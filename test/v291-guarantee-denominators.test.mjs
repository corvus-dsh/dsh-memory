/**
 * ── v291 (B4-0b-2 五形态之三「保证语不实」)：门禁的成功语必须带分母 ───────────────────────────────
 *
 * 派工单的判据是「每条门禁打印的保证语必须在它为真的所有状态下有测试」。那句「所有状态」静态判不了，
 * 但它**真正要防的那件事**可判，而且是本批反复出现的：
 *
 *   「全绿」这句话可以在三种完全不同的情况下打印出来 ——
 *
 *     ① 扫了 272 个名字，没有重名      ← 它想说的那种
 *     ② 扫了 0 个名字，没有重名        ← 什么都没扫
 *     ③ 扫错了地方，没有重名           ← §〇 17
 *
 *   **三次输出逐字相同。** 唯一能把它们分开的是分母。
 *
 * ── 判据 ──────────────────────────────────────────────────────────────────────────────────────
 *
 *   ① 本仓没有「扫过类」的成功语缺分母（spawn 门禁，断言 exit 0）
 *   ② 分母：被检查的语句数、脚本数都必须非零（空扫描不许通过）
 *   ③ 检测器能红：一段已知缺分母的语句，`findBareGuarantees` 必须报出来
 *   ④ 检测器不误报：三种合法的分母形态（字面数字 / `.length` / 插值计数）都必须被接受
 *
 * 第 ④ 条是从一次**误报**里长出来的：第一版只认字面数字，于是本仓四条**正确带分母**的语句
 * （`${gateSteps.length}`、`${byName.size}`、`${guaranteeCount}`、`${SHARED_NUMBER_BASELINE.size}`）
 * 全被报成缺分母 —— 对正确实现的假红，与对错误实现的假绿是同一枚硬币。所以 ④ 与 ③ 配对存在。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GATE = join(ROOT, 'scripts', 'check-guarantee-denominators.mjs')

test('v291 ①: 每条「扫过类」的成功语都带分母', () => {
  const result = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(
    result.status,
    0,
    `有成功语没带分母：\n${result.stdout}${result.stderr}\n` +
      '「全绿」在 扫了 N 个 / 扫了 0 个 / 扫错了地方 三种情况下形状相同，分母是唯一能把它们分开的东西。',
  )
  assert.match(result.stdout, /guarantee-denominators: OK/u)
})

test('v291 ②: 分母 —— 被检查的语句数与脚本数都非零', () => {
  const result = spawnSync(process.execPath, [GATE, '--json'], { cwd: ROOT, encoding: 'utf8' })
  const report = JSON.parse(result.stdout)
  assert.ok(report.scripts >= 20, `只检查了 ${report.scripts} 个脚本，扫描范围异常`)
  assert.ok(report.guaranteeCount >= 10, `只找到 ${report.guaranteeCount} 条成功语，检查的分母异常`)
  assert.deepEqual(report.findings, [], '出现了缺分母的成功语')
})

test('v291 ③: 检测器能红 —— 已知缺分母的语句必须被报出来', () => {
  return import(new URL('../scripts/check-guarantee-denominators.mjs', import.meta.url).href).then((mod) => {
    const bare = 'console.log(`duplicate-export-names: OK — every exported name is defined once`)\n'
    const findings = mod.findBareGuarantees(bare, new Map())
    assert.equal(findings.length, 1, `缺分母的成功语必须被报出，实测 ${findings.length} 条`)
    assert.match(findings[0].statement, /OK —/u)
  })
})

test('v291 ④: 检测器不误报 —— 三种合法的分母形态都必须被接受', () => {
  /**
   * ── THIS CASE EXISTS BECAUSE THE GATE CAUGHT ITS OWN FALSE RED ─────────────────────────────
   *
   * The first version accepted only a literal digit, so it reported bare four verdicts that DO carry
   * their denominator as a `.length` / `.size` / count interpolation. A gate that cries wolf on
   * correct code is the same defect as one that passes broken code — the dimension cannot tell them
   * apart — and it is worse in practice, because it gets switched off.
   */
  return import(new URL('../scripts/check-guarantee-denominators.mjs', import.meta.url).href).then((mod) => {
    const cases = [
      ['literal digit', 'console.log(`x: OK — 37 blocked(s) recorded`)\n'],
      ['a .length read', 'console.log(`x: OK — all ${gateSteps.length} gate step(s) are wired`)\n'],
      ['a .size read', 'console.log(`x: OK — ${byName.size} exported name(s), each defined once`)\n'],
      ['an interpolated count', 'console.log(`x: OK — ${guaranteeCount} success sentence(s) across the tree`)\n'],
    ]
    for (const [label, source] of cases) {
      const findings = mod.findBareGuarantees(source, new Map())
      assert.equal(findings.length, 0, `${label} 被误报为缺分母：${JSON.stringify(findings)}`)
    }
  })
})

test('v291 ⑤: 只查「扫过类」语句 —— 单例判词与动作完成语不需要分母', () => {
  /**
   * `PASS <name>` is one case, and the loop that prints it is the denominator. `built 46 module(s)`
   * is 「做成了」, not 「扫过了」. Requiring a number there is noise, and noise is how a real check
   * gets switched off.
   */
  return import(new URL('../scripts/check-guarantee-denominators.mjs', import.meta.url).href).then((mod) => {
    const perCase = "console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)\n"
    assert.equal(mod.findBareGuarantees(perCase, new Map()).length, 0, '单例判词不应要求分母')
  })
})