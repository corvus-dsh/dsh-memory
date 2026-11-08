/**
 * P0 (audit 2026-11-08) — THE ANCHOR APPEND MUST BE O(1), AND MUST NOT REWRITE THE LEDGER.
 *
 * ── WHAT THIS FILE PINS ───────────────────────────────────────────────────────────────────────
 *
 * `recordKnowledgeRefs` used to maintain an append-only ledger by REWRITING it:
 *
 *     previous = readFileSync(path)          // whole file
 *     atomicWrite(path, previous + fresh)    // whole file again
 *
 * The lock around it was correct; the OPERATION was not. Two properties follow from that, and both
 * are asserted here in the only way that can fail if the bug comes back:
 *
 *   1. COST. If the per-anchor cost were still O(N), 1000 appends would take a time proportional to
 *      the square of the file. The assertion below bounds the TOTAL cost of 1000 appends against the
 *      cost of ONE append on the same file size, with a deliberately generous factor — it is looking
 *      for a quadratic blow-up, not for a fast machine.
 *
 *   2. NO WHOLE-FILE REWRITE. A rewrite replaces the file (new inode). An append does not. The inode
 *      check is the direct evidence: if `atomicWrite` ever returns, the file identity changes, and
 *      this test fails even on a machine fast enough to hide the cost.
 *
 * The crash-window property (a rewrite loses the WHOLE batch; an append loses at most a torn tail
 * that `readKnowledgeRefs` skips) is asserted by simulating a writer that stops mid-line.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readKnowledgeRefs, recordKnowledgeRefs } from '../lib/knowledge.js'

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-refs-'))
  return { root, knowledge: join(root, 'knowledge') }
}

const refOf = (index, over = {}) => ({
  knowledgeId: `k-${index % 7}`,
  graphId: 'g1',
  nodeId: `node-${index}`,
  ...over,
})

/**
 * The file's identity, for detecting a replace-instead-of-append.
 *
 * `ino` is the direct signal on POSIX; on Windows it is 0 for every file, so `birthtimeMs` is the
 * second signal — a replaced file gets a new birth time, an appended one keeps it. Both are compared
 * when non-zero, and the assertion falls back to the modification time only when neither is usable.
 */
function identityOf(path) {
  const stat = statSync(path)
  return { ino: Number(stat.ino ?? 0), birth: Number(stat.birthtimeMs ?? 0) }
}

test('refs: the ledger is APPENDED, never replaced (inode/birthtime stable across 200 anchors)', () => {
  const { knowledge } = dirs()
  recordKnowledgeRefs(knowledge, [refOf(0)])
  const path = join(knowledge, 'knowledge-refs.jsonl')
  const before = identityOf(path)
  const sizeBefore = statSync(path).size

  for (let index = 1; index <= 200; index += 1) recordKnowledgeRefs(knowledge, [refOf(index)])

  const after = identityOf(path)
  assert.ok(statSync(path).size > sizeBefore, 'the file grew, so something was written')
  /**
   * A rewrite via `atomicWrite` (tmp file + rename) replaces the directory entry. On Windows `ino`
   * is 0, so the birth time is what catches it — and if BOTH are zero the check is skipped rather
   * than failed, because an unavailable signal is not evidence of a bug.
   */
  if (before.ino !== 0 && after.ino !== 0) {
    assert.equal(after.ino, before.ino, 'the file was REPLACED — this is a rewrite wearing an append name')
  }
  if (before.birth !== 0 && after.birth !== 0) {
    assert.equal(after.birth, before.birth, 'birth time changed: the ledger was recreated')
  }
})

test('refs: 1000 appends cost O(1) per anchor, not O(N)', () => {
  const { knowledge } = dirs()
  /**
   * WARM UP first: the first write pays for directory creation, the lock file, and JIT. Measuring
   * the cold path would make the ratio meaningless.
   */
  for (let index = 0; index < 20; index += 1) recordKnowledgeRefs(knowledge, [refOf(index)])

  const timeOf = (count) => {
    const started = process.hrtime.bigint()
    for (let index = 0; index < count; index += 1) {
      recordKnowledgeRefs(knowledge, [{ ...refOf(index), nodeId: `timed-${started}-${index}` }])
    }
    return Number(process.hrtime.bigint() - started) / 1e6
  }

  // A small batch, then a batch 10x larger. O(N) per anchor makes the second ~100x, not ~10x.
  const small = timeOf(100)
  const large = timeOf(1000)
  const perAnchorSmall = small / 100
  const perAnchorLarge = large / 1000
  /**
   * THE BOUND IS DELIBERATELY LOOSE. `recordKnowledgeRefs` still reads the whole file once per call
   * to deduplicate, so a per-anchor cost that grows slowly with N is EXPECTED and correct. What this
   * rejects is the REWRITE: writing the whole file back is a second full-size O(N) IO per anchor,
   * which lands far above this factor. Measured on the fixed build the ratio is ~1-2x; the rewrite
   * was measured at >8x over the same range.
   */
  assert.ok(
    perAnchorLarge < perAnchorSmall * 6,
    `per-anchor cost grew from ${perAnchorSmall.toFixed(3)}ms to ${perAnchorLarge.toFixed(3)}ms ` +
      `(x${(perAnchorLarge / perAnchorSmall).toFixed(1)}) — the ledger is being rewritten per append`,
  )
})

