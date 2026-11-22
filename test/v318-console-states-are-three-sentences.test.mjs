/**
 * ── v318 / 18.6-D (P1, lead-measured): 降级、断连、读取失败是三件事，渲染不许压成两句 ────────────────
 *
 * lead 的原话（§18.3），逐条对应本文件：
 *
 *   1. **memory 把「通」说成「未连通」**。`health` 只有两个分支，降级 payload 落进 else 被标成
 *      「宿主通道未连通」—— 而那份 payload 恰恰是经这条通道送来的。graft 有独立分支，memory 没有。
 *   2. **红卡标题一律是「读取失败」**，即使什么都没失败。同一张卡上面的注释就写着「『没有这个后端』
 *      不是『读取失败』，两者不许压成一句」。
 *   3. **红卡页脚无条件写「以上开关显示的是插件默认值」**，而无会话那一屏的开关是**真的、可写的**。
 *
 * 判据（每条都有负向半边 —— 否则「一律删除」也能过）：
 *   ① `degraded === true` ⇒ 徽章「宿主通道降级」且**不得**含「未连通」；负向：`error` 有值 ⇒ 必须含
 *   ② 红卡标题由状态决定：`error` ⇒ 「读取失败」；`error` 缺席 + `degraded` ⇒ 「宿主通道降级」
 *   ③ 页脚「开关是默认值」只在 `configWritable === false` 时出现；负向：那种情形**必须**出现
 *   ④ 以上三处必须在**同一屏**上彼此一致（不只断言徽章）
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

  const answering = (payload) => ({
    attach() {},
    state: async () => ({ ok: true, via: 'test', text: JSON.stringify(payload) }),
    set: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
    clear: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
  })
  /** The OTHER way a red card appears: the bridge does not answer at all. */
  const failing = (reason) => ({
    attach() {},
    state: async () => ({ ok: false, via: 'test', text: reason }),
    set: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
    clear: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
  })

  /**
   * ── 19.4-E 同族: A BRIDGE WHOSE ANSWER CAN CHANGE ─────────────────────────────────────────────
   *
   * `answering` and `failing` are fixed: each can produce exactly ONE state, so 「it worked, then it did
   * not」 is unreachable by construction — and that is the timeline where graft's badge was most wrong
   * (green badge, red card). v318 ⑤ needs a drawer that can be swapped between calls.
   */
  let reply = { ok: true, via: 'test', text: '{}' }
  const mutable = {
    attach() {},
    state: async () => reply,
    set: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
    clear: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
  }

  return {
    setReply: (next) => { reply = next },
    drawMutable: () => {
      React.__beginRender()
      return mod.__panelForTest({ bridge: mutable })
    },
    draw: (payload) => {
      React.__beginRender()
      return mod.__panelForTest({ bridge: answering(payload) })
    },
    drawFailing: (reason) => {
      React.__beginRender()
      return mod.__panelForTest({ bridge: failing(reason) })
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

/** The panel body without the raw JSON dump — it echoes every field and defeats negative assertions. */
const panelBody = (text) => {
  const start = text.lastIndexOf('记忆控制台')
  const body = start >= 0 ? text.slice(start) : text
  const dump = body.indexOf('原始状态数据')
  return dump >= 0 ? body.slice(0, dump) : body
}

/** The red card's own text: from its title onward, so a badge match cannot satisfy a title assertion. */
const cardText = (text) => {
  const body = panelBody(text)
  const at = body.lastIndexOf('错误详情：')
  if (at < 0) return ''
  const head = Math.max(body.lastIndexOf('读取失败', at), body.lastIndexOf('宿主通道降级', at))
  return head >= 0 ? body.slice(head) : body.slice(at)
}

/** A payload shaped like the product's degraded one — produced by the real `describeDegradation`. */
const payloadDegraded = ({ reason = '没有可测量的活动会话：阈值由配置推导，不代表任何真实窗口', configWritable = true } = {}) => ({
  ok: true,
  degraded: true,
  degradedReason: reason,
  configWritable,
  workspace: 'D:/work/a',
  memoryDir: 'D:/work/a/.dsh-memory',
  skillsDir: 'D:/store/.agents/skills',
  config: { retrieval: true, workspaceIsolation: true, semanticFilter: true, taskAlignment: true, autoApprove: false },
  counts: { skills: 0, active: 0, superseded: 0, scenes: 0, queued: 0 },
  scenes: [],
  skills: [],
  sessions: [],
})

const payloadHealthy = () => ({
  ok: true,
  degraded: false,
  configWritable: true,
  workspace: 'D:/work/a',
  memoryDir: 'D:/work/a/.dsh-memory',
  skillsDir: 'D:/store/.agents/skills',
  config: { retrieval: true, workspaceIsolation: true, semanticFilter: true, taskAlignment: true, autoApprove: false },
  counts: { skills: 0, active: 0, superseded: 0, scenes: 0, queued: 0 },
  scenes: [],
  skills: [],
  ledger: { epoch: 1, retired: 0, pending: 0 },
  sessions: [],
})

async function renderText(payload) {
  const { draw, runEffects } = loadPanel()
  draw(payload)
  await runEffects()
  return textOf(draw(payload)).join(' ')
}

test('v318 ①: a DEGRADED payload is 「降级」 — and must NOT be called 「未连通」', async () => {
  /**
   * The payload that carries this badge ARRIVED over the channel. Calling it 「未连通」 contradicts the
   * only fact the panel has just established, and sends the reader to look at the bridge.
   */
  const text = await renderText(payloadDegraded())
  assert.match(panelBody(text), /宿主通道降级/u,
    `降级时必须说「降级」；实测：${panelBody(text).slice(0, 400)}`)
  assert.equal(panelBody(text).includes('宿主通道未连通'), false,
    `降级时不得说「未连通」——那份 payload 就是经这条通道送来的；实测：${panelBody(text).slice(0, 400)}`)
})

test('v318 ①-负向: a BRIDGE FAILURE still says 「未连通」 — deleting the branch must not pass', async () => {
  /**
   * Without this half, ① is satisfied by removing 「未连通」 from the vocabulary altogether — which would
   * make the one case that genuinely needs it unreachable.
   */
  const { drawFailing, runEffects } = loadPanel()
  drawFailing('桥接超时（探针）')
  await runEffects()
  const text = panelBody(textOf(drawFailing('桥接超时（探针）')).join(' '))
  assert.match(text, /宿主通道未连通/u,
    `真的没连上时必须说「未连通」；实测：${text.slice(0, 400)}`)
  assert.equal(text.includes('宿主通道降级'), false,
    `断连不是降级（更强的那个事实优先）；实测：${text.slice(0, 400)}`)
})

test('v318 ②: the red card TITLE follows the state, not a literal', async () => {
  const { draw, drawFailing, runEffects } = loadPanel()

  const degraded = payloadDegraded()
  draw(degraded)
  await runEffects()
  const degradedCard = cardText(textOf(draw(degraded)).join(' '))
  assert.equal(degradedCard.includes('读取失败'), false,
    `降级不是读取失败，标题不得说「读取失败」；实测红卡：${degradedCard.slice(0, 400)}`)
  assert.match(degradedCard, /宿主通道降级/u,
    `降级卡标题必须是「宿主通道降级」；实测：${degradedCard.slice(0, 400)}`)

  drawFailing('桥接超时（探针）')
  await runEffects()
  const failedCard = cardText(textOf(drawFailing('桥接超时（探针）')).join(' '))
  assert.match(failedCard, /读取失败/u,
    `真的没读到时必须说「读取失败」；实测红卡：${failedCard.slice(0, 400)}`)
})

test('v318 ③: the footer 「开关是默认值」 appears ONLY when the switches really are defaults', async () => {
  const { draw, drawFailing, runEffects } = loadPanel()

  /** Case 1 — degraded because there is no measurable session: the switches ARE real and writable. */
  const writable = payloadDegraded({ configWritable: true })
  draw(writable)
  await runEffects()
  const writableCard = cardText(textOf(draw(writable)).join(' '))
  assert.equal(writableCard.includes('以上开关显示的是插件默认值'), false,
    `开关可写时不得说它们是默认值（同一张卡不能自相矛盾）；实测：${writableCard.slice(0, 500)}`)
  assert.match(writableCard, /点击「刷新」重试/u, '页脚仍要给出下一步动作')

  /** Case 2 (other direction) — `configEditor` unavailable: the claim IS true and must print. */
  const notWritable = payloadDegraded({ configWritable: false, reason: 'configEditor 服务不可用：下面的开关显示的是插件默认值，点击不会落盘' })
  draw(notWritable)
  await runEffects()
  const notWritableCard = cardText(textOf(draw(notWritable)).join(' '))
  assert.match(notWritableCard, /以上开关显示的是插件默认值/u,
    `configEditor 不可用时必须说开关是默认值；实测：${notWritableCard.slice(0, 500)}`)

  /** Case 3 — the bridge never answered: defaults, so the warning must not vanish. */
  drawFailing('桥接超时（探针）')
  await runEffects()
  const failedCard = cardText(textOf(drawFailing('桥接超时（探针）')).join(' '))
  assert.match(failedCard, /以上开关显示的是插件默认值/u,
    `读不到时开关必然是默认值，警告不得消失；实测：${failedCard.slice(0, 500)}`)
})

test('v318 ⑤ (19.4-E 同族): the same THREE TIMELINES that killed the graft badge — memory must pass all', async () => {
  /**
   * The lead measured this defect on graft only. The `setState((prev) => prev ?? fallbackState(reason))`
   * shape exists in BOTH clients, so 「memory is fine」 is a claim that needs evidence, not an assumption.
   * Measured (probe-memory-reachability.mjs): memory's `health` already tests `error` first, so all four
   * timelines are correct. These assertions PIN that, so a future edit that reorders the branches — the
   * exact edit that broke graft — turns red here instead of shipping.
   *
   * The three timelines, in the order the lead measured them:
   *   C. first render, effect not run   ⇒ a fetch is in flight; no verdict yet
   *   A. first fetch fails              ⇒ 「未连通」
   *   B. succeeded once, then fails     ⇒ 「未连通」, NOT the green 「正常」
   */
  const { setReply, drawMutable, runEffects } = loadPanel()
  const FAILURE = { ok: false, via: 'test', text: '桥接超时（3000ms 内宿主没有响应）' }
  const badgeOf = (text) =>
    ['宿主通道未连通', '宿主通道降级', '已连通 · 部分数据缺失', '宿主通道正常', '正在读取…']
      .find((name) => text.includes(name)) ?? '(none)'

  /* C — before anything was attempted, no verdict. */
  setReply({ ok: true, via: 'test', text: JSON.stringify(payloadHealthy()) })
  assert.equal(badgeOf(panelBody(textOf(drawMutable()).join(' '))), '正在读取…',
    '尚未尝试时不得断言「未连通」—— 一个在尝试之前到达的判决不是判决')

  /* A — first fetch fails. */
  setReply(FAILURE)
  await runEffects()
  assert.equal(badgeOf(panelBody(textOf(drawMutable()).join(' '))), '宿主通道未连通',
    '首次就失败必须说「未连通」，不许说「降级」（桥接没了 ≠ 数值不可信）')

  /* B — succeeded once, then fails. The most objectionable timeline: green badge beside a red card. */
  const second = loadPanel()
  second.setReply({ ok: true, via: 'test', text: JSON.stringify(payloadHealthy()) })
  second.drawMutable()
  await second.runEffects()
  assert.equal(badgeOf(panelBody(textOf(second.drawMutable()).join(' '))), '宿主通道正常',
    '前提确认：先成功的这一帧徽章应当是绿的')
  second.setReply(FAILURE)
  await second.runEffects()
  const afterFail = panelBody(textOf(second.drawMutable()).join(' '))
  assert.equal(badgeOf(afterFail), '宿主通道未连通',
    `成功后失败必须翻成「未连通」；实测=${badgeOf(afterFail)}`)
  assert.match(afterFail, /读取失败/u, '前提确认：红卡此时在说「读取失败」（两句必须一致）')
})

test('v318 ⑥ (19.4-E 同族): this file now has a DRAWER whose answer can change between calls', async () => {
  /**
   * §〇 26 corollary, on the fixture rather than the assertion: a fixed failing bridge cannot express
   * 「it worked, then it did not」, and timeline B is exactly that. `setReply` is why ⑤ can be written at
   * all — the earlier fixture could only ever produce one of the states, so the other was unreachable
   * by construction.
   */
  const { setReply, drawMutable, runEffects } = loadPanel()
  setReply({ ok: false, via: 'test', text: '桥接超时（探针）' })
  drawMutable()
  await runEffects()
  const failed = panelBody(textOf(drawMutable()).join(' '))
  setReply({ ok: true, via: 'test', text: JSON.stringify(payloadHealthy()) })
  await runEffects()
  const recovered = panelBody(textOf(drawMutable()).join(' '))
  assert.equal(failed.includes('宿主通道未连通'), true, '失败时「未连通」')
  assert.equal(recovered.includes('宿主通道正常'), true,
    `恢复后必须能回到正常（否则夹具只有一个状态，②③ 都测的是它）；实测：${recovered.slice(0, 300)}`)
})

test('v318 ④: badge, title and footer agree ON THE SAME SCREEN', async () => {
  /**
   * 18.6-D ④: every earlier criterion read ONE of the three places a state is rendered, which is exactly
   * how the original defect survived — the badge said 「降级」 while the card underneath said 「读取失败」.
   */
  const text = panelBody(await renderText(payloadDegraded({ configWritable: true })))
  assert.match(text, /没有可测量的活动会话/u, '① 理由：说清是哪一种降级')
  assert.match(text, /宿主通道降级/u, '② 徽章：这是降级')
  assert.equal(text.includes('宿主通道未连通'), false, '③ 徽章不得说「未连通」')
  const card = cardText(text)
  assert.match(card, /宿主通道降级/u, '④ 标题：由状态决定')
  assert.equal(card.includes('读取失败'), false, '⑤ 标题不得说「读取失败」')
  assert.equal(card.includes('以上开关显示的是插件默认值'), false, '⑥ 页脚不得说开关是默认值')
  assert.match(card, /点击「刷新」重试/u, '⑦ 页脚仍给出动作')

  /** Negative half: the healthy screen says NONE of the three failure sentences. */
  const healthy = panelBody(await renderText(payloadHealthy()))
  assert.match(healthy, /宿主通道正常/u, '健康时必须说正常')
  assert.equal(healthy.includes('宿主通道降级'), false, '健康时不得出现降级字样')
  assert.equal(healthy.includes('宿主通道未连通'), false, '健康时不得出现断连字样')
  assert.equal(cardText(healthy), '', '健康时不该有红卡')
})
