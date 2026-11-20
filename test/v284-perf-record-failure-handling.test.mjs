/**
 * ── v284 (B4-0b-2 W4-2d): A CRITERION MUST NOT BE BUILT ON A FAILED RUN ─────────────────────────
 *
 * Measured by the reviewer: one `perf-record` run used a `check (不含) code = 1` duration as the
 * threshold base. The verdict happened to stay `met:false`, but the PROCESS was invalid — a base that
 * claims 「this is what it costs」 must come from a run that finished.
 *
 * Three repairs, and this file pins all three by driving the REAL script against a throwaway repo:
 *
 *   ① a failed baseline ⇒ `computable:false` with the code named (never a threshold);
 *   ② a gate step that exited non-zero ⇒ printed as `EXITED n`, and EXCLUDED from the total (a failed
 *     gate is a failure, not overhead);
 *   ③ `check-readme-counts` is warmed before timing, and the record says `warm` (its cold cost is
 *     ~1000× larger, and the two must never be mixed).
 *
 * ── WHY THE FIXTURE IS A FAKE PACKAGE, NOT A MOCKED FUNCTION ──────────────────────────────────
 *
 * The defect was in how real subprocess RESULTS were read. Mocking `execFileSync` would test the mock.
 * So the script is copied into a skeleton with a `package.json` whose `check` is a stub that exits 1,
 * and the script's own JSON output is inspected.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(REPO, 'scripts', 'perf-record.mjs')

/** Nested `node --test` inherits the runner context and can silently do nothing; see v281 ⑤. */
function cleanTestEnv() {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID
  return env
}

/** A skeleton repository: the real script, a `check` stub, and a `test/` with one dummy file. */
function skeleton({ checkBody, checkExitCode = 0, gateBody }) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v284-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'test'), { recursive: true })
  cpSync(SCRIPT, join(root, 'scripts', 'perf-record.mjs'))
  writeFileSync(join(root, 'test', 'dummy.test.mjs'), "import test from 'node:test'\ntest('dummy', () => {})\n", 'utf8')
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'stub', version: '0.0.0',
    scripts: {
      check: 'node check-stub.mjs',
      'test:concurrency': 'node -e "0"',
    },
  }, null, 2), 'utf8')
  writeFileSync(
    join(root, 'check-stub.mjs'),
    `${checkBody}\nprocess.exitCode = ${checkExitCode}\n`,
    'utf8',
  )
  if (gateBody !== undefined) {
    for (const name of ['build', 'check-cycles', 'type-budget', 'check-readme-counts', 'check-frontmatter-reads']) {
      writeFileSync(join(root, 'scripts', `${name}.mjs`), gateBody, 'utf8')
    }
    writeFileSync(
      join(root, 'scripts', 'run-gate.mjs'),
      "process.exit(1)\n",
      'utf8',
    )
  }
  return root
}

function runRecord(root, args) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'perf-record.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
    env: cleanTestEnv(),
  })
  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

// ── ① a failed baseline refuses to produce a criterion ────────────────────────────────────

