/**
 * v0.5: self-falsification, decay, aliases and optimistic writes.
 *
 * The failure this file guards against: a rule learned once becomes a permanent
 * authority. A negative that reality has overturned must lose weight, a skill
 * nobody validated must rank lower and say so, and a concurrent harvest must
 * merge instead of paying for a second extraction.
 */

import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sanitizeExtraction } from '../lib/extract.js'
import {
  appendNegatives,
  markSkillValidated,
  normalizeSkill,
  parseSkillFile,
  recordCounterEvidence,
  skillPath,
  touchSkillUsage,
  writeSkill,
} from '../lib/store.js'
import { renderHint, retrieve, retrieveWithFilter } from '../lib/retrieve.js'
import { clearFilterCache, filterCacheStats, selectApplicableSkills } from '../lib/filter.js'
import { apply, snapshotStoreVersion } from '../lib/index.js'

beforeEach(() => clearFilterCache())

const EPISODE = {
  sessionId: 's1',
  boundarySeq: 9,
  turns: 3,
  conclusions: [{ text: '结论：先红测再修。', seq: 3 }],
  errors: [{ tool: 'deploy', text: 'SOURCE_DRIFT', seq: 5 }],
  toolNames: ['deploy'],
  evidence: [3, 5],
}

const SKILL = {
  name: 'db-connect-shape',
  title: '数据库连接形态',
  description: '连接数据库并查询的形态。',
  when: '当需要用 Python 连接数据库执行查询时',
  steps: ['建立连接', '执行参数化查询', '关闭连接'],
  verify: ['查询返回预期行数'],
  scope: 'project',
  aliases: ['连数据库', '数据库查询', 'mysql 连接'],
  evidence: [3],
}

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-v05-'))
  return { root, skills: join(root, 'skills'), memory: join(root, 'memory') }
}

test('v0.5: scope and aliases are extracted, validated, and default safely', () => {
  const parsed = sanitizeExtraction(
    {
      skills: [{ ...SKILL, when_to_use: SKILL.when, scope: 'global' }],
      negatives: [{ symptom: 'deploy 必报错', cause: 'cause', avoid: 'avoid', scope: 'workspace', evidence: [5] }],
    },
    EPISODE,
  )
  assert.equal(parsed.skills[0].scope, 'global')
  assert.deepEqual(parsed.skills[0].aliases, SKILL.aliases)
  assert.equal(parsed.negatives[0].scope, 'workspace')

  // An unknown scope is not guessed from wording; it degrades to `project`.
  const bogus = sanitizeExtraction({ skills: [{ ...SKILL, when_to_use: SKILL.when, scope: 'galaxy' }] }, EPISODE)
  assert.equal(bogus.skills[0].scope, 'project')

  // Backward compatibility: a legacy payload has neither field.
  const legacy = sanitizeExtraction(
    { skills: [{ name: 'old-skill', title: '旧', when: '旧的触发条件', steps: ['甲', '乙'], verify: ['验证通过后继续'], evidence: [3] }] },
    EPISODE,
  )
  assert.equal(legacy.skills[0].scope, 'project')
  assert.deepEqual(legacy.skills[0].aliases, [])
})

test('v0.5: SKILL.md carries scope/aliases/decay fields and parses them back', () => {
  const { skills } = dirs()
  assert.equal(writeSkill(skills, SKILL, { sessionId: 's', boundarySeq: 9 }), 'created')
  const text = readFileSync(skillPath(skills, SKILL.name), 'utf8')
  assert.match(text, /^scope: project$/mu)
  assert.match(text, /^aliases: 连数据库, 数据库查询, mysql 连接$/mu)
  assert.match(text, /^last_used: /mu)
  assert.match(text, /^last_validated: /mu)
  const parsed = parseSkillFile(text, SKILL.name)
  assert.equal(parsed.scope, 'project')
  assert.deepEqual(parsed.aliases, SKILL.aliases)
})

test('v0.5: aliases make a short generic ask recallable', () => {
  const { skills, memory } = dirs()
  writeSkill(skills, SKILL, { sessionId: 's', boundarySeq: 9 })
  const result = retrieve(memory, skills, '连数据库', { threshold: 0.2 })
  assert.equal(result.skill?.id, SKILL.name, 'the alias itself is recall fuel')
  assert.deepEqual(result.skill?.aliases, SKILL.aliases)
})

test('v0.5: counter-evidence weakens a negative and keeps the receipt', () => {
  const { skills, memory } = dirs()
  appendNegatives(
    memory,
    [{ symptom: '部署脚本必报 SOURCE_DRIFT', cause: '旧边界逻辑', avoid: '改用 boundarySeq，deploy 前先 dry-run', scope: 'project', evidence: [5] }],
    { sessionId: 's', boundarySeq: 9 },
  )
  const events = [
    { type: 'tool/call', seq: 20, data: { callId: 'c1', name: 'deploy', arguments: '{}' } },
    {
      type: 'tool/result',
      seq: 21,
      data: { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'deployment ok' }] } },
    },
  ]
  const result = recordCounterEvidence(memory, events)
  assert.equal(result.updated.length, 1)
  assert.equal(result.updated[0].confidence, 0.8)
  const record = JSON.parse(readFileSync(join(memory, 'negatives.jsonl'), 'utf8').trim())
  assert.deepEqual(record.counterEvidence, [21])

  const scored = retrieve(memory, skills, '部署脚本 SOURCE_DRIFT deploy', { threshold: 0.2 })
  assert.ok(scored.negative !== undefined)
  assert.equal(scored.negative.score < 1, true)
  assert.match(renderHint(scored) ?? '', /反向证据/u, 'the hint must say the rule was weakened')
})

