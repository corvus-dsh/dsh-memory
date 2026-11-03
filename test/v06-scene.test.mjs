/**
 * v0.6: scene isolation, composite evidence, four-layer retrieval, strong verify.
 *
 * The failure this guards: a memory learned in one domain silently activating in
 * another, and a skill written from a 240-char summary that no tool call backs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sanitizeExtraction } from '../lib/extract.js'
import { appendExperiences, appendFacts, parseSkillFile, skillPath, writeSkill } from '../lib/store.js'
import { inferScene, renderHint, retrieve } from '../lib/retrieve.js'
import { buildEvidenceVerifier, harvest } from '../lib/index.js'
import { apply } from '../lib/index.js'
import { mkdirSync, writeFileSync } from 'node:fs'

const EPISODE = {
  sessionId: 'session-alpha',
  boundarySeq: 9,
  turns: 2,
  conclusions: [{ text: '结论', seq: 3 }],
  errors: [],
  successes: [],
  toolNames: [],
  evidence: [3],
}

const skill = (over = {}) => ({
  name: 'db-shape',
  title: '数据库连接形态',
  description: '数据库连接。',
  when: '当需要连接数据库并查询时',
  steps: ['建立连接', '执行查询'],
  verify: ['返回预期结果'],
  scope: 'project',
  scene: 'database',
  aliases: [],
  evidence: [{ sourceSessionId: 'session-alpha', seq: 3 }],
  ...over,
})

test('v0.6: scene is extracted, validated and defaults to general', () => {
  const parsed = sanitizeExtraction(
    {
      skills: [{ ...skill(), when_to_use: skill().when }],
      facts: [{ text: '数据库连接返回了 3 行', seq: 3, scene: 'database' }],
      experiences: [{ text: '连接串要带 charset', seq: 3, scene: 'Bad Scene!' }, { text: '连接池要预热', seq: 3, scene: 'custom-domain' }],
      negatives: [{ symptom: '连接数据库超时了', cause: '网络抖动导致超时', avoid: '改用本地库或重试', scene: 'database', evidence: [3] }],
    },
    EPISODE,
  )
  assert.equal(parsed.skills[0].scene, 'database')
  assert.equal(parsed.facts[0].scene, 'database')
  assert.equal(parsed.experiences[0].scene, 'general', 'an unknown scene is not guessed')
  assert.equal(parsed.negatives[0].scene, 'database')
  assert.deepEqual(parsed.skills[0].evidence, [{ sourceSessionId: 'session-alpha', seq: 3 }])
})

test('v0.6: evidence is a composite key and SKILL.md round-trips it', () => {
  const skills = mkdtempSync(join(tmpdir(), 'dsh-mem-scene-'))
  assert.equal(writeSkill(skills, skill(), { sessionId: 'session-alpha', boundarySeq: 9 }), 'created')
  const text = readFileSync(skillPath(skills, 'db-shape'), 'utf8')
  assert.match(text, /^scene: database$/mu)
  assert.match(text, /evidence: session-alpha@3/u)
  assert.match(text, /源会话：session-alpha（seq 3）/u)
  const parsed = parseSkillFile(text, 'db-shape')
  assert.deepEqual(parsed.evidence, [{ sourceSessionId: 'session-alpha', seq: 3 }])
  assert.equal(parsed.scene, 'database')
})

test('v0.6: scene routing keeps the other domain out even at equal wording', () => {
  const skills = mkdtempSync(join(tmpdir(), 'dsh-mem-route-'))
  const memory = mkdtempSync(join(tmpdir(), 'dsh-mem-route-m-'))
  writeSkill(skills, skill({ name: 'db-shape' }), { sessionId: 's', boundarySeq: 9 })
  writeSkill(
    skills,
    skill({ name: 'ui-shape', title: '界面测试步骤', description: '组件测试。', when: '当需要写界面测试时', scene: 'ui', steps: ['渲染组件', '断言样式'] }),
    { sessionId: 's', boundarySeq: 9 },
  )
  assert.equal(inferScene('ui 组件 样式 测试'), 'ui')
  const result = retrieve(memory, skills, 'ui 组件 样式 测试', { threshold: 0.1 })
  assert.equal(result.skill?.id, 'ui-shape', 'the database skill must not activate for a UI query')
})

test('v0.6: facts and experiences are retrievable with lookup hints', () => {
  const skills = mkdtempSync(join(tmpdir(), 'dsh-mem-layer-'))
  const memory = mkdtempSync(join(tmpdir(), 'dsh-mem-layer-m-'))
  appendFacts(
    memory,
    [{ text: '测试用例传了 100 条数据但阈值也是 100', seq: 5, scene: 'database' }],
    { sessionId: 'session-alpha', boundarySeq: 9 },
  )
  appendExperiences(
    memory,
    [{ text: '样本量恰好等于阈值时边界极其脆弱', seq: 5, scene: 'database' }],
    { sessionId: 'session-alpha', boundarySeq: 9 },
  )
  const result = retrieve(memory, skills, '数据库 阈值 样本量', { threshold: 0.1 })
  assert.ok(result.fact !== undefined, 'a matching fact must be recalled')
  assert.equal(result.fact?.sessionId, 'session-alpha')
  assert.equal(result.fact?.seq, 5)
  const hint = renderHint(result) ?? ''
  assert.match(hint, /事实回查/u)
  assert.match(hint, /graft_search_history/u)
})

test('v0.6: the strong verifier refuses narration-only and failed-result evidence', () => {
  const events = [
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '我说做完了' }] } } },
    { type: 'tool/call', seq: 3, data: { callId: 'c1', name: 'pwsh' } },
    { type: 'tool/result', seq: 4, data: { message: { source: { callId: 'c1' }, isError: true, content: [{ type: 'text', text: 'boom' }] } } },
    { type: 'tool/call', seq: 5, data: { callId: 'c2', name: 'pwsh' } },
    { type: 'tool/result', seq: 6, data: { message: { source: { callId: 'c2' }, content: [{ type: 'text', text: 'ok' }] } } },
  ]
  const verify = buildEvidenceVerifier(events)
  assert.equal(verify([{ sourceSessionId: 's', seq: 2 }]).ok, false, 'narration is not proof')
  assert.equal(verify([{ sourceSessionId: 's', seq: 3 }]).ok, false, 'a failed result disproves the call')
  assert.equal(verify([{ sourceSessionId: 's', seq: 5 }]).ok, true)
  assert.equal(verify([{ sourceSessionId: 's', seq: 6 }]).ok, true)
})

test('v0.6: harvest drops a skill whose evidence is only narration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-verify-'))
  const graft = join(root, 'graft')
  mkdirSync(graft, { recursive: true })
  writeFileSync(join(graft, '.retired.json'), JSON.stringify(['session-verify']), 'utf8')
  const memory = join(root, 'memory')
  const skills = join(root, 'skills')
  const tools = new Map()
  const ctx = {
    paths: { data: root },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    sessionQuery: {
      readSession: async () => ({
        events: [
          { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '结论：连接数据库要参数化查询并且关闭连接，事务失败要回滚。' }] } } },
        ],
      }),
    },
    get: (name) =>
      name === 'llm'
        ? {
            async *stream() {
              yield { type: 'text-delta', text: JSON.stringify({ skills: [{ ...skill(), when_to_use: skill().when, evidence: [2] }] }) }
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }
        : undefined,
  }
  apply(ctx, { graftDataDir: graft, memoryDir: memory, skillsDir: skills, extractor: 'llm', autoApprove: true })
  const report = await tools.get('memory_harvest').execute({})
  assert.equal(report.harvested[0].skills.length, 0, 'no tool result behind the skill')
  assert.ok(report.harvested[0].dropped.some((line) => /evidence not confirmed/u.test(line)), JSON.stringify(report.harvested[0].dropped))
})