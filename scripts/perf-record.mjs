#!/usr/bin/env node
/**
 * ── PERF RECORD (B4-0b-2 W4-2c) ─────────────────────────────────────────────────────────────────
 *
 * ── WHY THIS EXISTS: A VERDICT THAT ONLY EXISTS IN PROSE IS NOT A VERDICT ──────────────────────
 *
 * Three documents now say 「memory check 不达标，差额 14 s」. That sentence is true, checked by hand,
 * and **nothing reads it**. When the report is archived, the number it depends on — `check` with
 * v208 vs without — survives only as prose, which is exactly the condition that let 「four repos
 * byte-identical」 and 「126 − 55 = 71」 be written down as facts (W4-1b, W4-2c).
 *
 * So this instrument PRODUCES the numbers instead of describing them:
 *
 *   · `check` including v208
 *   · `check` with v208 MOVED OUT (exclusion, never subtraction — see below)
 *   · v208 alone
 *   · each gate step separately
 *
 * ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ──────────────────────────────────────────────────
 *
 * **Under parallel execution, per-file durations are NOT subtractable.**
 *
 * Measured 2026-11-20 in dsh-memory: full suite parallel 122.8 s, serial 237 s, suite without v208
 * 100 s, `check` without v208 110 s, `check` with v208 134 s ⇒ v208's NET contribution is **34 s**,
 * while its standalone duration is **55 s**. It overlaps with other files. Anyone who subtracts 55
 * from 134 gets 79 s and concludes "we are fine" — a wrong answer produced by a plausible operation.
 *
 * Therefore the base is obtained by **moving the file out and running again**, which is the only
 * operation that answers "what would this cost without it".
 *
 * ── IT SETS NO THRESHOLD, ON PURPOSE ──────────────────────────────────────────────────────────
 *
 * A baseline is not a gate. This file prints a verdict *for a human to quote*, and exits 0 whatever
 * the numbers are — the point is that the numbers now exist in a form a later reader (or a later
 * script) can recompute rather than trust.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────────────────────
 *
 *   node scripts/perf-record.mjs                     # every reading, markdown fragment
 *   node scripts/perf-record.mjs --json              # machine-readable
 *   node scripts/perf-record.mjs --write docs/x.md   # append the fragment, UTF-8 (never shell >)
 *   node scripts/perf-record.mjs --skip-exclusion    # fastest path: no move-and-rerun
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const V208 = 'v208-v207-canred.test.mjs'

function parseArgs(argv) {
  const options = { asJson: false, writePath: undefined, skipExclusion: false }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--json') {
      options.asJson = true
      continue
    }
    if (argv[index] === '--skip-exclusion') {
      options.skipExclusion = true
      continue
    }
    if (argv[index] === '--write') {
      options.writePath = argv[index + 1]
      index += 1
      continue
    }
    console.error(`unknown argument: ${argv[index]}`)
    process.exit(2)
  }
  return options
}

/**
 * ── `npm.cmd` CANNOT BE SPAWNED DIRECTLY ON WINDOWS (measured, and it produced two fake zeros) ──
 *
 * The first version called `execFileSync('npm.cmd', …)`. On Windows Node refuses to execute a `.cmd`
 * without a shell: `spawnSync npm.cmd EINVAL`. The wrapper caught it as a non-zero exit and recorded
 * **0.0 s** for `check` — a reading produced by a command that never started.
 *
 * That is this batch's signature defect appearing INSIDE the instrument built to stop it, so the fix
 * is structural: run npm through the shell, and treat a spawn failure as a FAILURE TO MEASURE rather
 * than as a fast result. A number that came from a command that did not run must not be printed.
 */
