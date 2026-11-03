/**
 * v0.15: bi-temporal validity, supersede adjudication, and provenance tiers.
 *
 * The three mechanisms answer three questions the store previously could not:
 *   - WHEN was this true, and when did we stop believing it?   (valid_at/invalid_at)
 *   - is this new rule an ALTERNATIVE or a REPLACEMENT?         (supersede vs conflicts_with)
 *   - WHO says so — the user, a successful run, or a model?     (provenance)
 *
 * Both directions are asserted for each: the new behaviour fires, and the thing it
 * must not break still works.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendNegatives,
  applySupersede,
  isValidAt,
  memoryAuditPath,
  readSkillValidity,
  skillPath,
  writeSkill,
} from '../lib/store.js'
import { FILTER_SYSTEM_PROMPT, selectApplicableSkillsDetailed } from '../lib/filter.js'
import { renderHint, retrieve, retrieveWithFilter } from '../lib/retrieve.js'
import { deriveProvenance } from '../lib/index.js'

const WORKSPACE = 'D:\\项目A'

const skill = {
  name: 'pytest-fast',
  title: '用 pytest -x 先跑红',
  description: '跑测试时先用 -x 快速失败。',
  when: '需要在改动后快速定位第一个失败用例',
  steps: ['运行 pytest -x', '修掉第一个失败', '再整轮跑绿'],
  verify: ['第一个失败被修复后整轮通过'],
  evidence: [3],
}

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-v015-'))
  return { root, skills: join(root, 'skills'), memory: join(root, 'memory') }
}

/** Write a SKILL.md straight to disk: the only way to build an exact fixture. */
function plant(skillsDir, name, fields, body = '') {
  mkdirSync(join(skillsDir, name), { recursive: true })
  writeFileSync(
    skillPath(skillsDir, name),
    ['---', `name: ${name}`, ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), '---', '', `# ${name}`, body].join('\n'),
    'utf8',
  )
}

// ---------------------------------------------------------------------------
// 1. bi-temporal validity
// ---------------------------------------------------------------------------

test('v0.15: a written skill carries valid_at and provenance, and an empty invalid_at means "in force"', () => {
  const { skills, memory } = dirs()
  writeSkill(skills, skill, { sessionId: 's1', boundarySeq: 5, workspace: WORKSPACE, provenance: 'human' })
  const text = readFileSync(skillPath(skills, skill.name), 'utf8')
  assert.match(text, /^valid_at: \d{4}-\d{2}-\d{2}/mu)
  assert.match(text, /^provenance: human$/mu)
  const validity = readSkillValidity(text)
  assert.equal(validity.invalidAt, '', 'a new memory is not invalidated')
  assert.equal(isValidAt(validity), true)

  const result = retrieve(memory, skills, '改动后快速定位第一个失败用例', { threshold: 0, workspace: WORKSPACE })
  assert.ok(result.skill !== undefined)
  assert.equal(result.skill.provenance, 'human')
  assert.equal(result.skill.validAt?.slice(0, 10), new Date().toISOString().slice(0, 10))
})

test('v0.15: an elapsed invalid_at removes the memory from activation; a future one does not', () => {
  const { skills, memory } = dirs()
  const past = new Date(Date.now() - 86_400_000).toISOString()
  plant(skills, 'expired', { when_to_use: '改动后快速定位第一个失败用例', scope: 'project', workspace: WORKSPACE, provenance: 'tool', invalid_at: past, evidence: 's@1' })
  const expired = retrieve(memory, skills, '改动后快速定位第一个失败用例', { threshold: 0, workspace: WORKSPACE })
  assert.equal(expired.skill, undefined, 'an invalidated memory is not activated')
  assert.ok((expired.debug.blockedByInvalid ?? 0) >= 1, 'and the refusal is reported')

  const { skills: skills2, memory: memory2 } = dirs()
  const future = new Date(Date.now() + 86_400_000).toISOString()
  plant(skills2, 'still-valid', { when_to_use: '改动后快速定位第一个失败用例', scope: 'project', workspace: WORKSPACE, provenance: 'tool', invalid_at: future, evidence: 's@1' })
  const alive = retrieve(memory2, skills2, '改动后快速定位第一个失败用例', { threshold: 0, workspace: WORKSPACE })
  assert.ok(alive.skill !== undefined, 'invalidation in the future leaves it in force until then')
  assert.equal(alive.debug.blockedByInvalid, undefined)
})

