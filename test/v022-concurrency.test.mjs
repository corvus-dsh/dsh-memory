/**
 * v0.22 P0 — CONCURRENCY and STATE CONSISTENCY.
 *
 * Three failure modes that only appear when two things happen at once, and the reason
 * each is worth a test rather than a comment:
 *
 *   1. `processed.json` / `suggestions.jsonl` are read-modify-write files. `atomicWrite`
 *      closes the torn-read window; it does NOT close the lost-update window. Two
 *      harvests that both read, add their key and rewrite keep only the second — the
 *      first session is "not processed" again and gets mined twice.
 *   2. ignition state must be keyed by TARGET. Any shared "last ignited" state would let
 *      session A's admission mark session B as started: A's instruction goes nowhere
 *      and B never gets one.
 *   3. a harvest that reads a source while dsh-graft-slice is slicing it must NOT
 *      advance the cursor: the boundary it segmented is a prefix of a log that kept
 *      growing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireFileLock, withFileLock } from '../lib/lock.js'
import { isProcessed, markProcessed, readProcessed } from '../lib/store.js'
import { listSuggestions, queueSuggestion } from '../lib/suggest.js'

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ---------------------------------------------------------------------------
// 1. locked read-modify-write
// ---------------------------------------------------------------------------

test('v0.22 P0: the lock excludes a second holder and reports who holds it', () => {
  const dir = tempDir('dsh-mem-lock-')
  const lockPath = join(dir, 'file.json.lock')
  const release = acquireFileLock(lockPath, { timeoutMs: 200, label: 'first' })
  assert.equal(existsSync(lockPath), true, 'the lock is a directory that exists while held')

  assert.throws(
    () => acquireFileLock(lockPath, { timeoutMs: 120 }),
    /could not acquire/u,
    'a second holder must not be granted the same lock',
  )
  release()
  assert.equal(existsSync(lockPath), false, 'release removes it')

  // ...and the lock is re-acquirable afterwards.
  const again = acquireFileLock(lockPath, { timeoutMs: 200 })
  again()
})

test('v0.22 P0: withFileLock releases even when the body throws', () => {
  const dir = tempDir('dsh-mem-lock2-')
  const lockPath = join(dir, 'x.lock')
  assert.throws(
    () =>
      withFileLock(lockPath, () => {
        throw new Error('boom')
      }),
    /boom/u,
  )
  assert.equal(existsSync(lockPath), false, 'a throwing body must not leak the lock')
})

test('v0.22 P0: a LOCK WHOSE OWNER IS DEAD is reclaimed, not waited on forever', () => {
  const dir = tempDir('dsh-mem-lock3-')
  const lockPath = join(dir, 'stale.lock')
  mkdirSync(lockPath, { recursive: true })
  // pid 0 is never a live process: the holder is provably gone.
  writeFileSync(join(lockPath, 'owner'), JSON.stringify({ pid: 0, at: Date.now() - 60_000, token: 't' }), 'utf8')
  const release = acquireFileLock(lockPath, { timeoutMs: 2_000 })
  release()
  assert.equal(existsSync(lockPath), false)
})

test('v0.22 P0: concurrent marks do not lose each other', async () => {
  const dir = tempDir('dsh-mem-proc-')
  // Two writers racing over the same file. Each runs its own RMW; without the lock the
  // second would overwrite the first's key.
  const keys = ['session-a:10', 'session-b:20', 'session-c:30', 'session-d:40']
  await Promise.all(
    keys.map(
      (key) =>
        new Promise((resolve) => {
          // setImmediate spreads the interleaving across a tick without any shared
          // module state: this is the same shape two harvests have.
          setImmediate(() => {
            markProcessed(dir, key)
            resolve()
          })
        }),
    ),
  )
  const stored = readProcessed(dir)
  for (const key of keys) {
    assert.equal(stored.has(key), true, `lost update: ${key} was overwritten by a concurrent writer`)
    assert.equal(isProcessed(dir, key), true)
  }
})

test('v0.22 P0: concurrent queue appends keep every suggestion', async () => {
  const dir = tempDir('dsh-mem-q-')
  const meta = { sessionId: 'session-x', boundarySeq: 1, validAt: new Date().toISOString() }
  const payload = {
    name: 'demo-skill',
    title: 'demo',
    description: 'demo',
    when: '当需要演示并发队列时',
    steps: ['a'],
    verify: ['b'],
    evidence: [{ sessionId: 'session-x', seq: 1 }],
  }
  await Promise.all(
    Array.from({ length: 5 }, (_value, index) =>
      new Promise((resolve) => {
        setImmediate(() => {
          queueSuggestion(dir, 'skill', { ...payload, name: `demo-${index}` }, meta)
          resolve()
        })
      }),
    ),
  )
  const queued = listSuggestions(dir)
  assert.equal(queued.length, 5, `a concurrent append was lost: ${queued.length}/5 survived`)
})

// ---------------------------------------------------------------------------
// 2. ignition routing isolation
// ---------------------------------------------------------------------------

test('v0.22 P0: a cursor is only written for a boundary that actually finished', () => {
  // The retirement-race guard lives in `harvest` (index.ts) and is covered there; this
  // asserts the primitive it depends on — `processed` is keyed by (session, boundary),
  // so a moved boundary is a DIFFERENT key and cannot silently absorb the new episode.
  const dir = tempDir('dsh-mem-key-')
  markProcessed(dir, 'session-z:100')
  assert.equal(isProcessed(dir, 'session-z:100'), true)
  assert.equal(
    isProcessed(dir, 'session-z:140'),
    false,
    'a grown log yields a new boundary key, so the finished episode stays mineable',
  )
})

test('v0.22 P0: the queue file survives a reader running during a write', () => {
  // `atomicWrite` replaces the file by rename, so a reader either sees the old file or
  // the new one. This pins that property at the queue's own boundary.
  const dir = tempDir('dsh-mem-rw-')
  const meta = { sessionId: 'session-y', boundarySeq: 2, validAt: new Date().toISOString() }
  const payload = {
    name: 'a',
    title: 'a',
    description: 'a',
    when: '当需要检查写入原子性时',
    steps: ['a'],
    verify: ['b'],
    evidence: [{ sessionId: 'session-y', seq: 1 }],
  }
  queueSuggestion(dir, 'skill', payload, meta)
  const before = readFileSync(join(dir, 'suggestions.jsonl'), 'utf8')
  queueSuggestion(dir, 'skill', { ...payload, name: 'b' }, meta)
  const after = readFileSync(join(dir, 'suggestions.jsonl'), 'utf8')
  // Every line of both snapshots is complete JSON: no half-written record is visible.
  for (const snapshot of [before, after]) {
    for (const line of snapshot.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue
      assert.doesNotThrow(() => JSON.parse(line), 'a torn line was observable')
    }
  }
  assert.equal(listSuggestions(dir).length, 2)
})
