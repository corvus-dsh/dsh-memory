/**
 * v0.9.1 — DYNAMIC TASK GRAPH: the two invariants the user named, plus the dynamic edits.
 *
 * THE INVARIANTS
 *
 *   START IS FIXED.        Exactly one `start` node exists, always, and no operation removes it.
 *   THE GOAL CAN LOCK.     Once locked, the objective cannot be rewritten by the model that is
 *                          working on it. Paths stay open; only the destination is protected.
 *
 * Everything else is expected to move: nodes are added, edited, activated, completed and abandoned
 * as the work teaches the model what the work actually is. Every mutation appends ONE history
 * entry with the fields it touched, so "what changed and why" is answerable later.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  GOAL_NODE_ID,
  START_NODE_ID,
  describeGraph,
  emptyGraph,
  graphPath,
  hasCycle,
  hasGraph,
  readGraph,
  renderNodeBanner,
  updateGraph,
} from '../lib/graph.js'
import { readKnowledge, queryKnowledge, writeKnowledge } from '../lib/knowledge.js'

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dag-'))
  return { root, memory: join(root, 'memory'), knowledge: join(root, 'knowledge') }
}

test('dag: a fresh graph has the fixed start node and nothing else', () => {
  const { memory } = dirs()
  const graph = readGraph(memory)
  assert.equal(graph.nodes.length, 1)
  assert.equal(graph.nodes[0].id, START_NODE_ID)
  assert.equal(graph.nodes[0].fixed, true)
  assert.equal(graph.goal, '')
  assert.equal(hasGraph(memory), false, 'reading must not create a file')
})

test('dag: the START node cannot be created or removed by any operation', () => {
  const { memory } = dirs()
  assert.equal(updateGraph(memory, { op: 'add', nodeId: START_NODE_ID }).code, 'RESERVED')
  assert.equal(updateGraph(memory, { op: 'deprecate', nodeId: START_NODE_ID }).code, 'RESERVED')
  // A hand-edited file that lost the start node is repaired on READ, not silently accepted.
  mkdirSync(memory, { recursive: true })
  writeFileSync(graphPath(memory), JSON.stringify({ version: 1, id: 'default', goal: '', goalLockedAt: '', nodes: [], history: [] }), 'utf8')
  const repaired = readGraph(memory)
  assert.equal(repaired.nodes[0].id, START_NODE_ID, 'the origin is an invariant, not a row')
})

test('dag: add creates a phase node with node_type, requirements and pointers', () => {
  const { memory, knowledge } = dirs()
  const result = updateGraph(memory, {
    op: 'add',
    nodeId: 'phase-1',
    node: {
      title: '写失败用例',
      nodeType: 'testing',
      requirements: ['覆盖 1046 号崩溃', '跑通四仓'],
      knowledgePointers: ['red-test-first'],
    },
    knowledgeDir: knowledge,
  })
  assert.equal(result.ok, true)
  assert.equal(result.node?.nodeType, 'testing')
  assert.deepEqual(result.node?.requirements, ['覆盖 1046 号崩溃', '跑通四仓'])
  assert.deepEqual(result.node?.knowledgePointers, ['red-test-first'])
  assert.equal(result.node?.status, 'pending')

  const graph = readGraph(memory)
  assert.equal(graph.nodes.length, 2)
  assert.equal(graph.history.length, 1, 'one accepted mutation = one history entry')
  assert.equal(graph.history[0].op, 'add')
  assert.equal(graph.history[0].nodeId, 'phase-1')
})

test('dag: the graph is durable — a second read sees the same nodes', () => {
  const { memory } = dirs()
  updateGraph(memory, { op: 'add', nodeId: 'a', node: { title: 'A', nodeType: 'analysis' } })
  updateGraph(memory, { op: 'add', nodeId: 'b', node: { title: 'B', nodeType: 'coding' } })
  const graph = readGraph(memory)
  assert.deepEqual(graph.nodes.map((node) => node.id), [START_NODE_ID, 'a', 'b'])
  assert.ok(existsSync(graphPath(memory)))
  assert.equal(JSON.parse(readFileSync(graphPath(memory), 'utf8')).nodes.length, 3, 'complete JSON, always')
})

test('dag: update changes a node and records ONLY the fields that moved', () => {
  const { memory } = dirs()
  updateGraph(memory, { op: 'add', nodeId: 'a', node: { title: 'A', nodeType: 'analysis' } })
  const result = updateGraph(memory, {
    op: 'update',
    nodeId: 'a',
    node: { title: 'A2', nodeType: 'coding' },
    reason: '阶段变了',
  })
  assert.equal(result.ok, true)
  assert.equal(result.node?.title, 'A2')
  assert.equal(result.node?.nodeType, 'coding')
  const last = readGraph(memory).history.at(-1)
  assert.deepEqual(last?.changed, ['title', 'nodeType'])
  assert.equal(last?.reason, '阶段变了')
})

test('dag: a no-op update records no changed fields (so the history stays honest)', () => {
  const { memory } = dirs()
  updateGraph(memory, { op: 'add', nodeId: 'a', node: { title: 'A', nodeType: 'coding' } })
  const result = updateGraph(memory, { op: 'update', nodeId: 'a', node: { title: 'A', nodeType: 'coding' } })
  assert.equal(result.ok, true)
  assert.deepEqual(readGraph(memory).history.at(-1)?.changed, [], 'nothing moved, nothing claimed')
})

test('dag: activate / complete move the status, and abandon is available', () => {
  const { memory } = dirs()
  updateGraph(memory, { op: 'add', nodeId: 'a', node: { title: 'A', nodeType: 'coding' } })
  assert.equal(updateGraph(memory, { op: 'activate', nodeId: 'a' }).node?.status, 'active')
  assert.equal(updateGraph(memory, { op: 'complete', nodeId: 'a' }).node?.status, 'done')
  assert.equal(updateGraph(memory, { op: 'deprecate', nodeId: 'a' }).node?.status, 'abandoned')
})

test('dag: deprecate does NOT delete a node — the path it took stays readable', () => {
  const { memory } = dirs()
  updateGraph(memory, { op: 'add', nodeId: 'dead-end', node: { title: '走错的路', nodeType: 'debugging' } })
  updateGraph(memory, { op: 'deprecate', nodeId: 'dead-end' })
  const graph = readGraph(memory)
  assert.equal(graph.nodes.length, 2, 'the node is still there')
  assert.equal(graph.nodes[1].status, 'abandoned')
})

test('dag: a dangling dependency is refused', () => {
  const { memory } = dirs()
  const result = updateGraph(memory, { op: 'add', nodeId: 'a', node: { dependsOn: ['ghost'] } })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DANGLING_DEPENDENCY')
  assert.match(result.reason ?? '', /ghost/u)
  assert.equal(readGraph(memory).nodes.length, 1, 'a refused write changes nothing')
})

test('dag: a cycle is refused, and the refusal names the operation', () => {
  const { memory } = dirs()
  updateGraph(memory, { op: 'add', nodeId: 'a', node: { dependsOn: [] } })
  updateGraph(memory, { op: 'add', nodeId: 'b', node: { dependsOn: ['a'] } })
  const cyc = updateGraph(memory, { op: 'update', nodeId: 'a', node: { dependsOn: ['b'] } })
  assert.equal(cyc.ok, false)
  assert.equal(cyc.code, 'CYCLE')
  assert.equal(readGraph(memory).nodes.find((node) => node.id === 'a')?.dependsOn.length, 0, 'unchanged')
})

test('dag: hasCycle is a real check, not a self-edge check', () => {
  const base = (id, dependsOn) => ({ id, title: id, nodeType: '', requirements: [], status: 'pending', dependsOn, knowledgePointers: [], fixed: false, createdAt: '', updatedAt: '' })
  assert.equal(hasCycle([base('a', []), base('b', ['a'])]), false)
  assert.equal(hasCycle([base('a', ['c']), base('b', ['a']), base('c', ['b'])]), true, 'a three-node ring is a cycle')
  assert.equal(hasCycle([base('a', ['a'])]), true, 'a self-edge is a cycle')
})

test('dag: a duplicate node id is refused, and the message says which op to use', () => {
  const { memory } = dirs()
  updateGraph(memory, { op: 'add', nodeId: 'a', node: { title: 'A' } })
  const again = updateGraph(memory, { op: 'add', nodeId: 'a', node: { title: 'A again' } })
  assert.equal(again.code, 'NODE_EXISTS')
  assert.match(again.reason ?? '', /update/u)
})

/* ── the goal lock ─────────────────────────────────────────────────────────────────────────── */

