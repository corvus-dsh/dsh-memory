/**
 * ── THE GOAL LOCK, AND THE TWO DIRECTIONS OF A CONSTRAINT ───────────────────────────────────────
 *
 * This module owns WHAT A LOCK COVERS. `graph.ts` owns the graph and enforces the lock by calling
 * `classifyGoalUpdate`; `graph-v3.ts` owns how a v3 FIELD is judged. Neither owns the classification,
 * which is why it lives here: the rule has to be readable as one list, not inferred from a guard
 * expression inside a 300-line function.
 *
 * It also owns the top-level constraint operations (`constrain` / `relax`) and the node-scoped
 * `ephemeralConstraints` retirement, because all three answer the same question — "when does a rule
 * stop applying?" — and answering it in two files is how the answers come to disagree.
 *
 * ── WHY THE SPLIT WAS FORCED, AND WHY IT IS NOT A LINE-COUNT TRICK ─────────────────────────────
 *
 * After `constrain`/`relax` landed, `graph.ts` (848) and `graph-v3.ts` (842) both exceeded the hard
 * 800-line cap. Shaving comments would have made them smaller without making them clearer, and moving
 * code back and forth between two over-cap files changes no totals. The seam that is actually here:
 * `graph-v3.ts` judges FIELDS, this module decides LIFECYCLE (what a lock covers, when a constraint
 * retires). Two different questions, two files.
 */

import type { Author, EphemeralConstraint, PersistentConstraint } from './graph-v3.js'
import { asPersistentConstraints } from './graph-v3.js'

/**
 * ── TWO SETS, BECAUSE A LOCK HAS TO SAY BOTH WHAT IT FORBIDS AND WHAT IT ALLOWS ─────────────────
 *
 * `GOAL_DESTINATION_FIELDS` — changing any of these changes WHAT "done" means:
 *   requirements   the completion criteria ("what counts as finished")
 *   title          the goal's name
 *   status         status moves go through complete/activate, never a generic update
 *   nodeType       the node's kind is its identity
 *   dependsOn      the dependency graph is part of how the destination is reached
 *
 * `GOAL_JOURNEY_FIELDS` — where the work IS. Reporting these is the reason the graph exists; refusing
 * them made "I am 60% done" indistinguishable from "redefine the goal", which is what the old guard did
 * while its own comment claimed the opposite.
 */
export const GOAL_DESTINATION_FIELDS: ReadonlySet<string> = new Set([
  'requirements', 'title', 'status', 'nodeType', 'dependsOn',
])

export const GOAL_JOURNEY_FIELDS: ReadonlySet<string> = new Set([
  'progress', 'standing', 'objective', 'lastChange', 'origin',
  'evidence', 'logPointers', 'estimate', 'actual',
  'subgoals', 'alternatives', 'pruned', 'ephemeralConstraints',
])

/**
 * Classify what a locked goal's update is trying to touch.
 *
 * `allowed` is true only when EVERY touched field is a journey field. A batch mixing a journey field
 * with a destination one is REFUSED as a whole — otherwise "let progress through" becomes a side door
 * for a destination edit, and a partial application would be worse than a refusal.
 *
 * A field in NEITHER list is refused. The tempting default ("allow — probably harmless") would make
 * every FUTURE field automatically exempt from the lock: add `requirementsRevision` next year and the
 * lock quietly stops covering part of the destination. A lock whose default is open is not a lock.
 */
export function classifyGoalUpdate(
  touched: readonly string[],
): { allowed: true } | { allowed: false; code: 'DESTINATION' | 'UNKNOWN'; fields: string[] } {
  const destination = touched.filter((key) => GOAL_DESTINATION_FIELDS.has(key))
  if (destination.length > 0) return { allowed: false, code: 'DESTINATION', fields: destination }
  const unknown = touched.filter((key) => !GOAL_JOURNEY_FIELDS.has(key))
  if (unknown.length > 0) return { allowed: false, code: 'UNKNOWN', fields: unknown }
  return { allowed: true }
}

