/**
 * v1.0.2 — SKILL GENERATION + COMMIT-HASH DEMOTION.
 *
 * A skill is a claim about a codebase at a moment in time. Without the commit it was
 * extracted against, "the fix is X" reads exactly as authoritative after X was replaced,
 * and the next generation inherits a dead instruction with a fresh-looking timestamp.
 *
 * Two halves are pinned here:
 *   - the STORE records `generation` and `commitHash` as provenance;
 *   - RETRIEVAL demotes a skill whose commit no longer matches, and the hint says so in
 *     bold, BEFORE the claim — a trailing footnote reads as a comment on a fact.
 *
 * The checkout is injected (`currentCommit`) so these tests never need a repository.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearCommitCache, renderHint, retrieve } from '../lib/retrieve.js'
import { writeSkill } from '../lib/store.js'

const WORKSPACE = 'D:\\项目A'
const A = 'D:/项目A'
const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)

const skill = {
  name: 'cold-tape-materialize',
  title: '冷目标切片写法',
  description: '切片写入抛 cannot append outside a SessionStore 时改走 materializeTape。',
  when: '切片写入抛出 cannot append outside a SessionStore',
  steps: ['定位写入路径', '改走 materializeTape', '目标保持 COLD'],
  verify: ['真机切片不再抛 SessionStore 错'],
  evidence: [838],
}

const QUERY = '切片写入 cannot append outside a SessionStore 怎么修'

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-commit-'))
  return { skills: join(root, 'skills'), memory: join(root, 'memory') }
}

test('v1.0.2 store: generation and commitHash are written as frontmatter provenance', () => {
  const { skills, memory } = dirs()
  writeSkill(skills, skill, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE, generation: 3, commitHash: OLD })
  const text = readFileSync(join(skills, skill.name, 'SKILL.md'), 'utf8')
  assert.match(text, /^generation: 3$/mu)
  assert.match(text, new RegExp(`^commitHash: ${OLD}$`, 'mu'))
  // The gate's own provenance must survive alongside them.
  assert.match(text, /^workspace: D:\/项目A$/mu)
  assert.ok(memory.length > 0)
})

test('v1.0.2 store: an invented commit is refused rather than recorded', () => {
  const { skills } = dirs()
  writeSkill(skills, skill, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE, commitHash: 'not-a-hash' })
  const text = readFileSync(join(skills, skill.name, 'SKILL.md'), 'utf8')
  assert.doesNotMatch(text, /^commitHash:/mu, 'a malformed hash must not become provenance')
})

test('v1.0.2 retrieval: a skill from ANOTHER commit is demoted and labelled', () => {
  clearCommitCache()
  const { skills, memory } = dirs()
  writeSkill(skills, skill, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE, generation: 2, commitHash: OLD })

  const drifted = retrieve(memory, skills, QUERY, { threshold: 0, workspace: A, currentCommit: NEW })
  assert.ok(drifted.skill !== undefined, 'demoted is not dropped: the memory still exists')
  assert.equal(drifted.skill.commitDrift, true)
  assert.equal(drifted.skill.generation, 2)
  assert.equal(drifted.skill.currentCommit, NEW)
  const hint = renderHint(drifted)
  assert.match(hint, /此经验来自第 2 代的旧提交 aaaaaaa/u)
  assert.match(hint, /请谨慎使用/u)
  // The warning must come BEFORE the claim.
  assert.ok(hint.indexOf('此经验来自') < hint.indexOf('记忆提示'), 'the prefix must not be a trailing footnote')
})

test('v1.0.2 retrieval: the same commit is not drift, and costs nothing', () => {
  clearCommitCache()
  const { skills, memory } = dirs()
  writeSkill(skills, skill, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE, generation: 2, commitHash: OLD })

  const same = retrieve(memory, skills, QUERY, { threshold: 0, workspace: A, currentCommit: OLD })
  assert.ok(same.skill !== undefined)
  assert.equal(same.skill.commitDrift, undefined)
  assert.doesNotMatch(renderHint(same), /旧提交/u)
})

test('v1.0.2 retrieval: an unknown checkout never invents drift', () => {
  clearCommitCache()
  const { skills, memory } = dirs()
  writeSkill(skills, skill, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE, commitHash: OLD })

  // Empty current commit = "we could not ask" -> no demotion, no warning.
  const unknown = retrieve(memory, skills, QUERY, { threshold: 0, workspace: A, currentCommit: '' })
  assert.equal(unknown.skill?.commitDrift, undefined)
  assert.doesNotMatch(renderHint(unknown), /旧提交/u)
})

test('v1.0.2 retrieval: demotion rivals but does not erase a current skill', () => {
  clearCommitCache()
  const { skills, memory } = dirs()
  writeSkill(skills, { ...skill, name: 'stale-one' }, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE, commitHash: OLD })
  writeSkill(skills, { ...skill, name: 'fresh-one' }, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE, commitHash: NEW })

  const result = retrieve(memory, skills, QUERY, { threshold: 0, workspace: A, currentCommit: NEW })
  assert.equal(result.skill?.id, 'fresh-one', 'the matching commit wins the primary slot')
})