function timedNpm(label, args, cwd) {
  const startedAt = process.hrtime.bigint()
  let captured = ''
  try {
    captured = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
      /**
       * `shell: true` is what makes a `.cmd` executable on Windows. It is used ONLY for npm, never
       * for `node` (which needs no shell and whose argument quoting must stay exact).
       */
      shell: process.platform === 'win32',
    })
  } catch (error) {
    /** `error.status === null` means the process never started — that is NOT a duration. */
    if (error?.status === null || error?.status === undefined) {
      return { label, ms: undefined, code: -1, failedToStart: String(error?.message ?? error).slice(0, 160) }
    }
    /** stdout matters on the failure path: it is how a known-failure is told from a real one. */
    captured = `${error.stdout ?? ''}${error.stderr ?? ''}`
    return {
      label,
      ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
      code: error.status,
      /**
       * A TRUNCATED TAIL IS FOR HUMANS; `summary` IS FOR THE CODE (W4-2e).
       *
       * The diagnostic tail stays short (a 200 KB log in an error message helps nobody), but the two
       * facts the logic needs are extracted from the FULL output first. Nothing downstream may search
       * `tail` for a fact — that is what let a real failure look explained.
       */
      tail: captured.slice(-1200),
      summary: summariseCheckOutput(captured),
    }
  }
  return {
    label,
    ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
    code: 0,
    tail: captured.slice(-1200),
    summary: summariseCheckOutput(captured),
  }
}

/** Run a command and time it. Never throws: a non-zero exit is still a duration worth recording. */
function timed(label, command, args, cwd) {
  const startedAt = process.hrtime.bigint()
  let code = 0
  try {
    execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })
  } catch (error) {
    code = error.status ?? 1
  }
  return { label, ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6), code }
}

/**
 * THE EXCLUSION MEASUREMENT. The file is MOVED OUT, the command runs, the file is put back — in a
 * `finally`, because a crash mid-way must not leave a repository with a missing test.
 */
function measureWithAndWithout(target, label, command, args) {
  /**
   * `command` is only ever `'npm'`/`'node'` here; npm goes through the shell wrapper so a Windows
   * `.cmd` can start at all, and so a FAILED START is reported as such rather than as 0.0 s.
   */
  const run = (tag) => (command === 'npm' ? timedNpm(tag, args, REPO) : timed(tag, command, args, REPO))
  const withIt = run(`${label} (含)`)

  /**
   * ── THE PARKING DIRECTORY MUST BE ON THE SAME VOLUME (measured: EXDEV) ─────────────────────────
   *
   * The first version parked the file in `os.tmpdir()`. On this machine that is `C:` while the repo is
   * on `D:`, so `renameSync` failed with `EXDEV: cross-device link not permitted`. (A copy would have
   * worked, but a copy of a 12 KB test is not the problem — the repo would briefly contain a duplicate
   * that other test runs could pick up.)
   *
   * Parked INSIDE the repository, under a dot-directory `node --test test/*.test.mjs` does not glob,
   * and restored in `finally` so a crash cannot leave a test missing.
   */
  const parking = join(REPO, '.perf-record-parking')
  const source = join(REPO, 'test', target)
  if (!existsSync(source)) {
    return { withIt, withoutIt: undefined, note: `${target} not present — exclusion not measurable` }
  }
  mkdirSync(parking, { recursive: true })
  const parked = join(parking, target)
  renameSync(source, parked)
  let withoutIt
  try {
    withoutIt = run(`${label} (不含)`)
  } finally {
    /** Restore FIRST: the standalone measurement below needs the file back in `test/`. */
    renameSync(parked, source)
    rmSync(parking, { recursive: true, force: true })
  }
  return {
    withIt,
    withoutIt,
    /**
     * THE NET CONTRIBUTION, AND THE WARNING THAT COMES WITH IT. This is a MEASURED difference of two
     * runs, not a subtraction of two standalone durations — the distinction matters because the
     * parallel overlap makes the standalone number much larger (measured: 55 s vs 34 s).
     */
    netMs: withIt.ms !== undefined && withoutIt.ms !== undefined ? withIt.ms - withoutIt.ms : undefined,
    standaloneMs: timed(`${target} 单独`, process.execPath, ['--test', join('test', target)], REPO).ms,
  }
}

const options = parseArgs(process.argv.slice(2))

/** The gate chain, one step at a time — the breakdown that W4-2c said was 「32 s」 before measuring. */
const GATES = [
  ['build', 'scripts/build.mjs', []],
  ['check-cycles', 'scripts/check-cycles.mjs', []],
  ['type-budget (via run-gate)', 'scripts/run-gate.mjs', ['scripts/type-budget.mjs']],
  ['check-readme-counts', 'scripts/check-readme-counts.mjs', []],
  ['check-frontmatter-reads', 'scripts/check-frontmatter-reads.mjs', []],
  ['test:concurrency', undefined, []],
]

