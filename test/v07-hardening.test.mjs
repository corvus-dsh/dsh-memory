/**
 * v0.7.1: memory deep-water hardening.
 *
 * Five failures this file guards, each one observed or plausible in the live
 * store rather than invented:
 *
 *  1. observational blindness — a read/grep-only session produced a real
 *     architecture lesson and the verifier discarded it for having no "write".
 *  2. lexicon routing — "搞个本地存储" matched no database keyword, so the UI
 *     skill competed (and could win) on a database question.
 *  3. over-normalised merge — Python 3.8 and 3.12 procedures shared a trigger
 *     and collapsed into one file that ran on neither version.
 *  4. no use-effect loop — a skill that failed in real use kept full confidence.
 *  5. bare seq — a v0.6 pointer without a session id cannot be read back.
 */

import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sanitizeExtraction } from '../lib/extract.js'
import { hasEdge } from '../lib/edges.js'
import {
  applySkillFeedback,
  appendFacts,
  appendNegatives,
  migrateBareEvidence,
  parseSkillFile,
  skillPath,
  writeSkill,
} from '../lib/store.js'
import {
  classifyScene,
  clearSceneCache,
  collectScenes,
  renderHint,
  retrieve,
  retrieveWithFilter,
  sceneCacheStats,
} from '../lib/retrieve.js'
import { buildEvidenceVerifier } from '../lib/index.js'

beforeEach(() => clearSceneCache())

const meta = { sessionId: 'session-alpha', boundarySeq: 9 }

const dbSkill = (over = {}) => ({
  name: 'db-shape',
  title: '数据库连接形态',
  description: '连接本地 MySQL 并查询。',
  when: '当需要连接数据库并查询时',
  steps: ['建立连接', '执行查询'],
  verify: ['返回预期行数'],
  scope: 'project',
  scene: 'database',
  aliases: ['连数据库', '本地存储'],
  evidence: [{ sourceSessionId: 'session-alpha', seq: 3 }],
  ...over,
})

