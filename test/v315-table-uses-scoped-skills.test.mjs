/**
 * ── v315 / 17.4-B (P0, lead-measured): 表格必须用过滤后的技能 ──────────────────────────────────────
 *
 * lead 的原话（§十七）：
 *
 * > `memoryConsoleState` 两半都返回了（`skills` 与 `scoped.skills` 并存）。但 `client.js` 的表格读 `shown`，
 * > 来自 `state.skills`；`scoped.skills` **只用来算那个计数**。⇒ 面板多了一行「本工作区可用 N / 库中 M」，
 * > **但下面的表格照旧列出别处的技能**。
 *
 * 判据（lead 的四条，全部实现，且在**真实渲染**上）：
 *   ① 会话在 A、库里有 B 的 `scope: project` 技能 ⇒ 表格**不列出**它
 *   ② 负向：同一工作区的技能照常列出（不许「一律空表」也能过 ①）
 *   ③ 负向：`scope: global` 的技能仍然列出
 *   ④ `scoped` 缺席时表格有数据，且标题带「未按工作区过滤」
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const BUNDLE = 'dsh-memory/client.js'

function loadPanel() {
  const source = readFileSync(join(ROOT, BUNDLE), 'utf8')
  let captured
  const effects = []
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() }
    },
    useState(initial) {
      if (React.__cursor >= React.__slots.length) {
        React.__slots.push({ value: typeof initial === 'function' ? initial() : initial })
      }
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
  const run = new Function(
    'window', 'require', 'console', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    `"use strict";\n${source}\n`,
  )
  run(
    sandbox.window, sandbox.require, sandbox.console,
    sandbox.setInterval, sandbox.clearInterval, sandbox.setTimeout, sandbox.clearTimeout,
  )
  assert.ok(captured, 'the bundle must register a module definition')
  const ctx = {
    slots: { inject(_key, cb) { cb() }, register() { return () => {} } },
    get() { return undefined },
  }
  const mod = captured.factory(
    (name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require(${name})`)
    },
    { insert: () => () => {} },
    undefined,
  )
  mod.apply(ctx)

  const bridgeWith = (payload) => ({
    attach() {},
    state: async () => ({ ok: true, via: 'test', text: JSON.stringify(payload) }),
    set: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
    clear: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
  })

  return {
    draw: (payload) => {
      React.__beginRender()
      return mod.__panelForTest({ bridge: bridgeWith(payload) })
    },
    runEffects: async () => {
      for (const fn of effects) fn()
      for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

function textOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'function') return textOf(node.type(node.props || {}), out)
  for (const child of node.children ?? []) textOf(child, out)
  if (node.props && node.props.children !== undefined) textOf(node.props.children, out)
  return out
}

/** The panel body without the raw JSON dump (it echoes every field and defeats negative assertions). */
const panelBody = (text) => {
  const start = text.lastIndexOf('记忆控制台')
  const body = start >= 0 ? text.slice(start) : text
  const dump = body.indexOf('原始状态数据')
  return dump >= 0 ? body.slice(0, dump) : body
}

const skill = (name, workspace, scope = 'project') => ({
  name,
  scene: 'general',
  scope,
  workspace,
  source: 'inferred',
  evidence: 1,
  invalidAt: '',
})

/**
 * A payload shaped like the product's, with the two halves the lead measured: `skills` (the store) and
 * `scoped.skills` (the filtered list). Both are present so the test exercises the CHOICE the client makes.
 */
const payloadWith = ({ workspace, skills, scoped, withScoped = true }) => ({
  ok: true,
  workspace,
  skillsDir: 'D:/store/.agents/skills',
  config: { retrieval: true, workspaceIsolation: true },
  counts: { skills: skills.length, active: skills.length, superseded: 0, queued: 0 },
  scenes: ['general'],
  skills,
  ...(withScoped
    ? {
        scoped: {
          // What the producer would compute for THIS workspace.
          skills: scoped ?? skills.filter((entry) => entry.scope === 'global' || entry.workspace === workspace),
          skillsScope: 'filtered by workspace (same predicate retrieval uses)',
          memoryScope: `directory: ${workspace}/.dsh-memory`,
          knowledgeScope: `directory: ${workspace}/.dsh-knowledge`,
          graphScope: `directory: ${workspace}/.dsh-memory/task-graph.json`,
        },
      }
    : {}),
})

async function renderText(payload) {
  const { draw, runEffects } = loadPanel()
  draw(payload)
  await runEffects()
  return panelBody(textOf(draw(payload)).join(' '))
}

const STORE = [
  skill('mine-alpha', 'D:/work/a'),
  skill('other-beta', 'D:/work/b'),
  skill('shared-gamma', 'D:/work/b', 'global'),
]

test('v315 ①: a skill recorded in ANOTHER workspace is not listed in the table', async () => {
  const text = await renderText(payloadWith({ workspace: 'D:/work/a', skills: STORE }))
  assert.equal(text.includes('mine-alpha'), true, '本工作区的必须列出（负向半边的自检）')
  assert.equal(text.includes('other-beta'), false,
    `另一个工作区的 project 技能不得出现在表格里；实测表格文本：${text.slice(0, 600)}`)
})

test('v315 ② (negative half): the SAME workspace is still listed — not an empty table', async () => {
  /**
   * Without this, ① is satisfied by rendering nothing at all.
   */
  const text = await renderText(payloadWith({ workspace: 'D:/work/a', skills: STORE }))
  assert.equal(text.includes('mine-alpha'), true,
    `同工作区的技能必须照常列出；实测：${text.slice(0, 600)}`)
})

test('v315 ③ (negative half): `scope: global` is still listed', async () => {
  /**
   * Global records pass `memoryAllowsWorkspace` for every workspace, so a table that hid them would be
   * over-filtering — the same class of defect in the other direction.
   */
  const text = await renderText(payloadWith({ workspace: 'D:/work/a', skills: STORE }))
  assert.equal(text.includes('shared-gamma'), true,
    `global 技能必须仍然列出；实测：${text.slice(0, 600)}`)
})

test('v315 ④: a payload WITHOUT `scoped` falls back AND says 「未按工作区过滤」', async () => {
  /**
   * An older host, or one that has not restarted, sends only `skills`. Falling back is right — hiding the
   * table would be worse — but a SILENT fallback recreates the original confusion for exactly the reader
   * who is trying to tell whether the table is scoped.
   */
  const text = await renderText(payloadWith({ workspace: 'D:/work/a', skills: STORE, withScoped: false }))
  assert.equal(text.includes('other-beta'), true, '降级时表格仍有数据（来自 state.skills）')
  assert.match(text, /未按工作区过滤/u,
    `降级必须在标题上标明；实测：${text.slice(0, 600)}`)
})
