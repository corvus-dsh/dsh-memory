/**
 * ── v303 (B4-B B0b)：每个注册工具的 `execute` 返回值都必须是**无损 JSON** ────────────────────────
 *
 * ── 这条门禁的来历 ───────────────────────────────────────────────────────────────────────────────
 *
 * graft 里 `graft_prepare` 曾返回一个**自有 `undefined` 键**。`JSON.stringify` 会丢掉它，所以本地所有
 * 检查都通过；但宿主校验的是**无损 JSON**，`undefined` 不可无损表示 ⇒ 整个工具返回值被拒 ⇒ 主流程
 * 无法调用。发现它的是**用户截图**。
 *
 * 四仓所有 tool 的返回值走的是同一个宿主校验，而**没有任何本地门禁在测它**。逐条事后修，就是「修一处，
 * 等下一张截图」。所以这里是**机械版**：每个注册工具用最小合法参数调一次，逐节点扫描，越界就点名
 * 「工具名 + JSON 路径」。
 *
 * ── 判据（四条，两条负向）──────────────────────────────────────────────────────────────────────
 *
 *   ① 每个注册工具的返回值都是无损 JSON
 *   ② **分母**：实际调用数必须等于注册数，且新工具必须登记进表 —— 否则「一个都没跑」也会绿
 *   ③ 负向：扫描器能红，并点名到具体路径
 *   ④ 负向：合法值不许误报（`null` / 0 / `false` / `''` / 空数组 / 空对象 / 同一对象复用不是环）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

/** The host's rule. Returns PATHS, so a failure names where instead of saying 「invalid」. */
function losslessProblems(value, path = '$', seen = new Set()) {
  if (value === undefined) return [`${path} = undefined`]
  if (value === null) return []
  const type = typeof value
  if (type === 'number') return Number.isFinite(value) ? [] : [`${path} = ${String(value)}（非有限数）`]
  if (type === 'string' || type === 'boolean' || type === 'bigint') return []
  if (type === 'function') return [`${path} = function`]
  if (type === 'symbol') return [`${path} = symbol`]
  if (seen.has(value)) return [`${path} = 循环引用`]
  seen.add(value)
  const problems = []
  if (Array.isArray(value)) {
    value.forEach((item, index) => problems.push(...losslessProblems(item, `${path}[${index}]`, seen)))
  } else {
    for (const key of Object.keys(value)) {
      problems.push(...losslessProblems(value[key], `${path}.${key}`, seen))
    }
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      problems.push(`${path}.${String(symbol)} = symbol 键`)
    }
  }
  seen.delete(value)
  return problems
}

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'mem-b0b-'))
  const skillsDir = join(root, 'skills')
  const memoryDir = join(root, 'memory')
  mkdirSync(skillsDir, { recursive: true })
  mkdirSync(memoryDir, { recursive: true })
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    sessionQuery: { readSession: async () => undefined },
    on: () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  ctx.get = (name) => (name === 'llm' ? undefined : ctx[name])
  apply(ctx, { dataDir: root, memoryDir, skillsDir })
  return { ctx, tools, root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * EVERY REGISTERED TOOL, with the smallest arguments that reach its handler.
 *
 * Several of these deliberately miss: a tool that refuses returns `{ ok:false, error }`, which is ALSO
 * a value the host validates. Exercising only the happy path would leave half the surface untested.
 */
const CALLS = {
  memory_stats: { args: () => ({}) },
  memory_migrate_evidence: { args: () => ({}) },
  memory_search: { args: () => ({ query: 'anything', semantic: false }) },
  memory_forget: { args: () => ({ name: 'no-such-skill-b0b' }) },
  knowledge_query: { args: () => ({}) },
  knowledge_harvest: {
    args: () => ({ entries: [{ id: 'b0b-probe', kind: 'skill', title: 'B0b 探针', body: '一句话。' }] }),
  },
  memory_contribute: {
    args: () => ({
      nodeId: 'no-such-node-b0b',
      kind: 'skill',
      title: 'B0b 探针',
      author: { kind: 'test', sessionId: 'session-b0b', attempt: 1 },
    }),
  },
  knowledge_read: { args: () => ({ id: 'no-such-id-b0b' }) },
  knowledge_stats: { args: () => ({}) },
  /** Mines retired sessions; with none retired it legitimately reports zero. */
  memory_harvest: { args: () => ({}) },
  memory_suggestions: { args: () => ({}) },
  /** Both take an id; an unknown one must come back as a named refusal, which is still a checked value. */
  memory_approve: { args: () => ({ id: 'no-such-id-b0b' }) },
  memory_reject: { args: () => ({ id: 'no-such-id-b0b' }) },
  memory_graph_read: { args: () => ({}) },
  memory_graph_update: { args: () => ({ op: 'add', nodeId: 'nope-b0b', title: 'B0b' }) },
  skill_read: { args: () => ({ name: 'no-such-skill-b0b' }) },
}

test('v303 ①: 每个注册工具的返回值都是无损 JSON', async () => {
  const { tools, cleanup } = makeEnv()
  try {
    const names = [...tools.keys()]
    assert.ok(names.length > 0, '没有注册任何工具 —— 分母为 0，这条测试什么也没证明')

    const failures = []
    let exercised = 0

    for (const name of names) {
      const spec = CALLS[name]
      assert.ok(
        typeof spec === 'object' && spec !== null && typeof spec.args === 'function',
        `${name} 在 CALLS 表里没有条目。新工具必须在这里登记最小合法参数，否则这条门禁会漏掉它。`,
      )
      let value
      try {
        value = await tools.get(name).execute(spec.args(), { agent: { id: 'session-b0b' } })
      } catch (error) {
        failures.push(`${name} 抛出异常（没有返回值可查）：${String(error?.message ?? error)}`)
        continue
      }
      exercised += 1
      const problems = losslessProblems(value)
      if (problems.length > 0) failures.push(`${name} ⇒ ${problems.join('; ')}`)
    }

    // ② THE DENOMINATOR, carrying the failure list — a count alone hides its own cause.
    assert.equal(
      exercised,
      names.length,
      `只实际调用了 ${exercised}/${names.length} 个工具。异常：\n${failures.join('\n') || '(无)'}`,
    )
    assert.deepEqual(failures, [], `以下工具的返回值不是无损 JSON：\n${failures.join('\n')}`)
  } finally {
    cleanup()
  }
})

test('v303 ③: 负向 —— 扫描器能红，且点名 JSON 路径', () => {
  assert.deepEqual(losslessProblems({ ok: true, handover: undefined }), ['$.handover = undefined'])
  assert.deepEqual(losslessProblems({ ok: true, nested: { a: undefined } }), ['$.nested.a = undefined'])
  assert.deepEqual(losslessProblems([1, undefined]), ['$[1] = undefined'])
  assert.deepEqual(losslessProblems({ ok: true, n: NaN }), ['$.n = NaN（非有限数）'])
  assert.deepEqual(losslessProblems({ ok: true, n: Infinity }), ['$.n = Infinity（非有限数）'])
})

test('v303 ④: 负向 —— 合法值不许误报（否则这条门禁会被关掉）', () => {
  assert.deepEqual(losslessProblems({ ok: true, a: null, b: 0, c: false, d: '', e: [], f: {} }), [])
  assert.deepEqual(losslessProblems([]), [])
  assert.deepEqual(losslessProblems('text'), [])
  const shared = { x: 1 }
  assert.deepEqual(losslessProblems({ a: shared, b: shared }), [])
})
