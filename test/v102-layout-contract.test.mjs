/**
 * P1-2 (audit 2026-11-08) — THE CROSS-PLUGIN LAYOUT CONTRACT, PINNED WITH LITERALS.
 *
 * ── WHY LITERALS AND NOT IMPORTS ──────────────────────────────────────────────────────────────
 *
 * `dsh-memory` must never import `dsh-graft-slice`: either plugin has to survive being uninstalled
 * alone. So the contract cannot be a shared constant — it is a set of file names and a version number
 * that BOTH sides state independently, in prose, in their own code.
 *
 * That is exactly the shape that drifts silently: one side renames a ledger, the other keeps looking
 * for the old name and reads an empty history without an error. The defence is to write the expected
 * literals HERE, where a test fails the moment this side's expectation changes — and to keep the SAME
 * literal block in `dsh-graft-slice/test/v102-layout-contract.test.mjs`, which fails if the WRITER
 * changes. `_scratch/check-layout-contract.mjs` compares the two sides' published manifests directly.
 *
 * These tests therefore do not import the other plugin's constants. They hard-code them. That is the
 * point of the file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  GRAFT_LEDGER_FILES,
  GRAFT_LEDGER_LAYOUT_VERSION,
  LAYOUT_MANIFEST_FILE,
  LayoutUnsupportedError,
  MEMORY_LAYOUT_FILES,
  MEMORY_LAYOUT_VERSION,
  assertLayoutSupported,
  readLayoutManifest,
  writeLayoutManifest,
} from '../lib/layout.js'
import { describeLedgerSkips, describeMissingLedgerDir, readLedgers } from '../lib/ledger.js'
import { apply, harvest } from '../lib/index.js'

/** ── THE CONTRACT, AS LITERALS. Copied verbatim into graft's test; divergence is the alarm. ── */

/** What `dsh-graft-slice` writes into its ledger directory. */
const GRAFT_MANIFEST_LITERAL = {
  layout: 1,
  producer: 'dsh-graft-slice',
  files: ['.retired.json', '.transferred.json'],
}

/** What this plugin writes into its own store — the layout graft reads. */
const MEMORY_MANIFEST_LITERAL = {
  layout: 1,
  producer: 'dsh-memory',
  files: ['negatives.jsonl', 'facts.jsonl', 'experiences.jsonl', 'suggestions.jsonl'],
}

const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix))
const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, LAYOUT_MANIFEST_FILE), 'utf8'))

test('P1-2: the graft ledger layout this reader expects is pinned to literals', () => {
  assert.equal(LAYOUT_MANIFEST_FILE, '.layout.json')
  assert.deepEqual([...GRAFT_LEDGER_FILES], GRAFT_MANIFEST_LITERAL.files)
  assert.equal(GRAFT_LEDGER_LAYOUT_VERSION, GRAFT_MANIFEST_LITERAL.layout)
})

test('P1-2: this reader must be able to parse the very manifest graft publishes', () => {
  /**
   * The manifest graft writes is asserted here against the SAME literal graft's own test asserts.
   * If graft renames a ledger and bumps its list, its test goes red; if this reader's expectation
   * changes, this test goes red. Neither can move alone.
   */
  const dir = temp('dsh-memory-layout-graft-')
  writeFileSync(join(dir, LAYOUT_MANIFEST_FILE), `${JSON.stringify(GRAFT_MANIFEST_LITERAL, null, 2)}\n`, 'utf8')
  const read = assertLayoutSupported(dir, { version: GRAFT_LEDGER_LAYOUT_VERSION, producer: 'dsh-graft-slice' })
  assert.equal(read.state, 'present')
  assert.deepEqual(read.manifest.files, ['.retired.json', '.transferred.json'])
})

test('P1-2: the manifest this plugin publishes is pinned byte for byte', () => {
  const dir = temp('dsh-memory-layout-own-')
  assert.equal(
    writeLayoutManifest(dir, { layout: MEMORY_LAYOUT_VERSION, producer: 'dsh-memory', files: MEMORY_LAYOUT_FILES }),
    true,
  )
  assert.deepEqual(manifestOf(dir), MEMORY_MANIFEST_LITERAL)
})

test('P1-2: publishing is idempotent by content — a reload must not touch the directory', () => {
  const dir = temp('dsh-memory-layout-idem-')
  const manifest = { layout: MEMORY_LAYOUT_VERSION, producer: 'dsh-memory', files: MEMORY_LAYOUT_FILES }
  assert.equal(writeLayoutManifest(dir, manifest), true, 'the first activation writes it')
  assert.equal(writeLayoutManifest(dir, manifest), false, 'a reload must not rewrite an unchanged manifest')
})

