/**
 * THE CROSS-PLUGIN LAYOUT CONTRACT — the only thing `dsh-memory` and `dsh-graft-slice` share.
 *
 * ── P1-2 (audit 2026-11-08): WHY A VERSION MARKER, WHEN AN EPOCH ALREADY EXISTS ───────────────
 *
 * `ledger.ts` already fences the ledger *content format* with an epoch. That fence does NOT cover the
 * *directory layout*, and the difference is not academic:
 *
 *   - a file renamed (`.retired.json` → `.retired-v2.json`) reads as
 *     `{ epoch: 0, payload: undefined }` — which this reader has always interpreted as
 *     "there is no ledger yet". So a layout change on the writer's side made this side see an EMPTY
 *     history and say nothing. Not a refusal: a silence.
 *   - both sides derive each other's directory INDEPENDENTLY (`graftDataDir` here,
 *     `resolveStoreDir`/`resolveMemoryPaths` there), so the two derivations can disagree with no
 *     error anywhere.
 *
 * The epoch answers "can I parse what I found". This module answers the question before it: "is this
 * the directory I think it is, and does the other side still put the same things in it".
 *
 * THE MECHANISM IS A MANIFEST, AND IT IS DELIBERATELY BORING. Each producer writes `.layout.json`
 * into the directory it owns:
 *
 *   { "layout": 1, "producer": "dsh-graft-slice", "files": [".retired.json", ".transferred.json"] }
 *
 * Each reader asserts it BEFORE reading anything, and REFUSES rather than guesses:
 *
 *   absent      → proceed. A directory written before this marker existed is legacy, and refusing
 *                 it would break every existing installation on upgrade. Documented, not silent:
 *                 the epoch fence still applies to the content.
 *   unreadable  → REFUSE. A torn manifest is not proof of an understood layout, and the read is
 *                 cheap to retry.
 *   layout != N → REFUSE with `LAYOUT_UNSUPPORTED`. Exact match, not ">=": a reader that accepts an
 *                 older version is claiming it still knows that shape, and a claim nobody can check
 *                 is the guess this module exists to remove. A future layout change must ship a
 *                 reader that names the version it speaks.
 *
 * WHAT THIS CANNOT CATCH, SAID PLAINLY: if the two plugins look at DIFFERENT DIRECTORIES, this
 * reader finds no manifest there and proceeds — absent looks exactly like "never used". Detecting
 * that requires a deployment check, not a version check, and inventing a heuristic for it here would
 * make a wrong guess look like a verified fact.
 *
 * THE SAME MODULE EXISTS IN `dsh-graft-slice` WITH THE PRODUCER NAMES MIRRORED, and the duplication
 * is deliberate: the four repositories have zero static imports between them, which is what lets any
 * one be uninstalled without the others failing at load. Each side's test hard-codes the OTHER side's
 * literal file names and version, so a one-sided change to the layout turns a test red on the side
 * that changed — see `test/v102-layout-contract.test.mjs`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The manifest's file name, inside the directory it describes. */
export const LAYOUT_MANIFEST_FILE = '.layout.json'

/** The layout version of the MEMORY STORE this build writes. */
export const MEMORY_LAYOUT_VERSION = 1

/**
 * The files `dsh-graft-slice` reads out of this store. They are part of the layout because renaming
 * one is invisible to it: its reader degrades to `[]`, and "no memories recorded" reads exactly like
 * "the store moved".
 */
export const MEMORY_LAYOUT_FILES = ['negatives.jsonl', 'facts.jsonl', 'experiences.jsonl', 'suggestions.jsonl'] as const

/** The layout version of the GRAFT LEDGER directory this build reads. */
export const GRAFT_LEDGER_LAYOUT_VERSION = 1

/** The files this reader takes out of the graft ledger directory. */
export const GRAFT_LEDGER_FILES = ['.retired.json', '.transferred.json'] as const

export interface LayoutManifest {
  layout: number
  producer: string
  files: readonly string[]
}

export type LayoutRead =
  | { state: 'absent' }
  | { state: 'unreadable'; detail: string }
  | { state: 'present'; manifest: LayoutManifest }

/** Raised when a directory's declared layout is absent-but-torn or one this build does not speak. */
export class LayoutUnsupportedError extends Error {
  readonly code = 'LAYOUT_UNSUPPORTED'
  readonly dir: string
  readonly expected: number
  readonly found?: number

  constructor(dir: string, expected: number, detail: string, found?: number) {
    super(`LAYOUT_UNSUPPORTED: ${dir}: ${detail}`)
    this.name = 'LayoutUnsupportedError'
    this.dir = dir
    this.expected = expected
    this.found = found
  }
}

export function readLayoutManifest(dir: string): LayoutRead {
  const path = join(dir, LAYOUT_MANIFEST_FILE)
  if (!existsSync(path)) return { state: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { state: 'unreadable', detail: `manifest is not valid JSON (${String((error as any)?.message ?? error)})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'unreadable', detail: 'manifest is not a JSON object' }
  }
  const record = parsed as Record<string, unknown>
  const layout = Number(record.layout)
  if (!Number.isFinite(layout) || layout <= 0) {
    return { state: 'unreadable', detail: `manifest has no usable "layout" number (${JSON.stringify(record.layout)})` }
  }
  return {
    state: 'present',
    manifest: {
      layout,
      producer: typeof record.producer === 'string' ? record.producer : '',
      files: Array.isArray(record.files) ? record.files.filter((name): name is string => typeof name === 'string') : [],
    },
  }
}

/**
 * The pre-read gate. Throws `LayoutUnsupportedError` (code `LAYOUT_UNSUPPORTED`) when the directory
 * declares a layout this build does not speak; returns the read otherwise, including `absent`.
 *
 * IT THROWS RATHER THAN RETURNING A FLAG on purpose: a caller that forgets to check a boolean reads
 * the directory anyway, which is precisely the silent-empty-history failure this replaces. A thrown
 * error cannot be ignored by omission.
 */
export function assertLayoutSupported(
  dir: string,
  expected: { version: number; producer: string },
): LayoutRead {
  const read = readLayoutManifest(dir)
  if (read.state === 'absent') return read
  if (read.state === 'unreadable') {
    throw new LayoutUnsupportedError(dir, expected.version, read.detail)
  }
  if (read.manifest.layout !== expected.version) {
    throw new LayoutUnsupportedError(
      dir,
      expected.version,
      `written with layout ${read.manifest.layout} by ${read.manifest.producer || 'an unknown producer'}, ` +
        `but this build speaks layout ${expected.version}; refusing to read it rather than guess`,
      read.manifest.layout,
    )
  }
  return read
}

/**
 * Publish this side's layout. Idempotent BY CONTENT: an unchanged manifest is not rewritten, so an
 * activation does not touch the directory's mtime and no watcher sees a phantom change.
 */
export function writeLayoutManifest(dir: string, manifest: LayoutManifest): boolean {
  const body = `${JSON.stringify({ layout: manifest.layout, producer: manifest.producer, files: [...manifest.files] }, null, 2)}\n`
  const path = join(dir, LAYOUT_MANIFEST_FILE)
  try {
    if (existsSync(path) && readFileSync(path, 'utf8') === body) return false
  } catch {
    // unreadable → fall through and rewrite
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, body, 'utf8')
  return true
}
