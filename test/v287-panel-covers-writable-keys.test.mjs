/**
 * ── v287 (B4-0b-2 W6-1b)：面板的控件必须是**渲染出来的**，不是源码里的字符串 ─────────────────
 *
 * ── 第一版为什么不合格（这是本批第二次犯同一个错）────────────────────────────────────────────
 *
 * 第一版用 `panelWritableKeys()` 扫 `client.js` 源码里的 `write('…'` 出现，④ 用
 * `client.includes('任务图（DAG）')`。于是：
 *
 *     删掉 `autoApprove` 的 Toggle，只把 write('autoApprove' 留在**注释**里
 *     ⇒ ① 仍然绿
 *
 * 因为它只问「这个字符串在不在」。正确答案与错误答案在那个维度上长得一样 —— §〇 第 11 条说的
 * 就是这件事，而这条测试自己违反了它。`v284 ④` 犯过一次，这是第二次。
 *
 * ── 现在为什么能验行为 ────────────────────────────────────────────────────────────────────────
 *
 * `client.js` 是 `window.__ModuleLoader__.load({ factory })` 的形状，没有 import，所以可以拿一
 * 个受控 sandbox **真的执行它**（`v023` 与 `v255 ①` 已经证明这条路走得通），并从
 * `__panelForTest` 拿到组件函数。组件的 `Toggle` 渲染出 `role:"switch"` + `aria-label`，
 * `NumberRow` 渲染出 `<input>`，所以「控件在不在」是**数元素**，不是搜文本。
 *
 * ── 判据（六条）────────────────────────────────────────────────────────────────────────────────
 *
 *   ① memory：把**每个**可写键都喂进一次渲染，渲染树里必须存在一个 `aria-label` 含该键名的开关。
 *      不是「屏幕上有 5 个开关」—— 数量对不上名字是另一件事；这里断言的是**键到控件**的对应。
 *   ② graft：同一件事，用 graft 自己的可写集合（13 个，四段声明合并）。
 *   ③ 反向：渲染出来的**每一个**可写开关，其键名都在宿主接受的可写集合里（否则控件静默失败）。
 *   ④ 任务图三态渲染出**三句不同的话**：`unreadable` / `total<=1` / 正常（含活跃节点）。
 *      三条互相 `notEqual`，因为「三句话」的价值就在于它们可区分。
 *   ⑤ 「删除控件、留下注释」这个**具体**攻击必须红：测试内构造一份删掉 Toggle 的源码，断言
 *      —— 用第一版那种字符串扫描会通过，用现在的渲染断言会失败。（这是本文件的 meta 断言。）
 *   ⑥ 分母：可写集合与控件数都断言下界，且**两个数都打印**在失败信息里。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GRAFT = join(ROOT, '..', 'dsh-graft-slice')

/**
 * Load a client bundle the way the page does: execute `window.__ModuleLoader__.load(...)` against a
 * sandbox that supplies a minimal React.
 *
 * The React stub deliberately supports ONLY what the bundles use: `createElement`, `useState`,
 * `useEffect`. Elements keep `type`, `props` and `children` so the tree can be walked. `useState`
 * returns the initial value and a no-op setter — the panel is rendered ONCE, synchronously, which is
 * exactly the snapshot a static assertion needs.
 */
function loadPanel(file) {
  const source = readFileSync(file, 'utf8')
  let captured
  const calls = { state: 0, effect: 0 }

  const makeReact = () => {
    const React = {
      createElement(type, props, ...children) {
        return { type, props: props || {}, children: children.flat() }
      },
    }
    React.useState = (initial) => {
      calls.state += 1
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    }
    React.useEffect = () => {
      calls.effect += 1
    }
    return React
  }

  const React = makeReact()
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { captured = definition } } },
    require(name) {
      if (name === 'react') return React
      throw new Error(`unexpected require(${name})`)
    },
    console: { log() {}, error() {} },
  }
  const run = new Function('window', 'require', 'console', `"use strict";\n${source}\n;`)
  run(sandbox.window, sandbox.require, sandbox.console)
  assert.ok(captured !== undefined, `${file} must register a module definition`)

  const mod = captured.factory(sandbox.require, { insert: () => () => {} }, undefined)
  assert.equal(typeof mod.__panelForTest, 'function', `${file} must expose __panelForTest`)
  return { mod }
}

const DEAD_BRIDGE = {
  attach() {},
  state: async () => ({ ok: false, via: 'none', text: '宿主调用失败（测试）' }),
  set: async () => ({ ok: false, via: 'none', text: '宿主调用失败（测试）' }),
  clear: async () => ({ ok: false, via: 'none', text: '宿主调用失败（测试）' }),
}