test('dag: lock-goal records the objective and makes the goal node immutable', () => {
  const { memory } = dirs()
  const locked = updateGraph(memory, { op: 'lock-goal', goal: '修好 1046 崩溃，且四个仓库全绿' })
  assert.equal(locked.ok, true)
  assert.ok(locked.graph.goalLockedAt.length > 0)
  assert.equal(locked.graph.goal, '修好 1046 崩溃，且四个仓库全绿')
  assert.equal(locked.node?.id, GOAL_NODE_ID)

  const edit = updateGraph(memory, { op: 'update', nodeId: GOAL_NODE_ID, node: { requirements: ['把崩溃的测试删掉'] } })
  assert.equal(edit.ok, false)
  assert.equal(edit.code, 'GOAL_LOCKED')
  assert.match(edit.reason ?? '', /unlock-goal/u, 'the refusal names the way out')

  const abandon = updateGraph(memory, { op: 'deprecate', nodeId: GOAL_NODE_ID })
  assert.equal(abandon.code, 'GOAL_LOCKED', 'deprecating the goal is the same escape, differently spelled')
})

test('dag: a locked goal still lets you ADD nodes and change PATHS', () => {
  const { memory } = dirs()
  updateGraph(memory, { op: 'lock-goal', goal: '最终目标' })
  assert.equal(updateGraph(memory, { op: 'add', nodeId: 'detour', node: { title: '改走另一条路' } }).ok, true)
  assert.equal(updateGraph(memory, { op: 'add', nodeId: 'step-2', node: { dependsOn: ['detour'] } }).ok, true)
  assert.equal(updateGraph(memory, { op: 'update', nodeId: 'detour', node: { nodeType: 'debugging' } }).ok, true)
  assert.equal(updateGraph(memory, { op: 'activate', nodeId: GOAL_NODE_ID }).ok, true, 'working on the goal is allowed')
})

