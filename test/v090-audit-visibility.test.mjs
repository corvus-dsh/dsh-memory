/**
 * AUDIT ROUND 3 (P1-1): the diagnostics must say how many memories are USABLE, not just how many
 * exist — and the count must agree with what a real turn would see.
 *
 * THE MEASURED CONFUSION this pins down. On the audited machine `memory_stats` reported
 * `skills: 6` while retrieval matched ZERO, because every skill was `scope: project` recorded in a
 * DIFFERENT workspace. Nothing was broken — the fail-closed gate was working — but the only tool
 * that said so belonged to a different plugin (`graft_debug_status`), so a user reading one number
 * had no way to explain the other.
 *
 * THE CONTRACT ASSERTED HERE is stronger than "the field exists": the number `memory_stats` prints
 * must equal the number of skills the SAME predicate lets through. If they can drift, the new field
 * is decoration.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { listSkillRecords, writeSkill } from '../lib/store.js'
import { memoryAllowsWorkspace } from '../lib/workspace.js'

const WORKSPACE_A = 'D:\\项目A'
const WORKSPACE_B = 'D:\\项目B'
const A = 'D:/项目A'
const B = 'D:/项目B'

const SKILL = {
  name: 'red-test-first',
  title: '先跑冻结构建做红测',
  description: '改动迁移逻辑时，先证明修复有效再动手。',
  when: '改动迁移逻辑且要证明修复有效',
  steps: ['在冻结包跑同一套测试', '确认 3 条必红'],
  verify: ['同一组用例先红后绿'],
  evidence: [3],
}

function harness({ skills, memory, sessions }) {
  const handlers = []
  const tools = []
  const ctx = {
    paths: { data: memory },
    tools: { register: (definition) => tools.push(definition) },
    on: (event, handler) => handlers.push({ event, handler }),
    get: (name) => {
      if (name === 'sessions') return { get: (id) => sessions.get(id), list: () => [...sessions.values()].map((s, i) => ({ id: [...sessions.keys()][i], ...s })) }
      return undefined
    },
    logger: { info: () => {}, warn: () => {} },
  }
  return { ctx, tools }
}

test('audit P1-1: memory_stats reports usable-vs-blocked, and the count matches the gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-vis-'))
  const skills = join(root, 'skills')
  const memory = join(root, 'memory')

  // Two skills recorded in project A, one of them global.
  writeSkill(skills, SKILL, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE_A })
  writeSkill(skills, { ...SKILL, name: 'second-here' }, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE_A })

  // The session works in project B, so neither A-recorded skill is eligible.
  const sessions = new Map([['b1', { header: { cwd: WORKSPACE_B } }]])
  const { ctx, tools } = harness({ skills, memory, sessions })
  apply(ctx, { memoryDir: memory, skillsDir: skills, retrieval: true, retrievalFloor: 0.2 })

  const stats = tools.find((tool) => tool.name === 'memory_stats')
  assert.ok(stats !== undefined, 'memory_stats must be registered')

  const out = await stats.execute({}, { agent: { id: 'b1' } })
  assert.ok(out?.counts, 'counts must be present')

  // The new fields exist and are numbers.
  assert.equal(typeof out.counts.matchedInWorkspace, 'number')
  assert.equal(typeof out.counts.blockedByWorkspace, 'number')

  // THE CONTRACT: the printed split equals what the gate itself decides.
  const records = listSkillRecords(skills)
  const current = out.workspace
  const allowed = records.filter((record) =>
    memoryAllowsWorkspace({ scope: record.scope, workspace: record.workspace, current }),
  )
  assert.equal(
    out.counts.matchedInWorkspace,
    allowed.length,
    'the reported usable count must equal what the SAME predicate allows — otherwise it can drift from reality',
  )
  assert.equal(out.counts.blockedByWorkspace, records.length - allowed.length)
  assert.equal(out.counts.skills, records.length, 'the total is still reported')

  // From project B, everything recorded in A is blocked — and the note SAYS why.
  assert.ok(out.counts.blockedByWorkspace > 0, 'these skills were recorded elsewhere and must be blocked')
  assert.equal(typeof out.visibilityNote, 'string')
  assert.match(out.visibilityNote, /工作区隔离|当前工作区/u, 'the note must connect the number to the reason')
  assert.match(out.visibilityNote, /global/u, 'and must name the way out')
})

test('audit P1-1: a skill in the CURRENT workspace counts as usable, and no note is emitted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-vis2-'))
  const skills = join(root, 'skills')
  const memory = join(root, 'memory')

  writeSkill(skills, SKILL, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE_B })
  const sessions = new Map([['b1', { header: { cwd: WORKSPACE_B } }]])
  const { ctx, tools } = harness({ skills, memory, sessions })
  apply(ctx, { memoryDir: memory, skillsDir: skills, retrieval: true, retrievalFloor: 0.2 })

  const out = await tools.find((tool) => tool.name === 'memory_stats').execute({}, { agent: { id: 'b1' } })
  assert.equal(out.counts.matchedInWorkspace, 1, 'a skill recorded HERE is usable')
  assert.equal(out.counts.blockedByWorkspace, 0)
  assert.equal(
    out.visibilityNote,
    undefined,
    'no note when nothing is blocked — a warning that always fires is one nobody reads',
  )
})

test('audit P1-1: a `global` skill is usable from any workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-vis3-'))
  const skills = join(root, 'skills')
  const memory = join(root, 'memory')

  // `writeSkill` takes the scope from the skill record.
  writeSkill(skills, { ...SKILL, scope: 'global' }, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE_A })
  const sessions = new Map([['b1', { header: { cwd: WORKSPACE_B } }]])
  const { ctx, tools } = harness({ skills, memory, sessions })
  apply(ctx, { memoryDir: memory, skillsDir: skills, retrieval: true, retrievalFloor: 0.2 })

  const out = await tools.find((tool) => tool.name === 'memory_stats').execute({}, { agent: { id: 'b1' } })
  assert.equal(out.counts.matchedInWorkspace, 1, 'global escapes the gate — that is the documented way out')
  assert.equal(out.counts.blockedByWorkspace, 0)
})
