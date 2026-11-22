/**
 * ── v308 / B4-B TD-29 + TD-30 (P2): 同屏两个分母不同的数字，以及「正在读取」的出口 ──────────────────
 *
 * 用户原话（派工单 §十六）：
 *
 *   **TD-29**：「同屏两个口径不同的计数不标关系 —— 同一屏两处数字，分母不同且**没有任何一句话说它们不是
 *   一回事**。」判据 ④：**删掉那句说明 ⇒ 门禁红。**
 *
 *   **TD-30**：「剩下的同形：两处『读不到就永久显示正在读取』（`flywheel` / `ledger`）。TD-30 给出的教训
 *   不是『修那一处』，是**『正在读取』必须是一个有出口的状态**。」
 *
 * 两个数字的真身：
 *   · `counts.skills`     —— 技能存储（可注入 prompt 的技能）
 *   · `flywheel.contributed` —— `readKnowledge(knowledgeDir).length`（知识条目，含负知识）
 * 二者**不是同一集合**（不同生产者、不同目录），而页面上只有两个数字并排。
 *
 * 判据在**真实渲染**上（读渲染文本，不 grep 源码：一个词出现在 client.js 里正是本批反复出现的「形式齐全」）：
 *   ① 技能那一处标注「技能库（可注入）」
 *   ② 知识那一处标注「知识库（含负知识）」
 *   ③ 有一句话说明二者**不是同一集合**
 *   ④ **删掉那句 ⇒ ③ 红**（can-red，写在文件末尾的说明里，操作时执行）
 *   ⑤ 三处「读不到」的分支都必须有出口：`phase !== 'loading'` 时显示「未送达」而不是「正在读取」
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

/** Call function components, walk children, collect text. */
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

const payload = {
  ok: true,
  workspace: 'D:/ws',
  skillsDir: 'D:/ws/skills',
  counts: { skills: 7, active: 5, superseded: 2, queued: 1 },
  skills: [],
  flywheel: { contributed: 12, byKind: { skill: 4, negative: 8 }, totalFinishedNodes: 9, harvestedNodes: 7, pendingNodes: 2 },
  graph: { counts: { total: 3, active: 2 } },
  ledger: { epoch: { retired: 1, transferred: 2 }, supportedEpoch: 1, retired: 1, transferred: 2 },
}

test('v308 TD-29 ①②: both counters name their own source', async () => {
  const { draw, runEffects } = loadPanel()
  draw(payload)
  await runEffects()
  const text = textOf(draw(payload)).join(' ')

  assert.match(text, /技能库（可注入）/u,
    `技能那一处必须标注它是「技能库」；实测：${text.slice(0, 400)}`)
  assert.match(text, /知识库（含负知识/u, '知识那一处必须标注它是「知识库（含负知识）」')
})

test('v308 TD-29 ③: one sentence says the two are NOT the same set', async () => {
  const { draw, runEffects } = loadPanel()
  draw(payload)
  await runEffects()
  const text = textOf(draw(payload)).join(' ')

  assert.match(text, /不是同一集合/u,
    `两个分母不同的数字必须有一句话说明关系；实测：${text.slice(0, 500)}`)
  // And the producer must be named for BOTH, so ③ (no client-side recompute) is checkable.
  assert.match(text, /counts\.skills/u, '必须点名技能数的生产者')
  assert.match(text, /flywheel\.contributed/u, '必须点名知识条目数的生产者')
})

test('v308 TD-30 ⑤: a MISSING field is 「未送达」, not a permanent 「正在读取」', async () => {
  /**
   * The payload omits `flywheel`, `graph` and `ledger` while `state` itself is present — exactly the
   * shape a half-mounted Host produces. Before this fix all three cards said 「正在读取…」 forever.
   */
  const partial = { ok: true, workspace: 'D:/ws', skillsDir: 'D:/ws/skills', counts: { skills: 1, active: 1, superseded: 0, queued: 0 }, skills: [] }
  const { draw, runEffects } = loadPanel()
  draw(partial)
  await runEffects()
  const text = textOf(draw(partial)).join(' ')

  const sent = (text.match(/未送达/gu) || []).length
  assert.equal(sent >= 3, true,
    `飞轮/任务图/台账三处都必须显示「未送达」这一出口；实测出现 ${sent} 次。文本：${text.slice(0, 600)}`)
  assert.doesNotMatch(text, /正在读取…/u,
    '状态已经拿到（state 非空）时不得再显示「正在读取…」——那是一个没有出口的状态')
})
