/**
 * ── v211：`docs/**.md` 里不许出现**可执行的** `verify-pure-move ... --against HEAD` ──────────────────
 *
 * 用户裁定：「扫描 docs/**.md 里 verify-pure-move --against HEAD 的字样并报红 —— 同一条错
 * 已犯四次，不能再靠人读。」
 *
 * ── 那条错是什么 ────────────────────────────────────────────────────────────────────────────────
 *
 * `--against HEAD` 在**搬运完成之后**跑是 **VACUOUS**（exit 2，两边同一棵树）。而写文档的人
 * 是在搬运刚完成时写的，那时工作树确实等于「搬完的状态」——于是文档里记 `--against HEAD`
 * 看起来天然合理。读者几个月后照着跑，得到的是 exit 2（不是绿，也不是红）。
 *
 * 四次：step1 / step2 / step3 / step4 各一次。第五次之后没人会再读一遍全部文档。
 *
 * ── 判据要区分两种出现 ──────────────────────────────────────────────────────────────────────────
 *
 * 实测 docs/ 里这个字样有 7 处，其中 **5 处是订正说明**，例如：
 *
 *     > **订正（2026-11-15）**：这里原先写的是 `--against HEAD`。那有两个问题：…
 *
 * 那句**必须**保留 —— 它正是「这个错曾经存在、已修正」的记录。把订正说明也判红，
 * 等于强迫文档删掉自己的错误史。
 *
 * 所以判据只抓**可执行的形式**：代码块里以 `$` / `node` / `npm` 开头的行。
 * 叙述里用反引号提到的字样不算 —— 那是引用，不是指令。
 *
 * ── 边界 ────────────────────────────────────────────────────────────────────────────────────────
 *
 * · 只扫 `docs/*.md`（不含子目录；当前也没有）。根目录的 README/ARCHITECTURE 不在此列 ——
 *   它们不记录逐步搬运命令。若将来那里出现，把 ROOT 扩展即可。
 * · 不判断「带对父提交就算对」—— 本判据只禁 HEAD 这一种已知坏形状。
 *   父提交写错（写成某个中间提交）无法机械判定，那要靠 `--classify` 的输出对账。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const DOCS = join(REPO, 'docs')

/** 代码块围栏：``` 或 ~~~，允许带语言标注。 */
const FENCE = /^\s*(```|~~~)/u
/** 可执行行的开头：shell 提示符，或直接是 node / npm / pnpm。 */
const RUNNABLE = /^\s*(?:\$\s+)?(?:node|npm|pnpm)\b/u
/**
 * ── 表格里的门禁行也算 ────────────────────────────────────────────────────────────────────────
 *
 * `docs/retrieve-split-step2-3-plan.md` 的门禁表里曾有一行
 *
 *     | `verify-pure-move --against HEAD` | 消失 0 行；新增 = 注释 + 管线，逻辑必须 0 |
 *
 * 它不是代码块、也没有 `node` 前缀，所以旧判据看不见它。但它**和命令行一样危险**：
 * 读者把那一格抄进终端就是一个 VACUOUS 运行。**表格行是文档里的第二类指令。**
 *
 * 判据：以 `|` 开头的表格行，且同一行里出现 `verify-pure-move` 与该坏形状。
 */
const TABLE_ROW = /^\s*\|/u
const TABLE_CMD = /verify-pure-move/u
/** 我们禁的形状。 */
const BAD = /--against\s+HEAD\b/u

/**
 * ── 唯一的一份谓词 ──────────────────────────────────────────────────────────────────────────────
 *
 * 第一版有两个：`scan()`（读磁盘 + 自己判一遍）和 `scanText()`（can-red 用 + 再判一遍）。
 * 两份形状相同的正则、两套 if 链条 —— 改一处忘另一处，can-red 就会**验证一个不存在的判据**。
 *
 * 现在只有 `scanText`。`scan()` 只负责读文件与收集文件名，判断全部走 `scanText`。
 * 这是本仓反复写过的一句话：**一个判据只能有一份实现**（同 `families.mjs` 的 span、
 * 同 `move-gate` 的 declarations —— 各自都曾因为第二份实现而给出过错误答案）。
 */
const scanText = (text) => {
  const lines = text.split('\n')
  const out = []
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE.test(lines[i])) { inFence = !inFence; continue }
    if (!BAD.test(lines[i])) continue

    // 形态 A：代码块里的可执行行
    if (inFence && RUNNABLE.test(lines[i])) { out.push(i + 1); continue }
    // 形态 B：表格行里把它当命令引用（`verify-pure-move … --against HEAD`）
    if (!inFence && TABLE_ROW.test(lines[i]) && TABLE_CMD.test(lines[i])) { out.push(i + 1); continue }
  }
  return out
}

const scan = () => {
  const files = readdirSync(DOCS).filter((f) => f.endsWith('.md')).sort()
  const failures = []
  for (const file of files) {
    for (const line of scanText(readFileSync(join(DOCS, file), 'utf8'))) {
      failures.push(`${file}:L${line}`)
    }
  }
  return { failures, files }
}

test('v211 ①: docs/*.md 的代码块里不许有可执行的 `--against HEAD`', () => {
  const { failures, files } = scan()
  assert.ok(files.length >= 5,
    `docs/ 应至少有 5 个 .md（实际 ${files.length}）—— 分母太小说明扫描路径错了`)
  assert.deepEqual(failures, [],
    '这些行会把读者引向 VACUOUS 运行（--against HEAD 在搬运完成后是 exit 2）：\n  '
    + failures.join('\n  ')
    + '\n改成带父提交的形式：`--against <父提交的 sha> --classify`，并把树退到该步的提交。'
    + '\n（订正说明里用反引号提到这个字样是**允许**的，那是在记录错误，不是指令。）')
})

/**
 * ── can-red：判据必须能抓住正确形状，并且**不误伤**订正说明 ────────────────────────────────────
 *
 * 用 `scanText` 直接喂假数据 —— **与 `scan()` 用的是同一个函数**。
 * 「0 违规」只有在判据**能**报违规时才成立；而如果 can-red 自己另写一份判据，
 * 它验证的就是那份副本，不是门禁（本仓已经为此踩过 `families.mjs` 与 `move-gate` 两次）。
 *
 * 这里尤其重要：如果判据把「叙述里提到」也算违规，上面那条断言会永远红，
 * 下一个人就会去删订正说明来让它变绿 —— 那正好删掉了我们想保留的东西。
 */

test('v211 ② can-red: 代码块里的可执行行必须被抓到', () => {
  const bad = [
    '```bash',
    '$ node scripts/verify-pure-move.mjs --against HEAD',
    '```',
  ].join('\n')
  assert.deepEqual(scanText(bad), [2], '带 $ 提示符的可执行行必须红')

  const badNoPrompt = ['```', 'node scripts/verify-pure-move.mjs --against HEAD --classify', '```'].join('\n')
  assert.deepEqual(scanText(badNoPrompt), [2], '不带 $ 但以 node 开头的也必须红')

  const badNpm = ['```', 'npm run verify -- --against HEAD', '```'].join('\n')
  assert.deepEqual(scanText(badNpm), [2], 'npm 开头的也必须红')
})

