/**
 * ── v321 / G-8 (P0, MEMORY-03): 损坏的图不许被当成「没有计划」────────────────────────────────────
 *
 * 外部报告 v3.2 §5.4 的指控，lead 在当前 HEAD 复现：「部分成立」—— 面板侧已用 `graphIsUnreadable`
 * 区分，但 `readGraph` 本身仍 `catch → emptyGraph`，**活路径**照样拿到空图：
 *
 *     memory_graph_read / phaseNudgeFor / harvestWarningFor / activeNodeIdsForHarvest（后者是写）
 *
 * 后果（lead 原话）：图损坏 ⇒ `readGraph` 返回只有 `start` 的空图 ⇒ `harvestWarningFor` 认为没有待提炼
 * 节点、`markHarvested` 静默 no-op。**用户看到的是「一切正常」，实际是图已经读不出来。**
 *
 * 判据（四条，含两条负向）：
 *   ① 损坏图 ⇒ `memory_graph_read` 必须报「读不出来」，**不得**返回空图
 *   ② **负向**：文件**不存在** ⇒ 仍是「尚未建计划」（不许把「没建过」说成「损坏」）
 *   ③ 损坏图 ⇒ **写入路径**不得执行，且不得静默返回 `[]` 冒充「不需要盖章」
 *   ④ 三态在纯函数层可区分（absent / unreadable / ok），且空文件算 unreadable 而不是 absent
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..', '..')

const node = (id, title, status, extra = {}) => ({
  id,
  title,
  nodeType: 'coding',
  requirements: ['要求一'],
  status,
  dependsOn: [],
  knowledgePointers: [],
  fixed: id === 'start' || id === 'goal',
  harvestedAt: '',
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
  ...extra,
})

const goodGraph = {
  version: 1,
  id: 'default',
  goal: '目标',
  goalLockedAt: '2026-11-18T00:00:00.000Z',
  nodes: [node('start', '开始', 'done'), node('phase-a', 'A', 'active')],
  history: [],
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
  persistentConstraints: [],
}

/** A real plugin over a store whose `task-graph.json` is described by `graphBody`. */
async function env({ graphBody, omitGraph = false } = {}) {
  const memory = await import(pathToFileURL(join(ROOT, 'dsh-memory', 'lib', 'index.js')).href)
  const root = mkdtempSync(join(tmpdir(), 'dsh-v321-'))
  const memoryDir = join(root, '.dsh-memory')
  const knowledgeDir = join(root, '.dsh-knowledge')
  mkdirSync(memoryDir, { recursive: true })
  mkdirSync(knowledgeDir, { recursive: true })
  writeFileSync(
    join(memoryDir, '.layout.json'),
    JSON.stringify({ layout: 1, producer: 'dsh-memory', files: ['task-graph.json'] }, null, 2),
    'utf8',
  )
  if (!omitGraph) {
    writeFileSync(join(memoryDir, 'task-graph.json'), graphBody ?? JSON.stringify(goodGraph, null, 2), 'utf8')
  }
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
  return { memory, memoryDir, knowledgeDir, root, tools }
}

