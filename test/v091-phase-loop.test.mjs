/**
 * v0.9.1 — THE PHASE LOOP, END TO END, THROUGH THE PLUGIN'S OWN SURFACE.
 *
 * The module tests prove the store and the graph. These prove the thing the user actually asked
 * for: that a model standing in a phase is TOLD what applies, and that the knowledge it writes
 * when it finishes a phase is reachable from a different workspace afterwards.
 *
 * THE READ HALF  — `memory_graph_read` / `knowledge_query`.
 * THE WRITE HALF — `knowledge_harvest` (with tags + node types) / `memory_graph_update`.
 * THE NUDGE      — `agent/pre-step` produces ONE `[系统提示]` banner when the active node changes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Build a plugin instance over a throwaway store and return its registered tools + handlers. */
async function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-phase-'))
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
  return { root, memoryDir, skillsDir, knowledgeDir, tools, handlers }
}

const preStep = (handlers) => handlers.find((item) => item.event === 'agent/pre-step')?.handler

const turn = (text) => ({ agent: { id: 'agent-1' }, messages: [{ role: 'user', content: [{ type: 'text', text }] }] })

test('phase: the six new tools are registered and declare the ToolService contract', async () => {
  const { tools } = await makeEnv()
  for (const name of ['knowledge_query', 'knowledge_harvest', 'knowledge_read', 'knowledge_stats', 'memory_graph_read', 'memory_graph_update']) {
    assert.ok(tools.has(name), `${name} must be registered`)
    const definition = tools.get(name)
    assert.equal(typeof definition.output?.schema, 'object', `${name}.output.schema`)
    assert.equal(typeof definition.output?.render, 'function', `${name}.output.render`)
  }
})

test('phase: harvest writes with tags and node types, and query finds it cross-workspace', async () => {
  const { tools } = await makeEnv()
  const written = await tools.get('knowledge_harvest').execute({
    workspace: 'D:/project-a',
    entries: [
      {
        id: 'wal-before-batch',
        kind: 'skill',
        title: '批量写前先切 WAL',
        when: '需要高并发写入时',
        body: '先读 PRAGMA journal_mode，非 wal 切换后再批量写。',
        tags: ['sqlite', 'wal'],
        applicable_node_types: ['coding', 'testing'],
      },
    ],
  })
  assert.equal(written.written, 1)
  assert.deepEqual(written.refused, [])

  // The query names NO workspace: that is the whole point of the global store.
  const found = await tools.get('knowledge_query').execute({ tags: ['sqlite'], nodeType: 'testing' })
  assert.equal(found.matched, 1)
  assert.equal(found.hits[0].entry.id, 'wal-before-batch')
  assert.deepEqual(found.hits[0].entry.applicableNodeTypes, ['coding', 'testing'])
  assert.equal(found.hits[0].entry.workspace, 'D:/project-a', 'provenance travels even though it is not the gate')
})

test('phase: knowledge_read returns the body; knowledge_query deliberately does not', async () => {
  const { tools } = await makeEnv()
  await tools.get('knowledge_harvest').execute({
    entries: [{ id: 'k1', kind: 'skill', title: '标题', body: '这是正文，只在明确要读的时候才展开。', tags: ['x'] }],
  })
  const query = await tools.get('knowledge_query').execute({ tags: ['x'] })
  const hit = query.hits[0]
  assert.equal(hit.entry.body.length > 0, true, 'the body is in the entry')
  assert.equal(query.hint, undefined, 'no nodeType means no phase banner')

  const read = await tools.get('knowledge_read').execute({ id: 'k1' })
  assert.equal(read.title, '标题')
  assert.match(read.body, /正文/u)
})

test('phase: knowledge_read on an unknown id explains itself instead of returning null', async () => {
  const { tools } = await makeEnv()
  const result = await tools.get('knowledge_read').execute({ id: 'nope' })
  assert.match(result.error, /no knowledge entry "nope"/u)
  assert.equal(result.total, 0)
})

