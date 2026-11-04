/**
 * v0.22 P0 — a cross-process file lock, so two harvests cannot erase each other.
 *
 * THE BUG THIS CLOSES
 *
 * `atomicWrite` is already tmp-file + rename with a retry window, so a reader never
 * sees half a file. Atomicity is not isolation: `markProcessed` does
 * read-modify-write over `processed.json`, and two sessions harvesting at once each
 * hold a PARTIAL view. The second writer's `rename` replaces the first writer's key,
 * so the first session is "not processed" again and is mined a second time — the
 * duplicate-skill generator this project has already paid for once.
 *
 * The lock is a DIRECTORY: `mkdir` fails with EEXIST on every platform we ship, which
 * makes it the one primitive that is atomic without a native addon. A lock whose owner
 * pid is alive is never stolen, however old; a lock whose owner is dead (or whose
 * lease expired) is reclaimed, because a crashed writer must not pin the store.
 *
 * Deliberately small and dependency-free: the store needs mutual exclusion for whole
 * file replacements, not a general transaction manager.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface LockOptions {
  /** How long to wait for the lock before giving up. Default 8s. */
  timeoutMs?: number
  /** A lock older than this whose owner is unknown is reclaimed. Default 30s. */
  staleMs?: number
  /** Label recorded in the owner file, for diagnostics. */
  label?: string
}

interface OwnerRecord {
  pid: number
  at: number
  token: string
  label?: string
}

const LOCK_SETTLE_MS = 12

function sleepSync(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // Busy-wait: the lock critical sections here are single file replacements.
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user: still alive.
    return String((error as any)?.code ?? '') === 'EPERM'
  }
}

function readOwner(lockPath: string): OwnerRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(lockPath, 'owner'), 'utf8')) as Record<string, unknown>
    const pid = Number(parsed.pid)
    const at = Number(parsed.at)
    if (!Number.isFinite(pid) || !Number.isFinite(at)) return undefined
    return {
      pid,
      at,
      token: typeof parsed.token === 'string' ? parsed.token : '',
      ...(typeof parsed.label === 'string' ? { label: parsed.label } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * Acquire `lockPath` (a directory) and return the release function.
 *
 * Throws when the wait budget is exhausted: a caller that cannot get the lock must
 * NOT proceed to a read-modify-write, because that is exactly the lost update.
 */
export function acquireFileLock(lockPath: string, options: LockOptions = {}): () => void {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 8_000
  const staleMs = Number.isFinite(options.staleMs) ? Number(options.staleMs) : 30_000
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const deadline = Date.now() + timeoutMs
  // The lock is a SIBLING of the file it guards, so the parent may not exist yet on a
  // first run. Creating it here keeps every caller from repeating the step.
  mkdirSync(dirname(lockPath), { recursive: true })
  for (;;) {
    try {
      mkdirSync(lockPath, { recursive: false })
      const owner: OwnerRecord = {
        pid: process.pid,
        at: Date.now(),
        token,
        ...(options.label === undefined ? {} : { label: options.label }),
      }
      writeFileSync(join(lockPath, 'owner'), JSON.stringify(owner), 'utf8')
      let released = false
      return () => {
        if (released) return
        released = true
        // Only the owner releases: a reclaimed lock may now belong to somebody else.
        const current = readOwner(lockPath)
        if (current !== undefined && current.token !== token) return
        try {
          rmSync(lockPath, { recursive: true, force: true })
        } catch {
          // A lock that will not delete is left for the stale sweep.
        }
      }
    } catch (error) {
      if (String((error as any)?.code ?? '') !== 'EEXIST') throw error
    }
    // Somebody holds it. Reclaim only when the holder is provably gone.
    const owner = readOwner(lockPath)
    const ageMs = (() => {
      try {
        return Date.now() - statSync(lockPath).mtimeMs
      } catch {
        return 0
      }
    })()
    const dead = owner !== undefined && !isProcessAlive(owner.pid)
    const unknownAndOld = owner === undefined && ageMs > staleMs
    if (dead || unknownAndOld) {
      try {
        rmSync(lockPath, { recursive: true, force: true })
      } catch {
        // Another waiter won the reclaim; the retry loop settles it.
      }
      sleepSync(LOCK_SETTLE_MS)
      continue
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `could not acquire ${lockPath} within ${timeoutMs}ms` +
          (owner === undefined ? ' (owner unknown)' : ` (held by pid ${owner.pid}${owner.label === undefined ? '' : `, ${owner.label}`})`),
      )
    }
    sleepSync(LOCK_SETTLE_MS + Math.floor(Math.random() * 8))
  }
}

/** Run `body` while holding `lockPath`; the lock is always released. */
export function withFileLock<T>(lockPath: string, body: () => T, options: LockOptions = {}): T {
  const release = acquireFileLock(lockPath, options)
  try {
    return body()
  } finally {
    release()
  }
}
