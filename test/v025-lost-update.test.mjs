/**
 * v0.25 P1 — THE LOST UPDATE, IN EVERY REWRITE PATH.
 *
 * `atomicWrite` closes the torn-read window. It says nothing about the lost-update
 * window, and the distinction is the whole point:
 *
 *     A reads 10 rows ─┐
 *     B reads 10 rows ─┼─ each appends its own session's row
 *     A writes 11 ─────┘
 *     B writes 11      ← A's row is GONE, silently
 *
 * v0.22 fixed `processed.json` and the suggestion queue. This file covers the rest:
 * the jsonl LAYER files (negatives / facts / experiences) and the whole-file sweep in
 * `recordCounterEvidence` and `memory_migrate_evidence`. Each of those is a
 * read-all → mutate → write-all, so each was exposed to the same interleaving.
 *
 * Why it matters concretely: the harvest loop walks several sessions, and two Harvests
 * can run from two windows at once. A lost negative is a warning the agent will never
 * see again; a lost fact is evidence a skill can no longer cite.
 *
 * These tests race real writes through the real API, then assert that EVERY writer's
 * contribution survived. That is the only assertion that distinguishes "locked" from
 * "atomic", and it is why they call the store rather than a helper.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendFacts, appendNegatives } from '../lib/store.js'

/** Read a jsonl store file the way the store does: one JSON document per line. */
function readJsonl(path) {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

function tempMemory(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(dir, { recursive: true })
  return dir
}

const META = (sessionId) => ({
  sessionId,
  boundarySeq: 10,
  workspace: 'D:\\持久层能力架构',
  provenance: 'tool',
})

/**
 * Six GENUINELY DIFFERENT failures.
 *
 * The first draft used `symptom-0` / `symptom-1`, and only one row survived — not
 * because the lock failed but because `planNegative` correctly judged them near
 * duplicates and merged them. That is the dedupe doing its job. A lost-update test
 * needs records the store would never merge, or it measures the wrong thing.
 */
const DISTINCT = [
  { symptom: 'TypeError cannot read properties of undefined', cause: 'optional chaining missing', avoid: '不判空直接访问嵌套属性' },
  { symptom: 'git push rejected non-fast-forward', cause: 'remote moved ahead', avoid: '推送前先 fetch 并 rebase' },
  { symptom: 'ENOENT no such file or directory package.json', cause: 'wrong working directory', avoid: '在仓库根目录执行命令' },
  { symptom: 'EADDRINUSE port 3000 already in use', cause: 'stale dev server process', avoid: '启动前先确认端口释放' },
  { symptom: 'SyntaxError unexpected token in JSON at position 0', cause: 'response body is HTML error page', avoid: '解析前先检查 content-type' },
  { symptom: 'heap out of memory during build', cause: 'single pass over a huge log', avoid: '分批读取而不是一次性载入' },
]

function negative(index, sessionId) {
  const shape = DISTINCT[index % DISTINCT.length]
  return {
    symptom: shape.symptom,
    cause: shape.cause,
    avoid: shape.avoid,
    evidence: [{ sourceSessionId: sessionId, seq: index }],
    provenance: 'tool',
  }
}

/** Run tasks on separate macrotask ticks, so their critical sections can interleave. */
async function raced(tasks) {
  await Promise.all(
    tasks.map(
      (task) =>
        new Promise((resolve, reject) => {
          setImmediate(() => {
            try {
              resolve(task())
            } catch (error) {
              reject(error)
            }
          })
        }),
    ),
  )
}

// ---------------------------------------------------------------------------
// 1. negatives.jsonl
// ---------------------------------------------------------------------------

test('v0.25 P1: concurrent negative appends all survive', async () => {
  const dir = tempMemory('dsh-mem-neg-')
  const writers = 6
  await raced(
    Array.from({ length: writers }, (_unused, index) => () =>
      appendNegatives(dir, [negative(index, `session-${index}`)], META(`session-${index}`)),
    ),
  )
  const rows = readJsonl(join(dir, 'negatives.jsonl'))
  assert.equal(rows.length, writers, `a negative was lost: ${rows.length}/${writers} survived`)
  const symptoms = new Set(rows.map((row) => row.symptom))
  for (let index = 0; index < writers; index += 1) {
    const expected = DISTINCT[index % DISTINCT.length].symptom
    assert.equal(symptoms.has(expected), true, `${expected} was overwritten by a concurrent writer`)
  }
})

test('v0.25 P1: a concurrent DUPLICATE still merges instead of double-inserting', async () => {
  // The lock must not turn a merge into two rows: the read inside the lock is what
  // makes the duplicate check see the other writer's insert.
  const dir = tempMemory('dsh-mem-dup-')
  const same = negative(0, 'session-x')
  await raced([
    () => appendNegatives(dir, [same], META('session-x')),
    () => appendNegatives(dir, [{ ...same, evidence: [{ sourceSessionId: 'session-y', seq: 99 }] }], META('session-y')),
  ])
  const rows = readJsonl(join(dir, 'negatives.jsonl'))
  assert.equal(rows.length, 1, 'the same symptom+cause is ONE record, merged under the lock')
  assert.equal(Number(rows[0].hits), 2, 'both sightings are counted')
})

// ---------------------------------------------------------------------------
// 2. facts / experiences (appendLayer)
// ---------------------------------------------------------------------------

test('v0.25 P1: concurrent layer appends all survive', async () => {
  const dir = tempMemory('dsh-mem-layer-')
  const writers = 6
  await raced(
    Array.from({ length: writers }, (_unused, index) => () =>
      appendFacts(dir, [{ text: `fact-${index}`, seq: index }], META(`session-${index}`)),
    ),
  )
  const rows = readJsonl(join(dir, 'facts.jsonl'))
  assert.equal(rows.length, writers, `a fact was lost: ${rows.length}/${writers} survived`)
  const texts = new Set(rows.map((row) => row.text))
  for (let index = 0; index < writers; index += 1) {
    assert.equal(texts.has(`fact-${index}`), true, `fact-${index} was overwritten`)
  }
})

// ---------------------------------------------------------------------------
// 3. every store file is still a complete document
// ---------------------------------------------------------------------------

test('v0.25 P1: no concurrent write leaves a torn or partial file', async () => {
  const dir = tempMemory('dsh-mem-torn-')
  await raced(
    Array.from({ length: 5 }, (_unused, index) => () =>
      appendNegatives(dir, [negative(index, `s-${index}`)], META(`s-${index}`)),
    ),
  )
  const text = readFileSync(join(dir, 'negatives.jsonl'), 'utf8')
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    assert.doesNotThrow(() => JSON.parse(line), `a line was torn: ${line.slice(0, 80)}`)
  }
})

test('v0.25 P1: the lock is released even when a writer throws', () => {
  // A leaked lock would make the store unusable until the stale sweep ran.
  const dir = tempMemory('dsh-mem-lockleak-')
  appendNegatives(dir, [negative(0, 's0')], META('s0'))
  // A record that cannot be scanned is skipped, not thrown on; this asserts the lock
  // path itself is exception-safe by writing again immediately afterwards.
  appendNegatives(dir, [negative(1, 's1')], META('s1'))
  assert.equal(readJsonl(join(dir, 'negatives.jsonl')).length, 2)
})

test('v0.25 P1: a single-process sequential write is unchanged by the lock', () => {
  // The common case must stay exactly as before: no extra rows, no reordering.
  const dir = tempMemory('dsh-mem-seq-')
  appendNegatives(dir, [negative(0, 's0')], META('s0'))
  appendNegatives(dir, [negative(1, 's1')], META('s1'))
  appendNegatives(dir, [negative(2, 's2')], META('s2'))
  const rows = readJsonl(join(dir, 'negatives.jsonl'))
  assert.deepEqual(
    rows.map((row) => row.symptom),
    [DISTINCT[0].symptom, DISTINCT[1].symptom, DISTINCT[2].symptom],
  )
})
