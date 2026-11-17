/**
 * ── v231：`author` 是图级参数，不是节点字段 ──────────────────────────────────────────────────────
 *
 * ── THE BUG THIS PINS (measured 2026-11-17) ─────────────────────────────────────────────────────
 *
 * The tool's forwarding table listed `['author', 'author']` among the v3 NODE fields, so `...forwarded`
 * spread it into `node` and the top-level `input.author` was ALWAYS `undefined`. `constrain` / `relax`
 * read the author from the top level — it answers "who is editing the graph", which is not a property of
 * any node — so they failed with `MISSING_AUTHOR` on every call shaped the way the schema described.
 *
 * ── WHY IT SURVIVED A GREEN SUITE, WHICH IS THE PART WORTH KEEPING ───────────────────────────────
 *
 * The shape that DID work (`node: { author }`) was the one that got exercised first, because
 * `updateGraph` accepts `input.node?.author` as well. So the feature worked through an undocumented
 * shape and failed through the documented one — and a test written against the working shape goes green
 * while the documented path is broken.
 *
 * ㉙ said "the tool schema is the third place, and it is the one that gets forgotten". This is the same
 * disease one level in: **the parameter can also be in the wrong LAYER.** So this file asserts BOTH
 * shapes against the TOOL, never against `updateGraph` directly — a test that bypasses the tool layer
 * cannot see a tool-layer defect.
 *
 * ── THE ASYMMETRY OF THE FIX ────────────────────────────────────────────────────────────────────
 *
 * The top level is canonical (the schema declares it there). `node.author` is still accepted, because
 * the first schema invited it and code already written against it must not silently stop working. The
 * canonical one wins when both are present.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(join(REPO, 'lib', 'index.js')).href)

const AUTHOR = {
  kind: 'model',
  sessionId: 'session-v231',
  generation: 12,
  attempt: 2,
  agentName: 'lead',
  role: 'executor',
  at: '2026-11-17T13:30:00.000Z',
}

/** A real plugin application: every call below goes through the TOOL, never through `updateGraph`. */
async function env() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v231-'))
  const tools = new Map()
  const ctx = {
    paths: { data: root },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    on: () => {},
    get: () => undefined,
  }
  mod.apply(ctx, {
    memoryDir: join(root, 'memory'),
    skillsDir: join(root, 'skills'),
    knowledgeDir: join(root, 'knowledge'),
  })
  const call = (name, args) => tools.get(name).execute(args)
  return { root, tools, call, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('v231 ①: schema 在顶层声明 author（图级参数），而不是只藏在 node 里', async () => {
  const { tools, done } = await env()
  try {
    const schema = tools.get('memory_graph_update').parameters
    assert.ok('author' in schema.properties, '顶层必须有 author —— 它是「谁在改图」，不是节点字段')
    assert.equal(schema.additionalProperties, false, '顶层仍是封闭 schema')
    /** `node.author` stays declared so existing callers keep working; the description marks it legacy. */
    assert.ok('author' in schema.properties.node.properties, 'node.author 作为兼容路径仍然接受')
  } finally {
    done()
  }
})

test('v231 ②: 走工具层，顶层 author ⇒ constrain 成功且 by 正确', async () => {
  const { call, done } = await env()
  try {
    const result = await call('memory_graph_update', {
      op: 'constrain',
      constraint: { id: 'pc-v231', text: '不允许在没有备份的情况下删除任何脚本' },
      author: AUTHOR,
      reason: 'v231 用顶层 author',
    })
    assert.equal(result.ok, true, `constrain 必须成功：${JSON.stringify(result).slice(0, 300)}`)

    const read = await call('memory_graph_read', {})
    const pc = read.graph.persistentConstraints.find((row) => row.id === 'pc-v231')
    assert.ok(pc !== undefined, '约束必须写进图顶层')
    assert.equal(pc.by.sessionId, AUTHOR.sessionId, 'by.sessionId 必须来自顶层 author')
    assert.equal(pc.by.attempt, AUTHOR.attempt, 'attempt 必须原样保留（它是区分重试的唯一依据）')
    assert.equal(pc.by.role, AUTHOR.role, 'role 必须原样保留')
  } finally {
    done()
  }
})

test('v231 ③: 走工具层，顶层 author ⇒ relax 也成功（两个 op 都读同一个位置）', async () => {
  const { call, done } = await env()
  try {
    await call('memory_graph_update', {
      op: 'constrain',
      constraint: { id: 'pc-v231-r', text: '阶段 3 前不 publish' },
      author: AUTHOR,
      reason: 'v231 先声明',
    })
    const relaxed = await call('memory_graph_update', {
      op: 'relax',
      constraintId: 'pc-v231-r',
      author: AUTHOR,
      reason: 'v231 解除',
    })
    assert.equal(relaxed.ok, true, `relax 必须成功：${JSON.stringify(relaxed).slice(0, 300)}`)

    const read = await call('memory_graph_read', {})
    const pc = read.graph.persistentConstraints.find((row) => row.id === 'pc-v231-r')
    assert.ok(pc !== undefined, 'relax 之后仍然读得到 —— 退休不是删除')
    assert.ok(typeof pc.retiredAt === 'string' && pc.retiredAt.length > 0, '必须有 retiredAt')
    assert.equal(pc.retiredWhy, 'v231 解除')
  } finally {
    done()
  }
})

test('v231 ④: node.author 作为兼容路径仍然有效（既有调用者不被静默破坏）', async () => {
  const { call, done } = await env()
  try {
    const result = await call('memory_graph_update', {
      op: 'constrain',
      constraint: { id: 'pc-v231-legacy', text: '兼容路径的约束' },
      node: { author: { ...AUTHOR, sessionId: 'session-legacy' } },
      reason: 'v231 兼容路径',
    })
    assert.equal(result.ok, true, `node.author 必须仍然可用：${JSON.stringify(result).slice(0, 300)}`)
    const read = await call('memory_graph_read', {})
    const pc = read.graph.persistentConstraints.find((row) => row.id === 'pc-v231-legacy')
    assert.equal(pc.by.sessionId, 'session-legacy', 'node.author 的值必须被采用')
  } finally {
    done()
  }
})

test('v231 ⑤: 两种形状都给时，顶层（规范位置）胜出', async () => {
  const { call, done } = await env()
  try {
    await call('memory_graph_update', {
      op: 'constrain',
      constraint: { id: 'pc-v231-both', text: '两种都给' },
      author: { ...AUTHOR, sessionId: 'session-canonical' },
      node: { author: { ...AUTHOR, sessionId: 'session-legacy-loses' } },
      reason: 'v231 优先级',
    })
    const read = await call('memory_graph_read', {})
    const pc = read.graph.persistentConstraints.find((row) => row.id === 'pc-v231-both')
    assert.equal(pc.by.sessionId, 'session-canonical', '规范位置必须胜出 —— 否则优先级取决于对象展开顺序')
  } finally {
    done()
  }
})

test('v231 ⑥: 两个位置都不给 author ⇒ MISSING_AUTHOR（缺归属必须报错，不许编一个）', async () => {
  const { call, done } = await env()
  try {
    const result = await call('memory_graph_update', {
      op: 'constrain',
      constraint: { id: 'pc-v231-none', text: '没有作者' },
      reason: 'v231 无 author',
    })
    assert.equal(result.ok, false, '没有 author 必须拒绝')
    assert.equal(result.code, 'MISSING_AUTHOR')
    const read = await call('memory_graph_read', {})
    assert.equal(
      read.graph.persistentConstraints.find((row) => row.id === 'pc-v231-none'),
      undefined,
      '被拒绝的写入不许留下数据',
    )
  } finally {
    done()
  }
})