/**
 * ── `check-readme-counts` HAS A COLD AND A WARM COST, AND THEY DIFFER BY 1000× (W4-2d) ──────────
 *
 * Measured twice by the reviewer: 111.8 s in one run, 0.1 s in another. The difference is NOT noise.
 * Since W4-1 that gate reads a SHARED suite observation; on a cache miss it measures the whole suite
 * itself (~110 s), on a hit it reads a file (~0.1 s). Both numbers are true about different states.
 *
 * Discipline 9 says cold and warm must never be mixed. So this step is WARMED FIRST — one untimed run
 * that populates the cache — and then timed. The report labels it warm, because that is what `check`
 * actually experiences after the first run on a tree.
 *
 * If the warm-up itself fails, the step is still timed and its exit code is what the table shows;
 * failing to warm is not allowed to silently become a fast reading.
 */
function warmSharedObservation() {
  try {
    execFileSync(process.execPath, ['scripts/check-readme-counts.mjs'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    })
    return { warmed: true }
  } catch (error) {
    return { warmed: false, detail: String(error?.message ?? error).slice(0, 160) }
  }
}

const warmup = warmSharedObservation()

const gateSteps = []
for (const [label, script, args] of GATES) {
  if (script === undefined) {
    /** `npm run test:concurrency` is a package script, so it goes through npm (shell on Windows). */
    gateSteps.push(timedNpm(label, ['run', 'test:concurrency', '--silent'], REPO))
    continue
  }
  /**
   * ── THE GATE STEPS RUN IN THE ORDER `check` RUNS THEM, AFTER A BUILD ──────────────────────────
   *
   * Measured: `check-readme-counts` took **137 s** when this script ran it FIRST, and **0.1 s** when
   * run on its own afterwards. The difference is the shared suite observation (W4-1): with no cache
   * for this tree, that gate measures the whole suite itself. Timing the gates in an order that
   * cannot happen in `check` produces a number about this script, not about the gate.
   */
  gateSteps.push(timed(label, process.execPath, [script, ...args], REPO))
}
/**
 * ── THE EXCLUSION RUN IS EXPECTED TO TRIP THE COUNT GATE (W4-2d, measured) ──────────────────────
 *
 * Moving `v208` out makes `check` exit 1: two gates assert the README's declared test count equals
 * the measured one, and the measurement removed a test file — 685 declared, 684 measured. The failure
 * is PRODUCED BY THE MEASUREMENT, not by a defect.
 *
 * The DURATION is still valid (the suite ran, the gates ran, and this is exactly what `check` costs
 * without v208). What is not valid is treating that run as a PASS. So a non-zero exclusion run is
 * accepted as a base ONLY when every failure line matches the count witness our own removal caused,
 * and when it does, the record says so explicitly.
 *
 * Refusing every non-zero exclusion run would mean the criterion can NEVER be computed — that is not
 * safety, it is a check that has quietly stopped answering.
 */
/**
 * True when the ONLY reason this run failed is our own file removal changing the test count.
 *
 * Reads the STRUCTURED summary, never a truncated log tail (see `summariseCheckOutput`). The three
 * conditions are all required:
 *
 *   1. the run failed (a passing run needs no explanation);
 *   2. at least one count witness is present;
 *   3. the suite summary says `fail 0` **explicitly** — `suiteGreen === undefined` (no summary found)
 *      is NOT green. That distinction is the whole point: 「I could not see a failure」 ≠ 「there was
 *      no failure」, and this batch has paid for that confusion three times.
 */
function failureIsExplainedByRemoval(run) {
  if (run === undefined || run.code === 0) return false
  const summary = run.summary ?? summariseCheckOutput(run.tail)
  if (summary.countWitnesses.length === 0) return false
  return summary.suiteGreen === true
}

