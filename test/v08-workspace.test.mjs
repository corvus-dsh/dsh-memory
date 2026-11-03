/**
 * v0.8 WORKSPACE ISOLATION.
 *
 * The failure this suite pins down, measured live: capability memory lives in one
 * global directory (`~/.agents/skills`), so a session working in project A was fed
 * a constraint extracted in project B — including a one-off instruction to delete
 * a file that only ever existed in B. Lexical scoring cannot see a workspace
 * boundary, so these tests assert the boundary is carried in the record and
 * enforced before injection, in BOTH directions: the foreign memory must be
 * refused, and the local one must still arrive.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendExperiences, appendFacts, appendNegatives, readSkillWorkspace, skillPath, writeSkill } from '../lib/store.js'
import { collectScenes, renderHint, retrieve, retrieveWithFilter } from '../lib/retrieve.js'
import { approveSuggestion, listSuggestions, queueSuggestion } from '../lib/suggest.js'
import { memoryAllowsWorkspace, sameWorkspace, workspaceOfSession } from '../lib/workspace.js'

const WORKSPACE_A = 'D:\\项目A'
const WORKSPACE_B = 'D:\\项目B'
const A = 'D:/项目A'
const B = 'D:/项目B'

const skill = {
  name: 'red-test-first',
  title: '先跑冻结构建做红测',
  description: '改动迁移逻辑时，先证明修复有效再动手。',
  when: '改动迁移逻辑且要证明修复有效',
  steps: ['在冻结包跑同一套测试', '确认 3 条必红', '再在现行构建跑绿'],
  verify: ['同一组用例先红后绿，且失败信息指向被改的函数'],
  evidence: [3],
}

const QUERY = '改动迁移逻辑 证明修复有效'

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-ws-'))
  return { root, skills: join(root, 'skills'), memory: join(root, 'memory') }
}

test('v0.8: normalize/same accept separator, case and trailing-slash variants', () => {
  assert.equal(sameWorkspace(WORKSPACE_A, 'd:/项目a'), true, 'Windows paths fold case')
  assert.equal(sameWorkspace(`${WORKSPACE_A}\\`, `${A}/`), true, 'a trailing slash is not a different directory')
  assert.equal(sameWorkspace('\\\\?\\D:\\项目A', A), true, 'the Win32 long-path prefix is stripped')
  assert.equal(sameWorkspace(A, B), false)
  assert.equal(sameWorkspace('', ''), false, 'empty must never match empty')
})

test('v0.8: only `global` escapes the gate, and it must be written down', () => {
  assert.equal(memoryAllowsWorkspace({ scope: 'global', workspace: B, current: A }), true)
  assert.equal(memoryAllowsWorkspace({ scope: 'project', workspace: A, current: A }), true)
  assert.equal(memoryAllowsWorkspace({ scope: 'workspace', workspace: A, current: A }), true)
  assert.equal(memoryAllowsWorkspace({ scope: 'project', workspace: B, current: A }), false)
  // Cannot prove it belongs here → refuse. Missing provenance is not a wildcard.
  assert.equal(memoryAllowsWorkspace({ scope: 'project', workspace: '', current: A }), false)
  assert.equal(memoryAllowsWorkspace({ scope: 'project', workspace: A, current: '' }), false)
})

test('v0.8: a SKILL.md records the workspace it was written from', () => {
  const { skills, memory } = dirs()
  writeSkill(skills, skill, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE_A })
  const text = readFileSync(skillPath(skills, skill.name), 'utf8')
  assert.match(text, /^workspace: D:\/项目A$/mu, 'frontmatter carries real provenance, not a lowercased blob')
  assert.equal(readSkillWorkspace(text), A)
  // And it is retrieval metadata, not content: the body must not grow a section.
  assert.doesNotMatch(text, /## workspace/u)
})

test('v0.8: a foreign skill is refused even as the best lexical match; the local one still arrives', () => {
  const { skills, memory } = dirs()
  writeSkill(skills, { ...skill, name: 'red-test-first' }, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE_B })

  const foreign = retrieve(memory, skills, QUERY, { threshold: 0, workspace: A })
  assert.equal(foreign.skill, undefined, 'a memory from another workspace must not be injected')
  assert.ok((foreign.debug.blockedByWorkspace ?? 0) >= 1, 'the refusal is reported, not silent')

  const local = retrieve(memory, skills, QUERY, { threshold: 0, workspace: B })
  assert.ok(local.skill !== undefined, 'the workspace that produced it still sees it')
  assert.equal(local.skill.workspace, B)

  // Same file, same query, opposite answer: the only variable is the workspace.
  assert.equal(
    renderHint(foreign),
    undefined,
    'no hint is rendered when the only candidate belongs to another workspace',
  )
})

test('v0.8: `scope: global` is honoured across workspaces, on purpose', () => {
  const { skills, memory } = dirs()
  writeSkill(skills, { ...skill, scope: 'global' }, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE_B })
  const result = retrieve(memory, skills, QUERY, { threshold: 0, workspace: A })
  assert.ok(result.skill !== undefined, 'a deliberately global skill travels')
  assert.match(readFileSync(skillPath(skills, skill.name), 'utf8'), /^scope: global$/mu)
})

test('v0.8: an unscoped legacy SKILL.md fails closed', () => {
  const { skills, memory } = dirs()
  writeSkill(skills, skill, { sessionId: 's1', boundarySeq: 9 })  // no workspace: pre-v0.8 record
  const text = readFileSync(skillPath(skills, skill.name), 'utf8')
  assert.doesNotMatch(text, /^workspace:/mu)

  const gated = retrieve(memory, skills, QUERY, { threshold: 0, workspace: A })
  assert.equal(gated.skill, undefined, 'no provenance means no injection')
  assert.ok((gated.debug.blockedByWorkspace ?? 0) >= 1)

  // The offline/no-gate path is a deliberate escape hatch for diagnostics only.
  const ungated = retrieve(memory, skills, QUERY, { threshold: 0 })
  assert.ok(ungated.skill !== undefined, 'callers that ask for no gate keep the historical behaviour')
})

test('v0.8: a merge never launders a memory out of its workspace', () => {
  const { skills } = dirs()
  writeSkill(skills, skill, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE_A })
  // A queued suggestion replayed without provenance must inherit, not erase.
  const status = writeSkill(skills, { ...skill, title: '先跑冻结构建做红测（改写）' }, { sessionId: 's2', boundarySeq: 12 })
  assert.equal(status, 'merged')
  assert.equal(readSkillWorkspace(readFileSync(skillPath(skills, skill.name), 'utf8')), A)
})

test('v0.8: negatives, facts and experiences carry the workspace and obey the gate', () => {
  const { skills, memory } = dirs()
  const meta = { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE_B }
  appendNegatives(memory, [{ symptom: '部署脚本必报 SOURCE_DRIFT', cause: '边界判定用错', avoid: '改用 boundarySeq', evidence: [5] }], meta)
  appendFacts(memory, [{ text: '部署脚本在 B 项目里会报 SOURCE_DRIFT', seq: 6, scene: 'deploy' }], meta)
  appendExperiences(memory, [{ text: '在 B 项目里改用 boundarySeq 后部署通过', seq: 7, scene: 'deploy' }], meta)

  const raw = readFileSync(join(memory, 'negatives.jsonl'), 'utf8')
  assert.match(raw, /"workspace":"D:\/项目B"/u, 'the JSONL layers record provenance too')

  const query = '部署脚本 SOURCE_DRIFT deploy boundarySeq'
  const foreign = retrieve(memory, skills, query, { threshold: 0, workspace: A })
  assert.equal(foreign.negative, undefined)
  assert.equal(foreign.fact, undefined)
  assert.equal(foreign.experience, undefined)

  const local = retrieve(memory, skills, query, { threshold: 0, workspace: B })
  assert.ok(local.negative !== undefined, 'the producing workspace keeps its negative path')
})

test('v0.8: the scene vocabulary is read through the gate (no cross-project domains)', () => {
  const { skills, memory } = dirs()
  writeSkill(skills, { ...skill, scene: 'deploy' }, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE_B })
  assert.deepEqual(collectScenes(memory, skills, Date.now(), { workspace: B }), ['deploy'])
  assert.deepEqual(collectScenes(memory, skills, Date.now(), { workspace: A }), [], 'a domain that only exists in B must not route A')
})

test('v0.8: the LLM judge can never resurrect a foreign memory (it is never offered one)', async () => {
  const { skills, memory } = dirs()
  writeSkill(skills, { ...skill, name: 'foreign-only' }, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE_B })
  const llm = {
    async *stream() {
      // A judge that says "yes to everything" is the worst case for the gate.
      yield { type: 'text-delta', text: JSON.stringify({ apply: ['red-test-first', 'foreign-only'] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const result = await retrieveWithFilter(memory, skills, QUERY, { llm, floor: 0.2, workspace: A })
  assert.equal(result.skill, undefined)
  assert.equal(result.filter?.applied, false)
  assert.match(String(result.filter?.reason), /recall floor/u, 'the foreign candidate never entered stage 2')
})

test('v0.8: an approved suggestion keeps the workspace it was harvested in', () => {
  const { skills, memory } = dirs()
  const suggestion = queueSuggestion(memory, 'skill', skill, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE_A })
  assert.equal(listSuggestions(memory).length, 1)
  const approved = approveSuggestion(memory, skills, suggestion.id)
  assert.equal(approved.found, true)
  assert.equal(readSkillWorkspace(readFileSync(skillPath(skills, skill.name), 'utf8')), A, 'review must not strip provenance')
  assert.ok(retrieve(memory, skills, QUERY, { threshold: 0, workspace: A }).skill !== undefined)
  assert.equal(retrieve(memory, skills, QUERY, { threshold: 0, workspace: B }).skill, undefined)
})

test('v0.8: workspaceOfSession reads the log header, never the model', () => {
  assert.equal(workspaceOfSession({ session: { cwd: WORKSPACE_A } }), A)
  assert.equal(workspaceOfSession({ cwd: 'D:\\项目A\\' }), A, 'older flat shapes are accepted')
  assert.equal(workspaceOfSession({ session: {} }), '', 'no cwd = unscoped, not "anywhere"')
  assert.equal(workspaceOfSession({ session: { cwd: WORKSPACE_A } }), A)
})

test('v0.8 pre-step: a foreign skill is not injected, the local one is', async () => {
  const { skills, memory } = dirs()
  writeSkill(skills, { ...skill, name: 'from-b' }, { sessionId: 's1', boundarySeq: 9, workspace: WORKSPACE_B })
  const handlers = []
  const ctx = {
    paths: { data: memory },
    tools: { register: () => {} },
    on: (event, handler) => handlers.push({ event, handler }),
    get: (name) => {
      if (name !== 'llm') return undefined
      return {
        async *stream() {
          yield { type: 'text-delta', text: JSON.stringify({ apply: ['from-b'] }) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
    sessionQuery: { readSession: async () => undefined },
  }
  const { apply } = await import('../lib/index.js')
  apply(ctx, { memoryDir: memory, skillsDir: skills, retrieval: true, retrievalFloor: 0.2 })
  const handler = handlers.find((item) => item.event === 'agent/pre-step')?.handler
  assert.ok(handler !== undefined)

  const messages = [{ role: 'user', content: [{ type: 'text', text: '改动迁移逻辑，怎么证明修复有效？' }] }]
  const fromA = await handler({ agent: { id: 'aA', cwd: WORKSPACE_A }, messages }, async () => ({ kind: 'enter', messages }))
  assert.doesNotMatch(JSON.stringify(fromA), /记忆提示/u, 'a B-project memory must not reach an A-project turn')

  const fromB = await handler({ agent: { id: 'aB', cwd: WORKSPACE_B }, messages }, async () => ({ kind: 'enter', messages }))
  assert.match(JSON.stringify(fromB), /记忆提示/u, 'the producing workspace still gets its hint')
})
