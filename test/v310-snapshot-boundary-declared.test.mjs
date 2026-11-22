/**
 * ── v310 / B4-B TD-M20 (P2): 快照的年龄必须说出来，而不是声称实时 ────────────────────────────────
 *
 * 用户原话（派工单 §十六 TD-M20）：**「本批不改行为，只补一条边界声明：把『看不见窗口 ≤1 天』写进
 * `memory_stats` 的输出或面板文案。判据：读到缓存的路径上能说出『本快照最多可能旧 1 天』。负向：不声称实时。」**
 *
 * 窗口是真实的：缓存键 = 「目录 mtime + 当天日期」（`skillDocsKey`），所以
 *
 *   · 新增 / 删除一个技能文件 ⇒ 目录 mtime 变 ⇒ 立即失效；
 *   · **原地修改**同一个文件 ⇒ mtime 变而键里的日不变 ⇒ 要等到次日才被看见。
 *
 * `v293 ④` 钉的是**行为**（看不见）。本文件钉的是**读者被告知**：`memory_stats` 的数值旁边必须有这句话，
 * 且不许出现「实时 / 已是最新」这类相反的声称。
 *
 * ── 为什么声明住在 `skill-cache.ts` 而不是 `index.ts` ─────────────────────────────────────────────
 *
 * `index.ts` 有一条棘轮天花板（2819 行），规则原文是「今天多大就是多大，**不许因为加功能就放宽**」。
 * 一个需要抬高天花板才能放进去的声明，是放错文件的声明。声明因此跟着它描述的缓存走，通过
 * `skillDocsCacheStats().boundary` 输出 —— 那里本来就有调用方在读。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/**
 * Load the built library the way the plugin does.
 *
 * `pathToFileURL` is required, not stylistic: on Windows a bare `D:\…` specifier is rejected by the ESM
 * loader with `ERR_UNSUPPORTED_ESM_URL_SCHEME … Received protocol 'd:'`, which reads like a broken build
 * rather than a test-side path bug.
 */
async function loadCache() {
  return import(pathToFileURL(join(ROOT, 'lib', 'skill-cache.js')).href)
}

test('v310 TD-M20 ①: the cache stats carry the boundary, and it says 「at most 1 day old」', async () => {
  const cache = await loadCache()
  const stats = cache.skillDocsCacheStats()
  assert.equal(typeof stats.boundary, 'object', 'skillDocsCacheStats 必须带上 boundary')
  assert.match(String(stats.boundary.skillDocuments), /1 day old/u,
    `边界必须说清是「最多旧 1 天」；实测 ${JSON.stringify(stats.boundary)}`)
  assert.match(String(stats.boundary.reason), /原地修改/u,
    '并且必须说清哪一种改动看不见（原地修改同一文件），否则这句话解释不了它存在的理由')
})

test('v310 TD-M20 ② (negative half): the boundary must NOT claim to be live', async () => {
  /**
   * The negative half is the whole point: a declaration that says 「实时」 would be worse than none,
   * because the one time this window matters is when someone edits a skill and the tool keeps citing the
   * old text.
   */
  const cache = await loadCache()
  const boundary = cache.skillDocsCacheStats().boundary
  const text = `${boundary.skillDocuments} ${boundary.reason}`
  /**
   * Measured twice: a naive `/实时/` first fired on 「不声称实时」 and then on 「（非实时快照）」 — the
   * NEGATED forms. A criterion that cannot tell a claim from its denial punishes correct wording, so the
   * pattern targets an AFFIRMATIVE claim and explicitly excludes the negations in front of it.
   */
  assert.doesNotMatch(text, /(?:^|[^非不])(?:实时|已是最新)/u,
    `边界声明不得做出肯定式的「实时」声称；实测：${text}`)
  assert.match(text, /非实时|落后/u, 'and it must say the opposite in so many words')
})

test('v310 TD-M20 ③: the PANEL says it, next to the skill count', async () => {
  /**
   * The dispatch allows either 「`memory_stats` 的输出」 or 「面板文案」. The panel is where a reader actually
   * looks at the count, and it is reachable without growing `index.ts` — which is under a ratchet ceiling
   * whose rule is 「今天多大就是多大，不许因为加功能就放宽」. A declaration that needs a bigger ceiling is a
   * declaration in the wrong file.
   *
   * Asserted on the rendered sentence rather than on the exported constant: the constant existing proves
   * nothing about whether a reader ever sees it.
   */
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
  assert.equal(source.includes('本快照可能落后至多 1 天'), true,
    '面板必须有这句边界（位于技能库计数旁）')
  assert.match(source, /原地修改同一文件要等到次日/u,
    '并且必须说清哪一种改动看不见 —— 否则读者无法判断什么时候该重查')
})
