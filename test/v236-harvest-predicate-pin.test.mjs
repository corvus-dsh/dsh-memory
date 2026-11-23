/**
 * ── v236 (B2-T4): 「未提炼」判据必须是活的，不许被改成恒假 ─────────────────────────────────────
 *
 * `b2-trigger` 第三条要求（节点 `complete` 后 `harvestedAt` 空 ⇒ `harvestRequired:true`）**已经实现**，
 * 由 `test/v091-harvest-warning.test.mjs` 的 11 条覆盖，真机也连续验证过三次。T4 不重写它。
 *
 * 但「有测试」不等于「判据是活的」。实测的 can-red（2026-11-18）：把三处
 * `node.harvestedAt.length === 0` 全部换成字面 `false`，
 *
 *   v091  11 条 → 4 红 7 绿
 *
 * ——**红的正好是依赖这条判据的四条，其余七条照旧绿**。这证明它是一条真守卫，也证明
 * **只看「v091 全绿」不足以发现它被改成恒假**：另外七条仍然是绿的，一次跑下来是个绿多红少的
 * 报表，而 `harvestRequired` 已经永远为 false 了。
 *
 * ── 为什么这条用源码断言，而不是再写一遍行为测试 ─────────────────────────────────────────────
 *
 * 行为测试抓不到「判据被改成恒假但恰好没有场景触发它」。这里要钉的不是「会不会提醒」，而是
 * **判据本身还在不在**。源码断言是唯一能区分「判据活着但没触发」与「判据已经不存在」的仪器。
 *
 * 它不脆弱：断言的是**语义片段的出现**，不是行号（v140 已经因为硬编码行号吃过一次亏）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE = readFileSync(join(REPO, 'src', 'index.ts'), 'utf8')

/** The predicate, as one exact string — the thing whose existence this file exists to guarantee. */
const PREDICATE = 'node.harvestedAt.length === 0'

test('v236 ①: 「未提炼」判据在四处读取面都还在（completion 提示 / 列表 / harvestWarningFor / flywheel）', () => {
  const occurrences = SOURCE.split(PREDICATE).length - 1
  /**
   * FOUR, as of v0.40 (B3 / F6), and the change is recorded here rather than absorbed silently:
   *
   *   ① the completion prompt   ② the node listing   ③ `harvestWarningFor`   ④ the flywheel count
   *
   * ④ is new: `memory_stats.flywheel.pendingNodes` answers the same question the reminder answers
   * ("which finished nodes have not contributed"), so it must use the same predicate. A count derived
   * some other way would be a second definition of "un-harvested", and the two would drift.
   *
   * If this number changes again because a surface was REMOVED on purpose, update it and say why in
   * the commit; do not delete the assertion.
   *
   * ── 19.4-G: THREE HERE, FOUR SURFACES STILL EXIST ───────────────────────────────────────────────
   *
   * The number went 4 → 3 because ONE of the copies MOVED, not because a surface was removed. The
   * write-path copy now lives in `graph-view.ts` as `stampTargetsForHarvest`, which is the whole point
   * of 19.4-G: five hand-written filters each forgot `goal`, so 「is this a unit of work」 became one
   * predicate asked from one place.
   *
   * That is also why this file now counts BOTH files. A count restricted to `index.ts` would have
   * reported a surface REMOVED when it was actually re-homed — and the next reader would have had to
   * re-derive that. **A denominator that silently changes shape is the same disease as a number without
   * one.**
   */
  const VIEW = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'graph-view.ts'), 'utf8')
  const total = occurrences + (VIEW.split(PREDICATE).length - 1)
  assert.equal(total, 4, `判据必须仍在四处（index.ts ${occurrences} + graph-view.ts ${total - occurrences}），实测 ${total} 处`)
})

test('v236 ②: 判据没有被换成字面 false（can-red 的形状）', () => {
  /**
   * The can-red that motivates this file. Written as the exact failure shape so the message names what
   * went wrong rather than merely "a string is missing":
   *
   *     node.status === 'done' && false && node.id !== START_NODE_ID
   */
  assert.doesNotMatch(
    SOURCE,
    /node\.status === 'done' && false/u,
    '「未提炼」判据被换成了恒假 —— 提醒会永远消失，而 v091 的其余七条仍是绿的',
  )
})

test('v236 ③: 判据读的是 harvestedAt 的**空字符串**，不是任意假值', () => {
  /**
   * `harvestedAt` is a timestamp string: `''` means "never harvested", an ISO string means it was.
   * A predicate written as `!node.harvestedAt` would be equivalent today and would silently invert if
   * the field ever became a number (epoch 0 is falsy) — so the exact comparison is the contract.
   */
  for (const line of SOURCE.split('\n')) {
    if (!line.includes('harvestedAt')) continue
    if (!line.includes('node.status === \'done\'')) continue
    assert.match(line, /harvestedAt\.length === 0/u, `每一处完成判定都必须比长度：${line.trim()}`)
  }
})

test('v236 ④: 行为测试仍在（判据活着，且有人在测它）', () => {
  /**
   * The static pin above proves the PREDICATE exists; this proves the BEHAVIOUR is still covered.
   * Neither alone is enough: a predicate with no behavioural test can be "fixed" by deleting the test,
   * and a behavioural test with no static pin can pass while the predicate is恒假 but unmatched.
   */
  const suite = readFileSync(join(REPO, 'test', 'v091-harvest-warning.test.mjs'), 'utf8')
  assert.match(suite, /harvestedAt/u, 'v091 必须仍覆盖 harvestedAt 这条线')
  assert.match(suite, /knowledge_harvest/u, 'v091 必须仍覆盖「真的写了知识库才算」这一半')
})