test('P1-2: an unknown layout THROWS LAYOUT_UNSUPPORTED rather than being guessed at', () => {
  const dir = temp('dsh-memory-layout-future-')
  writeFileSync(
    join(dir, LAYOUT_MANIFEST_FILE),
    JSON.stringify({ layout: 2, producer: 'dsh-graft-slice', files: ['.retired.json', '.transferred.json'] }),
    'utf8',
  )
  assert.throws(
    () => assertLayoutSupported(dir, { version: GRAFT_LEDGER_LAYOUT_VERSION, producer: 'dsh-graft-slice' }),
    (error) => {
      assert.ok(error instanceof LayoutUnsupportedError, 'the refusal is a named error, not a string')
      assert.equal(error.code, 'LAYOUT_UNSUPPORTED')
      assert.equal(error.expected, 1)
      assert.equal(error.found, 2)
      assert.match(error.message, /LAYOUT_UNSUPPORTED/u)
      return true
    },
  )
})

test('P1-2: a torn manifest is refused too — unreadable is not proof of an understood layout', () => {
  const dir = temp('dsh-memory-layout-torn-')
  writeFileSync(join(dir, LAYOUT_MANIFEST_FILE), '{ "layout": ', 'utf8')
  assert.throws(
    () => assertLayoutSupported(dir, { version: GRAFT_LEDGER_LAYOUT_VERSION, producer: 'dsh-graft-slice' }),
    (error) => error.code === 'LAYOUT_UNSUPPORTED',
  )
  assert.equal(readLayoutManifest(dir).state, 'unreadable')
})

test('P1-2: an ABSENT manifest still reads — otherwise every existing install breaks on upgrade', () => {
  const dir = temp('dsh-memory-layout-legacy-')
  assert.deepEqual(assertLayoutSupported(dir, { version: GRAFT_LEDGER_LAYOUT_VERSION, producer: 'dsh-graft-slice' }), {
    state: 'absent',
  })
})

test('P1-2: an unknown layout refuses the WHOLE directory, even with a perfectly readable ledger in it', () => {
  const dir = temp('dsh-memory-layout-refuse-')
  writeFileSync(
    join(dir, '.retired.json'),
    JSON.stringify({ epoch: 2, at: new Date().toISOString(), pid: 1, payload: ['session-a', 'session-b'] }),
    'utf8',
  )
  writeFileSync(join(dir, LAYOUT_MANIFEST_FILE), JSON.stringify({ layout: 2, producer: 'dsh-graft-slice', files: [] }), 'utf8')

  const snapshot = readLedgers(dir)
  /**
   * THE POINT OF THE WHOLE MECHANISM: the ledger parses fine, and it is STILL not read. Half a
   * history is worse than none — a harvest would attribute work to a handoff it only partly saw.
   */
  assert.deepEqual(snapshot.retired, [], 'not one id may be taken from a directory whose layout is unknown')
  assert.deepEqual(snapshot.transferred, {})
  assert.equal(snapshot.deferred, true, 'a retry is owed, so the caller must not treat this as "no history"')
  assert.equal(snapshot.skipped.length, 1)
  assert.equal(snapshot.skipped[0].reason, 'layout-unsupported')
  assert.match(describeLedgerSkips(snapshot), /LAYOUT_UNSUPPORTED/u)
  assert.match(describeLedgerSkips(snapshot), /layout 2/u, 'the message names what was found')
  assert.match(describeLedgerSkips(snapshot), /layout 1/u, 'and what this build speaks')
})

test('P1-2: ACTIVATION publishes the manifest, before anything has been recorded', () => {
  /**
   * The marker is written at activation rather than on the first write, because the reader on the
   * other side may look at a brand-new store at any moment: a manifest that only appears after the
   * first harvest makes the first read of a fresh store unversioned by construction.
   */
  const memoryDir = temp('dsh-memory-layout-activate-')
  const ctx = {
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
    tools: { register: () => {} },
    sessionQuery: { readSession: async () => ({ events: [] }) },
  }
  apply(ctx, { memoryDir, skillsDir: join(memoryDir, 'skills'), graftDataDir: temp('dsh-memory-layout-graftdata-') })

  assert.deepEqual(manifestOf(memoryDir), MEMORY_MANIFEST_LITERAL, 'activation must publish the store layout')
})

