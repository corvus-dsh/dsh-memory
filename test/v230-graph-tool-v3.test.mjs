/**
 * ── v230：工具层打通 v3 字段 + constrain/relax + 短期约束自动退化 ────────────────────────────────
 *
 * ── THE GAP THIS CLOSES (㉙, measured 2026-11-17) ────────────────────────────────────────────────
 *
 * `GraphNode` has carried thirteen v3 fields since B2-T1, and `graph.ts` validates and stores every one
 * of them. But the `memory_graph_update` tool schema forwarded only the seven v1 fields, so a session
 * could READ a graph's `logPointers` and never WRITE one — the capability stopped at the tool boundary
 * while the storage layer claimed it worked.
 *
 * That is the failure mode ㉙ names: when a persistent field is added there are THREE places to touch —
 * (a) the type, (b) the store's read/write, (c) the tool schema. The third is the one that gets
 * forgotten, because it lives in a different file and nothing fails until someone tries to write.
 *
 * ── WHAT IS ASSERTED HERE ───────────────────────────────────────────────────────────────────────
 *
 *   ⑪ the schema declares the v3 fields individually (not `additionalProperties: true`)
 *   ⑫ a node written THROUGH THE TOOL with logPointers reads back with them
 *   ⑬ a malformed logPointers is refused with INVALID_FIELD naming the field (never silently dropped)
 *   ⑭ `constrain` adds a top-level constraint with an author; `relax` RETIRES it (it is still readable)
 *   ⑮ `complete` on a node retires its node-scoped ephemeralConstraints, and is idempotent
 *   ⑯ `scope: 'session'` constraints are NOT retired by a node finishing
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
  sessionId: 'session-v230',
  generation: 12,
  attempt: 1,
  at: '2026-11-17T12:00:00.000Z',
}

/** A real plugin application, so the assertions run against the tool surface a session actually sees. */
async function env() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v230-'))
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

test('v230 ⑪: 工具 schema 逐个声明 v3 字段（不是 additionalProperties: true）', async () => {
  const { tools, done } = await env()
  try {
    const schema = tools.get('memory_graph_update').parameters
    const node = schema.properties.node
    /**
     * `additionalProperties: false` combined with individual declarations is the point: an open schema
     * would accept a typo'd field name and drop it, which is the same silent loss ㉙ is about.
     */
    assert.equal(node.additionalProperties, false, 'node 必须还是封闭的 —— 开放会失去校验')
    for (const field of [
      'origin', 'last_change', 'objective', 'subgoals', 'alternatives', 'pruned',
      'estimate', 'actual', 'progress', 'standing', 'evidence', 'log_pointers', 'ephemeral_constraints',
    ]) {
      assert.ok(field in node.properties, `schema 必须声明 ${field}`)
    }
    assert.ok('constraint' in schema.properties, 'schema 必须声明 constraint')
    assert.ok('constraintId' in schema.properties, 'schema 必须声明 constraintId')
    const ops = schema.properties.op.enum
    for (const op of ['constrain', 'relax']) assert.ok(ops.includes(op), `op 枚举必须含 ${op}`)
  } finally {
    done()
  }
})

test('v230 ⑫: 通过工具写 logPointers ⇒ 读回可见（图能读也能写）', async () => {
  const { call, done } = await env()
  try {
    await call('memory_graph_update', { op: 'add', nodeId: 'nd-one', node: { node_type: 'coding' } })
    const written = await call('memory_graph_update', {
      op: 'update',
      nodeId: 'nd-one',
      node: {
        log_pointers: [
          { topic: '六轮 CI 失败的根因', generation: 5, sessionId: 'auto-graft-x', seq: 4508, what: '第一轮的 YAML' },
          { topic: 'compaction 推算', generation: 5, sessionId: 'auto-graft-x', search: '727,040', what: '算式' },
        ],
        progress: 42,
        standing: '正在补 v3',
        author: AUTHOR,
      },
      reason: 'v230 写 v3',
    })
    assert.equal(written.ok, true, `写入必须成功：${JSON.stringify(written).slice(0, 300)}`)

    const read = await call('memory_graph_read', {})
    const node = read.nodes.find((row) => row.id === 'nd-one')
    assert.equal(node.logPointers.length, 2, `读回必须有 2 条 pointer，实测 ${node.logPointers?.length}`)
    assert.equal(node.logPointers[0].seq, 4508, 'seq 必须保留')
    assert.equal(node.logPointers[1].search, '727,040', 'search 必须保留')
    assert.equal(node.progress, 42)
    assert.equal(node.standing, '正在补 v3')
  } finally {
    done()
  }
})

test('v230 ⑬: 形状错误的 logPointers ⇒ INVALID_FIELD 并点名（不许静默丢）', async () => {
  const { call, done } = await env()
  try {
    await call('memory_graph_update', { op: 'add', nodeId: 'nd-two', node: { node_type: 'coding' } })
    const result = await call('memory_graph_update', {
      op: 'update',
      nodeId: 'nd-two',
      node: {
        // Neither seq nor search: the pointer names nothing, so it must be refused rather than dropped.
        log_pointers: [{ topic: '没有地址的指针', generation: 5, sessionId: 's', what: '无法定位' }],
      },
      reason: 'v230 坏形状',
    })
    assert.equal(result.ok, false, '形状不对的 logPointers 必须让整次写入失败')
    assert.equal(result.code, 'INVALID_FIELD')
    assert.match(String(result.reason), /logPointers/u, `拒绝必须点名 logPointers，实测 ${result.reason}`)
    const read = await call('memory_graph_read', {})
    assert.equal(read.nodes.find((row) => row.id === 'nd-two').logPointers, undefined, '被拒的写入不许留下半份数据')
  } finally {
    done()
  }
})

