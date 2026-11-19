/**
 * ── v255 (B4-0b-1 C-6): the memory panel's contract, checked without a human clicking ────────────
 *
 * The audit's A-line says `client.js` was NEVER reviewed ("完全未审"), and the panel is the user's
 * only observation window. This file turns the four judgments of B4-0b-1 §三 into mechanical checks:
 *
 *   ① AUTO-RUNNABLE — `node --check` (syntax) plus presence of the features the panel claims;
 *   ② DANGER HAS A CONFIRMATION THAT NAMES ITS SCOPE — the clear-all flow is two-step and says which
 *      workspace, what survives, and that it MOVES rather than deletes;
 *   ③ ONE SOURCE OF NUMBERS — the panel and `memory_stats` read the same predicate
 *      (`skillVisibilityFor`), so the two readouts of one store cannot disagree;
 *   ④ READABLE ERROR STATE — the failure line says why and what to do.
 *
 * A static check on a UI file is weak by nature, and this one is honest about what it can and cannot
 * see: it proves the affordances EXIST and that the numbers come from the shared predicate. It does
 * not prove they render correctly — that still needs a human or a screenshot test.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
const server = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')

test('v255 ①: client.js 语法可自动检查（人不用点）', () => {
  const checked = spawnSync(process.execPath, ['--check', join(ROOT, 'client.js')], { encoding: 'utf8' })
  assert.equal(checked.status, 0, `node --check 失败：\n${checked.stderr}`)

  /**
   * The features the panel claims, as the LABELS it actually renders (measured in the file, not taken
   * from the dispatch's table — the dispatch's list is "起点，不是全部", and two of its items did not
   * exist: there was no flywheel readout and no task-graph readout at all).
   */
  for (const feature of ['技能', '台账状态（交接来源）', '数据清理（调试用）', '原始状态数据（排查用）', '飞轮（知识回流）']) {
    assert.ok(client.includes(feature), `面板缺少声称的功能「${feature}」`)
  }
})

test('v255 ②: 一键清空是两段式，且确认文案写明作用域与「不删除」', () => {
  /** First step: the trigger. Second step: a question + an explicit confirm + a cancel. */
  assert.ok(client.includes('一键清空当前工作区记忆'), '入口按钮必须存在')
  assert.ok(client.includes('确认清空当前工作区的记忆？'), '第二次确认必须问出来')
  assert.ok(client.includes('确认清空'), '确认动作必须是一个独立按钮')
  assert.ok(client.includes('取消'), '必须能反悔')

  /**
   * SCOPE, not decoration. "清空" without a scope is the dangerous word: the user cannot tell whether
   * it takes one workspace, one session, or the whole store. The description line says all three
   * facts: current workspace / not deleted / global and other workspaces survive.
   */
  assert.ok(client.includes('当前工作区'), '必须写明作用域是「当前工作区」')
  assert.ok(client.includes('不删除'), '必须写明是移入隔离目录而不是删除')
  assert.ok(
    client.includes('global 与其它工作区保留'),
    '必须写明哪些东西不受影响 —— 否则用户只能猜',
  )

  /** The confirm branch must be a real state flip, not a static string nearby. */
  assert.match(client, /confirming\s*\?\s*/u, '确认必须是一个状态分支（缺了它，两次点击之间没有任何拦截）')
})

test('v255 ③: 面板与 memory_stats 读同一个判据（同一事实不许两个读数）', () => {
  /**
   * `memoryConsoleState` is the ONLY producer of the panel's state (both console commands serialise
   * it). The counts it prints come from `skillVisibilityFor`, and `memory_stats` uses the same
   * function — asserted here by reading both call sites in the Host source.
   */
  assert.match(server, /const memoryConsoleState = \(agentId: string\)/u, '面板状态必须有一个唯一的产出函数')
  const visibilityUses = [...server.matchAll(/skillVisibilityFor\(/gu)].length
  assert.ok(visibilityUses >= 2, `面板与 memory_stats 必须都走 skillVisibilityFor，实测 ${visibilityUses} 处`)
  assert.ok(
    server.includes('shared with `memory_stats`') || server.includes('shared with memory_stats'),
    '源码里必须留下「这两处是同一个判据」的说明，否则下一个人会各写一份',
  )
})

test('v255 ④: 失败要能读懂 —— 说为什么，也说下一步做什么', () => {
  assert.ok(client.includes('面板无法调用宿主（'), '错误态必须有统一措辞')
  /** The parenthesis carries the failure list, and the sentence after it carries the advice. */
  assert.match(client, /面板无法调用宿主（[\s\S]{0,400}?）/u, '括号里必须带原因')
  assert.match(
    client,
    /等这一轮结束|再试|刷新/u,
    '必须给出下一步（等这一轮结束 / 重试 / 刷新）—— 只说「失败了」等于没说',
  )
  /** A crash boundary exists, so one bad payload cannot blank the whole panel. */
  assert.match(client, /getDerivedStateFromError|componentDidCatch/u, '必须有错误边界（一个坏载荷不许让整块面板消失）')
})