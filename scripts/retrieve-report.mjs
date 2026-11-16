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
 * ── 来自别的模块的名字：簇分析要知道「这一段依赖了谁」──────────────────────────────────────────
 *
 * `valueOut` 只记**本文件内**的声明（簇、SCC、拓扑层都只需要它）。
 * 但「族发现」问的是另一个问题：这一簇**自足吗** —— 它有没有把依赖伸到别处去？
 * 那需要知道某段代码用了哪些 import 进来的名字，所以单开一张表。
 */
const importSpecOf = new Map()
for (const stmt of sf.statements) {
  if (!ts.isImportDeclaration(stmt) || stmt.importClause === undefined) continue
  const spec = stmt.moduleSpecifier.text
  const bindings = stmt.importClause.namedBindings
  if (bindings && ts.isNamedImports(bindings)) {
    for (const el of bindings.elements) importSpecOf.set((el.name ?? el.propertyName).text, spec)
  }
}
const externalOut = new Map(decls.map((d) => [d.name, new Set()]))

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
    else if (target === undefined && importSpecOf.has(node.text)) {
      externalOut.get(owner.name).add(`${node.text} (import ${importSpecOf.get(node.text)})`)
    }
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

const layerDetail = [...layers.entries()].sort((a, b) => a[0] - b[0]).map(([l, names]) => ({
  layer: l,
  declarations: names.length,
  lines: names.reduce((s, n) => s + byName.get(n).lines, 0),
  members: names.slice().sort(),
}))

/**
 * ── 族发现：给定一组层，问「这里面有没有可搬的族」────────────────────────────────────────────────
 *
 * 前五步能整片搬走，是因为那些声明**聚成一团且闭包自足**。第六步之后剩下的 25 个声明是不是
 * 也这样？这个问题的答案不该由一次会话里的临时脚本给出（那份脚本还留在 `_scratch/` 里，
 * 随时会被删掉，文档就变成了不可复算的断言）。所以做成工具的一部分：
 *
 *   node scripts/retrieve-report.mjs --clusters              # 默认：L0 以外的所有层
 *   node scripts/retrieve-report.mjs --clusters --layers 1,2,3
 *
 * 三个数缺一不可（只看其中一个都会得出相反结论）：
 *   · **簇的规模**：19 个声明 / 369 行 和 2 个声明 / 5 行，是完全不同的问题；
 *   · **段外值依赖**：一簇再大，只要它的依赖全在簇内，它就**能**整片搬走；
 *     依赖伸到簇外（哪怕只有一处），搬走就会把 import 反向拉回来；
 *   · **小簇合计**：如果「除了最大簇全是 1–2 个声明」，那就没有中等规模的族 ——
 *     搬它们只会换来「模块数 +1、行数 −5、依赖图 +1 边」。
 */
const clusterLayers = (() => {
  const i = process.argv.indexOf('--layers')
  if (i >= 0 && process.argv[i + 1] !== undefined) {
    return process.argv[i + 1].split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n))
  }
  return layerDetail.filter((l) => l.layer >= 1).map((l) => l.layer)
})()

const clusterAnalysis = (() => {
  const candidate = new Set(layerDetail.filter((l) => clusterLayers.includes(l.layer)).flatMap((l) => l.members))
  const up = new Map([...candidate].map((n) => [n, n]))
  const root = (x) => { while (up.get(x) !== x) { up.set(x, up.get(up.get(x))); x = up.get(x) } return x }
  for (const a of candidate) {
    for (const b of valueOut.get(a) ?? []) {
      if (!candidate.has(b)) continue
      const ra = root(a); const rb = root(b)
      if (ra !== rb) up.set(ra, rb)
    }
  }
  const buckets = new Map()
  for (const n of candidate) {
    const r = root(n)
    if (!buckets.has(r)) buckets.set(r, [])
    buckets.get(r).push(n)
  }
  const clusters = [...buckets.values()].map((members) => {
    members.sort()
    const external = new Set()
    for (const m of members) {
      for (const e of externalOut.get(m) ?? []) external.add(e)
      for (const t of valueOut.get(m) ?? []) if (!candidate.has(t)) external.add(`${t}（同文件，不在候选集）`)
    }
    return {
      declarations: members.length,
      lines: members.reduce((s, n) => s + byName.get(n).lines, 0),
      externalCount: external.size,
      external: [...external].sort(),
      members,
    }
  }).sort((a, b) => b.declarations - a.declarations || a.members[0].localeCompare(b.members[0]))

  const totalLines = [...candidate].reduce((s, n) => s + byName.get(n).lines, 0)
  const rest = clusters.slice(1)
  return {
    layers: clusterLayers,
    declarations: candidate.size,
    lines: totalLines,
    clusters,
    smallClusters: rest.length,
    smallLines: rest.reduce((s, c) => s + c.lines, 0),
  }
})()

/**
 * ── 层账：整层搬完之后，文件还剩多少行 ────────────────────────────────────────────────────────────
 *
 * 这个数**必须由脚本算**，不能写进文档：文档里的「还剩 950 行」「最后剩 ~354 行」两版都是手算的，
 * 每一版都跟着上一次搬运过时一次。第一次错在用了 1419 的基数、第二次错在把「声明 span 之和」
 * 当成「文件净减」（实测差 30 行注释与空行）。
 *
 * 这里算三行，全部从**同一次测量**里来：
 *   ① 当前文件行数                     （磁盘上的真实行数）
 *   ② 搬完除 L0 以外的所有层之后        （文件行数 − 那些层的 span 之和）
 *   ③ 再搬完 L0 之后                    （文件行数 − 全部 span 之和）= 模块壳
 *
 * ③ 之所以不是 0：剩下的 import / re-export / 文件头注释 / 空行都不是声明，
 * 没有任何一步「按层搬」能把它们带走。
 */
