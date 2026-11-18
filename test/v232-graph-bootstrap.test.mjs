/**
 * ── v232：`bootstrap` —— 要么整张图建成，要么什么都不变 ──────────────────────────────────────────
 *
 * ── WHY A NEW OP AND NOT EIGHTEEN `add`s (measured against the current `add`) ────────────────────
 *
 * `add` refuses a `dependsOn` that does not exist yet:
 *
 *     const dangling = node.dependsOn.filter((parent) => !graph.nodes.some((other) => other.id === parent))
 *     if (dangling.length > 0) return fail('DANGLING_DEPENDENCY', …)
 *
 * So building a graph node-by-node has two hard problems, and the SECOND is the reason this op exists:
 *
 *   ① the calls must be in strict topological order (18 calls, in the right order);
 *   ② there is no atomicity — a failure at node 10 leaves 9 nodes on disk. And a half-built graph has
 *      `goal` set or more than one node, so `isBlankGraph` is already false: it LOOKS finished while
 *      half the plan is missing.
 *
 * `bootstrap` buys exactly one property: the whole graph lands, or the store is untouched.
 *
 * ── THE "BLANK" DEFINITION, AND WHY `history` IS NOT IN IT ──────────────────────────────────────
 *
 * `isBlankGraph` also requires `history.length === 0`. Using that as the gate would make a single failed
 * bootstrap PERMANENTLY unretryable: the attempt leaves an audit entry, and the gate would then say "not
 * blank" forever. So the gate is `nodes.length <= 1 && goal === ''` — history is an AUDIT, not evidence
 * about whether a plan exists — and leftover history produces a WARNING rather than a refusal.
 *
 * ── EVERY TEST BELOW GOES THROUGH THE TOOL ─────────────────────────────────────────────────────
 *
 * ㉙'s second form: a parameter in the wrong LAYER (or a validation that only `updateGraph` performs)
 * is invisible to a test that calls `updateGraph` directly. `author` is graph-level — v231 pinned that
 * for `constrain`; ⑩ and ⑪ pin it again for `bootstrap`.
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
  sessionId: 'session-v232',
  generation: 12,
  attempt: 1,
  agentName: 'lead',
  role: 'planner',
  at: '2026-11-17T14:00:00.000Z',
}

async function env() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v232-'))
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
  /** How many nodes the store ACTUALLY holds — the only honest measure of "did anything land". */
  const nodeCount = async () => (await call('memory_graph_read', {})).nodes.length
  return { root, tools, call, nodeCount, done: () => rmSync(root, { recursive: true, force: true }) }
}

/** A realistic three-node plan; `dependsOn` uses ids that only exist inside this batch. */
const PLAN3 = [
  { id: 'phase-a', title: '阶段 A', node_type: 'analysis', depends_on: ['goal'] },
  { id: 'phase-b', title: '阶段 B', node_type: 'coding', depends_on: ['phase-a'] },
  { id: 'phase-c', title: '阶段 C', node_type: 'testing', depends_on: ['phase-b'] },
]

test('v232 ①: 正常 bootstrap ⇒ 全部建成，goal 已设且已锁', async () => {
  const { call, done } = await env()
  try {
    const result = await call('memory_graph_update', {
      op: 'bootstrap',
      goal: '把持久层做到生产就绪',
      nodes: PLAN3,
      author: AUTHOR,
      reason: 'v232 建图',
    })
    assert.equal(result.ok, true, `bootstrap 必须成功：${JSON.stringify(result).slice(0, 400)}`)

    const read = await call('memory_graph_read', {})
    /** start + goal + the three planned nodes. */
    assert.equal(read.nodes.length, 5, `应为 start+goal+3 = 5，实测 ${read.nodes.length}`)
    assert.equal(read.graph.goal, '把持久层做到生产就绪')
    assert.ok(read.graph.goalLockedAt.length > 0, 'bootstrap 必须顺带锁目标 —— 不锁的话建完就能被改掉')
    assert.equal(read.goalLocked, true)
    for (const id of ['phase-a', 'phase-b', 'phase-c']) {
      assert.ok(read.nodes.some((node) => node.id === id), `${id} 必须存在`)
    }
  } finally {
    done()
  }
})

