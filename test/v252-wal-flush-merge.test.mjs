/**
 * ── v252 (B4-0a③): WAL flush 不许用旧快照覆盖另一个进程已经落盘的行 ────────────────────────────
 *
 * 审计 P0-2 原文：
 *   `src/ledger-cache.ts` `flushLedger`：`writeFileSync(path, body)` 用 `state.records`（本进程上次
 *   加载的数组）整份覆盖主文件，随后 `rmSync(walPathOf(path))`。**写前不 re-stat、不 re-read**。
 *   后果：A 的 5 s 定时 flush 用旧数组覆盖主文件、再删 WAL ⇒ B 刚 append 成功的行在「持久化边界」
 *   之后消失。而 `NODE_TEST_CONTEXT` 强制每写一次 flush，**测试永远看不到这个窗口**。
 *
 * 所以本文件的关键是**制造那个窗口**：外部写入之后，**不经过任何 `readLedger`**，直接调用
 * `flushLedger(path, true)` / `commitLedger(…, { patched: true })` —— 那正是定时器与补丁路径做的事。
 *
 * 判据是「**一行都不许丢**」，不是「把并发变正确」：两个进程同时 PATCH 同一行仍是
 * last-writer-wins（TD-M8 已登记的读-决策-写窗口）。④ 把这条边界写成断言，免得被读成「并发安全」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendRecords,
  clearLedgerCache,
  commitLedger,
  flushLedger,
  lastFlushMergeCount,
  ledgerVersion,
} from '../lib/ledger-cache.js'

const lines = (path) => readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean)
const row = (label, extra = {}) => ({ symptom: label, cause: 'c', avoid: 'a', at: '2026-11-19T00:00:00.000Z', ...extra })

test('v252 ①: 定时器那次 flush（不经任何读）不许抹掉另一个进程写的行', () => {
  clearLedgerCache()
  const root = mkdtempSync(join(tmpdir(), 'dsh-v252-'))
  const path = join(root, 'negatives.jsonl')

  /** Process A: one row, flushed. The cache now holds [A1]. */
  appendRecords(path, [row('A1')])
  assert.equal(lines(path).length, 1)

  /** Process B writes STRAIGHT INTO the main file — exactly what another process's flush looks like. */
  appendFileSync(path, `${JSON.stringify(row('B1'))}\n`, 'utf8')
  assert.equal(lines(path).length, 2, '外部那一行必须真的在盘上（否则这条测试是空的）')

  /** The 5 s timer's call: force a flush with NO read in between. This is the overwrite window. */
  const versionBefore = ledgerVersion(path)
  assert.equal(flushLedger(path, true), true)

  const survivors = lines(path).map((line) => JSON.parse(line).symptom).sort()
  assert.deepEqual(survivors, ['A1', 'B1'], `两行都必须在盘上：${JSON.stringify(survivors)}`)
  assert.ok(ledgerVersion(path) > versionBefore, '合并必须让版本前进（否则下游缓存会继续用旧文档）')
  assert.equal(lastFlushMergeCount(path), 1, '必须报出「这次 flush 保住了 1 行外部写入」')
})

test('v252 ②: 没有外部写入时，flush 行为与旧版逐字相同（不许为了修一个洞改掉正常路径）', () => {
  clearLedgerCache()
  const root = mkdtempSync(join(tmpdir(), 'dsh-v252-clean-'))
  const path = join(root, 'negatives.jsonl')
  appendRecords(path, [row('C1')])
  appendRecords(path, [row('C2')])
  assert.deepEqual(lines(path).map((line) => JSON.parse(line).symptom), ['C1', 'C2'])
  assert.equal(lastFlushMergeCount(path), 0, '没有外部写入就不许报合并')
})

test('v252 ③: 补丁路径（`commitLedger` 的 patched 分支）也不许把外部行挤掉', () => {
  clearLedgerCache()
  const root = mkdtempSync(join(tmpdir(), 'dsh-v252-patch-'))
  const path = join(root, 'negatives.jsonl')
  appendRecords(path, [row('P1')])

  /** External row lands; then THIS process flushes a patch WITHOUT re-reading. */
  appendFileSync(path, `${JSON.stringify(row('EXT'))}\n`, 'utf8')
  commitLedger(path, [], { patched: true })

  const onDisk = lines(path).map((line) => JSON.parse(line)).map((record) => record.symptom).sort()
  assert.deepEqual(onDisk, ['EXT', 'P1'], `补丁 flush 也不许挤掉外部行：${JSON.stringify(onDisk)}`)
})

test('v252 ④: 写明的边界 —— 两进程同时 patch 同一行仍会留下两行（TD-M8，不在本笔）', () => {
  /**
   * Asserted so it cannot be quietly reinterpreted as fixed. Closing it needs a lock around
   * read-decide-write; the P0 fixed here is "a WHOLE ROW another process wrote disappears", a
   * different and cheaper failure.
   */
  clearLedgerCache()
  const root = mkdtempSync(join(tmpdir(), 'dsh-v252-limit-'))
  const path = join(root, 'negatives.jsonl')
  appendRecords(path, [row('SAME', { hits: 1 })])
  /** The external process patched the same row: identical except `hits`. */
  appendFileSync(path, `${JSON.stringify(row('SAME', { hits: 2 }))}\n`, 'utf8')
  commitLedger(path, [], { patched: true })

  const same = lines(path)
    .map((line) => JSON.parse(line))
    .filter((record) => record.symptom === 'SAME')
  assert.equal(same.length, 2, '两个版本都留下 —— 这是已登记的窗口，不是新缺陷')
  assert.equal(lastFlushMergeCount(path), 1, '而且它被如实报出（不是静默）')
})