test('v0.15: the same window applies to negatives.jsonl', () => {
  const { skills, memory } = dirs()
  const meta = { sessionId: 's', boundarySeq: 1, workspace: WORKSPACE, provenance: 'tool' }
  appendNegatives(memory, [{ symptom: '部署脚本必报 SOURCE_DRIFT', cause: '边界判定用错', avoid: '改用 boundarySeq', evidence: [5] }], meta)
  const record = JSON.parse(readFileSync(join(memory, 'negatives.jsonl'), 'utf8').trim())
  assert.equal(record.provenance, 'tool')
  assert.match(String(record.valid_at), /^\d{4}-/u)

  const live = retrieve(memory, skills, '部署脚本 SOURCE_DRIFT boundarySeq', { threshold: 0, workspace: WORKSPACE })
  assert.ok(live.negative !== undefined)

  // Manually invalidate it: the same gate must refuse it, with no separate rule.
  const expired = { ...record, invalid_at: new Date(Date.now() - 86_400_000).toISOString() }
  writeFileSync(join(memory, 'negatives.jsonl'), `${JSON.stringify(expired)}\n`, 'utf8')
  const after = retrieve(memory, skills, '部署脚本 SOURCE_DRIFT boundarySeq', { threshold: 0, workspace: WORKSPACE })
  assert.equal(after.negative, undefined)
  assert.ok((after.debug.blockedByInvalid ?? 0) >= 1)
})

// ---------------------------------------------------------------------------
// 2. supersede
// ---------------------------------------------------------------------------

