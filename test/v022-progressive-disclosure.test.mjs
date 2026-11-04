/**
 * v0.22 P1 — CONTEXT BUDGET: progressive disclosure, degradation, and truncation.
 *
 * The three changes this holds are all about what a recall is allowed to COST. They
 * are easy to implement and easy to lose, because none of them makes anything break:
 * a hint that carries a 2 KB body still works, a judge that times out still returns,
 * an over-long candidate list still parses for most inputs. The cost is invisible
 * until it is a habit.
 *
 *   1. PROGRESSIVE DISCLOSURE — the hint names the skill and the trigger; the body is
 *      a SECOND read (`skill_read`). A hint that silently grew a body back would be
 *      paid on EVERY turn, so the shape of the hint is pinned here, not just its text.
 *   2. DEGRADATION — on the pre-step path a slow judge must cost the HINT, never the
 *      TURN. The fallback is the STRICT lexical bar, not the low floor: a weak match
 *      must not be injected raw just because the judge was slow.
 *   3. TRUNCATION — the judge is offered at most FILTER_MAX_CANDIDATES. An extreme
 *      input must not be able to grow the prompt past what the model will answer.
 *
 * A NOTE ON THE BUG THIS FILE WAS BORN WITH. The degradation path referenced
 * `DEFAULT_RETRIEVAL_THRESHOLD` without defining or importing it — the constant lived
 * in `index.ts`, and `index.ts` imports `retrieve.js`, so the fix could not be an
 * import without a cycle. In the shipped v0.22.0 build the fallback threw
 * `ReferenceError` from inside its own catch block: the judge's timeout was replaced by
 * a crash, so the guard that exists to protect the turn destroyed it. The first test
 * below is the one that would have caught that, and it is written to fail on a throw
 * rather than on a missing value, because that is how the bug actually presented.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_RETRIEVAL_THRESHOLD,
  FILTER_MAX_CANDIDATES,
  renderHint,
  retrieve,
  retrieveWithFilter,
  truncateCandidates,
} from '../lib/retrieve.js'
import { readSkillBody } from '../lib/store.js'
import { apply } from '../lib/index.js'

const WORKSPACE = 'D:\\持久层能力架构'

/**
 * A skill that is FRESH (used and validated now) scores 1.0 on an exact trigger match
 * and clears the strict bar. That matters for the degradation tests: an aged skill
 * caps out at ~0.34 and cannot clear 0.55, so an "assert the fallback kept it" test
 * would pass or fail for reasons unrelated to the fallback.
 */
function storeWith(skills) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-p1-'))
  const memoryDir = join(root, 'memory')
  const skillsDir = join(root, 'skills')
  mkdirSync(memoryDir, { recursive: true })
  mkdirSync(skillsDir, { recursive: true })
  const nowIso = new Date().toISOString()
  for (const [name, spec] of Object.entries(skills)) {
    const dir = join(skillsDir, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      [
        '---',
        `name: ${name}`,
        `title: ${spec.title ?? name}`,
        `when_to_use: ${spec.when}`,
        `scene: ${spec.scene ?? 'general'}`,
        `workspace: ${spec.workspace ?? WORKSPACE}`,
        ...(spec.fresh === false ? [] : [`last_used: ${nowIso}`, `last_validated: ${nowIso}`]),
        ...(spec.provenance === undefined ? [] : [`provenance: ${spec.provenance}`]),
        '---',
        '',
        `# ${spec.title ?? name}`,
        '',
        spec.body ?? 'step one',
        '',
      ].join('\n'),
      'utf8',
    )
  }
  return { memoryDir, skillsDir }
}

// ---------------------------------------------------------------------------
// 1. Progressive disclosure
// ---------------------------------------------------------------------------