const fileLines = (() => {
  const parts = text.replace(/\r\n/gu, '\n').split('\n')
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length
})()
const spanSum = decls.reduce((s, d) => s + d.lines, 0)
const upperLayers = layerDetail.filter((l) => l.layer >= 1)
const upperLines = upperLayers.reduce((s, l) => s + l.lines, 0)
const l0 = layerDetail.find((l) => l.layer === 0)
const layerAccount = {
  fileLines,
  upperLayers: upperLayers.map((l) => `L${l.layer}`).join('+'),
  upperLines,
  afterUpperLayers: fileLines - upperLines,
  l0Lines: l0 === undefined ? 0 : l0.lines,
  afterL0: fileLines - spanSum,
}

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
  spanSum,
  layerAccount,
  clusterDetail: clusterAnalysis,
  componentDetail: components.map((c) => ({
    declarations: c.members.length,
    lines: c.lines,
    members: c.members.map((m) => m.name).sort(),
  })),
  layerDetail,
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

console.log('')
console.log('── 层账（整层搬完之后，这个文件还剩多少行）──')
const la = report.layerAccount
console.log(`  当前文件                                   ${String(la.fileLines).padStart(4)} 行`)
console.log(`  搬完 ${la.upperLayers}（${la.upperLines} 行）${' '.repeat(Math.max(0, 18 - la.upperLayers.length))}${String(la.afterUpperLayers).padStart(4)} 行${la.afterUpperLayers > 800 ? '   ← 仍 > 800' : '   ← 已 ≤ 800'}`)
console.log(`  再搬完 L0（${la.l0Lines} 行）${' '.repeat(Math.max(0, 18 - String(la.l0Lines).length))}${String(la.afterL0).padStart(4)} 行   ← 模块壳`)
console.log('')
console.log('  ⇒ 结论（由数字决定，不是写死的判断）：')
if (la.afterUpperLayers > 800) {
  console.log(`    搬完 ${la.upperLayers} 仍有 ${la.afterUpperLayers} 行 > 800 —— 跨过 800 只能靠「动 L0」。`)
} else {
  console.log(`    搬完 ${la.upperLayers} 是 ${la.afterUpperLayers} 行，已经 ≤ 800 —— 「按层搬」到这里就够了。`)
  console.log(`    但继续搬 L0（${la.l0Lines} 行）会把本文件压到 ${la.afterL0} 行，那是「要不要把它变成纯壳」的决定，`)
  console.log('    不是搬运顺序问题：那一步需要另立一次「入口点归位」，并接受本文件变成 store.ts 那种壳。')
}
console.log(`    剩下的 ${la.afterL0} 行是 import / re-export / 文件头注释 / 空行 —— 它们不是声明，`)
console.log('    没有任何一步「按层搬」能带走。')

if (process.argv.includes('--clusters')) {
  const ca = report.clusterDetail
  const label = ca.layers.map((l) => `L${l}`).join('+')
  console.log('')
  console.log(`── 族发现：${label}（${ca.declarations} 声明 / ${ca.lines} 行）的连通簇 ──`)
  console.log('  #  声明  行数  段外  成员')
  ca.clusters.forEach((c, i) => {
    const members = c.members.length <= 8 ? c.members.join(', ') : `${c.members.slice(0, 6).join(', ')}, …（共 ${c.members.length}）`
    console.log(`  ${String(i + 1).padStart(2)} ${String(c.declarations).padStart(5)} ${String(c.lines).padStart(5)} ${String(c.externalCount).padStart(5)}  ${members}`)
  })
  console.log('')
  console.log(`  小簇合计（除最大簇）：${ca.smallClusters} 个 / ${ca.smallLines} 行`)
  for (const [i, c] of ca.clusters.entries()) {
    if (c.externalCount === 0) continue
    console.log(`  #${i + 1} 的段外值依赖 ${c.externalCount} 处：${c.external.join('; ')}`)
  }
  console.log('')
  console.log('  ⇒ 读法（三个数一起看，只看一个会得出相反结论）：')
  console.log('    簇的规模说明「能搬多大」；段外值依赖说明「搬了会不会把 import 反向拉回来」；')
  console.log('    小簇合计说明「有没有中等规模的族」—— 若其余全是 1–2 个声明，那就没有。')
  const top = ca.clusters[0]
  if (top !== undefined && top.externalCount > 0 && top.lines * 2 > ca.lines) {
    console.log(`    本例：最大簇 ${top.declarations} 声明 / ${top.lines} 行、段外 ${top.externalCount} 处，`)
    console.log('    几乎就是整个候选集 —— 它是**主干**，不是可搬的族。搬它 = 本文件变纯壳。')
  } else if (top !== undefined && top.externalCount === 0 && top.lines * 2 > ca.lines) {
    console.log(`    本例：最大簇 ${top.declarations} 声明 / ${top.lines} 行、段外依赖 0 —— 这是一个闭合的族，可以整片搬走。`)
  } else {
    console.log('    本例：没有「大且闭合」的簇，也没有中等规模的簇 —— 不是可搬的族。')
  }
}
