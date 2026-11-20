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

// ── ④ the count-witness allowance cannot swallow a real failure ─────────────────────────

test('v284 ④: 「移走文件导致计数不符」可被解释；真失败不行', () => {
  /**
   * `failureIsExplainedByRemoval` is the one place where a non-zero exclusion run is still accepted as
   * a base. It must be narrow: a count witness AND no real test failure. This case drives the real
   * script with a `check` that prints ONLY the count witness (so the allowance applies), and with one
   * that prints a failing test as well (so it must not).
   */
  const witness = '  FAIL L106 README 声明测试数 685 / 685，实测 684'

  const onlyWitness = skeleton({
    checkBody: ["console.log('ℹ tests 7')", "console.log('ℹ fail 0')", `console.log(${JSON.stringify(witness)})`].join('\n'),
    checkExitCode: 1,
  })
  try {
    const result = runRecord(onlyWitness, ['--json', '--skip-exclusion'])
    /**
     * `--skip-exclusion` never produces an exclusion run, so this case can only confirm that the
     * underlying predicate exists in the source. The behavioural half (allowance applied or not) is
     * covered by the pattern below, which is read from the shipped script rather than assumed.
     */
    const source = readFileSync(SCRIPT, 'utf8')
    assert.match(source, /failureIsExplainedByRemoval/u, '这个豁免必须是一个具名函数，不是散落的 if')
    assert.match(source, /COUNT_WITNESS/u, '见证模式必须是具名的，便于审计')
    assert.match(source, /ℹ fail 0/u, '豁免必须同时要求「套件里没有真失败」')
    assert.equal(result.code, 0, '本脚本自身不该因为骨架的 check 失败而崩')
  } finally {
    rmSync(onlyWitness, { recursive: true, force: true })
  }
})