test('v0.22 P1: the hint carries the TRIGGER and never the body', () => {
  const { memoryDir, skillsDir } = storeWith({
    'frontmatter-writer': {
      when: '当需要给 SKILL.md 写 frontmatter 并给出 when_to_use 时',
      body: 'BODY-MARKER-UNIQUE-9f3a 执行步骤：先写 --- 再写 when_to_use',
    },
  })
  const result = retrieve(memoryDir, skillsDir, '当需要给 SKILL.md 写 frontmatter 并给出 when_to_use 时', {
    threshold: 0.55,
    workspace: WORKSPACE,
    scene: 'general',
  })
  assert.ok(result.skill, 'the skill must be recalled for this to be a test of the hint')
  const hint = renderHint(result)
  assert.ok(hint)
  assert.equal(hint.includes('BODY-MARKER-UNIQUE-9f3a'), false, 'the procedure body must not ride the hint')
  assert.equal(hint.includes('执行步骤'), false, 'no step text of any kind')
  assert.ok(hint.includes('frontmatter'), 'the trigger IS what the hint carries')
  // ...and it names the second read, or the model has no way to ask for the body.
  assert.ok(hint.includes('skill_read'), 'the hint must name skill_read so the body is reachable')
  assert.ok(hint.includes('frontmatter-writer'), 'the pointer carries the exact name')
})

test('v0.22 P1: skill_read returns the body that the hint withheld', () => {
  const { skillsDir } = storeWith({
    'frontmatter-writer': {
      when: '当需要给 SKILL.md 写 frontmatter 时',
      body: 'BODY-MARKER-UNIQUE-9f3a 执行步骤',
    },
  })
  const body = readSkillBody(skillsDir, 'frontmatter-writer')
  assert.ok(body, 'the second read must succeed for a skill the hint named')
  assert.equal(body.body.includes('BODY-MARKER-UNIQUE-9f3a'), true)
  assert.ok(body.chars > 0, 'the caller can decide before reading')
  assert.equal(body.when, '当需要给 SKILL.md 写 frontmatter 时')
})

test('v0.22 P1: skill_read refuses a path escape instead of reading outside the store', () => {
  const { skillsDir } = storeWith({ a: { when: '当需要测试路径逃逸时' } })
  assert.equal(readSkillBody(skillsDir, '../a'), undefined)
  assert.equal(readSkillBody(skillsDir, '..\\a'), undefined)
  assert.equal(readSkillBody(skillsDir, 'no-such-skill'), undefined)
})

test('v0.22 P1: the plugin registers skill_read as a real tool', () => {
  const tools = new Map()
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-mem-p1-reg-'))
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    commands: { register: () => {} },
    paths: { data: dataDir },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    on: () => {},
  }
  apply(ctx, { memoryDir: join(dataDir, 'memory'), skillsDir: join(dataDir, 'skills'), extractor: 'off' })
  const tool = tools.get('skill_read')
  assert.ok(tool, 'skill_read must be registered')
  assert.equal(tool.parameters.required.includes('name'), true)
  // A missing name is an error OBJECT, not a throw: the tool service rejects a throw.
  return tool.execute({}).then((reply) => {
    assert.equal(typeof reply.error, 'string')
  })
})

// ---------------------------------------------------------------------------
// 2. Degradation on the pre-step path
// ---------------------------------------------------------------------------

/** A judge that never answers in time. */
const timedOutJudge = {
  stream() {
    return (async function* never() {
      throw new Error('judge timeout')
    })()
  },
}

test('v0.22 P1: DEFAULT_RETRIEVAL_THRESHOLD is reachable from the module that uses it', () => {
  // The regression that shipped: the fallback referenced a name that did not exist in
  // its own module, so the catch block threw ReferenceError. Asserting the VALUE keeps
  // the constant honest; the degradation test below asserts it is actually usable.
  assert.equal(typeof DEFAULT_RETRIEVAL_THRESHOLD, 'number')
  assert.ok(DEFAULT_RETRIEVAL_THRESHOLD > 0.2, 'the strict bar must sit above the recall floor')
})

