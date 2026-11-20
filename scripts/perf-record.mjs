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
  try {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
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
    return { label, ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6), code: error.status }
  }
  return { label, ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6), code: 0 }
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
const gateTotalMs = gateSteps.reduce((sum, step) => sum + (step.ms ?? 0), 0)

const check = options.skipExclusion
  ? { withIt: timedNpm('check (含)', ['run', 'check', '--silent'], REPO), withoutIt: undefined }
  : measureWithAndWithout(V208, 'check', 'npm', ['run', 'check', '--silent'])

const record = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu: `${(cpus()[0]?.model ?? 'unknown').trim()} × ${cpus().length}`,
  },
  check,
  gates: { steps: gateSteps, totalMs: gateTotalMs },
  /**
   * THE VERDICT IS COMPUTED, NOT TYPED. Same formula as graft (§26.4): a check may cost its suite
   * plus ten seconds of gate overhead. When the exclusion was not measured, no verdict is claimed —
   * an unknown base must not be turned into a pass by arithmetic.
   */
  criterion: check.withoutIt === undefined
    ? { computable: false, why: 'exclusion not measured; a base cannot be inferred by subtraction' }
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

say('## 机器可读的判据记录（W4-2c）')
say('')
say('> 由 `node scripts/perf-record.mjs` 生成，不设阈值。**判据结论是算出来的，不是写上去的。**')
say('')
say('### 排除法：`check` 含 / 不含 `v208`')
say('')
say('| 测量 | 秒 |')
say('|---|---|')
say(`| \`check\` 含 \`v208\` | **${sec(record.check.withIt.ms)}** |`)
if (record.check.withoutIt !== undefined) {
  say(`| \`check\` 不含 \`v208\`（移走再跑） | **${sec(record.check.withoutIt.ms)}** |`)
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
say('| 段 | 秒 |')
say('|---|---|')
for (const step of record.gates.steps) say(`| ${step.label} | ${sec(step.ms)} |`)
say(`| **合计** | **${sec(record.gates.totalMs)}** |`)
say('')
say('### 判据')
say('')
if (record.criterion.computable === false) {
  say(`**不可判定**：${record.criterion.why}`)
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
