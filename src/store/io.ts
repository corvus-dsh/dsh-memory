/**
 * THE IO PRIMITIVES — step B of the `store.ts` split.
 *
 * WHY THESE LEAVE FIRST: `atomicWrite` is depended on by the skill writers, the JSONL layer
 * writers and the lifecycle group at once. Pulling it out first means the later steps import
 * a module that already exists instead of dragging a copy of the write path along.
 *
 * The content below is MOVED, not rewritten: `scripts/verify-pure-move.mjs` compares the
 * content-line multiset of the whole `src/` tree, so a single edited character shows up as
 * DISAPPEARED. The only additions are the `import` lines and the `export` keywords that make
 * cross-file use possible — both are plumbing by that checker's definition.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { invalidateLedger, readRecords } from '../ledger-cache.js'

/** Windows holds a share lock while a reader has the file open; sleep briefly. */
function sleepSyncLocal(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // Fall back to a busy wait where SharedArrayBuffer is unavailable.
    const end = Date.now() + ms
    while (Date.now() < end) {
      // spin
    }
  }
}

const TRANSIENT_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * v0.23 — STRUCTURAL GATE BEFORE AN OVERWRITE.
 *
 * `atomicWrite` protects against a TORN file: a reader sees the old file or the new
 * one, never half. It says nothing about a file that was already garbage when it was
 * handed over. The failure this closes:
 *
 *   An extraction model returns a truncated reply — a reply that stops mid-value,
 *   because the response hit a token cap or the transport dropped a chunk. The
 *   caller parses what it got, or trusts a value it assembled, and writes it. The
 *   write is atomic and the file is now atomically WRONG, and the previous good
 *   contents are gone. A reader then meets a JSON document that cannot parse, and
 *   every entry after the break is invisible.
 *
 * The rule: a structured store file is validated BEFORE it replaces anything. On
 * failure nothing is overwritten — the offending payload goes to `<path>.rejected-*`
 * so it can be inspected, and the original file on disk stays exactly as it was.
 *
 * Scope is by EXTENSION, not by caller, because there are 20+ write sites and a guard
 * that each of them must remember to call is a guard that one of them will forget.
 * `.md` and `.jsonl` bodies are handled by their own writers (a skill is validated by
 * the frontmatter parser; a jsonl line is validated on read), so this gate covers the
 * single-document JSON stores where a truncation is unrecoverable.
 */
const JSON_GATE_EXT = '.json'

export class StoreWriteRejected extends Error {
  // Explicit fields rather than TypeScript parameter properties: `scripts/build.mjs`
  // strips types without transforming them, so the shorthand is not available here.
  readonly path: string
  readonly reason: string
  readonly quarantinePath: string | undefined

  constructor(path: string, reason: string, quarantinePath: string | undefined) {
    super(`[dsh-memory] refused to overwrite ${path}: ${reason}`)
    this.name = 'StoreWriteRejected'
    this.path = path
    this.reason = reason
    this.quarantinePath = quarantinePath
  }
}

/**
 * Throw when `text` is not a complete JSON document. Returns normally otherwise.
 *
 * Deliberately strict: `JSON.parse` on the whole string, no brace-matching heuristic.
 * A heuristic that "repairs" a truncated document would write a file that parses but
 * says something the model never said — worse than refusing.
 */
function assertCompleteJson(path: string, text: string): void {
  if (!path.toLowerCase().endsWith(JSON_GATE_EXT)) return
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  try {
    JSON.parse(trimmed)
  } catch (error) {
    const reason = `not a complete JSON document (${String((error as any)?.message ?? error)})`
    let quarantinePath: string | undefined
    try {
      quarantinePath = `${path}.rejected-${process.pid}-${Date.now()}`
      writeFileSync(quarantinePath, text, 'utf8')
    } catch {
      // A failed quarantine must not mask the real refusal: the caller still needs to
      // know the write did not happen.
      quarantinePath = undefined
    }
    throw new StoreWriteRejected(path, reason, quarantinePath)
  }
}

/**
 * v0.7.1: tmp-file + rename, with a retry window for Windows share locks.
 *
 * The extreme-consistency run (5 reader processes against 1 writer) proved the
 * rename can fail with EPERM while another process holds the destination open.
 * An unguarded `renameSync` therefore turned a concurrent READ into a failed
 * WRITE — the one failure mode an append-only ledger must not have. Retrying for
 * a bounded window keeps the atomicity and makes concurrent reads harmless.
 */
export function atomicWrite(path: string, text: string): void {
  // v0.23: validate BEFORE the tmp file exists, so a rejected payload never becomes
  // visible under any name that a reader could pick up.
  assertCompleteJson(path, text)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, path)
      return
    } catch (error) {
      const code = String((error as any)?.code ?? '')
      if (!TRANSIENT_RENAME.has(code) || attempt >= 40) {
        try {
          rmSync(tmp, { force: true })
        } catch {
          // The next write's own tmp file is equally disposable.
        }
        throw error
      }
      sleepSyncLocal(5 + Math.min(50, attempt * 5))
    }
  }
}

/**
 * READ ONE JSONL LEDGER.
 *
 * v1.1.0: this used to be `readFileSync` + line-by-line `JSON.parse` on EVERY call. The V8
 * profile put three instances of this function at 14.0% of a turn's CPU, and the retrieval
 * path re-parsed the same files again for another 13.2%. It now goes through the ledger
 * cache, which validates with two `stat` calls and returns the already-parsed array.
 *
 * The signature is unchanged on purpose: every caller keeps treating the result as a plain
 * array it may mutate, and `commitLedger` is what makes those mutations durable.
 */
export function readJsonl(path: string): Array<Record<string, unknown>> {
  return readRecords(path)
}

/**
 * Read a ledger that a caller is about to MUTATE under a lock.
 *
 * The cache returns a shared array; a caller that wants to be certain it is not holding a
 * snapshot taken before the lock must invalidate first. This is the explicit escape hatch —
 * named so that "did you mean the shared array or a fresh read?" has an answer at the call
 * site instead of in a comment.
 */
export function readJsonlFresh(path: string): Array<Record<string, unknown>> {
  invalidateLedger(path)
  return readRecords(path)
}
