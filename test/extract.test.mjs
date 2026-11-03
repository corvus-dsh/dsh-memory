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
  facts: [{ text: '合法提交被拒绝，报 SOURCE_DRIFT，但日志里没有任何新事件', seq: 5 }],
  experiences: [{ text: '边界判定用可变 lastSeq 时，校验结果会随自身写入漂移', seq: 5 }],
  skills: [
    {
      name: 'red-test-first',
      title: '先红测',
      description: '改动迁移逻辑时先证明修复有效再改实现。',
      when_to_use: '改动迁移逻辑且要证明修复有效时',
      steps: ['在冻结包跑同一套测试', '确认必红', '再在现行构建跑绿'],
      verify: ['同一用例先红后绿，且失败信息指向被改的函数'],
      evidence: [3],
    },
  ],
  negatives: [{ symptom: '合法提交被拒', cause: '整表按位置比较导致错位', avoid: '只比稳定块', evidence: [5] }],
}

test('extract: the prompt itself demands the four layers and the structured skill shape', () => {
  assert.match(EXTRACT_SYSTEM_PROMPT, /FOUR layers/u)
  assert.match(EXTRACT_SYSTEM_PROMPT, /\bfact\b/u)
  assert.match(EXTRACT_SYSTEM_PROMPT, /\bexperience\b/u)
  assert.match(EXTRACT_SYSTEM_PROMPT, /\bnegative\b/u)
  assert.match(EXTRACT_SYSTEM_PROMPT, /\bskill\b/u)
  // The user's mandated SKILL.md skeleton must be in the prompt verbatim enough
  // for the model to copy: frontmatter keys plus both body sections.
  assert.match(EXTRACT_SYSTEM_PROMPT, /when_to_use: /u)
  assert.match(EXTRACT_SYSTEM_PROMPT, /## 执行步骤/u)
  assert.match(EXTRACT_SYSTEM_PROMPT, /## 验证标准/u)
  assert.match(EXTRACT_SYSTEM_PROMPT, /at least 2 execution steps/u)
})

test('extract: a well-formed four-layer payload survives validation', () => {
  const result = sanitizeExtraction(valid, episode)
  assert.equal(result.facts.length, 1)
  assert.equal(result.facts[0].seq, 5)
  assert.equal(result.experiences.length, 1)
  assert.equal(result.skills.length, 1)
  assert.equal(result.skills[0].name, 'red-test-first')
  assert.deepEqual(result.skills[0].steps, valid.skills[0].steps)
  assert.deepEqual(result.skills[0].verify, valid.skills[0].verify)
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

test('extract: a fact without a real seq pointer is refused (auditability)', () => {
  const missing = sanitizeExtraction({ facts: [{ text: '测试用例传了 100 条数据，但阈值也是 100' }] }, episode)
  assert.equal(missing.facts.length, 0)
  assert.match(missing.dropped[0], /seq pointer/u)
  const hallucinated = sanitizeExtraction({ facts: [{ text: '测试用例传了 100 条数据，但阈值也是 100', seq: 9999 }] }, episode)
  assert.equal(hallucinated.facts.length, 0)
  assert.match(hallucinated.dropped[0], /seq pointer/u)
})

test('extract: a one-line "skill" is refused — the measured v0.1 failure', () => {
  const slogan = sanitizeExtraction(
    { skills: [{ ...valid.skills[0], steps: ['测试样本必须超过阈值'] }] },
    episode,
  )
  assert.equal(slogan.skills.length, 0, 'a single sentence is a conclusion, not a procedure')
  assert.match(slogan.dropped[0], /at least 2 execution steps/u)
})

test('extract: a skill without a verification criterion is refused', () => {
  const result = sanitizeExtraction({ skills: [{ ...valid.skills[0], verify: [] }] }, episode)
  assert.equal(result.skills.length, 0)
  assert.match(result.dropped[0], /verification criterion/u)
})

test('extract: generic advice is refused', () => {
  const result = sanitizeExtraction(
    {
      skills: [
        {
          ...valid.skills[0],
          title: '要小心',
          when_to_use: '每次都要小心一点别出错',
          steps: ['注意细节', '保持整洁'],
          verify: ['不要出错'],
        },
      ],
    },
    episode,
  )
  assert.equal(result.skills.length, 0)
})

test('extract: legacy `when`/`how` aliases still map (queue compatibility), verify still required', () => {
  const legacy = sanitizeExtraction(
    {
      skills: [
        {
          name: 'legacy-skill',
          title: '旧字段',
          when: '旧队列里的触发条件仍然可用',
          how: ['第一步做甲', '第二步做乙'],
          verify: ['看到甲乙都完成'],
          evidence: [3],
        },
      ],
    },
    episode,
  )
  assert.equal(legacy.skills.length, 1)
  assert.equal(legacy.skills[0].when, '旧队列里的触发条件仍然可用')
  assert.deepEqual(legacy.skills[0].steps, ['第一步做甲', '第二步做乙'])
  assert.match(legacy.skills[0].description, /旧队列里的触发条件/u, 'description falls back to when')
})

test('extract: caps hold at 3 facts / 3 experiences / 2 skills / 3 negatives', () => {
  const many = {
    facts: Array.from({ length: 6 }, (_, index) => ({ text: `事实编号 ${index} 足够长可以过校验`, seq: 3 })),
    experiences: Array.from({ length: 6 }, (_, index) => ({ text: `经验编号 ${index} 足够长可以过校验`, seq: 3 })),
    skills: Array.from({ length: 6 }, (_, index) => ({ ...valid.skills[0], name: `skill-${index}` })),
    negatives: Array.from({ length: 6 }, (_, index) => ({ ...valid.negatives[0], symptom: `symptom ${index} long enough` })),
  }
  const result = sanitizeExtraction(many, episode)
  assert.equal(result.facts.length, 3)
  assert.equal(result.experiences.length, 3)
  assert.equal(result.skills.length, 2, 'the prompt says at most 2; the code must enforce it')
  assert.equal(result.negatives.length, 3)
})

test('extract: JSON inside a fenced/chatty reply is still parsed', () => {
  const raw = '好的，结果如下：\n```json\n' + JSON.stringify(valid) + '\n```\n'
  const result = parseExtractionJson(raw, episode)
  assert.equal(result.skills.length, 1)
  assert.equal(result.facts.length, 1)
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
  assert.equal(result.facts.length, 1)
  assert.ok(result.rawChars > 0)
})