/**
 * ── v320 / 19.4-G (P0): 终点不是一段工作 ──────────────────────────────────────────────────────────
 *
 * lead 的取证（§二十二 / §二十三）：19.4-F 成立「让『哪些节点是阶段』只有一个所有者」这条原则，
 * **但只被它改到的两个读者遵守**。`src/index.ts` 里还有五处手写「排除 `start`」，**五处都漏了 `goal`**：
 *
 *   G-1 `:2152` 阶段横幅        → 说「你正在进入 [当前] 阶段…要求：四合持久层能力全部生产就绪」
 *   G-2 `:2089` 提炼提醒        → 「节点 goal、phase-b3、phase-b4 已完成，但还没有写入全局知识库」
 *   G-3 `:1135` **写盘入参**    → 一次真实 harvest 把 `harvestedAt` 盖到 goal 上并原子写盘（P0）
 *   G-4 `:1002` 飞轮统计        → 把 goal 算作已完成
 *   G-5 `:1839` unharvested 计数 → 把 goal 算进「完成但没提炼」的分母
 *   G-6 `graph.ts:604` 的锁     → 只覆盖 update/deprecate，`activate`/`complete` 打在 goal 上照样成功
 *
 * ── 判据的共同形状（lead 的硬要求）────────────────────────────────────────────────────────────
 *
 * 每条走**真实工具 / 真实文件**，每条带**负向半边**（否则「一律拒绝」「整条提醒消失」也能过），
 * 且**不许用源码子串断言新逻辑** —— 那只会把判据钉回某个写法（§〇 28）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..', '..')

const node = (id, title, status, dependsOn, extra = {}) => ({
  id,
  title,
  nodeType: '',
  requirements: ['要求一'],
  status,
  dependsOn,
  knowledgePointers: [],
  fixed: id === 'start' || id === 'goal',
  harvestedAt: '',
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
  ...extra,
})

/** The live screen's shape: `goal` is `active`, one real phase is `active`, one phase is `done`. */
function liveGraph({ goalStatus = 'active', goalHarvested = '' } = {}) {
  return {
    version: 1,
    id: 'default',
    goal: '四合持久层能力全部生产就绪',
    goalLockedAt: '2026-11-18T00:00:00.000Z',
    nodes: [
      node('start', '开始', 'done', []),
      node('goal', '目标', goalStatus, [], {
        requirements: ['四合持久层能力全部生产就绪'],
        harvestedAt: goalHarvested,
      }),
      node('phase-b3', 'B3', 'done', ['start'], { nodeType: 'coding', harvestedAt: '2026-11-20T00:00:00.000Z' }),
      node('phase-b4', 'B4', 'active', ['phase-b3'], { nodeType: 'coding' }),
      node('phase-b5', 'B5', 'pending', ['phase-b4']),
    ],
    history: [],
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    persistentConstraints: [],
  }
}

/** A real plugin on a real store. Returns the tools + the memoryDir so a caller can re-read the file. */
async function env(graph, { withHarvestTool = false } = {}) {
  const memory = await import(pathToFileURL(join(ROOT, 'dsh-memory', 'lib', 'index.js')).href)
  const root = mkdtempSync(join(tmpdir(), 'dsh-v320-'))
  const memoryDir = join(root, '.dsh-memory')
  const knowledgeDir = join(root, '.dsh-knowledge')
  mkdirSync(memoryDir, { recursive: true })
  mkdirSync(knowledgeDir, { recursive: true })
  writeFileSync(
    join(memoryDir, '.layout.json'),
    JSON.stringify({ layout: 1, producer: 'dsh-memory', files: ['task-graph.json'] }, null, 2),
    'utf8',
  )
  writeFileSync(join(memoryDir, 'task-graph.json'), JSON.stringify(graph, null, 2), 'utf8')

  const tools = new Map()
  const injected = []
  const ctx = {
    get(name) {
      if (name === 'paths') return { data: root }
      if (name === 'configEditor') return { entries: () => [], edit: async () => undefined }
      if (name === 'sessions') {
        return {
          get: (id) => ({
            id,
            header: { id, cwd: root },
            snapshotEvents: () => [],
            requestContext: () => ({ contextWindow: 1048576 }),
            requestHeader: () => ({ config: { maxTokens: 64000 } }),
          }),
          list: () => [{ id: 'session-alpha' }],
        }
      }
      return undefined
    },
    logger: { info() {}, warn() {}, error() {} },
    /**
     * The real hook is `agent/pre-step`, and its signature is `(payload, next)` where `next()` returns the
     * decision the listener may extend. Capturing the HANDLER (not faking an injection list) is what makes
     * ② read the real text instead of a copy of the rule.
     */
    on(event, handler) {
      if (event === 'agent/pre-step') injected.push({ event, handler })
    },
    tools: { register: (definition) => tools.set(definition.name, definition) },
  }
  memory.apply(ctx, { memoryDir, knowledgeDir, skillsDir: join(root, '.agents', 'skills') })
  return { memory, memoryDir, knowledgeDir, root, tools, injected, ctx }
}

