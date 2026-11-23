/**
 * ── v319 / 19.4-F (P1, 用户实测): 「当前节点」不许是 goal ──────────────────────────────────────────
 *
 * 用户的四条症状里，前两条（「失准」「会话未读图确认当前进度」）在代码里是可指的：
 *
 *   本机 23 节点图里 `goal` 是 `status: 'active'`（终点，不是一步），而 `memory_graph_read` 取的是
 *
 *       nodes.find((node) => node.status === 'active')      ← 第一个，含 start/goal
 *
 *   实测（探针 `_scratch/probe-dag-active-node.mjs`，与屏幕同形的图）：
 *
 *       memory_graph_read  activeNodeId = "goal"
 *                          activeBanner = "节点 goal（active） · 要求：四合持久层能力全部生产就绪"
 *       graft task-position current      = "phase-b4"           ← 同一张图，同一个问题
 *
 *   **两个读者，一张图，两个答案。** 模型看到的那个是错的。
 *
 * 判据：
 *   ① goal 与某个真实阶段同时 active ⇒ `activeNodeId` 是**那个阶段**，不是 goal
 *   ② 负向：只有 goal active（没有阶段在跑）⇒ `activeNodeId` 是空的，而不是退回 goal
 *   ③ `counts.active`（全部节点）与 `counts.work.active`（只数阶段）**都在**，两个事实都不藏
 *   ④ `describeGraph` 不许把 `describeNodes` 产出的字段丢掉（它曾经是手写字段表）
 *   ⑤ 端到端：面板那一行必须说得出「有几个固定节点」，且阶段数用阶段口径
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')

const node = (id, title, status, dependsOn, extra = {}) => ({
  id,
  title,
  nodeType: '',
  requirements: ['要求一'],
  status,
  dependsOn,
  knowledgePointers: [],
  fixed: id === 'start' || id === 'goal',
  harvestedAt: '',
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
  ...extra,
})

/** The live screen's shape: `goal` is `active`, and one real phase is `active` too. */
function graphWith({ goalStatus = 'active', phaseStatus = 'active' } = {}) {
  return {
    version: 1,
    id: 'default',
    goal: '四合持久层能力全部生产就绪',
    goalLockedAt: '2026-11-18T00:00:00.000Z',
    nodes: [
      node('start', '开始', 'done', []),
      node('goal', '目标', goalStatus, [], { requirements: ['四合持久层能力全部生产就绪'] }),
      node('phase-b3', 'B3', 'done', ['start']),
      node('phase-b4', 'B4', phaseStatus, ['phase-b3'], { progress: 40 }),
      node('phase-b5', 'B5', 'pending', ['phase-b4']),
    ],
    history: [],
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    persistentConstraints: [],
  }
}

/** A real plugin on a real store: nothing about the read path is stubbed. */
async function realRead(graph) {
  const memory = await import(pathToFileURL(join(ROOT, 'dsh-memory', 'lib', 'index.js')).href)
  const root = mkdtempSync(join(tmpdir(), 'dsh-v319-'))
  const memoryDir = join(root, '.dsh-memory')
  const knowledgeDir = join(root, '.dsh-knowledge')
  mkdirSync(memoryDir, { recursive: true })
  mkdirSync(knowledgeDir, { recursive: true })
  writeFileSync(
    join(memoryDir, '.layout.json'),
    JSON.stringify({ layout: 1, producer: 'dsh-memory', files: ['task-graph.json'] }, null, 2),
    'utf8',
  )
  writeFileSync(join(memoryDir, 'task-graph.json'), JSON.stringify(graph, null, 2), 'utf8')

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
  const read = tools.get('memory_graph_read')
  assert.ok(read !== undefined, 'memory_graph_read must be registered')
  return { out: await read.execute({}), root, memory }
}

