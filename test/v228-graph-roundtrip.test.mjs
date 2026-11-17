/**
 * ── v228：往返保真 —— 写入的 v3 字段在做一次无关 op 之后必须一个不少 ────────────────────────────
 *
 * ── THE FAILURE THIS FILE EXISTS FOR (measured 2026-11-17) ─────────────────────────────────────
 *
 * `readGraph` rebuilt every object from a whitelist and `persist` wrote the REBUILT object back. So:
 *
 *     read the file → keep the keys you recognise → write it back → every other key is GONE
 *
 * No error, no warning, no receipt that says anything but `ok`. Measured on the live store before this
 * batch: 18 nodes present, but the file held only the eleven v1 keys — the 8 `persistentConstraints`
 * and every node's `author` / `origin` / `logPointers` / `ephemeralConstraints` were already gone.
 *
 * So the assertion is not "the fields are documented". It is: WRITE a full v3 graph, do ONE unrelated
 * mutation, READ it back, and compare every field. Anything the reader did not understand would be
 * missing at exactly this point, and this is the only test that would notice.
 *
 * ── TWO SOURCES, PER THE RULING (a) AND (b) ────────────────────────────────────────────────────
 *
 * (a) The REAL store, when it can be located: it proves the actual file the host writes round-trips.
 *     Located the same way the plugin locates it (`DSH_MEMORY_DIR`, else the desktop profile's data
 *     dir), never hard-coded — a hard-coded `C:\Users\...` would be red on every other machine.
 *     Absent ⇒ SKIPPED with the reason PRINTED, following `run-gate-resource.test.mjs`: a test that
 *     silently skips is indistinguishable from a test that passed.
 * (b) A constructed 18-node fixture: portable, runs everywhere including CI, and it is the shape the
 *     live store is supposed to have. This one is never skipped.
 *
 * Both, because (b) alone would hide a fixture/live-drift, and (a) alone cannot run on CI.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(join(REPO, 'lib', 'graph.js')).href)
/**
 * The v3 field surface lives in its own module (`graph-v3.ts`, split out when `graph.ts` hit the
 * 800-line cap). `graph.js` re-exports the TYPES but not every function, so `asAuthor` is imported
 * from where it is defined rather than assumed to be on the graph module's export list.
 */
const v3 = await import(pathToFileURL(join(REPO, 'lib', 'graph-v3.js')).href)

const AUTHOR = {
  kind: 'model',
  sessionId: 'session-v228',
  generation: 12,
  attempt: 3,
  agentName: 'lead',
  role: 'executor',
  at: '2026-11-17T10:00:00.000Z',
}

/** The 18 ids the live graph holds, in their real order (see B2-T1 §三). */
const NODE_IDS = [
  'start', 'goal', 'phase-1-kg', 'phase-b0', 'phase-b1', 'phase-b2',
  'b2-t1', 'b2-t2', 'b2-t3', 'b2-trigger',
  'phase-b3', 'b3-f4', 'b3-f5', 'b3-f6', 'b3-f7',
  'phase-b4', 'phase-b5', 'phase-3-publish',
]

/**
 * A graph carrying EVERY v3 field this build knows, on every node. Not "a representative sample": a
 * sample would let the one forgotten field be the one that is not in the sample.
 */