test('P1-2 REGRESSION: a matching manifest changes nothing about the read', () => {
  const dir = temp('dsh-memory-layout-ok-')
  writeFileSync(join(dir, LAYOUT_MANIFEST_FILE), JSON.stringify(GRAFT_MANIFEST_LITERAL), 'utf8')
  writeFileSync(
    join(dir, '.retired.json'),
    JSON.stringify({ epoch: 2, at: new Date().toISOString(), pid: 1, payload: ['session-a'] }),
    'utf8',
  )
  writeFileSync(
    join(dir, '.transferred.json'),
    JSON.stringify({ epoch: 2, at: new Date().toISOString(), pid: 1, payload: { 'session-a': { newSessionId: 'session-b', at: 7 } } }),
    'utf8',
  )
  const snapshot = readLedgers(dir)
  assert.deepEqual(snapshot.retired, ['session-a'])
  assert.equal(snapshot.transferred['session-a'].newSessionId, 'session-b')
  assert.equal(snapshot.deferred, false)
  assert.equal(snapshot.layoutRefusal, undefined)
})

test('P1-2 REGRESSION: a legacy directory with no manifest reads exactly as before', () => {
  const dir = temp('dsh-memory-layout-legacy-read-')
  writeFileSync(
    join(dir, '.retired.json'),
    JSON.stringify({ epoch: 2, at: new Date().toISOString(), pid: 1, payload: ['session-a', 'session-b'] }),
    'utf8',
  )
  const snapshot = readLedgers(dir)
  assert.deepEqual(snapshot.retired, ['session-a', 'session-b'])
  assert.equal(snapshot.deferred, false)
})

/* ── THE LIVE FINDING: AN ABSENT DIRECTORY IS NOT AN EMPTY HISTORY ─────────────────────────────
 *
 * Measured on the running host (2026-11-08): this reader looked in `<data>/../dsh-graft-slice`, the
 * slicing plugin's store had resolved to its own package directory, and the snapshot said
 * `retired: []` — identical to "nothing was ever retired", with no complaint anywhere. Retirement
 * mining simply never ran.
 *
 * "I cannot see the directory" and "there is nothing in it" have different next actions, so they must
 * not produce the same sentence. These tests pin the distinction, and pin that it does NOT become a
 * deferral: nothing in a directory that is not there can be misread, so no gate may change.
 */

test('P1-4 LIVE: an ABSENT ledger directory is reported as such, not as "no retired sessions"', () => {
  const absent = join(temp('dsh-memory-layout-absent-'), 'dsh-graft-slice')
  const snapshot = readLedgers(absent)
  assert.deepEqual(snapshot.retired, [])
  assert.equal(snapshot.directory.present, false, 'the snapshot must say the directory was not there')
  assert.equal(snapshot.directory.path, absent, 'and name where it looked')
  assert.equal(snapshot.deferred, false, 'an absent directory is not untrustworthy — there is nothing to misread')
  const line = describeMissingLedgerDir(snapshot)
  assert.match(line, /not found/u)
  assert.match(line, /dsh-graft-slice/u)
  assert.ok(line.includes(absent), 'the sentence carries the path an operator needs')
  assert.match(line, /never "nothing was retired"/u, 'and refuses the conclusion it cannot support')
})

test('P1-4 LIVE: a directory that EXISTS and is merely empty stays quiet (no false alarm)', () => {
  const empty = temp('dsh-memory-layout-empty-')
  const snapshot = readLedgers(empty)
  assert.equal(snapshot.directory.present, true)
  assert.deepEqual(snapshot.retired, [])
  assert.equal(describeMissingLedgerDir(snapshot), '', 'an empty store is a normal first run, not a fault')
})

test('P1-4 LIVE: harvest says the ledger directory is missing instead of mining nothing quietly', async () => {
  const missing = join(temp('dsh-memory-layout-harvest-absent-'), 'dsh-graft-slice')
  const memoryDir = temp('dsh-memory-layout-harvest-store-')
  const ctx = {
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
    sessionQuery: { readSession: async () => ({ events: [] }) },
  }
  const report = await harvest(ctx, { memoryDir, skillsDir: join(memoryDir, 'skills'), graftDataDir: missing, extractor: 'off' })
  assert.equal(report.scanned, 0)
  assert.ok(
    report.warnings.some((warning) => warning.includes('handoff ledger directory not found')),
    `the report must name the missing directory: ${JSON.stringify(report.warnings)}`,
  )
  assert.ok(report.warnings.some((warning) => warning.includes(missing)), 'and carry the path it looked in')
})

test('P1-4 LIVE: a present, empty ledger directory adds NO such warning', async () => {
  const empty = temp('dsh-memory-layout-harvest-empty-')
  const memoryDir = temp('dsh-memory-layout-harvest-store2-')
  const ctx = {
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
    sessionQuery: { readSession: async () => ({ events: [] }) },
  }
  const report = await harvest(ctx, { memoryDir, skillsDir: join(memoryDir, 'skills'), graftDataDir: empty, extractor: 'off' })
  assert.equal(
    report.warnings.some((warning) => warning.includes('handoff ledger directory not found')),
    false,
    'a first run in an empty store must not read as a deployment fault',
  )
})
