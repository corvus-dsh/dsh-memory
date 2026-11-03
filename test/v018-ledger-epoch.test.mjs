/**
 * v0.18 — the ledger epoch, read side.
 *
 * The two plugins are released separately and share only a file format. When the
 * writer is newer than this reader, the honest move is to REFUSE the file and wait
 * for the next round: a skill attributed to a handoff nobody could parse is worse
 * than a skill that arrives one harvest later.
 *
 * What is asserted here:
 *   1. an envelope is read, and its epoch is reported;
 *   2. a legacy bare payload is still read (epoch 1) — the migration is not a flag day;
 *   3. a future epoch and a torn envelope are refused, and the snapshot SAYS SO;
 *   4. a refused ledger never feeds a harvest or a provenance guess.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describeLedgerSkips, readLedgers, SUPPORTED_LEDGER_EPOCH } from '../lib/ledger.js'
import { apply, harvest } from '../lib/index.js'

function dirWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-epoch-'))
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
  }
  return dir
}

function envelope(payload, epoch = SUPPORTED_LEDGER_EPOCH) {
  return { epoch, at: '2026-11-04T00:00:00.000Z', pid: 4242, payload }
}

test('v0.18: an epoch envelope is read, and the epoch is reported', () => {
  const dir = dirWith({
    '.retired.json': envelope(['session-a', 'session-b']),
    '.transferred.json': envelope({ 'session-a': { newSessionId: 'target-a', at: 7 } }),
  })
  const snapshot = readLedgers(dir)
  assert.deepEqual(snapshot.retired, ['session-a', 'session-b'])
  assert.equal(snapshot.transferred['session-a'].newSessionId, 'target-a')
  assert.deepEqual(snapshot.epoch, { retired: SUPPORTED_LEDGER_EPOCH, transferred: SUPPORTED_LEDGER_EPOCH })
  assert.equal(snapshot.deferred, false)
  assert.deepEqual(snapshot.skipped, [])
})

test('v0.18: a legacy bare payload is still read (epoch 1)', () => {
  const dir = dirWith({
    '.retired.json': ['legacy-a'],
    '.transferred.json': { 'legacy-a': { newSessionId: 'legacy-target' } },
  })
  const snapshot = readLedgers(dir)
  assert.deepEqual(snapshot.retired, ['legacy-a'])
  assert.equal(snapshot.transferred['legacy-a'].newSessionId, 'legacy-target')
  assert.deepEqual(snapshot.epoch, { retired: 1, transferred: 1 })
  assert.equal(snapshot.deferred, false)
})

test('v0.18: a future epoch is refused and named as the reason', () => {
  const dir = dirWith({ '.retired.json': envelope(['too-new'], SUPPORTED_LEDGER_EPOCH + 1) })
  const snapshot = readLedgers(dir)
  assert.deepEqual(snapshot.retired, [], 'a newer writer is not interpreted by an older reader')
  assert.equal(snapshot.deferred, true)
  assert.equal(snapshot.skipped.length, 1)
  assert.equal(snapshot.skipped[0].reason, 'future-epoch')
  assert.equal(snapshot.skipped[0].epoch, SUPPORTED_LEDGER_EPOCH + 1)
  assert.match(describeLedgerSkips(snapshot), /retrying next round/u)
  assert.match(describeLedgerSkips(snapshot), /understands up to/u)
})

test('v0.18: a torn envelope is refused, and a retry with a complete one succeeds', () => {
  const dir = dirWith({ '.retired.json': { epoch: SUPPORTED_LEDGER_EPOCH, at: 'now', pid: 1 } })
  const torn = readLedgers(dir)
  assert.deepEqual(torn.retired, [], 'no payload means no entries — never half a record')
  assert.equal(torn.skipped[0].reason, 'torn')
  assert.match(describeLedgerSkips(torn), /incomplete record/u)

  // The retry: the writer lands a complete file.
  writeFileSync(join(dir, '.retired.json'), JSON.stringify(envelope(['session-complete'])), 'utf8')
  const retried = readLedgers(dir)
  assert.deepEqual(retried.retired, ['session-complete'])
  assert.equal(retried.deferred, false)
})

test('v0.18: harvest reports a deferred ledger instead of mining half a record', async () => {
  const graftDataDir = dirWith({ '.retired.json': envelope(['session-half'], SUPPORTED_LEDGER_EPOCH + 1) })
  const memoryDir = mkdtempSync(join(tmpdir(), 'dsh-mem-epoch-store-'))
  const skillsDir = join(memoryDir, 'skills')

  const ctx = {
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
    sessionQuery: { readSession: async () => ({ events: [] }) },
  }
  const report = await harvest(ctx, { memoryDir, skillsDir, graftDataDir, extractor: 'off' })

  assert.equal(report.ledger.deferred, true)
  assert.equal(report.ledger.supportedEpoch, SUPPORTED_LEDGER_EPOCH)
  assert.equal(report.ledger.epoch.retired, SUPPORTED_LEDGER_EPOCH + 1)
  assert.equal(report.scanned, 0, 'nothing is harvested from a refused ledger')
  assert.equal(
    report.warnings.some((warning) => warning.includes('handoff ledger deferred')),
    true,
    'the refusal is in the report, not silent',
  )
  assert.doesNotMatch(JSON.stringify(report.harvested), /session-half/u)
})

test('v0.18: a refused ledger never becomes a provenance guess', async () => {
  const graftDataDir = dirWith({ '.transferred.json': { epoch: SUPPORTED_LEDGER_EPOCH, at: 'now', pid: 1 } })
  const memoryDir = mkdtempSync(join(tmpdir(), 'dsh-mem-epoch-migrate-'))
  const tools = new Map()
  const ctx = {
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
    tools: { register: (tool) => tools.set(tool.name, tool) },
    sessionQuery: { readSession: async () => ({ events: [] }) },
  }
  apply(ctx, { memoryDir, skillsDir: join(memoryDir, 'skills'), graftDataDir })

  const result = await tools.get('memory_migrate_evidence').execute({})
  assert.match(String(result.error), /not trustworthy this round/u)
  assert.match(String(result.error), /retrying next round|Retry/u)
})
