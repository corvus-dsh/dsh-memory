/**
 * ── v292 (B4-0b-2 五形态之四「记账先于事实」)：盖章必须在写盘的回答之后 ─────────────────────────
 *
 * 派工单的判据是「`state.X += 1` 出现在 `await execute` 之前 ⇒ 人工审 + 白名单」。那条字面判据在这个
 * 仓里有 279 处计数动作，绝大多数与 IO 无关（循环累加、字符串拼接、评分求和）—— 按它跑会得到一份
 * 待读清单，而待读清单的结局是不读。
 *
 * 所以实现的是它的**可判核心**，也是本批真正踩过的那一种形状，而它有唯一正确的写法：
 *
 *     写一条知识 → 报告写进去了多少条 → **只有写了才盖 harvestedAt 章**
 *
 * 判据：
 *   ① 本仓每个 `markHarvested(...)` 调用点都被一个判定门住（spawn 门禁，断言 exit 0）
 *   ② 分母：盖章点数、写盘点数都必须非零
 *   ③ 检测器能红 —— 三元门、`if … return` 门都必须被认；裸调用必须红
 *   ④ **注释不能代替判定** —— 这是本批第三次遇到同一件事，所以在这里钉一次
 *
 * 第 ④ 条是从一次真实的失败 can-red 里长出来的：把盖章移到三元上方之后，门禁**仍然绿**，因为紧邻
 * 上方那段注释里写着 `written + merged === 0`。**解释规则的散文，满足了规则本身。**
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GATE = join(ROOT, 'scripts', 'check-stamp-after-write.mjs')

test('v292 ①: 每个盖章调用点都在写盘的回答之后', () => {
  const result = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(
    result.status,
    0,
    `有盖章没被门住：\n${result.stdout}${result.stderr}\n` +
      '把「我试过」记成「做成了」，会让提醒停止，而那件事下一代会重做。',
  )
  assert.match(result.stdout, /stamp-after-write: OK/u)
})

test('v292 ②: 分母 —— 盖章点数与写盘点数都非零', () => {
  const result = spawnSync(process.execPath, [GATE, '--json'], { cwd: ROOT, encoding: 'utf8' })
  const report = JSON.parse(result.stdout)
  assert.ok(report.stampSites >= 2, `只找到 ${report.stampSites} 个盖章点，检查的分母异常`)
  assert.ok(report.writeSites >= 2, `只找到 ${report.writeSites} 个写盘点，检查的分母异常`)
  assert.ok(report.files >= 30, `只扫了 ${report.files} 个文件，扫描范围异常`)
  assert.deepEqual(report.findings, [])
})

test('v292 ③: 检测器能红 —— 裸盖章、写之前盖章都必须被报出', () => {
  return import(new URL('../scripts/check-stamp-after-write.mjs', import.meta.url).href).then((mod) => {
    /** A bare stamp with no decision anywhere near it. */
    const bare = ['export function f() {', '  const x = markHarvested(dir, ids)', '  return x', '}', ''].join('\n')
    assert.equal(mod.scanOrdering(bare).length, 1, `裸盖章必须被报出，实测 ${JSON.stringify(mod.scanOrdering(bare))}`)

    /** The ternary gate — the shape this repository actually uses. */
    const ternary = [
      'export function f() {',
      '  const r = writeKnowledge(dir, entries)',
      '  const recorded = r.written + r.merged',
      '  const h = recorded === 0 ? [] : markHarvested(dir, ids)',
      '  return h',
      '}',
      '',
    ].join('\n')
    assert.deepEqual(mod.scanOrdering(ternary), [], '三元门住的盖章必须通过')

    /** The `if … return` gate — the OTHER shape this repository uses. */
    const guard = [
      'export function f() {',
      '  const r = writeKnowledge(dir, entries)',
      '  const recorded = r.written + r.merged',
      '  if (recorded === 0) {',
      '    return { ok: false, ...r }',
      '  }',
      '  const h = markHarvested(dir, ids)',
      '  return { ok: true, h }',
      '}',
      '',
    ].join('\n')
    assert.deepEqual(mod.scanOrdering(guard), [], 'if + early return 门住的盖章必须通过')
  })
})

test('v292 ④: 注释里写着判定，不许让检查通过（本批第三次同族事故的回归）', () => {
  /**
   * ── THE MEASURED FAILURE THIS PINS ──────────────────────────────────────────────────────────
   *
   * The can-red moved the stamp above its ternary and the gate stayed GREEN. The reason was the block
   * comment immediately above:
   *
   *     * A refused entry does not count: `written + merged === 0` means the store learned nothing,
   *     * so stamping the node would silence the reminder without answering it.
   *
   * **The prose explaining the rule satisfied the check for the rule.** Same family as the comment in
   * `ci.yml` that made `check-check-parity` report 6/6 while two gates were missing.
   *
   * `scanOrdering` blanks comments before looking for a decision, and offsets are preserved (blanking
   * replaces each non-newline character with a space) so reported lines stay real.
   */
  return import(new URL('../scripts/check-stamp-after-write.mjs', import.meta.url).href).then((mod) => {
    const commentSatisfied = [
      'export function f() {',
      '  /**',
      '   * A refused entry does not count: `written + merged === 0` means the store learned nothing.',
      '   */',
      '  const h = markHarvested(dir, ids)',
      '  return h',
      '}',
      '',
    ].join('\n')
    const findings = mod.scanOrdering(commentSatisfied)
    assert.equal(
      findings.length,
      1,
      '注释里的判定让它通过了 —— 解释规则的散文不许满足规则本身',
    )
    /** And the reported line must be the STAMP's line, not the comment's. */
    assert.equal(
      findings[0].line,
      5,
      `行号必须指向盖章那一行（第 5 行），实测 ${findings[0].line} —— 指向注释就说明注释参与了判定`,
    )
  })
})