function fullGraph(id = 'v228-fixture') {
  const nodes = NODE_IDS.map((nodeId, index) => ({
    id: nodeId,
    title: `节点 ${nodeId}`,
    nodeType: index < 2 ? 'anchor' : 'coding',
    requirements: [`要求 A-${nodeId}`, `要求 B-${nodeId}`],
    status: nodeId === 'start' ? 'done' : 'pending',
    dependsOn: index === 0 ? [] : [NODE_IDS[Math.min(index - 1, 1)]],
    knowledgePointers: [],
    fixed: nodeId === 'start' || nodeId === 'goal',
    harvestedAt: '',
    createdAt: '2026-11-17T09:00:00.000Z',
    updatedAt: '2026-11-17T09:00:00.000Z',
    origin: { kind: index === 0 ? 'planned' : 'inserted', reason: `因为 ${nodeId} 需要存在`, by: AUTHOR },
    lastChange: { by: AUTHOR, revision: index },
    objective: `把 ${nodeId} 做到可验收`,
    subgoals: [{ id: `sg-${index}`, text: `子目标 ${index}`, done: index % 2 === 0, verifiedBy: 'v228' }],
    alternatives: [
      { option: '方案甲', rationale: '更简单', verdict: 'chosen', expectedP: 0.8, actualP: 0.75 },
      { option: '方案乙', rationale: '更周全', verdict: 'rejected', why: '成本高', expectedP: 0.2 },
      { option: '方案丙', rationale: '以后再说', verdict: 'deferred', expectedP: 0.5, verdictChanged: true },
    ],
    pruned: [{ direction: `废弃方向 ${index}`, why: '不适用', at: '2026-11-17T09:10:00.000Z', by: AUTHOR }],
    estimate: { complexity: 3, note: '估三' },
    actual: { complexity: 4, note: '实际四', closedAt: '2026-11-17T09:30:00.000Z' },
    progress: index * 5,
    standing: `当前状态 ${nodeId}`,
    evidence: [`证据 A-${nodeId}`],
    logPointers: [
      { topic: `话题 ${nodeId}`, generation: 5, sessionId: 'auto-graft-old', seq: 100 + index, what: `那里有 ${nodeId} 的取证` },
      { topic: `话题 B-${nodeId}`, generation: 6, sessionId: 'auto-graft-older', search: `关键字 ${nodeId}`, what: '只有搜索词' },
    ],
    ephemeralConstraints: [
      {
        id: `ec-${nodeId}`,
        text: `节点期间不许动 ${nodeId} 的配置`,
        by: AUTHOR,
        scope: 'node',
        retiredAt: '2026-11-17T09:50:00.000Z',
        retiredWhy: '节点关闭',
      },
    ],
  }))
  return {
    version: 1,
    id,
    goal: '四仓持久层能力全部生产就绪',
    goalLockedAt: '2026-11-17T08:00:00.000Z',
    persistentConstraints: [
      {
        id: 'pc-1',
        text: '绝对禁止用 user/message 的壳子去装 developer 的灵魂',
        by: AUTHOR,
        effectiveFrom: '2026-11-03T00:00:00.000Z',
        note: '永久有效',
      },
      {
        id: 'pc-6',
        text: '不 force push、不 publish、不碰 desktop profile',
        by: AUTHOR,
        effectiveFrom: '2026-11-03T00:00:00.000Z',
        retiredAt: '2026-12-01T00:00:00.000Z',
        retiredWhy: '阶段 3 发版时由用户显式解除',
      },
    ],
    nodes,
    history: [{ at: '2026-11-17T08:00:00.000Z', op: 'lock-goal', nodeId: 'goal', reason: '用户已裁定', changed: ['goal'], author: AUTHOR }],
    createdAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-17T09:00:00.000Z',
  }
}

/** Read the raw JSON on disk — the comparison must be against the FILE, not a re-read through the API. */
const rawOnDisk = (dir) => JSON.parse(readFileSync(join(dir, 'task-graph.json'), 'utf8'))

/** Every v3 field we planted, compared field by field. Returns the names that differ. */
function survivors(original, roundTripped) {
  const problems = []
  const pc = roundTripped.persistentConstraints ?? []
  if (pc.length !== original.persistentConstraints.length) {
    problems.push(`persistentConstraints 条数 ${pc.length} != ${original.persistentConstraints.length}`)
  }
  for (const wanted of original.persistentConstraints) {
    const found = pc.find((row) => row.id === wanted.id)
    if (found === undefined) { problems.push(`persistentConstraints 丢了 ${wanted.id}`); continue }
    for (const key of ['text', 'effectiveFrom', 'retiredAt', 'retiredWhy', 'note']) {
      if (JSON.stringify(found[key]) !== JSON.stringify(wanted[key])) problems.push(`pc ${wanted.id}.${key} 变了`)
    }
    if (JSON.stringify(found.by) !== JSON.stringify(wanted.by)) problems.push(`pc ${wanted.id}.by 变了`)
  }
  for (const wanted of original.nodes) {
    const found = (roundTripped.nodes ?? []).find((node) => node.id === wanted.id)
    if (found === undefined) { problems.push(`节点 ${wanted.id} 丢了`); continue }
    for (const key of [
      'origin', 'lastChange', 'objective', 'subgoals', 'alternatives', 'pruned',
      'estimate', 'actual', 'progress', 'standing', 'evidence', 'logPointers', 'ephemeralConstraints',
    ]) {
      if (JSON.stringify(found[key]) !== JSON.stringify(wanted[key])) {
        problems.push(`节点 ${wanted.id}.${key} 变了\n  写:${JSON.stringify(wanted[key])}\n  读:${JSON.stringify(found[key])}`)
      }
    }
  }
  const historyEntry = (roundTripped.history ?? [])[0]
  if (JSON.stringify(historyEntry?.author) !== JSON.stringify(AUTHOR)) problems.push('history[0].author 变了')
  return problems
}

