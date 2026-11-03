/**
 * Plugin wiring: the harvest tool must consume the LEDGER FILE and the
 * `ctx.sessionQuery.readSession` service only. No import of the slicing plugin
 * appears anywhere in this package — that is the contract under test here.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-plugin-'))
  const graftDataDir = join(root, 'data', 'dsh-graft-slice')
  const memoryDir = join(root, 'data', 'dsh-memory', '.dsh-memory')
  const skillsDir = join(root, 'skills')
  mkdirSync(graftDataDir, { recursive: true })
  writeFileSync(join(graftDataDir, '.retired.json'), JSON.stringify(['session-a']), 'utf8')
  writeFileSync(join(graftDataDir, '.transferred.json'), JSON.stringify({ 'session-a': { newSessionId: 'target-a' } }), 'utf8')
  const log = {
    events: [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '结论：先跑真实日志校验，再改断言。' }] } } },
      { type: 'tool/call', seq: 3, data: { name: 'pwsh', callId: 'c1' } },
      { type: 'tool/result', seq: 4, data: { message: { source: { callId: 'c1' }, isError: true, content: [{ type: 'text', text: 'Error: SOURCE_DRIFT' }] } } },
      { type: 'tool/result', seq: 5, data: { message: { source: { callId: 'c2' }, content: [{ type: 'text', text: 'ok' }] } } },
    ],
  }
  const tools = new Map()
  const ctx = {
    paths: { data: join(root, 'data', 'dsh-memory') },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    sessionQuery: { readSession: async (id) => (id === 'session-a' ? log : undefined) },
    get: (name) => {
      if (name !== 'llm') return undefined
      return {
        async *stream() {
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              facts: [{ text: '改断言之前没有先跑真实日志，测试失败原因被误判', seq: 4 }],
              experiences: [{ text: '怀疑测试与实现不一致时，先用真实日志跑一遍再改断言', seq: 2 }],
              skills: [
                {
                  name: 'verify-before-edit',
                  title: '先验证再改断言',
                  description: '怀疑测试与实现不一致时的排查顺序。',
                  when_to_use: '怀疑测试本身与实现不一致时',
                  steps: ['用真实日志跑一遍', '确认失败原因', '再决定改实现还是改断言'],
                  verify: ['修复后同一用例转绿，且失败信息与判断一致'],
                  // v0.6: must cite a real, successful tool result (seq 5), or the
                  // extractor refuses the skill.
                  evidence: [5],
                },
              ],
              negatives: [
                { symptom: '提交被 SOURCE_DRIFT 拒绝', cause: '边界在审核期间移动', avoid: '审核后重新 prepare', evidence: [4] },
              ],
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  apply(ctx, { graftDataDir, memoryDir, skillsDir, extractor: 'llm', autoApprove: true })
  return { ctx, tools, skillsDir, memoryDir, graftDataDir, root }
}

test('plugin: harvest reads the ledger + readSession and writes structured SKILL.md', async () => {
  const { tools, skillsDir, memoryDir } = makeEnv()
  const report = await tools.get('memory_harvest').execute({})
  assert.equal(report.scanned, 1)
  assert.equal(report.harvested.length, 1)
  assert.equal(report.harvested[0].skills[0].status, 'created')
  assert.equal(report.harvested[0].facts, 1, 'the fact layer is persisted with its seq')
  assert.equal(report.harvested[0].experiences, 1)
  assert.ok(existsSync(join(skillsDir, 'verify-before-edit', 'SKILL.md')))
  assert.ok(existsSync(join(memoryDir, 'negatives.jsonl')))
  assert.ok(existsSync(join(memoryDir, 'facts.jsonl')))
  assert.ok(existsSync(join(memoryDir, 'experiences.jsonl')))
  const skillText = readFileSync(join(skillsDir, 'verify-before-edit', 'SKILL.md'), 'utf8')
  assert.match(skillText, /^name: verify-before-edit$/mu)
  assert.match(skillText, /^when_to_use: /mu)
  assert.match(skillText, /^## 执行步骤$/mu)
  assert.match(skillText, /^## 验证标准$/mu)
})

test('plugin: the second harvest is a no-op (idempotent by session+boundarySeq)', async () => {
  const { tools, memoryDir } = makeEnv()
  await tools.get('memory_harvest').execute({})
  const second = await tools.get('memory_harvest').execute({})
  assert.equal(second.scanned, 0, 'processed key must remove the session from the queue')
  assert.equal(second.harvested.length, 0)
  const processed = JSON.parse(readFileSync(join(memoryDir, 'processed.json'), 'utf8'))
  assert.deepEqual(processed, ['session-a:5'])
})

test('plugin: stats and forget are wired', async () => {
  const { tools, skillsDir } = makeEnv()
  await tools.get('memory_harvest').execute({})
  const before = await tools.get('memory_stats').execute({})
  assert.equal(before.skills, 1)
  assert.equal(before.negatives, 1)
  const removed = await tools.get('memory_forget').execute({ name: 'verify-before-edit' })
  assert.equal(removed.removed, true)
  assert.equal(existsSync(join(skillsDir, 'verify-before-edit')), false)
})

test('plugin: extractor=off spends no tokens and writes no skill', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-off-'))
  const graftDataDir = join(root, 'graft')
  mkdirSync(graftDataDir, { recursive: true })
  writeFileSync(join(graftDataDir, '.retired.json'), JSON.stringify(['session-a']), 'utf8')
  const tools = new Map()
  let llmCalls = 0
  const ctx = {
    paths: { data: join(root, 'mem') },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    sessionQuery: { readSession: async () => ({ events: [{ type: 'assistant/message', seq: 1, data: { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '一条足够长的结论，代表这次会话的方法。' }] } } }] }) },
    get: () => ({
      async *stream() {
        llmCalls += 1
        yield { type: 'text-delta', text: '{}' }
      },
    }),
  }
  apply(ctx, { graftDataDir, memoryDir: join(root, 'mem'), skillsDir: join(root, 'skills'), extractor: 'off', autoApprove: true })
  const report = await tools.get('memory_harvest').execute({})
  assert.equal(report.scanned, 1)
  assert.equal(report.harvested.length, 1)
  assert.equal(report.harvested[0].skills.length, 0)
  assert.equal(llmCalls, 0)
})
test('plugin: declares the Cordis contract (name + inject) — without it, tools no-op silently', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'dsh-memory')
  assert.ok(Array.isArray(mod.inject), 'inject must be an array')
  assert.ok(mod.inject.includes('tools'), 'tools must be injected or ctx.tools is undefined')
  assert.ok(mod.inject.includes('sessionQuery'), 'harvest cannot read logs without it')
  assert.equal(mod.activate, mod.apply)
})

test('plugin: a Cordis-style throwing ctx.paths must not fail activation', async () => {
  const tools = new Map()
  const ctx = {
    get: (name) => (name === 'paths' ? { data: mkdtempSync(join(tmpdir(), 'dsh-mem-ctx-')) } : undefined),
    tools: { register: (definition) => tools.set(definition.name, definition) },
    on: () => {},
  }
  Object.defineProperty(ctx, 'paths', {
    get() {
      throw new Error('service not found: paths')
    },
  })
  const { apply } = await import('../lib/index.js')
  apply(ctx, { memoryDir: mkdtempSync(join(tmpdir(), 'dsh-mem-m-')), skillsDir: mkdtempSync(join(tmpdir(), 'dsh-mem-s-')) })
  assert.ok(tools.has('memory_harvest'), 'tools must register even when ctx.paths throws')
  assert.ok(tools.has('memory_stats'))
})

test('plugin: every tool declares output { schema, render } (DSH ToolService contract)', async () => {
  const tools = new Map()
  const ctx = { get: () => undefined, tools: { register: (d) => tools.set(d.name, d) }, on: () => {} }
  const { apply } = await import('../lib/index.js')
  apply(ctx, { memoryDir: mkdtempSync(join(tmpdir(), 'dsh-out-m-')), skillsDir: mkdtempSync(join(tmpdir(), 'dsh-out-s-')) })
  assert.ok(tools.size >= 5, `expected tools, got ${tools.size}`)
  for (const [name, definition] of tools) {
    assert.ok(definition.output !== undefined, `${name} must declare output`)
    assert.equal(typeof definition.output.schema, 'object', `${name}.output.schema`)
    assert.equal(typeof definition.output.render, 'function', `${name}.output.render`)
  }
})

test('plugin: a failed extraction call leaves the session unprocessed (retryable)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-retry-'))
  const graft = join(root, 'graft')
  mkdirSync(graft, { recursive: true })
  writeFileSync(join(graft, '.retired.json'), JSON.stringify(['session-x']), 'utf8')
  const tools = new Map()
  const ctx = {
    paths: { data: join(root, 'mem') },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    sessionQuery: { readSession: async () => ({ events: [{ type: 'assistant/message', seq: 3, data: { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '一条足够长的结论，用来代表这次会话的方法。' }] } } }] }) },
    get: () => ({ async *stream() { throw new Error('provider exploded') } }),
  }
  const { apply } = await import('../lib/index.js')
  apply(ctx, { graftDataDir: graft, memoryDir: join(root, 'mem'), skillsDir: join(root, 'skills'), extractor: 'llm', autoApprove: true })
  const report = await tools.get('memory_harvest').execute({})
  assert.equal(report.scanned, 1)
  assert.equal(report.harvested.length, 0, 'nothing extracted')
  assert.ok(report.warnings.some((line) => line.includes('extraction failed')), JSON.stringify(report.warnings))
  const processedPath = join(root, 'mem', 'processed.json')
  const processed = existsSync(processedPath) ? JSON.parse(readFileSync(processedPath, 'utf8')) : []
  assert.deepEqual(processed, [], 'a failed call must stay retryable')
})

test('segment: resolveModelTarget reads request/context and falls back to the header', async () => {
  const { resolveModelTarget } = await import('../lib/segment.js')
  const fromEvents = resolveModelTarget({
    session: {},
    events: [
      { type: 'request/context', seq: 1, data: { provider: 'codearts', model: 'deepseek-v4.1-flash' } },
      { type: 'request/context', seq: 9, data: { provider: 'codearts', model: 'deepseek-v4.1-flash-1017' } },
    ],
  })
  assert.deepEqual(fromEvents, { provider: 'codearts', model: 'deepseek-v4.1-flash-1017' })
  const fromHeader = resolveModelTarget({ session: { provider: 'deepseek-account', model: 'deepseek-flash' }, events: [] })
  assert.deepEqual(fromHeader, { provider: 'deepseek-account', model: 'deepseek-flash' })
})

test('plugin: memory_search on an empty store returns lossless JSON (no undefined keys)', async () => {
  const tools = new Map()
  const ctx = { get: () => undefined, tools: { register: (d) => tools.set(d.name, d) }, on: () => {} }
  const { apply } = await import('../lib/index.js')
  apply(ctx, { memoryDir: mkdtempSync(join(tmpdir(), 'dsh-empty-m-')), skillsDir: mkdtempSync(join(tmpdir(), 'dsh-empty-s-')) })
  const value = await tools.get('memory_search').execute({ query: '改动迁移逻辑 证明修复有效' })
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, 'undefined properties break the host JSON check')
  assert.equal(Object.values(value).some((item) => item === undefined), false)
})
