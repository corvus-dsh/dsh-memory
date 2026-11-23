/**
 * ── v324 / G-8b (P0): 「读不出来」时不许递上一份健康的空图 ────────────────────────────────────────
 *
 * 路径：**公开工具**（`memory_graph_read`）+ **真实渲染用的 payload** —— 模型实际读到的那一份。
 *
 * ── 缺陷（lead 实测，§24.3）────────────────────────────────────────────────────────────────────
 *
 * G-8 让 `memory_graph_read` 说出了 `readStatus: "unreadable"`，但同一份回执还带着：
 *
 *     nodes        = ["start"]
 *     counts       = { total: 1, pending: 0, active: 0, done: 1, ... }
 *     activeNodeId = ""
 *
 * —— 这正是「健康、只是还没建过计划」的形状。根因：`describeGraph` 仍然走 `readGraph`（fail-open 到
 * 空图），于是空图数据**覆盖**了三态结果，`readStatus` 只是贴上去的一个字段。
 *
 * 模型据 `nodes`/`counts` 决定要不要 bootstrap，于是会拿一张空图**覆盖**它只是读不出来的计划。
 *
 * `v321 ①` 只钉住「说了什么」，没钉住「同时递了什么」（§〇 31：按身份挑，不按数量挑）。
 *
 * ── 判据（三条，两条负向）─────────────────────────────────────────────────────────────────────
 *
 *   ① 损坏图 ⇒ `readStatus='unreadable'` **且** nodes 不得是 `["start"]` **且** counts 不得给出健康计数
 *   ② **负向** 文件不存在 ⇒ `absent` 且 `nodes=["start"]` 仍然正确（「没建过」是事实，不是失败）
 *   ③ **负向** 健康图 ⇒ nodes/counts 与今天完全一致（不许为了修 ① 把正常路径也掏空）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..', '..')

const node = (id, title, status, extra = {}) => ({
  id,
  title,
  nodeType: 'coding',
  requirements: ['要求一'],
  status,
  dependsOn: [],
  knowledgePointers: [],
  fixed: id === 'start' || id === 'goal',
  harvestedAt: '',
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
  ...extra,
})

const healthyGraph = {
  version: 1,
  id: 'default',
  goal: '目标',
  goalLockedAt: '2026-11-18T00:00:00.000Z',
  nodes: [
    node('start', '开始', 'done'),
    node('goal', '目标', 'pending', { requirements: ['目标'] }),
    node('phase-b4', 'B4', 'active'),
    node('phase-b5', 'B5', 'pending'),
  ],
  history: [],
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
  persistentConstraints: [],
}

async function env({ graphBody, omitGraph = false } = {}) {
  const memory = await import(pathToFileURL(join(ROOT, 'dsh-memory', 'lib', 'index.js')).href)
  const root = mkdtempSync(join(tmpdir(), 'dsh-v324-'))
  const memoryDir = join(root, '.dsh-memory')
  const knowledgeDir = join(root, '.dsh-knowledge')
  mkdirSync(memoryDir, { recursive: true })
  mkdirSync(knowledgeDir, { recursive: true })
  writeFileSync(join(memoryDir, '.layout.json'), JSON.stringify({ layout: 1, producer: 'dsh-memory' }, null, 2), 'utf8')
  if (!omitGraph) {
    writeFileSync(join(memoryDir, 'task-graph.json'), graphBody ?? JSON.stringify(healthyGraph, null, 2), 'utf8')
  }
  const tools = new Map()
  const ctx = {
    get(name) {
      if (name === 'paths') return { data: root }
      if (name === 'configEditor') return { entries: () => [], edit: async () => undefined }
      if (name === 'sessions') return { get: () => undefined, list: () => [] }
      return undefined
    },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    tools: { register: (definition) => tools.set(definition.name, definition) },
  }
  memory.apply(ctx, { memoryDir, knowledgeDir, skillsDir: join(root, '.agents', 'skills') })
  return { root, memoryDir, tools }
}

const nodeIds = (out) => (Array.isArray(out.nodes) ? out.nodes.map((entry) => entry.id) : [])

test('v324 ① (P0): a CORRUPT graph must NOT come back wearing a healthy empty graph', async () => {
  const e = await env({ graphBody: '{ broken json' })
  try {
    const out = await e.tools.get('memory_graph_read').execute({})
    assert.equal(out.readStatus, 'unreadable', `① 必须报 unreadable；实测 ${String(out.readStatus)}`)
    assert.match(String(out.readDetail ?? ''), /不是合法 JSON/u, '① 必须说清原因')

    /**
     * THE HALF THAT WAS MISSING. `nodes: ["start"]` + `counts.done >= 1` is what a healthy project that
     * never made a plan looks like, and the model acts on it.
     */
    assert.deepEqual(nodeIds(out), [],
      `① 读不出来时不得递节点（那会让模型以为「尚未建计划」而去 bootstrap 覆盖它）；实测 ${JSON.stringify(nodeIds(out))}`)
    const counts = out.counts ?? {}
    assert.equal(counts.total, 0, `① counts.total 不得是健康计数；实测 ${counts.total}`)
    assert.equal(counts.done, 0, `① counts.done 不得是健康计数；实测 ${counts.done}`)
    assert.equal(out.activeNodeId, '', '① 不得凭空给出当前节点')
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})