test('v232 ②: 依赖关系全部可解析（没有悬空边）', async () => {
  const { call, done } = await env()
  try {
    await call('memory_graph_update', {
      op: 'bootstrap',
      goal: '依赖测试',
      nodes: PLAN3,
      author: AUTHOR,
      reason: 'v232 依赖',
    })
    const read = await call('memory_graph_read', {})
    const ids = new Set(read.nodes.map((node) => node.id))
    for (const node of read.nodes) {
      for (const parent of node.dependsOn) {
        assert.ok(ids.has(parent), `${node.id} 的依赖 ${parent} 不存在`)
      }
    }
    assert.deepEqual(read.nodes.find((n) => n.id === 'phase-b').dependsOn, ['phase-a'])
  } finally {
    done()
  }
})

test('v232 ③: 原子性 —— 第 10 个节点非法 ⇒ 失败，且图仍为空', async () => {
  const { call, nodeCount, done } = await env()
  try {
    /**
     * Nine valid nodes and a tenth whose `depends_on` names something that does not exist. Everything
     * BEFORE it is legal, so a loop-and-write implementation would leave nine nodes on disk.
     */
    const nodes = Array.from({ length: 9 }, (_, index) => ({
      id: `nd-${index}`,
      title: `节点 ${index}`,
      node_type: 'coding',
      depends_on: index === 0 ? ['goal'] : [`nd-${index - 1}`],
    }))
    nodes.push({ id: 'nd-bad', title: '第十个', node_type: 'coding', depends_on: ['never-exists'] })

    const before = await nodeCount()
    const result = await call('memory_graph_update', {
      op: 'bootstrap',
      goal: '原子性测试',
      nodes,
      author: AUTHOR,
      reason: 'v232 原子性',
    })
    assert.equal(result.ok, false, '悬空依赖必须让整次 bootstrap 失败')
    assert.equal(result.code, 'DANGLING_DEPENDENCY')

    const after = await nodeCount()
    assert.equal(after, before, `失败后节点数必须不变（${before} → ${after}）—— 变了就是半成品`)
    assert.equal(after, 1, '空图只有 start 一个节点')
    const read = await call('memory_graph_read', {})
    assert.equal(read.graph.goal, '', '失败后 goal 也不许被写上')
  } finally {
    done()
  }
})

test('v232 ④: 环检测 —— a→b→a ⇒ CYCLE，图仍为空', async () => {
  const { call, nodeCount, done } = await env()
  try {
    const cyclic = [
      { id: 'cyc-a', title: 'A', depends_on: ['cyc-b'] },
      { id: 'cyc-b', title: 'B', depends_on: ['cyc-a'] },
      { id: 'cyc-c', title: 'C', depends_on: ['cyc-a'] },
    ]
    const before = await nodeCount()
    const result = await call('memory_graph_update', {
      op: 'bootstrap',
      goal: '成环测试',
      nodes: cyclic,
      author: AUTHOR,
      reason: 'v232 成环',
    })
    assert.equal(result.ok, false, '成环必须被拒')
    assert.equal(result.code, 'CYCLE')
    assert.equal(await nodeCount(), before, '被拒之后图必须一个节点都没多')
  } finally {
    done()
  }
})

test('v232 ⑤: 已有图再 bootstrap ⇒ GRAPH_NOT_EMPTY（不是静默覆盖）', async () => {
  const { call, done } = await env()
  try {
    await call('memory_graph_update', { op: 'bootstrap', goal: '第一张图', nodes: PLAN3, author: AUTHOR, reason: '第一次' })
    const second = await call('memory_graph_update', {
      op: 'bootstrap',
      goal: '第二张图',
      nodes: PLAN3,
      author: AUTHOR,
      reason: '第二次',
    })
    assert.equal(second.ok, false, '已建好的图不许被 bootstrap 覆盖')
    assert.equal(second.code, 'GRAPH_NOT_EMPTY')
    const read = await call('memory_graph_read', {})
    assert.equal(read.graph.goal, '第一张图', '原图必须原样保留')
  } finally {
    done()
  }
})

