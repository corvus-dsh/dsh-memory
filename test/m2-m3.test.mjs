/**
 * M2 (dedupe + suggest queue) and M3 (retrieval + pre-step hint).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findSkillCandidate, jaccard, normalizeForMatch, planNegative, trigrams } from '../lib/dedupe.js'
import { appendNegatives, writeSkill } from '../lib/store.js'
import { approveSuggestion, listSuggestions, queueSuggestion, rejectSuggestion } from '../lib/suggest.js'
import { renderHint, retrieve } from '../lib/retrieve.js'

const skill = {
  name: 'red-test-first',
  title: '先跑冻结构建做红测',
  when: '改动迁移逻辑且要证明修复有效',
  how: ['在冻结包跑同一套测试', '确认 3 条必红', '再在现行构建跑绿'],
  evidence: [3],
}

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-m2-'))
  return { root, skills: join(root, 'skills'), memory: join(root, 'memory') }
}

test('dedupe: normalization strips punctuation and numbers', () => {
  assert.equal(normalizeForMatch('改动迁移（v7.4）逻辑，seq=12'), normalizeForMatch('改动迁移逻辑 seq 12'.replace(' 12', '')))
})

test('dedupe: punctuation variants hit ≥0.85; different methods do not', () => {
  const a = trigrams('改动迁移逻辑且要证明修复有效')
  const same = trigrams('改动迁移逻辑，且要证明修复有效。')
  const c = trigrams('先读源码确认插件挂载态再验证')
  assert.ok(jaccard(a, same) >= 0.85, `expected ≥0.85, got ${jaccard(a, same).toFixed(2)}`)
  assert.ok(jaccard(a, c) < 0.2)
})

test('dedupe: a semantic reword lands below the gate (that is what review is for)', () => {
  const a = trigrams('改动迁移逻辑且要证明修复有效')
  const reworded = trigrams('修改迁移逻辑，并证明修复是有效的')
  assert.ok(jaccard(a, reworded) < 0.85, 'n-gram jaccard is a typo gate, not a semantic one')
})

test('dedupe: normalized-exact `when` finds the existing skill', () => {
  const { skills } = dirs()
  writeSkill(skills, skill, { sessionId: 's1', boundarySeq: 9 })
  const exact = findSkillCandidate(skills, '改动迁移逻辑，且要证明修复有效。')
  assert.equal(exact?.name, 'red-test-first')
  assert.equal(exact?.exact, true)
  assert.equal(findSkillCandidate(skills, '完全不相干的另一件事'), undefined)
})

test('dedupe: same symptom with a different cause is a conflict, not a duplicate', () => {
  const existing = [{ symptom: '提交被拒', cause: '边界移动', avoid: '重新 prepare', evidence: [1] }]
  assert.deepEqual(planNegative(existing, { symptom: '提交被拒', cause: '边界移动', avoid: 'x', evidence: [] }).duplicate, true)
  const conflict = planNegative(existing, { symptom: '提交被拒', cause: '权限不足', avoid: '检查 ACL', evidence: [] })
  assert.equal(conflict.duplicate, false)
  assert.deepEqual(conflict.conflicts, [0])
})

test('store: an exact duplicate negative merges evidence instead of appending', () => {
  const { memory } = dirs()
  const neutral = { symptom: '提交被拒', cause: '边界移动', avoid: '重新 prepare', evidence: [5] }
  assert.equal(appendNegatives(memory, [neutral], { sessionId: 's1', boundarySeq: 9 }), 1)
  assert.equal(appendNegatives(memory, [{ ...neutral, evidence: [7] }], { sessionId: 's2', boundarySeq: 20 }), 0)
  const lines = readFileSync(join(memory, 'negatives.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]).evidence, [5, 7])
})

test('store: a conflicting cause is appended with a back-link', () => {
  const { memory } = dirs()
  appendNegatives(memory, [{ symptom: '提交被拒', cause: '边界移动', avoid: '重新 prepare', evidence: [5] }], { sessionId: 's1', boundarySeq: 9 })
  appendNegatives(memory, [{ symptom: '提交被拒', cause: '权限不足', avoid: '检查 ACL', evidence: [8] }], { sessionId: 's2', boundarySeq: 20 })
  const records = readFileSync(join(memory, 'negatives.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(records.length, 2)
  assert.deepEqual(records[1].conflictsWith, [0])
})

test('suggest: queue holds a candidate until approval, then writes SKILL.md', () => {
  const { skills, memory } = dirs()
  const queued = queueSuggestion(memory, 'skill', skill, { sessionId: 's1', boundarySeq: 9 })
  assert.equal(listSuggestions(memory).length, 1)
  assert.equal(existsSync(join(skills, skill.name)), false, 'nothing is written before approval')
  const approved = approveSuggestion(memory, skills, queued.id)
  assert.equal(approved.found, true)
  assert.equal(approved.status, 'created')
  assert.ok(existsSync(join(skills, skill.name, 'SKILL.md')))
  assert.equal(listSuggestions(memory).length, 0)
})

test('suggest: rejection removes the candidate and writes nothing', () => {
  const { skills, memory } = dirs()
  const queued = queueSuggestion(memory, 'skill', skill, { sessionId: 's1', boundarySeq: 9 })
  assert.equal(rejectSuggestion(memory, queued.id), true)
  assert.equal(listSuggestions(memory).length, 0)
  assert.equal(existsSync(join(skills, skill.name)), false)
})

test('retrieve: a distinctive query hits the skill, a vague one does not', () => {
  const { skills, memory } = dirs()
  writeSkill(skills, skill, { sessionId: 's1', boundarySeq: 9 })
  const hit = retrieve(memory, skills, '改动迁移逻辑 怎么证明修复有效', { threshold: 0.55 })
  assert.equal(hit.skill?.id, 'red-test-first')
  const vague = retrieve(memory, skills, '帮我看看这个', { threshold: 0.55 })
  assert.equal(vague.skill, undefined)
})

test('retrieve: freshness decays and importance raises the score', () => {
  const { skills, memory } = dirs()
  writeSkill(skills, skill, { sessionId: 's1', boundarySeq: 9 })
  const now = Date.now()
  const fresh = retrieve(memory, skills, '改动迁移逻辑 证明修复有效', { threshold: 0, now })
  const old = retrieve(memory, skills, '改动迁移逻辑 证明修复有效', { threshold: 0, now: now + 365 * 86_400_000 })
  assert.ok(fresh.skill !== undefined && old.skill !== undefined)
  assert.ok(fresh.skill.score > old.skill.score, 'a year-old skill must score lower')
})

test('renderHint: one sentence, ≤120 chars, never imperative', () => {
  const { skills, memory } = dirs()
  writeSkill(skills, skill, { sessionId: 's1', boundarySeq: 9 })
  appendNegatives(memory, [{ symptom: '直接重跑副作用工具导致重复提交', cause: '没核对上次结果', avoid: '先读结果', evidence: [5] }], { sessionId: 's1', boundarySeq: 9 })
  const result = retrieve(memory, skills, '改动迁移逻辑 证明修复有效 重跑 副作用', { threshold: 0.3 })
  const hint = renderHint(result)
  assert.ok(hint !== undefined)
  assert.ok(hint.length <= 120, `hint too long: ${hint.length}`)
  assert.match(hint, /^（记忆提示：/u)
  assert.doesNotMatch(hint, /^(你|请|必须)/u)
})

test('pre-step: the hint rides messages once per user turn, non-blocking', async () => {
  const { skills, memory } = dirs()
  writeSkill(skills, skill, { sessionId: 's1', boundarySeq: 9 })
  const handlers = []
  const ctx = {
    paths: { data: memory },
    tools: { register: () => {} },
    on: (event, handler) => handlers.push({ event, handler }),
    get: () => undefined,
    sessionQuery: { readSession: async () => undefined },
  }
  const { apply } = await import('../lib/index.js')
  apply(ctx, { memoryDir: memory, skillsDir: skills, retrieval: true, retrievalThreshold: 0.3 })
  const handler = handlers.find((item) => item.event === 'agent/pre-step')?.handler
  assert.ok(handler !== undefined, 'pre-step handler registered')

  const payload = { agent: { id: 'a1' }, messages: [{ role: 'user', content: [{ type: 'text', text: '改动迁移逻辑，怎么证明修复有效？' }] }] }
  const next = async () => ({ kind: 'enter', messages: payload.messages })
  const first = await handler(payload, next)
  const text = JSON.stringify(first)
  assert.match(text, /记忆提示/u)
  assert.match(text, /plugin:dsh-memory/u)

  const same = await handler(payload, next)
  assert.doesNotMatch(JSON.stringify(same), /记忆提示/u, 'same user turn must not be nudged twice')
})
test('retrieve: a long negative title clips at punctuation, not mid-comma', async () => {
  const { writeSkill } = await import('../lib/store.js')
  const { appendNegatives } = await import('../lib/store.js')
  const { retrieve } = await import('../lib/retrieve.js')
  const skills = mkdtempSync(join(tmpdir(), 'dsh-clip-s-'))
  const memory = mkdtempSync(join(tmpdir(), 'dsh-clip-m-'))
  appendNegatives(memory, [{ symptom: 'graft_commit 反复返回 SOURCE_DRIFT，即使没有任何外部改动、没有任何未提交变更，也仍然拒绝提交，并且不给出任何可定位的原因说明', cause: '边界判定用错', avoid: '改用 boundarySeq', evidence: [5] }], { sessionId: 's', boundarySeq: 9 })
  const result = retrieve(memory, skills, 'SOURCE_DRIFT 反复 拒绝提交 边界', { threshold: 0.1 })
  assert.ok(result.negative !== undefined)
  assert.ok(!result.negative.title.endsWith('，'), `title must not end on a comma: ${result.negative.title}`)
  assert.ok(result.negative.title.endsWith('…'), `clipped titles carry an ellipsis: ${result.negative.title}`)
})

test('retrieve: stopword-only queries score below the threshold', async () => {
  const { writeSkill } = await import('../lib/store.js')
  const { retrieve } = await import('../lib/retrieve.js')
  const skills = mkdtempSync(join(tmpdir(), 'dsh-stop-s-'))
  const memory = mkdtempSync(join(tmpdir(), 'dsh-stop-m-'))
  writeSkill(skills, { name: 'red-test-first', title: '先跑红测', when: '改动迁移逻辑且要证明修复有效', how: ['跑冻结包'], evidence: [3] }, { sessionId: 's', boundarySeq: 9 })
  const result = retrieve(memory, skills, '逻辑 修复 改动 的 了 在 是', { threshold: 0.55 })
  assert.equal(result.skill, undefined, 'high-frequency words must not recall a skill on their own')
})

test('retrieve: a long prompt is not diluted by its own length (top-8 denominator)', async () => {
  const { writeSkill, appendNegatives } = await import('../lib/store.js')
  const { retrieve } = await import('../lib/retrieve.js')
  const skills = mkdtempSync(join(tmpdir(), 'dsh-long-s-'))
  const memory = mkdtempSync(join(tmpdir(), 'dsh-long-m-'))
  appendNegatives(memory, [{ symptom: 'graft_commit 反复返回 SOURCE_DRIFT', cause: '边界 seq 漂移', avoid: '改用 boundarySeq', evidence: [5] }], { sessionId: 's', boundarySeq: 9 })
  const long = '只观察，不做任何文件操作、不写代码、不运行命令。请回答三件事：你是否看到记忆提示；列出技能名；判断相关性。背景：我在排查 graft_commit 反复返回 SOURCE_DRIFT，last seq N -> N+1，边界 seq 校验在两阶段提交里失败的问题。'
  const result = retrieve(memory, skills, long, { threshold: 0.55 })
  assert.ok(result.negative !== undefined, `a long prompt must still recall SOURCE_DRIFT, got ${JSON.stringify(result.debug)}`)
})