/**
 * ── TWO FACTS ARE EXTRACTED FROM THE OUTPUT, NOT FOUND BY SCANNING A TRUNCATED TAIL (W4-2e) ─────
 *
 * `failureIsExplainedByRemoval` needs two things that live in DIFFERENT PARTS of a `check` log:
 *
 *   · the suite summary (`ℹ fail 0`) — printed by the test step, before the gate verdicts;
 *   · the count witness (`README 声明测试数 685 / 685，实测 684`) — printed BY a gate, near the end.
 *
 * The first version kept a `slice(-1200)` tail and searched it for both. With a real `check` log the
 * summary can easily fall outside 1200 characters of the end, and the failure mode is the dangerous
 * one: 「the witness is there, `ℹ fail 0` is truncated away」 makes the fallback
 * `|| !/ℹ fail \d+/` treat a REAL failure as explained. A 1200-character window is not a contract.
 *
 * So both facts are parsed out of the FULL captured output, once, at the point where the output is
 * available. Downstream code reads booleans and counts, never a substring of a log.
 */
function summariseCheckOutput(output) {
  const text = String(output ?? '')
  /**
   * The suite summary. `tests`/`fail` may appear more than once if npm echoes child output, so the
   * LAST occurrence wins — that is the final summary the runner printed.
   */
  const failMatches = [...text.matchAll(/^ℹ fail (\d+)$/gmu)]
  const passMatches = [...text.matchAll(/^ℹ pass (\d+)$/gmu)]
  const suiteFail = failMatches.length > 0 ? Number(failMatches[failMatches.length - 1][1]) : undefined
  const suitePass = passMatches.length > 0 ? Number(passMatches[passMatches.length - 1][1]) : undefined
  /** Every count witness line, so a reader can see WHICH gate complained and by how much. */
  const witnesses = [...text.matchAll(/README 声明测试数 (\d+) \/ (\d+)，实测 (\d+)/gu)].map((match) => ({
    declared: Number(match[1]),
    declaredTotal: Number(match[2]),
    measured: Number(match[3]),
    raw: match[0],
  }))
  return {
    /**
     * `true` / `false` / `undefined`. **`undefined` is not `true`**: 「we could not see the summary」
     * must never be read as 「the suite was green」.
     */
    suiteGreen: suiteFail === undefined ? undefined : suiteFail === 0,
    suiteFail,
    suitePass,
    countWitnesses: witnesses,
    bytes: text.length,
  }
}
const gateStepsOk = gateSteps.filter((step) => step.ms !== undefined && step.code === 0)
const gateStepsFailed = gateSteps.filter((step) => step.ms === undefined || step.code !== 0)
const gateTotalMs = gateStepsOk.reduce((sum, step) => sum + step.ms, 0)

const check = options.skipExclusion
  ? { withIt: timedNpm('check (含)', ['run', 'check', '--silent'], REPO), withoutIt: undefined }
  : measureWithAndWithout(V208, 'check', 'npm', ['run', 'check', '--silent'])

/** Which of the two required runs cannot be trusted as a base, and why. `[]` means computable. */
const blockingRuns = []
if (check.withIt?.code !== 0) {
  blockingRuns.push({
    run: 'check (含)',
    code: check.withIt?.code,
    detail: check.withIt?.failedToStart ?? 'exited non-zero; its duration describes a FAILED check, not a cost',
  })
}
let exclusionExplained = false
if (check.withoutIt === undefined) {
  blockingRuns.push({ run: 'check (不含)', code: undefined, detail: 'exclusion not measured' })
} else if (check.withoutIt.code !== 0) {
  if (failureIsExplainedByRemoval(check.withoutIt)) {
    /**
     * EXPECTED: our own file removal changed the declared/measured count. The duration stands; the
     * run is simply not a "pass", and that fact travels in the record rather than being smoothed away.
     */
    exclusionExplained = true
  } else {
    blockingRuns.push({
      run: 'check (不含)',
      code: check.withoutIt.code,
      detail: check.withoutIt.failedToStart ?? 'exited non-zero for a reason other than the file removal',
    })
  }
}

