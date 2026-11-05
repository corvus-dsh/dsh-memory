/**
 * v0.30 — THE LOCK IS A LEASE. These tests pin the MECHANISM, not just the outcome.
 *
 * WHY THE MECHANISM NEEDS ITS OWN TESTS
 *
 * The lock that this replaced passed its own tests and still corrupted stores: the failure needed
 * contention AND load, and it presented as `ENOENT ... .lock/owner` from a writer that had already WON
 * the lock. A test that only asserts "two writers both survive" passes on a quiet machine with the racy
 * implementation. So the properties below are the ones that make the race impossible rather than
 * unlikely:
 *
 *   1. THE RECORD IS A FILE, written by temp+rename. The old lock was a DIRECTORY with an `owner` file
 *      written in a second, non-atomic step — the window a reclaimer could delete through.
 *   2. A LEGACY DIRECTORY IS RECLAIMED. An upgrade must not brick a store because the old artifact is
 *      still on disk and unreadable by the new code.
 *   3. A YOUNG UNREADABLE FILE IS NOT STOLEN. That is the other direction, and it is what keeps the
 *      reclamation from becoming a licence to double-grant a live holder.
 *   4. THE RECORD CARRIES owner + epoch, which is the FENCE the layer hands back.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireFileLock, withFileLock, isLockHeld } from '../lib/lock.js'

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('v0.30: the lock record is a FILE written atomically, not a directory with a second write', () => {
  const dir = tempDir('dsh-mem-lease-')
  const lockPath = join(dir, 'negatives.jsonl.lock')
  const release = acquireFileLock(lockPath, { timeoutMs: 2_000, label: 'writer' })

  /**
   * THE ASSERTION THE OLD DESIGN WOULD FAIL. `readFileSync` on the old lock threw EISDIR, and the
   * `owner` file inside it was written by a SEPARATE call — the step a reclaimer could interleave with.
   */
  const raw = readFileSync(lockPath, 'utf8')
  const record = JSON.parse(raw)
  assert.equal(typeof record.owner, 'string')
  assert.equal(typeof record.epoch, 'number')
  assert.equal(typeof record.expiresAt, 'number')
  assert.equal(record.label, 'writer', 'the label travels with the lease, for diagnosing a stuck lock')
  assert.equal(isLockHeld(lockPath), true)

  release()
  assert.equal(isLockHeld(lockPath), false, 'release removes the record')
})

test('v0.30: a leftover DIRECTORY lock from the previous version is reclaimed, not waited on', () => {
  const dir = tempDir('dsh-mem-lease-legacy-')
  const lockPath = join(dir, 'processed.json.lock')
  /**
   * EXACTLY the artifact the old implementation left behind: a directory with an `owner` file. The new
   * lease cannot parse it, so without reclamation the store would be permanently locked by a dead
   * upgrade — the failure mode this test exists to prevent.
   */
  mkdirSync(lockPath, { recursive: true })
  writeFileSync(join(lockPath, 'owner'), JSON.stringify({ pid: 0, at: Date.now() - 60_000, token: 't' }), 'utf8')

  const release = acquireFileLock(lockPath, { timeoutMs: 2_000 })
  const record = JSON.parse(readFileSync(lockPath, 'utf8'))
  assert.equal(typeof record.epoch, 'number', 'the legacy artifact was replaced by a real lease record')
  release()
  assert.equal(isLockHeld(lockPath), false)
})

test('v0.30: a YOUNG unreadable record is NOT stolen — reclamation is for leftovers only', () => {
  const dir = tempDir('dsh-mem-lease-corrupt-')
  const lockPath = join(dir, 'facts.jsonl.lock')
  /**
   * A corrupt record whose holder may be alive. Stealing it would grant a SECOND holder while the first
   * still believes it is alone — the double-grant this whole design forbids. The lock must instead be
   * reported as held, and the caller must time out rather than proceed.
   */
  writeFileSync(lockPath, '{ this is not valid json', 'utf8')
  assert.throws(
    () => acquireFileLock(lockPath, { timeoutMs: 150 }),
    /could not acquire/u,
    'an unreadable, recently-modified record must not be reclaimed on sight',
  )
})

test('v0.30: repeated contention keeps exactly one winner per round', () => {
  /**
   * THE RACE, RUN MANY TIMES. One round proves little: the old defect needed a reclaimer to land inside a
   * sub-millisecond window. Twenty rounds of acquire-while-held makes that window get hit if it exists —
   * and it is deliberately inside ONE process, where the old `mkdir` version was also broken.
   */
  const dir = tempDir('dsh-mem-lease-stress-')
  const lockPath = join(dir, 'stress.lock')
  for (let round = 0; round < 20; round += 1) {
    const release = acquireFileLock(lockPath, { timeoutMs: 2_000 })
    assert.throws(() => acquireFileLock(lockPath, { timeoutMs: 40 }), /could not acquire/u, `round ${round}`)
    release()
    assert.equal(isLockHeld(lockPath), false, `round ${round}: released`)
  }
})

test('v0.30: withFileLock still returns the body value and releases on every path', () => {
  const dir = tempDir('dsh-mem-lease-wfl-')
  const lockPath = join(dir, 'value.lock')
  assert.equal(withFileLock(lockPath, () => 42), 42, 'the synchronous contract is unchanged')
  assert.equal(isLockHeld(lockPath), false)
  assert.throws(() => withFileLock(lockPath, () => {
    throw new Error('body failed')
  }), /body failed/u)
  assert.equal(isLockHeld(lockPath), false, 'a throwing body must not leave the lock behind')
})