test('v232 ⑥: 少于 3 个节点 ⇒ TOO_FEW_NODES', async () => {
  const { call, done } = await env()
  try {
    const result = await call('memory_graph_update', {
      op: 'bootstrap',
      goal: '太小',
      nodes: [{ id: 'only-one', title: '只有一个' }],
      author: AUTHOR,
      reason: 'v232 太少',
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'TOO_FEW_NODES')
  } finally {
    done()
  }
})

test('v232 ⑦: goal 为空 ⇒ MISSING_GOAL', async () => {
  const { call, done } = await env()
  try {
    const result = await call('memory_graph_update', { op: 'bootstrap', goal: '   ', nodes: PLAN3, author: AUTHOR, reason: 'v232 无目标' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'MISSING_GOAL')
  } finally {
    done()
  }
})

test('v232 ⑧: 节点 id 重复 ⇒ 拒绝并点名', async () => {
  const { call, done } = await env()
  try {
    const duplicated = [...PLAN3, { id: 'phase-a', title: '重复的 A', depends_on: ['goal'] }]
    const result = await call('memory_graph_update', {
      op: 'bootstrap',
      goal: '重复 id',
      nodes: duplicated,
      author: AUTHOR,
      reason: 'v232 重复',
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'NODE_EXISTS')
    /** "Which id" is the only useful part of that message. */
    assert.match(String(result.reason), /phase-a/u, `拒绝必须点名 phase-a，实测 ${result.reason}`)
  } finally {
    done()
  }
})

test('v232 ⑨: dependsOn 指向批次外且不存在的节点 ⇒ DANGLING_DEPENDENCY 并点名', async () => {
  const { call, done } = await env()
  try {
    const result = await call('memory_graph_update', {
      op: 'bootstrap',
      goal: '悬空依赖',
      nodes: [
        { id: 'ok-a', title: 'A', depends_on: ['goal'] },
        { id: 'ok-b', title: 'B', depends_on: ['ok-a'] },
        { id: 'bad-c', title: 'C', depends_on: ['ghost-node'] },
      ],
      author: AUTHOR,
      reason: 'v232 悬空',
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'DANGLING_DEPENDENCY')
    assert.match(String(result.reason), /ghost-node/u, '拒绝必须点名那个不存在的依赖')
  } finally {
    done()
  }
})

test('v232 ⑩: 不传 author ⇒ MISSING_AUTHOR（T1c 的教训，走工具层）', async () => {
  const { call, nodeCount, done } = await env()
  try {
    const result = await call('memory_graph_update', {
      op: 'bootstrap',
      goal: '没有作者',
      nodes: PLAN3,
      reason: 'v232 无 author',
    })
    assert.equal(result.ok, false, '没有 author 的 bootstrap 必须被拒')
    assert.equal(result.code, 'MISSING_AUTHOR')
    assert.equal(await nodeCount(), 1, '被拒之后不许留下任何节点')
  } finally {
    done()
  }
})

test('v232 ⑪: 节点自带 origin.by 与顶层 author 不一致 ⇒ AUTHOR_MISMATCH', async () => {
  const { call, done } = await env()
  try {
    const other = { ...AUTHOR, sessionId: 'someone-else' }
    const result = await call('memory_graph_update', {
      op: 'bootstrap',
      goal: '归属不一致',
      nodes: [
        { id: 'm-a', title: 'A', depends_on: ['goal'] },
        { id: 'm-b', title: 'B', depends_on: ['m-a'], origin: { kind: 'planned', reason: '别人建的', by: other } },
        { id: 'm-c', title: 'C', depends_on: ['m-b'] },
      ],
      author: AUTHOR,
      reason: 'v232 归属',
    })
    assert.equal(result.ok, false, '一批节点里混进别人的节点必须被拒')
    assert.equal(result.code, 'AUTHOR_MISMATCH')
    assert.match(String(result.reason), /m-b/u, '拒绝要点名是哪个节点')
  } finally {
    done()
  }
})

test('v232 ⑫: 节点没给 origin ⇒ 从顶层 author 派生，kind = planned', async () => {
  const { call, done } = await env()
  try {
    await call('memory_graph_update', { op: 'bootstrap', goal: '派生 origin', nodes: PLAN3, author: AUTHOR, reason: 'v232 派生' })
    const read = await call('memory_graph_read', {})
    const node = read.nodes.find((row) => row.id === 'phase-a')
    assert.ok(node.origin !== undefined, '没有 origin 的节点必须被派生一个')
    assert.equal(node.origin.kind, 'planned', '派生的 kind 是 planned')
    assert.equal(node.origin.by.sessionId, AUTHOR.sessionId, 'by 必须来自顶层 author')
    assert.equal(node.origin.by.attempt, AUTHOR.attempt, 'attempt 必须保留（它是区分重试的唯一依据）')
  } finally {
    done()
  }
})

test('v232 ⑬: v3 字段透传 —— bootstrap 时给 logPointers，读回可见', async () => {
  const { call, done } = await env()
  try {
    await call('memory_graph_update', {
      op: 'bootstrap',
      goal: 'v3 透传',
      nodes: [
        {
          id: 'v3-a',
          title: 'A',
          depends_on: ['goal'],
          objective: '把 A 做完',
          progress: 10,
          log_pointers: [{ topic: '六轮 CI', generation: 5, sessionId: 'auto-graft-x', seq: 4508, what: '根因' }],
        },
        { id: 'v3-b', title: 'B', depends_on: ['v3-a'] },
        { id: 'v3-c', title: 'C', depends_on: ['v3-b'] },
      ],
      author: AUTHOR,
      reason: 'v232 v3',
    })
    const read = await call('memory_graph_read', {})
    const node = read.nodes.find((row) => row.id === 'v3-a')
    assert.equal(node.objective, '把 A 做完')
    assert.equal(node.progress, 10)
    assert.equal(node.logPointers.length, 1)
    assert.equal(node.logPointers[0].seq, 4508)
  } finally {
    done()
  }
})

test('v232 ⑭: history 有 bootstrap 与 lock-goal 两条，且是同一次操作', async () => {
  const { call, done } = await env()
  try {
    await call('memory_graph_update', { op: 'bootstrap', goal: 'history 测试', nodes: PLAN3, author: AUTHOR, reason: 'v232 history' })
    const read = await call('memory_graph_read', {})
    const ops = read.graph.history.map((entry) => entry.op)
    assert.ok(ops.includes('bootstrap'), `history 必须含 bootstrap，实测 ${ops.join(',')}`)
    assert.ok(ops.includes('lock-goal'), `history 必须含 lock-goal，实测 ${ops.join(',')}`)
    /** Both entries carry the author, so the audit can attribute the whole operation to one actor. */
    const boot = read.graph.history.find((entry) => entry.op === 'bootstrap')
    assert.equal(boot.author.sessionId, AUTHOR.sessionId, 'bootstrap 的 history 必须带 author')
  } finally {
    done()
  }
})

test('v232 ⑮: 幂等性反面 —— 成功后立刻再 bootstrap ⇒ 拒绝', async () => {
  const { call, done } = await env()
  try {
    const first = await call('memory_graph_update', { op: 'bootstrap', goal: '一次就够', nodes: PLAN3, author: AUTHOR, reason: '第一次' })
    assert.equal(first.ok, true)
    const second = await call('memory_graph_update', { op: 'bootstrap', goal: '再来一次', nodes: PLAN3, author: AUTHOR, reason: '第二次' })
    assert.equal(second.ok, false)
    assert.equal(second.code, 'GRAPH_NOT_EMPTY')
    const read = await call('memory_graph_read', {})
    assert.equal(read.graph.goal, '一次就够', '第二次不许改动第一次的结果')
    assert.equal(read.nodes.length, 5)
  } finally {
    done()
  }
})

test('v232 ⑯: bootstrap 分支只调用一次 persist（原子性的静态证据）', async () => {
  /**
   * ── WHY A SOURCE-LEVEL ASSERTION IS THE RIGHT TOOL HERE ─────────────────────────────────────────
   *
   * ③ proves "a rejected batch leaves the graph unchanged", but a loop-and-write implementation would
   * ALSO pass ③ as long as the loop happened to check before writing — the difference only shows up
   * when the failure is in the MIDDLE of a batch. Simulating a mid-write failure needs an injectable
   * fault in the store, which this repository does not have.
   *
   * What can be checked exactly: the bootstrap branch performs ONE `persist`. Two structural facts make
   * that meaningful rather than cosmetic — `persist` is the only function that writes the graph, and it
   * is called exactly once on the path, after every check has already run in `planBootstrap`. A loop of
   * `add` calls would show `updateGraph(` recursion or several `persist(` calls inside one branch.
   */
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(join(REPO, 'src', 'graph.ts'), 'utf8')
  const start = source.indexOf("if (op === 'bootstrap') {")
  assert.ok(start > 0, '必须能在源码里定位 bootstrap 分支')
  /** The branch ends at the next top-level `const targetId`, which is where node ops resume. */
  const end = source.indexOf('const targetId = asNodeId', start)
  assert.ok(end > start, '必须能定位 bootstrap 分支的结尾')
  const branch = source.slice(start, end)

  const persistCalls = (branch.match(/persist\(memoryDir,/g) ?? []).length
  assert.equal(persistCalls, 1, `bootstrap 分支必须恰好一次 persist，实测 ${persistCalls} 次`)
  /** No recursion: building the graph must not go back through op dispatch. */
  assert.equal(/updateGraph\(/.test(branch), false, 'bootstrap 不许递归调用 updateGraph（那就是「循环 add」）')
  /** The whole validation happens before the write: `planBootstrap` must come first. */
  assert.ok(branch.indexOf('planBootstrap(') < branch.indexOf('persist(memoryDir,'), '校验必须在写盘之前')
})

test('v232 ⑰: 十节点批次中途失败 ⇒ 前面九个一个也没落盘（审计痕迹除外）', async () => {
  const { call, nodeCount, done } = await env()
  try {
    /**
     * The first nine are fully legal; the tenth contradicts the batch author — a check that runs DURING
     * the per-node loop, i.e. after nine nodes have already been turned into specs. A loop that wrote
     * as it went would have nine nodes on disk by the time it noticed.
     */
    const nodes = Array.from({ length: 9 }, (_, index) => ({
      id: `mid-${index}`,
      title: `节点 ${index}`,
      node_type: 'coding',
      depends_on: index === 0 ? ['goal'] : [`mid-${index - 1}`],
    }))
    nodes.push({
      id: 'mid-bad',
      title: '第十个',
      node_type: 'coding',
      depends_on: ['mid-8'],
      origin: { kind: 'planned', reason: '别人', by: { ...AUTHOR, sessionId: 'somebody-else' } },
    })
    const before = await nodeCount()
    const result = await call('memory_graph_update', {
      op: 'bootstrap',
      goal: '中途失败',
      nodes,
      author: AUTHOR,
      reason: 'v232 中途失败',
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'AUTHOR_MISMATCH')
    assert.equal(await nodeCount(), before, '中途失败后节点数必须不变')
    const read = await call('memory_graph_read', {})
    assert.equal(read.graph.goal, '', 'goal 也不许被写上')
    assert.deepEqual(read.graph.history, [], 'history 也不许留下痕迹（整次操作要么全成要么全不）')
  } finally {
    done()
  }
})

test('v232 ⑱: 批次里形状错的 v3 字段必须报 INVALID_FIELD 并点名，不许静默丢弃', async () => {
  /**
   * ── THE SECOND DOOR INTO THE SAME TWELVE FIELDS ─────────────────────────────────────────────────
   *
   * `add` asks `vanishedFields` and refuses; `bootstrap` is a separate entry point into exactly the
   * same normaliser, and it did not ask. Measured before the fix: this very batch returned `ok: true`,
   * and on re-read `phase-a.logPointers` and `phase-b.progress` were both `undefined` — the caller
   * believes an eighteen-node plan recorded its pointers and its progress, and the store holds neither.
   * A silence, not an error.
   *
   * Both malformed shapes are exercised in one batch on purpose: `log_pointers` is snake_case from the
   * tool side and `progress` is a plain number, so a fix that only handles the snake_case mapping would
   * still miss the range violation.
   */
  const { call, nodeCount, done } = await env()
  try {
    const before = await nodeCount()
    const result = await call('memory_graph_update', {
      op: 'bootstrap',
      goal: '形状错字段',
      author: AUTHOR,
      reason: 'v232 静默丢弃',
      nodes: [
        { id: 'bad-a', title: 'A', depends_on: ['goal'], log_pointers: [{ nonsense: 1 }] },
        { id: 'bad-b', title: 'B', depends_on: ['bad-a'], progress: 999 },
        { id: 'bad-c', title: 'C', depends_on: ['bad-b'] },
      ],
    })
    assert.equal(result.ok, false, '形状不对的 v3 字段不许静默通过')
    assert.equal(result.code, 'INVALID_FIELD')
    /** The NODE must be named — in a batch of eighteen, a field name alone is a search, not a fix. */
    assert.match(result.reason, /bad-a/, `必须点名是哪个节点：${result.reason}`)
    assert.match(result.reason, /logPointers/, `必须点名是哪个字段：${result.reason}`)
    assert.equal(await nodeCount(), before, '拒绝之后图必须保持不变')

    /** And the range violation is caught too — the second shape, not a special case of the first. */
    const range = await call('memory_graph_update', {
      op: 'bootstrap',
      goal: '越界 progress',
      author: AUTHOR,
      reason: 'v232 越界',
      nodes: [
        { id: 'rng-a', title: 'A', depends_on: ['goal'] },
        { id: 'rng-b', title: 'B', depends_on: ['rng-a'], progress: 999 },
        { id: 'rng-c', title: 'C', depends_on: ['rng-b'] },
      ],
    })
    assert.equal(range.ok, false, 'progress=999 超出 0..100，不许通过')
    assert.equal(range.code, 'INVALID_FIELD')
    assert.match(range.reason, /rng-b/, `必须点名是哪个节点：${range.reason}`)
    assert.match(range.reason, /progress/, `必须点名是哪个字段：${range.reason}`)
    assert.equal(await nodeCount(), before, '拒绝之后图必须保持不变')
  } finally {
    done()
  }
})

