/**
 * ── v322 / G-9 (P1, MEMORY-04): 「做完了」不是「验收过了」──────────────────────────────────────────
 *
 * 路径：**存储层 helper**（`graph.updateGraph`）—— 这是「规则检查」，不是活路径验收。
 *
 * ── 本文件的边界（lead §24.4 的处置，与 v102 同一种）────────────────────────────────────────────
 *
 * 四条判据**全部**经 `graph.updateGraph(...)` 直接调存储层，**没有一条经过 `memory_graph_update`
 * 工具**。它们证明的是**存储层的规则是对的**——那条规则确实是对的——但它们证明不了模型实际走的那条路。
 *
 * 实测：`graph-tool.ts` 的 `V3_FORWARD` 曾经少两行，字段在到达门禁之前就被丢掉，真实工具上
 * 「无证据 accept」返回 `ok:true`，而本文件四条全绿。**活路径由 `v323` 覆盖。**
 *
 * 这个提示不是免责声明，是定位：读到这里的人必须知道**绿≠活路径通过**。降级并写明边界，
 * 不是删除——这正是 `v102` 用过的处置（§二十）。
 *
 * ── 缺陷（lead 实测）──────────────────────────────────────────────────────────────────────────
 *
 * `src/` 里 `acceptance` / `accepted` **零命中**，`complete` 直接写 `status:'done'` —— 模型自报
 * 「做完了」，对每个读者就是「完成了」，没有证据、没有验收这一步。
 *
 * 采纳 v2.4 §5.5 的三轴，但**只做最小切片**（停止条件：不改 `TaskGraph.version`）：
 *
 *   status           'done'      「不再是一段进行中的工作」  —— 不改，所有既有读者不受影响
 *   executionStatus  'produced'  工作产出了                  —— 新，可选
 *   acceptanceStatus 'pending'   还没人验收                  —— 新，可选；`complete` **永不自称 accepted**
 *
 * 判据（四条，含两条负向）：
 *   ① `complete` 之后节点**不得**是 `accepted`（必须是 pending）
 *   ② 带证据的 `accept` 才允许进 `accepted`
 *   ③ **负向**：无证据的 `accept` 必须被拒
 *   ④ **负向**：`status` 的语义没被改坏 —— 既有读者仍看到 `'done'`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..', '..')

const emptyGraphRecord = (at = '2026-11-20T00:00:00.000Z') => ({
  version: 1,
  id: 'default',
  goal: '',
  goalLockedAt: '',
  nodes: [
    {
      id: 'start',
      title: 'start',
      nodeType: '',
      requirements: [],
      status: 'done',
      dependsOn: [],
      knowledgePointers: [],
      fixed: true,
      harvestedAt: '',
      createdAt: at,
      updatedAt: at,
    },
  ],
  history: [],
  createdAt: at,
  updatedAt: at,
  persistentConstraints: [],
})

async function env() {
  const graph = await import(pathToFileURL(join(ROOT, 'dsh-memory', 'lib', 'graph.js')).href)
  const root = mkdtempSync(join(tmpdir(), 'dsh-v322-'))
  const memoryDir = join(root, '.dsh-memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(memoryDir, 'task-graph.json'), JSON.stringify(emptyGraphRecord(), null, 2), 'utf8')
  return { graph, root, memoryDir }
}

const readNode = (memoryDir, id) => {
  const parsed = JSON.parse(readFileSync(join(memoryDir, 'task-graph.json'), 'utf8'))
  return (parsed.nodes ?? []).find((entry) => entry.id === id)
}

test('v322 ①: `complete` must NOT produce an ACCEPTED node — only 「produced, pending acceptance」', async () => {
  const { graph, root, memoryDir } = await env()
  try {
    assert.equal(graph.updateGraph(memoryDir, { op: 'add', nodeId: 'phase-a', node: { title: 'A' } }).ok, true)
    assert.equal(graph.updateGraph(memoryDir, { op: 'activate', nodeId: 'phase-a' }).ok, true)
    const completed = graph.updateGraph(memoryDir, { op: 'complete', nodeId: 'phase-a' })
    assert.equal(completed.ok, true, `前提：complete 必须成功；实测 ${JSON.stringify(completed).slice(0, 200)}`)

    const node = readNode(memoryDir, 'phase-a')
    assert.equal(node.status, 'done', '④ status 的语义不变（既有读者仍看到 done）')
    assert.equal(node.executionStatus, 'produced', '① 产出了')
    assert.equal(node.acceptanceStatus, 'pending',
      `① complete 绝不自称「验收过」；实测 acceptanceStatus=${String(node.acceptanceStatus)}`)
    assert.notEqual(node.acceptanceStatus, 'accepted', '① 这是本条的核心：完成 ≠ 验收')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v322 ②: an acceptance WITH evidence moves the node to accepted', async () => {
  const { graph, root, memoryDir } = await env()
  try {
    graph.updateGraph(memoryDir, { op: 'add', nodeId: 'phase-a', node: { title: 'A' } })
    graph.updateGraph(memoryDir, { op: 'activate', nodeId: 'phase-a' })
    graph.updateGraph(memoryDir, { op: 'complete', nodeId: 'phase-a' })

    /**
     * The acceptance is an `update` that carries both the verdict AND the evidence it rests on
     * (existing facts only — a commit hash, a test result, `harvestedAt`; no new external system).
     */
    const accepted = graph.updateGraph(memoryDir, {
      op: 'update',
      nodeId: 'phase-a',
      node: { acceptanceStatus: 'accepted', evidence: ['commit:deadbeef', 'tests:1092 pass'] },
      reason: '验收：证据是提交与测试结果',
    })
    assert.equal(accepted.ok, true, `② 带证据的 accept 必须成功；实测 ${JSON.stringify(accepted).slice(0, 300)}`)
    const node = readNode(memoryDir, 'phase-a')
    assert.equal(node.acceptanceStatus, 'accepted')
    assert.deepEqual(node.evidence, ['commit:deadbeef', 'tests:1092 pass'], '证据必须落盘，不是只写结论')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v322 ③ (negative half): an acceptance WITHOUT evidence is REFUSED', async () => {
  /**
   * Without this, ① is satisfied by never accepting anything, and ② by accepting everything. A verdict
   * with nothing behind it is exactly what the batch is removing.
   */
  const { graph, root, memoryDir } = await env()
  try {
    graph.updateGraph(memoryDir, { op: 'add', nodeId: 'phase-a', node: { title: 'A' } })
    graph.updateGraph(memoryDir, { op: 'activate', nodeId: 'phase-a' })
    graph.updateGraph(memoryDir, { op: 'complete', nodeId: 'phase-a' })

    const bare = graph.updateGraph(memoryDir, {
      op: 'update',
      nodeId: 'phase-a',
      node: { acceptanceStatus: 'accepted' },
      reason: '我要验收（但没有证据）',
    })
    assert.equal(bare.ok, false,
      `③ 无证据的 accept 必须被拒；实测 ${JSON.stringify(bare).slice(0, 300)}`)
    assert.equal(bare.code, 'MISSING_EVIDENCE')

    const node = readNode(memoryDir, 'phase-a')
    assert.equal(node.acceptanceStatus, 'pending', '被拒之后状态不得改变')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v322 ④ (negative half): the OLD reading still works — a plain `update` without the new fields is unaffected', async () => {
  /**
   * The minimal slice must not change what an existing caller sees. A node that never mentions
   * `acceptanceStatus` keeps `status: 'done'` after `complete` and nothing else changes.
   */
  const { graph, root, memoryDir } = await env()
  try {
    graph.updateGraph(memoryDir, { op: 'add', nodeId: 'phase-b', node: { title: 'B' } })
    graph.updateGraph(memoryDir, { op: 'activate', nodeId: 'phase-b' })
    graph.updateGraph(memoryDir, { op: 'complete', nodeId: 'phase-b' })
    const updated = graph.updateGraph(memoryDir, {
      op: 'update',
      nodeId: 'phase-b',
      node: { progress: 100 },
      reason: '只是报进度',
    })
    assert.equal(updated.ok, true, '普通 update 不受影响')
    const node = readNode(memoryDir, 'phase-b')
    assert.equal(node.progress, 100)
    assert.equal(node.acceptanceStatus, 'pending', '没提验收就不会被改成 accepted')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})