test('v0.5: a still-failing run adds no counter-evidence', () => {
  const { memory } = dirs()
  appendNegatives(
    memory,
    [{ symptom: '部署脚本必报 SOURCE_DRIFT', cause: '旧边界逻辑', avoid: '改用 boundarySeq，deploy 前先 dry-run', scope: 'project', evidence: [5] }],
    { sessionId: 's', boundarySeq: 9 },
  )
  const events = [
    { type: 'tool/call', seq: 30, data: { callId: 'c2', name: 'deploy' } },
    { type: 'tool/result', seq: 31, data: { message: { source: { callId: 'c2' }, content: [{ type: 'text', text: '部署脚本必报 SOURCE_DRIFT' }] } } },
  ]
  assert.equal(recordCounterEvidence(memory, events).updated.length, 0)
})

test('v0.5: a stale skill is ranked down and the hint warns', () => {
  const { skills, memory } = dirs()
  writeSkill(skills, SKILL, { sessionId: 's', boundarySeq: 9 })
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const path = skillPath(skills, SKILL.name)
  let text = readFileSync(path, 'utf8')
  text = text.replace(/^last_used:.*$/mu, `last_used: ${old}`).replace(/^last_validated:.*$/mu, `last_validated: ${old}`)
  writeFileSync(path, text, 'utf8')

  const result = retrieve(memory, skills, '连接数据库执行查询', { threshold: 0.1 })
  assert.equal(result.skill?.stale, true)
  assert.ok(result.skill.score < 0.9, '30 unvalidated days halve the importance')
  const hint = renderHint(result) ?? ''
  assert.match(hint, /较久未被验证/u)
  assert.ok(hint.length <= 220)

  // New evidence re-validates it: the warning must disappear.
  markSkillValidated(skills, SKILL.name, new Date().toISOString())
  const fresh = retrieve(memory, skills, '连接数据库执行查询', { threshold: 0.1 })
  assert.equal(fresh.skill?.stale, undefined)
  assert.doesNotMatch(renderHint(fresh) ?? '', /较久未被验证/u)
})

test('v0.5: touchSkillUsage restarts the decay clock', () => {
  const { skills } = dirs()
  writeSkill(skills, SKILL, { sessionId: 's', boundarySeq: 9 })
  const path = skillPath(skills, SKILL.name)
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString()
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^last_used:.*$/mu, `last_used: ${old}`), 'utf8')
  assert.equal(touchSkillUsage(skills, SKILL.name), true)
  const used = parseSkillFile(readFileSync(path, 'utf8'), SKILL.name)
  assert.ok(Date.parse(readFileSync(path, 'utf8').match(/^last_used: (.+)$/mu)[1]) > Date.now() - 60_000)
})

test('v0.5: the adjudication cache answers repeated questions without a second call', async () => {
  const { skills, memory } = dirs()
  writeSkill(skills, SKILL, { sessionId: 's', boundarySeq: 9 })
  const candidates = [{ kind: 'skill', id: SKILL.name, title: SKILL.title, score: 0.9, when: SKILL.when }]
  let calls = 0
  const llm = {
    async *stream() {
      calls += 1
      yield { type: 'text-delta', text: JSON.stringify({ apply: [SKILL.name] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const first = await selectApplicableSkills(llm, '连数据库', candidates)
  const second = await selectApplicableSkills(llm, '连数据库', candidates)
  assert.deepEqual(first, [SKILL.name])
  assert.deepEqual(second, [SKILL.name])
  assert.equal(calls, 1, 'same query + same candidates = one call')
  assert.equal(filterCacheStats().size, 1)

  await selectApplicableSkills(llm, '另一个问题', candidates)
  assert.equal(calls, 2, 'a different query is a different verdict')
})

test('v0.5: concurrent harvest merges writes without a second extraction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-v05-harvest-'))
  const graft = join(root, 'graft')
  mkdirSync(graft, { recursive: true })
  writeFileSync(join(graft, '.retired.json'), JSON.stringify(['session-v05']), 'utf8')
  const memory = join(root, 'memory')
  const skills = join(root, 'skills')
  mkdirSync(memory, { recursive: true })
  let calls = 0
  const events = [
    { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '结论：连接数据库要参数化查询并关闭连接，事务失败要回滚。' }] } } },
    { type: 'tool/call', seq: 3, data: { name: 'deploy', callId: 'c1' } },
    { type: 'tool/result', seq: 4, data: { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] } } },
  ]
  const tools = new Map()
  const ctx = {
    paths: { data: root },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    sessionQuery: { readSession: async () => ({ events }) },
    get: (name) =>
      name === 'llm'
        ? {
            async *stream() {
              calls += 1
              // Simulate another harvest finishing while this model call is open.
              writeFileSync(join(memory, 'facts.jsonl'), '{"text":"concurrent-writer"}\n', 'utf8')
              yield { type: 'text-delta', text: JSON.stringify({ skills: [{ ...SKILL, when_to_use: SKILL.when, steps: SKILL.steps, verify: SKILL.verify }] }) }
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }
        : undefined,
  }
  apply(ctx, { graftDataDir: graft, memoryDir: memory, skillsDir: skills, extractor: 'llm', autoApprove: true })
  const report = await tools.get('memory_harvest').execute({})
  assert.equal(calls, 1, 'a concurrent write must never trigger a second extraction')
  assert.equal(report.harvested.length, 1)
  assert.equal(report.harvested[0].mergedConcurrentWrites, 1)
})

test('v0.5: the store version changes when either side is written', () => {
  const { memory, skills } = dirs()
  mkdirSync(memory, { recursive: true })
  const before = snapshotStoreVersion(memory, skills)
  writeFileSync(join(memory, 'negatives.jsonl'), '{}\n', 'utf8')
  assert.notEqual(snapshotStoreVersion(memory, skills), before)
})