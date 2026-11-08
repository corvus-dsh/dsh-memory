/**
 * P1-5 (audit 2026-11-08) — A BROKEN `harvestedAt` MUST NOT SILENCE THE REMINDER FOREVER.
 *
 * `harvestedAt` is read as a BOOLEAN by three consumers: the `complete` receipt (`harvestRequired`),
 * the pre-step reminder, and the `unharvested` statistic. Any non-empty string therefore means
 * "this phase answered". The graph is a plain JSON document that a hand edit, an external writer or a
 * half-finished migration can touch, so `harvestedAt: "yes"` used to silence the reminder for that
 * node permanently — with nothing reporting it.
 *
 * These tests pin TWO things: that a non-timestamp reads back as "not harvested", and that the
 * consequence — the reminder fires again — actually happens end to end. The second is the one that
 * matters; the first is only the mechanism.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readGraph } from '../lib/graph.js'

function memoryDir() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-harvest-at-'))
  const memory = join(root, 'memory')
  mkdirSync(memory, { recursive: true })
  return memory
}

/** Write a graph with one finished node carrying the given `harvestedAt`. */
function writeGraphWith(memory, harvestedAt) {
  const node = {
    id: 'n1',
    title: 'N1',
    nodeType: 'coding',
    requirements: [],
    status: 'done',
    dependsOn: ['start'],
    knowledgePointers: [],
    fixed: false,
    harvestedAt,
    createdAt: '2026-11-08T00:00:00.000Z',
    updatedAt: '2026-11-08T00:00:00.000Z',
  }
  writeFileSync(
    join(memory, 'task-graph.json'),
    JSON.stringify(
      {
        version: 1,
        id: 'default',
        goal: '',
        goalLockedAt: '',
        nodes: [
          { id: 'start', title: '开始', nodeType: '', requirements: [], status: 'done', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z' },
          node,
        ],
        history: [],
        createdAt: '2026-11-08T00:00:00.000Z',
        updatedAt: '2026-11-08T00:00:00.000Z',
      },
      null,
      2,
    ),
    'utf8',
  )
}

const harvestedAtOf = (memory) => readGraph(memory).nodes.find((node) => node.id === 'n1')?.harvestedAt

async function makePlugin() {
  const memory = memoryDir()
  const knowledgeDir = join(memory, '..', 'knowledge')
  const tools = new Map()
  const handlers = []
  const ctx = {
    paths: { data: memory },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    on: (event, handler) => handlers.push({ event, handler }),
    get: () => undefined,
  }
  const { apply } = await import('../lib/index.js')
  apply(ctx, { memoryDir: memory, skillsDir: join(memory, '..', 'skills'), knowledgeDir, retrieval: true })
  return { memory, knowledgeDir, tools, handlers }
}

test('P1-5: a real ISO timestamp is preserved exactly', () => {
  const memory = memoryDir()
  writeGraphWith(memory, '2026-11-08T12:34:56.789Z')
  assert.equal(harvestedAtOf(memory), '2026-11-08T12:34:56.789Z')
})

test('P1-5: a non-timestamp READS BACK AS "not harvested"', () => {
  for (const bad of ['yes', 'pending', '2026-11-08', '2026-11-08 12:00:00', 'not-a-date', '0']) {
    const memory = memoryDir()
    writeGraphWith(memory, bad)
    assert.equal(
      harvestedAtOf(memory),
      '',
      `${JSON.stringify(bad)} must not count as a harvest — otherwise the reminder is silenced forever`,
    )
  }
})

test('P1-5: an impossible date with the right SHAPE is still refused', () => {
  // Passes the regex, fails Date.parse: 13 months / 32 days.
  const memory = memoryDir()
  writeGraphWith(memory, '2026-13-32T00:00:00.000Z')
  assert.equal(harvestedAtOf(memory), '', 'a well-shaped but unreal instant is not a harvest')
})

test('P1-5: a non-string value is refused', () => {
  for (const bad of [123, true, null, { at: 'x' }, ['2026-11-08T00:00:00.000Z']]) {
    const memory = memoryDir()
    writeGraphWith(memory, bad)
    assert.equal(harvestedAtOf(memory), '', `${JSON.stringify(bad)} is not a timestamp`)
  }
})

test('P1-5: an EMPTY harvestedAt stays empty (the normal un-harvested state)', () => {
  const memory = memoryDir()
  writeGraphWith(memory, '')
  assert.equal(harvestedAtOf(memory), '')
})

/* ── the consequence: the reminder fires again ─────────────────────────────────────────────── */

test('P1-5 ACCEPTANCE: a corrupted harvestedAt makes the harvest reminder fire again', async () => {
  const { memory, tools, handlers } = await makePlugin()
  // A finished phase whose tag is not a timestamp — the hand-edited-file scenario.
  writeGraphWith(memory, 'yes')

  const state = await tools.get('memory_graph_read').execute({})
  const node = state.nodes.find((item) => item.id === 'n1')
  assert.equal(node.harvestedAt, '', 'read back as not harvested')

  const stats = await tools.get('knowledge_stats').execute({})
  assert.equal(stats.unharvested, 1, 'the statistics agree it is unanswered')

  const handler = handlers.find((item) => item.event === 'agent/pre-step')?.handler
  const payload = { agent: { id: 'agent-1' }, messages: [{ role: 'user', content: [{ type: 'text', text: '继续推进任务' }] }] }
  const result = await handler(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  const reminders = (result.messages ?? []).filter((message) => String(message.id ?? '').startsWith('memory-harvest-warn-'))
  assert.equal(reminders.length, 1, `expected the reminder to fire, got ${JSON.stringify(result.messages?.map((m) => m?.id))}`)
  assert.match(reminders[0].content[0].text, /knowledge_harvest/u)
})

test('P1-5 ACCEPTANCE: a VALID timestamp keeps it silent (the check has not broken the normal path)', async () => {
  const { memory, tools, handlers } = await makePlugin()
  writeGraphWith(memory, '2026-11-08T12:00:00.000Z')

  const stats = await tools.get('knowledge_stats').execute({})
  assert.equal(stats.unharvested, 0)

  const handler = handlers.find((item) => item.event === 'agent/pre-step')?.handler
  const payload = { agent: { id: 'agent-1' }, messages: [{ role: 'user', content: [{ type: 'text', text: '继续推进任务' }] }] }
  const result = await handler(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  assert.equal(
    (result.messages ?? []).filter((message) => String(message.id ?? '').startsWith('memory-harvest-warn-')).length,
    0,
    'an answered phase must not be nagged',
  )
})