test('v284 ①: 基线失败 ⇒ criterion 拒绝计算，并点名是哪一次、什么 code', () => {
  /**
   * The `check` stub prints a REAL test failure (not a count witness), so this is the case the
   * reviewer measured. `--skip-exclusion` makes the run cheap: only one check is executed, and it
   * fails, so the criterion must refuse even before exclusion is considered.
   */
  const root = skeleton({
    checkBody: ["console.log('ℹ tests 7')", "console.log('ℹ pass 6')", "console.log('ℹ fail 1')", "console.log('✖ a real test broke')"].join('\n'),
    checkExitCode: 1,
  })
  try {
    const result = runRecord(root, ['--json', '--skip-exclusion'])
    const record = JSON.parse(result.out.slice(result.out.indexOf('{')))
    assert.equal(record.criterion.computable, false, '失败的基线绝不许产出阈值')
    assert.match(String(record.criterion.why), /baseline run failed/u, `必须说明是基线失败；actual: ${record.criterion.why}`)
    assert.ok(Array.isArray(record.criterion.blocked) && record.criterion.blocked.length > 0, '必须点名是哪一次运行')
    assert.equal(record.criterion.blocked[0].code, 1, '必须说出 exit code')
    assert.equal(record.criterion.thresholdMs, undefined, '不许留下一个看似可用的阈值')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ② a failed gate step is not summed ───────────────────────────────────────────────────

test('v284 ②: 失败的段不计入合计，且打印 EXITED n', () => {
  /**
   * `run-gate.mjs` exits 1 here, so `type-budget (via run-gate)` fails while the others succeed.
   * Its duration must NOT be folded into `totalMs` — a failed gate is a failure, not overhead.
   */
  const root = skeleton({
    checkBody: "console.log('ℹ fail 0')",
    checkExitCode: 0,
    gateBody: "console.log('ok')\n",
  })
  try {
    const result = runRecord(root, ['--json', '--skip-exclusion'])
    const record = JSON.parse(result.out.slice(result.out.indexOf('{')))
    const failed = record.gates.failed ?? []
    assert.ok(failed.some((step) => step.label.includes('type-budget')), `必须把失败段列出来；actual: ${JSON.stringify(failed)}`)
    assert.match(String(record.gates.totalOf), /^\d+\/6 step\(s\) exited 0$/u, `合计必须说明「几段里几段退出 0」；actual: ${record.gates.totalOf}`)

    /** THE ARITHMETIC THAT WAS WRONG: the failed step's ms must not be inside the total. */
    const typeBudget = record.gates.steps.find((step) => step.label.includes('type-budget'))
    assert.notEqual(typeBudget.code, 0, '前提：这一段必须真的失败')
    const sumOfOk = record.gates.steps.filter((step) => step.code === 0 && step.ms !== undefined).reduce((sum, step) => sum + step.ms, 0)
    assert.equal(record.gates.totalMs, sumOfOk, '合计必须只等于「退出 0 的段」之和')

    const markdown = runRecord(root, ['--skip-exclusion'])
    assert.match(markdown.out, /EXITED \d+/u, '失败段在表格里必须带 EXITED n，不能只显耗时')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ③ the observation state is stated ───────────────────────────────────────────────────

test('v284 ③: 记录必须写明观测缓存是 warm 还是 cold（两者相差约 1000 倍）', () => {
  const root = skeleton({ checkBody: "console.log('ℹ fail 0')", checkExitCode: 0 })
  try {
    const result = runRecord(root, ['--json', '--skip-exclusion'])
    const record = JSON.parse(result.out.slice(result.out.indexOf('{')))
    assert.match(String(record.gates.observation ?? ''), /warm|cold/u, '必须标明观测缓存状态')
    /**
     * The warm-up runs the real `check-readme-counts` in the skeleton. It does not exist there, so the
     * honest outcome is either `warm` (it ran) or `cold — warm-up failed: …`. What must never happen is
     * silence: an unlabelled 0.1 s and an unlabelled 111 s would be indistinguishable.
     */
    assert.ok(String(record.gates.observation).length > 4, '观测状态不许是空字符串')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ④ the count-witness allowance must be BEHAVIOUR, not a name in the source ───────────

test('v284 ④: 「移走文件导致计数不符」可被解释；同一次运行里有真失败就不行（行为，不是源码）', () => {
  /**
   * ── THE OLD VERSION OF THIS CASE WAS A LIE, AND IT WAS MY LIE (W4-2e) ────────────────────────
   *
   * It ran the skeleton with `--skip-exclusion` — which never produces an exclusion run at all — and
   * then asserted `assert.match(source, /failureIsExplainedByRemoval/)`, `/COUNT_WITNESS/`,
   * `/ℹ fail 0/`. The test's own comment admitted 「this case can only confirm that the predicate
   * EXISTS」. Consequence: changing the predicate to `return true` (accept ANY non-zero exclusion run
   * as explained) left all three strings in place ⇒ this case stayed GREEN.
   *
   * The repair is behavioural, and it needs the script to REALLY take the exclusion path. That means
   * the skeleton must contain a file whose name matches the `V208` constant, so `measureWithAndWithout`
   * parks it, runs `check` without it, and consults the predicate on a REAL failed run.
   *
   * Two variants, two runs:
   *
   *   A. witness + `ℹ fail 0`   ⇒ explained   ⇒ criterion is COMPUTABLE (a threshold exists)
   *   B. witness + `ℹ fail 1`   ⇒ NOT explained ⇒ criterion is REFUSED (`computable:false`)
   *
   * can-red: make the predicate `return true` ⇒ B stops refusing ⇒ B's assertion fails.
   */
  const V208_NAME = readFileSync(join(REPO, 'scripts', 'perf-record.mjs'), 'utf8')
  const parkedName = /const V208 = '([^']+)'/u.exec(V208_NAME)?.[1]
  assert.ok(parkedName !== undefined, '前提：脚本里必须有 V208 常量，否则骨架无法触发排除法')

  /**
   * ── THE STUB MUST SUCCEED WHEN THE FILE IS PRESENT AND FAIL WHEN IT IS PARKED ────────────────
   *
   * Variant A needs the criterion to be COMPUTABLE, which requires `check (含)` to exit 0: a passing
   * run is the base's numerator. Only the EXCLUSION run may fail, and only because of the count
   * witness. A stub that always exits 1 tests nothing about the allowance — it just refuses earlier,
   * at the `check (含)` gate. (Measured: that is exactly how the first attempt failed.)
   *
   * So the stub inspects the filesystem: if the parked test file is gone, the counts no longer match
   * and it reports the witness and exits 1; otherwise it exits 0 with a green summary.
   */
  const witnessCheck = (suiteFailLine) =>
    [
      "import { existsSync } from 'node:fs'",
      "import { join } from 'node:path'",
      `const parked = join(process.cwd(), 'test', ${JSON.stringify(parkedName)})`,
      'const missing = !existsSync(parked)',
      "console.log('ℹ tests 7')",
      "console.log('ℹ pass 7')",
      `console.log(missing ? ${JSON.stringify(suiteFailLine)} : 'ℹ fail 0')`,
      "if (!missing) process.exit(0)",
      /**
       * The witness is printed near the END, after the suite summary — deliberately, because that is
       * the layout that broke the old `slice(-1200)` tail: summary early, witness late.
       */
      "for (let i = 0; i < 400; i += 1) console.log('padding line to push the summary out of a 1200-char tail ' + i)",
      "console.log('  FAIL L106 README 声明测试数 689 / 689，实测 688')",
      'process.exit(1)',
    ].join('\n')

  const runSkeleton = (suiteFailLine) => {
    /**
     * `checkExitCode: 0` — the stub sets its OWN exit code from whether the parked file exists.
     * The skeleton's blanket `process.exitCode = N` would override that line, so it is left at 0.
     */
    const root = skeleton({ checkBody: witnessCheck(suiteFailLine), checkExitCode: 0 })
    try {
      /**
       * The parked file must be NAMED like V208 so the exclusion path triggers. It is not a real
       * test: the stub `check` decides what the run reports.
       */
      writeFileSync(join(root, 'test', parkedName), '// parked by the exclusion measurement\n', 'utf8')
      return runRecord(root, ['--json'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  // ── A: the only failure is our own accounting ⇒ the base is still usable
  const explained = runSkeleton('ℹ fail 0')
  const explainedRecord = JSON.parse(explained.out.slice(explained.out.indexOf('{')))
  assert.equal(
    explainedRecord.exclusionFailureExplained,
    true,
    `「只有计数见证 + 套件绿」必须被解释为测量自身造成的失败；actual: ${JSON.stringify(explainedRecord.criterion)}`,
  )
  assert.equal(
    explainedRecord.criterion.thresholdMs !== undefined,
    true,
    `被解释的排除法运行必须能建立阈值（否则判据永远算不出来）；actual: ${JSON.stringify(explainedRecord.criterion)}`,
  )
  /**
   * The record omits `computable` when the criterion IS computable — its presence is what marks a
   * refusal. Asserting on the field's absence would be asserting on JSON shape rather than behaviour,
   * so the positive evidence (`thresholdMs` exists and a verdict was reached) is what is checked.
   */
  assert.equal(explainedRecord.criterion.computable, undefined, '可计算时不该出现 computable:false 的标记')
  assert.equal(typeof explainedRecord.criterion.met, 'boolean', '必须给出结论')

  // ── B: the SAME run also has a real test failure ⇒ nothing may be explained
  const refused = runSkeleton('ℹ fail 1')
  const refusedRecord = JSON.parse(refused.out.slice(refused.out.indexOf('{')))
  assert.equal(
    refusedRecord.exclusionFailureExplained,
    false,
    '同一次运行里有真失败时，绝不许把整次运行说成「测量自己造成的」',
  )
  assert.equal(
    refusedRecord.criterion.computable,
    false,
    `有真失败时判据必须拒绝计算；actual: ${JSON.stringify(refusedRecord.criterion)}`,
  )
  assert.equal(refusedRecord.criterion.thresholdMs, undefined, '拒绝时不许留下看似可用的阈值')
})