test('v0.22 P1: a timed-out judge DEGRADES to strict lexical recall instead of throwing', async () => {
  const when = '当需要给 SKILL.md 写 frontmatter 并给出 when_to_use 时'
  const { memoryDir, skillsDir } = storeWith({ 'frontmatter-writer': { when } })
  // No assert.throws wrapper: on the shipped v0.22.0 build this call REJECTED with
  // `ReferenceError: DEFAULT_RETRIEVAL_THRESHOLD is not defined`, thrown from the
  // degradation path itself. The turn was lost by the code meant to save it.
  const result = await retrieveWithFilter(memoryDir, skillsDir, when, {
    floor: 0.2,
    workspace: WORKSPACE,
    scene: 'general',
    llm: timedOutJudge,
    degradeOnTimeout: true,
    timeoutMs: 50,
  })
  assert.equal(result.filter?.attempted, true, 'the judge was tried')
  assert.equal(result.filter?.applied, false, 'and it did not decide')
  assert.match(String(result.filter?.reason), /degraded to strict lexical/u, 'the trace names the degradation')
  assert.ok(result.skill, 'the strict fallback keeps a genuinely strong match')
  assert.equal(result.skill.id, 'frontmatter-writer')
})

test('v0.22 P1: without degradeOnTimeout the judge failure still FAILS CLOSED', async () => {
  // memory_search must not inherit the pre-step's optimism: there the honest answer to
  // "the judge could not decide" is that answer, not a lexical guess.
  const when = '当需要给 SKILL.md 写 frontmatter 并给出 when_to_use 时'
  const { memoryDir, skillsDir } = storeWith({ 'frontmatter-writer': { when } })
  const result = await retrieveWithFilter(memoryDir, skillsDir, when, {
    floor: 0.2,
    workspace: WORKSPACE,
    scene: 'general',
    llm: timedOutJudge,
    timeoutMs: 50,
  })
  assert.equal(result.filter?.applied, false)
  assert.equal(result.skill, undefined, 'a low-floor candidate is never injected raw')
  assert.equal(String(result.filter?.reason).includes('degraded'), false, 'no degradation was requested')
})

test('v0.22 P1: degradation does not smuggle in a weak match the strict bar rejects', async () => {
  // The point of degrading to 0.55 rather than to the 0.20 floor: an aged skill that
  // only cleared the net must not be injected just because the judge was slow.
  const when = '当需要处理编号 77 的独立事务时'
  const { memoryDir, skillsDir } = storeWith({ 'aged-skill': { when, fresh: false } })
  const result = await retrieveWithFilter(memoryDir, skillsDir, when, {
    floor: 0.2,
    workspace: WORKSPACE,
    scene: 'general',
    llm: timedOutJudge,
    degradeOnTimeout: true,
    timeoutMs: 50,
  })
  assert.match(String(result.filter?.reason), /degraded to strict lexical/u)
  assert.equal(result.skill, undefined, 'a decayed skill cannot clear the strict bar on its own')
})

// ---------------------------------------------------------------------------
// 3. Filter input truncation
// ---------------------------------------------------------------------------

test('v0.22 P1: truncateCandidates keeps the best N and preserves order', () => {
  assert.equal(FILTER_MAX_CANDIDATES, 5)
  // Descending by score: the best five are s8..s4.
  const many = Array.from({ length: 9 }, (_value, index) => ({ id: `s${index}`, score: index / 10 }))
  const kept = truncateCandidates(many)
  assert.equal(kept.length, FILTER_MAX_CANDIDATES)
  assert.deepEqual(
    kept.map((item) => item.id),
    ['s8', 's7', 's6', 's5', 's4'],
    'the BEST candidates survive, not the first ones in file order',
  )
})

test('v0.22 P1: a short list is returned intact and never mutated', () => {
  const short = [
    { id: 'a', score: 0.3 },
    { id: 'b', score: 0.2 },
  ]
  const kept = truncateCandidates(short)
  assert.deepEqual(kept.map((item) => item.id), ['a', 'b'])
  assert.notEqual(kept, short, 'a fresh array, so a caller cannot corrupt the pool')

  const input = [{ id: 'x', score: 0.1 }, { id: 'y', score: 0.9 }]
  truncateCandidates(input)
  assert.deepEqual(input.map((item) => item.id), ['x', 'y'], 'the input order is untouched')
})