test('v321 ①: a CORRUPT graph ⇒ `memory_graph_read` says it cannot read it, and does not return an empty graph', async () => {
  const e = await env({ graphBody: '{ this is not json' })
  try {
    const out = await e.tools.get('memory_graph_read').execute({})
    const status = out.readStatus ?? out.status
    assert.equal(status, 'unreadable',
      `损坏的图必须被报为 unreadable；实测 readStatus=${String(status)}，回执=${JSON.stringify(out).slice(0, 300)}`)
    assert.match(String(out.readDetail ?? ''), /不是合法 JSON/u,
      `必须说清为什么读不出来；实测：${String(out.readDetail)}`)
    /**
     * The silent-empty-graph behaviour is the defect: a reader that gets `nodes: [start]` looks at a
     * perfectly ordinary 「no plan yet」 project.
     */
    assert.notEqual(String(out.activeNodeId ?? ''), 'goal', '不得凭空给出一个当前节点')
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})

test('v321 ② (negative half): a MISSING file is still 「尚未建计划」 — not a read failure', async () => {
  /**
   * Without this half, ① is satisfied by calling EVERY unreadable-or-absent case a failure — which sends
   * a brand-new project to look at a corrupt file that does not exist.
   */
  const e = await env({ omitGraph: true })
  try {
    const out = await e.tools.get('memory_graph_read').execute({})
    const status = out.readStatus ?? out.status
    assert.equal(status, 'absent',
      `文件不存在是 absent（正常状态）；实测 ${String(status)}`)
    assert.equal(out.readDetail, undefined, 'absent 不该带「读失败」的细节')
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})

test('v321 ③ (P0, WRITE PATH): a corrupt graph must not let the writer silently do nothing', async () => {
  /**
   * An empty stamp list claims 「nothing needs stamping」. Inventing that claim from a FAILED read is how
   * a damaged graph reports 「一切正常」 while the writer no-ops.
   */
  const e = await env({ graphBody: '{ broken' })
  try {
    const contribute = e.tools.get('knowledge_harvest')
    assert.ok(contribute !== undefined, '前提：knowledge_harvest 必须已注册')
    const result = await contribute.execute(
      {
        entries: [
          {
            id: 'probe-g8-skill',
            kind: 'skill',
            title: '探针：G-8 写入路径',
            body: '用来验证图不可读时写入路径的行为',
            author: { kind: 'model', sessionId: 'session-alpha', generation: 1, attempt: 1 },
          },
        ],
      },
      { agent: { id: 'session-alpha' } },
    )
    /** The knowledge itself may still land (that file is fine); what must NOT happen is silence. */
    assert.ok(result.harvestSkipped !== undefined,
      `图不可读时必须报出「盖章被跳过」的原因，不许静默返回空数组；实测 ${JSON.stringify(result).slice(0, 400)}`)
    assert.match(String(result.harvestSkipped), /读不出来|不是合法 JSON/u,
      `原因必须说得出来；实测：${String(result.harvestSkipped)}`)
  } finally {
    rmSync(e.root, { recursive: true, force: true })
  }
})

test('v321 ④: the three states are distinguishable at the pure-function level', async () => {
  const { readGraphState } = await import(pathToFileURL(join(ROOT, 'dsh-memory', 'lib', 'graph.js')).href)
  const root = mkdtempSync(join(tmpdir(), 'dsh-v321d-'))
  try {
    /* ok */
    mkdirSync(join(root, 'ok'), { recursive: true })
    writeFileSync(join(root, 'ok', 'task-graph.json'), JSON.stringify(goodGraph, null, 2), 'utf8')
    assert.equal(readGraphState(join(root, 'ok')).status, 'ok')

    /* absent */
    mkdirSync(join(root, 'absent'), { recursive: true })
    assert.equal(readGraphState(join(root, 'absent')).status, 'absent')

    /* unreadable — bad JSON */
    mkdirSync(join(root, 'bad'), { recursive: true })
    writeFileSync(join(root, 'bad', 'task-graph.json'), '{ nope', 'utf8')
    const bad = readGraphState(join(root, 'bad'))
    assert.equal(bad.status, 'unreadable')
    assert.match(String(bad.detail), /不是合法 JSON/u)

    /* unreadable — EMPTY file. Something created it, so it is not 「absent」. */
    mkdirSync(join(root, 'empty'), { recursive: true })
    writeFileSync(join(root, 'empty', 'task-graph.json'), '', 'utf8')
    const empty = readGraphState(join(root, 'empty'))
    assert.equal(empty.status, 'unreadable', '空文件是「存在但内容不可信」，不是「没建过」')
    assert.match(String(empty.detail), /空文件/u)

    /* unreadable — a JSON ARRAY is not a graph. */
    mkdirSync(join(root, 'array'), { recursive: true })
    writeFileSync(join(root, 'array', 'task-graph.json'), '[]', 'utf8')
    assert.equal(readGraphState(join(root, 'array')).status, 'unreadable', '数组不是图')

    /**
     * ── unreadable — THE FILE CANNOT BE OPENED FOR A REASON OTHER THAN ENOENT ─────────────────────
     *
     * This is the case can-red `a` exposed as UNCOVERED: the first version of this criterion only fed
     * the reader PARSE errors, which are classified after a successful `readFileSync`. Making
     * `readGraphText` treat EVERY error as `absent` therefore changed nothing it looked at.
     *
     * A DIRECTORY in the file's place is the portable way to produce that failure: `readFileSync` throws
     * `EISDIR` on Linux and `EISDIR`/`EPERM` on Windows — never `ENOENT`.
     *
     * **It must be `unreadable`, not `absent`**: something IS there and we cannot read it. Reporting
     * 「no plan yet」 here is the fail-open the whole task is about.
     */
    mkdirSync(join(root, 'isdir', 'task-graph.json'), { recursive: true })
    const isDir = readGraphState(join(root, 'isdir'))
    assert.equal(isDir.status, 'unreadable',
      `打开失败但不是 ENOENT ⇒ 必须 unreadable（不是「没建过计划」）；实测 ${isDir.status}`)
    assert.match(String(isDir.detail), /失败/u, `必须带原因；实测：${String(isDir.detail)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})