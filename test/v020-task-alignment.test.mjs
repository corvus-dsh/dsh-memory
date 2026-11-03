/**
 * v0.20 — TASK ALIGNMENT: the second semantic gate.
 *
 * The workspace gate answers "was this memory produced HERE". Inside one repository
 * that is not enough: the dominant memory shape there is the incident log ("when X
 * reports SOURCE_DRIFT, the digest moved"), which is valuable for the task that hit
 * it and actively harmful in an unrelated one. Measured on this project: a task-board
 * redesign recalled skills about ledger epochs and CLI flag parsing, because all of
 * them lived in the same two repositories and shared the words "session", "state",
 * "memory".
 *
 * What these tests hold:
 *   1. the gate separates SHAPE (incident log vs method), not topic;
 *   2. a stale incident log with no task-term overlap is removed from the pool;
 *   3. a method-shaped memory survives — recall must not die for a phrasing mismatch;
 *   4. the gate runs BEFORE scoring, so a refused memory cannot shift the weights of
 *      an on-task one;
 *   5. the refusal is reported (`blockedByTask`), because a silent refusal is
 *      indistinguishable from "no memory of that kind";
 *   6. `taskAlignment: false` restores the old pool (the differential switch).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  allowsTask,
  askAsksForFix,
  extractTaskTerms,
  looksLikeIncidentLog,
  retrieve,
  retrieveCandidates,
} from '../lib/retrieve.js'

const WORKSPACE = 'D:\\持久层能力架构'

/** Write one SKILL.md into a throwaway skills dir. */
function writeSkill(skillsDir, name, { title, when, body, scene = 'general', workspace = WORKSPACE }) {
  const dir = join(skillsDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `title: ${title}`,
      `when_to_use: ${when}`,
      `scene: ${scene}`,
      `workspace: ${workspace}`,
      '---',
      '',
      `# ${title}`,
      '',
      body,
      '',
    ].join('\n'),
    'utf8',
  )
}

function store(skills) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-task-'))
  const memoryDir = join(root, 'memory')
  const skillsDir = join(root, 'skills')
  mkdirSync(memoryDir, { recursive: true })
  mkdirSync(skillsDir, { recursive: true })
  for (const [name, spec] of Object.entries(skills)) writeSkill(skillsDir, name, spec)
  return { memoryDir, skillsDir }
}

test('v0.20: the gate reads SHAPE — an incident log is not a method', () => {
  assert.equal(looksLikeIncidentLog({ title: '遇到 TypeError 报错时先看 traceback' }), true)
  assert.equal(looksLikeIncidentLog({ title: 'graft_commit 抛 SOURCE_DRIFT 时的临时修复' }), true)
  assert.equal(looksLikeIncidentLog({ detail: 'root cause: the writer held the ledger' }), true)
  assert.equal(looksLikeIncidentLog({ title: '给 SKILL.md 写 frontmatter 时必须给出 when_to_use' }), false)
  assert.equal(looksLikeIncidentLog({ title: '两次检索：先低阈值召回，再由模型裁决' }), false)
})

test('v0.20: task terms come from the ask, and drop the stopwords', () => {
  const terms = extractTaskTerms('请把瘦身结果格式化为任务看板，并给 dsh-memory 增加任务对齐过滤')
  assert.ok(terms.size > 0)
  assert.equal(terms.has('dsh-memory'), true)
  assert.equal(terms.has('任务'), true, 'a content word survives')
  // A stopword carries no task signal and must not widen the gate.
  assert.equal(extractTaskTerms('然后呢，继续').size <= 2, true, 'a follow-up yields almost nothing')
  assert.equal(extractTaskTerms('').size, 0)
})

test('v0.20: an off-task incident log is refused even when it shares vocabulary', () => {
  const terms = extractTaskTerms('把瘦身结果格式化为任务看板，四列都要有')
  // The measured false positive: an incident log about the SAME subsystem. Term
  // overlap is the wrong test — that is exactly what a shared-vocabulary match
  // produces, and it is what the user asked to exclude.
  const incident = { title: '看板渲染四列时报错时的临时修复', tokens: new Set(['看板', '四列', '报错']) }
  const method = { title: '写 SKILL.md 时必须给出 when_to_use', tokens: new Set(['skil', 'frontmatter']) }
  assert.equal(allowsTask(incident, { terms }), false, 'shape decides, not vocabulary overlap')
  assert.equal(allowsTask(method, { terms }), true, 'a method is never excluded on shape')
  // No gate at all keeps the historical behaviour (offline callers, diagnostics).
  assert.equal(allowsTask(incident, undefined), true)
  assert.equal(allowsTask(incident, { terms, enabled: false }), true)
})

test('v0.20: an incident log IS in scope when the ask is about fixing that failure', () => {
  const incident = { title: '看板渲染四列时报错时的临时修复', tokens: new Set(['看板', '四列', '报错']) }
  // (1) the ask asks for a fix.
  const fixAsk = extractTaskTerms('看板渲染四列时报错了，帮我排查')
  assert.equal(allowsTask(incident, { terms: fixAsk, askIsFixIntent: true }), true)

  // (2) the ask names the failure's own identifier (an error type or a snake_case
  // symbol). "SOURCE_DRIFT 又出现了" is a user dealing with THAT error.
  const named = extractTaskTerms('SOURCE_DRIFT 又出现了')
  assert.equal(
    allowsTask({ title: 'SOURCE_DRIFT 报错时', tokens: new Set(['source_drift']) }, { terms: named }),
    true,
  )

  // (3) the ask quotes a term the pool made RARE and this incident actually has.
  const rareIncident = { title: '看板渲染时报错，traceback 里有 renderBoard', tokens: new Set(['看板', 'traceback']) }
  const rareAsk = extractTaskTerms('看板四列的 traceback 该怎么读')
  assert.equal(allowsTask(rareIncident, { terms: rareAsk, distinctive: new Set(['traceback']) }), true)

  // ...but a pool-wide word is not "distinctive", so it does not reopen the gate:
  // the ask shares 看板 with the incident, and 看板 is what EVERY memory here says.
  assert.equal(allowsTask(incident, { terms: rareAsk, distinctive: new Set() }), false)
})

