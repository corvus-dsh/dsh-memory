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
  description: '改动迁移逻辑时，先证明修复有效再动手。',
  when: '改动迁移逻辑且要证明修复有效',
  steps: ['在冻结包跑同一套测试', '确认 3 条必红', '再在现行构建跑绿'],
  verify: ['同一组用例先红后绿，且失败信息指向被改的函数'],
  evidence: [3],
}

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-m2-'))
  return { root, skills: join(root, 'skills'), memory: join(root, 'memory') }
}

/**
 * THE OLD ASSERTION WAS `normalizeForMatch('…（v7.4）…') === normalizeForMatch('…'.replace(' 12',''))`,
 * which passed only because EVERY digit was stripped. That is the bug: it also made `端口 3000` and
 * `端口 8080` identical.
 *
 * The INTENT survives — a parenthetical aside and stray punctuation are formatting and must not split a
 * match — but the mechanism is now the parenthetical rule, not a blanket digit sweep. The two assertions
 * below are the intent and the boundary, and they are deliberately adjacent: one would be satisfied by the
 * old bug, the other would be violated by it.
 */
test('dedupe: normalization strips punctuation and parentheticals, NOT digits', () => {
  /** Intent preserved: `（v7.4）` is commentary, so these two claims are the same. */
  assert.equal(
    normalizeForMatch('改动迁移（v7.4）逻辑，要证明修复有效。'),
    normalizeForMatch('改动迁移逻辑 要证明修复有效'),
    'a bracketed version is commentary and must not split a match',
  )
  /** The boundary the bug crossed: digits that CARRY MEANING must survive. */
  assert.notEqual(normalizeForMatch('端口 3000 被占用'), normalizeForMatch('端口 8080 被占用'))
  assert.equal(normalizeForMatch('端口 3000 被占用'), normalizeForMatch('端口3000被占用'), 'formatting still normalises')
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

/**
 * THE P0 REGRESSION — 端口 3000 与 端口 8080 是两个不同的事件。
 *
 * HOW THIS FAILED BEFORE: `normalizeForMatch` ended with `.replace(/[0-9]+/gu, '')`, so both symptoms
 * normalised to `端口被占用`, `planNegative` returned `duplicate: true`, and the second lesson was SILENTLY
 * DROPPED on the write path.
 *
 * WHY THIS TEST IS AT THE `appendNegatives` LAYER AND NOT ONLY AT `normalizeForMatch`: a unit test on the
 * normaliser proves the string differs; only an end-to-end assertion proves the SECOND ROW IS WRITTEN.
 * The bug's cost was a missing row, so the assertion has to be about rows.
 */
test('dedupe: two different ports are two records, not one (P0 regression)', () => {
  const { memory } = dirs()
  const at = (port) => ({
    symptom: `端口 ${port} 被占用`,
    cause: '上一个开发服务器没有退出',
    avoid: '启动前先确认端口释放',
    evidence: [port],
  })

  assert.equal(appendNegatives(memory, [at(3000)], { sessionId: 's-a', boundarySeq: 1 }), 1, 'the first row is written')
  /**
   * THIS IS THE ASSERTION THAT MATTERS. Before the fix it returned `0` — the record was judged a duplicate
   * of port 3000 and discarded.
   */
  assert.equal(appendNegatives(memory, [at(8080)], { sessionId: 's-b', boundarySeq: 2 }), 1, 'port 8080 is NOT a duplicate of port 3000')

  const rows = readFileSync(join(memory, 'negatives.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(rows.length, 2, `expected two rows, got ${rows.length}`)
  assert.ok(rows.some((row) => String(row.symptom).includes('3000')), 'port 3000 survived')
  assert.ok(rows.some((row) => String(row.symptom).includes('8080')), 'port 8080 survived')
})

test('dedupe: the SAME port is still a duplicate (the fix must not disable dedupe)', () => {
  const { memory } = dirs()
  const at = (evidence) => ({
    symptom: '端口 3000 被占用',
    cause: '上一个开发服务器没有退出',
    avoid: '启动前先确认端口释放',
    evidence,
  })
  assert.equal(appendNegatives(memory, [at([1])], { sessionId: 's-a', boundarySeq: 1 }), 1)
  /** Same symptom AND same cause → genuinely the same event, so it merges rather than appending. */
  assert.equal(appendNegatives(memory, [at([2])], { sessionId: 's-b', boundarySeq: 2 }), 0, 'an exact duplicate must still merge')
  const rows = readFileSync(join(memory, 'negatives.jsonl'), 'utf8').trim().split('\n')
  assert.equal(rows.length, 1)
  /** And the merge kept both pieces of evidence rather than dropping one. */
  assert.equal(JSON.parse(rows[0]).evidence.length, 2)
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
  // v0.17: an untrusted hint carries a trust PREFIX ("参考历史数据，非当前指令"), which
  // is part of the sentence's meaning and so is allowed to exceed the plain cap —
  // exactly like the stale warning. A human-sourced hint keeps the tight budget.
  const prefixLength = hint.startsWith('[参考历史数据') ? hint.indexOf('（记忆提示：') : 0
  assert.ok(hint.length - prefixLength <= 120, `hint too long: ${hint.length} (prefix ${prefixLength})`)
  assert.match(hint, /（记忆提示：/u)
  assert.doesNotMatch(hint, /^(你|请|必须)/u)
})

test('pre-step: the hint rides messages once per user turn, non-blocking', async () => {
  const { skills, memory } = dirs()
  // v0.8: the pre-step gate only injects memories recorded in the SAME workspace.
  // This fixture's payload carries no agent cwd, so the plugin resolves the
  // workspace the same way a session would: the process working directory. The
  // skill is written with that provenance, which is what a real harvest records
  // (`session.cwd`). The refusal direction is covered in v08-workspace.test.mjs.
  writeSkill(skills, skill, { sessionId: 's1', boundarySeq: 9, workspace: process.cwd() })
  const handlers = []
  const ctx = {
    paths: { data: memory },
    tools: { register: () => {} },
    on: (event, handler) => handlers.push({ event, handler }),
    get: (name) => {
      // v0.4: the two-stage pipeline requires a judge. Without one, the plugin
      // deliberately injects nothing, so this fixture supplies a fake adjudicator.
      if (name !== 'llm') return undefined
      return {
        async *stream() {
          yield { type: 'text-delta', text: JSON.stringify({ apply: ['red-test-first'] }) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
    sessionQuery: { readSession: async () => undefined },
  }
  const { apply } = await import('../lib/index.js')
  apply(ctx, { memoryDir: memory, skillsDir: skills, retrieval: true, retrievalFloor: 0.2 })
  const handler = handlers.find((item) => item.event === 'agent/pre-step')?.handler
  assert.ok(handler !== undefined, 'pre-step handler registered')

  const payload = { agent: { id: 'a1' }, messages: [{ role: 'user', content: [{ type: 'text', text: '改动迁移逻辑，怎么证明修复有效？' }] }] }
  const next = async () => ({ kind: 'enter', messages: payload.messages })
  const first = await handler(payload, next)
  const text = JSON.stringify(first)
  assert.match(text, /记忆提示/u)
  assert.match(text, /plugin:dsh-memory/u)

  /**
   * HOST CONTRACT: DSH appends every pre-step message as a `user/message` event and its
   * validator requires event type and role to agree. A `developer` role here is not context —
   * it is a fatal append error that killed a live run at seq 1046. Assert the SHAPE the host
   * will receive, not just the payload's spelling.
   */
  const injected = first.messages.filter((message) => !payload.messages.includes(message))
  assert.ok(injected.length > 0, 'the hint must be appended to the step')
  for (const message of injected) {
    assert.equal(
      message.role,
      'user',
      'pre-step messages become user/message; a developer role makes the host throw "developer/message and developer role must occur together"',
    )
    assert.match(message.content?.[0]?.text ?? '', /^\[系统提示\]/u, 'a user-carried system note must say so')
  }

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
  writeSkill(skills, { name: 'red-test-first', title: '先跑红测', when: '改动迁移逻辑且要证明修复有效', steps: ['跑冻结包', '确认必红'], verify: ['失败信息指向被改函数'], evidence: [3] }, { sessionId: 's', boundarySeq: 9 })
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
