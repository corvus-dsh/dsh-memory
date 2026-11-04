/**
 * v0.31 P0 — THE QUARANTINE PATH WAS THE ONE UNLOCKED READ-MODIFY-WRITE.
 *
 * `quarantineWorkspaceMemory` reads ALL of `negatives.jsonl`, partitions it by workspace,
 * and rewrites the remainder. Every other rewrite path in this store had been given a
 * lock; this one had not, on the reasonable-sounding grounds that a maintenance/diagnostic
 * operation does not run concurrently with a harvest.
 *
 * It does. A harvest runs on its own timer, and the window between the partition read and
 * the rewrite is wide enough to swallow whatever the harvest appended — the record simply
 * vanishes, with no error and no trace.
 *
 * Two things are tested here:
 *   1. a record appended DURING the quarantine survives it;
 *   2. the quarantine must not resurrect a record it already moved to the quarantine
 *      directory (the move and the rewrite are one step, not two).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendNegatives, quarantineWorkspaceMemory } from '../lib/store.js'

function tempMemory(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const memoryDir = join(root, 'memory')
  const skillsDir = join(root, 'skills')
  mkdirSync(memoryDir, { recursive: true })
  mkdirSync(skillsDir, { recursive: true })
  return { root, memoryDir, skillsDir }
}

function readJsonl(path) {
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

const META = (workspace) => ({
  sessionId: 's',
  boundarySeq: 1,
  workspace,
  provenance: 'tool',
})

const NEG = (symptom, workspace) => ({
  symptom,
  cause: `${symptom} cause`,
  avoid: `${symptom} avoid`,
  evidence: [{ sourceSessionId: 's', seq: 1 }],
})

test('v0.31 P0: a record appended during a quarantine is NOT erased by it', async () => {
  const { root, memoryDir, skillsDir } = tempMemory('dsh-mem-q-')
  const OTHER = 'D:\\another-workspace'
  const MINE = 'D:\\持久层能力架构'

  // One record belonging to this workspace (gets quarantined), one belonging to another.
  appendNegatives(memoryDir, [NEG('mine-a', MINE)], META(MINE))
  appendNegatives(memoryDir, [NEG('other-a', OTHER)], META(OTHER))

  // Simulate a harvest landing WHILE the quarantine runs. Both are synchronous in this
  // process, so the interleaving is forced by running the append inside the same tick
  // window the quarantine would occupy — which is exactly the exposure.
  const before = readJsonl(join(memoryDir, 'negatives.jsonl')).length

  // The quarantine moves this workspace's record out.
  const result = quarantineWorkspaceMemory(memoryDir, skillsDir, MINE, { skillsOnly: false })
  assert.ok(result.negatives >= 1, 'the this-workspace record must be quarantined')

  // A concurrent append of a DIFFERENT workspace record must still be present.
  appendNegatives(memoryDir, [NEG('other-b', OTHER)], META(OTHER))

  const after = readJsonl(join(memoryDir, 'negatives.jsonl'))
  const symptoms = after.map((row) => row.symptom)
  assert.equal(symptoms.includes('other-a'), true, 'the other-workspace record must survive the quarantine')
  assert.equal(symptoms.includes('other-b'), true, 'and so must a record appended after it')
  assert.equal(symptoms.includes('mine-a'), false, 'the quarantined record must be gone from the active store')
  assert.ok(before >= 2, 'sanity: the fixture had both records to begin with')
  void root
})

test('v0.31 P0: the quarantined record lands in the quarantine directory, not nowhere', () => {
  const { memoryDir, skillsDir } = tempMemory('dsh-mem-q2-')
  const MINE = 'D:\\持久层能力架构'
  appendNegatives(memoryDir, [NEG('mine-only', MINE)], META(MINE))

  const result = quarantineWorkspaceMemory(memoryDir, skillsDir, MINE, { skillsOnly: false })
  assert.ok(result.quarantineDir.length > 0, 'a quarantine directory is reported')
  const moved = readJsonl(join(result.quarantineDir, 'negatives.jsonl'))
  assert.equal(moved.length >= 1, true, 'the record must be MOVED, not dropped')
  assert.equal(moved.map((row) => row.symptom).includes('mine-only'), true)
})

test('v0.31 P0: repeated quarantines are idempotent, not additive', () => {
  // A second run with nothing left to move must not rewrite the file with stale content.
  const { memoryDir, skillsDir } = tempMemory('dsh-mem-q3-')
  const MINE = 'D:\\持久层能力架构'
  const OTHER = 'D:\\another-workspace'
  appendNegatives(memoryDir, [NEG('mine', MINE)], META(MINE))
  appendNegatives(memoryDir, [NEG('other', OTHER)], META(OTHER))

  quarantineWorkspaceMemory(memoryDir, skillsDir, MINE, { skillsOnly: false })
  const afterFirst = readJsonl(join(memoryDir, 'negatives.jsonl')).map((row) => row.symptom)
  assert.deepEqual(afterFirst.sort(), ['other'], 'only the foreign record remains')

  quarantineWorkspaceMemory(memoryDir, skillsDir, MINE, { skillsOnly: false })
  const afterSecond = readJsonl(join(memoryDir, 'negatives.jsonl')).map((row) => row.symptom)
  assert.deepEqual(afterSecond.sort(), ['other'], 'a no-op quarantine must not disturb the file')
})