/** Why an update on a locked goal was refused, in a sentence that names the offending fields. */
export function goalLockedReason(
  lockedAt: string,
  verdict: { code: 'DESTINATION' | 'UNKNOWN'; fields: string[] },
): string {
  const journey = [...GOAL_JOURNEY_FIELDS].join(' / ')
  if (verdict.code === 'DESTINATION') {
    return (
      `最终目标已在 ${lockedAt} 锁定。这些字段属于「终点」，改它们等于改目标：${verdict.fields.join(', ')}。` +
      `进度与过程（${journey}）不在此限，可以随时更新。确需修改终点请先 unlock-goal 并说明理由。`
    )
  }
  return (
    `最终目标已锁定，而 ${verdict.fields.join(', ')} 不在「过程」白名单里。` +
    '锁的默认方向是「不许改」——只有被明确列为 journey 的字段才放行，否则将来新增的字段会自动绕过锁。' +
    `可选的过程字段：${journey}。`
  )
}

/**
 * ── THE WHOLE LOCK DECISION, FOR ONE UPDATE (19.4-G: moved here from `graph.ts`) ─────────────────
 *
 * Returns the refusal SENTENCE, or `undefined` when the update may proceed. `graph.ts` used to inline
 * both the guard condition and the deprecate message, so 「what a locked goal refuses」 was stated in two
 * files — and the inlined version covered `update`/`deprecate` only, which is how `activate`/`complete`
 * on the goal came to be accepted. The rule belongs here, next to the field sets it talks about.
 *
 * A goal that is not locked is not this function's business: `undefined` means "not refused HERE",
 * never "allowed" in general.
 */
