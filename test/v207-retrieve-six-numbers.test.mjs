/**
 * ── v207：`retrieve.ts` 的六个数字必须能被一条命令重算，且与文档逐项相等 ──────────────────────────
 *
 * 为什么需要这条测试：
 *
 * `docs/retrieve-families-and-tiers.md` 里有一张表（19 分量 / 1251 主干 / 89 SCC / 8 层 /
 * 486·413·373·263）。那张表第一次是用一个**临时脚本**算的，而临时脚本不会重跑 ——
 * 于是下一个人要么相信那几个数字，要么从零重算。两者都不好。
 *
 * 所以数字被搬进 `scripts/retrieve-report.mjs`（仓内、可 `--json`），本测试逐项对比
 * 文档表与命令输出。**任何一边变了，这条会红，并指出是哪一项。**
 *
 * ── 顺带钉住 instrument 的那次教训 ──────────────────────────────────────────────────────────────
 *
 * `scripts/families.mjs` 的 spanOf 曾是手写括号配平器，在 `retrieve.ts` 上把 8 行的
 * `INCIDENT_MARKERS` 算成 **1427 行**（正则里的 `\(` 被当成语法括号），一个假分量吞掉
 * 68 个声明，整张表作废。它还有第二个、更隐蔽的缺陷：边过滤把文件名写死成 `'index.ts'`，
 * 于是在 `retrieve.ts` 上所有边都被丢弃 → 输出 62 个分量而不是 19。
 * **那次自校验是绿的**（跨度之和 == 闭包行数），因为它只验数字、不验结构。
 *
 * 因此本文件有两条断言：数字对得上（①），以及**边没有全丢**（②）——
 * 后者用「最大分量必须远大于 1 个声明」来抓，一个边全丢的图会让每个声明各成一个分量。
 *
 * ── 缺编译器时 ──────────────────────────────────────────────────────────────────────────────────
 *
 * 跳过并写明 RESOURCE reason（照 test/v201 与 v203 的惯例）。**不 skip 的情况**是编译器可用：
 * 那时任何一项不等都是失败。本文件的 skip 只在 CI 不装 typescript 时发生。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const REPORT = join(REPO, 'scripts', 'retrieve-report.mjs')
const FAMILIES = join(REPO, 'scripts', 'families.mjs')

const RESOURCE_REASON =
  'scripts/retrieve-report.mjs and families.mjs need the TypeScript compiler API; '
  + 'this environment does not provide it (this package declares no dependencies and CI installs no '
  + 'typescript). RESOURCE condition — NOT a pass and NOT a failure.'

const run = (script, args, env) => {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env } })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return { status: error.status ?? -1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

const compilerAvailable = () => {
  const r = run(join(REPO, 'scripts', 'closure.mjs'), ['--declarations'])
  if (r.status !== 0) return false
  try {
    const rows = JSON.parse(r.stdout.trim().split('\n').pop())
    return Array.isArray(rows) && rows.length > 100
  } catch { return false }
}

const six = () => {
  const r = run(REPORT, ['--json'])
  assert.equal(r.status, 0, `retrieve-report --json must exit 0, got ${r.status}\n${r.stderr}`)
  const rows = r.stdout.trim().split('\n')
  return JSON.parse(rows[rows.length - 1])
}

const AVAILABLE = compilerAvailable()

/**
 * 文档里的表。**这里是手抄的期望值，不是从脚本反读的** —— 那样会变成「脚本同意自己」。
 *
 * ── 2026-11-15：第一步搬运之后更新 ──────────────────────────────────────────────────────────────
 *
 * 搬走 14 个声明（→ `src/retrieve/interning.ts`）之后，`retrieve.ts` 的数字**必然**变化：
 * 一份「搬完之后数字不变」的表，只能说明表没被重算。所以这些值是搬运后重新测的，
 * 并逐项与 `docs/retrieve-families-and-tiers.md` 的历史表并列（那份文档记的是**搬前**的
 * 快照，因而也保留 —— 它不是过期的真理，是那个时点的记录）。
 *
 * 旧值 → 新值：
 *   分量 19 → 21（簇被拆开后，原来连在一起的两块各自成家）
 *   主干 68/1251 → 51/955（14 个声明连同它们的边一起离开）
 *   SCC 89 → 75，层 8 → 6，声明 89 → 75，跨度和 1535 → 1362
 */
const DOCUMENTED = {
  components: 21,
  trunkDeclarations: 51,
  trunkLines: 955,
  sccs: 75,
  nontrivialSccs: 0,
  layers: 6,
  tiers: { D: 486, C: 362, B: 295, A: 219 },
  tierCounts: { D: 4, C: 7, B: 13, A: 51 },
  declarations: 75,
  spanSum: 1362,
}

