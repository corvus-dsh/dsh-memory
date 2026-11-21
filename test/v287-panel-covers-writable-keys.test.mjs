/**
 * ── v287 (B4-0b-2 W6-1): 面板能读到的每个可写开关，面板上都必须有控件 ────────────────────────────
 *
 * MEASURED, BOTH REPOSITORIES, 2026-11-21:
 *
 *   memory `MEMORY_CONSOLE_KEYS`  = retrieval / workspaceIsolation / semanticFilter / autoApprove /
 *                                   taskAlignment                       (5 keys, all reported in config)
 *   memory `client.js` toggles    = 4                                    → `autoApprove` 无控件
 *
 *   graft  `CONSOLE_WRITABLE_KEYS`= 13 keys (5 bool + 2 ratio + 3 enum + 3 integer)
 *   graft  `client.js` controls   = 12                                   → `growthReserveTurns` 无控件
 *                                   （该名字在 client.js 里只出现一次，在 `fallbackState` 的默认值里）
 *
 * WHY THIS IS WORSE THAN A MISSING FEATURE. In both cases the panel DISPLAYED the value (the Host
 * ships it in `config`) and offered no way to change it. A user seeing a live readout next to a list
 * of switches concludes the switch is broken, not absent — and the only workaround was typing
 * `/memory-console-set autoApprove true` / `/graft-console-set growthReserveTurns 3` by hand, i.e.
 * the panel made the value visible and the action invisible.
 *
 * 判据（四条，全部机械可判）：
 *   ① 每个可写键都出现在面板的 `write('<key>'` 调用里（memory 与 graft 各一遍）；
 *   ② 反向：面板写的每个键都在可写集合里（否则控件会静默失败）；
 *   ③ 键集合的**分母**非空且被显式数出来（一条扫描什么都没扫到时不许通过）；
 *   ④ memory 的配置里报告的键 ⊆ 可写键 ∪ 只读展示键 —— 「报告了但既不能改也没标注只读」是缺陷。
 *
 * can-red（实测）：删掉 memory 的 `autoApprove` Toggle ⇒ ① 红并点名；删掉 graft 的
 * `growthReserveTurns` NumberRow ⇒ ① 红并点名。两个方向都测过。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GRAFT = join(ROOT, '..', 'dsh-graft-slice')

/** Keys a panel actually calls `write('<key>'` for. */
function panelWritableKeys(clientSource) {
  return new Set([...clientSource.matchAll(/write\('([A-Za-z][A-Za-z0-9]*)'/gu)].map((match) => match[1]))
}

const memoryServer = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
const memoryClient = readFileSync(join(ROOT, 'client.js'), 'utf8')

test('v287 ①: memory 的每个可写开关都在面板上有一个控件', () => {
  const setMatch = memoryServer.match(/MEMORY_CONSOLE_KEYS = new Set\(\[([^\]]+)\]\)/u)
  assert.ok(setMatch !== null, '找不到 MEMORY_CONSOLE_KEYS —— 检查本身失效了，不要当成通过')
  const writable = setMatch[1].match(/'([A-Za-z][A-Za-z0-9]*)'/gu).map((quoted) => quoted.slice(1, -1))

  /** ③ 分母：可写集合不能是空的 —— 一条扫不到东西的检查恒真。 */
  assert.ok(writable.length >= 5, `可写键只有 ${writable.length} 个，检查的分母异常`)

  const panel = panelWritableKeys(memoryClient)
  const missing = writable.filter((key) => !panel.has(key))
  assert.deepEqual(missing, [], `这些键可写，但面板上没有控件（宿主会显示它的值，于是用户以为是坏的）：${missing.join(', ')}`)
})

test('v287 ②: 面板写的每个键都真的是可写键（反向）', () => {
  const setMatch = memoryServer.match(/MEMORY_CONSOLE_KEYS = new Set\(\[([^\]]+)\]\)/u)
  const writable = new Set(setMatch[1].match(/'([A-Za-z][A-Za-z0-9]*)'/gu).map((quoted) => quoted.slice(1, -1)))
  const panel = panelWritableKeys(memoryClient)
  const bogus = [...panel].filter((key) => !writable.has(key))
  assert.deepEqual(bogus, [], `面板写了这些键，但宿主不认（控件会静默失败）：${bogus.join(', ')}`)
})

test('v287 ③: graft 的每个可写开关也在面板上有控件（同一缺陷的第二个仓）', () => {
  const graftServer = readFileSync(join(GRAFT, 'src', 'index.ts'), 'utf8')
  const graftClient = readFileSync(join(GRAFT, 'client.js'), 'utf8')

  /**
   * The writable set is built from FOUR declarations, so it is assembled here rather than matched as
   * one literal — a single regex over the file would silently pick up a subset and pass.
   */
  const bool = [...(graftServer.match(/CONSOLE_BOOLEAN_KEYS = \[([\s\S]*?)\]/u)?.[1] ?? '').matchAll(/'(\w+)'/gu)]
  const ratio = [...(graftServer.match(/CONSOLE_RATIO_KEYS = \[([\s\S]*?)\]/u)?.[1] ?? '').matchAll(/'(\w+)'/gu)]
  const enumBlock = graftServer.match(/CONSOLE_ENUM_KEYS[^=]*= \{([\s\S]*?)\n\}/u)?.[1] ?? ''
  const intBlock = graftServer.match(/CONSOLE_INTEGER_KEYS[^=]*= \{([\s\S]*?)\n\}/u)?.[1] ?? ''
  const enumKeys = [...enumBlock.matchAll(/^\s{2}(\w+):/gmu)].map((match) => match[1])
  const intKeys = [...intBlock.matchAll(/^\s{2}(\w+):/gmu)].map((match) => match[1])
  const writable = [
    ...bool.map((match) => match[1]),
    ...ratio.map((match) => match[1]),
    ...enumKeys,
    ...intKeys,
  ]

  assert.ok(writable.length >= 13, `graft 的可写键只有 ${writable.length} 个，检查的分母异常（应为 13）`)

  const panel = panelWritableKeys(graftClient)
  const missing = writable.filter((key) => !panel.has(key))
  assert.deepEqual(missing, [], `graft 面板缺少这些可写键的控件：${missing.join(', ')}`)
})

test('v287 ④: 任务图视图真的从宿主拿数，而不是在客户端重算一遍', () => {
  /**
   * The failure this pins is already in the repository's history: 飞轮 numbers were once computed in
   * both places and drifted. The rule is one producer; the panel may only RENDER.
   *
   * So: the Host must ship a `graph` field produced by `describeGraph`, and the client must contain a
   * task-graph card that reads `state.graph` — while containing no graph-COUNTING logic of its own.
   */
  assert.match(
    memoryServer,
    /graph: \(\(\) => \{[\s\S]{0,400}?describeGraph\(resolved\.memoryDir, entries\)/u,
    '面板的 graph 字段必须由 describeGraph 产出（与 memory_graph_read 同一个函数）',
  )
  assert.ok(memoryClient.includes('任务图（DAG）'), '面板必须有任务图视图')
  assert.match(memoryClient, /state\.graph/u, '视图必须读宿主送来的 state.graph，不能在客户端另算')
})
