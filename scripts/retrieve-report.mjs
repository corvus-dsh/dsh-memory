#!/usr/bin/env node
/**
 * ── RETRIEVE.TS 的六个数字：一条命令、一个 span 来源 ─────────────────────────────────────────────
 *
 * 用途：`docs/retrieve-families-and-tiers.md` 里的六个数字必须能被**重算**，否则它只是一次
 * 会话里的断言。本脚本是那条命令：
 *
 *     node scripts/retrieve-report.mjs            # 人读
 *     node scripts/retrieve-report.mjs --json     # 机器读（test/v207 用它逐项对比）
 *
 * ── span 从哪来：closure.mjs --declarations ──────────────────────────────────────────────────────
 *
 * **不自己解析行区间。** `scripts/families.mjs` 曾经用一个手写括号配平器算 span，它在
 * `retrieve.ts` 上把 8 行的 `INCIDENT_MARKERS` 算成 **1427 行**（正则里的 `\(` 被当成语法括号），
 * 一个假分量吞掉 68 个声明，整张表作废。那个脚本已改为消费 `closure.mjs --declarations`，
 * 本脚本用同一个来源 —— 于是全仓只有**一处**回答「这个声明占几行」这个问题。
 *
 * ── 边从哪来：AST 的值引用 ──────────────────────────────────────────────────────────────────────
 *
 * 只看**值**引用。类型引用（`interface` / `type` / 类型注解 / 泛型实参）在构建期被
 * `stripTypeScriptTypes` 擦除，运行期不存在，因此不构成耦合 —— 与 `check-cycles.mjs` 的
 * ACYCLIC 判据同口径。
 *
 * ── 缺编译器时 ──────────────────────────────────────────────────────────────────────────────────
 *
 * 退出码 **2** + 一行 RESOURCE 说明，与 `closure.mjs` / `test/v201` 的约定一致。
 * 不产出「六个数字」的近似值：一个建立在缺失测量上的表比没有表更糟。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * `--root <dir>` re-points the whole measurement at another tree.
 *
 * WHY IT EXISTS: `test/v207 ①b` has to re-derive the numbers the doc records for the **pre-split**
 * snapshot, so it exports that commit's `src/` into a temp dir and runs this script against it.
 * Without `--root` the script always measured the tree it lives in, and the test silently measured
 * today's `retrieve.ts` instead of the historical one — it reported 21 components where the doc says
 * 19, with no hint that the input was the wrong tree.
 *
 * A measurement tool that cannot be pointed at a specific input cannot be used to verify a
 * HISTORICAL claim.
 */
const REPO = (() => {
  const i = process.argv.indexOf('--root')
  const explicit = i >= 0 ? process.argv[i + 1] : undefined
  if (explicit !== undefined) return resolve(explicit).replace(/[\\/]+$/u, '')
  return fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/u, '')
})()
const FILE = process.argv.includes('--file')
  ? process.argv[process.argv.indexOf('--file') + 1]
  : 'retrieve.ts'
const ABS = `${REPO}/src/${FILE}`
const AS_JSON = process.argv.includes('--json')

/** compiler spans — the ONLY source of line ranges in this program. */
const spansOf = (() => {
  /**
   * 转发 `GRAFT_CLOSURE_SRC`：`--root` 指向别处的树时，closure 也必须量那棵树，
   * 否则两边量的不是同一份输入（这正是 `test/v207 ①b` 第一次红的形状：
   * 报 21 个分量而文档说 19，因为脚本量的是今天的树）。
   */
  const env = { ...process.env, GRAFT_CLOSURE_SRC: `${REPO}/src` }
  const out = execFileSync(process.execPath, [`${REPO}/scripts/closure.mjs`, '--declarations'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env })
  return JSON.parse(out.trim().split('\n').pop()).filter((row) => row.file === FILE)
})()

const text = readFileSync(ABS, 'utf8')
const sf = ts.createSourceFile(ABS, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const spanByName = new Map(spansOf.map((row) => [row.name, row]))

const decls = []
for (const stmt of sf.statements) {
  let name
  if (ts.isFunctionDeclaration(stmt) && stmt.name) name = stmt.name.text
  else if (ts.isVariableStatement(stmt)) {
    const d = stmt.declarationList.declarations[0]
    if (d && ts.isIdentifier(d.name)) name = d.name.text
  } else if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)
    || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) name = stmt.name?.text
  if (!name) continue
  const span = spanByName.get(name)
  if (span === undefined) {
    throw new Error(`closure --declarations has no span for ${FILE}:${name} — the two views disagree`)
  }
  decls.push({ name, kind: span.kind, lines: span.lines, stmt })
}
const byName = new Map(decls.map((d) => [d.name, d]))
const valueOut = new Map(decls.map((d) => [d.name, new Set()]))

/**
 * 类型位置判定。逐个 child 判断而不是「整棵子树」：同一行里可能既有值引用又有类型引用
 * （`function f(x: Foo): Bar { return make() }`）。
 */
const isTypeField = (parent, child) => {
  if (parent.kind === ts.SyntaxKind.TypeAnnotation) return true
  if (ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)) return true
  if (ts.isTypeReferenceNode(parent) || ts.isTypeParameterDeclaration(parent)) return true
  if (ts.isExpressionWithTypeArguments(parent) || ts.isHeritageClause(parent)) return true
  if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)
    || ts.isArrowFunction(parent) || ts.isMethodDeclaration(parent)) && parent.type === child) return true
  if (ts.isParameter(parent) && parent.type === child) return true
  if (ts.isVariableDeclaration(parent) && parent.type === child) return true
  if (Array.isArray(parent.typeArguments) && parent.typeArguments.includes(child)) return true
  return false
}
const visit = (node, owner, inType) => {
  if (ts.isIdentifier(node) && !inType) {
    const target = byName.get(node.text)
    if (target !== undefined && target.name !== owner.name) valueOut.get(owner.name).add(target.name)
  }
  ts.forEachChild(node, (child) => visit(child, owner, inType || isTypeField(node, child)))
}
for (const d of decls) visit(d.stmt, d, false)