test('v207 ①: 六个数字与 docs/retrieve-families-and-tiers.md 逐项相等', (t) => {
  if (!AVAILABLE) { t.skip(RESOURCE_REASON); return }
  const r = six()

  assert.equal(r.components, DOCUMENTED.components, `无向连通分量：文档 ${DOCUMENTED.components}`)
  assert.equal(r.trunk.declarations, DOCUMENTED.trunkDeclarations, '主干声明数')
  assert.equal(r.trunk.lines, DOCUMENTED.trunkLines, '主干行数')
  assert.equal(r.sccs, DOCUMENTED.sccs, '有向 SCC 个数')
  assert.equal(r.nontrivialSccs, DOCUMENTED.nontrivialSccs, '非平凡 SCC 个数（零循环）')
  assert.equal(r.layers, DOCUMENTED.layers, '缩点拓扑层数')

  for (const k of ['D', 'C', 'B', 'A']) {
    assert.equal(r.tiers[k].lines, DOCUMENTED.tiers[k], `四档 ${k} 的行数`)
    assert.equal(r.tiers[k].n, DOCUMENTED.tierCounts[k], `四档 ${k} 的声明数`)
  }

  assert.equal(r.declarations, DOCUMENTED.declarations, '顶层声明数')
  assert.equal(r.spanSum, DOCUMENTED.spanSum, '声明跨度和')
})

test('v207 ②: 边没有被全丢 —— 主干必须远大于单个声明（抓「62 分量」那类静默结构错误）', (t) => {
  if (!AVAILABLE) { t.skip(RESOURCE_REASON); return }
  const r = six()

  /**
   * 边全丢时的签名：每个声明各成一个分量 ⇒ 分量数 == 声明数，主干 == 1 个声明。
   * 实测过：边过滤写死 `f.file !== 'index.ts'`，在 retrieve.ts 上就是 62 个分量。
   * 那次**自校验是绿的**（跨度之和 == 闭包行数），因为自校验只验数字。
   */
  assert.ok(r.components < r.declarations,
    `分量数 ${r.components} 不小于声明数 ${r.declarations} —— 这说明引用边几乎全丢了`
    + '（典型原因：边过滤把文件名写死，或 AST 访问器没有排除类型位置）')
  assert.ok(r.trunk.declarations > 10,
    `最大分量只有 ${r.trunk.declarations} 个声明 —— 一个健康的图里主干应当有几十个`)
  assert.ok(r.trunk.lines > 500,
    `最大分量只有 ${r.trunk.lines} 行 —— 与「一个 1251 行的主干」这个结论矛盾`)
})

test('v207 ③: 每条分量/层里的成员都是真实声明（没有凭空的格子）', (t) => {
  if (!AVAILABLE) { t.skip(RESOURCE_REASON); return }
  const r = six()

  const all = new Set()
  for (const c of r.componentDetail) for (const n of c.members) all.add(n)
  assert.equal(all.size, r.declarations,
    `分量里出现的不同名字 ${all.size} 个，而文件有 ${r.declarations} 个顶层声明 —— 有声明没被归入任何分量`)

  const inLayers = new Set()
  for (const l of r.layerDetail) for (const n of l.members) inLayers.add(n)
  assert.equal(inLayers.size, r.declarations, '拓扑层必须覆盖全部声明（SCC 缩点不丢节点）')

  const tierTotal = ['D', 'C', 'B', 'A'].reduce((s, k) => s + r.tiers[k].n, 0)
  assert.equal(tierTotal, r.declarations, '四档的声明数之和必须等于顶层声明数')
  const tierLines = ['D', 'C', 'B', 'A'].reduce((s, k) => s + r.tiers[k].lines, 0)
  assert.equal(tierLines, r.spanSum, '四档的行数之和必须等于声明跨度和')
})

/**
 * ── families.mjs：span 现在来自编译器 ────────────────────────────────────────────────────────────
 *
 * 这一组钉住那次重写。`INCIDENT_MARKERS` 是 8 行 —— 如果哪天它又变成上千行，
 * 说明有人把 `spanOf` 的手写配平器放回来了（或者改成读错了来源）。
 */