export function goalLockVerdict(
  lockedAt: string,
  targetId: string,
  op: string,
  patch: Record<string, unknown> | undefined,
): string | undefined {
  if (lockedAt.length === 0) return undefined
  if (targetId !== 'goal') return undefined
  if (op === 'deprecate') {
    return (
      `最终目标已在 ${lockedAt} 锁定，deprecate 被拒绝：废弃终点等于换一个目标。` +
      '确需修改请先 unlock-goal 并说明理由。'
    )
  }
  if (op !== 'update') return undefined
  const touched = Object.entries(patch ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
  const verdict = classifyGoalUpdate(touched)
  if (verdict.allowed === false) return goalLockedReason(lockedAt, verdict)
  // Every touched field is a journey field: the update proceeds.
  return undefined
}

/**
 * ── WHICH STATUS OPS A FIXED NODE REFUSES (19.4-G G-6, P0) ──────────────────────────────────────
 *
 * `start` and `goal` are structural: the origin is done by definition, the destination is where the work
 * is going and is written as `pending` by `lock-goal`. NEITHER IS A UNIT OF WORK, so neither can be
 * activated, completed or deprecated — the very idea is a category error, and the graph will hold the
 * resulting contradiction without complaint.
 *
 * THE MEASURED ORIGIN: `graph.ts` refused `deprecate` on a fixed node and nothing else, and the status
 * branches test only the op — so `memory_graph_update(op:'activate', nodeId:'goal')` returned `ok:true`
 * and wrote `goal.status = "active"`. That is exactly the live graph's shape, and the reason 19.4-F had
 * to teach every reader to skip the goal. `complete` on `goal` additionally returned `harvestRequired`.
 *
 * ONE RULE, NOT TWO SPECIAL CASES: stated once, asked from one place.
 */
export const refusesStatusOp = (op: string): boolean =>
  op === 'activate' || op === 'complete' || op === 'deprecate'

/** The one sentence a fixed node gets back, so the refusal reads the same wherever it is raised. */
export const fixedNodeStatusRefusal = (nodeId: string): string =>
  `${nodeId} 是固定节点（起点/终点），不是一段工作：不能 activate / complete / deprecate。` +
  '终点由 lock-goal 建立、状态恒为 pending；要报告进度请更新真正的阶段节点。'

/**
 * ── WHAT `complete` ACTUALLY MEANS (G-9, MEMORY-04) ─────────────────────────────────────────────
 *
 * It used to write `status: 'done'` and nothing else, so a phase the model DECLARED finished was, for
 * every reader, finished — no evidence, no acceptance step. Measured (v3.2 §5.5): `src/` had ZERO
 * occurrences of `acceptance` / `accepted`.
 *
 * THREE CLAIMS, THREE FIELDS, and only one of them moves here:
 *
 *   status           'done'       「no longer in flight」   — unchanged, so every reader is unaffected
 *   executionStatus  'produced'   the work exists           — new, written by this transition
 *   acceptanceStatus 'pending'    nobody accepted it yet    — new, and this transition NEVER sets it
 *                                                            to 'accepted'
 *
 * `TaskGraph.version` is NOT bumped: these are optional node fields. The stop condition reserves
 * schema-version changes for an explicit ruling.
 */
export function completeNodeTransition<
  TNode extends {
    ephemeralConstraints?: readonly EphemeralConstraint[]
  },
>(current: TNode, at: string): {
  node: TNode & { status: 'done'; executionStatus: 'produced'; acceptanceStatus: 'pending'; updatedAt: string }
  changed: string[]
} {
  const retired = retireEphemeral(current.ephemeralConstraints, at, '节点完成')
  return {
    node: {
      ...current,
      status: 'done',
      executionStatus: 'produced',
      acceptanceStatus: 'pending',
      updatedAt: at,
      ...(retired === undefined ? {} : { ephemeralConstraints: retired }),
    },
    changed: ['status', 'executionStatus', 'acceptanceStatus', ...(retired === undefined ? [] : ['ephemeralConstraints'])],
  }
}

/** `deprecate`: the node leaves the plan. Same owner as `complete` — both are LIFECYCLE, and 「how a
 * node stops being work」 should not be stated in two places. Distinct from `complete`: nothing was
 * produced, so no `executionStatus`/`acceptanceStatus` is written. */
export function abandonNodeTransition<
  TNode extends {
    ephemeralConstraints?: readonly EphemeralConstraint[]
  },
>(current: TNode, at: string): {
  node: TNode & { status: 'abandoned'; updatedAt: string }
  changed: string[]
} {
  const retired = retireEphemeral(current.ephemeralConstraints, at, '节点被废弃')
  return {
    node: {
      ...current,
      status: 'abandoned',
      updatedAt: at,
      ...(retired === undefined ? {} : { ephemeralConstraints: retired }),
    },
    changed: ['status', ...(retired === undefined ? [] : ['ephemeralConstraints'])],
  }
}

/** `activate`: the node becomes the current work. The trivial one of the three — stated here so all
 * three transitions have ONE owner, not so it looks symmetrical. */
export function activateNodeTransition<TNode>(current: TNode, at: string): {
  node: TNode & { status: 'active'; updatedAt: string }
  changed: string[]
} {
  return { node: { ...current, status: 'active', updatedAt: at }, changed: ['status'] }
}

/**
 * ── AN ACCEPTANCE NEEDS EVIDENCE (G-9, MEMORY-04) ───────────────────────────────────────────────
 *
 * `acceptanceStatus: 'accepted'` is a VERDICT. A verdict with nothing behind it is the exact shape this
 * batch removes (a claim that is formally complete and substantively empty), so it is refused unless the
 * same write carries evidence.
 *
 * WHAT COUNTS AS EVIDENCE: an existing fact, not a new system — a commit hash, a test result, a
 * `harvestedAt`-style stamp, a probe output. The field already exists (`evidence: string[]`), so this
 * rule adds a REQUIREMENT, not a schema.
 *
 * A REJECTION needs no evidence: 「this does not pass」 is not a claim that something was achieved, and
 * demanding proof of a failure would push callers to invent one.
 */
export function acceptanceNeedsEvidence(
  next: { acceptanceStatus?: unknown; evidence?: unknown },
  current: { evidence?: readonly string[] },
): { ok: true } | { ok: false; code: 'MISSING_EVIDENCE'; reason: string } {
  if (next.acceptanceStatus !== 'accepted') return { ok: true }
  const supplied = Array.isArray(next.evidence)
    ? next.evidence.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
  const existing = (current.evidence ?? []).filter((entry) => entry.trim().length > 0)
  if (supplied.length > 0 || existing.length > 0) return { ok: true }
  return {
    ok: false,
    code: 'MISSING_EVIDENCE',
    reason:
      '把节点标为 accepted 是一句判决，必须带证据（提交哈希 / 测试结果 / 探针输出等已有事实）。' +
      '本次既没提供 evidence，节点上也没有既往证据 —— 没有证据的「验收过了」和「做完了」没有区别。',
  }
}

/**
 * ── TOP-LEVEL CONSTRAINTS (`constrain` / `relax`) ───────────────────────────────────────────────
 *
 * `relax` RETIRES, never deletes: a constraint that vanished would leave the next generation unable to
 * tell "this was lifted" from "this was never declared", which is the distinction `retiredAt` exists for.
 *
 * `constrain` REFUSES an id that already exists. Silently overwriting would make "declare a new rule"
 * and "change an existing one" the same call, so a typo'd id would quietly rewrite a different
 * constraint while the receipt said ok.
 */
export function declareConstraint(
  current: readonly PersistentConstraint[],
  raw: unknown,
  author: Author,
  at: string,
):
  | { ok: true; list: PersistentConstraint[]; declared: PersistentConstraint }
  | { ok: false; code: 'INVALID_FIELD' | 'CONSTRAINT_EXISTS'; reason: string } {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const parsed = asPersistentConstraints(
    [{ ...source, by: source.by ?? author, effectiveFrom: source.effectiveFrom ?? at }],
    () => at,
  )
  if (parsed.length === 0) {
    return { ok: false, code: 'INVALID_FIELD', reason: 'constraint 需要 id 与 text（by 由调用者的 author 补上）' }
  }
  const declared = parsed[0]
  const existing = current.find((row) => row.id === declared.id)
  if (existing !== undefined) {
    return {
      ok: false,
      code: 'CONSTRAINT_EXISTS',
      reason:
        `长期约束 ${declared.id} 已存在（${existing.retiredAt === undefined ? '仍有效' : `${existing.retiredAt} 已退休`}）。` +
        '换一个 id，或先 relax 旧的 —— 覆盖会让「新增一条」与「改掉另一条」变成同一个调用。',
    }
  }
  return { ok: true, list: [...current, declared], declared }
}

export function relaxConstraint(
  current: readonly PersistentConstraint[],
  constraintId: string,
  reason: string,
  at: string,
):
  | { ok: true; list: PersistentConstraint[] }
  | { ok: false; code: 'INVALID_FIELD' | 'NODE_NOT_FOUND' | 'CONSTRAINT_EXISTS'; reason: string } {
  const wanted = constraintId.trim().toLowerCase()
  if (wanted === '') return { ok: false, code: 'INVALID_FIELD', reason: 'relax 需要 constraintId' }
  const found = current.find((row) => row.id === wanted)
  if (found === undefined) return { ok: false, code: 'NODE_NOT_FOUND', reason: `没有 id 为 ${wanted} 的长期约束` }
  if (found.retiredAt !== undefined) {
    return { ok: false, code: 'CONSTRAINT_EXISTS', reason: `${wanted} 已经在 ${found.retiredAt} 退休了，无需重复操作` }
  }
  return {
    ok: true,
    list: current.map((row) => (row.id === wanted ? { ...row, retiredAt: at, retiredWhy: reason } : row)),
  }
}

/**
 * ── A NODE'S SHORT-LIVED CONSTRAINTS EXPIRE WITH THE NODE (user ruling 5, implemented) ──────────
 *
 * The schema has carried `ephemeralConstraints` since B2-T1 and the ruling said "节点过去就退化", but
 * nothing retired them: a finished node kept its constraints in force forever, the opposite of
 * "short-lived".
 *
 * RETIRE, NEVER DELETE — deleting would let the next generation see a node that never had constraints.
 * `scope: 'session'` is NOT retired here: it belongs to a conversation, not to a node, so the node
 * finishing says nothing about it. An already-retired row is left alone, so running `complete` twice
 * does not rewrite the original retirement time (that would be a false history).
 *
 * Returns `undefined` when nothing changed, which is what lets the caller decide whether
 * `ephemeralConstraints` belongs in the `changed` list — allocating a fresh array every time would
 * report a change that did not happen.
 */
export function retireEphemeral(
  list: readonly EphemeralConstraint[] | undefined,
  at: string,
  why: string,
): EphemeralConstraint[] | undefined {
  if (list === undefined || list.length === 0) return undefined
  let touched = false
  const next = list.map((row) => {
    if (row.retiredAt !== undefined || row.scope === 'session') return row
    touched = true
    return { ...row, retiredAt: at, retiredWhy: why }
  })
  return touched ? next : undefined
}