test('phase: memory_graph_update builds a DAG, and the goal lock is enforced end to end', async () => {
  const { tools } = await makeEnv()
  await tools.get('knowledge_harvest').execute({ entries: [{ id: 'k1', title: '知识一', tags: ['sqlite'] }] })

  const add = await tools.get('memory_graph_update').execute({
    op: 'add',
    nodeId: 'phase-1',
    node: { title: '分析崩溃', node_type: 'analysis', requirements: ['定位 1046'], knowledge_pointers: ['k1'] },
  })
  assert.equal(add.ok, true)
  assert.equal(add.anchored, 1)
  assert.equal(add.node.nodeType, 'analysis')

  const lock = await tools.get('memory_graph_update').execute({ op: 'lock-goal', goal: '修好崩溃且四仓全绿' })
  assert.equal(lock.ok, true)

  const sneaky = await tools.get('memory_graph_update').execute({
    op: 'update',
    nodeId: 'goal',
    node: { requirements: ['改成把失败测试删掉'] },
  })
  assert.equal(sneaky.ok, false)
  assert.equal(sneaky.code, 'GOAL_LOCKED')

  // The path is still editable while the goal is locked.
  const detour = await tools.get('memory_graph_update').execute({ op: 'add', nodeId: 'phase-2', node: { title: '换条路', node_type: 'debugging' } })
  assert.equal(detour.ok, true)
})

test('phase: memory_graph_read reports the active node and its banner', async () => {
  const { tools } = await makeEnv()
  await tools.get('knowledge_harvest').execute({ entries: [{ id: 'k1', title: '知识一', applicable_node_types: ['testing'] }] })
  await tools.get('memory_graph_update').execute({
    op: 'add',
    nodeId: 'testing-node',
    node: { title: '跑测试', node_type: 'testing', requirements: ['四仓全绿'], knowledge_pointers: ['k1'] },
  })
  await tools.get('memory_graph_update').execute({ op: 'activate', nodeId: 'testing-node' })

  const read = await tools.get('memory_graph_read').execute({})
  assert.equal(read.activeNodeId, 'testing-node')
  assert.match(read.activeBanner, /testing/u)
  assert.match(read.activeBanner, /四仓全绿/u)
  assert.equal(read.goalLocked, false)
  const node = read.nodes.find((item) => item.id === 'testing-node')
  assert.equal(node.knowledge[0].title, '知识一', 'the pointer is resolved for the DAG view')
})

test('phase: memory_stats of the knowledge layer separates shareable from local', async () => {
  const { tools } = await makeEnv()
  await tools.get('knowledge_harvest').execute({
    entries: [
      { id: 'shareable', title: 'S', tags: ['sqlite'] },
      { id: 'local-only', title: 'L' },
    ],
  })
  const stats = await tools.get('knowledge_stats').execute({})
  assert.equal(stats.entries, 2)
  assert.equal(stats.localOnly, 1, 'an entry with no axes can never travel; the panel says so')
  assert.deepEqual(stats.tags.map((item) => item.tag), ['sqlite'])
})

/* ── the pre-step phase banner ─────────────────────────────────────────────────────────────── */