// ── ① 无向连通分量 ──
const parent = new Map(decls.map((d) => [d.name, d.name]))
const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
for (const [a, set] of valueOut) {
  for (const b of set) {
    const ra = find(a); const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
}
const grouped = new Map()
for (const d of decls) {
  const root = find(d.name)
  if (!grouped.has(root)) grouped.set(root, [])
  grouped.get(root).push(d)
}
const components = [...grouped.values()]
  .map((members) => ({ members, lines: members.reduce((s, m) => s + m.lines, 0) }))
  .sort((a, b) => b.lines - a.lines)

// ── ③ 有向 SCC（Tarjan）──
const sccs = (() => {
  let index = 0
  const idx = new Map(); const low = new Map(); const onStack = new Set(); const stack = []; const out = []
  const strong = (v) => {
    idx.set(v, index); low.set(v, index); index += 1; stack.push(v); onStack.add(v)
    for (const w of valueOut.get(v) ?? []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))) }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)))
    }
    if (low.get(v) === idx.get(v)) {
      const comp = []
      for (;;) { const w = stack.pop(); onStack.delete(w); comp.push(w); if (w === v) break }
      out.push(comp)
    }
  }
  for (const d of decls) if (!idx.has(d.name)) strong(d.name)
  return out
})()

// ── ④ 缩点后的拓扑层 ──
const compOf = new Map()
sccs.forEach((c, i) => c.forEach((n) => compOf.set(n, i)))
const dag = new Map(sccs.map((_, i) => [i, new Set()]))
for (const [a, set] of valueOut) {
  for (const b of set) {
    const ca = compOf.get(a); const cb = compOf.get(b)
    if (ca !== cb) dag.get(ca).add(cb)
  }
}
const level = new Map()
const levelOf = (c, seen) => {
  if (level.has(c)) return level.get(c)
  if (seen.has(c)) return 0
  seen.add(c)
  const ups = [...dag.entries()].filter(([, s]) => s.has(c)).map(([k]) => k)
  const v = ups.length === 0 ? 0 : 1 + Math.max(...ups.map((u) => levelOf(u, new Set(seen))))
  level.set(c, v)
  return v
}
sccs.forEach((_, i) => levelOf(i, new Set()))
const layers = new Map()
for (const [i, c] of sccs.entries()) {
  const l = level.get(i)
  if (!layers.has(l)) layers.set(l, [])
  layers.get(l).push(...c)
}

// ── ⑤ 四档 ──
const TIER_OF = (n) => (n >= 100 ? 'D' : n >= 40 ? 'C' : n >= 12 ? 'B' : 'A')
const tiers = { D: { n: 0, lines: 0 }, C: { n: 0, lines: 0 }, B: { n: 0, lines: 0 }, A: { n: 0, lines: 0 } }
for (const d of decls) { const k = TIER_OF(d.lines); tiers[k].n += 1; tiers[k].lines += d.lines }

const report = {
  file: FILE,
  spanSource: 'closure.mjs --declarations (compiler getStart/getEnd)',
  components: components.length,
  trunk: { declarations: components[0].members.length, lines: components[0].lines },
  sccs: sccs.length,
  nontrivialSccs: sccs.filter((c) => c.length > 1).length,
  layers: layers.size,
  tiers,
  declarations: decls.length,
  spanSum: decls.reduce((s, d) => s + d.lines, 0),
  componentDetail: components.map((c) => ({
    declarations: c.members.length,
    lines: c.lines,
    members: c.members.map((m) => m.name).sort(),
  })),
  layerDetail: [...layers.entries()].sort((a, b) => a[0] - b[0]).map(([l, names]) => ({
    layer: l,
    declarations: names.length,
    lines: names.reduce((s, n) => s + byName.get(n).lines, 0),
    members: names.slice().sort(),
  })),
}

if (AS_JSON) {
  console.log(JSON.stringify(report))
  process.exit(0)
}

console.log(`file           : src/${FILE}`)
console.log(`span source    : ${report.spanSource}`)
console.log('')
console.log(`① 无向连通分量        : ${report.components}`)
console.log(`② 最大分量（主干）    : ${report.trunk.declarations} 声明 / ${report.trunk.lines} 行`)
console.log(`③ 有向 SCC            : ${report.sccs}（非平凡 ${report.nontrivialSccs}）`)
console.log(`④ 缩点拓扑层数        : ${report.layers}`)
console.log(`⑤ 四档 D/C/B/A        : ${tiers.D.n}/${tiers.D.lines}  ${tiers.C.n}/${tiers.C.lines}  ${tiers.B.n}/${tiers.B.lines}  ${tiers.A.n}/${tiers.A.lines}`)
console.log(`⑥ 顶层声明 / 跨度和   : ${report.declarations} / ${report.spanSum}`)
console.log('')
console.log('── 分量 ──')
for (const [i, c] of components.entries()) {
  console.log(`  #${String(i + 1).padStart(2)} ${String(c.members.length).padStart(2)} 声明 / ${String(c.lines).padStart(4)} 行`)
}
console.log('')
console.log('── 拓扑层 ──')
for (const l of report.layerDetail) {
  console.log(`  L${l.layer}  ${String(l.lines).padStart(4)} 行 / ${String(l.declarations).padStart(2)} 声明`)
}
