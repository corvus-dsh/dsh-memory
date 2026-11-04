/**
 * v0.23 P0 — THE STRUCTURAL GATE BEFORE AN OVERWRITE.
 *
 * `atomicWrite` was already tmp+rename, so a reader never saw half a file. That is
 * atomicity, not validity: it says the file changes all at once, not that what it
 * changed TO is a complete document.
 *
 * The gap this closes is narrow and real. An extraction model returns a reply that
 * stops mid-value — a token cap, a dropped chunk. The caller writes it. The write is
 * atomic, so the file is now atomically WRONG, and the previous good contents are
 * gone. The next reader meets a document that cannot parse, and every record after
 * the break is silently invisible.
 *
 * The rule under test: a `.json` store file is parsed BEFORE it replaces anything.
 * On failure nothing is overwritten, the payload is quarantined for inspection, and
 * the failure is loud.
 *
 * What is deliberately NOT done: repairing the document. A brace-matching heuristic
 * could turn `{"a":1,"b":` into something that parses, and the file would then claim
 * a value the model never produced. Refusing is the only safe answer.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { StoreWriteRejected, atomicWrite } from '../lib/store.js'

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('v0.23 P0: a complete JSON document is written normally', () => {
  const dir = tempDir('dsh-mem-gate-ok-')
  const path = join(dir, 'processed.json')
  atomicWrite(path, JSON.stringify({ a: 1, b: [2, 3] }, null, 2))
  assert.equal(existsSync(path), true)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { a: 1, b: [2, 3] })
})

test('v0.23 P0: a TRUNCATED document is refused and the good file survives', () => {
  const dir = tempDir('dsh-mem-gate-bad-')
  const path = join(dir, 'index.json')
  // The good state, already on disk.
  atomicWrite(path, JSON.stringify({ keep: 'this' }))
  const before = readFileSync(path, 'utf8')

  // A reply cut off mid-value: exactly what a token cap produces.
  const truncated = '{"keep":"this","broken":{"nested":[1,2'
  assert.throws(
    () => atomicWrite(path, truncated),
    (error) => {
      assert.equal(error instanceof StoreWriteRejected, true, 'the refusal has a name')
      assert.match(String(error.message), /refused to overwrite/u)
      assert.match(String(error.reason), /not a complete JSON document/u)
      return true
    },
  )

  // THE POINT: the previous contents are untouched. A failed write must be a no-op.
  assert.equal(readFileSync(path, 'utf8'), before, 'the good file must not be replaced by garbage')
})

test('v0.23 P0: the refused payload is quarantined so it can be inspected', () => {
  const dir = tempDir('dsh-mem-gate-quar-')
  const path = join(dir, 'suggestions.json')
  const truncated = '{"half": tru'
  let quarantine
  try {
    atomicWrite(path, truncated)
    assert.fail('must throw')
  } catch (error) {
    assert.equal(error instanceof StoreWriteRejected, true)
    quarantine = error.quarantinePath
  }
  assert.ok(quarantine, 'a quarantine path is reported')
  assert.equal(existsSync(quarantine), true, 'the offending bytes are on disk for inspection')
  assert.equal(readFileSync(quarantine, 'utf8'), truncated, 'byte-for-byte, so the break is diagnosable')
  assert.equal(existsSync(path), false, 'the destination was never created')
})

test('v0.23 P0: no .tmp- staging file is left behind by a refusal', () => {
  const dir = tempDir('dsh-mem-gate-tmp-')
  const path = join(dir, 'processed.json')
  atomicWrite(path, '{}')
  assert.throws(() => atomicWrite(path, '{"a":'), StoreWriteRejected)
  const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [], 'validation runs BEFORE the tmp file exists, so nothing is staged')
})

test('v0.23 P0: a NON-json path is not parsed (skills are markdown, jsonl is per-line)', () => {
  const dir = tempDir('dsh-mem-gate-md-')
  const md = join(dir, 'SKILL.md')
  // Deliberately not JSON. The gate is scoped by extension, so this must pass through.
  assert.doesNotThrow(() => atomicWrite(md, '---\nname: x\n---\n\n# x\n'))
  assert.equal(existsSync(md), true)

  const jsonl = join(dir, 'negatives.jsonl')
  assert.doesNotThrow(() => atomicWrite(jsonl, '{"a":1}\n{"b":2}\n'))
  assert.equal(existsSync(jsonl), true, 'a jsonl file is a stream of documents, not one document')
})

test('v0.23 P0: an empty document is allowed (a cleared store is valid)', () => {
  const dir = tempDir('dsh-mem-gate-empty-')
  const path = join(dir, 'processed.json')
  assert.doesNotThrow(() => atomicWrite(path, ''))
  assert.equal(existsSync(path), true)
})

test('v0.23 P0: a trailing-newline document still parses', () => {
  const dir = tempDir('dsh-mem-gate-nl-')
  const path = join(dir, 'processed.json')
  // `JSON.stringify([...keys], null, 2) + '\n'` is a real call site; a gate that
  // rejected it would break processed-cursor writes entirely.
  assert.doesNotThrow(() => atomicWrite(path, '["a","b"]\n'))
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), ['a', 'b'])
})

test('v0.23 P0: the REAL processed-cursor write path is covered end to end', () => {
  // The gate must protect the stores that actually matter, not just a synthetic call.
  // `markProcessed` writes processed.json through atomicWrite.
  const dir = tempDir('dsh-mem-gate-real-')
  const { markProcessed, readProcessed } = require_store()
  markProcessed(dir, 'session-a:10')
  assert.equal(readProcessed(dir).has('session-a:10'), true)
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(dir, 'processed.json'), 'utf8')))
})

/** Small indirection so the import stays at the top of the file. */
function require_store() {
  // eslint-disable-next-line global-require
  return storeApi
}

const storeApi = await import('../lib/store.js')
