/**
 * ── v283 (B4-0b-2 W4-3): A SCALE BASELINE THAT CANNOT LIE ABOUT WHAT IT MEASURED ────────────────
 *
 * Audit AUD-14: retrieval had no scale baseline, and the 「2.5 ms at 2000 documents」 figure lived
 * only in a report — measured once, by hand, on an unknown machine. That is the same condition that
 * let 「four repos byte-identical」 be written down as fact (W4-1b), so the fix has two halves: a
 * reproducible script, and a test that keeps the script honest.
 *
 * ── THE MISTAKE THIS FILE EXISTS TO PREVENT, MADE BY ME ON THE FIRST RUN ───────────────────────
 *
 * `scripts/retrieval-baseline.mjs` first reported **0.02 ms at 2000 documents** — suspiciously the
 * same as the 50-document case. It was measuring a CACHE HIT: `skillDocuments` consults
 * `skill-cache.ts` keyed on the directory's mtime, so every sample after the first answered from
 * memory. Reporting only that number would have produced 「2000 documents in 0.02 ms」, which is true
 * and means almost nothing.
 *
 * The script now reports WARM and COLD separately, and `--cold` calls `invalidateSkillDocs` — the
 * cache this path actually reads (`invalidateDocuments` was a different cache, one layer up).
 *
 * ── WHAT THIS TEST PINS ─────────────────────────────────────────────────────────────────────
 *
 *   ① cold scales with corpus size — 800 docs costs meaningfully more than 50 (a flat line would mean
 *     the cache is still answering, which is exactly the defect above);
 *   ② warm does NOT scale — it stays flat, and that is stated as a PROPERTY, not a hope;
 *   ③ the dispatch's criterion (2000 documents warm ≤ 2 ms) still holds;
 *   ④ `--samples` below 5 is REFUSED — a median of three samples on a shared machine is noise;
 *   ⑤ the corpus is really parsed (document count == requested size), so "fast" cannot mean "skipped";
 *   ⑥ `--check-warm` enforces, and an impossible threshold exits 1 (the gate is not decorative).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(REPO, 'scripts', 'retrieval-baseline.mjs')

/**
 * ── THE ENVIRONMENT A NESTED RUNNER INHERITS MUST BE CLEANED (this bit me twice now) ──────────
 *
 * Running `node --test` (or anything that starts a test runner) from INSIDE `node --test` inherits
 * `NODE_TEST_CONTEXT` / `NODE_TEST_WORKER_ID`; the child then behaves as an inner worker and can exit
 * without doing its work. It produced a false green in the burn-in harness (`v281 ⑤`) and it broke
 * THIS file on its first run (`shared.code !== 0` with an empty measured table).
 *
 * Measured here as well: the same command run from a plain shell exits 0 with a full table.
 */
function cleanTestEnv() {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID
  return env
}

/** Run the baseline script and return `{ code, out }` — never throws on a non-zero exit. */
function runBaseline(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
    env: cleanTestEnv(),
  })
  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/** Parse the table into `{ size: { warm, cold, parsed } }`. */
function parseTable(output) {
  const table = {}
  for (const line of output.split(/\r?\n/u)) {
    /**
   * `^\s+`, NOT `^\s{2}` — measured. The table right-aligns the size column (`String(size).padStart(4)`),
   * so `  50` has three leading spaces and `2000` has two. A fixed-width prefix parsed ONLY the 2000
   * row, and the resulting 「表里必须有 50 这一行」 failure pointed at the fixture rather than at the
   * parser. A test that mis-reads its own input is the same defect class as the module it guards.
   */
  const match = /^\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s*$/u.exec(line)
    if (match === null) continue
    table[Number(match[1])] = { warm: Number(match[2]), cold: Number(match[3]), parsed: Number(match[4]) }
  }
  return table
}

/**
 * ── ONE REAL RUN, SHARED BY THE ASSERTIONS — LAZILY, AND THE REASON IS MEASURED ────────────────
 *
 * The first version ran the script at MODULE TOP LEVEL (`const shared = runBaseline(...)`). That
 * returned in **1.17 ms** with an empty table, while a test body invoking the same command took 4.5 s
 * and worked: a synchronous child process started while the test module is still being loaded does not
 * get to do its work here.
 *
 * So the run happens on first use, inside a test body, and the result is memoised. Same idea as the
 * W4-2 memoisations, for the same reason: measure where the work actually runs.
 */
let sharedRun
function measuredTable() {
  if (sharedRun === undefined) sharedRun = runBaseline(['--samples', '5'])
  return { code: sharedRun.code, out: sharedRun.out, table: parseTable(sharedRun.out) }
}