test('v319 ①: with `goal` AND a real phase active, the current node is THE PHASE', async () => {
  const { out, root } = await realRead(graphWith())
  try {
    assert.equal(out.activeNodeId, 'phase-b4',
      `当前节点必须是真实阶段，不是 goal；实测 ${String(out.activeNodeId)}（banner：${String(out.activeBanner)}）`)
    assert.equal(String(out.activeBanner).includes('goal'), false,
      `banner 不得点名 goal；实测：${String(out.activeBanner)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v319 ② (negative half): only `goal` is active ⇒ NO current node, not a fallback to the goal', async () => {
  /**
   * Without this half, ① is satisfied by 「prefer the non-goal one when present」 — which still answers
   * 「goal」 when no phase is running. A destination is never a current step, so the honest answer is
   * 「no phase is active」 and the caller says so.
   */
  const { out, root } = await realRead(graphWith({ goalStatus: 'active', phaseStatus: 'pending' }))
  try {
    assert.equal(out.activeNodeId, '',
      `只有 goal active 时不许把 goal 当当前节点；实测 ${String(out.activeNodeId)}`)
    assert.equal(String(out.activeBanner), '', 'banner 也必须为空')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v319 ③: both tallies are present — the store size AND the phase count', async () => {
  /**
   * 「共 23 个节点」 and 「21 个阶段」 are different facts. Collapsing them either hides the fixed nodes
   * (the panel silently omits start/goal) or inflates 进行中 by counting the goal.
   */
  const { out, root } = await realRead(graphWith())
  try {
    assert.equal(out.counts.total, 5, '全部节点 5 个')
    assert.equal(out.counts.active, 2, '全部节点口径：goal + phase-b4')
    assert.equal(out.counts.structural, 2, '固定节点 2 个（start / goal）')
    assert.equal(out.counts.work.total, 3, '阶段口径：phase-b3 / b4 / b5')
    assert.equal(out.counts.work.active, 1,
      `阶段里只有 1 个在跑；实测 ${String(out.counts.work.active)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v319 ④: `describeGraph` must not drop what `describeNodes` produced', async () => {
  /**
   * It used to rebuild the result field by field (`{ graph, nodes, counts }`). Adding `work` /
   * `structural` / `activeWorkNodes` reached NO caller until that line was changed — a producer that
   * produces more than it delivers, with nothing failing. `...view` makes it impossible by construction.
   */
  const { describeGraph } = await import(pathToFileURL(join(ROOT, 'dsh-memory', 'lib', 'graph.js')).href)
  const root = mkdtempSync(join(tmpdir(), 'dsh-v319d-'))
  const memoryDir = join(root, '.dsh-memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(memoryDir, 'task-graph.json'), JSON.stringify(graphWith(), null, 2), 'utf8')
  try {
    const described = describeGraph(memoryDir, undefined)
    for (const key of ['counts', 'nodes', 'activeWorkNodes']) {
      assert.ok(described[key] !== undefined,
        `describeGraph 的输出缺少 ${key} —— 手写字段表把生产者多出来的字段丢掉了`)
    }
    assert.ok(described.counts.work !== undefined, 'counts.work 必须在，且与 counts 同一个形状')
    assert.equal(described.counts.structural, 2, 'counts.structural 也必须在')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v319 ⑤ (end-to-end, REAL RENDER): the panel line names the fixed nodes and counts phases as phases', async () => {
  /**
   * The user's screen said 「进行中 2」 and then listed `goal` first. Two facts were missing from that
   * line: that two of the nodes are structural, and that only ONE phase is running.
   *
   * ── WHY THIS IS A RENDER ASSERTION AND NOT A REGEX OVER `client.js` ────────────────────────────
   *
   * The first version asserted the source text contained `counts.work`. can-red proved it worthless:
   * replacing the runtime expression with `const work = gc` left the COMMENT above it mentioning
   * `counts.work`, so all five criteria stayed green while the panel went back to counting the goal as
   * a phase. That is the 「name exists ⟹ the rule holds」 failure this whole batch is about — a regex
   * can see a word, never a screen.
   */
  const source = readFileSync(join(ROOT, 'dsh-memory', 'client.js'), 'utf8')
  let captured
  const effects = []
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat() } },
    useState(initial) {
      if (React.__cursor >= React.__slots.length) React.__slots.push({ value: typeof initial === 'function' ? initial() : initial })
      const slot = React.__slots[React.__cursor]
      React.__cursor += 1
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useEffect(fn) { effects.push(fn) },
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    useRef(initial) { return { current: initial } },
    __slots: [],
    __cursor: 0,
    __beginRender() { React.__cursor = 0 },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { captured = definition } } },
    require(name) {
      if (name === 'react') return React
      throw new Error(`unexpected require(${name})`)
    },
    console: { log() {}, error() {} },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  new Function(
    'window', 'require', 'console', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    `"use strict";\n${source}\n`,
  )(sandbox.window, sandbox.require, sandbox.console, sandbox.setInterval, sandbox.clearInterval, sandbox.setTimeout, sandbox.clearTimeout)
  const ctx = { slots: { inject(_key, cb) { cb() }, register() { return () => {} } }, get() { return undefined } }
  const mod = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  }, { insert: () => () => {} }, undefined)
  mod.apply(ctx)

  /** A payload shaped EXACTLY as the Host now ships it: all-node tallies beside the phase-only tally. */
  const payload = {
    degraded: false,
    configWritable: true,
    workspace: 'D:/work/a',
    memoryDir: 'D:/work/a/.dsh-memory',
    skillsDir: 'D:/store/.agents/skills',
    config: {},
    counts: { skills: 0, active: 0, superseded: 0, scenes: 0, queued: 0 },
    scenes: [],
    skills: [],
    sessions: [],
    flywheel: { contributed: 0, harvestedNodes: 0 },
    graph: {
      graphId: 'default',
      goalLocked: true,
      counts: {
        total: 5, pending: 1, active: 2, done: 2, abandoned: 0,
        work: { total: 3, pending: 1, active: 1, done: 1, abandoned: 0 },
        structural: 2,
      },
      activeNodes: [{ id: 'phase-b4', banner: '节点 phase-b4（active） · 要求：要求一' }],
      activeNodeId: 'phase-b4',
      activeBanner: '节点 phase-b4（active） · 要求：要求一',
      activeNotShown: 0,
    },
  }

  const bridge = {
    attach() {},
    state: async () => ({ ok: true, via: 'test', text: JSON.stringify(payload) }),
    set: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
    clear: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
  }
  const draw = () => { React.__beginRender(); return mod.__panelForTest({ bridge }) }
  draw()
  for (const fn of effects) fn()
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))

  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object') return
    if (typeof node.type === 'function') { walk(node.type(node.props || {})); return }
    for (const child of node.children ?? []) walk(child)
    if (node.props && node.props.children !== undefined) walk(node.props.children)
  }
  walk(draw())
  const text = out.join(' ')

  assert.match(text, /其中 2 个是固定节点 start\/goal/u,
    `面板必须说得出有 2 个节点不是阶段；实测：${text.slice(0, 600)}`)
  assert.match(text, /阶段 3 个：进行中 1 /u,
    `阶段口径必须是「进行中 1」，而不是把 goal 算进去的 2；实测：${text.slice(0, 600)}`)
  assert.equal(text.includes('节点 goal'), false,
    `不得把 goal 渲染成当前阶段；实测：${text.slice(0, 600)}`)
})