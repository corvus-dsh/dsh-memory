import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readLedgers } from '../lib/ledger.js'
import { segmentSession } from '../lib/segment.js'

test('ledger: missing files mean "no ledgers", never an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-ledger-'))
  assert.deepEqual(readLedgers(dir), { retired: [], transferred: {} })
})

test('ledger: corrupt json and wrong shapes are tolerated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-ledger2-'))
  writeFileSync(join(dir, '.retired.json'), '{not json', 'utf8')
  writeFileSync(join(dir, '.transferred.json'), '[1,2,3]', 'utf8')
  assert.deepEqual(readLedgers(dir), { retired: [], transferred: {} })
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

test('segment: evidence only contains seqs that actually exist', () => {
  const events = [
    { type: 'assistant/message', seq: 7, data: { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '一条足够长的结论句子，用来代表这次会话的方法。' }] } } },
  ]
  const episode = segmentSession('s2', { events })
  assert.deepEqual(episode.evidence, [7])
  assert.equal(episode.boundarySeq, 7)
})