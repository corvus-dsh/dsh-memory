/**
 * ── fs-settle: make a filesystem change OBSERVABLE, with a bound ────────────────────────────────
 *
 * ── THE FLAKE THIS EXISTS TO REMOVE (B4-0b-2 §40, measured 2026-11-21) ──────────────────────────
 *
 * `v293 ④` did `mkdirSync(...)` and then asked whether the parent directory's mtime had moved. It
 * failed **18/20** in a 20-run sweep on this machine (the user saw 1/8 on theirs). The first fix
 * attempted — poll the mtime AFTER the mkdir — made it worse in a different way: **7/20 still failed,
 * after waiting 405 ms, with every sample identical.**
 *
 * ── THE MECHANISM, MEASURED, AND IT IS NOT A LAG ───────────────────────────────────────────────
 *
 * Twenty trials per row, `sleep` BEFORE the mkdir versus after it:
 *
 *     sleep 0 ms before   : before === after in 20/20,  and STILL equal after waiting 250 ms
 *     sleep 1 ms before   : 0/20 equal
 *     sleep 2 / 5 / 16 ms : 0/20 equal
 *
 *     poll AFTER the mkdir for up to 400 ms : 7/20 still see no change (all samples identical)
 *
 * So the value is CORRECT once recorded — it is simply recorded with the SAME timestamp when the mkdir
 * lands in the same filesystem update window as the stat that preceded it. **Waiting afterwards cannot
 * help, because the timestamp has already been committed.** Only a pause before the change moves the
 * next operation into a fresh window.
 *
 * That is why `settleBefore` exists and `waitForMtimeChange` is no longer the primary helper.
 *
 * ── WHY NOT A PLAIN `sleep(50)` ─────────────────────────────────────────────────────────────
 *
 * §33.3 already removed a fixed 250 ms wait for exactly this reason: it is either too short (the flake
 * returns) or too long (every run pays it). So the pause is the smallest measured to work (1 ms) plus a
 * safety factor, and the RESULT is still verified by polling — a pause that was too short fails loudly
 * instead of silently reintroducing the flake.
 */
import { statSync } from 'node:fs'

/** A pause before a filesystem change so it lands in a fresh update window. 1 ms was measured sufficient; 4 gives margin. */
export const FS_SETTLE_PAUSE_MS = 4
/** How long to keep verifying afterwards. Generous against the tick, small against a hung volume. */
export const FS_SETTLE_TIMEOUT_MS = 400
/** Re-check period while verifying. */
export const FS_SETTLE_POLL_MS = 5

function sleepSync(ms) {
  if (ms <= 0) return
  /** `Atomics.wait` is a real sleep; a busy loop would burn a core and skew any timing nearby. */
  const shared = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(shared, 0, 0, ms)
}

/** Pause so that the NEXT filesystem mutation is recorded in a different update window. */
export function settleBefore(ms = FS_SETTLE_PAUSE_MS) {
  sleepSync(ms)
}

/**
 * Poll `read` until `predicate(value)` is true, or the bound expires.
 *
 * Returns `{ ok, waitedMs, samples }` — the samples are what makes a failure diagnosable: a test that
 * times out can print the sequence it saw instead of 「timeout」.
 */
export function waitFor(read, predicate, { timeoutMs = FS_SETTLE_TIMEOUT_MS, pollMs = FS_SETTLE_POLL_MS } = {}) {
  const started = Date.now()
  const samples = []
  let last
  for (;;) {
    last = read()
    samples.push(last)
    if (predicate(last)) return { ok: true, waitedMs: Date.now() - started, samples }
    if (Date.now() - started >= timeoutMs) return { ok: false, waitedMs: Date.now() - started, samples, last }
    sleepSync(pollMs)
  }
}

/**
 * The shape every 「write, then stat」 test should use:
 *
 *   1. take the baseline mtime;
 *   2. `settleBefore()` — move the next mutation into a fresh window (this is the load-bearing step);
 *   3. perform the mutation;
 *   4. `waitForMtimeChange` — verify it became visible, and fail with the observed samples if not.
 *
 * Steps 2 and 4 are not redundant: 2 makes it work, 4 proves it did. A helper that only slept would
 * silently degrade to a flake the day the filesystem changed its window; this one reports.
 */
export function mtimeChangeAfter(path, mutate, { pauseMs, ...options } = {}) {
  const before = statSync(path).mtimeMs
  settleBefore(pauseMs)
  mutate()
  const settled = waitForMtimeChange(path, before, options)
  return { ...settled, before }
}

/** Wait until the directory mtime at `path` differs from `previousMtimeMs`. */
export function waitForMtimeChange(path, previousMtimeMs, options) {
  return waitFor(
    () => {
      try {
        return statSync(path).mtimeMs
      } catch {
        return undefined
      }
    },
    (value) => value !== undefined && value !== previousMtimeMs,
    options,
  )
}