test('v207 ④: families.mjs 不再自己配平 —— INCIDENT_MARKERS 必须是 8 行，不是 1427', (t) => {
  if (!AVAILABLE) { t.skip(RESOURCE_REASON); return }
  const r = run(join(REPO, 'scripts', 'closure.mjs'), ['--declarations'])
  assert.equal(r.status, 0, 'closure --declarations must succeed')
  const rows = JSON.parse(r.stdout.trim().split('\n').pop())

  /**
   * 2026-11-15：第一步搬运把 `INCIDENT_MARKERS` 移到了 `src/retrieve/interning.ts`。
   * 断言跟随它 —— 这条测试要钉的是「span 来源是编译器」，不是「它住在哪个文件」。
   * 所以这里按**名字**找、不限文件，并要求全树只有一条。
   */
  const hits = rows.filter((row) => row.name === 'INCIDENT_MARKERS')
  assert.equal(hits.length, 1,
    `INCIDENT_MARKERS 应恰好有一处模块级声明，实测 ${hits.length} 处：${hits.map((h) => h.file).join(',')}`)
  assert.equal(hits[0].lines, 8,
    'INCIDENT_MARKERS 是 8 行正则数组。手写括号配平器会把 /(…)/u 里的括号当成语法括号，'
    + '把它算成 1427 行并吞掉 68 个声明 —— 那个缺陷把整张分量表变成了假的。')
})

test('v207 ⑤: families.mjs 在 retrieve.ts 上不再报假分量（最大分量应是闭包成员，不是 1 个 1427 行的常量）', (t) => {
  if (!AVAILABLE) { t.skip(RESOURCE_REASON); return }
  const r = run(FAMILIES, ['--src', 'retrieve.ts', 'retrieveWithFilter'])
  assert.equal(r.status, 0, `families must exit 0, got ${r.status}\n${r.stderr}\n${r.stdout.slice(0, 400)}`)

  // 自校验必须归零（跨度之和 == 闭包行数）
  assert.match(r.stdout, /跨度之和 == 闭包总行数/u,
    'families 的自校验必须报 0 差；报 WARNING 说明 span 来源已经不可信')

  // 1427 那个假数字不许再出现
  assert.ok(!/1427\s*lines/u.test(r.stdout),
    'families 又报出了 1427 行 —— 手写配平器回来了，或 span 来源读错了文件')

  // 分量数必须远小于声明数（边没全丢）
  const m = r.stdout.match(/^(\d+) connected component/mu)
  assert.ok(m !== null, 'families 的输出里应有 "N connected component(s)" 一行')
  const components = Number(m[1])
  assert.ok(components <= 12,
    `families 报了 ${components} 个分量 —— 边过滤可能又把文件名写死了`
    + '（实测过：写死 index.ts 时 retrieve.ts 报 62 个分量，而真值是 19）')
})

test('v207 ⑥: 成员按文件过滤 —— 不会静默取到别处的同名声明', (t) => {
  if (!AVAILABLE) { t.skip(RESOURCE_REASON); return }
  const r = run(join(REPO, 'scripts', 'closure.mjs'), ['--declarations'])
  const rows = JSON.parse(r.stdout.trim().split('\n').pop())

  /**
   * `FilterOptions` 在整棵树里有两处模块级声明：`filter.ts:42` 与 `retrieve.ts:1644`。
   * 第一版 `byName.set` 不过滤文件，于是 retrieve.ts 的 `FilterOptions` 被 filter.ts 的
   * 同名项覆盖 —— 跨度从 49 行变成 16 行，自校验报差额 −33。这里钉住「按文件过滤」。
   *
   * 注：`provenanceOf` / `firstEvidence` 在 who-references 眼里也是"歧义"的，但那是因为它们
   * 还有**函数内局部**同名声明；`closure --declarations` 只收模块级，所以表里各只有一条。
   * 用 `FilterOptions` 做例子才是真正的跨文件模块级撞名。
   */
  const duplicated = rows.filter((row) => row.name === 'FilterOptions')
  const files = new Set(duplicated.map((row) => row.file))
  assert.ok(files.size > 1,
    `前提：FilterOptions 应跨多个文件声明（实测 ${[...files].join(',') || '无'}）—— 这条测试才有意义`)
  assert.ok(files.has('filter.ts') && files.has('retrieve.ts'),
    `FilterOptions 应在 filter.ts 与 retrieve.ts 各有一条，实测在 ${[...files].join(',')}`)

  // 两处行数不同 ⇒ 取错了会被数字抓到
  const sizes = new Map(duplicated.map((row) => [row.file, row.lines]))
  assert.notEqual(sizes.get('filter.ts'), sizes.get('retrieve.ts'),
    '两处的行数必须不同，否则「取错文件」这件事在数字上看不出来')

  // 每个 (file, name) 组合最多一条 —— 同一文件内的同名模块级声明会破坏 byName 的语义
  const keys = duplicated.map((row) => `${row.file}:${row.name}`)
  assert.equal(new Set(keys).size, keys.length, '同一文件内的同名模块级声明会破坏 byName 的语义')
})
