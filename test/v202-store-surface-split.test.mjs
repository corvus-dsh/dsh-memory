/**
 * 门禁①：`lib/store.js` 的导出面必须拆成两半分别断言。
 *
 * ── WHY "51" WAS THE WRONG BASELINE ───────────────────────────────────────────────────────────
 *
 * 前几轮一直用「导出面 = 51」当 A3 的基线，把「仍 51」当作「纯位移没撑大公开面」的证据。
 * 实测（`git show <sha>:lib/store.js` 静态数导出名）：
 *
 *     1065ca1  A3 完成   总数 51 = 业务面 50 + 接缝 1（resetMonotonicClockForTest）
 *     3a5933e  HEAD      总数 52 = 业务面 50 + 接缝 2（+resetShapeCacheForTest）
 *
 * **业务面一直是 50，一个都没变过。** 那个「51」是「50 业务 + 1 接缝」的和 ——
 * 把接缝混进业务面一起数，加一个测试接缝就被读成「公开契约被撑大」，而它其实没变。
 *
 * 所以本测试把两件事分开断言：
 *   - 业务面必须是 50（对外承诺的契约；加一个就该有人解释为什么）；
 *   - 接缝必须是「已登记清单」的精确集合（不多不少，每个都写明为什么从这里出去）。
 *
 * 混在一起数的时候，接缝增长会掩护业务面增长 —— 那正是本文件存在的理由。
 *
 * ── THE NAMES COME FROM MEASUREMENT, NOT FROM TYPING ─────────────────────────────────────────
 *
 * 这份 50 个名字是**实测生成**的（`Object.keys(await import('lib/store.js'))` 过滤掉 `*ForTest`）。
 * 第一版我凭记忆手写了一份，结果漏了 `MAX_LAYER_RECORDS` / `planLayerArchive`、又多了几个
 * 不存在的名字 —— 手抄名单在这件事上没有一次是对的。名单与计数是两种断言：
 * 计数抓「加一个删一个」，名单抓「换一个但数量不变」。
 */

import { describe, it } from 'node:test'
import { equal, deepEqual } from 'node:assert'

/**
 * 业务面：对外承诺的公开契约。实测值，见文件头。
 *
 * ── 2026-11-18（B3-5 / TD-M1）：50 → 51，`mergeSkills` ─────────────────────────────────────────
 *
 * TD-M1 的退出条件原文写着「`store.mergeSkills(keeper, absorbed)` 落盘」，所以这个函数**必须**
 * 出现在 `store.js` 的业务面上——不是「顺手多导出」，而是那条退出条件点名的地方。
 *
 * 为什么它算业务面而不是接缝：`applySkillArchive` 在**激活路径**上调用它，`lib/index.js` 的
 * 归档 pass 靠它执行合并。有生产调用方的函数不是接缝。
 */
const EXPECTED_BUSINESS_NAMES = [
  'AUDIT_KEEP', 'AUDIT_ROTATE_BYTES', 'MAX_LAYER_RECORDS', 'MAX_NEGATIVES', 'NEGATIVE_ARCHIVE_FILE',
  'StoreWriteRejected', 'appendExperiences', 'appendFacts', 'appendMemoryAudit', 'appendNegatives',
  'applySkillFeedback', 'applySupersede', 'asVocab', 'assertSafeSkillName', 'atomicWrite', 'clampConfidence',
  'clearSkillShapeCache', 'conflictStrength', 'defaultSkillsDir', 'environmentDivergence',
  'environmentTokensOf', 'findConflicts', 'invalidateSkillShape', 'isConflictingSkill', 'isProcessed',
  'isValidAt', 'linkConflictBack', 'listSkillRecords', 'markProcessed', 'markSkillValidated',
  'memoryAuditPath', 'mergeSkills', 'migrateBareEvidence', 'monotonicTimestamp', 'normalizeSkill', 'parseInstant',
  'parseSkillFile', 'planNegativeArchive', 'processedKey', 'quarantineWorkspaceMemory',
  'readFrontmatterField', 'readFrontmatterList',
  'readProcessed', 'readSkillBody', 'readSkillValidity', 'readSkillWorkspace', 'rebuildConflictLinks',
  'recordCounterEvidence', 'rotateAuditIfNeeded', 'scanThreat', 'skillPath', 'stats',
  'touchSkillUsage', 'writeSkill',
]

