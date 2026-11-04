/**
 * v0.32 — A PROVIDER THAT REFUSES `reasoningEffort: 'off'`.
 *
 * Measured live on `qiniu` / `deepseek/deepseek-v4.1-flash`:
 *
 *   provider "qiniu" model "deepseek/deepseek-v4.1-flash"
 *   does not support reasoning effort "off"
 *
 * The adjudicator threw on every call, the pre-step path read that as "the judge
 * has no opinion", and every hint silently degraded to strict lexical recall —
 * while `memory_search` reported `applied: false` with exactly that message. The
 * fix is one retry with the field omitted; these tests pin both halves: the
 * retry happens, and an unrelated failure is still NOT retried.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { clearFilterCache, selectApplicableSkills, selectApplicableSkillsDetailed } from '../lib/filter.js'

function hit(id, when) {
  return { kind: 'skill', id, title: id, score: 0.9, when }
}

/** Rejects `reasoningEffort: 'off'` the way the real adapter does; succeeds otherwise. */
function refusingLlm() {
  const state = { calls: 0, efforts: [], budgets: [] }
  return {
    state,
    async *stream(options) {
      state.calls += 1
      state.efforts.push(options.reasoningEffort)
      state.budgets.push(options.maxTokens)
      if (options.reasoningEffort === 'off') {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: 'provider "qiniu" model "deepseek/deepseek-v4.1-flash" does not support reasoning effort "off"',
            },
          },
        }
        return
      }
      yield { type: 'text-delta', text: '{"apply":["relevant"]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

test('v0.32 filter: a refusal of reasoningEffort "off" is retried without the field', async () => {
  clearFilterCache()
  const llm = refusingLlm()
  const picked = await selectApplicableSkills(llm, '连数据库', [hit('relevant', 'w1')], { bypassCache: true })
  assert.deepEqual(picked, ['relevant'], 'the second attempt (field omitted) supplies the verdict')
  assert.equal(llm.state.calls, 2, 'exactly one retry, not a loop')
  assert.deepEqual(llm.state.efforts, ['off', undefined], 'the retry omits the field so the adapter default applies')
})

test('v0.32 filter: the retry budgets for the reasoning the adapter default spends', async () => {
  clearFilterCache()
  const llm = refusingLlm()
  await selectApplicableSkills(llm, '连数据库', [hit('relevant', 'w1')], { bypassCache: true })
  assert.equal(llm.state.budgets[0], 900, 'the cheap first attempt keeps the original budget')
  assert.ok(
    llm.state.budgets[1] >= 4096,
    'measured live: the effort-less adapter reasoned 3593 tokens, so a 900-token budget ended as max-tokens with no JSON',
  )
})

test('v0.32 filter: an unrelated failure is not retried', async () => {
  clearFilterCache()
  const state = { calls: 0 }
  const llm = {
    async *stream() {
      state.calls += 1
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'connection reset by peer' } } }
    },
  }
  await assert.rejects(() => selectApplicableSkills(llm, '连数据库', [hit('relevant', 'w1')], { bypassCache: true }), /connection reset/u)
  assert.equal(state.calls, 1, 'a network error must surface immediately, not double the latency')
})

test('v0.32 filter: a caller that pins its own effort gets exactly one attempt', async () => {
  clearFilterCache()
  const state = { calls: 0, efforts: [] }
  const llm = {
    async *stream(options) {
      state.calls += 1
      state.efforts.push(options.reasoningEffort)
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'does not support reasoning effort "high"' } } }
    },
  }
  await assert.rejects(
    () => selectApplicableSkills(llm, '连数据库', [hit('relevant', 'w1')], { bypassCache: true, reasoningEffort: 'high' }),
    /does not support reasoning effort/u,
  )
  assert.equal(state.calls, 1, 'an explicit effort is an explicit decision; do not silently override it')
  assert.deepEqual(state.efforts, ['high'])
})

/**
 * v0.32 P1 — A JSON DIALECT IS NOT A VERDICT LOSS.
 *
 * Measured live: `Expected property name or '}' in JSON at position 4 (line 2 column 3)`
 * — the model answered with a comment or a trailing comma, and the entire adjudication
 * was discarded, degrading the hint to strict lexical recall.
 */
function replyingWith(text) {
  return {
    async *stream() {
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

test('v0.32 filter: a malformed envelope still yields the apply list (ids validated)', async () => {
  clearFilterCache()
  const reply = '{\n  // 只有一个命中\n  "apply": ["relevant", "hallucinated"],\n  "supersede": []\n}'
  const verdict = await selectApplicableSkillsDetailed(replyingWith(reply), '连数据库', [hit('relevant', 'w1')], {
    bypassCache: true,
    reasoningEffort: 'high',
  })
  assert.deepEqual(verdict.apply, ['relevant'], 'the real id survives; the invented one is dropped')
})

test('v0.32 filter: a malformed envelope can never retire a memory', async () => {
  clearFilterCache()
  const reply = '{"apply": ["relevant"], "supersede": [{"winner":"relevant","loser":"noise","reason":"x"}],}'
  const verdict = await selectApplicableSkillsDetailed(replyingWith(reply), '连数据库', [hit('relevant', 'w1'), hit('noise', 'w2')], {
    bypassCache: true,
    reasoningEffort: 'high',
  })
  assert.deepEqual(verdict.apply, ['relevant'])
  assert.deepEqual(verdict.supersede, [], 'supersede is a WRITE: only strictly parsed JSON may carry it')
})

test('v0.32 filter: an unsalvageable reply still throws (fail closed)', async () => {
  clearFilterCache()
  await assert.rejects(
    () => selectApplicableSkills(replyingWith('我无法判断这些技能是否适用。'), '连数据库', [hit('relevant', 'w1')], {
      bypassCache: true,
      reasoningEffort: 'high',
    }),
    /had no JSON|nothing could be salvaged/u,
  )
})