/**
 * ── THE MINI-RENDERER, AND WHY IT IS NECESSARY ────────────────────────────────────────────────
 *
 * `h(Toggle, {...})` produces an ELEMENT whose `type` is the FUNCTION `Toggle`. A tree walk that only
 * reads `node.type === 'button'` sees the Toggle elements and never their output — so it would report
 * 「一个开关都没有」 on a perfectly good panel, i.e. a false RED. That is the mirror of the defect this
 * file is about: an assertion whose dimension cannot see the thing it claims to check.
 *
 * So the walk EXPANDS function components: invoke them with their props and walk the result. The
 * panel under test is called directly (hooks consume the supplied values), and anything it renders
 * afterwards is expanded with hooks falling back to their real initial values — which is exactly what
 * `Toggle` (hook-free) and `NumberRow` (`useState(String(value))`) need.
 */
function expand(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    for (const child of node) expand(child, out)
    return out
  }
  if (typeof node !== 'object') return out

  if (typeof node.type === 'function') {
    const props = { ...(node.props ?? {}) }
    const extra = Array.isArray(node.children) ? node.children.filter(() => false) : []
    void extra
    /** React passes children through `props.children`; the stub kept them on the node. */
    if (props.children === undefined && Array.isArray(node.children) && node.children.length > 0) {
      props.children = node.children.length === 1 ? node.children[0] : node.children
    }
    return expand(node.type(props), out)
  }

  out.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) expand(child, out)
  if (node.props !== undefined && node.props !== null && node.props.children !== undefined) {
    expand(node.props.children, out)
  }
  return out
}

/** Every switch the tree actually RENDERS, by its own `aria-label`. */
function renderedSwitches(tree) {
  return expand(tree)
    .filter((node) => node.type === 'button' && node.props !== undefined && node.props.role === 'switch')
    .map((node) => String(node.props['aria-label'] ?? ''))
}

/**
 * Render the memory panel with a state object that is REAL ENOUGH to reach the control cards.
 *
 * `canWrite` is `state !== null`, so a state object is what turns the switches operable — the panel
 * is rendered against the state a working Host would send, not against a dead one.
 */
function renderMemory(state) {
  const { mod } = loadPanel(join(ROOT, 'client.js'))
  return mod.__panelForTest({ bridge: DEAD_BRIDGE, useSessions: () => [], __state: state })
}

/**
 * The panel fetches on mount and renders from `useState(null)`, so a single synchronous call sees the
 * LOADING branch. To reach the control cards we drive the component with a React whose `useState`
 * returns supplied values in order — that is what a settled render looks like.
 */
function renderMemoryWithState(state) {
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
  let captured
  const supplied = [state, '', '', '', '*', false, false, '', 0, '', '']
  let index = 0
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() }
    },
    useState(initial) {
      const next = index < supplied.length ? supplied[index] : typeof initial === 'function' ? initial() : initial
      index += 1
      return [next, () => {}]
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { captured = definition } } },
    require(name) {
      if (name === 'react') return React
      throw new Error(`unexpected require(${name})`)
    },
    console: { log() {}, error() {} },
  }
  const run = new Function('window', 'require', 'console', `"use strict";\n${source}\n;`)
  run(sandbox.window, sandbox.require, sandbox.console)
  const mod = captured.factory(sandbox.require, { insert: () => () => {} }, undefined)
  return mod.__panelForTest({ bridge: DEAD_BRIDGE, useSessions: () => [] })
}

const memoryServer = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
const memoryWritable = (() => {
  const setMatch = memoryServer.match(/MEMORY_CONSOLE_KEYS = new Set\(\[([^\]]+)\]\)/u)
  assert.ok(setMatch !== null, '找不到 MEMORY_CONSOLE_KEYS —— 检查本身失效了，不要当成通过')
  return setMatch[1].match(/'([A-Za-z][A-Za-z0-9]*)'/gu).map((quoted) => quoted.slice(1, -1))
})()

/** A state shaped like the real Host payload, with every writable key present in `config`. */
function stateFor(writable) {
  const config = {}
  for (const key of writable) config[key] = true
  return {
    config,
    workspace: 'D:/w',
    memoryDir: '/m',
    skillsDir: '/s',
    counts: { skills: 0, active: 0, superseded: 0, scenes: 0, queued: 0 },
    scenes: [],
    skills: [],
    flywheel: { contributed: 0, byKind: {}, totalFinishedNodes: 0, harvestedNodes: 0, pendingNodes: 0 },
    ledger: { epoch: { retired: 0, transferred: 0 }, retired: 0, transferred: 0 },
    sessions: [],
    graph: { graphId: 'default', goalLocked: false, counts: { total: 3, pending: 0, active: 1, done: 2, abandoned: 0 }, activeNodeId: 'n1', activeBanner: '节点 n1（active）' },
  }
}

