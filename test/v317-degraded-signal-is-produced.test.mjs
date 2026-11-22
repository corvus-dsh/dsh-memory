/**
 * ── v317 / §〇 24 同族: 面板等一个产品从不发出的信号（memory 侧）────────────────────────────────────
 *
 * 与 graft `v316` **同一个缺陷**，出现在姊妹插件里：`client.js` 在三处读 `state.degraded`（健康徽标、
 * 红卡、交给渲染器的 fallback state），而 `src/` 里 `degraded` 只出现在 `pending-transfers.ts` 一句别义的
 * 注释里 —— **信号从不发出**。
 *
 * 判据写在真实生产者上：
 *   ① 三条真实降级各自被点名：任务图读不出 / 台账被拒读 / `configEditor` 不可用
 *   ② 负向：健康时必须 `degraded === false` 且不带理由（否则红卡变成壁纸）
 *   ③ 负向：**「读不出来」与「没有内容」必须分开** —— 空图不等于读不出
 *   ④ 多条同时降级时理由**全部**出现（不许只报第一条，让人以为只有一处坏了）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

async function load() {
  return import(pathToFileURL(join(ROOT, 'lib', 'console-degradation.js')).href)
}

test('v317 ①: each real degradation is named, with a reason a reader can act on', async () => {
  const { describeDegradation } = await load()

  const graph = describeDegradation({ graphUnreadable: true, ledgerDeferred: false, editorAvailable: true })
  assert.equal(graph.degraded, true)
  assert.match(String(graph.degradedReason), /任务图读不出来/u, '任务图读不出必须点名')

  const ledger = describeDegradation({ graphUnreadable: false, ledgerDeferred: true, editorAvailable: true })
  assert.equal(ledger.degraded, true)
  assert.match(String(ledger.degradedReason), /台账/u, '台账被拒读必须点名')

  const editor = describeDegradation({ graphUnreadable: false, ledgerDeferred: false, editorAvailable: false })
  assert.equal(editor.degraded, true)
  assert.match(String(editor.degradedReason), /configEditor/u, 'configEditor 不可用必须点名')
})

test('v317 ② (negative half): a HEALTHY host reports false and carries NO reason', async () => {
  /**
   * Without this, ① is satisfied by 「always degraded」 — and a红 card that is always on is wallpaper.
   */
  const { describeDegradation } = await load()
  const healthy = describeDegradation({ graphUnreadable: false, ledgerDeferred: false, editorAvailable: true })
  assert.equal(healthy.degraded, false, '健康时不得降级')
  assert.equal(healthy.degradedReason, undefined, '健康时不该带理由字符串')
})

test('v317 ③ (negative half): 「could not read」 is not the same as 「nothing there」', async () => {
  /**
   * An EMPTY graph is a normal, healthy state (a project that never created a plan). Only an UNREADABLE
   * one is degradation. Collapsing the two would put a red card on every new project.
   */
  const { describeDegradation } = await load()
  const emptyGraph = describeDegradation({ graphUnreadable: false, ledgerDeferred: false, editorAvailable: true })
  assert.equal(emptyGraph.degraded, false, '空任务图是正常状态，不是降级')
})

test('v317 ④: several failures at once are ALL reported, not just the first', async () => {
  /**
   * Reporting only the first reason is how a reader fixes one thing, sees the card stay red, and concludes
   * the diagnosis is wrong.
   */
  const { describeDegradation } = await load()
  const all = describeDegradation({ graphUnreadable: true, ledgerDeferred: true, editorAvailable: false })
  assert.equal(all.degraded, true)
  const reason = String(all.degradedReason)
  assert.match(reason, /任务图/u)
  assert.match(reason, /台账/u)
  assert.match(reason, /configEditor/u)
})

test('v317 ③b: `graphIsUnreadable` distinguishes 「absent」 from 「cannot read」 and 「cannot parse」', async () => {
  /**
   * `readGraph` CANNOT answer this — it swallows every failure and returns `emptyGraph`, so the two cases
   * arrive as one value. This helper exists because the collapse is right for a card that must render
   * something and wrong for the degraded signal.
   */
  const { graphIsUnreadable } = await load()
  const enoent = (error) => String(error?.code ?? '') === 'ENOENT'

  // 1. ABSENT ⇒ healthy. A project that never made a plan is normal.
  assert.equal(
    graphIsUnreadable(
      () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) },
      enoent,
      JSON.parse,
    ),
    false,
    '文件不存在是正常状态，不是降级',
  )

  // 2. UNREADABLE for another reason (permissions, a directory) ⇒ degraded.
  assert.equal(
    graphIsUnreadable(
      () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) },
      enoent,
      JSON.parse,
    ),
    true,
    '读了但失败（不是「没有」）必须报降级',
  )

  // 3. UNPARSEABLE ⇒ degraded. The file is there and its content cannot be trusted.
  assert.equal(
    graphIsUnreadable(() => '{ not json', enoent, JSON.parse),
    true,
    '内容坏了也必须报降级 —— 「有文件但读不懂」不等于「没有计划」',
  )

  // 4. PRESENT and valid ⇒ healthy.
  assert.equal(
    graphIsUnreadable(() => '{"nodes":[]}', enoent, JSON.parse),
    false,
    '空图是正常状态',
  )
})

test('v317 ⑤: a THROWING probe fails CLOSED (degraded), not silently healthy', async () => {
  /**
   * `safeFlag` exists so the three probes read the same way. Its default must be 「degraded」 — a probe
   * that cannot run is 「we do not know」, and a number that might be wrong must say so.
   */
  const { safeFlag } = await load()
  assert.equal(safeFlag(() => true), true)
  assert.equal(safeFlag(() => false), false)
  assert.equal(safeFlag(() => { throw new Error('boom') }), true, '抛错的探针必须 fail-closed 到 degraded')
  assert.equal(safeFlag(() => { throw new Error('boom') }, false), false, '调用方可以显式选择另一侧')
})
