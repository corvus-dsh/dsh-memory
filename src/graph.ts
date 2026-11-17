/**
 * DYNAMIC TASK GRAPH — the durable shape of "what this task is, right now".
 *
 * ── WHY A GRAPH AND NOT A TODO LIST ───────────────────────────────────────────────────────────
 *
 * `todo_write` is flat, unordered and rewritten wholesale; it answers "what is next" and nothing else.
 * This layer needs two questions a flat list cannot express: WHICH PHASE is this (a `testing` phase and
 * a `coding` phase call for different knowledge, and the phase belongs to the NODE), and WHAT DID WE
 * LEARN HERE (the bidirectional anchor: a node points at knowledge via `knowledgePointers`, and the
 * knowledge records which nodes used it, written by `recordKnowledgeRefs`).
 *
 * ── THE TWO INVARIANTS THE USER NAMED ─────────────────────────────────────────────────────────
 *
 *   START IS FIXED. Exactly one `start` node, always present, never removed — a graph without it is a
 *     different task, not an edited one.
 *   THE GOAL CAN BE LOCKED. A stated objective must not be quietly rewritten by the same model working
 *     on it (that is how "fix the crash" becomes "delete the crashing test"). While `goalLockedAt` is
 *     set, `update`/`deprecate` on that node is refused; the only way out is an explicit `unlock` with
 *     a recorded justification. Paths stay open: nodes are added, changed and abandoned freely.
 *
 * ── STORAGE ───────────────────────────────────────────────────────────────────────────────────
 *
 * One JSON document, `<memoryDir>/task-graph.json`, written atomically under a lease. A single document
 * rather than a ledger because a graph is MUTATED in place by definition; the audit trail is one
 * `history` entry per accepted mutation.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWrite } from './store.js'
import { withFileLock } from './lock.js'
import { normalizeNodeTypes, normalizeVocabList, recordKnowledgeRefs } from './knowledge.js'
import type { KnowledgeEntry, KnowledgeQueryResult, KnowledgeRef } from './knowledge.js'
/**
 * ── THE v3 FIELD SURFACE LIVES IN ITS OWN MODULE (B2-T1) ────────────────────────────────────────
 *
 * `graph.ts` owns the GRAPH: nodes, edges, cycles, the goal lock, history. `graph-v3.ts` owns ONE
 * thing: how a v3 field is judged. Both directions call into it, so a written field and a re-read
 * field cannot disagree about what a valid value is.
 *
 * It is a separate file because this one is governed by a hard 800-line cap
 * (`test/v205-module-size-cap.test.mjs`) and a registered ceiling may only go DOWN. The first attempt
 * inlined all of it here and took the file from 681 to 1,351 lines — the cap then refused it, which is
 * the cap doing its job. Splitting along a real seam beats raising a ceiling, because a file nobody
 * can read is a file nobody reviews.
 */
import {
  applyV3Patch,
  asAuthor,
  asHarvestedAt,
  asPersistentConstraints,
  carryUnknownKeys,
  mergePersistentConstraints,
  noteGraphWarning,
  pickV3,
  resolveNodeV3,
  unknownKeyWarning,
  VANISHED_FIELDS_HINT,
  vanishedFields,
} from './graph-v3.js'
export { drainGraphWarnings, unknownNodeKeys } from './graph-v3.js'
import type {
  Alternative,
  Author,
  EphemeralConstraint,
  LogPointer,
  PersistentConstraint,
  PrunedDirection,
} from './graph-v3.js'
export type {
  Alternative,
  Author,
  EphemeralConstraint,
  LogPointer,
  PersistentConstraint,
  PrunedDirection,
} from './graph-v3.js'

/** The identity of the graph's fixed origin. Reserved: no operation may create or remove it. */
export const START_NODE_ID = 'start'
/** The id the goal node takes when the caller does not name one. Also reserved against deletion. */
export const GOAL_NODE_ID = 'goal'

export type NodeStatus = 'pending' | 'active' | 'done' | 'abandoned'

/** A DAG node. Every mutable field is optional at the call site and normalised on write. */
export interface GraphNode {
  id: string
  title: string
  /** The phase this node belongs to (`analysis`, `coding`, `testing`, …). Drives phase hints. */
  nodeType: string
  /** What this phase must accomplish. Free text, written for the next reader. */
  requirements: string[]
  status: NodeStatus
  /** Ids that must finish first; validated (no self-edge, no dangling id, no cycle). */
  dependsOn: string[]
  /** Global knowledge entries this node produced or relies on. The forward half of the anchor. */
  knowledgePointers: string[]
  /** True only for the start and goal nodes; they are protected against structural removal. */
  fixed: boolean
  /** Empty = this phase recorded nothing; `knowledge_harvest` stamps it. See `asHarvestedAt`. */
  harvestedAt: string
  createdAt: string
  updatedAt: string

