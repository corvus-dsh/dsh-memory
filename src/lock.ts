/**
 * v0.30 — THE LOCK IS NOW A LEASE, AND THE RACE IS GONE BY CONSTRUCTION.
 *
 * WHAT THIS FILE USED TO BE, AND WHAT IT COST
 *
 * It was a `mkdir` lock: `mkdirSync(lockDir)` won the lock atomically, and then a SEPARATE call wrote
 * `lockDir/owner`. A reclaimer that judged the lock stale could delete the directory between those two
 * lines, and the winning writer then crashed on `ENOENT` writing its own owner file. Observed under
 * load, with eight contending processes:
 *
 *     Error: ENOENT: no such file or directory, open '…/negatives.jsonl.lock/owner'
 *
 * Two more defects lived in the same design: reclaim judged liveness from a pid (so a pid recycled by
 * an unrelated process pinned the lock), and the release path could delete a successor's lock.
 *
 * WHAT IT IS NOW
 *
 * The primitive is `createSyncLeaseAdapter` from `dsh-paradise` — the SAME lease the rest of the
 * ecosystem uses, with a synchronous driver (this store is synchronous end to end, from `appendNegatives`
 * up through the harvest pass, so an async lock could not be dropped in without changing every
 * signature). Every rule — expiry, the ownership fence, the epoch bump — comes from
 * `protocol/lease.ts`, shared with the asynchronous driver.
 *
 * The record is written to a temp file and RENAMED into place while a guard (created with `wx`) is
 * held, so there is no window in which a half-written or owner-less lock exists for a reclaimer to
 * delete. Reclamation is by EXPIRY, not by pid: a lease that has not expired is never stolen, and one
 * that has is taken by the next caller regardless of who used to hold it.
 *
 * WHY THE API DID NOT CHANGE
 *
 * `acquireFileLock(path)` and `withFileLock(path, body)` keep their exact synchronous shapes. Nine call
 * sites in `store.ts` / `suggest.ts` and 52 synchronous calls in the test suite depend on them, and a
 * lock migration that forced every caller to become async would be a behaviour change wearing a
 * refactor's clothes.
 *
 * THE PATH IS STILL THE IDENTITY. Callers pass `<file>.lock`; that string is used as the LEASE KEY, and
 * one record file lives at that exact path — so "is the lock held?" stays answerable with `existsSync`,
 * which two tests rely on.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'

import type { LeaseRecord } from './lease-types.js'
import { acquireLease, releaseLease, leaseAdapterStatus } from './lease-bridge.js'

export interface LockOptions {
  /** How long to wait for the lock before giving up. Default 30s. */
  timeoutMs?: number
  /** How long a held lease stays valid without renewal. Default 30s. */
  staleMs?: number
  /** Label recorded with the lease, for diagnostics. */
  label?: string
}

/** How long between acquisition attempts. Small: the critical sections are single file replacements. */
const RETRY_MS = 8

/**
 * A DISTINCT HOLDER IDENTITY PER ACQUISITION, and it is not cosmetic.
 *
 * The lease rule "the same owner may re-acquire what it already holds" is right FOR A LEASE — a job
 * retrying its own claim should not be locked out by itself. It is wrong FOR A LOCK: two callers inside
 * ONE process (two sessions harvesting on the same tick) share a pid, so a pid-only owner would make the
 * second acquisition look like a renewal and both would enter the critical section. That is precisely
 * the lost update this file exists to prevent.
 *
 * So each acquisition names itself: pid PLUS a per-call counter and a random suffix. The pid stays in
 * the string because it is what a human reads when diagnosing a stuck lock.
 */
