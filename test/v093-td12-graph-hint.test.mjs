/**
 * TD-12 — the task graph has never been created, and nothing said so.
 *
 * THE MEASURED STATE this pins: `memory_graph_read`, `memory_graph_update` and the cross-slice
 * phase nudge are all implemented, and `phaseNudge` defaults to ON. But `task-graph.json` does
 * not exist in any workspace, and `readGraph` returns an EMPTY graph for a missing file instead
 * of throwing — so `phaseNudgeFor` finds no active node, returns `undefined`, and the whole
 * "pull knowledge by node type" chain is inert. A finished feature that was never plugged in.
 *
 * WHY THE FIX IS A LINE OF TEXT AND NOT AN AUTO-CREATE: an auto-created graph has no author.
 * "Who decided this is phase 2" is the entire point of a durable task graph, and inventing a
 * node on the model's behalf destroys exactly that. The cost of that choice is that nothing
 * exists unless something says so — and nothing did. `memory_stats` is where a model already
 * looks, so the hint lives there.
 *
 * WHAT THIS FILE DOES *NOT* ASSERT: that the graph is created, that any tool behaviour changed,
 * or that `phaseNudgeFor` was touched. All three are explicitly out of scope (no auto-build).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

function harness({ memory }) {
  const tools = []
  const ctx = {
    paths: { data: memory },
    tools: { register: (definition) => tools.push(definition) },
    on: () => {},
    get: (name) => {
      if (name === 'sessions') return { get: () => undefined, list: () => [] }
      return undefined
    },
    logger: { info: () => {}, warn: () => {} },
  }
  return { ctx, tools }
}

async function statsOf(root) {
  const memory = join(root, 'memory')
  mkdirSync(memory, { recursive: true })
  const { ctx, tools } = harness({ memory })
  apply(ctx, { memoryDir: memory, skillsDir: join(root, 'skills'), retrieval: false })
  const stats = tools.find((tool) => tool.name === 'memory_stats')
  assert.ok(stats !== undefined, 'memory_stats must be registered')
  return { out: await stats.execute({}, { agent: { id: 'a1' } }), memory }
}

test('TD-12: memory_stats says there is no task graph, and how to create one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-td12-absent-'))
  const { out, memory } = await statsOf(root)

  assert.ok(out?.taskGraph, 'the graph status must be reported')
  assert.equal(out.taskGraph.present, false)
  assert.equal(out.taskGraph.path, join(memory, 'task-graph.json'))
  assert.match(out.taskGraph.hint, /尚无任务图/u)
  // The hint must be actionable, not decorative: it names the tool and the reason.
  assert.match(out.taskGraph.hint, /memory_graph_update/u)
  assert.match(out.taskGraph.hint, /阶段节点/u)
  assert.match(out.taskGraph.hint, /跨切片/u)
})

test('TD-12: with a task graph present there is no hint, and the counts are real', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-td12-present-'))
  const memory = join(root, 'memory')
  mkdirSync(memory, { recursive: true })
  // The START node plus one phase the model created. Hand-written on purpose: this test is
  // about REPORTING, so it must not depend on the write path it is not testing.
  writeFileSync(
    join(memory, 'task-graph.json'),
    JSON.stringify({
      id: 'default',
      goal: '',
      nodes: [
        { id: 'start', title: '开始', nodeType: '', requirements: [], status: 'done', dependsOn: [], knowledgePointers: [], fixed: true },
        { id: 'n1', title: '阶段 1', nodeType: 'coding', requirements: [], status: 'active', dependsOn: ['start'], knowledgePointers: [] },
      ],
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    'utf8',
  )

  const { ctx, tools } = harness({ memory })
  apply(ctx, { memoryDir: memory, skillsDir: join(root, 'skills'), retrieval: false })
  const stats = tools.find((tool) => tool.name === 'memory_stats')
  const out = await stats.execute({}, { agent: { id: 'a1' } })

  assert.equal(out.taskGraph.present, true)
  assert.equal(out.taskGraph.hint, undefined, 'a graph that exists needs no "there is none" hint')
  assert.equal(out.taskGraph.nodes, 2)
  assert.equal(out.taskGraph.phaseNodes, 1, 'the fixed START node is not a phase the model created')
})

test('TD-12: the hint is TEXT ONLY — reading stats creates nothing on disk', async () => {
  // The no-auto-build rule, asserted rather than assumed. A hint that quietly materialised a
  // graph would violate exactly the property (traceable authorship) the design trades for.
  const root = mkdtempSync(join(tmpdir(), 'dsh-td12-noauto-'))
  const { out, memory } = await statsOf(root)
  assert.equal(out.taskGraph.present, false)

  const { existsSync } = await import('node:fs')
  assert.equal(existsSync(join(memory, 'task-graph.json')), false, 'reading stats must never create the graph')
})