test('v230 ⑭: constrain 加一条带 author 的约束；relax 退休而不删除', async () => {
  const { call, done } = await env()
  try {
    const added = await call('memory_graph_update', {
      op: 'constrain',
      constraint: { id: 'pc-t1', text: '不 force push、不 publish', note: '阶段 3 前有效' },
      author: AUTHOR,
      reason: 'v230 声明约束',
    })
    assert.equal(added.ok, true, `constrain 必须成功：${JSON.stringify(added).slice(0, 300)}`)

    const afterAdd = await call('memory_graph_read', {})
    const declared = afterAdd.graph.persistentConstraints.find((row) => row.id === 'pc-t1')
    assert.ok(declared !== undefined, '约束必须真的写进图顶层')
    assert.equal(declared.text, '不 force push、不 publish')
    assert.equal(declared.by.sessionId, AUTHOR.sessionId, 'by 必须来自调用者的 author')
    assert.equal(declared.retiredAt, undefined, '刚声明的约束还没退休')

    /** Declaring the same id twice is refused: "new rule" and "change a rule" must not be one call. */
    const duplicate = await call('memory_graph_update', {
      op: 'constrain',
      constraint: { id: 'pc-t1', text: '改一个说法' },
      author: AUTHOR,
      reason: 'v230 重复 id',
    })
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.code, 'CONSTRAINT_EXISTS')

    const relaxed = await call('memory_graph_update', {
      op: 'relax',
      constraintId: 'pc-t1',
      author: AUTHOR,
      reason: '阶段 3 发版时解除',
    })
    assert.equal(relaxed.ok, true, `relax 必须成功：${JSON.stringify(relaxed).slice(0, 300)}`)

    const afterRelax = await call('memory_graph_read', {})
    const retired = afterRelax.graph.persistentConstraints.find((row) => row.id === 'pc-t1')
    assert.ok(retired !== undefined, 'relax 之后它必须仍然读得到 —— 退休不是删除')
    assert.ok(typeof retired.retiredAt === 'string' && retired.retiredAt.length > 0, '必须有 retiredAt')
    assert.equal(retired.retiredWhy, '阶段 3 发版时解除', 'retiredWhy 必须记录理由')
  } finally {
    done()
  }
})

test('v230 ⑮: complete 让节点的短期约束退休（且幂等）', async () => {
  const { call, done } = await env()
  try {
    await call('memory_graph_update', {
      op: 'add',
      nodeId: 'nd-three',
      node: {
        node_type: 'coding',
        ephemeral_constraints: [
          { id: 'ec-1', text: '节点期间不许动配置', by: AUTHOR, scope: 'node' },
          { id: 'ec-2', text: '节点期间只跑单测', by: AUTHOR, scope: 'node' },
        ],
      },
    })
    const before = await call('memory_graph_read', {})
    const pre = before.nodes.find((row) => row.id === 'nd-three').ephemeralConstraints
    assert.equal(pre.length, 2)
    assert.ok(pre.every((row) => row.retiredAt === undefined), '前置：complete 之前都没退休')

    await call('memory_graph_update', { op: 'complete', nodeId: 'nd-three', reason: 'v230 完成' })
    const mid = await call('memory_graph_read', {})
    const retired = mid.nodes.find((row) => row.id === 'nd-three').ephemeralConstraints
    assert.ok(retired.every((row) => typeof row.retiredAt === 'string' && row.retiredAt.length > 0), '两条都必须退休')
    assert.ok(retired.every((row) => String(row.retiredWhy).includes('节点完成')), 'retiredWhy 必须写明原因')

    /**
     * Idempotent: a second `complete` must NOT rewrite the original retirement time. A moving timestamp
     * would be a false history — it would say the constraint retired when it was merely re-stamped.
     */
    const firstStamp = retired[0].retiredAt
    await call('memory_graph_update', { op: 'complete', nodeId: 'nd-three', reason: 'v230 再完成一次' })
    const again = await call('memory_graph_read', {})
    const same = again.nodes.find((row) => row.id === 'nd-three').ephemeralConstraints
    assert.equal(same[0].retiredAt, firstStamp, '重复 complete 不许改写退休时间')
  } finally {
    done()
  }
})

test('v230 ⑯: scope: "session" 的短期约束不因节点完成而退休', async () => {
  const { call, done } = await env()
  try {
    await call('memory_graph_update', {
      op: 'add',
      nodeId: 'nd-four',
      node: {
        node_type: 'coding',
        ephemeral_constraints: [
          { id: 'ec-node', text: '随节点', by: AUTHOR, scope: 'node' },
          { id: 'ec-session', text: '随会话', by: AUTHOR, scope: 'session' },
        ],
      },
    })
    await call('memory_graph_update', { op: 'complete', nodeId: 'nd-four', reason: 'v230 完成' })
    const read = await call('memory_graph_read', {})
    const list = read.nodes.find((row) => row.id === 'nd-four').ephemeralConstraints
    const byId = new Map(list.map((row) => [row.id, row]))
    assert.ok(typeof byId.get('ec-node').retiredAt === 'string', 'scope:node 必须随节点退休')
    assert.equal(
      byId.get('ec-session').retiredAt,
      undefined,
      'scope:session 属于会话，不属于节点 —— 节点完成对它什么也没说',
    )
  } finally {
    done()
  }
})
