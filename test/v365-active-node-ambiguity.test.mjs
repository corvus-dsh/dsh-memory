/**
 * ── v365：S11 / M1 —— 多个 active 节点时不许静默取 `[0]` ─────────────────────────────────────────
 *
 * 病（`src/index.ts` 的 `memory_taskgraph_read` 处理器）：
 *
 *     const active = described.activeWorkNodes[0]
 *     ...
 *     activeNodeId: active?.id ?? '',
 *
 * 只要 `activeWorkNodes` 里有多于一个节点，它就**默默把第一个当成「当前要做的事」**。调用方看到的
 * 字段叫 `activeNodeId`，读起来像「当前节点就是它」，没有任何地方说「其实有 2 个，我挑了 1 个」。
 *
 * 这与本仓反复出现的那一类同源：**多个候选时不该猜，应当报告不确定**。
 *
 * 判据：
 *   ① 一个 active ⇒ `RESOLVED`，`activeNodeId` 就是它，行为与从前一致（不许把正常路径改坏）
 *   ② 两个 active ⇒ `AMBIGUOUS`，`activeNodeId` **留空**（不猜），`activeNodeCandidates` 列出全部
 *   ③ 两个 active ⇒ 横幅必须说「有 N 个」，而不是渲染其中一个节点的横幅
 *   ④ 零个 active ⇒ `RESOLVED` 且 `activeNodeId` 为空（「没有进行中的节点」不是「不确定」）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const makeEnv = async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-m1-'))
  const memoryDir = join(root, 'memory')
  const skillsDir = join(root, 'skills')
  const knowledgeDir = join(root, 'knowledge')
  const tools = new Map()
  const handlers = []
  const ctx = {
    paths: { data: root },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    on: (event, handler) => handlers.push({ event, handler }),
    get: () => undefined,
  }
  const { apply } = await import('../lib/index.js')
  apply(ctx, { memoryDir, skillsDir, knowledgeDir, retrieval: true })
  return { memoryDir, tools }
}

/**
 * A plan whose nodes carry the statuses under test.
 *
 * 两处实测出来的约束（都不是猜的）：
 *   · `start` / `goal` 是**保留 id**，bootstrap 自己创建它们，批次里不许再声明
 *     （实测 INVALID_FIELD：「节点 start 用了保留 id」）；
 *   · `bootstrap` 要求 `goal` + `reason` + 图级 `author`，且 `author.kind` 只接受
 *     `user | model | subagent | observer | system`。
 *
 * 所以要凑够 `minItems: 3`，由调用方给出至少 3 个**自己的**节点（`start` / `goal` 另算）。
 */
const buildGraph = async (tools, nodes) => {
  assert.ok(nodes.length >= 3, `夹具需要至少 3 个自有节点（bootstrap 的 minItems），实测 ${nodes.length}`)
  const written = await tools.get('memory_graph_update').execute({
    op: 'bootstrap',
    goal: '验证 M1：多个 active 节点必须报 AMBIGUOUS',
    reason: 'v365 判据夹具：验证 active 节点的歧义判定',
    author: {
      kind: 'model',
      sessionId: 'v365-session',
      generation: 0,
      attempt: 1,
      at: new Date('2026-11-25T00:00:00Z').toISOString(),
    },
    nodes,
  })
  assert.equal(written.ok ?? true, true,
    `前置：建图必须成功（实测 ${JSON.stringify(written).slice(0, 240)}）`)
}

test('v365 ①: ONE active node is RESOLVED — the normal path is unchanged', async () => {
  const { tools } = await makeEnv()
  await buildGraph(tools, [
    { id: 'n1', title: '第一件', status: 'active', nodeType: 'coding' },
    { id: 'n2', title: '第二件', status: 'pending', nodeType: 'coding' },
    { id: 'n3', title: '第三件', status: 'pending', nodeType: 'coding' },
  ])
  const read = await tools.get('memory_graph_read').execute({})
  assert.equal(read.activeNodeStatus, 'RESOLVED', '① 单个 active ⇒ RESOLVED')
  assert.equal(read.activeNodeId, 'n1', '① 单个 active 时必须给出它（不改既有行为）')
})

test('v365 ②: TWO active nodes are AMBIGUOUS — and `activeNodeId` stays EMPTY', async () => {
  const { tools } = await makeEnv()
  await buildGraph(tools, [
    { id: 'a1', title: '甲', status: 'active', nodeType: 'coding' },
    { id: 'a2', title: '乙', status: 'active', nodeType: 'coding' },
    { id: 'a3', title: '丙', status: 'pending', nodeType: 'coding' },
  ])
  const read = await tools.get('memory_graph_read').execute({})

  assert.equal(read.activeNodeStatus, 'AMBIGUOUS', '② 两个 active ⇒ AMBIGUOUS')
  assert.equal(read.activeNodeId, '', '② 不许静默挑一个：activeNodeId 必须留空')
  assert.deepEqual([...(read.activeNodeCandidates ?? [])].sort(), ['a1', 'a2'],
    '② 必须列出全部候选，让调用方自己决定')
})

test('v365 ③: the AMBIGUOUS banner names the COUNT and the candidates, not one node\'s banner', async () => {
  const { tools } = await makeEnv()
  await buildGraph(tools, [
    { id: 'b1', title: '任务一', status: 'active', nodeType: 'testing' },
    { id: 'b2', title: '任务二', status: 'active', nodeType: 'testing' },
    { id: 'b3', title: '任务三', status: 'pending', nodeType: 'testing' },
  ])
  const read = await tools.get('memory_graph_read').execute({})
  assert.match(read.activeBanner, /AMBIGUOUS/u, '③ 横幅必须自报 AMBIGUOUS')
  assert.match(read.activeBanner, /2/u, '③ 横幅必须说出有几个候选')
  assert.ok(read.activeBanner.includes('b1') && read.activeBanner.includes('b2'),
    '③ 横幅必须点名两个候选')
})

test('v365 ④: ZERO active nodes is RESOLVED with an empty id — 「没有」不是「不确定」', async () => {
  const { tools } = await makeEnv()
  await buildGraph(tools, [
    { id: 'c1', title: '待办', status: 'pending', nodeType: 'coding' },
    { id: 'c2', title: '另一件', status: 'pending', nodeType: 'coding' },
    { id: 'c3', title: '第三件', status: 'pending', nodeType: 'coding' },
  ])
  const read = await tools.get('memory_graph_read').execute({})
  assert.equal(read.activeNodeStatus, 'RESOLVED', '④ 没有进行中的节点 ⇒ RESOLVED（一个确定的事实）')
  assert.equal(read.activeNodeId, '', '④ 但没有节点可指')
  assert.equal(read.activeNodeCandidates, undefined, '④ 零候选时不该出现候选列表')
})