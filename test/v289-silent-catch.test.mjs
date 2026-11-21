/**
 * ── v289 (B4-0b-2 五形态之五「静默丢弃」)：空 catch 必须说得出理由，增量必须被拒 ─────────────────
 *
 * 「空 catch 算缺陷」这句话单独写出来，会逼出一种更糟的东西：为了让检查通过而补的注释。
 * 实测首跑：**134 个 catch 里 37 个**是「没有语句、只有一句短注释」——`/* ignore *\/`、
 * `// fall through`、`// exiting anyway`，也有真的不错但很短的 `// Never let the hint break the step.`
 *
 * 这 37 处各自在其语境里都站得住。把 37 处一次性改写成 40 字以上，只会得到 37 句凑字的话 ——
 * 那正是这个项目反复拒绝的形状。所以采用与 `check-frontmatter-reads` / `check-test-numbers` 相同的处置：
 * **存量按实测登记，增量拒绝。**
 *
 * ── 判据 ──────────────────────────────────────────────────────────────────────────────────────
 *
 *   ① 本仓没有**新增**的静默 catch（多重集比较，不是成员判断）
 *   ② 复制的注释也算新增 —— `/* ignore *\/` 从一处复制到另一处，计数从 1 变 2，必须红
 *   ③ 分母：扫描到的 catch 数、文件数、基线条数都必须非零且被打印（空扫描不许通过）
 *   ④ 检测器本身能红：把一段已知的静默 catch 喂给 `isSilentBody`，它必须说 silent
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'check-silent-catch.mjs')

test('v289 ①: 没有新增的静默 catch（存量已按实测登记）', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(
    result.status,
    0,
    `出现了新的静默 catch：\n${result.stdout}${result.stderr}\n` +
      '要么写清为什么可以静默（≥ 一句能被反驳的理由），要么处理它；改写存量会让基线自动收紧。',
  )
  assert.match(result.stdout, /silent-catch: OK/u)
})

test('v289 ②: 分母 —— 扫描到的 catch 数、文件数、基线条数都必须非零', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--json'], { cwd: ROOT, encoding: 'utf8' })
  const report = JSON.parse(result.stdout)

  assert.ok(report.files >= 30, `只扫到 ${report.files} 个 .ts 文件，扫描范围异常`)
  assert.ok(report.catchCount >= 100, `只扫到 ${report.catchCount} 个 catch，检查的分母异常`)
  assert.ok(report.findings.length >= 30, `只识别出 ${report.findings.length} 个静默 catch，检测器可能失效了`)
  assert.deepEqual(report.violations, [], '存量之外出现了新的静默 catch')
})

test('v289 ③: 检测器能红 —— 一段已知的静默 catch 必须被判为 silent', () => {
  /**
   * The detector is the load-bearing part; if it silently returned `false` for everything, ① and ②
   * would both pass on a repository full of empty catches. So it is driven directly with three
   * bodies whose answer is known by construction.
   */
  return import(new URL('../scripts/check-silent-catch.mjs', import.meta.url).href).then((mod) => {
    assert.equal(mod.isSilentBody('\n  ') /* nothing at all */.silent, true, '完全空的 catch 必须被判为静默')
    assert.equal(mod.isSilentBody('\n  /* ignore */\n').silent, true, '只有一句 ignore 的 catch 必须被判为静默')
    assert.equal(
      mod.isSilentBody('\n  // a torn line must not hide the rest of the queue.\n').silent,
      true,
      '只有注释、没有语句的 catch 属于「静默」——它的理由由基线决定是否已登记',
    )
    assert.equal(
      mod.isSilentBody('\n  logger.warn(String(error))\n').silent,
      false,
      '有语句的 catch 不是静默',
    )
  })
})

test('v289 ④: 复制一句已有的注释到新 catch ⇒ 计数增加 ⇒ 必须红（多重集，不是成员判断）', () => {
  /**
   * ── WHY THIS CASE EXISTS ────────────────────────────────────────────────────────────────────
   *
   * `check-frontmatter-reads` had exactly this hole (W5-2b → W5-2c): a baseline that asks 「这个文本在
   * 不在」 cannot see a duplicate, and copying an existing line is the MOST NATURAL way to add a new
   * one. `/* ignore *\/` is already in the baseline for two files, so 「copy that to my new catch」 is
   * one keystroke away.
   *
   * The gate compares COUNTS per file. This case proves the comparison is a count by driving the
   * module's own `scanFile` on a synthetic source with the same body twice, then checking the gate's
   * multiset logic would see 2 where the baseline allows 1.
   */
  return import(new URL('../scripts/check-silent-catch.mjs', import.meta.url).href).then((mod) => {
    /** `scanFile` is exported for this; the synthetic source has the same terse body twice. */
    const synthetic = [
      'export function first() {',
      '  try {',
      '    return read()',
      '  } catch {',
      '    /* ignore */',
      '  }',
      '}',
      'export function second() {',
      '  try {',
      '    return read()',
      '  } catch {',
      '    /* ignore */',
      '  }',
      '}',
      '',
    ].join('\n')

    const findings = mod.scanFile(synthetic)
    assert.equal(findings.length, 2, `两处静默 catch 必须都被识别，实测 ${findings.length}`)
    assert.equal(findings[0].body, findings[1].body, '两处必须带同一个 body —— 这才是「复制」的定义')

    /**
     * The multiset comparison, reproduced here so the assertion is about COUNT and not about
     * membership: same body, observed 2, permitted 1 ⇒ one violation.
     */
    const allowed = new Map([[findings[0].body, 1]])
    const seen = new Map()
    const violations = []
    for (const finding of findings) {
      const count = (seen.get(finding.body) ?? 0) + 1
      seen.set(finding.body, count)
      if (count > (allowed.get(finding.body) ?? 0)) violations.push(finding)
    }
    assert.equal(violations.length, 1, '同一 body 出现 2 次而基线允许 1 次，必须恰好报一条违规')
  })
})