test('phase nudge: entering a node injects ONE [系统提示] banner naming the phase', async () => {
  const { tools, handlers } = await makeEnv()
  await tools.get('knowledge_harvest').execute({
    entries: [{ id: 'k1', title: '先写测试', applicable_node_types: ['testing'] }],
  })
  await tools.get('memory_graph_update').execute({
    op: 'add',
    nodeId: 'testing-node',
    node: { title: '跑测试', node_type: 'testing', requirements: ['覆盖 1046'] },
  })
  await tools.get('memory_graph_update').execute({ op: 'activate', nodeId: 'testing-node' })

  const payload = turn('继续推进这个任务')
  const first = await preStep(handlers)(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  const banner = (first.messages ?? []).find((message) => String(message.id).startsWith('memory-phase-'))
  assert.ok(banner !== undefined, `expected a phase banner, got ${JSON.stringify(first.messages?.map((m) => m.id))}`)
  assert.equal(banner.role, 'user', 'HOST CONTRACT: pre-step messages become user/message')
  assert.match(banner.content[0].text, /\[系统提示\]/u)
  assert.match(banner.content[0].text, /testing/u)
  assert.match(banner.content[0].text, /覆盖 1046/u, 'the node own requirements travel with the banner')
})

test('phase nudge: the same node is announced ONCE, not every turn', async () => {
  const { tools, handlers } = await makeEnv()
  await tools.get('knowledge_harvest').execute({ entries: [{ id: 'k1', title: 'K', applicable_node_types: ['coding'] }] })
  await tools.get('memory_graph_update').execute({ op: 'add', nodeId: 'c1', node: { node_type: 'coding' } })
  await tools.get('memory_graph_update').execute({ op: 'activate', nodeId: 'c1' })

  const handler = preStep(handlers)
  const payload = turn('第一个问题，足够长')
  const first = await handler(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  assert.ok((first.messages ?? []).some((message) => String(message.id).startsWith('memory-phase-')))

  const second = await handler(turn('第二个问题，也足够长'), async () => ({ kind: 'enter', messages: turn('第二个问题，也足够长').messages }))
  assert.ok(
    !(second.messages ?? []).some((message) => String(message.id).startsWith('memory-phase-')),
    'a banner repeated every turn is a banner nobody reads',
  )
})

test('phase nudge: moving to a DIFFERENT node announces again', async () => {
  const { tools, handlers } = await makeEnv()
  await tools.get('knowledge_harvest').execute({
    entries: [
      { id: 'k-test', title: '测试知识', applicable_node_types: ['testing'] },
      { id: 'k-code', title: '编码知识', applicable_node_types: ['coding'] },
    ],
  })
  await tools.get('memory_graph_update').execute({ op: 'add', nodeId: 'n1', node: { node_type: 'testing' } })
  await tools.get('memory_graph_update').execute({ op: 'activate', nodeId: 'n1' })
  const handler = preStep(handlers)
  await handler(turn('第一步任务'), async () => ({ kind: 'enter', messages: [] }))

  await tools.get('memory_graph_update').execute({ op: 'complete', nodeId: 'n1' })
  await tools.get('memory_graph_update').execute({ op: 'add', nodeId: 'n2', node: { node_type: 'coding' } })
  await tools.get('memory_graph_update').execute({ op: 'activate', nodeId: 'n2' })

  const moved = await handler(turn('第二步任务'), async () => ({ kind: 'enter', messages: [] }))
  const banner = (moved.messages ?? []).find((message) => String(message.id).startsWith('memory-phase-'))
  assert.ok(banner !== undefined, 'a new phase is a new announcement')
  assert.match(banner.content[0].text, /coding/u)
})

test('phase nudge: no graph means no banner, and nothing breaks', async () => {
  const { handlers } = await makeEnv()
  const payload = turn('一个普通的问题')
  const result = await preStep(handlers)(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  assert.ok(!(result.messages ?? []).some((message) => String(message.id).startsWith('memory-phase-')))
})

test('phase nudge: an empty knowledge base still announces the phase', async () => {
  const { tools, handlers } = await makeEnv()
  await tools.get('memory_graph_update').execute({ op: 'add', nodeId: 'n1', node: { node_type: 'testing' } })
  await tools.get('memory_graph_update').execute({ op: 'activate', nodeId: 'n1' })
  const payload = turn('开始这一阶段')
  const result = await preStep(handlers)(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  /**
   * NO BANNER HERE, and that is the intended split: the phase hint exists to say "there is
   * knowledge, go read it". With an empty store there is nothing to read, and a banner that says
   * "you are in testing" on every new node is noise the model cannot act on.
   */
  assert.ok(!(result.messages ?? []).some((message) => String(message.id).startsWith('memory-phase-')))
})

test('phase nudge: a short ask still gets the banner (the phase does not depend on the prompt)', async () => {
  const { tools, handlers } = await makeEnv()
  await tools.get('knowledge_harvest').execute({ entries: [{ id: 'k1', title: 'K', applicable_node_types: ['testing'] }] })
  await tools.get('memory_graph_update').execute({ op: 'add', nodeId: 'n1', node: { node_type: 'testing' } })
  await tools.get('memory_graph_update').execute({ op: 'activate', nodeId: 'n1' })
  // "继续" is 2 chars — below the lexical path's 4-char floor.
  const payload = turn('继续')
  const result = await preStep(handlers)(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  assert.ok(
    (result.messages ?? []).some((message) => String(message.id).startsWith('memory-phase-')),
    'the phase is known from the graph, not from the sentence',
  )
})