test('dag: unlock-goal REQUIRES a reason and records it', () => {
  const { memory } = dirs()
  updateGraph(memory, { op: 'lock-goal', goal: '目标' })
  const noReason = updateGraph(memory, { op: 'unlock-goal' })
  assert.equal(noReason.ok, false)
  assert.equal(noReason.code, 'MISSING_REASON')

  const ok = updateGraph(memory, { op: 'unlock-goal', reason: '用户改主意了：先做兼容层' })
  assert.equal(ok.ok, true)
  assert.equal(ok.graph.goalLockedAt, '')
  const last = readGraph(memory).history.at(-1)
  assert.equal(last?.op, 'unlock-goal')
  assert.match(last?.reason ?? '', /用户改主意/u)
})

test('dag: lock-goal with no objective is refused (an unnamed goal protects nothing)', () => {
  const { memory } = dirs()
  const result = updateGraph(memory, { op: 'lock-goal' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MISSING_REASON')
})

/* ── the bidirectional anchor ─────────────────────────────────────────────────────────────── */

test('dag: a node pointer writes the REVERSE anchor into the knowledge base', () => {
  const { memory, knowledge } = dirs()
  writeKnowledge(knowledge, [
    { id: 'wal-before-batch', title: '批量写前先切 WAL', tags: ['sqlite'], applicableNodeTypes: ['coding'] },
  ])
  const result = updateGraph(memory, {
    op: 'add',
    nodeId: 'phase-1',
    node: { title: '写批量导入', nodeType: 'coding', knowledgePointers: ['wal-before-batch'] },
    knowledgeDir: knowledge,
  })
  assert.equal(result.anchored, 1, 'the forward pointer produced a reverse row')

  const hits = queryKnowledge(knowledge, { tags: ['sqlite'] }).hits
  assert.deepEqual(
    hits[0].referencedBy.map((ref) => ref.nodeId),
    ['phase-1'],
    'the entry now knows which task node used it',
  )
})

test('dag: adding a pointer via UPDATE anchors it too (the half that is easy to forget)', () => {
  const { memory, knowledge } = dirs()
  writeKnowledge(knowledge, [{ id: 'no-mock-db', kind: 'negative', title: '别 mock 数据库', applicableNodeTypes: ['testing'] }])
  updateGraph(memory, { op: 'add', nodeId: 'phase-1', node: { title: 'P1', nodeType: 'testing' } })
  const result = updateGraph(memory, {
    op: 'update',
    nodeId: 'phase-1',
    node: { knowledgePointers: ['no-mock-db'] },
    knowledgeDir: knowledge,
  })
  assert.equal(result.anchored, 1)
  assert.equal(queryKnowledge(knowledge, { nodeType: 'testing' }).hits[0].referencedBy.length, 1)
})

test('dag: re-anchoring the same pointer does not duplicate the reverse row', () => {
  const { memory, knowledge } = dirs()
  writeKnowledge(knowledge, [{ id: 'k1', title: 'K', tags: ['x'] }])
  updateGraph(memory, { op: 'add', nodeId: 'n1', node: { knowledgePointers: ['k1'] }, knowledgeDir: knowledge })
  const second = updateGraph(memory, { op: 'update', nodeId: 'n1', node: { title: 'renamed' }, knowledgeDir: knowledge })
  assert.equal(second.anchored, 0, 'the anchor is idempotent; only the edit happened')
})

test('dag: describeGraph resolves pointers and computes the unlock edges', () => {
  const { memory, knowledge } = dirs()
  writeKnowledge(knowledge, [{ id: 'k1', title: '知识一', tags: ['x'] }])
  updateGraph(memory, { op: 'add', nodeId: 'a', node: { title: 'A', knowledgePointers: ['k1'] } })
  updateGraph(memory, { op: 'add', nodeId: 'b', node: { title: 'B', dependsOn: ['a'] } })

  const described = describeGraph(memory, readKnowledge(knowledge))
  const a = described.nodes.find((node) => node.id === 'a')
  const b = described.nodes.find((node) => node.id === 'b')
  assert.equal(a?.knowledge[0]?.title, '知识一', 'the pointer resolves to the entry itself')
  assert.deepEqual(a?.unlocks, ['b'], 'the edge is computed from dependsOn, both directions')
  assert.deepEqual(b?.knowledge, [], 'a node with no pointers resolves to nothing, not to garbage')
  assert.equal(described.counts.total, 3)
  assert.equal(described.counts.done, 1, 'the fixed start node is behind the work, so it is done')
  assert.equal(described.counts.pending, 2)
})

test('dag: describeGraph counts statuses so the console can colour the DAG', () => {
  const { memory } = dirs()
  updateGraph(memory, { op: 'add', nodeId: 'a' })
  updateGraph(memory, { op: 'add', nodeId: 'b' })
  updateGraph(memory, { op: 'add', nodeId: 'c' })
  updateGraph(memory, { op: 'activate', nodeId: 'a' })
  updateGraph(memory, { op: 'complete', nodeId: 'b' })
  updateGraph(memory, { op: 'deprecate', nodeId: 'c' })
  const { counts } = describeGraph(memory, [])
  /**
   * `start` is `done`, not `pending`: the origin is behind the work by definition. That is also
   * why the totals add up — every node has exactly one status and the start node is not a
   * permanently "waiting" hole in the console.
   */
  assert.deepEqual(counts, { total: 4, pending: 0, active: 1, done: 2, abandoned: 1 }, JSON.stringify(counts))
  assert.equal(counts.pending + counts.active + counts.done + counts.abandoned, counts.total)
})

test('dag: updatedAt and history survive a restart', () => {
  const { memory } = dirs()
  updateGraph(memory, { op: 'add', nodeId: 'a', at: '2026-01-01T00:00:00.000Z' })
  updateGraph(memory, { op: 'complete', nodeId: 'a', at: '2026-01-02T00:00:00.000Z' })
  const graph = readGraph(memory)
  assert.equal(graph.updatedAt, '2026-01-02T00:00:00.000Z')
  assert.deepEqual(
    graph.history.map((entry) => `${entry.op}@${entry.at}`),
    ['add@2026-01-01T00:00:00.000Z', 'complete@2026-01-02T00:00:00.000Z'],
  )
})

test('dag: an unknown op is refused with the list of valid ones', () => {
  const { memory } = dirs()
  const result = updateGraph(memory, { op: 'explode' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UNKNOWN_OP')
  assert.match(result.reason ?? '', /add/u)
  assert.match(result.reason ?? '', /lock-goal/u)
})

test('dag: a corrupt file reads as a blank graph instead of throwing', () => {
  const { memory } = dirs()
  mkdirSync(memory, { recursive: true })
  writeFileSync(graphPath(memory), '{ this is not json', 'utf8')
  const graph = readGraph(memory)
  assert.equal(graph.nodes.length, 1)
  assert.equal(graph.nodes[0].id, START_NODE_ID)
})

test('dag: renderNodeBanner names the node, phase, requirements and knowledge', () => {
  const { memory, knowledge } = dirs()
  writeKnowledge(knowledge, [{ id: 'k1', title: '知识一', tags: ['x'] }])
  updateGraph(memory, {
    op: 'add',
    nodeId: 'testing-node',
    node: { title: 'T', nodeType: 'testing', requirements: ['覆盖 1046'], knowledgePointers: ['k1'] },
  })
  updateGraph(memory, { op: 'activate', nodeId: 'testing-node' })
  const node = describeGraph(memory, readKnowledge(knowledge)).nodes.find((item) => item.id === 'testing-node')
  const banner = renderNodeBanner(node)
  assert.ok(banner !== undefined)
  assert.match(banner, /testing-node/u)
  assert.match(banner, /testing/u)
  assert.match(banner, /覆盖 1046/u)
  assert.match(banner, /知识一/u)
  assert.equal(renderNodeBanner(undefined), undefined)
})

test('dag: emptyGraph is a usable value, not a special case at every call site', () => {
  const graph = emptyGraph('g1', '2026-01-01T00:00:00.000Z')
  assert.equal(graph.id, 'g1')
  assert.equal(graph.version, 1)
  assert.equal(graph.nodes.length, 1)
  assert.equal(graph.goalLockedAt, '')
})
