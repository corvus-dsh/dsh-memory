/**
 * ── v288 (B4-0b-2 五形态之二「门禁不咬」)：本地门禁必须也是 CI 步骤 ─────────────────────────────
 *
 * `package.json` 的 `check` 与 `ci.yml` 是**两份各自维护的清单**，而这个仓已经为它们的漂移付过两次账
 * （`check-readme-counts` 与 `check-docs` 都曾经「存在于 scripts/、从没在 push 上跑过」）。
 *
 * 写 `scripts/check-check-parity.mjs` 的时候，它当场抓出**三处**真缺陷：
 *
 *   memory   · `check-cycles.mjs`            本地跑、CI 从未
 *   memory   · `check-frontmatter-reads.mjs`  本地跑、CI 从未（**正是本批 W5-2 刚修完的那个缺陷的门禁**）
 *   observer · `preflight.mjs`                本地跑、CI 从未
 *
 * 第二处尤其值得写下来：W5-2 修掉了三份「门禁看不见的 `\s*` 拷贝」，而防止第四份的守卫**自己没接线**。
 * 一个不跑的守卫，等于一个带保质期的修复。
 *
 * ── 判据 ──────────────────────────────────────────────────────────────────────────────────────
 *
 *   ① 当前仓库：`check` 的每个门禁步骤都在 ci.yml 里（构建步骤按名字豁免，见脚本注释）
 *   ② 反向：ci.yml 提到的脚本都在磁盘上（改名后 CI 还在调用它）
 *   ③ 豁免表只许有两个构建步骤 —— 第三个需要它自己的理由
 *   ④ **注释不能代替执行**：构造一份只在注释里写 `npm run check` 的 ci.yml，必须报告缺失
 *      （这是本批第二次遇到「注释满足了门禁」：写这个脚本时，memory 一度报 OK，因为 ci.yml 的
 *      注释里有一句 `npm run check`，展开后整条 check 链都被算作「已在 CI 跑」）
 *
 * 第 ④ 条是本文件的重点，而且它是**从真实事故里长出来的**，不是想象的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'check-check-parity.mjs')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const ciText = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

test('v288 ①: 本仓 `check` 的每个门禁步骤都是 ci.yml 的一个步骤', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(
    result.status,
    0,
    `check 与 ci.yml 漂移了：\n${result.stdout}${result.stderr}\n` +
      '这条判据的意义是：一个只在本地跑的门禁，在 push 上等于不存在。',
  )
  assert.match(result.stdout, /check-parity: OK/u)
})

test('v288 ②: 检查自己的分母 —— `check` 里确实有门禁步骤，且 ci.yml 确实被读到', () => {
  /**
   * A gate that scans an empty list reports no problems. Both halves of the input are therefore
   * asserted to be non-trivial before the verdict is trusted.
   */
  const gateSteps = [...String(pkg?.scripts?.check ?? '').matchAll(/node\s+scripts\/([\w.-]+\.mjs)/gu)].map(
    (match) => match[1],
  )
  assert.ok(gateSteps.length >= 4, `\`check\` 里只找到 ${gateSteps.length} 个门禁步骤，检查的分母异常`)
  assert.ok(ciText.includes('node scripts/') || ciText.includes('npm run '), 'ci.yml 里没有任何可执行步骤，分母异常')
  assert.ok(readdirSync(join(ROOT, 'scripts')).includes('check-check-parity.mjs'), '被检查的脚本自己必须存在')
})

test('v288 ③: 「注释里写 npm run check」不许让检查通过（真事故的回归）', () => {
  /**
   * ── THIS IS NOT A HYPOTHETICAL ──────────────────────────────────────────────────────────────
   *
   * While writing `check-check-parity.mjs`, it reported `6/6 OK` for this repository — while
   * `check-cycles` and `check-frontmatter-reads` were both absent from ci.yml. The cause: the gate
   * expanded `npm run <script>` through package.json, and ci.yml contains, INSIDE A COMMENT,
   *
   *     # child process, so `npm run check` runs the suite twice
   *
   * That one comment expanded to the entire `check` chain, so every step counted as present.
   * **A comment satisfied the gate.**
   *
   * The fix strips `#` lines before any matching. This case pins it: a synthetic workflow whose ONLY
   * mention of the gate is a comment must be reported as MISSING.
   */
  const synthetic = [
    'name: synthetic',
    'on: [push]',
    'jobs:',
    '  ci:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      # nothing below actually runs; this comment mentions npm run check on purpose',
    '      - name: noop',
    '        run: echo "no gates here"',
    '',
  ].join('\n')

  const result = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' })

  /**
   * The synthetic file is compared by feeding it through the gate's own parser rather than by
   * overwriting the repository's ci.yml (a test that edits the tree under test cannot be re-run
   * safely). The parser is imported so this case and the real verdict share one implementation.
   */
  const moduleUrl = new URL('../scripts/check-check-parity.mjs', import.meta.url).href
  return import(moduleUrl).then((mod) => {
    const mentions = mod.mentionedInCi(synthetic, pkg?.scripts)
    assert.equal(
      mentions.has('check-cycles.mjs'),
      false,
      '注释里的 `npm run check` 展开出了真实门禁步骤 —— 这正是那次假绿的原因',
    )
    /**
     * And the whole point: with only comments, the gate must NOT be able to claim the chain ran.
     * The real workflow does mention the steps, so the real verdict is 0; the synthetic one cannot be.
     */
    assert.equal(mentions.size, 0, `只含注释的 ci.yml 不应解析出任何脚本，实测 ${[...mentions].join(', ')}`)
    void result
  })
})

test('v288 ④: 反向 —— ci.yml 提到的脚本都在磁盘上（改名后 CI 还在调用它）', () => {
  const onDisk = new Set(readdirSync(join(ROOT, 'scripts')))
  const mentioned = new Set([...ciText.matchAll(/scripts\/([\w.-]+\.mjs)/gu)].map((match) => match[1]))
  assert.ok(mentioned.size >= 3, `ci.yml 只提到 ${mentioned.size} 个脚本，分母异常`)
  const orphans = [...mentioned].filter((name) => !onDisk.has(name))
  assert.deepEqual(orphans, [], `ci.yml 调用了这些不存在的脚本（改名后没同步）：${orphans.join(', ')}`)
})