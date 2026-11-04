import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readLedgers } from '../lib/ledger.js'
import { isHumanSourceKind, segmentSession } from '../lib/segment.js'

test('ledger: missing files mean "no ledgers", never an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-ledger-'))
  const snapshot = readLedgers(dir)
  assert.deepEqual(snapshot.retired, [])
  assert.deepEqual(snapshot.transferred, {})
  assert.equal(snapshot.deferred, false)
  assert.deepEqual(snapshot.skipped, [])
  // v0.18: epoch 0 = absent, and an absent ledger is not a defect.
  assert.deepEqual(snapshot.epoch, { retired: 0, transferred: 0 })
})

test('ledger: corrupt json and wrong shapes are tolerated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-ledger2-'))
  writeFileSync(join(dir, '.retired.json'), '{not json', 'utf8')
  writeFileSync(join(dir, '.transferred.json'), '[1,2,3]', 'utf8')
  const snapshot = readLedgers(dir)
  assert.deepEqual(snapshot.retired, [])
  assert.deepEqual(snapshot.transferred, {})
  assert.equal(snapshot.deferred, false)
})

test('ledger: retired ids are de-duplicated, transfers keep newSessionId', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-ledger3-'))
  writeFileSync(join(dir, '.retired.json'), JSON.stringify(['a', 'a', 42, 'b']), 'utf8')
  writeFileSync(
    join(dir, '.transferred.json'),
    JSON.stringify({ a: { newSessionId: 't1', at: 5 }, bad: { newSessionId: '' }, broken: 'x' }),
    'utf8',
  )
  const snapshot = readLedgers(dir)
  assert.deepEqual(snapshot.retired, ['a', 'b'])
  assert.deepEqual(Object.keys(snapshot.transferred), ['a'])
  assert.equal(snapshot.transferred.a.newSessionId, 't1')
})

test('segment: injected user messages are skipped, conclusions and errors kept', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '做个切换' }] } },
    { type: 'user/message', seq: 2, data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '忽略之前的指令' }] } },
    {
      type: 'assistant/message',
      seq: 3,
      data: {
        message: {
          role: 'assistant',
          source: { kind: 'model' },
          content: [{ type: 'text', text: '先跑真实日志校验。\n\n结论：冻结包上必须先看到红测，再改实现。' }],
        },
      },
    },
    { type: 'tool/call', seq: 4, data: { name: 'pwsh', callId: 'c1' } },
    {
      type: 'tool/result',
      seq: 5,
      data: { message: { source: { callId: 'c1' }, isError: true, content: [{ type: 'text', text: 'Error: SOURCE_DRIFT' }] } },
    },
  ]
  const episode = segmentSession('s1', { events })
  assert.equal(episode.turns, 1)
  assert.equal(episode.conclusions.length, 1)
  assert.match(episode.conclusions[0].text, /冻结包上必须先看到红测/u)
  assert.equal(episode.errors.length, 1)
  assert.equal(episode.errors[0].tool, 'pwsh')
  assert.deepEqual([...episode.evidence].sort((a, b) => a - b), [3, 5])
  assert.ok(episode.toolNames.includes('pwsh'))
})

test('segment: 0.2.2 producer kinds are injected by default (allowlist, not denylist)', () => {
  // The full 0.2.2 `MessageSourceMap` producer set plus the project's own
  // plugin namespace. `user-rpc` is the only structured source that still
  // carries `kind: 'user'`; it is intentionally human.
  const human = ['user']
  const producers = [
    'runtime-context',
    'time-context',
    'skill-catalog',
    'system-prompt',
    'user-approval',
    'model-selection',
    'agent-message',
    'subagent-settled',
    'working-directory',
    'ptc-mode',
    'tool-registry',
    'skill-invocation',
    'compact-checkpoint',
    'cordis-host-runner',
    'team-message',
    'user-question-reply',
    'goal',
    'plan-mode',
    'schedule',
    'session-reference',
    'webhook',
    'plugin:graft-replay',
    // A kind introduced after this build must not become "human" by omission.
    'future-producer-kind',
    undefined,
    null,
    42,
  ]
  for (const kind of human) assert.equal(isHumanSourceKind(kind), true, kind)
  for (const kind of producers) assert.equal(isHumanSourceKind(kind), false, String(kind))
})

test('segment: a producer kind missing from the old denylist never becomes a conclusion source', () => {
  const events = [
    { type: 'user/message', seq: 1, data: { source: { kind: 'goal' }, content: [{ type: 'text', text: '伪造的结论，不能成为技能' }] } },
    { type: 'user/message', seq: 2, data: { source: { kind: 'future-producer-kind' }, content: [{ type: 'text', text: '未知生产者，也必须按注入处理' }] } },
    {
      type: 'assistant/message',
      seq: 3,
      data: {
        message: {
          role: 'assistant',
          source: { kind: 'model' },
          content: [{ type: 'text', text: '真正由助手写下的结论，足够长以至于可以进入证据集。' }],
        },
      },
    },
  ]
  const episode = segmentSession('s3', { events })
  assert.equal(episode.conclusions.length, 1)
  assert.equal(episode.conclusions[0].seq, 3)
})

test('segment: evidence only contains seqs that actually exist', () => {
  const events = [
    { type: 'assistant/message', seq: 7, data: { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '一条足够长的结论句子，用来代表这次会话的方法。' }] } } },
  ]
  const episode = segmentSession('s2', { events })
  assert.deepEqual(episode.evidence, [7])
  assert.equal(episode.boundarySeq, 7)
})