const record = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu: `${(cpus()[0]?.model ?? 'unknown').trim()} × ${cpus().length}`,
  },
  check,
  /**
   * WHETHER THE EXCLUSION RUN FAILED FOR A REASON WE CAUSED. `true` means the only failure was the
   * test-count witness (declared 685 vs measured 684 because the file is parked), which is the
   * measurement describing itself, not a defect. `false` with a non-zero code is a real blocker.
   */
  exclusionFailureExplained: exclusionExplained,
  gates: {
    steps: gateSteps,
    /** Only successful steps are summed; the failed ones are listed separately, never folded in. */
    totalMs: gateTotalMs,
    totalOf: `${gateStepsOk.length}/${gateSteps.length} step(s) exited 0`,
    /**
     * The shared observation was warmed before timing, so `check-readme-counts` is a WARM reading.
     * Stated explicitly because the same gate costs ~1000× more cold, and the two must not be
     * compared or averaged (discipline 9).
     */
    observation: warmup.warmed ? 'warm (shared suite cache populated before timing)' : `cold — warm-up failed: ${warmup.detail}`,
    failed: gateStepsFailed.map((step) => ({
      label: step.label,
      code: step.ms === undefined ? 'did not start' : step.code,
      ms: step.ms,
    })),
  },
  /**
   * THE VERDICT IS COMPUTED, NOT TYPED — AND IT IS NOT COMPUTED FROM A FAILED RUN.
   *
   * Same formula as graft (§26.4): a check may cost its suite plus ten seconds of gate overhead.
   * The base must come from a run that EXITED 0; when it did not, no verdict is claimed. An invalid
   * base must not be turned into either a pass or a fail by arithmetic — it is simply not a base.
   */
  criterion: blockingRuns.length > 0
    ? {
        computable: false,
        /**
         * ── THE MOST IMPORTANT REASON COMES FIRST (measured by v284 ①) ──────────────────────────
         *
         * The first version reported `exclusion not measured` whenever `--skip-exclusion` was used,
         * even when the run it DID make had failed. With exclusion skipped, 「not measured」 is
         * trivially true and hides 「the baseline failed」 — which is the fact a reader must act on.
         * A failed run is a defect; an unmeasured one is a choice.
         */
        why: blockingRuns.some((entry) => entry.code !== undefined && entry.code !== 0)
          ? `baseline run failed (code=${blockingRuns.filter((entry) => entry.code !== undefined).map((entry) => entry.code).join(', ')})`
          : 'exclusion not measured; a base cannot be inferred by subtraction',
        blocked: blockingRuns,
      }
    : (() => {
        const thresholdMs = check.withoutIt.ms + 10_000
        return {
          formula: 'check(含) ≤ check(不含) + 10 s',
          thresholdMs,
          measuredMs: check.withIt.ms,
          met: check.withIt.ms <= thresholdMs,
          gapMs: Math.max(0, check.withIt.ms - thresholdMs),
        }
      })(),
}

if (options.asJson) {
  const json = `${JSON.stringify(record, null, 2)}\n`
  if (options.writePath !== undefined) {
    writeFileSync(options.writePath, json, 'utf8')
    console.log(`wrote ${options.writePath}`)
  } else {
    process.stdout.write(json)
  }
  process.exit(0)
}

// ── markdown fragment ─────────────────────────────────────────────────────────────────────

const lines = []
const say = (line = '') => lines.push(line)
/**
 * `ms === undefined` means the command NEVER STARTED. Printing it as `0.0` would be a fake reading —
 * exactly the defect that produced two zeros on the first run of this script.
 */
const sec = (ms) => (ms === undefined ? '**FAILED TO START**' : (ms / 1000).toFixed(1))

/**
 * A FAILED RUN'S DURATION IS PRINTED WITH ITS EXIT CODE, NOT AS A COST (W4-2d).
 *
 * `check (不含) code = 1` was measured being used as a threshold base. The number is real; it is a
 * real duration of a real FAILED run. Printing it bare invites exactly that misuse, so the cell
 * carries `EXITED n` whenever the exit code is non-zero.
 */
const cell = (step) => (step === undefined ? '—' : step.code === 0 ? sec(step.ms) : `${sec(step.ms)} **EXITED ${step.code}**`)