test('v324 ② (negative half): a MISSING file is 「尚未建计划」 — nodes=["start"] is CORRECT there', async () => {
  /**
   * Without this half, ① is satisfied by never returning nodes at all — which would make a brand-new
   * project unable to see the start node it needs to build on.
   */
  const e = await env({ omitGraph: true })
  try {
    const out = await e.tools.get('memory_graph_read').execute({})
    assert.equal(out.readStatus, 'absent', `② 文件不存在是 absent；实测 ${String(out.readStatus)}`)
    assert.deepEqual(nodeIds(out), ['start'],
      `② 「没建过」时 start 节点仍然正确（它是建图的起点）；实测 ${JSON.stringify(nodeIds(out))}`)
    assert.equal((out.counts ?? {}).total, 1, '② absent 时 counts 仍然是真实的 1（一个 start 节点）')
    assert.equal(out.readDetail, undefined, '② absent 不该带「读失败」的细节')
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})

test('v324 ③ (negative half): a HEALTHY graph answers exactly as it does today', async () => {
  /**
   * The other way to pass ① is to empty every payload. This pins the healthy path field by field, so
   * 「修好了 unreadable」 cannot cost the reader the data they came for.
   */
  const e = await env()
  try {
    const out = await e.tools.get('memory_graph_read').execute({})
    assert.equal(out.readStatus, 'ok')
    assert.deepEqual(nodeIds(out), ['start', 'goal', 'phase-b4', 'phase-b5'])
    const counts = out.counts ?? {}
    assert.equal(counts.total, 4, `③ 健康图的 total 必须是真的 4；实测 ${counts.total}`)
    assert.equal(counts.structural, 2, '③ start/goal 仍然被计为结构节点')
    assert.equal(counts.work.active, 1, '③ 阶段口径仍然正确（只有 phase-b4 在跑）')
    assert.equal(out.activeNodeId, 'phase-b4', '③ 当前节点仍然是真实阶段（19.4-F 的成果不许丢）')
    assert.match(String(out.activeBanner ?? ''), /coding/u, '③ 横幅仍然带 nodeType')
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})

test('v324 ④ (path: real render payload): the panel graph card gets the same refusal', async () => {
  /**
   * `memoryConsoleState.graph` uses the SAME `describeGraph`. A decider that refuses while the panel
   * still prints 「共 1 个节点 · 已完成 1」 would be two answers to one question.
   */
  const e = await env({ graphBody: '{ broken json' })
  try {
    const commands = []
    /* The console command is registered on `ctx.commands`; drive it the way the panel does. */
    const memory = await import(pathToFileURL(join(ROOT, 'dsh-memory', 'lib', 'index.js')).href)
    void memory
    const map = new Map()
    const root2 = mkdtempSync(join(tmpdir(), 'dsh-v324d-'))
    const memoryDir = join(root2, '.dsh-memory')
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(memoryDir, '.layout.json'), JSON.stringify({ layout: 1, producer: 'dsh-memory' }), 'utf8')
    writeFileSync(join(memoryDir, 'task-graph.json'), '{ broken json', 'utf8')
    const ctx = {
      get(name) {
        if (name === 'paths') return { data: root2 }
        if (name === 'commands') return { register: (definition) => map.set(definition.name, definition) }
        if (name === 'configEditor') return { entries: () => [], edit: async () => undefined }
        if (name === 'sessions') return { get: () => undefined, list: () => [] }
        return undefined
      },
      logger: { info() {}, warn() {}, error() {} },
      on() {},
      tools: { register: () => {} },
    }
    memory.apply(ctx, { memoryDir, knowledgeDir: join(root2, '.dsh-knowledge'), skillsDir: join(root2, '.agents', 'skills') })
    const consoleCommand = map.get('memory-console-global')
    assert.ok(consoleCommand !== undefined, '前提：memory-console-global 必须已注册')
    const reply = await consoleCommand.handler({})
    const payload = JSON.parse(reply.text)
    assert.equal(payload.graph?.unreadable !== undefined || payload.degraded === true, true,
      `④ 面板侧必须能看出图不可读；实测 graph=${JSON.stringify(payload.graph).slice(0, 200)}`)
    void commands
    rmSync(root2, { recursive: true, force: true })
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})