/**
 * ── can-red ⑤：**表格行**里的门禁行也必须红（用户裁定⑤）──────────────────────────────────────
 *
 * `docs/retrieve-split-step2-3-plan.md:128` 那一行就是真实案例：
 *
 *     | `verify-pure-move --against HEAD` | 消失 0 行；… |
 *
 * 它不在代码块里，也没有 `node` 前缀。旧判据看不见它 —— 但它和命令行一样危险：
 * 读者把那一格抄进终端就是 VACUOUS。
 */
test('v211 ⑤ can-red: 计划文档表格里的门禁行必须红', () => {
  const fakePlan = [
    '# 某步的计划',
    '',
    '| 门禁 | 结果 |',
    '|---|---|',
    '| `verify-pure-move --against HEAD` | 消失 0 行；新增 = 注释 + 管线，**逻辑必须 0** |',
    '| `npm test` | 全绿 |',
  ].join('\n')
  assert.deepEqual(scanText(fakePlan), [5],
    '表格行里的 `verify-pure-move … --against HEAD` 必须红 —— 它是「第二类指令」')

  // 但表格里**别的**门禁行不许被误伤
  const goodPlan = [
    '| 门禁 | 结果 |',
    '|---|---|',
    '| `verify-pure-move --against 0381c6c --classify` | 逻辑 0 |',
    '| `npm test` | 全绿 |',
  ].join('\n')
  assert.deepEqual(scanText(goodPlan), [], '带父提交的表格行必须绿')
})

test('v211 ③ can-red: 订正说明里提到这个字样**不许**红（否则会逼人删掉错误史）', () => {
  const prose = [
    '> **订正**：这里原先写的是 `--against HEAD`，那有两个问题……',
    '',
    '所以正确的形式是带父提交。',
  ].join('\n')
  assert.deepEqual(scanText(prose), [], '叙述里的引用不是指令，不该红')

  // 代码块里但**不是**可执行行（是历史输出）——也不该红
  const historicalOutput = [
    '```',
    '$ node scripts/verify-pure-move.mjs --against HEAD',
    'ref   : 13034 内容行',
    '```',
  ].join('\n')
  // ↑ 这一个**是**可执行的，应该红；用它确认判据没有把「历史输出」整个放过
  assert.deepEqual(scanText(historicalOutput), [2],
    '即使它记录的是历史输出，那个命令行本身仍是可执行的坏形状 —— 读者会照抄')

  // 正确形式在代码块里 → 绿
  const good = ['```bash', 'node scripts/verify-pure-move.mjs --against 7b9d3f6 --classify', '```'].join('\n')
  assert.deepEqual(scanText(good), [], '带父提交的形式必须绿')
})

test('v211 ④: 围栏外的行内引用不算指令（但表格行算 —— 见 ⑤）', () => {
  const outside = [
    '你可以跑 `node scripts/verify-pure-move.mjs --against HEAD` 看看。',
  ].join('\n')
  assert.deepEqual(scanText(outside), [],
    '行内反引号的**叙述**不是指令，不判 —— 但表格行里的同样字样**是**指令，见 can-red ⑤')
})