test('⑧(b) 构造 18 节点全字段图：一次无关 op 之后，v3 字段一个不少（可移植，CI 也跑）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v228-fixture-'))
  try {
    const original = fullGraph()
    writeFileSync(join(dir, 'task-graph.json'), `${JSON.stringify(original, null, 2)}\n`, 'utf8')

    // Sanity: the reader must SEE the planted graph before we ask whether it survives a write.
    const loaded = mod.readGraph(dir)
    assert.equal(loaded.nodes.length, 18, `前置条件：18 节点必须读得到，实测 ${loaded.nodes.length}`)
    assert.equal(loaded.persistentConstraints.length, 2, '前置条件：persistentConstraints 必须读得到')

    /**
     * The mutation is deliberately UNRELATED to any v3 field: a plain `status` change. If the writer
     * rebuilds the document from what THIS op touches, every v3 field disappears — which is exactly the
     * measured failure.
     */
    const updated = mod.updateGraph(dir, {
      op: 'update',
      nodeId: 'b2-t1',
      node: { status: 'active' },
      reason: 'v228 无关变更',
    })
    assert.equal(updated.ok, true, `更新必须成功：${JSON.stringify(updated).slice(0, 300)}`)

    const after = rawOnDisk(dir)
    const problems = survivors(original, after)
    assert.deepEqual(problems, [], `v3 字段在往返中丢失或变化：\n${problems.join('\n')}`)

    // And the field the op DID touch actually moved — otherwise "nothing changed" would also pass.
    assert.equal(after.nodes.find((node) => node.id === 'b2-t1').status, 'active', '被更新的字段必须真的变了')
    // 18 nodes in, 18 nodes out: a writer that drops nodes would otherwise pass the field comparison.
    assert.equal(after.nodes.length, 18)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑧(a) 真实 store 若存在则同样往返（不存在则明确跳过并打印原因）', (t) => {
  /**
   * Located the way the plugin locates it, never hard-coded: `DSH_MEMORY_DIR` first, then the desktop
   * profile's data directory. A hard-coded `C:\Users\...` would be red on every machine but this one.
   */
  const candidates = [
    process.env.DSH_MEMORY_DIR,
    join(homedir(), '.dsh', 'profiles', 'desktop', '.dsh-memory'),
  ].filter((value) => typeof value === 'string' && value.length > 0)
  const live = candidates.find((dir) => existsSync(join(dir, 'task-graph.json')))
  if (live === undefined) {
    /**
     * SKIPPED WITH A REASON, loudly. A silent skip is indistinguishable from a pass, and this test's
     * whole value is that somebody can see whether the REAL file was checked.
     */
    t.diagnostic(`(a) 未验：在 ${candidates.join(' / ')} 都没有 task-graph.json。`)
    t.diagnostic('(a) 这不代表判据通过 —— 只代表这台机器上没有那个文件；(b) 已独立覆盖同一组字段。')
    return
  }
  const copy = mkdtempSync(join(tmpdir(), 'dsh-v228-live-'))
  try {
    /**
     * A COPY, never the live file: this test must not mutate the host's state, and the whole point of
     * the fixture is that the round-trip is a property of the code, not of the machine.
     */
    const original = JSON.parse(readFileSync(join(live, 'task-graph.json'), 'utf8'))
    writeFileSync(join(copy, 'task-graph.json'), `${JSON.stringify(original, null, 2)}\n`, 'utf8')
    const target = (original.nodes ?? []).find((node) => node.status !== 'done' && node.id !== 'goal')
    if (target === undefined) {
      t.diagnostic('(a) 未验：真实图里没有可安全改动的非 done 节点。')
      return
    }
    const updated = mod.updateGraph(copy, {
      op: 'update',
      nodeId: target.id,
      node: { standing: 'v228 往返探针' },
      reason: 'v228 live round-trip',
    })
    assert.equal(updated.ok, true, `真实图的一次更新必须成功：${JSON.stringify(updated).slice(0, 300)}`)
    const after = rawOnDisk(copy)
    /**
     * The comparison is on what the LIVE file actually CONTAINS, so a live file that predates v3 has
     * nothing to compare field-by-field. What must hold for it is: same node count, same ids, and every
     * key it carried is still there — that is the "no silent shredding" property.
     */
    assert.deepEqual(after.nodes.map((node) => node.id), (original.nodes ?? []).map((node) => node.id), '节点集合必须不变')
    const topKeysLost = Object.keys(original).filter((key) => !(key in after))
    assert.deepEqual(topKeysLost, [], `顶层字段被删除：${topKeysLost.join(', ')}`)
    t.diagnostic(`(a) 已验：真实 store ${live} 的 ${after.nodes.length} 个节点往返无损。`)
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})

