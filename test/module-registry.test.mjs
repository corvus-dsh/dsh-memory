/**
 * ── memory 的模块登记门禁（从 dsh-observer 的 `test/module-registry.test.mjs` 移植）───────
 *
 * 守什么：`MODULE-REGISTRY.md` 与 `src/*.ts` **双向**一致。
 *
 * ── 为什么双向都要查（这句是移植时加的理解）──────────────────────────────────────────────────
 *
 *   只查「表里的文件是否存在」→ 新模块可以悄悄不进表（代码在长、图不动）；
 *   只查「磁盘上的文件是否进表」→ 表里可以留已删除模块的行。
 * 两个方向都查，才叫登记表。第三个方向：依赖列必须指向真实存在的模块。
 *
 * ── 本仓与 observer 的差别 ───────────────────────────────────────────────────────────────────
 *
 * observer 的被覆盖目录是 `src/core`；本仓是**扁平 `src/`**（27 个 .ts 都在同一层），
 * 所以 COVERED_DIRS 只有一个 `src`。这也意味着文件名可能只是 `index.ts` 这种无前缀形态，
 * 行内模块名统一写成 `src/<file>` 以免歧义。
 *
 * 表头写明分母算法：`endsWith('.ts')`。`src/` 下没有 `.bak-cut`；换成别的目录时要先确认这一点。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REGISTRY = join(ROOT, 'MODULE-REGISTRY.md')
const COVERED_DIRS = ['src']

/**
 * `| \`src/x.ts\` | 职责 | 导出 | 依赖 |`
 *
 * ── 字符集必须包含下划线 ────────────────────────────────────────────────────────────────────
 *
 * 第一版照抄 observer 的 `[a-z0-9-]+`，can-red 注入 `__unregistered.ts` 时**门禁没有红** ——
 * 因为下划线不在字符集里，那一行根本没被解析成"一行"，于是"表里的幽灵行"和"磁盘上的新文件"
 * 两个方向都看不见它。**一个读不进表的文件名，等于一个不受监管的文件名。**
 *
 * 改成 `[a-z0-9_-]+`（下划线、连字符、字母、数字）。
 */
const ROW = /^\|\s*`((?:src\/)?[a-z0-9_-]+\.ts)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/gmu

const readRows = () => {
  assert.ok(existsSync(REGISTRY), 'MODULE-REGISTRY.md must exist (it is the only authority on module coverage)')
  const text = readFileSync(REGISTRY, 'utf8')
  const rows = []
  for (const m of text.matchAll(ROW)) {
    rows.push({
      module: m[1].startsWith('src/') ? m[1] : `src/${m[1]}`,
      duty: m[2].trim(),
      exports: m[3].trim(),
      deps: m[4].trim(),
    })
  }
  return rows
}

const modulesOnDisk = () => {
  const out = []
  for (const dir of COVERED_DIRS) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (!name.endsWith('.ts')) continue
      out.push(`${dir}/${name}`)
    }
  }
  return out.sort()
}

test('every module on disk is REGISTERED (a new file cannot slip in silently)', () => {
  const registered = new Set(readRows().map((r) => r.module))
  const missing = modulesOnDisk().filter((m) => !registered.has(m))
  assert.deepEqual(missing, [], `these module(s) exist under src/ but are NOT in MODULE-REGISTRY.md: ${missing.join(', ')}`)
})

test('every row in the registry points at a file that EXISTS (a deleted module cannot linger)', () => {
  const onDisk = new Set(modulesOnDisk())
  const phantom = readRows().map((r) => r.module).filter((m) => !onDisk.has(m))
  assert.deepEqual(phantom, [], `these row(s) name a module that no longer exists: ${phantom.join(', ')}`)
})

test('every row declares a one-line duty and its exports', () => {
  for (const row of readRows()) {
    assert.notEqual(row.duty.length, 0, `${row.module}: the duty column is empty — a registry without "what for" is a file list`)
    assert.notEqual(row.exports.length, 0, `${row.module}: the exports column is empty`)
  }
})

test('the dependency column only names modules that EXIST (no dangling dependency)', () => {
  const onDisk = new Set(modulesOnDisk())
  for (const row of readRows()) {
    if (row.deps === '—' || row.deps.length === 0) continue
    for (const dep of splitDeps(row.deps)) {
      assert.ok(onDisk.has(dep.module), `${row.module}: dependency "${dep.raw}" does not exist under src/`)
    }
  }
})

/**
 * 依赖列里一项的解析。
 *
 * `x.ts (type-only)` 与 `x.ts` 是**两种不同的边**：前者运行时被擦除，后者真的会执行。
 * 门禁必须区分它们，否则一个仅类型环会让"表不能成环"这条永远红 ——
 * 而那条环恰恰是合法的（见 MODULE-REGISTRY.md 的说明）。
 */
function splitDeps (cell) {
  return cell.split(',').map((s) => s.trim()).filter((s) => s.length > 0).map((raw) => {
    const m = /^`?([a-z0-9-]+\.ts)`?\s*(\(type-only\))?$/u.exec(raw.replace(/^`|`$/gu, ''))
    const module = m === null ? raw.replace(/`/gu, '').replace(/\s*\(type-only\)$/u, '') : m[1]
    return {
      raw,
      module: module.startsWith('src/') ? module : `src/${module}`,
      typeOnly: m !== null && m[2] !== undefined,
    }
  })
}