  // v3 (B2-T1): optional on every node; see graph-v3.ts for meaning, asNode for judging.
  origin?: { kind: 'planned' | 'inserted'; reason: string; by: Author }
  lastChange?: { by: Author; revision: number }
  objective?: string
  subgoals?: Array<{ id: string; text: string; done: boolean; verifiedBy?: string }>
  alternatives?: Alternative[]
  pruned?: PrunedDirection[]
  estimate?: { complexity: 1 | 2 | 3 | 4 | 5; note?: string }
  actual?: { complexity: 1 | 2 | 3 | 4 | 5; note?: string; closedAt?: string }
  progress?: number
  standing?: string
  evidence?: string[]
  logPointers?: LogPointer[]
  ephemeralConstraints?: EphemeralConstraint[]
}

export interface GraphHistoryEntry {
  at: string
  op: GraphOp
  nodeId: string
  /** Human-readable justification, carried through to the audit line. */
  reason: string
  /** Field names that actually changed, so a reader does not have to diff two snapshots. */
  changed: string[]
  /**
   * Who made the change. Entries written before B2-T1 have none: they do not take part in
   * author-filtered views, and the reader says so rather than pretending they were authored.
   */
  author?: Author
}

export type GraphOp = 'add' | 'update' | 'deprecate' | 'activate' | 'complete' | 'lock-goal' | 'unlock-goal'

export interface TaskGraph {
  version: 1
  id: string
  /** The stated objective of the whole graph. Immutable while `goalLockedAt` is set. */
  goal: string
  goalLockedAt: string
  /**
   * Project-level constraints. They do NOT disappear when a node closes (that is what
   * `ephemeralConstraints` are for); they end only when `retiredAt` is set.
   */
  persistentConstraints: PersistentConstraint[]
  nodes: GraphNode[]
  /** Newest last. Capped: this is an audit trail, not the state. */
  history: GraphHistoryEntry[]
  createdAt: string
  updatedAt: string
}

/** How many history entries are kept. A long task mutates often; the state is what matters. */
export const MAX_HISTORY = 200

export function graphPath(memoryDir: string): string {
  return join(memoryDir, 'task-graph.json')
}

function nowIso(at?: string): string {
  return at ?? new Date().toISOString()
}

function asStatus(value: unknown): NodeStatus {
  return value === 'active' || value === 'done' || value === 'abandoned' ? value : 'pending'
}

function asStringList(value: unknown, max = 12): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const out: string[] = []
  for (const item of raw) {
    const text = typeof item === 'string' ? item.replace(/\s+/gu, ' ').trim() : ''
    if (text.length === 0 || out.includes(text)) continue
    out.push(text)
    if (out.length >= max) break
  }
  return out
}

/** Node ids are kebab-case, same grammar as everything else that travels between files. */
const NODE_ID = /^[a-z0-9][a-z0-9._-]{0,47}$/u

/** A harvest stamp is a real ISO instant or nothing — see `asHarvestedAt` in `graph-v3.ts`. */

function asNodeId(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return NODE_ID.test(text) ? text : ''
}

/** Coerce one stored node, tolerating a hand-edited file. Returns undefined for an unusable row. */
function asNode(raw: unknown, at: string): GraphNode | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const id = asNodeId(record.id)
  if (id.length === 0) return undefined
  const nodeType = normalizeVocabList([record.nodeType ?? record.node_type ?? record.type], 1)[0] ?? ''
  const node: GraphNode = {
    id,
    title: typeof record.title === 'string' && record.title.trim().length > 0 ? record.title.trim() : id,
    nodeType,
    requirements: asStringList(record.requirements),
    status: asStatus(record.status),
    dependsOn: asStringList(record.dependsOn ?? record.depends_on, 16)
      .map((item) => asNodeId(item))
      .filter((item) => item.length > 0),
    knowledgePointers: asStringList(record.knowledgePointers ?? record.knowledge_pointers, 24)
      .map((item) => item.toLowerCase())
      .filter((item) => NODE_ID.test(item)),
    fixed: record.fixed === true || id === START_NODE_ID || id === GOAL_NODE_ID,
    /**
     * A hand-edited or externally-written graph may carry a tag that is not a timestamp. It reads
     * back as "not harvested" so the reminder still fires — see `asHarvestedAt`.
     */
    harvestedAt: asHarvestedAt(record.harvestedAt),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : at,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : at,
    // ── v3 fields: one table, shared with the write side (see `resolveNodeV3`) ──
    ...resolveNodeV3(record, () => at),
  }
  carryUnknownKeys(node, record)
  return node
}