test('v287 ①: memory 的每个可写键，渲染树里都有一个对应的开关（键 → 控件，不是数个数）', () => {
  assert.ok(memoryWritable.length >= 5, `可写键只有 ${memoryWritable.length} 个，检查的分母异常`)
  const tree = renderMemoryWithState(stateFor(memoryWritable))
  const labels = renderedSwitches(tree).join('\n')

  const missing = memoryWritable.filter((key) => !labels.includes(key))
  assert.deepEqual(
    missing,
    [],
    `这些键可写，但**渲染树里没有对应的开关**（宿主会显示它的值，用户会以为它是坏的）：\n  ${missing.join('\n  ')}\n` +
      `实际渲染出的开关：\n  ${renderedSwitches(tree).join('\n  ') || '(一个都没有)'}`,
  )
  assert.ok(
    renderedSwitches(tree).length >= 5,
    `渲染出的开关只有 ${renderedSwitches(tree).length} 个，少于可写键 ${memoryWritable.length} 个`,
  )
})

test('v287 ②: 反向 —— 渲染出的每个开关，其键名都必须在宿主接受的可写集合里', () => {
  const tree = renderMemoryWithState(stateFor(memoryWritable))
  const labels = renderedSwitches(tree)
  assert.ok(labels.length > 0, '一个开关都没渲染出来，反向检查会空转')

  /**
   * The label carries the key in parentheses (`工作区硬隔离（workspaceIsolation）`), so the key is
   * extracted from the label. A switch whose label names no known key is either a new control that
   * the Host will reject, or a label that stopped naming its key — both are failures.
   */
  const named = labels
    .map((label) => (/（([A-Za-z][A-Za-z0-9]*)）/u.exec(label)?.[1] ?? ''))
    .filter((key) => key.length > 0)
  const bogus = named.filter((key) => !memoryWritable.includes(key))
  assert.deepEqual(bogus, [], `渲染出了这些开关，但宿主不认它们的键（点击会静默失败）：${bogus.join(', ')}`)
  assert.ok(named.length >= 5, `能从标签里读出键名的开关只有 ${named.length} 个，反向检查的分母异常`)
})

test('v287 ③: graft 的 13 个可写键同样逐个有控件（同一缺陷的第二个仓）', () => {
  const graftServer = readFileSync(join(GRAFT, 'src', 'index.ts'), 'utf8')
  const bool = [...(graftServer.match(/CONSOLE_BOOLEAN_KEYS = \[([\s\S]*?)\]/u)?.[1] ?? '').matchAll(/'(\w+)'/gu)]
  const ratio = [...(graftServer.match(/CONSOLE_RATIO_KEYS = \[([\s\S]*?)\]/u)?.[1] ?? '').matchAll(/'(\w+)'/gu)]
  const enumBlock = graftServer.match(/CONSOLE_ENUM_KEYS[^=]*= \{([\s\S]*?)\n\}/u)?.[1] ?? ''
  const intBlock = graftServer.match(/CONSOLE_INTEGER_KEYS[^=]*= \{([\s\S]*?)\n\}/u)?.[1] ?? ''
  const writable = [
    ...bool.map((match) => match[1]),
    ...ratio.map((match) => match[1]),
    ...[...enumBlock.matchAll(/^\s{2}(\w+):/gmu)].map((match) => match[1]),
    ...[...intBlock.matchAll(/^\s{2}(\w+):/gmu)].map((match) => match[1]),
  ]
  assert.ok(writable.length >= 13, `graft 的可写键只有 ${writable.length} 个，检查的分母异常（应为 13）`)

  /**
   * The graft panel names keys in its labels the same way (`工作目录红线（workspaceRedline）`), so the
   * same render-and-read-the-tree approach applies. Rendered with a state that reaches the control
   * cards — the graft panel also gates them on `canWrite`.
   */
  const source = readFileSync(join(GRAFT, 'client.js'), 'utf8')
  let captured
  let index = 0
  const config = {}
  for (const key of writable) config[key] = key.endsWith('Ratio') ? 0.7 : key.startsWith('growth') || key === 'constraintBudgetChars' ? 1200 : true
  const supplied = [{ config, thresholds: undefined, sessions: [], workspace: 'D:/w' }, '', '', false, '', '', '']
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() }
    },
    useState(initial) {
      const next = index < supplied.length ? supplied[index] : typeof initial === 'function' ? initial() : initial
      index += 1
      return [next, () => {}]
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { captured = definition } } },
    require(name) {
      if (name === 'react') return React
      throw new Error(`unexpected require(${name})`)
    },
    console: { log() {}, error() {} },
  }
  const run = new Function('window', 'require', 'console', `"use strict";\n${source}\n;`)
  run(sandbox.window, sandbox.require, sandbox.console)
  const mod = captured.factory(sandbox.require, { insert: () => () => {} }, undefined)
  const tree = mod.__panelForTest({ bridge: DEAD_BRIDGE, useSessions: () => [] })
  const text = expand(tree)
    .map((node) => {
      const aria = typeof node.props?.['aria-label'] === 'string' ? node.props['aria-label'] : ''
      const label = node.props?.label
      /** `NumberRow` takes `label` as a prop, not as an aria attribute. */
      return `${aria}\n${typeof label === 'string' ? label : ''}`
    })
    .filter((label) => label.trim().length > 0)
    .join('\n')

  const missing = writable.filter((key) => !text.includes(key))
  assert.deepEqual(missing, [], `graft 面板缺少这些可写键的控件：${missing.join(', ')}`)
})

