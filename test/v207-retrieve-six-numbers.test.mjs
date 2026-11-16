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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
 * ── 2026-11-15：第二步搬运之后再次更新 ──────────────────────────────────────────────────────────
 *
 * 搬走 6 个声明（→ `src/retrieve/storage-tier.ts`）：3 个 let + setStorageTier + getStorageTier
 * + currentIndex。三个 let 是**模块级状态**，所以它们的 3 个节点整个离开本文件的图。
 *
 * ── 2026-11-16：第五步搬运之后再次更新（场景族 → retrieve/scene.ts）──────────────────────────────
 *
 * 搬走 10 个声明：SCENE_PROMPT / SceneOptions / SceneCacheEntry / sceneCache / clearSceneCache /
 * sceneCacheStats / SCENE_TAG / classifyScene / LEGACY_SCENE_HINTS / inferScene。
 * 场景族跨了四个拓扑层（L0/L1/L2/L3），整族搬走后层数不变（仍 4），但主干从 30 缩到 22。
 *
 * 六步的值：
 *   搬前（第一步前）  19 / 68·1251 / 89 / 8 / 486·413·373·263 / 89·1535
 *   第一步后          21 / 51·955  / 75 / 6 / 486·362·295·219 / 75·1362
 *   第二步后          21 / 45·927  / 69 / 5 / 486·362·282·204 / 69·1334
 *   第三步后          21 / 40·894  / 64 / 5 / 486·362·261·192 / 64·1301
 *   第四步后          22 / 30·647  / 56 / 4 / 365·317·208·175 / 56·1065
 *   第五步后          20 / 22·557  / 46 / 4 / 365·254·208·137 / 46·964
 *   第六步后           6 / 22·557  / 32 / 4 / 365·106·163·86  / 32·720
 *
 * 分量 22 → 20：场景族从主干里离开后，主干从 30 缩到 22；
 * 而 `SceneOptions`/`SceneCacheEntry` 这两个纯类型声明随族走，
 * 它们在原图里各自只与 `classifyScene`/`sceneCache` 相连，整体离开。
 *
 * ── 2026-11-16：第六步搬运之后再次更新（契约类型族 → retrieve/types.ts）────────────────────────
 *
 * 搬走 12 个纯类型声明（DocumentKind / MemoryHit / Document / Scored / WorkspaceGate /
 * TaskAlignmentGate / DocumentCacheEntry / CandidateOptions / HybridRecallOptions /
 * RetrieveResult / FilterTrace / FilterOptions），并删掉 2 个零引用常量（CJK / LATIN）。
 *
 * **分量 20 → 6 是这一步最有信息量的数字**：那 12 个类型声明在值引用图里**不产生任何边**
 * （它们只被类型引用，构建时擦除），所以它们原本是 12 个互不相连的孤立节点 ——
 * 图里看起来像「20 个耦合的分量」，实际上主干之外的 14 个分量里有一大半是**从不出现在运行期**的类型。
 * 搬走之后，剩下的 6 个分量全部是会被执行的代码。
 *
 * 主干不变（22 声明 / 557 行）：唯一的类型声明在主干里是 `MemoryHit` 的**使用方**，不是它自己。
 * 层数不变（仍 4）：类型节点本来在各层都有，但都不承载值边，搬走不抽空任何一层。
 */
const DOCUMENTED = {
  components: 6,
  trunkDeclarations: 22,
  trunkLines: 561,
  sccs: 32,
  nontrivialSccs: 0,
  layers: 4,
  tiers: { D: 365, C: 106, B: 167, A: 86 },
  tierCounts: { D: 3, C: 2, B: 7, A: 20 },
  declarations: 32,
  spanSum: 724,
}

