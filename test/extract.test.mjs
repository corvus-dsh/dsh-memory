import test from 'node:test'
import assert from 'node:assert/strict'

import { EXTRACT_SYSTEM_PROMPT, extractEpisode, parseExtractionJson, sanitizeExtraction } from '../lib/extract.js'

const episode = {
  sessionId: 's1',
  boundarySeq: 9,
  turns: 3,
  conclusions: [{ text: '结论：先红测再修。', seq: 3 }],
  errors: [{ tool: 'pwsh', text: 'SOURCE_DRIFT', seq: 5 }],
  toolNames: ['pwsh'],
  evidence: [3, 5],
}

const valid = {
  skills: [
    { name: 'red-test-first', title: '先红测', when: '改动迁移逻辑时要证明修复有效', how: ['在冻结包跑同一套测试', '确认必红'], evidence: [3] },
  ],
  negatives: [{ symptom: '合法提交被拒', cause: '整表按位置比较导致错位', avoid: '只比稳定块', evidence: [5] }],
}

test('extract: a well-formed payload survives validation', () => {
  const result = sanitizeExtraction(valid, episode)
  assert.equal(result.skills.length, 1)
  assert.equal(result.skills[0].name, 'red-test-first')
  assert.equal(result.negatives.length, 1)
  assert.deepEqual(result.dropped, [])
})

test('extract: a non-kebab name is refused (SKILL.md grammar)', () => {
  const result = sanitizeExtraction({ skills: [{ ...valid.skills[0], name: 'Red Test' }] }, episode)
  assert.equal(result.skills.length, 0)
  assert.match(result.dropped[0], /kebab-case/u)
})

test('extract: hallucinated evidence seq is refused', () => {
  const result = sanitizeExtraction({ skills: [{ ...valid.skills[0], evidence: [9999] }] }, episode)
  assert.equal(result.skills.length, 0)
  assert.match(result.dropped[0], /evidence/u)
})

test('extract: generic advice is refused', () => {
  const result = sanitizeExtraction(
    { skills: [{ ...valid.skills[0], title: '要小心', when: '每次都要小心一点别出错', how: ['注意细节'] }] },
    episode,
  )
  assert.equal(result.skills.length, 0)
})

test('extract: caps hold at 2 skills (prompt-aligned) and 3 negatives', () => {
  const many = {
    skills: Array.from({ length: 6 }, (_, index) => ({ ...valid.skills[0], name: `skill-${index}` })),
    negatives: Array.from({ length: 6 }, (_, index) => ({ ...valid.negatives[0], symptom: `symptom ${index} long enough` })),
  }
  const result = sanitizeExtraction(many, episode)
  assert.equal(result.skills.length, 2, 'the prompt says at most 2; the code must enforce it')
  assert.equal(result.negatives.length, 3)
})

test('extract: JSON inside a fenced/chatty reply is still parsed', () => {
  const raw = '好的，结果如下：\n```json\n' + JSON.stringify(valid) + '\n```\n'
  const result = parseExtractionJson(raw, episode)
  assert.equal(result.skills.length, 1)
})

test('extract: no llm service is reported, not thrown', async () => {
  const result = await extractEpisode(undefined, episode)
  assert.equal(result.skills.length, 0)
  assert.match(result.dropped[0], /llm service unavailable/u)
})

test('extract: the stream contract yields deltas and finishes', async () => {
  const llm = {
    async *stream(options) {
      assert.ok(options.system === EXTRACT_SYSTEM_PROMPT)
      assert.match(options.messages[0].content[0].text, /ASSISTANT CONCLUSIONS/u)
      yield { type: 'text-delta', text: JSON.stringify(valid) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const result = await extractEpisode(llm, episode)
  assert.equal(result.skills.length, 1)
  assert.equal(result.negatives.length, 1)
  assert.ok(result.rawChars > 0)
})