test('v0.15: supersede invalidates the old skill, links both ways, and audits the decision', () => {
  const { skills, memory } = dirs()
  writeSkill(skills, { ...skill, name: 'pytest-verbose', title: '用 pytest -v' }, { sessionId: 's1', boundarySeq: 1, workspace: WORKSPACE, provenance: 'tool' })
  writeSkill(skills, { ...skill, name: 'pytest-fast' }, { sessionId: 's2', boundarySeq: 2, workspace: WORKSPACE, provenance: 'tool' })

  const result = applySupersede(
    memory,
    skills,
    { winner: 'pytest-fast', loser: 'pytest-verbose', reason: 'same runner, the team settled on -x' },
    { query: '跑测试用哪个参数' },
  )
  assert.equal(result.applied, true)

  const loserText = readFileSync(skillPath(skills, 'pytest-verbose'), 'utf8')
  const loser = readSkillValidity(loserText)
  assert.match(loser.invalidAt, /^\d{4}-/u, 'the old memory gets an invalidation time')
  assert.equal(loser.supersededBy, 'pytest-fast')
  assert.match(loserText, /## ⚠️ 已被取代/u)
  assert.match(loserText, /已被 `pytest-fast` 取代/u, 'the reason is on the record, not only in a log')

  const winnerText = readFileSync(skillPath(skills, 'pytest-fast'), 'utf8')
  assert.deepEqual(readSkillValidity(winnerText).supersedes, ['pytest-verbose'], 'the link is mutual')
  assert.match(winnerText, /## 取代/u)

  const audit = readFileSync(memoryAuditPath(memory), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(audit.at(-1).kind, 'supersede')
  assert.equal(audit.at(-1).winner, 'pytest-fast')
  assert.equal(audit.at(-1).loser, 'pytest-verbose')
  assert.equal(audit.at(-1).query, '跑测试用哪个参数')

  // The old one is now inert, and the new one still answers.
  const hit = retrieve(memory, skills, '跑测试 快速失败', { threshold: 0, workspace: WORKSPACE })
  assert.equal(hit.skill?.id, 'pytest-fast')
  const second = applySupersede(memory, skills, { winner: 'pytest-fast', loser: 'pytest-verbose', reason: 'again' })
  assert.equal(second.applied, false)
  assert.equal(second.status, 'skipped:already-invalid', 'an invalidation is a timeline, not a repeated action')
})

test('v0.15: a machine verdict may NOT invalidate a human-stated memory', () => {
  const { skills, memory } = dirs()
  writeSkill(skills, { ...skill, name: 'human-rule', title: '用户说的规则' }, { sessionId: 's1', boundarySeq: 1, workspace: WORKSPACE, provenance: 'human' })
  writeSkill(skills, { ...skill, name: 'machine-guess', title: '模型推的规则' }, { sessionId: 's2', boundarySeq: 2, workspace: WORKSPACE, provenance: 'inferred' })

  const refused = applySupersede(memory, skills, { winner: 'machine-guess', loser: 'human-rule', reason: 'looks newer' })
  assert.equal(refused.applied, false)
  assert.equal(refused.status, 'refused:human-loser-protected')
  assert.equal(readSkillValidity(readFileSync(skillPath(skills, 'human-rule'), 'utf8')).invalidAt, '', 'the human memory is untouched')
  const audit = readFileSync(memoryAuditPath(memory), 'utf8')
  assert.match(audit, /"kind":"supersede-refused"/u)
  assert.match(audit, /human-sourced/u)

  // The same direction is allowed when the human memory is the WINNER.
  const allowed = applySupersede(memory, skills, { winner: 'human-rule', loser: 'machine-guess', reason: 'the user overruled it' })
  assert.equal(allowed.applied, true)
})

test('v0.15: the filter prompt states the supersede contract and the human veto', () => {
  assert.match(FILTER_SYSTEM_PROMPT, /SUPERSEDE/u)
  assert.match(FILTER_SYSTEM_PROMPT, /NEVER supersede a `human` candidate/u)
  assert.match(FILTER_SYSTEM_PROMPT, /Each candidate shows its PROVENANCE/u, 'the candidates carry their tier into the prompt')
})

test('v0.15: the filter returns a validated supersede verdict, and unknown ids are dropped', async () => {
  const candidates = [
    { kind: 'skill', id: 'new-rule', title: 'n', score: 0.9, provenance: 'tool' },
    { kind: 'skill', id: 'old-rule', title: 'o', score: 0.8, provenance: 'tool' },
    { kind: 'skill', id: 'other', title: 'x', score: 0.7, provenance: 'human' },
  ]
  const llm = (payload) => ({
    async *stream() {
      yield { type: 'text-delta', text: JSON.stringify(payload) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const verdict = await selectApplicableSkillsDetailed(
    llm({ apply: ['new-rule', 'old-rule'], supersede: [{ winner: 'new-rule', loser: 'old-rule', reason: 'same job, newer flag' }, { winner: 'ghost', loser: 'other', reason: 'invented id' }] }),
    'query',
    candidates,
    { bypassCache: true },
  )
  assert.deepEqual(verdict.apply, ['new-rule', 'old-rule'])
  assert.equal(verdict.supersede.length, 1, 'an id that was never offered is discarded')
  assert.deepEqual(verdict.supersede[0].provenance, { winner: 'tool', loser: 'tool' })
})

test('v0.15: the pre-step path persists the verdict; the manual preview does not', async () => {
  const { skills, memory } = dirs()
  writeSkill(skills, { ...skill, name: 'old-rule' }, { sessionId: 's1', boundarySeq: 1, workspace: WORKSPACE, provenance: 'tool' })
  writeSkill(skills, { ...skill, name: 'new-rule' }, { sessionId: 's2', boundarySeq: 2, workspace: WORKSPACE, provenance: 'tool' })
  const writes = []
  const llm = {
    async *stream() {
      yield { type: 'text-delta', text: JSON.stringify({ apply: ['new-rule', 'old-rule'], supersede: [{ winner: 'new-rule', loser: 'old-rule', reason: 'same job' }] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const result = await retrieveWithFilter(memory, skills, '快速定位第一个失败用例 跑测试', {
    llm,
    floor: 0.2,
    workspace: WORKSPACE,
    onSupersede: (decision) => writes.push(decision),
  })
  assert.equal(writes.length, 1)
  assert.equal(result.filter?.supersede?.[0].winner, 'new-rule')

  // Without the callback (the read-only preview), nothing is offered for writing.
  writes.length = 0
  const preview = await retrieveWithFilter(memory, skills, '快速定位第一个失败用例 跑测试', { llm, floor: 0.2, workspace: WORKSPACE })
  assert.equal(writes.length, 0)
  assert.equal(preview.filter?.supersede?.[0].loser, 'old-rule', 'the preview still REPORTS what it would do')
})

// ---------------------------------------------------------------------------
// 3. provenance
// ---------------------------------------------------------------------------

test('v0.15: provenance is derived from the evidence, never from the model', () => {
  const events = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' } } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'plugin:dsh-memory' } } },
    { seq: 3, type: 'tool/result', data: { message: { isError: false } } },
    { seq: 4, type: 'assistant/message', data: {} },
  ]
  assert.equal(deriveProvenance([{ sourceSessionId: 's', seq: 1 }], events), 'human')
  assert.equal(deriveProvenance([{ sourceSessionId: 's', seq: 3 }], events), 'tool')
  assert.equal(deriveProvenance([{ sourceSessionId: 's', seq: 4 }], events), 'inferred')
  assert.equal(
    deriveProvenance([{ sourceSessionId: 's', seq: 2 }, { sourceSessionId: 's', seq: 3 }], events),
    'tool',
    'a plugin-authored user/message is not a human statement',
  )
  assert.equal(
    deriveProvenance([{ sourceSessionId: 's', seq: 3 }, { sourceSessionId: 's', seq: 1 }], events),
    'human',
    'the user outranks a successful run',
  )
  assert.equal(deriveProvenance([], events), 'inferred')
})

test('v0.15: the hint marks tool/inferred provenance and leaves a human rule unmarked', () => {
  const base = { kind: 'skill', id: 'x', title: '先跑冻结构建做红测', score: 0.9 }
  const inferred = renderHint({ skill: { ...base, provenance: 'inferred' }, debug: { terms: 1, matched: 1 } })
  assert.match(String(inferred), /\[来源：工具推断，请核实\]/u)
  const tool = renderHint({ skill: { ...base, provenance: 'tool' }, debug: { terms: 1, matched: 1 } })
  assert.match(String(tool), /\[来源：工具推断，请核实\]/u)
  const human = renderHint({ skill: { ...base, provenance: 'human' }, debug: { terms: 1, matched: 1 } })
  assert.doesNotMatch(String(human), /来源：工具推断/u, 'what the user stated needs no disclaimer')
  // A legacy record without a tier reads as inferred, so it earns the marker.
  const legacy = renderHint({ skill: { ...base }, debug: { terms: 1, matched: 1 } })
  assert.match(String(legacy), /\[来源：工具推断，请核实\]/u)
  // The marker must survive the length cap, not be the part that gets clipped.
  const long = renderHint({
    skill: { ...base, title: '这是一个非常非常长的技能标题用来把提示推到长度上限之上以便验证标记不会被裁掉', provenance: 'inferred' },
    debug: { terms: 1, matched: 1 },
  })
  assert.match(String(long), /\[来源：工具推断，请核实\]/u)
})

test('v0.15: inside a conflict the human-sourced skill takes the primary slot', () => {
  const { skills, memory } = dirs()
  // The inferred one matches the query BETTER; the human one is linked as the
  // conflicting alternative. Authority must win inside the conflict.
  plant(skills, 'inferred-fast', { when_to_use: '连接数据库查询', scope: 'project', workspace: WORKSPACE, provenance: 'inferred', conflicts_with: 'human-choice', evidence: 's@1' })
  plant(skills, 'human-choice', { when_to_use: '数据库取数', scope: 'project', workspace: WORKSPACE, provenance: 'human', conflicts_with: 'inferred-fast', evidence: 's@2' })

  const result = retrieve(memory, skills, '连接数据库查询', { threshold: 0, workspace: WORKSPACE })
  assert.equal(result.skill?.id, 'human-choice', 'the user-stated procedure is the one presented as authoritative')
  assert.equal(result.alternatives?.[0]?.id, 'inferred-fast')

  // With no conflict declared, provenance does not reorder relevance.
  const { skills: plainSkills, memory: plainMemory } = dirs()
  plant(plainSkills, 'inferred-fast', { when_to_use: '连接数据库查询', scope: 'project', workspace: WORKSPACE, provenance: 'inferred', evidence: 's@1' })
  plant(plainSkills, 'human-choice', { when_to_use: '数据库取数', scope: 'project', workspace: WORKSPACE, provenance: 'human', evidence: 's@2' })
  const plain = retrieve(plainMemory, plainSkills, '连接数据库查询', { threshold: 0, workspace: WORKSPACE })
  assert.equal(plain.skill?.id, 'inferred-fast', 'outside a conflict, the better match still wins')
})
