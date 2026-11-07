/**
 * v1.6.0 — HYBRID SEARCH: lexical recall, optional semantic rerank.
 *
 * THE PROPERTY THAT MUST HOLD ABOVE ALL OTHERS
 *
 * The reranker may REORDER what lexical recall found. It may never ADD a document lexical recall
 * did not produce. That is what keeps every result explainable — each hit still reports the
 * lexical rank it started from — and it is what stops a hallucinating judge from injecting a
 * memory that does not exist.
 *
 * These tests pin that boundary plus the fallbacks, because a silent fallback would make an
 * offline deployment indistinguishable from a hybrid one in the logs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const layer = await import(new URL('../lib/hybrid-search.js', import.meta.url).href)

function candidates(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `doc-${index}`,
    text: `candidate ${index} about deploy`,
    lexical: 1 - index * 0.05,
    rank: index + 1,
    payload: { index },
  }))
}

test('hybrid: with no reranker the lexical order is returned and the trace says why', async () => {
  const result = await layer.rankHybrid('deploy', candidates(10), { limit: 3 })
  assert.deepEqual(
    result.hits.map((hit) => hit.id),
    ['doc-0', 'doc-1', 'doc-2'],
  )
  assert.equal(result.trace.applied, false)
  assert.match(String(result.trace.reason), /no reranker/u, 'the reason is stated, not implied')
  assert.equal(result.trace.recalled, 10)
})

test('hybrid: the reranker can promote a lower-ranked candidate', async () => {
  const rerank = async () => [
    { id: 'doc-7', relevance: 0.95, reason: '直接回答了查询' },
    { id: 'doc-0', relevance: 0.2 },
  ]
  const result = await layer.rankHybrid('deploy', candidates(10), { limit: 3, rerank })
  assert.equal(result.hits[0].id, 'doc-7', 'the semantically best candidate wins')
  assert.equal(result.hits[0].lexicalRank, 8, 'and its original lexical rank is still reported')
  assert.equal(result.hits[0].semantic, 0.95)
  assert.match(String(result.hits[0].why), /直接回答/u, 'the justification survives to the caller')
  assert.equal(result.trace.applied, true)
})

test('hybrid: the reranker can NEVER introduce a document recall did not find', async () => {
  const rerank = async () => [
    { id: 'invented-doc', relevance: 1, reason: '幻觉' },
    { id: 'doc-1', relevance: 0.5 },
  ]
  const result = await layer.rankHybrid('deploy', candidates(5), { limit: 5, rerank })
  const ids = result.hits.map((hit) => hit.id)
  assert.equal(ids.includes('invented-doc'), false, 'an unknown id is ignored, not admitted')
  assert.equal(ids.length, 5)
  assert.equal(result.trace.judged, 1, 'only the known id counted as judged')
})

test('hybrid: a reranker that throws does not lose the recall that already happened', async () => {
  const rerank = async () => {
    throw new Error('provider down')
  }
  const result = await layer.rankHybrid('deploy', candidates(10), { limit: 3, rerank })
  assert.deepEqual(
    result.hits.map((hit) => hit.id),
    ['doc-0', 'doc-1', 'doc-2'],
    'lexical order survives a failed rerank',
  )
  assert.equal(result.trace.applied, false)
  assert.match(String(result.trace.reason), /provider down/u)
})

test('hybrid: a reranker returning nothing usable falls back with a stated reason', async () => {
  const rerank = async () => []
  const result = await layer.rankHybrid('deploy', candidates(5), { limit: 3, rerank })
  assert.equal(result.trace.applied, false)
  assert.match(String(result.trace.reason), /no usable verdicts/u)
})

test('hybrid: unjudged candidates are not pushed below judged ones arbitrarily', async () => {
  /**
   * A reranker that judges only two of five must not imply the other three are irrelevant.
   * "No opinion" is not "worthless".
   */
  const rerank = async () => [{ id: 'doc-4', relevance: 0.99 }]
  const result = await layer.rankHybrid('deploy', candidates(5), { limit: 5, rerank })
  assert.equal(result.hits[0].id, 'doc-4')
  assert.deepEqual(
    result.hits.slice(1).map((hit) => hit.id),
    ['doc-0', 'doc-1', 'doc-2', 'doc-3'],
    'the unjudged keep their lexical order behind the judged winner',
  )
})

test('hybrid: preferRerank:false keeps lexical order but still reports semantic scores', async () => {
  const rerank = async () => [{ id: 'doc-9', relevance: 0.99 }]
  const result = await layer.rankHybrid('deploy', candidates(10), { limit: 3, rerank, preferRerank: false })
  assert.deepEqual(
    result.hits.map((hit) => hit.id),
    ['doc-0', 'doc-1', 'doc-2'],
    'diagnostics mode does not change behaviour',
  )
})

test('hybrid: out-of-range relevance is clamped to [0,1]', async () => {
  const rerank = async () => [
    { id: 'doc-3', relevance: 42 },
    { id: 'doc-1', relevance: -7 },
  ]
  const result = await layer.rankHybrid('deploy', candidates(5), { limit: 5, rerank })
  const byId = new Map(result.hits.map((hit) => [hit.id, hit]))
  assert.equal(byId.get('doc-3').semantic, 1, 'above 1 becomes 1')
  assert.equal(byId.get('doc-1').semantic, 0, 'below 0 becomes 0')
})

test('hybrid: recallLimit caps what the reranker is asked to judge', async () => {
  let seen = 0
  const rerank = async (_query, list) => {
    seen = list.length
    return []
  }
  await layer.rankHybrid('deploy', candidates(100), { recallLimit: 20, limit: 5, rerank })
  assert.equal(seen, 20, 'the judge sees a shortlist, never the corpus')
})

test('hybrid: no candidates means no work and no reason to blame the reranker', async () => {
  const result = await layer.rankHybrid('nothing matches', [], { limit: 5 })
  assert.deepEqual([...result.hits], [])
  assert.equal(result.trace.recalled, 0)
  assert.match(String(result.trace.reason), /no candidates/u)
})

test('hybrid: parseVerdicts tolerates fences, prose and bad indices', () => {
  const pool = candidates(3)
  const raw = 'Here you go:\n```json\n[{"index":0,"relevance":0.9,"reason":"good"},{"index":9,"relevance":1}]\n```\nDone.'
  const verdicts = layer.parseVerdicts(raw, pool)
  assert.equal(verdicts.length, 1, 'the out-of-range index is dropped')
  assert.equal(verdicts[0].id, 'doc-0')
  assert.equal(verdicts[0].relevance, 0.9)
})

test('hybrid: parseVerdicts returns empty rather than throwing on garbage', () => {
  assert.deepEqual([...layer.parseVerdicts('not json at all', candidates(3))], [])
  assert.deepEqual([...layer.parseVerdicts('[{"index":"x"}]', candidates(3))], [])
  assert.deepEqual([...layer.parseVerdicts('', candidates(3))], [])
})