/**
 * ── W1-9b: 业务面 52 → 54，新增两个名字，理由是「它们必须能被测试直接驱动」 ─────────────────────
 *
 * `readFrontmatterField` / `readFrontmatterList` 是 frontmatter 读取的**唯一合法入口**。
 * 它们之所以必须在业务面上，不是为了让调用方方便，而是因为判据本身是关于**它们的行为**的：
 *
 *   · `v270 ③` 断言「字段为空 + 下一行非空 ⇒ 返回空列表」，这是唯一能钉住 `\s*` 那个 bug 的形态；
 *   · `scripts/check-frontmatter-reads.mjs` 断言「别处不许再写第 36 份副本」——它检查的是
 *     helper 的**函数体**，而不是一个恰好叫这个名字的字符串。
 *
 * 如果把它们藏成内部私有函数，就只能靠间接推断（读某个更高层的输出），而那种断言在「读取器
 * 忽略该字段」时会照样通过 —— 这正是 `v269 ④` 已经拒绝过的形状。
 */
const EXPECTED_BUSINESS_COUNT = 54

/**
 * 已登记接缝：名字 → 为什么必须从 `store.js` 导出。
 * 集合必须精确：多一个、少一个都红。新增时必须能写出理由 ——
 * 写不出，那多半它不该在这里（命名规则见 `src/index.ts` 的 `THE TEST-SEAM SURFACE`）。
 *
 * ── A1-6：接缝从 N=2 回到 N=1 ────────────────────────────────────────────────────────────────
 *
 * `resetShapeCacheForTest` 已随 `shapeCache` 进 `store/skill.ts`，**不再从 store.js 导出**。
 * 理由：一个测试接缝应该跟着它重置的那份状态走，而不是留在业务面上。
 * 实测：store.js 52 → 51 条 = 业务面 50（不变）+ 接缝 1。
 * 这条变化由本文件的第二个断言捕获 —— 若忘了同步登记表，它会红。
 */
const REGISTERED_SEAMS = new Map([
  ['resetMonotonicClockForTest',
    '第 0 步把时钟三件套搬进 store/clock.ts 后沿用既有 import 路径；src/index.ts 也 re-export 它'],
])

const surfaceOf = async () => {
  const mod = await import(new URL('../lib/store.js', import.meta.url).href)
  return Object.keys(mod).sort()
}

describe('lib/store.js 导出面：业务面与接缝分开断言', () => {
  it(`业务面恰好 ${EXPECTED_BUSINESS_COUNT} 个，且逐个名字对得上`, async () => {
    const business = (await surfaceOf()).filter((k) => !/ForTest/u.test(k))
    deepEqual(business, [...EXPECTED_BUSINESS_NAMES].sort(),
      '业务面与实测基准不一致 —— 计数相同但名字不同（换了一个）也会在这里红')
    equal(business.length, EXPECTED_BUSINESS_COUNT,
      `业务面应为 ${EXPECTED_BUSINESS_COUNT}，实测 ${business.length}`)
  })

  it('接缝恰好是已登记的那 N 个', async () => {
    const seams = (await surfaceOf()).filter((k) => /ForTest/u.test(k))
    deepEqual(seams.sort(), [...REGISTERED_SEAMS.keys()].sort(),
      '接缝集合与登记表不一致 —— 新增接缝请先在 REGISTERED_SEAMS 写明它为什么必须从这里导出')
  })

  it('登记表只收 *ForTest$ 形状的名字', () => {
    for (const name of REGISTERED_SEAMS.keys()) {
      if (!/ForTest$/u.test(name)) {
        throw new Error(`登记表里的 ${name} 不是 *ForTest 结尾 —— 登记表只收接缝`)
      }
    }
  })
})