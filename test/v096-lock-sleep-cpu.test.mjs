/**
 * v0.9.6 — waiting for the lock must NOT burn a CPU core.
 *
 * ── THE MEASUREMENT THIS PINS ────────────────────────────────────────────────────────────────────
 *
 * `sleepSync` in `dsh-memory/src/lock.ts` used to be `while (Date.now() < until) {}`. Waiting 50 ms
 * therefore consumed ~50 ms of CPU — about one core, 97.1% of wall time, measured with
 * `process.cpuUsage()` in `dsh-paradise/scripts/bench-lock-spin.mjs`.
 *
 * That is not a micro-optimisation. The cross-process benchmark found `hold p95 = 2004 ms` inside an
 * EMPTY critical section: waiters were starving the holder of CPU. The spin was manufacturing the
 * contention it appeared to be suffering from.
 *
 * ── WHY THIS TEST READS `process.cpuUsage()` AND NOT A COMMENT ──────────────────────────────────
 *
 * The property is "the CPU does not move while we wait". Only CPU accounting can assert it — a
 * functional test passes identically under both implementations, which is exactly how the spin
 * survived 30 versions.
 *
 * ── IT MUST BE ABLE TO FAIL ─────────────────────────────────────────────────────────────────────
 *
 * Verified against the old implementation before the change: the ratio came out at ~0.97 and this
 * test was RED. A threshold test that has never been seen to fail is a decoration.
 *
 * ── WHY THE WAIT IS REACHED THROUGH THE PUBLIC API ──────────────────────────────────────────────
 *
 * `sleepSync` is module-private in `lock.ts` (not exported, and exporting it would widen the public
 * surface for a test's benefit). So the wait is produced the way production produces it: hold the
 * lock, then try to acquire it with a short timeout, and measure while it retries.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireFileLock } from '../lib/lock.js'

const cpuMs = () => {
  const usage = process.cpuUsage()
  return (usage.user + usage.system) / 1000
}
const wallMs = () => Number(process.hrtime.bigint()) / 1e6

/**
 * Force the retry loop: hold the lock, then try to take it with a budget of `waitFor` ms.
 * The second acquisition is expected to THROW — the wait happens before it does.
 */
function waitOnHeldLock(lockPath, waitFor) {
  const release = acquireFileLock(lockPath, { label: 'holder', timeoutMs: 10_000, staleMs: 60_000 })
  try {
    const cpuBefore = cpuMs()
    const wallBefore = wallMs()
    assert.throws(
      () => acquireFileLock(lockPath, { label: 'waiter', timeoutMs: waitFor, staleMs: 60_000 }),
      /could not acquire/u,
      'the waiter must time out — if it acquired, nothing was measured',
    )
    return { wall: wallMs() - wallBefore, cpu: cpuMs() - cpuBefore }
  } finally {
    release()
  }
}

test('v0.9.6: waiting on a held lock consumes < 10% of wall time in CPU', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-spin-'))
  const lockPath = join(dir, 'contended.json.lock')
  try {
    // Warm up: first call pays module init and JIT, which is not what is under test.
    waitOnHeldLock(lockPath, 30)

    /**
     * ── WHY THE CATEGORICAL CHECK, AND WHY THE RATIO ALONE WAS FLAKY ────────────────────────────
     *
     * `process.cpuUsage()` is CLOCK-TICK GRANULAR: on Windows the whole test suite run reported
     * `cpu = 16.0 ms` for a wait that burned nothing — the sampling unit, not the work. With a
     * ~70 ms wait that tick alone is 18.6%, which fails a 10% threshold on perfectly correct code.
     * Measured: standalone the ratio is 0.0%; inside the full suite (other tests' CPU already
     * accounted) the same code reports 18.6%. **The threshold was measuring the clock's resolution.**
     *
     * The property that actually separates the two implementations is not "how many ticks" but
     * "does the CPU move at all, monotonically, every time":
     *
     *     busy-wait  →  ~62 ms CPU per 50 ms wait, EVERY sample   (~97%)
     *     Atomics    →  0 ms, or occasionally one 16 ms tick      (≤ 19% at 70 ms, usually 0%)
     *
     * So the assertion is: a MAJORITY of samples burn less than one tick of CPU, and the MEDIAN
     * ratio stays under 10%. A reintroduced spin fails both immediately — it scores ~97% on every
     * single sample, which no amount of tick noise can produce.
     */
    const samples = []
    for (let i = 0; i < 5; i += 1) samples.push(waitOnHeldLock(lockPath, 70))

    const ratios = samples.map((sample) => sample.cpu / sample.wall).sort((a, b) => a - b)
    const medianRatio = ratios[Math.floor(ratios.length / 2)]
    const quiet = samples.filter((sample) => sample.cpu < 1).length
    const detail = samples
      .map((sample) => `wall=${sample.wall.toFixed(1)}ms cpu=${sample.cpu.toFixed(1)}ms`)
      .join(' | ')

    assert.ok(
      quiet >= 3,
      `at least 3 of 5 waits must burn under 1 ms of CPU (got ${quiet}/5) [${detail}]\n` +
        'The busy-wait implementation burned ~62 ms on EVERY wait; it cannot pass this.',
    )
    assert.ok(
      medianRatio < 0.1,
      `median cpu/wall must stay under 10% (got ${(medianRatio * 100).toFixed(1)}%) [${detail}]`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.9.6: the lock still blocks for the whole wait budget (it sleeps, it does not skip)', () => {
  // A "fast" implementation that returned immediately would also burn no CPU. This pins that the
  // time is actually spent waiting and the timeout still fires.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-spin-dur-'))
  const lockPath = join(dir, 'held.json.lock')
  try {
    const { wall } = waitOnHeldLock(lockPath, 80)
    assert.ok(wall >= 70, `the waiter must actually wait ~80ms, not return early (got ${wall.toFixed(1)}ms)`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