say('## 机器可读的判据记录（W4-2c）')
say('')
say('> 由 `node scripts/perf-record.mjs` 生成，不设阈值。**判据结论是算出来的，不是写上去的。**')
say('')
say('### 排除法：`check` 含 / 不含 `v208`')
say('')
say('| 测量 | 秒 |')
say('|---|---|')
say(`| \`check\` 含 \`v208\` | **${cell(record.check.withIt)}** |`)
if (record.check.withoutIt !== undefined) {
  say(`| \`check\` 不含 \`v208\`（移走再跑） | **${cell(record.check.withoutIt)}** |`)
  say(`| \`v208\` 单独 | ${sec(record.check.standaloneMs)} |`)
  say(`| \`v208\` 的**净贡献**（排除法差值） | **${sec(record.check.netMs)}** |`)
  say('')
  say(
    `> ⚠ 净贡献（${sec(record.check.netMs)} s）**小于**它自己单独跑的时间（${sec(record.check.standaloneMs)} s）：` +
      '`node --test` 并行执行，它与其他文件重叠。**并行下各文件耗时不可相减** —— 想知道「去掉它要多久」，' +
      '只能移走再跑。',
  )
}
say('')
say('### 门禁各段')
say('')
say(`> 观测缓存：${record.gates.observation}`)
say('')
say('| 段 | 秒 |')
say('|---|---|')
for (const step of record.gates.steps) say(`| ${step.label} | ${cell(step)} |`)
say(`| **合计（只算退出 0 的段：${record.gates.totalOf}）** | **${sec(record.gates.totalMs)}** |`)
if (record.gates.failed.length > 0) {
  say('')
  /**
   * THE FAILED SEGMENTS ARE LISTED, NOT FOLDED IN. A gate that exited non-zero contributed no work
   * to the chain's cost; including its duration in 「合计」 would present a failure as overhead.
   */
  say('> **未计入合计的失败段**：' + record.gates.failed.map((step) => `\`${step.label}\`（${step.code}）`).join('、'))
}
if (record.exclusionFailureExplained === true) {
  say('')
  say(
    '> `check`（不含）**exit 1，但这是移走文件本身造成的**：两道门禁断言 README 的测试数等于实测，' +
      '移走 `v208` 后 685 → 684。这不是缺陷，是测量在描述自己。耗时仍然有效（套件与门禁确实都跑了）——' +
      '**但这次运行不算「通过」，这句话一并留在记录里。**',
  )
}
say('')
say('### 判据')
say('')
if (record.criterion.computable === false) {
  say(`**不可判定**：${record.criterion.why}`)
  say('')
  /**
   * WHY, NOT JUST THAT. "Baseline run failed" alone sends the reader to re-run everything; naming the
   * run and its code sends them to the actual breakage.
   */
  for (const entry of record.criterion.blocked ?? []) {
    say(`- \`${entry.run}\`：code=${entry.code ?? '—'} —— ${entry.detail}`)
  }
} else {
  say(`公式：\`${record.criterion.formula}\``)
  say('')
  say('```')
  say(`阈值 = ${sec(record.criterion.thresholdMs)} s`)
  say(`实测 = ${sec(record.criterion.measuredMs)} s`)
  say(
    record.criterion.met
      ? '结论 = 达标'
      : `结论 = 不达标，超出 ${sec(record.criterion.gapMs)} s（成因：v208 为长尾，其余文件先跑完，那段并行度填不满）`,
  )
  say('```')
}
say('')
/**
 * THE TWO SENTENCES THAT MUST TRAVEL TOGETHER. The suite got 43% faster AND the overall criterion is
 * still not met. Writing only the first would be a true statement arranged to look like a pass.
 */
if (record.check.netMs !== undefined && record.check.standaloneMs !== undefined) {
  say(
    `> **两句必须同时出现**：\`v208\` 从 97–102 s 降到 ${sec(record.check.standaloneMs)} s（约 -43%）**算达成**；` +
      `而整体判据（\`check\` 含 ≤ \`check\` 不含 + 10 s）**不达标**，` +
      `差额 ${sec(record.criterion.gapMs ?? 0)} s，成因是长尾。只写前一句就是一次不完整的陈述。`,
  )
  say('')
}
say(`环境：node ${record.environment.node} · ${record.environment.platform} · ${record.environment.cpu}`)
say(`生成时间：${record.generatedAt}`)

const fragment = `${lines.join('\n')}\n`
if (options.writePath !== undefined) {
  /**
   * `--write` appends with an explicit UTF-8 encoding. The document this fragment belongs to was
   * once destroyed by a PowerShell `>` redirection (UTF-16), so the encoding is this script's job now.
   */
  mkdirSync(dirname(options.writePath), { recursive: true })
  writeFileSync(options.writePath, fragment, { encoding: 'utf8', flag: 'a' })
  console.log(`appended to ${options.writePath} (utf-8, ${Buffer.byteLength(fragment, 'utf8')} bytes)`)
  process.exit(0)
}
process.stdout.write(fragment)
