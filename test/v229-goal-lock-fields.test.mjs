/**
 * ── v229：目标锁锁的是「终点」，不是「旅程」 ──────────────────────────────────────────────────────
 *
 * ── WHAT WAS WRONG (measured 2026-11-17) ────────────────────────────────────────────────────────
 *
 * `updateGraph` refused EVERY `update` on a locked goal node:
 *
 *     const touchesGoal = targetId === GOAL_NODE_ID || …
 *     if (locked && touchesGoal && (op === 'update' || op === 'deprecate')) return fail('GOAL_LOCKED', …)
 *
 * while the comment directly above it said the opposite — "working on the goal is what the lock is
 * protecting, not reporting progress on it". So `progress` was refused, and the restore tool had to
 * unlock → write → re-lock just to seed five journey fields.
 *
 * ⑦ in this repository's own catalogue: an unverified comment assertion, contradicting the code under it.
 *
 * ── THE FIX, AND WHY THE DEFAULT IS "REFUSE" ───────────────────────────────────────────────────
 *
 * Destination fields (requirements / title / status / nodeType / dependsOn) stay refused: changing them
 * changes what "done" means. Journey fields (progress / standing / objective / …) are allowed: they say
 * where the work IS, which is the graph's whole purpose.
 *
 * A field in NEITHER list is REFUSED. The tempting default would be "allow — it is probably harmless",
 * and that makes every future field automatically exempt from the lock: add `requirementsRevision` next
 * year and the lock silently stops covering part of the destination. A lock whose default is "open" is
 * not a lock.
 *
 * ③ and ④ below are the two that matter most:
 *   ③ mixed progress + requirements ⇒ refused (no smuggling a destination edit in with a journey one)
 *   ④ unknown field                 ⇒ refused (no future field silently bypasses)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(join(REPO, 'lib', 'graph.js')).href)

const dirs = () => {
  const memory = mkdtempSync(join(tmpdir(), 'dsh-v229-'))
  /** A locked goal is the precondition for every case here, so it is built once, explicitly. */
  mod.updateGraph(memory, { op: 'lock-goal', goal: '把持久层做到生产就绪' })
  return { memory, done: () => rmSync(memory, { recursive: true, force: true }) }
}

test('v229 ①: 锁定的 goal，update { progress } ⇒ 放行（这就是「报告进度」）', () => {
  const { memory, done } = dirs()
  try {
    const result = mod.updateGraph(memory, {
      op: 'update',
      nodeId: mod.GOAL_NODE_ID,
      node: { progress: 42 },
      reason: '报告进度',
    })
    assert.equal(result.ok, true, `进度更新必须被放行，实测 ${result.code ?? '?'} ${result.reason ?? ''}`)
    const goal = mod.readGraph(memory).nodes.find((node) => node.id === mod.GOAL_NODE_ID)
    assert.equal(goal.progress, 42, '进度必须真的写进去')
  } finally {
    done()
  }
})

test('v229 ②: 锁定的 goal，update { requirements } ⇒ 仍然 GOAL_LOCKED（终点不许改）', () => {
  const { memory, done } = dirs()
  try {
    const result = mod.updateGraph(memory, {
      op: 'update',
      nodeId: mod.GOAL_NODE_ID,
      node: { requirements: ['把崩溃的测试删掉'] },
      reason: '偷偷改终点',
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'GOAL_LOCKED')
    assert.match(String(result.reason), /unlock-goal/u, '拒绝必须指出出路')
    /** The refusal must name WHICH fields were the problem, or the caller cannot fix the call. */
    assert.match(String(result.reason), /requirements/u, `拒绝必须点名 requirements，实测 ${result.reason}`)
  } finally {
    done()
  }
})

test('v229 ③: 锁定的 goal，update { progress, requirements } ⇒ GOAL_LOCKED（不许夹带）', () => {
  const { memory, done } = dirs()
  try {
    const result = mod.updateGraph(memory, {
      op: 'update',
      nodeId: mod.GOAL_NODE_ID,
      node: { progress: 42, requirements: ['新的完成标准'] },
      reason: '把改终点夹在报进度里',
    })
    assert.equal(result.ok, false, '夹带必须被拒 —— 否则「放行 progress」就成了绕开锁的侧门')
    assert.equal(result.code, 'GOAL_LOCKED')
    assert.match(String(result.reason), /requirements/u, '拒绝要点名夹带的那个字段')
    /** And nothing was written: a partial application would be worse than a refusal. */
    const goal = mod.readGraph(memory).nodes.find((node) => node.id === mod.GOAL_NODE_ID)
    assert.notEqual(goal.progress, 42, '被拒绝的批次里，放行的字段也不许落地（要么全成，要么全不成）')
  } finally {
    done()
  }
})

test('v229 ④: 锁定的 goal，update { 未知字段 } ⇒ GOAL_LOCKED（默认拒，不许新字段绕过）', () => {
  const { memory, done } = dirs()
  try {
    const result = mod.updateGraph(memory, {
      op: 'update',
      nodeId: mod.GOAL_NODE_ID,
      node: { requirementsRevision: 7 },
      reason: '未来某天新增的字段',
    })
    assert.equal(result.ok, false, '未知字段必须被拒 —— 否则每个新字段都自动绕过锁')
    assert.equal(result.code, 'GOAL_LOCKED')
    assert.match(String(result.reason), /requirementsRevision|白名单/u, `拒绝必须说明它不在白名单，实测 ${result.reason}`)
  } finally {
    done()
  }
})

test('v229 ⑤: deprecate 锁定的 goal 仍然被拒，且理由与 update 不同', () => {
  const { memory, done } = dirs()
  try {
    const result = mod.updateGraph(memory, { op: 'deprecate', nodeId: mod.GOAL_NODE_ID, reason: '放弃目标' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'GOAL_LOCKED')
    assert.match(String(result.reason), /deprecate/u, '废弃有它自己的理由，不该复用 update 的措辞')
  } finally {
    done()
  }
})

test('v229 ⑥: 解锁后 requirements 可以改（锁是唯一的门槛，不是永久禁止）', () => {
  const { memory, done } = dirs()
  try {
    mod.updateGraph(memory, { op: 'unlock-goal', reason: '项目方向变了' })
    const result = mod.updateGraph(memory, {
      op: 'update',
      nodeId: mod.GOAL_NODE_ID,
      node: { requirements: ['新的完成标准'] },
      reason: '方向变了',
    })
    assert.equal(result.ok, true, '解锁之后必须能改，否则锁就不是锁而是禁止修改')
  } finally {
    done()
  }
})