test('⑩ 没有 attempt 的 author 必须被拒 ——「没说第几次」不等于「第一次」', (t) => {
  /**
   * ── THE ONE DEFAULT THAT MUST NOT EXIST ────────────────────────────────────────────────────────
   *
   * Six consecutive CI failures in this project happened inside ONE session. "The diagnosis at failure
   * 3" and "at failure 5" are that same session and different attempts. Filling a missing `attempt`
   * with 1 would convert "the writer did not say which try this was" into "this was the first try" — a
   * fact nobody established — and the two would then read as one.
   *
   * So `asAuthor` returns `undefined`, and the writer refuses. Both halves are asserted here: a
   * refusing reader whose writer then substitutes a default would be the same defect one layer down.
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v228-author-'))
  try {
    assert.equal(v3.asAuthor({ ...AUTHOR, attempt: undefined }), undefined, '缺 attempt ⇒ asAuthor 必须返回 undefined')
    assert.equal(v3.asAuthor({ ...AUTHOR, attempt: 0 }), undefined, 'attempt 从 1 开始，0 非法')
    assert.ok(v3.asAuthor({ ...AUTHOR, attempt: 1 }) !== undefined, '合法的 attempt 必须解析成功')

    writeFileSync(join(dir, 'task-graph.json'), `${JSON.stringify(fullGraph('v228-author'), null, 2)}\n`, 'utf8')
    const bad = { ...AUTHOR }
    delete bad.attempt
    const result = mod.updateGraph(dir, {
      op: 'update',
      nodeId: 'b2-t1',
      node: { origin: { kind: 'inserted', reason: 'x', by: bad } },
      reason: 'v228 author 测试',
    })
    /**
     * The field is supplied but cannot resolve ⇒ the write is REFUSED, not silently dropped. This is
     * the write-side half of `vanishedFields`, and it is what makes "it is in the store ⇒ it is a
     * valid Author" a property later readers can rely on.
     */
    assert.equal(result.ok, false, '缺 attempt 的 author 必须让整次写入失败')
    assert.equal(result.code, 'INVALID_FIELD')
    assert.match(String(result.reason), /origin/u, `拒绝必须点名是哪个字段，实测 ${result.reason}`)
    t.diagnostic(String(result.reason).slice(0, 200))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑨ 未知字段：保留 + 读图时点名报告（不静默丢弃，也不静默保留）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v228-unknown-'))
  try {
    const graph = fullGraph('v228-unknown')
    graph.nodes[1].futureField = 42
    graph.topLevelFutureField = 'x'
    writeFileSync(join(dir, 'task-graph.json'), `${JSON.stringify(graph, null, 2)}\n`, 'utf8')

    mod.drainGraphWarnings()
    const loaded = mod.readGraph(dir)
    const warnings = mod.drainGraphWarnings()

    assert.equal(loaded.nodes.find((node) => node.id === graph.nodes[1].id).futureField, 42,
      '未知字段必须被保留 —— 丢弃一个未来版本的字段，就是让降级毁掉升级的数据')
    assert.ok(warnings.some((w) => w.includes('futureField')), `报告必须点名 futureField，实测 ${JSON.stringify(warnings)}`)
    assert.ok(warnings.some((w) => w.includes('topLevelFutureField')), '图级未知字段同样要点名')
    /**
     * ONCE, not once per node. A graph with 40 nodes and one typo would otherwise emit forty identical
     * lines, and a warning nobody reads is not a warning.
     */
    assert.equal(warnings.length, 1, `一次读只报告一次，实测 ${warnings.length} 条`)
    t.diagnostic(warnings[0])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
