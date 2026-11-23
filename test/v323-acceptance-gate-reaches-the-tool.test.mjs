/**
 * ── v323 / G-9b (P0): 验收门禁必须**走真实工具**到达 ───────────────────────────────────────────────
 *
 * 路径：**公开工具**（`memory_graph_update`）—— 这是模型实际调用的那一条。
 *
 * ── 缺陷（lead 实测，§24.4）────────────────────────────────────────────────────────────────────
 *
 * `graph-goal-lock.ts` 的 `acceptanceNeedsEvidence` 逻辑正确，`graph.ts:687` 也确实调用了它。
 * 但 patch 是**在 `graph-tool.ts` 里逐字段装配的**，`V3_FORWARD` 只有 13 项，缺
 * `acceptance_status` / `execution_status` —— 字段在到达门禁之前就消失了：
 *
 *     node:{ acceptanceStatus:'accepted' }                 → ok:true，节点仍 pending
 *     node:{ acceptanceStatus:'accepted', evidence:[...] } → ok:true，节点仍 pending
 *
 * 两条都成功、都没变。**存储层规则是对的，字段没送到。**
 *
 * ── 为什么 `v322` 全绿 ──────────────────────────────────────────────────────────────────────────
 *
 * 它四条**全部**经 `graph.updateGraph()` 直接调存储层，没有一条走工具。那是「规则检查」，不是活路径
 * （§〇 30）。本文件补的正是那条路径；`v322` 保留并已降级为存储层规则判据。
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

/** A REAL plugin registration: we drive the registered TOOL, not the storage function. */
async function env() {
  const memory = await import(pathToFileURL(join(ROOT, 'dsh-memory', 'lib', 'index.js')).href)
  const root = mkdtempSync(join(tmpdir(), 'dsh-v323-'))
  const memoryDir = join(root, '.dsh-memory')
  const knowledgeDir = join(root, '.dsh-knowledge')
  mkdirSync(memoryDir, { recursive: true })
  mkdirSync(knowledgeDir, { recursive: true })
  writeFileSync(join(memoryDir, '.layout.json'), JSON.stringify({ layout: 1, producer: 'dsh-memory' }, null, 2), 'utf8')
  writeFileSync(join(memoryDir, 'task-graph.json'), JSON.stringify(emptyGraphRecord(), null, 2), 'utf8')

  const tools = new Map()
  const ctx = {
    get(name) {
      if (name === 'paths') return { data: root }
      if (name === 'configEditor') return { entries: () => [], edit: async () => undefined }
      if (name === 'sessions') return { get: () => undefined, list: () => [] }
      return undefined
    },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    tools: { register: (definition) => tools.set(definition.name, definition) },
  }
  memory.apply(ctx, { memoryDir, knowledgeDir, skillsDir: join(root, '.agents', 'skills') })
  return { memory, memoryDir, root, tools }
}

const readNode = (memoryDir, id) => {
  const parsed = JSON.parse(readFileSync(join(memoryDir, 'task-graph.json'), 'utf8'))
  return (parsed.nodes ?? []).find((entry) => entry.id === id)
}

/** Seed a phase node through the TOOL and complete it, so the fixture is the production path too. */
async function completedPhase(update, nodeId = 'phase-a') {
  const added = await update.execute({ op: 'add', nodeId, node: { title: nodeId } })
  assert.equal(added.ok, true, `前提：add 必须成功；实测 ${JSON.stringify(added).slice(0, 200)}`)
  await update.execute({ op: 'activate', nodeId })
  const done = await update.execute({ op: 'complete', nodeId })
  assert.equal(done.ok, true, `前提：complete 必须成功；实测 ${JSON.stringify(done).slice(0, 200)}`)
}

test('v323 ① (P0, REAL TOOL): 无证据的 accept 必须被 MISSING_EVIDENCE 拒 —— 不再 ok:true', async () => {
  const e = await env()
  try {
    const update = e.tools.get('memory_graph_update')
    assert.ok(update !== undefined, '前提：memory_graph_update 必须已注册')
    await completedPhase(update)

    const bare = await update.execute({
      op: 'update',
      nodeId: 'phase-a',
      node: { acceptanceStatus: 'accepted' },
      reason: '我要验收（但没有证据）',
    })
    assert.equal(bare.ok, false,
      `① 无证据 accept 必须失败；实测 ${JSON.stringify(bare).slice(0, 300)}`)
    assert.equal(bare.code, 'MISSING_EVIDENCE',
      `① 拒绝码必须是 MISSING_EVIDENCE（说明字段真的到达了门禁）；实测 ${String(bare.code)}`)
    assert.equal(readNode(e.memoryDir, 'phase-a').acceptanceStatus, 'pending', '被拒后状态不变')
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})

test('v323 ② (REAL TOOL, positive half): 带证据的 accept 必须成功并落盘 accepted', async () => {
  const e = await env()
  try {
    const update = e.tools.get('memory_graph_update')
    await completedPhase(update)

    const accepted = await update.execute({
      op: 'update',
      nodeId: 'phase-a',
      node: { acceptanceStatus: 'accepted', evidence: ['commit:deadbeef', 'tests:806 pass'] },
      reason: '验收：证据是提交与测试结果',
    })
    assert.equal(accepted.ok, true, `② 带证据的 accept 必须成功；实测 ${JSON.stringify(accepted).slice(0, 300)}`)
    const node = readNode(e.memoryDir, 'phase-a')
    assert.equal(node.acceptanceStatus, 'accepted', '② 必须真的落盘成 accepted（不是只返回 ok）')
    assert.deepEqual(node.evidence, ['commit:deadbeef', 'tests:806 pass'], '证据必须落盘')
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})

test('v323 ③ (negative half, REAL TOOL): 普通 update 不带这两个字段 ⇒ 行为与今天完全一致', async () => {
  /**
   * Without this half, ①② are satisfied by a tool that refuses or rewrites unrelated edits.
   */
  const e = await env()
  try {
    const update = e.tools.get('memory_graph_update')
    await completedPhase(update)

    const plain = await update.execute({ op: 'update', nodeId: 'phase-a', node: { progress: 100 }, reason: '只报进度' })
    assert.equal(plain.ok, true, '③ 普通 update 不受影响')
    const node = readNode(e.memoryDir, 'phase-a')
    assert.equal(node.progress, 100)
    assert.equal(node.acceptanceStatus, 'pending', '没提验收就不会被自动改成 accepted')
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})

test('v323 ④: the tool schema DECLARES both fields — otherwise the host rejects them before the handler', async () => {
  /**
   * `additionalProperties: false` makes an undeclared property a schema-level rejection, so a
   * `V3_FORWARD` row alone would still leave the field unreachable. This asserts the declaration, which is
   * the half a storage-layer test can never see.
   */
  const e = await env()
  try {
    const update = e.tools.get('memory_graph_update')
    const nodeSchema = update.parameters?.properties?.node?.properties ?? {}
    for (const field of ['execution_status', 'acceptance_status']) {
      assert.ok(nodeSchema[field] !== undefined,
        `④ schema 必须声明 ${field}（additionalProperties:false 会在 handler 之前拒掉未声明的字段）`)
    }
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})