test('the registry has no VALUE cycle (type-only edges are erased at runtime and do not count)', () => {
  const rows = readRows()
  const graph = new Map(rows.map((r) => [
    r.module,
    r.deps === '—'
      ? []
      : splitDeps(r.deps).filter((d) => !d.typeOnly).map((d) => d.module),
  ]))

  const state = new Map()
  const visit = (node, trail) => {
    if (state.get(node) === 'done') return undefined
    if (state.get(node) === 'active') return [...trail, node]
    state.set(node, 'active')
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next, [...trail, node])
      if (cycle !== undefined) return cycle
    }
    state.set(node, 'done')
    return undefined
  }

  for (const node of graph.keys()) {
    const cycle = visit(node, [])
    assert.equal(cycle, undefined, `the registry's VALUE dependencies contain a cycle: ${cycle?.join(' -> ')}`)
  }
})

test('every type-only edge is REALLY type-only in the source (the label cannot lie)', () => {
  /**
   * 这条防的是「把一条值依赖标成 type-only 来骗过成环检查」。
   * 判据：源文件里指向该模块的那条 import 必须以 `import type` 或 `{ type X }` 出现，
   * 且**不存在**任何指向同一模块的值导入。
   */
  for (const row of readRows()) {
    if (row.deps === '—') continue
    const text = readFileSync(join(ROOT, row.module), 'utf8')
    for (const dep of splitDeps(row.deps)) {
      if (!dep.typeOnly) continue
      const targetBase = dep.module.replace(/^src\//u, '').replace(/\.ts$/u, '')
      const imports = [...text.matchAll(/^[ \t]*(?:import|export)[^\n]*from\s+['"](\.[^'"]+)['"]/gmu)]
        .map((m) => ({ spec: m[1].replace(/\.(?:js|ts)$/u, ''), line: m[0] }))
        .filter((i) => i.spec.split('/').pop() === targetBase)
      assert.ok(imports.length > 0, `${row.module}: claims a type-only edge to ${dep.module} but has no such import`)
      const hasValue = imports.some((i) => !/^\s*(?:import|export)\s+type\b/u.test(i.line) && !/\{\s*type\b/u.test(i.line))
      assert.equal(hasValue, false, `${row.module}: labels ${dep.module} as type-only, but at least one import of it is a VALUE import: ${imports.map((i) => i.line.trim()).join(' | ')}`)
    }
  }
})
