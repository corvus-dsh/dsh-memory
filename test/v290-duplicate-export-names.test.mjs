/**
 * ── v290 (B4-0b-2 五形态之一「判据分裂」)：同名同义的两份实现 ⇒ 名字必须说出差异 ─────────────────
 *
 * ── 实测的那一处 ──────────────────────────────────────────────────────────────────────────────
 *
 * `src/archive.ts` 与 `src/dedupe.ts` 都导出过 `whenSimilarity`：同名、同签名、同声称用途
 * （「这两个触发器说的是不是同一件事」），而同一对句子给出差得很远的答案：
 *
 *     处理编号 0 的独立任务时  vs  处理编号 1 的独立任务时
 *         archive: 0.000   ← 数字不同 ⇒ 不同任务（archive.ts 的注释里明写这条规则）
 *         dedupe : 0.909   ← `normalizeForMatch` 删掉所有数字，两句塌成同一个串，于是 > 0.9
 *
 * ── 为什么**不合并** ──────────────────────────────────────────────────────────────────────────
 *
 * 两个答案在各自语境里都对：
 *
 *   · archive 的合并是**破坏性**的（absorb 一个技能，原文件标 archived）⇒ 「编号 0」与「编号 1」
 *     永远不许合并；
 *   · dedupe 的链接是**非破坏性**的（因果链上把两条记录连起来）⇒ 端口号、版本号通常是噪音。
 *
 * 所以缺陷不是两个行为，是**那一个名字**。修法是让名字说出它回答哪个问题：
 * `whenSimilarityDigitsMatter`。
 *
 * ── 判据（四条）───────────────────────────────────────────────────────────────────────────────
 *
 *   ① 静态：没有导出名在两个以上模块里**各定义一次**（`check-duplicate-export-names.mjs`，含分母）
 *   ② 行为：那两对句子在改名后的两个函数上**必须给出不同的答案** —— 这条钉住「分裂是真实存在的
 *      语义差异」，而不是「曾经重名」。若有人把两者改成一致，② 会红并迫使他们说明。
 *   ③ archive 侧仍然是「数字不同 ⇒ 不相似」（0） —— 破坏性路径的安全性质
 *   ④ dedupe 侧仍然是「数字是噪音」（> 0.9） —— 非破坏性路径的既定行为
 *
 * ②③④ 合起来的意思是：**两个函数各自的行为被分别钉住了。** 只钉「不重名」的测试，在有人把两者
 * 都改成同一个函数时仍会绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { whenSimilarityDigitsMatter } from '../lib/archive.js'
import { whenSimilarity } from '../lib/dedupe.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GATE = join(ROOT, 'scripts', 'check-duplicate-export-names.mjs')

/** The pair that exposed the split. Digits are the ONLY difference. */
const DIGIT_A = '处理编号 0 的独立任务时'
const DIGIT_B = '处理编号 1 的独立任务时'

test('v290 ①: 没有导出名在两个以上模块里各定义一次', () => {
  const result = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(
    result.status,
    0,
    `出现同名导出了：\n${result.stdout}${result.stderr}\n` +
      '两个模块导出一个名字，是在声称它们回答同一个问题。要么让行为只有一处，要么让名字说出差异。',
  )
  assert.match(result.stdout, /duplicate-export-names: OK/u)
})

test('v290 ②: 两个函数对同一对句子必须给出不同的答案（分裂是真实的语义差异）', () => {
  const archive = whenSimilarityDigitsMatter(DIGIT_A, DIGIT_B)
  const dedupe = whenSimilarity(DIGIT_A, DIGIT_B)

  assert.notEqual(
    archive,
    dedupe,
    '两个函数给出了相同答案 —— 要么有人把其中一个改成了另一个，要么这次「分裂」从来不存在。' +
      `实测 archive=${archive} dedupe=${dedupe}`,
  )
  /**
   * And the gap must be WIDE, not a rounding difference: the whole reason two names exist is that
   * they land on opposite sides of a merge threshold.
   */
  assert.ok(
    Math.abs(archive - dedupe) > 0.5,
    `两个答案只差 ${Math.abs(archive - dedupe)}，不足以说明它们回答的是不同问题`,
  )
})

test('v290 ③: archive 侧 —— 数字不同 ⇒ 不相似（破坏性路径的安全性质）', () => {
  /**
   * The archive pass ABSORBS a skill: the absorbed file is marked `archived` and folded into the
   * keeper. So 「编号 0 的任务」 and 「编号 1 的任务」 must never merge, and this assertion is about a
   * destructive act, not about a number.
   */
  assert.equal(
    whenSimilarityDigitsMatter(DIGIT_A, DIGIT_B),
    0,
    'archive 认为这两个技能相似 —— 一次错误的合并会把编号 1 的技能永久标为 archived',
  )
  /** The positive control: the SAME sentence still scores 1, so ③ is not 「always 0」. */
  assert.equal(whenSimilarityDigitsMatter(DIGIT_A, DIGIT_A), 1, '同一句话必须仍是 1 —— 否则 ③ 是「恒 0」的假断言')
})

test('v290 ④: dedupe 侧 —— 数字是噪音（非破坏性路径的既定行为）', () => {
  assert.ok(
    whenSimilarity(DIGIT_A, DIGIT_B) > 0.9,
    'dedupe 未把数字当噪音 —— 它的 `normalizeForMatch` 删掉所有数字是既有实现，改了要在这里说清',
  )
  /** And a genuinely different pair still scores low, so ④ is not 「always 1」. */
  assert.ok(
    whenSimilarity('处理编号 0 的独立任务时', '数据库连接池要设置超时') < 0.5,
    'dedupe 对毫不相干的两句话给了高分 —— 阈值判据失效',
  )
})