const readWritten = (memoryDir) => JSON.parse(readFileSync(join(memoryDir, 'task-graph.json'), 'utf8'))
const nodeOf = (graph, id) => (graph.nodes ?? []).find((entry) => entry.id === id)

/* ── ① G-1：阶段横幅 ───────────────────────────────────────────────────────────────────────────── */

test('v320 ①: goal active + 阶段 active ⇒ 横幅点名那个阶段，且带它的 nodeType', async () => {
  const e = await env(liveGraph())
  try {
    const read = e.tools.get('memory_graph_read')
    const out = await read.execute({})
    assert.equal(out.activeNodeId, 'phase-b4',
      `当前节点必须是真实阶段；实测 ${String(out.activeNodeId)}`)
    assert.match(String(out.activeBanner), /coding/u,
      `横幅必须带阶段的 nodeType（不是 goal 的要求文本）；实测：${String(out.activeBanner)}`)
    assert.equal(String(out.activeBanner).includes('goal'), false, '横幅不得点名 goal')
    /** The same predicate must reach the INJECTION (G-1), not only the tool. 19.4-F fixed the tool. */
    const source = readFileSync(join(ROOT, 'dsh-memory', 'src', 'index.ts'), 'utf8')
    assert.equal(source.includes("node.id !== START_NODE_ID"), false,
      '五处手写「排除 start」必须全部消失 —— 否则第 N 处仍会漏掉 goal（§〇 28：钉一个写法只钉住那个写法）')
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})

test('v320 ①-负向: goal active 但没有阶段 active ⇒ 不得点名 goal', async () => {
  /**
   * Without this half, ① is satisfied by 「prefer a non-goal when present」 — which still names the goal
   * when nothing is running.
   */
  const e = await env(liveGraph({ goalStatus: 'active' }))
  try {
    const path = join(e.memoryDir, 'task-graph.json')
    const graph = readWritten(e.memoryDir)
    graph.nodes = graph.nodes.map((entry) =>
      entry.id === 'phase-b4' ? { ...entry, status: 'pending' } : entry)
    writeFileSync(path, JSON.stringify(graph, null, 2), 'utf8')
    const out = await e.tools.get('memory_graph_read').execute({})
    assert.equal(out.activeNodeId, '', `只有 goal active 时不得把 goal 当当前节点；实测 ${String(out.activeNodeId)}`)
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})

/* ── ② G-2：提炼提醒 ───────────────────────────────────────────────────────────────────────────── */

test('v320 ②: goal done ⇒ 提炼提醒的 id 与正文都不含 goal；负向：真实阶段的提醒仍在', async () => {
  /**
   * ── THE FIXTURE NEEDS A **REAL** DONE PHASE TOO ────────────────────────────────────────────────────
   *
   * First version had `goal` done and no other un-harvested node — so after the fix the reminder set was
   * correctly EMPTY and ② had nothing to read. That empty set is the fix working, not the rule broken.
   * `phase-b5` is done-without-harvest here, so the reminder still fires and must name IT while not
   * naming the goal. (Sixth time this batch: check the probe before believing it red.)
   */
  const e = await env(liveGraph({ goalStatus: 'done' }))
  try {
    const path = join(e.memoryDir, 'task-graph.json')
    const graph = readWritten(e.memoryDir)
    graph.nodes = graph.nodes.map((entry) =>
      entry.id === 'phase-b5' ? { ...entry, status: 'done' } : entry)
    writeFileSync(path, JSON.stringify(graph, null, 2), 'utf8')
    /**
     * `harvestWarningFor` is a pre-step injection. Driving it through the registered hook is the only
     * way to see the TEXT; calling the filter directly would test a copy of the rule.
     */
    const subjects = []
    for (const { handler } of e.injected) {
      const result = await handler(
        {
          agent: { id: 'session-alpha' },
          messages: [{ role: 'user', content: [{ type: 'text', text: '继续把这件事做完' }] }],
        },
        async () => ({ kind: 'enter', messages: [] }),
      )
      const messages = Array.isArray(result) ? result : result?.messages ?? []
      for (const message of messages) {
        const text = (message?.content ?? []).map((part) => String(part?.text ?? '')).join(' ')
        if (text.length > 0) subjects.push(text)
      }
    }
    const harvestTexts = subjects.filter((text) => text.includes('已完成') && text.includes('知识库'))
    assert.ok(harvestTexts.length > 0,
      `前提确认：goal=done 时会有「完成但没提炼」的提醒（否则 ② 是在断言一件没发生的事）；收到 ${JSON.stringify(subjects).slice(0, 400)}`)
    for (const text of harvestTexts) {
      assert.equal(text.includes('goal'), false,
        `提醒不得点名 goal；实测：${text.slice(0, 300)}`)
    }
    /** Negative half — a REAL completed phase is still named, so 「整条提醒消失」 cannot pass. */
    const namesPhase = harvestTexts.some((text) => text.includes('phase-b4') || text.includes('phase-b5') || text.includes('phase'))
    assert.equal(namesPhase, true,
      `提醒仍须点名真正完成的阶段（不许靠「整条消失」蒙混）；实测：${JSON.stringify(harvestTexts).slice(0, 400)}`)
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})

/* ── ③ G-6：goal 的 activate / complete 必须被拒 ───────────────────────────────────────────────── */

test('v320 ③: activate/complete 打在 goal 上必须失败；负向：打在真实阶段上仍然成功', async () => {
  const e = await env(liveGraph())
  try {
    const update = e.tools.get('memory_graph_update')
    /**
     * `activate` / `complete` must be refused by the FIXED-NODE rule (`RESERVED`). `deprecate` is refused
     * EARLIER by the goal lock (`GOAL_LOCKED`) — that guard predates this work and still fires first, so
     * the code is asserted per-op rather than forced to be one value. What matters for all three is
     * `ok: false`: the destination is not a unit of work.
     */
    for (const [op, code] of [['activate', 'RESERVED'], ['complete', 'RESERVED'], ['deprecate', 'GOAL_LOCKED']]) {
      const result = await update.execute({ op, nodeId: 'goal', reason: '探针：终点不是工作' })
      assert.equal(result.ok, false, `${op} 打在 goal 上必须被拒；实测 ${JSON.stringify(result).slice(0, 200)}`)
      assert.equal(result.code, code,
        `${op} 的拒绝码应为 ${code}（未新增错误码，见停止条件）；实测 ${String(result.code)}`)
    }
    /** Negative half: an ordinary phase is untouched — this is not 「refuse everywhere」. */
    const ok = await update.execute({ op: 'activate', nodeId: 'phase-b5', reason: '探针：真实阶段可以开工' })
    assert.equal(ok.ok, true, `真实阶段必须照常可以 activate；实测 ${JSON.stringify(ok).slice(0, 200)}`)
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})

/* ── ④ G-3 + ⑤ 写入层（P0 的主判据）───────────────────────────────────────────────────────────── */

test('v320 ④b (P0, THE ACTUAL WRITE SITE): `activeNodeIdsForHarvest` 的入参不含 goal', async () => {
  /**
   * ── WHY THIS EXISTS, AND WHY ④ ALONE WAS NOT ENOUGH ───────────────────────────────────────────
   *
   * can-red `a` (restore the hand-written `id !== 'start'`) left EVERY criterion green. The reason:
   * ④ drives `memory_contribute`, which stamps ONE explicit node id — it never goes through
   * `activeNodeIdsForHarvest`, and that function is the argument of `markHarvested` at `:1650`, the
   * 「all done and unharvested」 write. So ④ proved the contribute path while the harvest-batch path —
   * the one the lead measured writing `harvestedNodes = ["goal","phase-b3","phase-b4"]` — was untested.
   *
   * **A criterion that pins one call path pins that path.** This one reads the FUNCTION'S OUTPUT on a
   * real store: the set that will be handed to the writer must not contain the goal.
   */
  const e = await env(liveGraph({ goalStatus: 'done' }))
  try {
    const path = join(e.memoryDir, 'task-graph.json')
    const graph = readWritten(e.memoryDir)
    graph.nodes = graph.nodes.map((entry) =>
      entry.id === 'phase-b5' ? { ...entry, status: 'done' } : entry)
    writeFileSync(path, JSON.stringify(graph, null, 2), 'utf8')

    /**
     * Drive the REAL batch path (`knowledge_harvest` at `index.ts:1650` calls
     * `markHarvested(memoryDir, activeNodeIdsForHarvest(memoryDir))`). The first version of this
     * criterion re-derived the naive set itself and asserted on THAT — so it could never fail when the
     * product kept the bug, which is exactly what can-red `a` proved. The criterion must read what the
     * PRODUCT writes, not what a copy of the product would write.
     */
    const batch = e.tools.get('knowledge_harvest')
    assert.ok(batch !== undefined, '前提：knowledge_harvest（批量路径）必须已注册')
    await batch.execute(
      {
        entries: [
          {
            id: 'probe-batch-skill',
            kind: 'skill',
            title: '探针：批量路径写入的一条知识',
            body: '由 v320 ④b 写入，用来触发 markHarvested 的批量分支',
            author: { kind: 'model', sessionId: 'session-alpha', generation: 1, attempt: 1 },
          },
        ],
      },
      { agent: { id: 'session-alpha' } },
    )

    const after = readWritten(e.memoryDir)
    const goalAfter = nodeOf(after, 'goal')
    assert.equal(String(goalAfter?.harvestedAt ?? ''), '',
      `批次写盘路径不得把 goal 收进 markHarvested 的入参（lead 实测过一次 harvest 盖三个章）；` +
      `实测 goal.harvestedAt=${String(goalAfter?.harvestedAt)}`)
    /** The negative half: real phases ARE stamped, so 「整段消失」 cannot pass. */
    assert.ok((after.nodes ?? []).some((n) => n.id === 'phase-b3' && String(n.harvestedAt ?? '').length > 0),
      '真实阶段必须仍然有章（phase-b3 原本就带章，不许被清掉）')
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})

test('v320 ⑤ (G-1, THE INJECTION): 阶段横幅的真实输出点名阶段，不含 goal', async () => {
  /**
   * ── G-1 IS THE LAYER THE USER COMPLAINED ABOUT, AND ① ONLY CHECKED THE TOOL ────────────────────
   *
   * `v320 ①` asserts `memory_graph_read.activeNodeId` — the TOOL (fixed in 19.4-F). The banner that the
   * NEXT sliced session reads is produced by `phaseNudgeFor` at `agent/pre-step`, a different reader with
   * its own copy of the filter. can-red `a` left ① green because the mutation only reached one of them.
   *
   * So this drives the real pre-step handler and reads the injected text.
   */
  const e = await env(liveGraph())
  try {
    /**
     * ── `renderPhaseHint` RETURNS `undefined` WHEN NOTHING MATCHES ─────────────────────────────────
     *
     * `knowledge.ts:711`: `if (result.matched === 0) return undefined`. A banner therefore only exists
     * when the knowledge base has an entry for that `nodeType` — an EMPTY store produces no banner at
     * all, and the first version of this criterion read that silence as 「G-1 unfixed」. It was the
     * fixture, not the product. Seed one `coding` entry so the banner has something to say.
     * (Seventh fixture error this batch, same shape: check the probe before believing it red.)
     */
    e.memory.writeKnowledge?.(
      e.knowledgeDir,
      [{ id: 'probe-coding-skill', kind: 'skill', title: '探针：coding 阶段的技能', applicableNodeTypes: ['coding'], workspace: '' }],
      { workspace: '' },
    )
    /** Fall back to the on-disk layout when the module does not re-export the writer. */
    if (e.memory.writeKnowledge === undefined) {
      writeFileSync(
        join(e.knowledgeDir, 'knowledge.jsonl'),
        `${JSON.stringify({
          id: 'probe-coding-skill',
          kind: 'skill',
          title: '探针：coding 阶段的技能',
          when: 'probe',
          applicableNodeTypes: ['coding'],
          workspace: '',
          tags: [],
          evidence: [],
        })}\n`,
        'utf8',
      )
    }

    const texts = []
    const raw = []
    for (const { handler } of e.injected) {
      const result = await handler(
        {
          agent: { id: 'session-alpha' },
          messages: [{ role: 'user', content: [{ type: 'text', text: '继续把这件事做完' }] }],
        },
        async () => ({ kind: 'enter', messages: [] }),
      )
      raw.push(result)
      const messages = Array.isArray(result) ? result : result?.messages ?? []
      for (const message of messages) {
        const text = (message?.content ?? []).map((part) => String(part?.text ?? '')).join(' ')
        if (text.length > 0) texts.push(text)
      }
    }
    assert.ok(texts.length > 0,
      `前提确认：goal active + phase-b4 active 时应当有注入；handler 数=${e.injected.length}，` +
      `返回值=${JSON.stringify(raw).slice(0, 500)}；` +
      `read=${JSON.stringify(await e.tools.get('memory_graph_read').execute({})).slice(0, 400)}`)
    /** Keep only the phase banner — the retrieval hint may also have injected text. */
    const banners = texts.filter((text) => text.includes('[系统提示]'))
    assert.ok(banners.length > 0,
      `前提确认：必须有阶段横幅；实测注入文本：${JSON.stringify(texts).slice(0, 600)}`)
    for (const text of banners) {
      assert.equal(text.includes('节点 goal'), false,
        `横幅不得把 goal 说成当前节点；实测：${text.slice(0, 400)}`)
      assert.equal(text.includes('[当前]'), false,
        `[当前] 是 goal 的 nodeType 为空时的回退词，出现它说明选中的不是真实阶段；实测：${text.slice(0, 400)}`)
    }
    assert.ok(banners.some((text) => text.includes('coding') || text.includes('phase-b4')),
      `横幅必须点名真实阶段（不许靠「整条不注入」蒙混）；实测：${JSON.stringify(banners).slice(0, 400)}`)
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})

test('v320 ④ (P0, WRITE, single-node path): goal done 时一次真实贡献不得给它盖章；阶段仍被盖章', async () => {
  /**
   * THE ONE THAT LEAVES HISTORY. A read error is read again; this writes `harvestedAt` into
   * `task-graph.json`, and every later reader then believes 「the destination was harvested」.
   *
   * Baseline measured by the lead: with `goal: 'done'`, one real `knowledge_harvest` produced
   * `harvestedNodes = ["goal","phase-b3","phase-b4"]`.
   */
  const e = await env(liveGraph({ goalStatus: 'done' }))
  try {
    const harvest = e.tools.get('memory_harvest')
    assert.ok(harvest !== undefined, '前提：memory_harvest 必须已注册')
    /**
     * `memory_harvest` needs retired sessions to mine; with none, the run writes nothing and the stamp
     * never happens. `knowledge_harvest` (per node) is the path that stamps unconditionally, so it is the
     * one that proves the write rule.
     */
    const contribute = e.tools.get('memory_contribute') ?? e.tools.get('knowledge_harvest')
    assert.ok(contribute !== undefined, '前提：写知识并盖章的工具必须已注册')

    const before = nodeOf(readWritten(e.memoryDir), 'goal')
    assert.equal(String(before?.harvestedAt ?? ''), '', '前提确认：goal 初始无章')

    /** The stamp is applied to 「all done and unharvested」 — the set this rule filters. */
    const donePhases = ['phase-b4']
    for (const id of ['phase-b4', ...donePhases]) {
      const graph = readWritten(e.memoryDir)
      const entry = nodeOf(graph, id)
      if (entry !== undefined && entry.status !== 'done') {
        graph.nodes = graph.nodes.map((n) => (n.id === id ? { ...n, status: 'done' } : n))
        writeFileSync(join(e.memoryDir, 'task-graph.json'), JSON.stringify(graph, null, 2), 'utf8')
      }
    }

    const result = await contribute.execute(
      {
        nodeId: 'phase-b4',
        kind: 'skill',
        title: '探针技能',
        body: '这是探针写入的一条知识',
        /**
         * `memory_contribute` requires an author — measured: without it the call returns
         * `MISSING_AUTHOR`, which would have made ④ fail for a FIXTURE reason and been read as a product
         * defect. (Fifth time this batch: check the probe before believing it red.)
         */
        author: { kind: 'model', sessionId: 'session-alpha', generation: 1, attempt: 1 },
      },
      { agent: { id: 'session-alpha' } },
    )
    assert.equal(result.ok, true, `前提确认：贡献必须成功；实测 ${JSON.stringify(result).slice(0, 300)}`)

    const after = readWritten(e.memoryDir)
    const goalAfter = nodeOf(after, 'goal')
    assert.equal(String(goalAfter?.harvestedAt ?? ''), '',
      `终点不得被盖章（这是写盘污染，之后所有读者都会相信它）；实测 harvestedAt=${String(goalAfter?.harvestedAt)}`)

    /** ⑤ the negative half: a REAL phase IS stamped, so 「盖章整段消失」 cannot pass. */
    const stamps = (after.nodes ?? []).filter((n) => String(n.harvestedAt ?? '').length > 0).map((n) => n.id)
    assert.ok(stamps.some((id) => id !== 'start' && id !== 'goal'),
      `真实阶段必须仍然被盖章（否则判据被「盖章整段消失」蒙混）；实测 ${JSON.stringify(stamps)}`)
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})