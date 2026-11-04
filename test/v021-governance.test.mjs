/**
 * v0.21 P1 — MEMORY GOVERNANCE: the LLM warning, archival, and negative staleness.
 *
 * Three claims about a long-running store, and why each is worth a test:
 *
 *   1. "LLM unavailable" must be LOUD. A missing provider does not announce itself —
 *      harvest returns nothing and the store simply stops growing, which looks like
 *      "quiet" rather than "broken". Nobody notices until the corpus is stale.
 *   2. The store must not grow without bound. Past the threshold, near-duplicate
 *      triggers merge; what still overflows is ARCHIVED (not deleted), least recently
 *      used first, and retrieval stops seeing it.
 *   3. An old negative is an ANECDOTE, not a rule. Past 30 days with no recurrence it
 *      is down-weighted and the hint says `[历史偶发错误，仅供参考]` BEFORE the claim —
 *      a trailing note reads as a comment, a prefix changes how it is read.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ARCHIVE_FRACTION,
  DEFAULT_SKILL_LIMIT,
  MERGE_SIMILARITY,
  applySkillArchive,
  isArchivedSkill,
  listSkillSummaries,
  planSkillArchive,
  whenSimilarity,
} from '../lib/archive.js'
import {
  NEGATIVE_STALE_DAYS,
  NEGATIVE_STALE_PREFIX,
  NEGATIVE_STALE_WEIGHT,
  isStaleNegative,
  renderHint,
  retrieve,
} from '../lib/retrieve.js'
import { apply } from '../lib/index.js'

const WORKSPACE = 'D:\\持久层能力架构'

function skillDir(root) {
  const dir = join(root, 'skills')
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeSkill(dir, name, { when, scene = 'general', lastUsed = '', archived = false } = {}) {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(
    join(dir, name, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `when_to_use: ${when}`,
      `scene: ${scene}`,
      `workspace: ${WORKSPACE}`,
      ...(lastUsed.length > 0 ? [`last_used: ${lastUsed}`] : []),
      ...(archived ? ['archived: true'] : []),
      '---',
      '',
      `# ${name}`,
      '',
      'body',
      '',
    ].join('\n'),
    'utf8',
  )
  return join(dir, name, 'SKILL.md')
}

// ---------------------------------------------------------------------------
// 1. LLM availability
// ---------------------------------------------------------------------------

test('v0.21 P1: a missing LLM is announced at activation, in the exact sentence', () => {
  const warnings = []
  const ctx = {
    tools: { register: () => {} },
    commands: { register: () => {} },
    paths: { data: mkdtempSync(join(tmpdir(), 'dsh-mem-llm-')) },
    logger: { info: () => {}, warn: (line) => warnings.push(String(line)), error: () => {} },
    get(name) {
      if (name === 'llm') return undefined
      return undefined
    },
    on: () => {},
  }
  apply(ctx, { memoryDir: join(ctx.paths.data, 'memory'), skillsDir: join(ctx.paths.data, 'skills') })
  assert.ok(
    warnings.some((line) => line.includes('[dsh-memory] LLM unavailable. Harvesting is disabled.')),
    `the loud line is required; got: ${JSON.stringify(warnings)}`,
  )
})

test('v0.21 P1: a deliberate scan-only mode is NOT warned about', () => {
  // A warning that fires on a configured state trains people to ignore warnings.
  const warnings = []
  const ctx = {
    tools: { register: () => {} },
    commands: { register: () => {} },
    paths: { data: mkdtempSync(join(tmpdir(), 'dsh-mem-llm2-')) },
    logger: { info: () => {}, warn: (line) => warnings.push(String(line)), error: () => {} },
    get: () => undefined,
    on: () => {},
  }
  apply(ctx, {
    memoryDir: join(ctx.paths.data, 'memory'),
    skillsDir: join(ctx.paths.data, 'skills'),
    extractor: 'off',
  })
  assert.equal(warnings.some((line) => line.includes('LLM unavailable')), false)
})

// ---------------------------------------------------------------------------
// 2. Archival
// ---------------------------------------------------------------------------

test('v0.21 P1: under the limit nothing happens at all', () => {
  const dir = skillDir(mkdtempSync(join(tmpdir(), 'dsh-mem-arch-')))
  for (let index = 0; index < 5; index += 1) writeSkill(dir, `s${index}`, { when: `做第 ${index} 类事情时` })
  const plan = planSkillArchive(listSkillSummaries(dir), DEFAULT_SKILL_LIMIT)
  assert.equal(plan.underLimit, true)
  assert.deepEqual(plan.merges, [])
  assert.deepEqual(plan.archive, [])
})

test('v0.21 P1: near-identical triggers merge instead of being thrown away', () => {
  const dir = skillDir(mkdtempSync(join(tmpdir(), 'dsh-mem-merge-')))
  const when = '当需要给 SKILL.md 写 frontmatter 并给出 when_to_use 时'
  writeSkill(dir, 'writer-a', { when, lastUsed: '2026-01-01T00:00:00.000Z' })
  writeSkill(dir, 'writer-b', { when, lastUsed: '2026-02-01T00:00:00.000Z' })
  for (let index = 0; index < 3; index += 1) writeSkill(dir, `other${index}`, { when: `完全不同的第 ${index} 件事` })

  const summaries = listSkillSummaries(dir)
  const plan = planSkillArchive(summaries, 4)
  assert.equal(plan.underLimit, false)
  assert.equal(plan.merges.length, 1, 'the duplicate pair is merged, not archived')
  assert.deepEqual(plan.merges[0], { absorbed: 'writer-b', keptInto: 'writer-a' })
  assert.deepEqual(plan.archive, [], 'merging alone got us under the limit')
})

test('v0.21 P1: different scenes never merge, however similar the wording', () => {
  const when = '当需要给 SKILL.md 写 frontmatter 时'
  const dir = skillDir(mkdtempSync(join(tmpdir(), 'dsh-mem-scene-')))
  writeSkill(dir, 'db-writer', { when, scene: 'database' })
  writeSkill(dir, 'ui-writer', { when, scene: 'ui' })
  for (let index = 0; index < 3; index += 1) writeSkill(dir, `o${index}`, { when: `别的第 ${index} 件` })
  const plan = planSkillArchive(listSkillSummaries(dir), 4)
  assert.deepEqual(plan.merges, [], 'a database method is not a UI method')
})

test('v0.21 P1: whatever still overflows is archived least-recently-used first', () => {
  const dir = skillDir(mkdtempSync(join(tmpdir(), 'dsh-mem-archive-')))
  // Ten distinct skills, distinct triggers, only some of them ever used.
  for (let index = 0; index < 10; index += 1) {
    writeSkill(dir, `s${index}`, {
      when: `处理编号 ${index} 的独立任务时`,
      lastUsed: index < 3 ? `2026-03-0${index + 1}T00:00:00.000Z` : '',
    })
  }
  const plan = planSkillArchive(listSkillSummaries(dir), 8)
  assert.equal(plan.underLimit, false)
  assert.deepEqual(plan.merges, [], 'nothing is similar enough to merge')
  const expectedMin = Math.ceil(10 * ARCHIVE_FRACTION)
  assert.ok(plan.archive.length >= expectedMin, `archived ${plan.archive.length}, expected >= ${expectedMin}`)
  // Never-used skills go first; deterministic ordering so the pass is auditable.
  assert.equal(plan.archive.includes('s3'), true, 'a never-used skill is archived')
  assert.equal(plan.archive.includes('s0'), false, 'a recently used skill survives')
})

test('v0.21 P1: archiving marks the file and retrieval stops seeing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-apply-'))
  const dir = skillDir(root)
  const path = writeSkill(dir, 'to-archive', { when: '当需要归档测试时', scene: 'testing' })
  const plan = { total: 1, active: 1, merges: [], archive: ['to-archive'], underLimit: false }
  const applied = applySkillArchive(dir, plan)
  assert.deepEqual(applied.archived, ['to-archive'])
  assert.equal(isArchivedSkill(readFileSync(path, 'utf8')), true, 'the mark is in the frontmatter')
  // ...and the summary reflects it, so a second pass does not re-archive it.
  assert.equal(listSkillSummaries(dir)[0].archived, true)

  // Retrieval must not activate it: the activation gate is the single answer to
  // "why did this disappear?".
  const memoryDir = join(root, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const result = retrieve(memoryDir, dir, '当需要归档测试时', { threshold: 0.01, workspace: WORKSPACE })
  assert.equal(result.skill, undefined, 'an archived skill is never injected')
  assert.ok(result.debug.blockedByInvalid >= 1, 'the refusal is counted, not silent')
})

// ---------------------------------------------------------------------------
// 3. Negative staleness
// ---------------------------------------------------------------------------

test('v0.21 P1: an old never-recurred negative is stale; a recurring one is not', () => {
  assert.equal(isStaleNegative({ ageDays: NEGATIVE_STALE_DAYS + 1 }), true)
  assert.equal(isStaleNegative({ ageDays: NEGATIVE_STALE_DAYS - 1 }), false)
  // A negative that keeps happening is a live rule, however old its first sighting.
  assert.equal(isStaleNegative({ ageDays: 400, hits: 5 }), false)
})

test('v0.21 P1: the stale negative is down-weighted AND labelled before the claim', () => {
  const old = new Date(Date.now() - (NEGATIVE_STALE_DAYS + 10) * 86_400_000).toISOString()
  const negative = {
    id: 'neg-0',
    title: 'pytest fixture 报错',
    detail: '别用那个 fixture',
    ageDays: NEGATIVE_STALE_DAYS + 10,
    hits: 1,
    workspace: WORKSPACE,
  }
  const hint = renderHint({
    negative,
    debug: { terms: 1, matched: 1 },
  })
  assert.ok(hint, 'the hint still renders: it is an anecdote, not a deletion')
  assert.ok(hint.includes(NEGATIVE_STALE_PREFIX), 'the label is present')
  // The prefix must come BEFORE the claim, not after it.
  assert.ok(
    hint.indexOf(NEGATIVE_STALE_PREFIX) < hint.indexOf('翻车'),
    'a trailing note reads as a comment; a prefix changes how the sentence is read',
  )
  assert.ok(NEGATIVE_STALE_WEIGHT < 1)
  void old
})

test('v0.21 P1: a fresh negative is rendered without the anecdote label', () => {
  const hint = renderHint({
    negative: { id: 'neg-1', title: '刚发生的翻车', detail: '别做', ageDays: 1, hits: 1, workspace: WORKSPACE },
    debug: { terms: 1, matched: 1 },
  })
  assert.ok(hint)
  assert.equal(hint.includes(NEGATIVE_STALE_PREFIX), false)
})

test('v0.21 P1: similarity is a real measure, not a stub', () => {
  assert.ok(whenSimilarity('当需要写 SKILL.md 的 frontmatter 时', '当需要写 SKILL.md 的 frontmatter 时') > MERGE_SIMILARITY)
  assert.ok(whenSimilarity('当需要写 frontmatter 时', '数据库连接池要设置超时') < MERGE_SIMILARITY)
  assert.equal(whenSimilarity('', '任何东西'), 0)
})