/** Keys a node carries that this build does not recognise. Reported once per read, never dropped. */

/**
 * Cycle check. A DAG that contains a cycle cannot be scheduled, and the failure mode is silent
 * (every node waits for another forever), so a write that would introduce one is refused.
 */
export function hasCycle(nodes: readonly GraphNode[]): boolean {
  const edges = new Map<string, string[]>()
  for (const node of nodes) edges.set(node.id, node.dependsOn.filter((parent) => edges.has(parent) || nodes.some((other) => other.id === parent)))
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string): boolean => {
    const mark = state.get(id)
    if (mark === 'done') return false
    if (mark === 'visiting') return true
    state.set(id, 'visiting')
    for (const parent of edges.get(id) ?? []) if (visit(parent)) return true
    state.set(id, 'done')
    return false
  }
  for (const node of nodes) if (visit(node.id)) return true
  return false
}

/** A graph with no `start` node is not "empty", it is malformed: the origin is an invariant. */
export function emptyGraph(id: string, at?: string): TaskGraph {
  const stamp = nowIso(at)
  return {
    version: 1,
    id,
    goal: '',
    goalLockedAt: '',
    nodes: [
      {
        id: START_NODE_ID,
        title: '开始',
        nodeType: '',
        requirements: [],
        /**
         * `done`, NOT `active`. The origin is BEHIND you by definition: it is the point the graph
         * was cut from, not a phase you are working through. Reporting it as `active` made every
         * status count wrong by one and made the console highlight a node that can never finish.
         */
        status: 'done',
        dependsOn: [],
        knowledgePointers: [],
        fixed: true,
        harvestedAt: '',
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    history: [],
    createdAt: stamp,
    updatedAt: stamp,
    persistentConstraints: [],
  }
}

/** Read the graph. A missing or unreadable file is an EMPTY graph, never a throw at call time. */
export function readGraph(memoryDir: string, id = 'default'): TaskGraph {
  const path = graphPath(memoryDir)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return emptyGraph(id)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyGraph(id)
  }
  if (parsed === null || typeof parsed !== 'object') return emptyGraph(id)
  const record = parsed as Record<string, unknown>
  const stamp = nowIso()
  const nodes: GraphNode[] = []
  for (const raw of Array.isArray(record.nodes) ? record.nodes : []) {
    const node = asNode(raw, stamp)
    if (node !== undefined && !nodes.some((other) => other.id === node.id)) nodes.push(node)
  }
  // A hand-edited file may have lost the start node. Restore it rather than pretending the graph
  // is fine: every consumer relies on the origin existing.
  if (!nodes.some((node) => node.id === START_NODE_ID)) nodes.unshift(emptyGraph(id, stamp).nodes[0])
  const history: GraphHistoryEntry[] = []
  for (const raw of Array.isArray(record.history) ? record.history : []) {
    if (raw === null || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const author = asAuthor(entry.author, () => stamp)
    history.push({
      at: typeof entry.at === 'string' ? entry.at : '',
      op: (typeof entry.op === 'string' ? entry.op : 'update') as GraphOp,
      nodeId: typeof entry.nodeId === 'string' ? entry.nodeId : '',
      reason: typeof entry.reason === 'string' ? entry.reason : '',
      changed: asStringList(entry.changed, 16),
      ...(author === undefined ? {} : { author }),
    })
  }
  /**
   * ── REPORT WHAT WAS KEPT BUT NOT UNDERSTOOD (B2-T1 §3.1) ─────────────────────────────────────
   *
   * The carrying itself happens in `carryUnknownKeys`; the REPORT happens here so a read produces one
   * sentence rather than one per node. See `unknownKeyWarning` for why this is a warning and not a
   * refusal.
   */
  const unknownWarning = unknownKeyWarning(Array.isArray(record.nodes) ? record.nodes : [], record)
  if (unknownWarning !== undefined) noteGraphWarning(unknownWarning)
  return {
    version: 1,
    id: typeof record.id === 'string' && record.id.length > 0 ? record.id : id,
    goal: typeof record.goal === 'string' ? record.goal : '',
    goalLockedAt: typeof record.goalLockedAt === 'string' ? record.goalLockedAt : '',
    persistentConstraints: asPersistentConstraints(record.persistentConstraints, () => stamp),
    nodes,
    history: history.slice(-MAX_HISTORY),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : stamp,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : stamp,
  }
}


export interface GraphUpdateInput {
  graphId?: string
  op: GraphOp
  nodeId?: string
  /** For `add`: the node to create. For `update`: the fields to change. */
  node?: {
    id?: string
    title?: string
    nodeType?: string
    requirements?: unknown
    status?: string
    dependsOn?: unknown
    knowledgePointers?: unknown
    /**
     * The v3 fields (B2-T1). Typed `unknown` on the way IN, like `requirements`: this is the boundary
     * where an arbitrary payload from a model arrives, so each one is validated rather than trusted.
     */
    origin?: unknown
    lastChange?: unknown
    objective?: unknown
    subgoals?: unknown
    alternatives?: unknown
    pruned?: unknown
    estimate?: unknown
    actual?: unknown
    progress?: unknown
    standing?: unknown
    evidence?: unknown
    logPointers?: unknown
    ephemeralConstraints?: unknown
    /** Who is making this change. Recorded on the history entry. */
    author?: unknown
  }
  /** Present ⇒ REPLACE (same normaliser). Absent ⇒ carry the existing list through untouched. */
  persistentConstraints?: unknown
  /** For `lock-goal`: the objective that becomes immutable. Empty keeps the current one. */
  goal?: string
  /** Required for `unlock-goal` and recorded on every entry. */
  reason?: string
  at?: string
  /** Where to record the reverse anchor. Omitted = no reverse index (a caller without a knowledge dir). */
  knowledgeDir?: string
}

export interface GraphUpdateResult {
  ok: boolean
  /** Machine-readable refusal code; absent on success. */
  code?:
    | 'UNKNOWN_OP'
    | 'NODE_NOT_FOUND'
    | 'NODE_EXISTS'
    | 'RESERVED'
    | 'GOAL_LOCKED'
    | 'DANGLING_DEPENDENCY'
    | 'CYCLE'
    | 'MISSING_REASON'
    /** A supplied v3 field did not survive normalisation — see `vanishedFields`. */
    | 'INVALID_FIELD'
  reason?: string
  graph: TaskGraph
  node?: GraphNode
  /** Reverse-anchor rows appended for this mutation. */
  anchored: number
  /**
   * Set by `complete` when the phase produced no knowledge. The instruction travels in
   * `harvestPrompt`; a caller must surface it rather than treating the edit as finished.
   */
  harvestRequired?: boolean
  harvestPrompt?: string
  /** Knowledge entries the node now points at, when a knowledge dir was supplied. */
  knowledge?: KnowledgeQueryResult
}

function persist(memoryDir: string, graph: TaskGraph): TaskGraph {
  const trimmed: TaskGraph = { ...graph, history: graph.history.slice(-MAX_HISTORY) }
  atomicWrite(graphPath(memoryDir), `${JSON.stringify(trimmed, null, 2)}\n`)
  return trimmed
}

/**
 * Apply one mutation. Every accepted mutation appends ONE history entry.
 *
 * REFUSALS ARE RETURNED, NOT THROWN: a model calling `memory_graph_update` must READ why its edit was
 * refused and try again; a throw would surface as a tool error with no detail.
 */
export function updateGraph(memoryDir: string, input: GraphUpdateInput): GraphUpdateResult {
  const graphId = typeof input.graphId === 'string' && input.graphId.length > 0 ? input.graphId : 'default'
  const at = nowIso(input.at)
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  const op = input.op
  const known: GraphOp[] = ['add', 'update', 'deprecate', 'activate', 'complete', 'lock-goal', 'unlock-goal']
  if (!known.includes(op)) {
    return { ok: false, code: 'UNKNOWN_OP', reason: `未知操作 ${JSON.stringify(op)}；可用：${known.join(', ')}`, graph: readGraph(memoryDir, graphId), anchored: 0 }
  }

  return withFileLock(graphPath(memoryDir) + '.lock', () => {
    const graph = readGraph(memoryDir, graphId)
    const finish = (current: TaskGraph): TaskGraph => ({ ...current, updatedAt: at })
    const fail = (code: GraphUpdateResult['code'], detail: string): GraphUpdateResult => ({
      ok: false,
      code,
      reason: detail,
      graph,
      anchored: 0,
    })

    if (op === 'lock-goal') {
      const goal = typeof input.goal === 'string' && input.goal.trim().length > 0 ? input.goal.trim() : graph.goal
      if (goal.length === 0) return fail('MISSING_REASON', '锁定目标前必须先写下目标本身（goal 不能为空）')
      const nodes = [...graph.nodes]
      const goalIndex = nodes.findIndex((node) => node.id === GOAL_NODE_ID)
      if (goalIndex < 0) {
        nodes.push({
          id: GOAL_NODE_ID,
          title: '最终目标',
          nodeType: '',
          requirements: [goal],
          status: 'pending',
          dependsOn: [],
          knowledgePointers: [],
          fixed: true,
          harvestedAt: '',
          createdAt: at,
          updatedAt: at,
        })
      } else {
        nodes[goalIndex] = { ...nodes[goalIndex], requirements: [goal], fixed: true, updatedAt: at }
      }
      const next = finish({
        ...graph,
        goal,
        goalLockedAt: at,
        nodes,
        history: [...graph.history, { at, op, nodeId: GOAL_NODE_ID, reason: reason || '目标已锁定', changed: ['goal', 'goalLockedAt'] }],
      })
      return { ok: true, graph: persist(memoryDir, next), node: next.nodes.find((node) => node.id === GOAL_NODE_ID), anchored: 0 }
    }

    if (op === 'unlock-goal') {
      if (reason.length === 0) return fail('MISSING_REASON', '解锁最终目标必须写明理由（reason），它会进审计历史')
      const next = finish({
        ...graph,
        goalLockedAt: '',
        history: [...graph.history, { at, op, nodeId: GOAL_NODE_ID, reason, changed: ['goalLockedAt'] }],
      })
      return { ok: true, graph: persist(memoryDir, next), anchored: 0 }
    }

    const targetId = asNodeId(input.nodeId ?? input.node?.id)
    if (targetId.length === 0) return fail('NODE_NOT_FOUND', '缺少合法的 nodeId（小写 kebab-case）')

    if (op === 'add') {
      /**
       * RESERVED IS CHECKED BEFORE EXISTS, and the order is the whole message.
       *
       * `start` always exists, so an existence check first reported `NODE_EXISTS` ("use update") for
       * a node that must never be created OR updated — advice that sends the caller down a path that
       * is also refused. The reserved ids are not a special case of duplication; they are a
       * different rule, and the refusal has to say which one.
       */
      if (targetId === START_NODE_ID || targetId === GOAL_NODE_ID) {
        return fail('RESERVED', `${targetId} 是保留节点：start 恒存在且不可创建/删除，goal 由 lock-goal 创建`)
      }
      if (graph.nodes.some((node) => node.id === targetId)) {
        return fail('NODE_EXISTS', `节点 ${targetId} 已存在；改它请用 op: update`)
      }
      const suppliedV3: Record<string, unknown> = { ...(input.node ?? {}) }
      /**
       * Only the v3 fields are spread, NOT `input.node` wholesale — see `pickV3` for the failure that
       * a wholesale spread produces (an id refusal about the wrong thing).
       */
      const node = asNode(
        {
          id: targetId,
          title: input.node?.title,
          nodeType: input.node?.nodeType,
          requirements: input.node?.requirements,
          status: input.node?.status ?? 'pending',
          dependsOn: input.node?.dependsOn,
          knowledgePointers: input.node?.knowledgePointers,
          // v3 fields travel through the SAME normaliser the reader uses, so a written node and a
          // re-read node cannot disagree about what a valid value is.
          ...pickV3(input.node as Record<string, unknown> | undefined),
          createdAt: at,
          updatedAt: at,
        },
        at,
      )
      if (node === undefined) return fail('NODE_NOT_FOUND', `节点 ${targetId} 的 id 不合法`)
      /** A supplied field that did not survive is a REFUSAL on the write side — see `vanishedFields`. */
      const missing = vanishedFields(suppliedV3, node)
      if (missing.length > 0) return fail('INVALID_FIELD', `节点 ${targetId}：${VANISHED_FIELDS_HINT}（涉及 ${missing.join(', ')}）`)
      // Dependencies must already exist: a dangling edge is a node nobody declared a reason for.
      const dangling = node.dependsOn.filter((parent) => !graph.nodes.some((other) => other.id === parent))
      if (dangling.length > 0) return fail('DANGLING_DEPENDENCY', `依赖的节点不存在：${dangling.join(', ')}`)
      const candidate = [...graph.nodes, node]
      if (hasCycle(candidate)) return fail('CYCLE', `加入 ${targetId} 会形成环（${node.dependsOn.join(' -> ')}），DAG 不允许环`)
      const next = finish({
        ...graph,
        nodes: candidate,
        history: [...graph.history, { at, op, nodeId: targetId, reason, changed: ['node'] }],
      })
      return finalizeAnchor(memoryDir, input, persist(memoryDir, next), node.id, at)
    }

    const index = graph.nodes.findIndex((node) => node.id === targetId)
    if (index < 0) return fail('NODE_NOT_FOUND', `没有节点 ${targetId}`)
    const current = graph.nodes[index]

    /**
     * THE GOAL LOCK, ENFORCED HERE AND NOWHERE ELSE.
     *
     * A locked goal refuses `update` and `deprecate` on the goal node AND any change to the
     * top-level `goal` text. `activate`/`complete` are still allowed deliberately: working on the
     * goal is what the lock is protecting, not reporting progress on it.
     */
    const touchesGoal = targetId === GOAL_NODE_ID || (input.node !== undefined && typeof input.node.requirements !== 'undefined' && targetId === GOAL_NODE_ID)
    if (graph.goalLockedAt.length > 0 && touchesGoal && (op === 'update' || op === 'deprecate')) {
      return fail(
        'GOAL_LOCKED',
        `最终目标已在 ${graph.goalLockedAt} 锁定，${op} 被拒绝。路径可以调整，终点不能改；确需修改请先 unlock-goal 并说明理由。`,
      )
    }
    if (current.fixed === true && op === 'deprecate' && targetId !== GOAL_NODE_ID) {
      return fail('RESERVED', `${targetId} 是固定节点，不能废弃`)
    }

    let updated: GraphNode = current
    const changed: string[] = []
    if (op === 'activate') {
      updated = { ...current, status: 'active', updatedAt: at }
      changed.push('status')
    } else if (op === 'complete') {
      updated = { ...current, status: 'done', updatedAt: at }
      changed.push('status')
    } else if (op === 'deprecate') {
      updated = { ...current, status: 'abandoned', updatedAt: at }
      changed.push('status')
    } else {      const patch = input.node ?? {}
      const nextNode: GraphNode = { ...current, updatedAt: at }
      if (typeof patch.title === 'string' && patch.title.trim().length > 0) {
        const title = patch.title.trim()
        if (title !== current.title) changed.push('title')
        nextNode.title = title
      }
      if (typeof patch.nodeType === 'string') {
        const nodeType = normalizeNodeTypes([patch.nodeType], 1)[0] ?? ''
        if (nodeType !== current.nodeType) changed.push('nodeType')
        nextNode.nodeType = nodeType
      }
      if (typeof patch.requirements !== 'undefined') {
        const requirements = asStringList(patch.requirements)
        if (requirements.join('\u0000') !== current.requirements.join('\u0000')) changed.push('requirements')
        nextNode.requirements = requirements
      }
      if (typeof patch.status === 'string') {
        const status = asStatus(patch.status)
        if (status !== current.status) changed.push('status')
        nextNode.status = status
      }
      if (typeof patch.dependsOn !== 'undefined') {
        const dependsOn = asStringList(patch.dependsOn, 16)
          .map((item) => asNodeId(item))
          .filter((item) => item.length > 0)
        const dangling = dependsOn.filter((parent) => parent !== nextNode.id && !graph.nodes.some((other) => other.id === parent))
        if (dangling.length > 0) return fail('DANGLING_DEPENDENCY', `依赖的节点不存在：${dangling.join(', ')}`)
        const candidate = graph.nodes.map((node) => (node.id === targetId ? { ...nextNode, dependsOn } : node))
        if (hasCycle(candidate)) return fail('CYCLE', `把 ${targetId} 的依赖改成 ${dependsOn.join(', ')} 会形成环`)
        if (dependsOn.join('\u0000') !== current.dependsOn.join('\u0000')) changed.push('dependsOn')
        nextNode.dependsOn = dependsOn.filter((parent) => parent !== nextNode.id)
      }
      if (typeof patch.knowledgePointers !== 'undefined') {
        const pointers = normalizeVocabList(patch.knowledgePointers, 24)
        if (pointers.join('\u0000') !== current.knowledgePointers.join('\u0000')) changed.push('knowledgePointers')
        nextNode.knowledgePointers = pointers
      }
      /**
       * ── THE v3 FIELDS, UPDATE SIDE (B2-T1) ────────────────────────────────────────────────────
       *
       * Same rule as `add`: run the merged payload through the READER's normaliser, then refuse if a
       * supplied field vanished. A patch REPLACES the field it names; a field the patch does not mention
       * keeps its current value (the spread above already did that).
       */
      const v3Patch = applyV3Patch({ ...patch } as Record<string, unknown>, current as unknown as Record<string, unknown>, () => at)
      if (v3Patch.ok === false) return fail('INVALID_FIELD', `节点 ${targetId}：${v3Patch.reason}`)
      for (const key of v3Patch.changed) changed.push(key)
      Object.assign(nextNode, v3Patch.fields as Partial<GraphNode>)
      updated = nextNode
    }

    const nodes = graph.nodes.map((node) => (node.id === targetId ? updated : node))
    /**
     * ── `persistentConstraints` SURVIVES EVERY OP THAT DOES NOT MENTION IT ──────────────────────
     *
     * The failure this guards is the one already measured here: a whole-document rebuild that keeps
     * only what the current op touches. A `complete` on a coding node has nothing to do with
     * project-level constraints, so a rebuild that "recomputes" them silently empties the list — and
     * the constraints stop travelling while every receipt still says ok.
     *
     * Present in the input ⇒ REPLACE the list (through the same normaliser, same refuse-if-vanished
     * rule). Absent ⇒ carry the existing list through untouched.
     */
    let persistentConstraints = graph.persistentConstraints
    const merged = mergePersistentConstraints(persistentConstraints, input.persistentConstraints, () => at)
    if (merged.ok === false) return fail('INVALID_FIELD', merged.reason)
    persistentConstraints = merged.list
    const author = asAuthor(input.node?.author, () => at)
    const next = finish({
      ...graph,
      persistentConstraints,
      nodes,
      history: [...graph.history, { at, op, nodeId: targetId, reason, changed, ...(author === undefined ? {} : { author }) }],
    })
    const anchoredResult = finalizeAnchor(memoryDir, input, persist(memoryDir, next), targetId, at)
    /**
     * ── THE WRITE HALF: A FINISHED PHASE MUST SAY WHAT IT LEARNED ─────────────────────────────
     *
     * `complete` is the one moment the model knows what the phase cost. If nothing is written here,
     * the knowledge base only ever grows from the paths that happened to be interesting, and the
     * DAG records progress that taught the next session nothing.
     *
     * THE WARNING IS IN THE RESULT, NOT IN THE SCHEMA. A refusal would be wrong — a phase can
     * legitimately teach nothing, and blocking `complete` would leave the graph stuck. So the node
     * finishes, the receipt carries the instruction, and `harvestedAt` (empty) is the durable
     * record that this phase produced no knowledge. The pre-step warning reads the same field.
     */
    if (op === 'complete') {
      const harvesting = harvestingPrompt(updated)
      return {
        ...anchoredResult,
        ...(harvesting === undefined ? {} : { harvestRequired: true, harvestPrompt: harvesting }),
      }
    }
    return anchoredResult
  }) as GraphUpdateResult
}

/**
 * The sentence `complete` returns, or `undefined` when this phase has nothing to add.
 *
 * A node that ALREADY recorded knowledge is not nagged again: repeating an instruction the model
 * has satisfied is how a warning becomes noise. A node that pointed at nothing and whose phase type
 * is unknown is likewise left alone — "you are in [当前]" is not an actionable sentence.
 */
export function harvestingPrompt(node: GraphNode | undefined): string | undefined {
  if (node === undefined) return undefined
  if (node.harvestedAt.length > 0) return undefined
  const phase = node.nodeType.length > 0 ? `[${node.nodeType}] ` : ''
  const pointers = node.knowledgePointers.length
  return (
    `节点 ${node.id} 已完成。请立刻调用 knowledge_harvest 将本阶段经验写入全局知识库，并补充 tags 和 applicable_node_types。` +
    `\n${phase}本阶段还没有写入任何知识${pointers > 0 ? `（引用了 ${pointers} 条，但那不等于你总结了这一阶段）` : ''}。` +
    '\n全局知识库只从这种总结里生长；不写，下一个工作区就学不到这次的教训。'
  )
}

/**
 * Stamp a node as harvested. Called by `knowledge_harvest` when the model actually writes, so the
 * warning has a real answer rather than a checkbox the caller can tick without writing anything.
 *
 * Returns the node ids that were stamped; an empty array means nothing needed it (no graph, no
 * active node, or already stamped).
 */
export function markHarvested(memoryDir: string, nodeIds: readonly string[], at = new Date().toISOString()): string[] {
  const wanted = nodeIds.filter((id) => typeof id === 'string' && id.length > 0)
  if (wanted.length === 0) return []
  return withFileLock(`${graphPath(memoryDir)}.lock`, () => {
    const graph = readGraph(memoryDir)
    const stamped: string[] = []
    const nodes = graph.nodes.map((node) => {
      if (!wanted.includes(node.id)) return node
      if (node.harvestedAt.length > 0) return node
      stamped.push(node.id)
      return { ...node, harvestedAt: at, updatedAt: at }
    })
    if (stamped.length === 0) return []
    atomicWrite(
      graphPath(memoryDir),
      `${JSON.stringify({ ...graph, nodes, updatedAt: at, history: graph.history.slice(-MAX_HISTORY) }, null, 2)}\n`,
    )
    return stamped
  })
}

/**
 * Record the reverse anchor for the node's CURRENT pointer set, and describe what it points at.
 *
 * The anchor is recorded on every mutation, not only on `add`: a node that gains a pointer through
 * `update` must appear in the knowledge entry's `referencedBy`, and that is the half of the link a
 * reader of the knowledge store can actually see.
 */
function finalizeAnchor(memoryDir: string, input: GraphUpdateInput, graph: TaskGraph, nodeId: string, at: string): GraphUpdateResult {
  const node = graph.nodes.find((item) => item.id === nodeId)
  if (node === undefined) return { ok: true, graph, anchored: 0 }
  const knowledgeDir = typeof input.knowledgeDir === 'string' && input.knowledgeDir.length > 0 ? input.knowledgeDir : ''
  if (knowledgeDir.length === 0 || node.knowledgePointers.length === 0) {
    return { ok: true, graph, node, anchored: 0 }
  }
  const refs: Array<Omit<KnowledgeRef, 'at'>> = node.knowledgePointers.map((knowledgeId) => ({
    knowledgeId,
    graphId: graph.id,
    nodeId: node.id,
  }))
  const anchored = recordKnowledgeRefs(knowledgeDir, refs, at)
  return { ok: true, graph, node, anchored }
}

export interface GraphNodeView extends GraphNode {
  /** The knowledge entries this node points at, resolved (empty when no knowledge dir was given). */
  knowledge: KnowledgeEntry[]
  /** Nodes that depend on this one. */
  unlocks: string[]
}

/** The console/DAG view: nodes plus their resolved knowledge, edges already computed. */
export function describeGraph(memoryDir: string, knowledge: KnowledgeEntry[] | undefined, id = 'default'): {
  graph: TaskGraph
  nodes: GraphNodeView[]
  counts: { total: number; pending: number; active: number; done: number; abandoned: number }
} {
  const graph = readGraph(memoryDir, id)
  const byId = new Map((knowledge ?? []).map((entry) => [entry.id, entry]))
  const nodes: GraphNodeView[] = graph.nodes.map((node) => ({
    ...node,
    knowledge: node.knowledgePointers.map((pointer) => byId.get(pointer)).filter((entry): entry is KnowledgeEntry => entry !== undefined),
    unlocks: graph.nodes.filter((other) => other.dependsOn.includes(node.id)).map((other) => other.id),
  }))
  const counts = { total: nodes.length, pending: 0, active: 0, done: 0, abandoned: 0 }
  for (const node of nodes) counts[node.status] += 1
  return { graph, nodes, counts }
}

/** One-line readiness answer, used by the phase hint and the console. */
export function renderNodeBanner(node: GraphNodeView | undefined): string | undefined {
  if (node === undefined) return undefined
  const parts = [`节点 ${node.id}（${node.status}）`]
  if (node.nodeType.length > 0) parts.push(`阶段 ${node.nodeType}`)
  if (node.requirements.length > 0) parts.push(`要求：${node.requirements.slice(0, 3).join('；')}`)
  if (node.knowledge.length > 0) parts.push(`相关技能：${node.knowledge.slice(0, 3).map((entry) => entry.title || entry.id).join('、')}`)
  return parts.join(' · ')
}

/** Convenience: is the graph untouched (only the start node, no goal)? */
export function isBlankGraph(graph: TaskGraph): boolean {
  return graph.goal.length === 0 && graph.nodes.length <= 1 && graph.history.length === 0
}

/** True when this memory dir already holds a graph file (the console uses it to decide what to say). */
export function hasGraph(memoryDir: string): boolean {
  return existsSync(graphPath(memoryDir))
}
