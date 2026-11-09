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

test('v0.9.6: waiting on a held lock does not burn CPU for the DURATION of the wait', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-spin-'))
  const lockPath = join(dir, 'contended.json.lock')
  try {
    // Warm up: first call pays module init and JIT, which is not what is under test.
    waitOnHeldLock(lockPath, 30)

    /**
     * ── WHY THE PER-SAMPLE THRESHOLD WAS WRONG (measured, three revisions) ──────────────────────
     *
     * REVISION 1 — `cpu/wall < 10%` on one sample. Failed inside the full suite at 18.6%.
     * REVISION 2 — median of 5 samples < 10% plus "3 of 5 under 1 ms". Failed **1 run in 5 on this
     *   machine** (`got 2/5`, with samples `cpu=0.0 | 31.0 | 47.0 | …`). CI failed on BOTH Node
     *   versions while Windows reported 423/423 green.
     *
     * The cause is not the lock, it is the INSTRUMENT: `process.cpuUsage()` is accounted per thread
     * (V8, GC, the libuv pool) with a coarse tick, so a 70 ms window can accrue 30–47 ms of CPU that
     * this call never spent — a GC that happened to run, or tick attribution from a neighbouring
     * sample. A SHORT window cannot distinguish "slept" from "a tick landed".
     *
     * So the measurement window is made long enough that a real spin cannot be hidden, and the
     * assertion is on the AGGREGATE, which is what the property actually is:
     *
     *     spin    : ~62 ms of CPU per 50 ms waited  → ~1.24 ms CPU per ms waited
     *     sleep   : ~0 ms                            → ~0.00 ms CPU per ms waited
     *
     * Over a 1-second window the sleeping implementation scores under 0.1 and the spinning one scores
     * ~1.2 — an order of magnitude apart, and no neighbouring tick can move it across.
     */
    const WAIT_MS = 1000
    const samples = [waitOnHeldLock(lockPath, WAIT_MS), waitOnHeldLock(lockPath, WAIT_MS)]
    const totalWall = samples.reduce((sum, sample) => sum + sample.wall, 0)
    const totalCpu = samples.reduce((sum, sample) => sum + sample.cpu, 0)
    // CPU milliseconds consumed per wall millisecond spent waiting.
    const cpuPerWall = totalCpu / totalWall
    const detail = samples
      .map((sample) => `wall=${sample.wall.toFixed(0)}ms cpu=${sample.cpu.toFixed(0)}ms`)
      .join(' | ')

    assert.ok(
      cpuPerWall < 0.35,
      `waiting must not burn the core it waits on: ${cpuPerWall.toFixed(2)} ms CPU per ms wall ` +
        `(want < 0.35) [${detail}]\n` +
        'The removed busy-wait scored ~1.24 here (62 ms CPU per 50 ms waited) and cannot pass; ' +
        'a genuine sleep scores ~0.00.',
    )
    // And it must really have waited — a fast return would also burn nothing.
    assert.ok(totalWall >= WAIT_MS * 2 * 0.9, `both waits must last ~${WAIT_MS}ms (got ${totalWall.toFixed(0)}ms total)`)
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
