/**
 * v1.5.0 — NEGATIVE MERGE AND CONFLICT EDGES.
 *
 * THE BUG THIS PINS
 *
 * `appendNegatives` located the duplicate with a guard on the WHOLE conflict list:
 *
 *     existing.find((record) => plan.conflicts.length === 0 && symptom === … && cause === …)
 *
 * `plan.conflicts` lists every existing row that shares the symptom and differs in cause — it
 * says nothing about the candidate in hand. So once the store held BOTH a duplicate and a variant,
 * the guard was false, `find` returned undefined, and the row was neither merged nor linked.
 *
 * The symptom is invisible unless the store is seeded in a specific ORDER (variant first), which
 * is why the earlier A/B run passed while the conflict edges were silently empty.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const WS = process.cwd()
const store = await import(pathToFileURL(join(WS, 'lib/store.js')).href)
const ledger = await import(pathToFileURL(join(WS, 'lib/ledger-cache.js')).href)

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-negmerge-'))
  const memoryDir = join(root, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  return { root, memoryDir }
}

function readNegatives(memoryDir) {
  try {
    return readFileSync(join(memoryDir, 'negatives.jsonl'), 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function add(memoryDir, root, symptom, cause, seq) {
  return store.appendNegatives(
    memoryDir,
    [{ symptom, cause, avoid: `avoid-${cause}`, evidence: [seq] }],
    { sessionId: 's', boundarySeq: seq, workspace: root, provenance: 'inferred' },
  )
}

test('negative merge: same symptom+cause merges — hits increments and evidence unions', () => {
  const { root, memoryDir } = fixture()
  add(memoryDir, root, 'deploy fails', 'cause-A', 1)
  add(memoryDir, root, 'deploy fails', 'cause-A', 2)
  add(memoryDir, root, 'deploy fails', 'cause-A', 3)
  ledger.flushAllLedgers()

  const rows = readNegatives(memoryDir)
  assert.equal(rows.length, 1, 'three identical incidents are ONE rule')
  assert.equal(rows[0].hits, 3, 'the re-hit count is the confidence signal')
  assert.equal(rows[0].evidence.length, 3, 'every sighting is kept as evidence')
  rmSync(root, { recursive: true, force: true })
})

test('negative merge: same symptom, DIFFERENT cause stays two rows', () => {
  const { root, memoryDir } = fixture()
  add(memoryDir, root, 'deploy fails', 'cause-A', 1)
  add(memoryDir, root, 'deploy fails', 'cause-B', 2)
  ledger.flushAllLedgers()

  const rows = readNegatives(memoryDir)
  assert.equal(rows.length, 2, 'two different root causes are two different lessons')
  rmSync(root, { recursive: true, force: true })
})

test('negative merge: a duplicate still merges when a VARIANT already exists (the regression)', () => {
  const { root, memoryDir } = fixture()
  /**
   * THE ORDER THAT EXPOSED THE BUG: variant first, then the duplicate.
   * Before the fix this produced 3 rows — the third was appended instead of merged.
   */
  add(memoryDir, root, 'deploy fails', 'cause-A', 1)
  add(memoryDir, root, 'deploy fails', 'cause-B', 2)
  add(memoryDir, root, 'deploy fails', 'cause-A', 3)
  ledger.flushAllLedgers()

  const rows = readNegatives(memoryDir)
  assert.equal(rows.length, 2, 'the third incident merges into cause-A, it does not add a row')
  const causeA = rows.find((row) => row.cause === 'cause-A')
  assert.equal(causeA.hits, 2)
  assert.equal(causeA.evidence.length, 2)
  rmSync(root, { recursive: true, force: true })
})

test('negative merge: the NEW variant names the existing row it conflicts with', () => {
  const { root, memoryDir } = fixture()
  /**
   * WHY ONLY ONE DIRECTION HERE, AND THE OTHER IN THE NEXT TEST
   *
   * When `cause-B` arrives, `cause-A` is already on disk and cannot be rewritten by accident of
   * this call — the store records the edge on the NEW row, pointing back at the existing one. The
   * existing row learns about the variant on its next repeat (next test).
   *
   * Asserting both directions here would demand that a write reach back and mutate a row it was
   * not asked to touch, which is a different (and riskier) contract than this store has.
   */
  add(memoryDir, root, 'deploy fails', 'cause-A', 1)
  add(memoryDir, root, 'deploy fails', 'cause-B', 2)
  ledger.flushAllLedgers()

  const rows = readNegatives(memoryDir)
  const causeB = rows.find((row) => row.cause === 'cause-B')
  assert.ok(Array.isArray(causeB.conflictsWith) && causeB.conflictsWith.length > 0, 'the new variant names the row it differs from')
  rmSync(root, { recursive: true, force: true })
})

test('negative merge: a repeat of an existing row attaches newly discovered conflicts', () => {
  const { root, memoryDir } = fixture()
  /**
   * The duplicate existed BEFORE the variant. Attaching the edge only at creation would leave it
   * permanently unlinked, so a repeat has to be able to repair the row.
   */
  add(memoryDir, root, 'deploy fails', 'cause-A', 1)
  add(memoryDir, root, 'deploy fails', 'cause-B', 2)
  add(memoryDir, root, 'deploy fails', 'cause-A', 3)
  ledger.flushAllLedgers()

  const causeA = readNegatives(memoryDir).find((row) => row.cause === 'cause-A')
  assert.ok(Array.isArray(causeA.conflictsWith) && causeA.conflictsWith.length > 0, 'cause-A now knows about cause-B')
  rmSync(root, { recursive: true, force: true })
})

test('fact merge: identical text merges, different text appends', () => {
  const { root, memoryDir } = fixture()
  const meta = { sessionId: 's', boundarySeq: 1, workspace: root, provenance: 'inferred' }
  store.appendFacts(memoryDir, [{ text: 'same observation', seq: 1, scene: 't' }], meta)
  store.appendFacts(memoryDir, [{ text: 'same observation', seq: 2, scene: 't' }], meta)
  store.appendFacts(memoryDir, [{ text: 'different observation', seq: 3, scene: 't' }], meta)
  ledger.flushAllLedgers()

  const rows = readFileSync(join(memoryDir, 'facts.jsonl'), 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.equal(rows.length, 2)
  const repeated = rows.find((row) => row.text === 'same observation')
  assert.equal(repeated.hits, 2)
  assert.equal(repeated.evidence.length, 2)
  rmSync(root, { recursive: true, force: true })
})