let acquisitionCounter = 0
function nextHolderIdentity(): string {
  acquisitionCounter += 1
  return `pid:${process.pid}:${acquisitionCounter}:${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Block the current thread without burning a core (Atomics.wait is a real sleep).
 *
 * ── WHY THIS IS NO LONGER A BUSY-WAIT (measured 2026-11-09) ─────────────────────────────────────
 *
 * It used to be `while (Date.now() < until) {}`. The comment beside it said the critical sections are
 * "single file replacements", which is true and is also why the spin looked harmless — each wait was
 * expected to be microseconds.
 *
 * It is not harmless once anyone else holds the lock. Measured with `process.cpuUsage()` across a
 * 50 ms wait (`dsh-paradise/scripts/bench-lock-spin.mjs`):
 *
 *     memory (spin)           wall 61.6 ms   cpu 62.0 ms   97.1% of a core
 *     graft  (Atomics.wait)   wall 61.6 ms   cpu  0.0 ms    0.0%
 *
 * So a waiter burned a whole core doing nothing. When several sessions contend, the waiters compete
 * for CPU with the holder — which is why the cross-process benchmark observed `hold p95 = 2004 ms`
 * inside an EMPTY critical section. That was not a slow critical section; it was starvation created
 * by this function.
 *
 * ── SAME IMPLEMENTATION AS dsh-graft-slice, ON PURPOSE ──────────────────────────────────────────
 *
 * This body is `dsh-graft-slice/src/core/txn.ts:94-105` — same `Int32Array(new SharedArrayBuffer(4))`,
 * same `Atomics.wait`, same fallback. The two MUST be kept identical: they are separate locks with no
 * shared dependency, so nothing but a test can notice if one drifts back to spinning.
 * `test/lock-sleep-parity.test.mjs` asserts both.
 *
 * `Atomics.wait` on the MAIN THREAD is legal and is exactly the primitive this store needs: it blocks
 * synchronously (so every `withFileLock` caller keeps its signature) and releases the CPU.
 */
function sleepSync(ms: number): void {
  try {
    const waitArray = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(waitArray, 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      // Atomics unavailable (exotic runtime): the deadline loop still yields the CPU.
    }
  }
}

/**
 * Acquire the lease at `lockPath` and return the synchronous release function.
 *
 * Throws when the wait budget is exhausted: a caller that cannot get the lock must NOT proceed to a
 * read-modify-write, because that is exactly the lost update this whole file exists to prevent.
 */
/**
 * ── ACQUISITION COUNTER (env-gated, DEFAULT OFF, read-only) ───────────────────────────────────
 *
 * WHY IT EXISTS: "reduce the number of lock acquisitions" is the fix the T2d numbers point at, but
 * nobody has counted how many acquisitions a turn actually makes, or on which paths. Without that
 * distribution, "fewer" is a direction, not an edit — a call site that runs once per session is a
 * different target from one that runs twice inside a single function.
 *
 * WHY IT IS A COUNTER AND NOT A HOOK: a hook would let a measurement change behaviour if it threw.
 * This only increments a Map and is consulted by an explicitly-called snapshot function. With the
 * env var unset, `record()` returns on its first line: no allocation, no string building, no
 * observable difference beyond one boolean test per acquisition.
 *
 * It is NOT a feature and nothing in production reads it.
 */
const LOCK_TRACE_ENABLED = process.env.DSH_LOCK_TRACE === '1'
const lockTrace = new Map<string, number>()
let lockTraceTotal = 0

function recordAcquisition(lockPath: string): void {
  if (!LOCK_TRACE_ENABLED) return
  lockTraceTotal += 1
  const key = lockPath
  lockTrace.set(key, (lockTrace.get(key) ?? 0) + 1)
}

/** Snapshot of acquisitions since the last reset. Empty unless `DSH_LOCK_TRACE=1`. */
export function lockTraceSnapshot(): { enabled: boolean; total: number; byPath: Array<{ path: string; count: number }> } {
  return {
    enabled: LOCK_TRACE_ENABLED,
    total: lockTraceTotal,
    byPath: [...lockTrace.entries()]
      .map(([path, count]) => ({ path, count }))
      .sort((left, right) => right.count - left.count),
  }
}

/** Clear the counters. Safe to call whether or not tracing is on. */
export function lockTraceReset(): void {
  lockTrace.clear()
  lockTraceTotal = 0
}

export function acquireFileLock(lockPath: string, options: LockOptions = {}): () => void {
  recordAcquisition(lockPath)
  /**
   * THE WAIT BUDGET IS DELIBERATELY GENEROUS. The cost asymmetry decides it: waiting longer costs a
   * slower write, which is invisible (a harvest is already long). Failing costs a LOST RECORD, because
   * a caller that cannot get the lock must not proceed. Measured on a loaded machine, eight writers
   * plus a full test suite can spend seconds merely taking turns even though each section is
   * milliseconds.
   */
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 30_000
  const ttlMs = Number.isFinite(options.staleMs) ? Number(options.staleMs) : 30_000
  const status = leaseAdapterStatus()
  if (!status.ok) {
    throw new Error(
      `无法取得 ${lockPath}：${status.reason}。` +
        '这个锁现在由 dsh-paradise 的租约提供——把 dsh-paradise 放在与 dsh-memory 同级的目录，或在 profile 依赖里加入它。',
    )
  }

  const deadline = Date.now() + timeoutMs
  for (;;) {
    const lease = acquireLease(lockPath, {
      ttlMs,
      owner: nextHolderIdentity(),
      ...(options.label === undefined ? {} : { label: options.label }),
    })
    if (lease !== undefined) {
      let released = false
      return () => {
        if (released) return
        released = true
        /**
         * THE RELEASE IS FENCED. `releaseLease` refuses when the record is no longer this generation,
         * so a holder that overran its TTL cannot delete the claim of whoever took over. That refusal
         * is correct and silent here: leaves the successor's record in place, which is the safe
         * direction.
         */
        releaseLease(lease)
      }
    }
    if (Date.now() >= deadline) {
      const holder = describeCurrentHolder(lockPath)
      throw new Error(
        `could not acquire ${lockPath} within ${timeoutMs}ms${holder === '' ? ' (holder unknown)' : ` (held by ${holder})`}`,
      )
    }
    sleepSync(RETRY_MS + Math.floor(Math.random() * 8))
  }
}

/** Best-effort description of whoever holds it, for the timeout message. */
function describeCurrentHolder(lockPath: string): string {
  try {
    const record = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LeaseRecord>
    const owner = typeof record.owner === 'string' ? record.owner : 'unknown'
    return `${owner}${typeof record.label === 'string' ? `, ${record.label}` : ''}`
  } catch {
    return ''
  }
}

/** Run `body` while holding the lock at `lockPath`; the lock is always released. */
export function withFileLock<T>(lockPath: string, body: () => T, options: LockOptions = {}): T {
  const release = acquireFileLock(lockPath, options)
  try {
    return body()
  } finally {
    release()
  }
}

/** Is a lock currently held at this path? Answerable because the record IS the lock file. */
export function isLockHeld(lockPath: string): boolean {
  return existsSync(lockPath)
}

/** Remove a lock record without the fence. ONLY for test cleanup of an abandoned directory. */
export function forceReleaseLockForTest(lockPath: string): void {
  rmSync(lockPath, { force: true })
}