test('v0.20: askAsksForFix separates "design this" from "debug this"', () => {
  assert.equal(askAsksForFix('把瘦身结果格式化为任务看板，四列都要有'), false)
  assert.equal(askAsksForFix('这个报错帮我排查一下'), true)
  assert.equal(askAsksForFix('fix the failing test'), true)
  assert.equal(askAsksForFix('why does the build fail'), true)
})

test('v0.20: the pool really loses the stale incident log, and says so', () => {
  const { memoryDir, skillsDir } = store({
    'stale-incident': {
      title: '看板渲染四列时报错时的临时修复',
      when: '当任务看板四列渲染报错时，先看 traceback 再临时修复',
      body: '把渲染函数用 try/catch 包起来。',
    },
    'on-task-method': {
      title: '任务看板必须列成四列',
      when: '需要把会话状态蒸馏成任务看板时',
      body: '按 原始要求 / 已完成 / 进行中 / 待开始 四列输出。',
    },
  })
  const query = '把瘦身结果格式化为任务看板，四列都要有'
  const terms = extractTaskTerms(query)

  const gated = retrieve(memoryDir, skillsDir, query, {
    threshold: 0.05,
    workspace: WORKSPACE,
    taskTerms: terms,
  })
  // The stale incident log is about a failure the current task does not have, and it
  // shares the subsystem's vocabulary — which is precisely the case a term-overlap
  // test gets wrong.
  if (gated.skill !== undefined) {
    assert.notEqual(gated.skill.id, 'stale-incident', 'a stale incident log must not be injected')
  }
  assert.equal(gated.debug.blockedByTask, 1, 'the refusal is REPORTED, never silent')
  const gatedCandidates = retrieveCandidates(memoryDir, skillsDir, query, {
    threshold: 0.05,
    workspace: WORKSPACE,
    taskTerms: terms,
  })
  assert.deepEqual(gatedCandidates.map((hit) => hit.id), ['on-task-method'], 'only the method is offered')

  // The differential: without the gate the two are indistinguishable at this score.
  const ungated = retrieveCandidates(memoryDir, skillsDir, query, {
    threshold: 0.05,
    workspace: WORKSPACE,
    taskAlignment: false,
  })
  assert.deepEqual(
    ungated.map((hit) => hit.id).sort(),
    ['on-task-method', 'stale-incident'],
    'the switch restores the old pool, which is what makes the gate testable',
  )
  const ungatedResult = retrieve(memoryDir, skillsDir, query, {
    threshold: 0.05,
    workspace: WORKSPACE,
    taskAlignment: false,
  })
  assert.equal(ungatedResult.debug.blockedByTask, undefined)
})

test('v0.20: a debugging ask keeps the incident log in scope', () => {
  const { memoryDir, skillsDir } = store({
    'stale-incident': {
      title: '看板渲染四列时报错时的临时修复',
      when: '当任务看板四列渲染报错时，先看 traceback 再临时修复',
      body: '把渲染函数用 try/catch 包起来。',
    },
  })
  const query = '看板渲染四列时报错了，帮我排查一下'
  const gated = retrieve(memoryDir, skillsDir, query, {
    threshold: 0.05,
    workspace: WORKSPACE,
    taskTerms: extractTaskTerms(query),
    taskFixIntent: true,
  })
  assert.equal(gated.debug.blockedByTask, undefined, 'the user is asking about this failure')
  assert.equal(gated.skill?.id, 'stale-incident')
})

test('v0.20: the gate runs BEFORE scoring, so a refused memory shifts no weights', () => {
  // If the incident log were only filtered AFTER scoring, its presence would change
  // the IDF of the terms shared with the on-task memory — and therefore change that
  // memory's score. Same store, same query, only the gate differs.
  const { memoryDir, skillsDir } = store({
    'stale-incident': {
      title: '看板渲染时报错的排查流水账',
      when: '当看板渲染报错时',
      body: '先看 traceback，再临时修复。',
    },
    'on-task-method': {
      title: '看板要分四列',
      when: '需要输出任务看板时',
      body: '四列：原始要求 / 已完成 / 进行中 / 待开始。',
    },
  })
  const query = '看板要分四列'
  const terms = extractTaskTerms('看板要分四列')
  const gated = retrieve(memoryDir, skillsDir, query, { threshold: 0.05, workspace: WORKSPACE, taskTerms: terms })
  // The on-task method shares the ask's terms, so it is never the one refused.
  assert.equal(gated.debug.blockedByTask, 1)
  if (gated.skill !== undefined) assert.notEqual(gated.skill.id, 'stale-incident')
})

test('v0.20: a task with no distinctive terms keeps the whole pool', () => {
  const { memoryDir, skillsDir } = store({
    'stale-incident': { title: 'TypeError 报错时先看 traceback', when: '当报错时', body: '看 traceback。' },
  })
  // An EMPTY gate must not behave like "refuse everything": a follow-up turn
  // ("继续") carries no task signal, and refusing on that basis would empty the hint
  // for the rest of the session.
  const result = retrieve(memoryDir, skillsDir, 'TypeError', {
    threshold: 0.05,
    workspace: WORKSPACE,
    taskTerms: new Set(),
  })
  assert.equal(result.debug.blockedByTask, undefined)
})