test('v207 ①: 当前六数与内置基线逐项相等（基线来自实测，不是从文档反读）', (t) => {
  if (!AVAILABLE) { t.skip(RESOURCE_REASON); return }
  const r = six()

  assert.equal(r.components, DOCUMENTED.components, `无向连通分量：基线 ${DOCUMENTED.components}`)
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

/**
 * ── v207 ①b：真的去读文档，并对上它自己声称的那个时点 ──────────────────────────────────────────
 *
 * ── 这一条为什么存在 ────────────────────────────────────────────────────────────────────────────
 *
 * 用户裁定⑥：`v207 ①` 的名字原本是「六个数字与 `docs/retrieve-families-and-tiers.md` 逐项相等」，
 * 但它**从来没读过那个文件** —— 它比的是本文件里的常量 `DOCUMENTED`。
 *
 * 一个名字里带文档路径、实际不读文档的测试，比没有这条测试更危险：读报告的人会以为
 * 「文档被守住了」，而文档可以漂移到任何数字都不红。所以要么改名，要么真读。
 *
 * ── 为什么不能「直接拿当前六数比文档」──────────────────────────────────────────────────────────
 *
 * 那份文档记的是**拆分之前**的快照（19 分量 / 89 SCC / 8 层）。当前是 21 / 64 / 5 ——
 * 三步搬运之后，直接比会红，而且红得**没有意义**（它只是说「文档是历史的」，这是已知的）。
 *
 * 真正的判据是：**文档对上它自己声称的时点**。所以这里用 git 取出拆分前的
 * `src/retrieve.ts`，用 `retrieve-report.mjs --file` 在临时树上重算，再与文档里的表逐项比。
 *
 * 这样这条测试同时守住两件事：
 *   ① 文档里的数字确实来自那个提交的文件（不是手抄错的、不是别处的数字）；
 *   ② 文档的表格式没变（解析失败会红，而不是静默跳过）。
 */
test('v207 ①b: 真读 docs/retrieve-families-and-tiers.md，并对上它记录的「搬前」快照', (t) => {
  if (!AVAILABLE) { t.skip(RESOURCE_REASON); return }

  /**
   * ── 这条测试需要**历史**，而 CI 的 checkout 是浅克隆 ──────────────────────────────────────────
   *
   * `actions/checkout@v4` 默认 `fetch-depth: 1`：只取当前提交，父提交与更早的对象都不在本地。
   * 这条测试要 `git show 0381c6c:src/retrieve.ts` 重建「搬前」快照，浅克隆下必然失败。
   *
   * 2026-11-15 实测：本地 490/490 全绿，CI 双 Node 全红在 `Test` 步骤 —— 这是**测试自己**
   * 引入了对仓库深度的依赖，而 CI 不满足。两种情况都真实存在，不能只挑一种环境说它对。
   *
   * 处置：**缺历史时 skip 并写明 RESOURCE reason**（与 v201 缺编译器、v203 缺 typescript 同一惯例）。
   * 不改成「失败」：那不是被测代码的问题；也不改成「静默通过」：那会让这条断言消失而不留痕。
   *
   * 为什么不去给 CI 加 `fetch-depth: 0`：那是对的，但它是**对 CI 的让步**，而这里的根因是
   * 「一条测试假设了它没有声明的前置条件」。声明前置条件、缺了就 skip，比悄悄依赖环境更诚实。
   */
  const hasRef = (() => {
    try {
      execFileSync('git', ['cat-file', '-e', '0381c6c'], { cwd: REPO, stdio: 'ignore' })
      return true
    } catch { return false }
  })()
  if (!hasRef) {
    t.skip('RESOURCE：本地仓库没有 0381c6c（浅克隆 / shallow clone）。'
      + '这条测试要重算「搬前」快照，需要那个提交的对象。'
      + '在完整克隆上运行即可覆盖；NOT a pass and NOT a failure.')
    return
  }

  const docPath = join(REPO, 'docs', 'retrieve-families-and-tiers.md')
  assert.ok(existsSync(docPath), `文档必须存在：${docPath}`)
  const doc = readFileSync(docPath, 'utf8')

  /**
   * 文档在第一节写明它是「搬前」快照。解析它声称的数字；解析不出来就红 —— 而不是跳过。
   */
  const components = doc.match(/^## 二、值引用无向连通分量：(\d+) 个/mu)
  assert.ok(components !== null, '文档里应有「## 二、值引用无向连通分量：N 个」这一节')
  assert.equal(components[1], '19', '文档记录的是搬前快照：19 个分量')

  const scc = doc.match(/有向 SCC：(\d+) 个/u)
  assert.ok(scc !== null, '文档里应有「有向 SCC：N 个」')
  assert.equal(scc[1], '89', '搬前 89 个 SCC')

  const trunk = doc.match(/^\|\s*\*\*1\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|/mu)
  assert.ok(trunk !== null, '文档的分量表里应有 #1 主干那一行')
  assert.equal(trunk[1], '68', '搬前主干 68 声明')
  assert.equal(trunk[2], '1251', '搬前主干 1251 行')

  // 四档：D 486 / C 413 / B 373 / A 263
  const tierD = doc.match(/^\|\s*\*\*D 大块 ≥100\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|/mu)
  assert.ok(tierD !== null, '文档的四档表里应有 D 档那一行')
  assert.equal(tierD[1], '4')
  assert.equal(tierD[2], '486')

  /**
   * 现在**重算**那个时点：把拆分前的 retrieve.ts 放进临时树，用当前报告脚本算一遍。
   * 拆分前的最后一次提交 = 第一步的父提交（0381c6c）。
   */
  const PRE_SPLIT = '0381c6c'
  const tmp = mkdtempSync(join(REPO, '.v207-doc-'))
  try {
    /**
     * ⚠ 必须导出**整棵 src/**，不能只放 retrieve.ts。
     *
     * 第一版只写了 `retrieve.ts` 一个文件，重算得 21 个分量（当前值）而不是 19 —— 因为
     * `retrieve-report.mjs` 通过 `closure.mjs --declarations` 取的是**整个 TypeScript program**
     * 的声明表；临时树里只有那一个文件时，closure 看到的是一棵残缺的树，
     * 名字解析与 span 都会跟着变。
     *
     * 这类「测试自建的环境不完整」的错，与 families.mjs 把文件名写死是同一族：
     * 判据没错，**输入不是它以为的那份输入**。
     */
    execFileSync('git', ['archive', PRE_SPLIT, 'src', 'scripts', 'package.json'], { cwd: REPO, stdio: 'pipe' })
      .toString()
    // git archive 输出二进制 tar；改用逐文件导出（本仓 src/ 只有几十个文件，够快）
    const list = execFileSync('git', ['ls-tree', '-r', '--name-only', PRE_SPLIT, '--', 'src'], { cwd: REPO, encoding: 'utf8' })
      .split(/\r?\n/u).filter((p) => p.endsWith('.ts'))
    assert.ok(list.length > 20, `搬前的 src/ 应有 20+ 个 .ts，实测 ${list.length}`)
    for (const rel of list) {
      const target = join(tmp, rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, execFileSync('git', ['show', `${PRE_SPLIT}:${rel}`], { cwd: REPO, encoding: 'utf8' }), 'utf8')
    }
    // 脚本用当前的（解析逻辑与今天一致），但 src/ 是搬前的
    //   ⇒ 临时树里要有 scripts/（retrieve-report 会去 REPO/scripts 调 closure.mjs）
    cpSync(join(REPO, 'scripts'), join(tmp, 'scripts'), { recursive: true })
    const reportScript = join(REPO, 'scripts', 'retrieve-report.mjs')
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    let out
    try {
      out = execFileSync(process.execPath, [reportScript, '--json', '--root', tmp],
        { cwd: tmp, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 180_000, env })
    } catch (e) {
      out = String(e.stdout ?? '')
    }
    const rows = out.trim().split('\n')
    const json = rows[rows.length - 1]
    const parsed = JSON.parse(json)

    assert.equal(parsed.components, 19, `重算搬前的分量数应为 19，实测 ${parsed.components}`)
    assert.equal(parsed.sccs, 89, `重算搬前的 SCC 应为 89，实测 ${parsed.sccs}`)
    assert.equal(parsed.trunk.declarations, 68, '重算搬前的主干声明数应为 68')
    assert.equal(parsed.trunk.lines, 1251, '重算搬前的主干行数应为 1251')
    assert.equal(parsed.layers, 8, `重算搬前的拓扑层数应为 8，实测 ${parsed.layers}`)
    assert.equal(parsed.tiers.D.lines, 486, 'D 档 486 行')
    assert.equal(parsed.tiers.C.lines, 413, 'C 档 413 行')
    assert.equal(parsed.tiers.B.lines, 373, 'B 档 373 行')
    assert.equal(parsed.tiers.A.lines, 263, 'A 档 263 行')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
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
   * `FilterOptions` 在整棵树里有两处模块级声明：`filter.ts` 与 `retrieve/types.ts`。
   * 第一版 `byName.set` 不过滤文件，于是 retrieve 侧的 `FilterOptions` 被 filter.ts 的
   * 同名项覆盖 —— 跨度从 49 行变成 16 行，自校验报差额 −33。这里钉住「按文件过滤」。
   *
   * 注：第六步把契约类型搬进 `retrieve/types.ts` 之后，第二个文件从 `retrieve.ts`
   * 变成 `retrieve/types.ts` —— 被测的**性质**没变（跨文件模块级撞名），只是位置变了。
   *
   * 注：`provenanceOf` / `firstEvidence` 在 who-references 眼里也是"歧义"的，但那是因为它们
   * 还有**函数内局部**同名声明；`closure --declarations` 只收模块级，所以表里各只有一条。
   * 用 `FilterOptions` 做例子才是真正的跨文件模块级撞名。
   */
  const duplicated = rows.filter((row) => row.name === 'FilterOptions')
  const files = new Set(duplicated.map((row) => row.file))
  assert.ok(files.size > 1,
    `前提：FilterOptions 应跨多个文件声明（实测 ${[...files].join(',') || '无'}）—— 这条测试才有意义`)
  assert.ok(files.has('filter.ts') && files.has('retrieve/types.ts'),
    `FilterOptions 应在 filter.ts 与 retrieve/types.ts 各有一条，实测在 ${[...files].join(',')}`)

  // 两处行数不同 ⇒ 取错了会被数字抓到
  const sizes = new Map(duplicated.map((row) => [row.file, row.lines]))
  assert.notEqual(sizes.get('filter.ts'), sizes.get('retrieve/types.ts'),
    '两处的行数必须不同，否则「取错文件」这件事在数字上看不出来')

  // 每个 (file, name) 组合最多一条 —— 同一文件内的同名模块级声明会破坏 byName 的语义
  const keys = duplicated.map((row) => `${row.file}:${row.name}`)
  assert.equal(new Set(keys).size, keys.length, '同一文件内的同名模块级声明会破坏 byName 的语义')
})