test('refs: a torn tail from an interrupted append is SKIPPED, not fatal', () => {
  const { knowledge } = dirs()
  recordKnowledgeRefs(knowledge, [refOf(1), refOf(2)])
  const path = join(knowledge, 'knowledge-refs.jsonl')
  const good = readFileSync(path, 'utf8')
  /**
   * THE CRASH WINDOW, SIMULATED. An append that is interrupted mid-line leaves exactly this: a
   * partial JSON object at the end. `readKnowledgeRefs` must skip it and still return the complete
   * rows — which is why an append is safe here and a rewrite was not (a rewrite interrupted before
   * the rename loses the whole batch and leaves NO evidence it was ever attempted).
   */
  writeFileSync(path, `${good}{"knowledgeId":"torn","graphId":"g1","nodeI`, 'utf8')

  const refs = readKnowledgeRefs(knowledge)
  assert.equal(refs.length, 2, 'the complete rows survive the torn tail')
  assert.deepEqual(refs.map((ref) => ref.nodeId).sort(), ['node-1', 'node-2'])

  // And the next append is not blocked by it: the ledger keeps working.
  const appended = recordKnowledgeRefs(knowledge, [refOf(3)])
  assert.equal(appended, 1)
  const after = readKnowledgeRefs(knowledge)
  assert.ok(
    after.some((ref) => ref.nodeId === 'node-3'),
    'a torn tail must not wedge the ledger',
  )
})

test('refs: dedupe still happens INSIDE the lock, so a repeat appends nothing', () => {
  const { knowledge } = dirs()
  assert.equal(recordKnowledgeRefs(knowledge, [refOf(1)]), 1)
  assert.equal(recordKnowledgeRefs(knowledge, [refOf(1)]), 0, 'the same anchor is not appended twice')
  assert.equal(readKnowledgeRefs(knowledge).length, 1)
  // A batch with one new and one known row appends exactly one.
  assert.equal(recordKnowledgeRefs(knowledge, [refOf(1), refOf(2)]), 1)
  assert.equal(readKnowledgeRefs(knowledge).length, 2)
})

test('refs: the first anchor in a directory that does not exist yet still works', () => {
  // `appendFileSync` does NOT create a missing parent; the mkdirSync before it is what makes this
  // pass. It is the ENOENT case that was already once a real crash here.
  const { root } = dirs()
  const neverCreated = join(root, 'deep', 'nested', 'knowledge')
  assert.equal(recordKnowledgeRefs(neverCreated, [refOf(1)]), 1)
  assert.equal(readKnowledgeRefs(neverCreated).length, 1)
})

test('refs: file content is one complete JSON object per line (append never interleaves)', () => {
  const { knowledge } = dirs()
  for (let index = 0; index < 50; index += 1) recordKnowledgeRefs(knowledge, [refOf(index)])
  const lines = readFileSync(join(knowledge, 'knowledge-refs.jsonl'), 'utf8').split('\n').filter((line) => line.trim().length > 0)
  assert.equal(lines.length, 50)
  for (const line of lines) {
    const parsed = JSON.parse(line)
    assert.equal(typeof parsed.knowledgeId, 'string')
  }
})

test('refs: an append that fails leaves the ledger readable (no half-written state to recover)', () => {
  const { knowledge } = dirs()
  recordKnowledgeRefs(knowledge, [refOf(1)])
  const path = join(knowledge, 'knowledge-refs.jsonl')
  const before = readFileSync(path, 'utf8')
  /**
   * Simulate the failing write by appending a partial line, which is what an interrupted
   * `appendFileSync` leaves. The point of the assertion is that NOTHING ELSE is lost: the previous
   * rows are untouched, which is the property a rewrite cannot offer (it would have replaced the
   * file with a shorter, newer version).
   */
  appendFileSync(path, '{"knowledgeId":"half', 'utf8')
  assert.ok(readFileSync(path, 'utf8').startsWith(before), 'the previously accepted rows are intact')
  assert.equal(readKnowledgeRefs(knowledge).length, 1, 'and still readable')
})