/** A model double that routes by the system prompt (scene vs adjudication). */
function routedLlm(scene = '{"scene":"database"}', apply = '{"apply":["db-shape"]}') {
  const counter = { scene: 0, filter: 0 }
  return {
    counter,
    async *stream(options) {
      const system = String(options?.system ?? '')
      if (/route a coding-agent memory lookup/u.test(system)) {
        counter.scene += 1
        yield { type: 'text-delta', text: scene }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      counter.filter += 1
      yield { type: 'text-delta', text: apply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

test('v0.7.1: read-only (observational) evidence passes the strong verifier', () => {
  const events = [
    { type: 'tool/call', seq: 10, data: { callId: 'r1', name: 'read' } },
    { type: 'tool/result', seq: 11, data: { message: { source: { callId: 'r1' }, content: [{ type: 'text', text: 'module exports begin/commit' }] } } },
    { type: 'tool/call', seq: 12, data: { callId: 'g1', name: 'grep' } },
    { type: 'tool/result', seq: 13, data: { message: { source: { callId: 'g1' }, content: [{ type: 'text', text: 'no matches' }] } } },
    { type: 'tool/call', seq: 14, data: { callId: 'w1', name: 'write' } },
    { type: 'tool/result', seq: 15, data: { message: { source: { callId: 'w1' }, content: [{ type: 'text', text: 'written' }] } } },
  ]
  const verify = buildEvidenceVerifier(events)
  const observational = verify([{ sourceSessionId: 's', seq: 11 }])
  assert.equal(observational.ok, true)
  assert.equal(observational.observation, true, 'read/grep is observation, not operation')
  const operational = verify([{ sourceSessionId: 's', seq: 15 }])
  assert.equal(operational.ok, true)
  assert.equal(operational.observation, false)
  // Mixed evidence is operational: something was actually done.
  assert.equal(verify([{ sourceSessionId: 's', seq: 11 }, { sourceSessionId: 's', seq: 15 }]).observation, false)
})

test('v0.7.1: a fact extracted from a read-only session survives sanitize+verify', async () => {
  const episode = {
    sessionId: 'session-read',
    boundarySeq: 11,
    turns: 1,
    conclusions: [],
    errors: [],
    successes: [],
    toolNames: ['read'],
    evidence: [10, 11],
  }
  const llm = {
    async *stream() {
      yield {
        type: 'text-delta',
        text: JSON.stringify({
          facts: [{ text: '模块把 begin/commit 拆成两段，中间不能插 await', seq: 11, scene: 'database' }],
          experiences: [{ text: '事务边界靠两段调用拼出来', seq: 11, scene: 'database' }],
        }),
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const { extractEpisode } = await import('../lib/extract.js')
  const result = await extractEpisode(llm, episode, {
    verify: buildEvidenceVerifier([
      { type: 'tool/call', seq: 10, data: { callId: 'r1', name: 'read' } },
      { type: 'tool/result', seq: 11, data: { message: { source: { callId: 'r1' }, content: [{ type: 'text', text: 'ok' }] } } },
    ]),
  })
  assert.equal(result.ok, true)
  assert.equal(result.facts.length, 1, 'an observational fact is not discarded')
  assert.equal(result.experiences.length, 1)
})

test('v0.7.1: the LLM classifier routes everyday wording, not just keywords', async () => {
  const llm = routedLlm()
  const scene = await classifyScene(llm, '搞个本地存储，存点记录', { scenes: ['database', 'ui'] })
  assert.equal(scene, 'database')
  assert.equal(llm.counter.scene, 1)
  // The same query is cached: a long task must not pay this call every step.
  await classifyScene(llm, '搞个本地存储，存点记录', { scenes: ['database', 'ui'] })
  assert.equal(llm.counter.scene, 1)
  assert.equal(sceneCacheStats().size, 1)
})

test('v0.7.1: a failed or invented classification degrades to general, never throws', async () => {
  const broken = {
    async *stream() {
      throw new Error('provider exploded')
    },
  }
  assert.equal(await classifyScene(broken, '随便', { scenes: ['database'] }), 'general')
  const invented = routedLlm('{"scene":"quantum-basket-weaving"}')
  assert.equal(await classifyScene(invented, '随便', { scenes: ['database'] }), 'general', 'an invented tag is not a domain')
  assert.equal(await classifyScene(undefined, '随便', { scenes: [] }), 'general')
})

test('v0.7.1: scene routing activates only the matching domain', async () => {
  const skills = mkdtempSync(join(tmpdir(), 'dsh-mem-v07-scene-'))
  const memory = mkdtempSync(join(tmpdir(), 'dsh-mem-v07-scene-m-'))
  writeSkill(skills, dbSkill(), meta)
  writeSkill(
    skills,
    dbSkill({
      name: 'ui-shape',
      title: '界面组件测试',
      description: '渲染组件并断言样式。',
      when: '当需要写界面组件测试时',
      scene: 'ui',
      aliases: ['组件测试', '样式断言'],
      steps: ['渲染组件', '断言样式'],
      verify: ['快照通过'],
    }),
    meta,
  )
  assert.deepEqual(collectScenes(memory, skills).sort(), ['database', 'ui'])
  // "本地存储" is a database ask in plain language; the classifier says so.
  const llm = routedLlm('{"scene":"database"}', '{"apply":["db-shape"]}')
  const result = await retrieveWithFilter(memory, skills, '搞个本地存储，存点记录', { llm, floor: 0.2 })
  assert.equal(result.skill?.id, 'db-shape')
  assert.equal(result.skill?.scene, 'database')
  assert.ok(!(result.candidates ?? []).some((candidate) => candidate.id === 'ui-shape'), 'the UI skill must not even be a candidate')
})

test('v0.7.1: python 3.8 vs 3.12 is a conflict, never a merge', () => {
  const skills = mkdtempSync(join(tmpdir(), 'dsh-mem-v07-env-'))
  const py38 = dbSkill({
    name: 'pymysql-connect',
    title: 'pymysql 连接',
    when: '当需要用 Python 连接 MySQL 时',
    steps: ['用 python 3.8 安装 pymysql', '建立连接并查询'],
    aliases: [],
  })
  const py312 = {
    ...py38,
    title: '标准库连接',
    steps: ['用 python 3.12 的内置驱动建立连接', '执行查询'],
  }
  assert.equal(writeSkill(skills, py38, meta), 'created')
  const status = writeSkill(skills, py312, meta)
  assert.match(status, /^conflicted:/u, `expected a conflict, got ${status}`)
  const original = readFileSync(skillPath(skills, 'pymysql-connect'), 'utf8')
  const alternative = readFileSync(skillPath(skills, 'pymysql-connect-2'), 'utf8')
  /**
   * v1.0.0: the two-way link is an EDGE, not a frontmatter line in each file. What this
   * test protects — "a one-way link makes the unlinked one look authoritative" — is now
   * enforced by the index being unordered: `hasEdge` is true from either direction, so a
   * one-way record is structurally impossible.
   */
  assert.equal(hasEdge(skills, 'pymysql-connect', 'pymysql-connect-2'), true,
    'the link must be symmetric')
  assert.equal(hasEdge(skills, 'pymysql-connect-2', 'pymysql-connect'), true,
    'lookup from the other side must agree')
  assert.match(alternative, /python 3\.12/u)
  assert.match(original, /python 3\.8/u)
})

test('v0.7.1: identical environment still merges (the guard is not over-eager)', () => {
  const skills = mkdtempSync(join(tmpdir(), 'dsh-mem-v07-merge-'))
  const first = dbSkill({ name: 'pymysql-connect', when: '当需要用 Python 连接 MySQL 时', steps: ['用 python 3.8 安装 pymysql', '建立连接'] })
  assert.equal(writeSkill(skills, first, meta), 'created')
  assert.equal(writeSkill(skills, { ...first, title: 'pymysql 连接（补充）' }, { sessionId: 'session-beta', boundarySeq: 11 }), 'merged')
  const text = readFileSync(skillPath(skills, 'pymysql-connect'), 'utf8')
  assert.match(text, /sources: 2/u)
})

test('v0.7.1: feedback raises a confirmed skill and lowers a failed one', () => {
  const skills = mkdtempSync(join(tmpdir(), 'dsh-mem-v07-feedback-'))
  assert.equal(writeSkill(skills, dbSkill(), meta), 'created')
  assert.match(readFileSync(skillPath(skills, 'db-shape'), 'utf8'), /^confidence: 1\.00$/mu)

  const negative = applySkillFeedback(skills, ['db-shape'], 'negative')
  assert.equal(negative.updated[0].confidence, 0.9)
  applySkillFeedback(skills, ['db-shape'], 'negative')
  const text = readFileSync(skillPath(skills, 'db-shape'), 'utf8')
  assert.match(text, /^confidence: 0\.80$/mu)
  assert.match(text, /^last_feedback: negative$/mu)

  const positive = applySkillFeedback(skills, ['db-shape'], 'positive', '2026-01-02T00:00:00.000Z')
  assert.equal(positive.updated[0].confidence, 0.85)
  const after = readFileSync(skillPath(skills, 'db-shape'), 'utf8')
  assert.match(after, /^last_validated: 2026-01-02T00:00:00\.000Z$/mu, 'a confirmed use restarts the decay clock')
  assert.match(after, /^confidence: 0\.85$/mu)
  // Floor: repeated failures must not make a skill disappear.
  for (let index = 0; index < 20; index += 1) applySkillFeedback(skills, ['db-shape'], 'negative')
  assert.match(readFileSync(skillPath(skills, 'db-shape'), 'utf8'), /^confidence: 0\.20$/mu)
  assert.deepEqual(applySkillFeedback(skills, ['ghost-skill'], 'positive').missing, ['ghost-skill'])
})

test('v0.7.1: a lowered confidence ranks the skill down, not out', () => {
  const skills = mkdtempSync(join(tmpdir(), 'dsh-mem-v07-rank-'))
  const memory = mkdtempSync(join(tmpdir(), 'dsh-mem-v07-rank-m-'))
  writeSkill(skills, dbSkill(), meta)
  const fresh = retrieve(memory, skills, '连接数据库查询', { threshold: 0.1, scene: 'database' })
  const freshScore = fresh.skill?.score ?? 0
  applySkillFeedback(skills, ['db-shape'], 'negative')
  applySkillFeedback(skills, ['db-shape'], 'negative')
  const weakened = retrieve(memory, skills, '连接数据库查询', { threshold: 0.05, scene: 'database' })
  assert.ok((weakened.skill?.score ?? 0) < freshScore, `${weakened.skill?.score} must rank below ${freshScore}`)
})

test('v0.7.1: bare seq pointers migrate to composite refs, idempotently', () => {
  const skills = mkdtempSync(join(tmpdir(), 'dsh-mem-v07-mig-'))
  const memory = mkdtempSync(join(tmpdir(), 'dsh-mem-v07-mig-m-'))
  mkdirSync(join(skills, 'legacy-skill'), { recursive: true })
  writeFileSync(
    skillPath(skills, 'legacy-skill'),
    [
      '---',
      'name: legacy-skill',
      'description: 旧技能',
      'when_to_use: 当需要连接数据库时',
      'scene: database',
      'evidence: 14926,29810',
      '---',
      '# 旧技能',
      '',
      '## 执行步骤',
      '',
      '1. 建立连接',
      '2. 执行查询',
      '',
      '## 验证标准',
      '',
      '- 返回行数',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(memory, 'negatives.jsonl'),
    JSON.stringify({ symptom: '连接超时', cause: '网络', avoid: '重试', evidence: [14926], hits: 1 }) + '\n',
    'utf8',
  )
  // Legacy facts row: a bare seq with no session id (pre-v0.7 shape).
  writeFileSync(
    join(memory, 'facts.jsonl'),
    JSON.stringify({ text: '查询返回了三行记录', scene: 'database', evidence: [3], sourceSessionId: '', boundarySeq: 9, hits: 1 }) + '\n',
    'utf8',
  )

  const report = migrateBareEvidence(memory, skills, 'handoff-v75-memory')
  assert.deepEqual(report.skills, [{ name: 'legacy-skill', rewritten: 2 }])
  assert.equal(report.negatives, 1)
  assert.equal(report.facts, 1)
  const text = readFileSync(skillPath(skills, 'legacy-skill'), 'utf8')
  assert.match(text, /^evidence: handoff-v75-memory@14926,handoff-v75-memory@29810$/mu)
  const negative = JSON.parse(readFileSync(join(memory, 'negatives.jsonl'), 'utf8').trim())
  assert.deepEqual(negative.evidence, [{ sourceSessionId: 'handoff-v75-memory', seq: 14926 }])
  assert.equal(negative.sourceSessionId, 'handoff-v75-memory')
  const fact = JSON.parse(readFileSync(join(memory, 'facts.jsonl'), 'utf8').trim())
  assert.deepEqual(fact.evidence[0], { sourceSessionId: 'handoff-v75-memory', seq: 3 })
  assert.equal(fact.sourceSessionId, 'handoff-v75-memory')

  // Second run is a no-op: no duplicate prefixes, counts unchanged.
  const again = migrateBareEvidence(memory, skills, 'handoff-v75-memory')
  assert.deepEqual(again.skills, [])
  assert.equal(again.negatives, 0)
})

test('v0.7.1: 5 readers against 1 writer never see a torn negative ledger', async () => {
  const memory = mkdtempSync(join(tmpdir(), 'dsh-mem-v07-conc-'))
  const writers = { done: false }
  const base = {
    symptom: '合法写入被撕裂',
    cause: '没有原子写',
    avoid: '先写临时文件再改名',
    evidence: [1],
    scope: 'project',
    scene: 'database',
  }
  // Reader: parse every line of the ledger; a torn write would throw here.
  const reader = async (id) => {
    let reads = 0
    while (!writers.done) {
      let text
      try {
        text = readFileSync(join(memory, 'negatives.jsonl'), 'utf8')
      } catch {
        await new Promise((resolve) => setImmediate(resolve))
        continue
      }
      for (const line of text.split(/\r?\n/u).filter(Boolean)) {
        const record = JSON.parse(line)
        assert.equal(typeof record.symptom, 'string', `reader ${id} saw a torn line`)
      }
      reads += 1
      await new Promise((resolve) => setImmediate(resolve))
    }
    return reads
  }
  const writer = async () => {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    for (let index = 0; index < 40; index += 1) {
      // Distinct TWO-letter tags: normalizeForMatch lowercases and strips digits,
      // so a plain counter would collapse the rows into duplicates.
      const tag = letters[index % letters.length] + letters[Math.floor(index / letters.length)]
      appendNegatives(
        memory,
        [{ ...base, symptom: `合法写入被撕裂 ${tag}`, cause: `没有原子写 ${tag}`, avoid: `先写临时文件再改名 ${tag}` }],
        meta,
      )
      await new Promise((resolve) => setImmediate(resolve))
    }
    writers.done = true
  }
  const readers = await Promise.all([...Array.from({ length: 5 }, (_, id) => reader(id)), writer()])
  assert.ok(readers.slice(0, 5).every((count) => count > 0), 'every reader actually ran')
  const finalLines = readFileSync(join(memory, 'negatives.jsonl'), 'utf8').split(/\r?\n/u).filter(Boolean)
  assert.equal(finalLines.length, 40)
})