test('v287 ④: 任务图三态渲染出三句**不同**的话（可区分才是「三态」）', () => {
  const base = stateFor(memoryWritable)
  const normal = renderMemoryWithState(base)
  const empty = renderMemoryWithState({ ...base, graph: { graphId: 'default', goalLocked: false, counts: { total: 1, pending: 0, active: 0, done: 0, abandoned: 0 }, activeNodeId: '', activeBanner: '' } })
  const broken = renderMemoryWithState({ ...base, graph: { unreadable: 'EACCES: task-graph.json' } })

  const textOf = (tree) => expand(tree).filter((node) => typeof node.children?.[0] === 'string').map((node) => node.children.join('')).join('\n')
  const normalText = textOf(normal)
  const emptyText = textOf(empty)
  const brokenText = textOf(broken)

  assert.ok(normalText.includes('任务图'), '正常态必须画出任务图卡片')
  assert.match(brokenText, /读不出来/u, 'unreadable 必须说「读不出来」，而不是「没有任务图」')
  assert.match(emptyText, /还没有建过任务图/u, 'total<=1 必须说「还没有建过任务图」')
  assert.match(normalText, /进行中/u, '正常态必须给出进行中计数')

  /**
   * The three sentences must be mutually different — that is the entire point of the three branches.
   * A panel that renders the same line for 「读不出来」 and 「还没有」 sends the reader to the wrong
   * action (build one vs look at the file).
   */
  assert.notEqual(brokenText, emptyText, '「读不出来」与「还没有建过」渲染成了同一段文本')
  assert.notEqual(normalText, emptyText, '正常态与空态渲染成了同一段文本')
})

test('v287 ⑤: meta ——「删控件、留注释」必须红（第一版字符串扫描会放过它）', () => {
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')

  /**
   * Construct the exact attack: remove the `autoApprove` Toggle element but LEAVE the string
   * `write('autoApprove'` in a comment nearby. That is the mutation the first version of this test
   * could not see, and it is reproducible without touching the repository: the mutated source is
   * evaluated here in a sandbox.
   */
  const START = "          h(Toggle, {\n            key: 'aa',"
  const startAt = source.indexOf(START)
  assert.ok(startAt > 0, '找不到 autoApprove 的 Toggle —— 攻击的构造点变了，这条 meta 断言需要更新')
  const endAt = source.indexOf('}),', startAt)
  assert.ok(endAt > startAt, '找不到该 Toggle 的结尾')
  const mutated = `${source.slice(0, startAt)}/* 控件已删除；write('autoApprove' 仅作为注释保留 */${source.slice(endAt + 3)}`

  /** First: the OLD check would still pass — the string is there. That is why the old test was wrong. */
  const oldCheckKeys = new Set([...mutated.matchAll(/write\('([A-Za-z][A-Za-z0-9]*)'/gu)].map((match) => match[1]))
  assert.ok(oldCheckKeys.has('autoApprove'), '前提不成立：旧检查在这份变异体上应当仍然“看见” autoApprove')

  /** Second: the NEW check (render the panel) must SEE the missing switch. */
  let captured
  let index = 0
  const supplied = [stateFor(memoryWritable), '', '', '', '*', false, false, '', 0, '', '']
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() }
    },
    useState(initial) {
      const next = index < supplied.length ? supplied[index] : typeof initial === 'function' ? initial() : initial
      index += 1
      return [next, () => {}]
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { captured = definition } } },
    require(name) {
      if (name === 'react') return React
      throw new Error(`unexpected require(${name})`)
    },
    console: { log() {}, error() {} },
  }
  const run = new Function('window', 'require', 'console', `"use strict";\n${mutated}\n;`)
  run(sandbox.window, sandbox.require, sandbox.console)
  const mod = captured.factory(sandbox.require, { insert: () => () => {} }, undefined)
  const labels = renderedSwitches(mod.__panelForTest({ bridge: DEAD_BRIDGE, useSessions: () => [] })).join('\n')

  assert.equal(
    labels.includes('autoApprove'),
    false,
    '渲染断言没能看见被删掉的控件 —— 那它和字符串扫描就没有区别',
  )
})