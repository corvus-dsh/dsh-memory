/**
 * ── v217: D-1 —— `hitOf` 不复制 `ageDays`/`hits` ⇒ 过期前缀永不出现 ───────────────────────────────
 *
 * ── 这个缺陷的形状（比原登记更大）──────────────────────────────────────────────────────────────
 *
 * 原登记说：`hitOf()` 不复制 `ageDays` ⇒ `renderHint()` 读到的永远是 `undefined` ⇒ 前缀不出现。
 * 端到端实测（`docs/d1-ageDays-plan.md`）证明还有第二个字段：**`hits` 也没有被复制**。
 *
 * 而 `isStaleNegative` 的规则是「**老 且 从未复发**」：
 *
 *     const hits = Number(negative.hits ?? 1)
 *     if (Number.isFinite(hits) && hits > 1) return false     ← 复发过 ⇒ 不是往事
 *
 * 于是 `hits` 恒为 `undefined` ⇒ `?? 1` ⇒ **一律当成「从未复发」**。
 *
 * ── 为什么两行必须同一笔修（这个文件存在的核心理由）──────────────────────────────────────────
 *
 * | 情形 | 真值 | 都不修（修前） | **只修 ageDays** |
 * |---|---|---|---|
 * | 老 + 从未复发（hits=1） | 前缀 | 无前缀（少说） | 前缀 ✅ |
 * | **老 + 复发 5 次（hits=5）** | **无前缀** | 无前缀 | **前缀 ❌ 主动说错** |
 * | 新 + 从未复发 | 无前缀 | 无前缀 | 无前缀 |
 *
 * 修前是**安静地少说一句话**；只修一半会变成**主动说错一句话**，比不修更糟。
 * 所以测试 ③ 是「只修一半就会红」的守卫 —— 它在修前也是绿的（因为一律不带前缀），
 * 它是**回归守卫**，不是先红项。这一点必须写清楚，否则下一个人会以为它没用。
 *
 * ── 为什么原测试没抓到（D-1 最难的部分）──────────────────────────────────────────────────────
 *
 * `test/v021-governance.test.mjs:206-229` 确实断言了「前缀会出现」，但它**手工构造**了
 * `{ ageDays: NEGATIVE_STALE_DAYS + 10, hits: 1 }` 喂给 `renderHint` ——
 * **那正是真实路径永远不会产出的对象**。它测的是 `renderHint` 的局部逻辑，
 * 不是 `hitOf → renderHint` 这条链。
 *
 * 下面 ④ 把那条测试改成走真实路径（在那里改，不在这里重复）——
 * 否则 D-1 修完了，那条测试还在测假对象，下一个改的人还会被它误导。
 *
 * ── 本文件只走真实路径 ──────────────────────────────────────────────────────────────────────────
 *
 * 每一条都经 `retrieveCandidates`（真实读盘 → `negativeDocumentOf` → `hitOf`），
 * **没有一条手工构造 hit**。这是与 v021 那三条的本质区别。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  NEGATIVE_STALE_DAYS,
  NEGATIVE_STALE_PREFIX,
  renderHint,
  retrieveCandidates,
} from '../lib/retrieve.js'

const WORKSPACE = 'D:\\workspace'
const WS = 'D:/workspace'
const QUERY = '改动迁移逻辑 证明修复有效'

/** 造一个记忆目录，往 negatives.jsonl 里写一条。与真实 store 的落盘形状一致。 */
function plantNegative ({ atDaysAgo, hits, symptom = '迁移时漏改索引导致断言失败', avoid = '先跑全量再改' }) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-d1-'))
  const memory = join(root, 'memory')
  const skills = join(root, 'skills')
  mkdirSync(memory, { recursive: true })
  mkdirSync(skills, { recursive: true })
  const at = new Date(Date.now() - atDaysAgo * 86_400_000).toISOString()
  const record = {
    symptom,
    cause: '索引与实现不同步',
    avoid,
    scope: 'project',
    workspace: WS,
    at,
    ...(hits === undefined ? {} : { hits }),
    provenance: 'user',
  }
  writeFileSync(join(memory, 'negatives.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
  return { memory, skills }
}

/** 走真实路径取回第一条 negative hit。 */
function retrieveNegative (planted) {
  const hits = retrieveCandidates(planted.memory, planted.skills, QUERY, { workspace: WORKSPACE })
  return hits.find((hit) => hit.kind === 'negative')
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * 测试 ①：真实路径的 hit 必须带 ageDays / hits（**修前必红**）
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

test('D-1 ①: 真实路径产出的 negative hit 必须带 ageDays 与 hits（修前红）', () => {
  const planted = plantNegative({ atDaysAgo: NEGATIVE_STALE_DAYS + 10, hits: 1 })
  const hit = retrieveNegative(planted)

  assert.ok(hit !== undefined, '真实路径应当召回这条 negative —— 否则本测试测的是空集')

  // 这两个断言在当前代码上是红的：hitOf 没有复制它们。
  assert.equal(typeof hit.ageDays, 'number',
    `hit.ageDays 应当是数字，实测 ${JSON.stringify(hit.ageDays)}。`
    + 'renderHint 用它判断「老」，undefined 会让它永远判不出老。')
  /**
   * `ageDays` 是**小数**，不是整数：`ageDaysOf` 算的是 `(now - at) / 86400000`，
   * 而 `now` 是取数那一刻的毫秒、`at` 是落盘时写下的 ISO 秒。
   * 实测 `40.00000001157407` —— 差的那点来自「plant 之后到 retrieve 之间」的几毫秒。
   *
   * 所以断言用**区间**，不是 `=== 40`：写死整数会让这条测试在跨秒边界时偶发红，
   * 而那种红与被测行为无关。这与「判据必须能红」不冲突 —— 它仍然会在
   * `ageDays` 缺失、或被算成 0/1 时红。
   */
  assert.ok(hit.ageDays > NEGATIVE_STALE_DAYS && hit.ageDays < NEGATIVE_STALE_DAYS + 11,
    `hit.ageDays 应落在 (${NEGATIVE_STALE_DAYS}, ${NEGATIVE_STALE_DAYS + 11}) 开区间内，实测 ${hit.ageDays}`)

  assert.equal(typeof hit.hits, 'number',
    `hit.hits 应当是数字，实测 ${JSON.stringify(hit.hits)}。`
    + 'isStaleNegative 用 Number(hits ?? 1)，undefined 会被当成「从未复发」。')
  assert.equal(hit.hits, 1, `hit.hits 应为 1（这条只发生过一次），实测 ${JSON.stringify(hit.hits)}`)
})

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * 测试 ②：真实路径的 hint 必须带过期前缀（**修前必红**）
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

test('D-1 ②: 真实路径的 hint 带过期前缀（修前红）', () => {
  const planted = plantNegative({ atDaysAgo: NEGATIVE_STALE_DAYS + 10, hits: 1 })
  const hit = retrieveNegative(planted)
  assert.ok(hit !== undefined, '真实路径应当召回这条 negative')

  const hint = renderHint({ negative: hit, debug: { terms: 1, matched: 1 } })
  assert.ok(hint !== undefined, 'hint 应当渲染出来：它是一条往事，不是删除')

  assert.ok(hint.includes(NEGATIVE_STALE_PREFIX),
    `这条是 ${NEGATIVE_STALE_DAYS + 10} 天前、只发生过一次的错误，提示里必须带 `
    + `「${NEGATIVE_STALE_PREFIX}」。实测 hint = ${JSON.stringify(hint)}`)
})

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * 测试 ③：复发过的老 negative **不带**前缀（回归守卫，修前也绿）
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

test('D-1 ③: 复发过的老 negative 不带过往前缀（只修 ageDays 会红）', () => {
  /**
   * 这是「两行必须同一笔」的守卫。它的价值不在修前（修前一律不带前缀，故这里绿），
   * 而在**中间状态**：如果只补了 `ageDays` 而漏了 `hits`，
   * 这条提示会被打上「历史偶发错误，仅供参考」—— 而它是一条**复发了 5 次的活规则**。
   */
  const planted = plantNegative({ atDaysAgo: NEGATIVE_STALE_DAYS + 10, hits: 5 })
  const hit = retrieveNegative(planted)
  assert.ok(hit !== undefined, '真实路径应当召回这条 negative')

  // 先确认前提真的被建出来了：这条确实是 hits=5 的老记录
  assert.equal(hit.hits, 5,
    `前提：hit.hits 必须是 5（复发过）。实测 ${JSON.stringify(hit.hits)}。`
    + '若这里就红了，说明 hits 没被复制 —— 那 ④ 的豁免判断会建立在 undefined 上。')

  const hint = renderHint({ negative: hit, debug: { terms: 1, matched: 1 } })
  assert.ok(hint !== undefined)
  assert.equal(hint.includes(NEGATIVE_STALE_PREFIX), false,
    '复发了 5 次的规则是**活规则**，不是往事。给它打上过往前缀 = 主动说错一句话。\n  '
    + `hint = ${JSON.stringify(hint)}`)
})

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * 测试 ④：新记录不带前缀（防止修复把前缀加宽）
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

test('D-1 ④: 新的 negative 不带过往前缀（修完也不能变成一律带）', () => {
  const planted = plantNegative({ atDaysAgo: 1, hits: 1 })
  const hit = retrieveNegative(planted)
  assert.ok(hit !== undefined)

  const hint = renderHint({ negative: hit, debug: { terms: 1, matched: 1 } })
  assert.ok(hint !== undefined)
  assert.equal(hint.includes(NEGATIVE_STALE_PREFIX), false,
    `1 天前的记录不是往事。实测 hint = ${JSON.stringify(hint)}`)
})