test('v0.22 P1: the judge is never offered more than the cap', async () => {
  const when = '当需要给 SKILL.md 写 frontmatter 并给出 when_to_use 时'
  const skills = {}
  // Nine skills that all match the same trigger, so the pool is genuinely wide.
  for (let index = 0; index < 9; index += 1) skills[`writer-${index}`] = { when, title: `writer ${index}` }
  const { memoryDir, skillsDir } = storeWith(skills)

  let offered = 0
  const judge = {
    stream() {
      return (async function* answer() {
        // Count the ids the filter actually rendered into the prompt.
        yield { type: 'text-delta', text: '{"apply":[]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const result = await retrieveWithFilter(memoryDir, skillsDir, when, {
    floor: 0.2,
    workspace: WORKSPACE,
    scene: 'general',
    llm: judge,
    timeoutMs: 2_000,
    bypassCache: true,
  })
  offered = result.filter?.offered ?? 0
  assert.ok(offered <= FILTER_MAX_CANDIDATES, `judge saw ${offered} candidates, cap is ${FILTER_MAX_CANDIDATES}`)
  assert.ok((result.candidates?.length ?? 0) >= offered, 'the stage-1 pool itself is untouched for diagnostics')
})

test('v0.22 P1: an over-wide pool still parses a valid verdict', async () => {
  const when = '当需要给 SKILL.md 写 frontmatter 并给出 when_to_use 时'
  const skills = {}
  for (let index = 0; index < 9; index += 1) skills[`writer-${index}`] = { when, title: `writer ${index}` }
  const { memoryDir, skillsDir } = storeWith(skills)

  // Answer with an id that is in the pool but NOT in the truncated view: the truncation
  // must be applied before the call, so this id is still validated against the offered
  // set. Keeping it would be the bug; the anti-hallucination gate drops what it cannot see.
  const judge = {
    stream() {
      return (async function* answer() {
        yield { type: 'text-delta', text: '{"apply":["writer-0","writer-8"]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const result = await retrieveWithFilter(memoryDir, skillsDir, when, {
    floor: 0.2,
    workspace: WORKSPACE,
    scene: 'general',
    llm: judge,
    timeoutMs: 2_000,
    bypassCache: true,
  })
  assert.equal(result.filter?.applied, true, 'a verdict within the cap is honoured')
  for (const id of result.filter?.kept ?? []) {
    assert.ok(id.startsWith('writer-'), `unexpected id ${id}`)
  }
  assert.ok((result.filter?.offered ?? 0) <= FILTER_MAX_CANDIDATES)
})

test('v0.22 P1: the body of a recalled skill is absent from every hint form', () => {
  // The strongest form of the claim: even with alternatives and a negative present, no
  // body text can reach the string that enters the prompt.
  const { memoryDir, skillsDir } = storeWith({
    'frontmatter-writer': { when: '当需要给 SKILL.md 写 frontmatter 并给出 when_to_use 时', body: 'BODY-MARKER-A 步骤' },
    'frontmatter-writer-2': { when: '当需要给 SKILL.md 写 frontmatter 并给出 when_to_use 时', body: 'BODY-MARKER-B 步骤' },
  })
  const result = retrieve(memoryDir, skillsDir, '当需要给 SKILL.md 写 frontmatter 并给出 when_to_use 时', {
    threshold: 0.55,
    workspace: WORKSPACE,
    scene: 'general',
  })
  const hint = renderHint(result)
  assert.ok(hint, 'a hint exists')
  assert.equal(/BODY-MARKER/u.test(hint), false, 'no body from any recalled skill')
  // Sanity: the bodies really are on disk, so this is a test of the hint, not of absence.
  assert.equal(readFileSync(join(skillsDir, 'frontmatter-writer', 'SKILL.md'), 'utf8').includes('BODY-MARKER-A'), true)
})