// ── ⑤ the corpus is really parsed ─────────────────────────────────────────────────────────

test('v283 ⑤: 语料真的被解析了 —— 文档数 == 请求数（「快」不许等于「跳过」）', () => {
  const { code, out, table } = measuredTable()
  assert.equal(code, 0, `baseline 必须正常退出；实际 ${code}\n${out.slice(-800)}`)
  for (const size of [50, 200, 800, 2000]) {
    assert.ok(table[size] !== undefined, `表里必须有 ${size} 这一行；解析到的行：${Object.keys(table).join(',')}`)
    assert.equal(table[size].parsed, size, `${size} 条语料必须解析出 ${size} 份文档，实际 ${table[size].parsed}`)
  }
})

// ── ① cold scales with size (the cache is NOT answering) ────────────────────────────────

test('v283 ①: cold 随规模增长 —— 2000 条明显贵于 50 条（平线说明缓存还在答）', () => {
  const { table } = measuredTable()
  const small = table[50]
  const large = table[2000]
  assert.ok(small !== undefined && large !== undefined, '前提：两端都必须测到')
  /**
   * A FLAT COLD LINE IS THE DEFECT. Measured before the fix: 0.02 ms at both 50 and 2000 documents,
   * because `--cold` was invalidating a different cache. The ratio here is ~25x in the healthy case;
   * the assertion asks for a factor of 5, which is far below the healthy value and far above the
   * broken one (1.0), so it separates the two without being brittle about machine speed.
   */
  assert.ok(
    large.cold >= small.cold * 5,
    `2000 条的 cold 必须至少是 50 条的 5 倍；实际 ${large.cold} vs ${small.cold}（比值 ${(large.cold / small.cold).toFixed(1)}）`,
  )
})

// ── ② warm is flat, and that is stated rather than hoped ────────────────────────────────

test('v283 ②: warm 不随规模变化 —— 它是缓存命中，不是一个可比的规模指标', () => {
  const { table } = measuredTable()
  const small = table[50]
  const large = table[2000]
  assert.ok(small !== undefined && large !== undefined)
  /**
   * Warm should be within a small constant factor across a 40x corpus range. This is asserted so the
   * NEXT reader sees the property in code: if warm ever starts scaling, the cache stopped working and
   * the 「2.5 ms at 2000」 style claim would silently become a scan measurement.
   */
  const ratio = Math.max(small.warm, large.warm) / Math.max(0.001, Math.min(small.warm, large.warm))
  assert.ok(
    ratio <= 20,
    `warm 必须基本持平（≤20x）；实测 50 条 ${small.warm} ms、2000 条 ${large.warm} ms（比值 ${ratio.toFixed(1)}）——` +
      '若它开始随规模增长，说明缓存失效了，那时 warm 与 cold 的区别就没了',
  )
})

// ── ③ the dispatch's criterion ──────────────────────────────────────────────────────────

test('v283 ③: 派工单判据 —— 2000 条 warm ≤ 2 ms 仍成立', () => {
  const { table } = measuredTable()
  const large = table[2000]
  assert.ok(large !== undefined)
  assert.ok(large.warm <= 2, `2000 条 warm 必须 ≤ 2 ms；实际 ${large.warm} ms（判据来自派工单 W4-3）`)
})

// ── ④ fewer than five samples is refused ────────────────────────────────────────────────

test('v283 ④: --samples < 5 被拒绝（三次取中位是带了小数点的噪声）', () => {
  const short = runBaseline(['--samples', '3'])
  assert.equal(short.code, 2, `必须 exit 2；实际 ${short.code}\n${short.out.slice(-400)}`)
  assert.match(short.out, /must be ≥ 5/u, '必须说明为什么，而不是只说「参数非法」')
})

// ── ⑥ the threshold really enforces ─────────────────────────────────────────────────────

test('v283 ⑥: --check-warm 会真的判红（一个不可能达到的阈值 ⇒ exit 1）', () => {
  /**
   * A gate that cannot fail is a comment. 0.0001 ms is below any real measurement, so this exercises
   * the red path without depending on machine speed.
   */
  const impossible = runBaseline(['--samples', '5', '--check-warm', '0.0001'])
  assert.equal(impossible.code, 1, `不可能的阈值必须 exit 1；实际 ${impossible.code}\n${impossible.out.slice(-400)}`)
  assert.match(impossible.out, /THRESHOLD EXCEEDED/u)
  assert.match(impossible.out, /WARM/u, '失败必须点名是哪一类（warm/cold），否则读者不知道该看哪里')
})