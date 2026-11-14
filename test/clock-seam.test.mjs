/**
 * ── 时钟接缝（seam）测试：第 0 步搬 `store/clock.ts` 前后的**唯一判据** ─────────────────────────
 *
 * 为什么这条测试必须先于搬迁存在：
 *
 * `lastIssuedMs` 是一个**模块级**状态，而 `monotonicTimestamp` / `resetMonotonicClockForTest`
 * 是它的两个门。把它们搬进 `store/clock.ts` 时，最危险的失败不是"编译不过"，而是
 * **测试接缝指向了一个不同的实例** —— 那么 `resetMonotonicClockForTest(0)` 清的是 A 实例的钟，
 * 而 `monotonicTimestamp` 读的是 B 实例的钟。编译通过、单测**也可能通过**（如果每个用例都刚好
 * 从零开始），但"测试能重置生产时钟"这个前提已经不成立了。
 *
 * 所以本文件断言的是**跨两个入口的同一性**：
 *
 *     resetMonotonicClockForTest(0); monotonicTimestamp(1000)  ===  「1970-01-01T00:00:01.000Z」
 *
 * 若两者不是同一个 `lastIssuedMs`，那么 `lastIssuedMs` 会保留它之前的值（很可能远大于 1000），
 * 于是 `max(1000, last + 1)` 会返回 `last + 1` 而不是 1000 —— 断言立刻失败。
 *
 * **搬前搬后都要绿**，才算"穿上了"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { monotonicTimestamp, resetMonotonicClockForTest } from '../lib/store.js'

test('clock seam: reset(0) then stamp(1000) is based on 0, not on whatever the clock had before', () => {
  /**
   * 先把钟推到很远，制造一个"如果接缝断了就会被看到"的状态。
   * 没有这一步，一个全新进程里的 `lastIssuedMs` 本来就是 0，
   * 测试会在"接缝其实是坏的"情况下照样通过 —— 那正是这类缺陷最容易漏掉的地方。
   */
  monotonicTimestamp(1_000_000_000_000)
  const polluted = monotonicTimestamp(Date.now())
  assert.ok(
    new Date(polluted).getTime() >= 1_000_000_000_000,
    'setup: the clock must be far ahead before we reset it (otherwise the assertion below proves nothing)',
  )

  resetMonotonicClockForTest(0)
  const stamped = monotonicTimestamp(1_000)

  assert.equal(
    stamped,
    new Date(1_000).toISOString(),
    'after reset(0), a stamp at t=1000 must be exactly 1000 — if it is larger, reset and stamp are not sharing one clock',
  )

  resetMonotonicClockForTest(0)
})

test('clock seam: reset takes effect on the SAME module instance the writer uses', () => {
  /**
   * 第二条独立角度：reset 到一个**非零**的已知原点，再问两个先后时间。
   * 这能抓住"reset 只清了一个副本"的另一种形状：若接缝断了，第二个值会继续基于
   * 上一次的高位，而不是基于我们刚设的 5_000。
   */
  resetMonotonicClockForTest(5_000)

  const a = monotonicTimestamp(1_000) // 早于原点 ⇒ 应被抬到 5_001
  const b = monotonicTimestamp(1_000)

  assert.equal(new Date(a).getTime(), 5_001, 'a timestamp earlier than the reset origin is bumped to origin+1')
  assert.equal(new Date(b).getTime(), 5_002, 'and the next one is bumped again — the origin was really 5_000')

  resetMonotonicClockForTest(0)
})
