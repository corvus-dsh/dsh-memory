/**
 * v0.2.0: the second retrieval stage (LLM relevance filter).
 *
 * The motivating live failure: a prompt about a commit-drift bug also recalled
 * `divergent-rebuild-probe`, because both share "prepare / 产物 / 字段". Lexical
 * scoring cannot tell the topics apart; one cheap model call can. These tests
 * pin the contract: the filter may only DROP candidates, must reject invented
 * ids, and must never make retrieval worse than the offline top-1.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendNegatives, writeSkill } from '../lib/store.js'
import { retrieve, retrieveCandidates, retrieveWithFilter, renderHint } from '../lib/retrieve.js'
import { FILTER_SYSTEM_PROMPT, selectApplicableSkills } from '../lib/filter.js'

const RELEVANT = {
  name: 'boundary-seq-fix',
  title: '提交漂移：用 boundarySeq 固定边界',
  description: '两阶段提交漂移校验的修复方法。',
  when: 'graft_commit 返回 SOURCE_DRIFT 或边界 seq 校验失败时',
  steps: ['停止使用可变的 lastSeq', '改用 prepare 时的 boundarySeq', '在任何写入前完成校验'],
  verify: ['连续两次 commit 不再出现 last seq N -> N+1'],
  evidence: [14926],
}

const NOISE = {
  name: 'divergent-rebuild-probe',
  title: '两阶段产物不一致时逐段比对',
  description: 'prepare 与独立重建产物不一致时的定位方法。',
  when: 'prepare 与独立重建产物的字段不一致，而两处调用参数已确认完全相同时',
  steps: ['在同一进程内先 prepare 再重建', '逐段比对找出第一个分叉', '把两侧结构写进错误信息'],
  verify: ['第一个分叉段落被定位到具体字段'],
  evidence: [14704],
}

const PROMPT =
  '排查 graft_commit 反复返回 SOURCE_DRIFT，last seq N -> N+1，边界 seq 校验失败；' +
  '顺便确认这是不是 prepare 与重建产物字段不一致导致的，还是提交漂移本身的问题。'

function store() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-filter-'))
  const skills = join(root, 'skills')
  const memory = join(root, 'memory')
  writeSkill(skills, RELEVANT, { sessionId: 's', boundarySeq: 9 })
  writeSkill(skills, NOISE, { sessionId: 's', boundarySeq: 9 })
  return { skills, memory }
}

function hit(id, when) {
  return { kind: 'skill', id, title: id, score: 0.9, when }
}

function fakeLlm(reply, counter = { calls: 0 }) {
  return {
    counter,
    async *stream(options) {
      counter.calls += 1
      this.lastSystem = options.system
      this.lastInput = options.messages[0].content[0].text
      this.lastProvider = options.provider
      this.lastModel = options.model
      this.lastReasoning = options.reasoningEffort
      yield { type: 'text-delta', text: typeof reply === 'function' ? reply(options) : reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

test('filter: the prompt states the data boundary and demands exact ids', () => {
  assert.match(FILTER_SYSTEM_PROMPT, /DATA/u)
  assert.match(FILTER_SYSTEM_PROMPT, /Never invent/u)
  assert.match(FILTER_SYSTEM_PROMPT, /"apply"/u)
})

test('filter: only the ids the model names survive validation', async () => {
  const llm = fakeLlm('{"apply":["noise","relevant"]}')
  const picked = await selectApplicableSkills(llm, 'q', [hit('relevant', 'w1'), hit('noise', 'w2')])
  assert.deepEqual(picked, ['relevant', 'noise'])
  assert.match(llm.lastInput, /id=relevant/u, 'the model must see the exact ids')
  assert.match(llm.lastInput, /when=w1/u, 'and the trigger, not just the title')
})

test('filter: a hallucinated id is discarded, never forwarded', async () => {
  const llm = fakeLlm('{"apply":["skill-that-does-not-exist","relevant"]}')
  const picked = await selectApplicableSkills(llm, 'q', [hit('relevant', 'w1')])
  assert.deepEqual(picked, ['relevant'])
})

test('filter: a reply with no JSON throws so the caller can fall back', async () => {
  const llm = fakeLlm('抱歉，我无法判断。')
  await assert.rejects(() => selectApplicableSkills(llm, 'q', [hit('a', 'w'), hit('b', 'w')]), /no JSON/u)
})

test('filter: the model route reaches llm.stream, reasoning is OFF (measured: it thought instead of answering)', async () => {
  const llm = fakeLlm('{"apply":["relevant"]}')
  await selectApplicableSkills(llm, 'q', [hit('relevant', 'w')], { provider: 'codearts', model: 'deepseek-v4.1-flash-1017' })
  assert.equal(llm.lastProvider, 'codearts')
  assert.equal(llm.lastModel, 'deepseek-v4.1-flash-1017')
  assert.equal(llm.lastReasoning, 'off')
})

test('retrieveWithFilter: a failing filter reports the reason instead of pretending to filter', async () => {
  const { skills, memory } = store()
  const broken = {
    async *stream() {
      throw new Error('no adapter registered for provider "undefined"')
    },
  }
  const result = await retrieveWithFilter(memory, skills, PROMPT, { llm: broken })
  assert.equal(result.filter?.attempted, true)
  assert.equal(result.filter?.applied, false)
  assert.match(result.filter?.reason ?? '', /no adapter/u)
})

test('retrieveWithFilter: a successful filter is traceable', async () => {
  const { skills, memory } = store()
  const llm = fakeLlm('{"apply":["boundary-seq-fix"]}')
  const result = await retrieveWithFilter(memory, skills, PROMPT, { llm })
  assert.deepEqual(result.filter, { attempted: true, applied: true, kept: ['boundary-seq-fix'] })
})

test('retrieve: two skills above the threshold are both visible before filtering', () => {
  const { skills, memory } = store()
  const candidates = retrieveCandidates(memory, skills, PROMPT, { kind: 'skill', limit: 4 })
  assert.ok(candidates.length >= 2, `expected both candidates, got ${JSON.stringify(candidates)}`)
  const ids = candidates.map((candidate) => candidate.id)
  assert.ok(ids.includes('boundary-seq-fix') && ids.includes('divergent-rebuild-probe'))
})

test('retrieveWithFilter: the lexical false friend is dropped by the model', async () => {
  const { skills, memory } = store()
  const llm = fakeLlm('{"apply":["boundary-seq-fix"]}')
  const result = await retrieveWithFilter(memory, skills, PROMPT, { llm })
  assert.equal(result.skill?.id, 'boundary-seq-fix')
  assert.equal(result.alternatives, undefined, 'the noise skill must not ride along')
  assert.doesNotMatch(renderHint(result) ?? '', /divergent-rebuild-probe|逐段比对/u)
  assert.equal(llm.counter.calls, 1, 'exactly one filter call')
})

test('retrieveWithFilter: even one weak candidate is adjudicated at the low floor', async () => {
  const { skills, memory } = store()
  const llm = fakeLlm('{"apply":[]}')
  const result = await retrieveWithFilter(memory, skills, 'SOURCE_DRIFT 边界 seq 校验失败', { llm })
  assert.equal(llm.counter.calls, 1, 'the net is wide: nothing is injected without a verdict')
  assert.equal(result.skill, undefined, 'a rejected candidate is not injected')
  assert.equal(result.filter?.applied, true)
  assert.equal(renderHint(result), undefined)
})

test('retrieveWithFilter: a failing judge injects nothing (fail closed)', async () => {
  const { skills, memory } = store()
  const broken = {
    async *stream() {
      throw new Error('provider exploded')
    },
  }
  const result = await retrieveWithFilter(memory, skills, PROMPT, { llm: broken })
  assert.equal(result.skill, undefined, 'low-floor candidates must never fall back to a lexical hint')
  assert.equal(result.filter?.applied, false)
  assert.match(result.filter?.reason ?? '', /provider exploded/u)
  assert.equal(renderHint(result), undefined)
  assert.ok((result.candidates ?? []).length > 0, 'candidates stay visible for diagnostics only')
})

test('retrieveWithFilter: no judge means no hint, even with candidates on the table', async () => {
  const { skills, memory } = store()
  const result = await retrieveWithFilter(memory, skills, PROMPT, {})
  assert.equal(result.skill, undefined)
  assert.equal(result.filter?.applied, false)
  assert.match(result.filter?.reason ?? '', /llm unavailable/u)
  assert.ok((result.candidates ?? []).length > 0)
})

test('retrieveWithFilter: an empty verdict injects nothing — not even the negative', async () => {
  const { skills, memory } = store()
  appendNegatives(
    memory,
    [
      {
        symptom: 'graft_commit 反复返回 SOURCE_DRIFT，边界 seq 校验失败',
        cause: '边界判定用可变 lastSeq 且写入早于校验',
        avoid: '改用 boundarySeq 并在任何写入前校验',
        evidence: [14926],
      },
    ],
    { sessionId: 's', boundarySeq: 9 },
  )
  const llm = fakeLlm('{"apply":[]}')
  const result = await retrieveWithFilter(memory, skills, PROMPT, { llm })
  assert.equal(result.skill, undefined, 'the model said no skill applies')
  assert.equal(result.negative, undefined, 'negatives answer to the same verdict at the low floor')
  assert.equal(renderHint(result), undefined)
})

test('retrieveWithFilter: a kept negative still rides along', async () => {
  const { skills, memory } = store()
  appendNegatives(
    memory,
    [
      {
        symptom: 'graft_commit 反复返回 SOURCE_DRIFT，边界 seq 校验失败',
        cause: '边界判定用可变 lastSeq 且写入早于校验',
        avoid: '改用 boundarySeq 并在任何写入前校验',
        evidence: [14926],
      },
    ],
    { sessionId: 's', boundarySeq: 9 },
  )
  const llm = fakeLlm('{"apply":["neg-0"]}')
  const result = await retrieveWithFilter(memory, skills, PROMPT, { llm })
  assert.equal(result.negative?.id, 'neg-0')
  assert.match(renderHint(result) ?? '', /翻车/u)
})

test('v0.4: the recall floor is 0.20 (strict bar kept for offline mode)', async () => {
  const { DEFAULT_RETRIEVAL_FLOOR, DEFAULT_RETRIEVAL_THRESHOLD } = await import('../lib/index.js')
  assert.equal(DEFAULT_RETRIEVAL_FLOOR, 0.2)
  assert.ok(DEFAULT_RETRIEVAL_THRESHOLD > DEFAULT_RETRIEVAL_FLOOR, 'offline mode keeps the strict bar')

  const { skills, memory } = store()
  const query = 'SOURCE_DRIFT 边界 seq'
  assert.equal(retrieveCandidates(memory, skills, query, { threshold: 1.01 }).length, 0, 'nothing clears an impossible floor')
  const wide = retrieveCandidates(memory, skills, query, {})
  assert.ok(wide.length > 0, 'the default floor recalls')

  const llm = fakeLlm(`{"apply":["${wide[0].id}"]}`)
  const result = await retrieveWithFilter(memory, skills, query, { llm, floor: DEFAULT_RETRIEVAL_FLOOR })
  assert.equal(result.skill?.id, wide[0].id)
  assert.ok(renderHint(result) !== undefined)
})

test('retrieveWithFilter: two kept skills render as one hint within 120 chars', async () => {
  const { skills, memory } = store()
  const llm = fakeLlm('{"apply":["boundary-seq-fix","divergent-rebuild-probe"]}')
  const result = await retrieveWithFilter(memory, skills, PROMPT, { llm })
  const hint = renderHint(result)
  assert.ok(hint !== undefined)
  assert.ok(hint.length <= 120, `hint too long: ${hint.length}`)
  assert.match(hint, /「.*」「.*」/u)
})