/**
 * ── MODULE SIZE CAP: 800 LINES, AS A RULE RATHER THAN A SENTENCE ─────────────────────────────────
 *
 * 订正一句措辞（用户指出的）：**不是**「skill.ts 超了 800 上限」。
 * memory 此前**根本没有尺寸门禁** —— 800 这个数字只出现在文档与 move-gate 的 A 档里，
 * 从来没有被测过。本轮补上这条门禁，并把**现存**超限文件登记为天花板。
 * 「先有门禁、再有天花板」与「有门禁而某文件越界」是两件事，不能混说。
 *
 * ── 四条规则（移植自 graft-slice v130，按 memory 的差异改写）────────────────────────────────────
 *
 *   1. 每个被扫描的 `.ts` 文件 ≤ 800 行；
 *   2. 超限的登记在 `EXEMPT` 里，`ceiling` = **今天实测的行数**，只能降不能升；
 *   3. 天花板是**上限快照**，不是许可证：文件长大一行的下一次运行就红；
 *   4. 文件**降到 800 以内后必须删掉登记项**，否则表里会堆一批不再有意义的条目。
 *
 * ── 与 v130 的两处刻意不同 ──────────────────────────────────────────────────────────────────────
 *
 * **(a) 扫描集是显式列名，不是发现目录（用户明确要求）。**
 *   v130 用 `readdirSync` 递归发现目录，理由是「写死目录会让未来目录成为盲区」。
 *   memory 取相反方向，因为这里的情况不同：`src/` 是**扁平**的，只有一个子目录
 *   `store/`，而它是本轮重构**刚刚造出来**的。用发现式扫描意味着「今天新建一个目录，
 *   明天它自动进入门禁」——听起来安全，实际会把「哪些文件受尺寸约束」变成一件
 *   需要读代码才知道的事。
 *
 *   显式列名的代价是「新文件默认不受约束」。这一条用**独立的完整性断言**堵住：
 *   下面有一条测试把「磁盘上真实存在的 .ts 文件集合」与「显式名单」逐名比对，
 *   不一致就红。于是「忘了登记新文件」不会静默通过，而名单本身仍然是可读的一行行文字。
 *
 * **(b) `index.ts` 不豁免，它就在红名单里。**
 *   v130 把 `index.ts` 排除在范围外（它是被分解的目标，包含进来会让门禁永久红）。
 *   memory 的 `index.ts` 是 2361 行，**确实超限** —— 把它排除等于在门禁第一天就
 *   开一个 2361 行的洞。这里选择登记为天花板，让它的尺寸**可见且不可增长**。
 *
 * ── 为什么「新文件 ≤ 800」要能独立断言 ─────────────────────────────────────────────────────────
 *
 * 天花板（`EXEMPT`）是给历史遗留的。如果唯一的断言是「超限者必须在表里」，
 * 那么**给任何新文件加一条登记**就成了合法的绕过路径 —— 门禁会退化成
 * 「超大文件必须被登记」而不是「新文件不许超大」。
 *
 * 所以这里分开断言：
 *   - `EXEMPT` 里每个条目必须是**已知的历史文件**（`HISTORICAL` 名单，只减不增）；
 *   - 扫描集里**不在** `HISTORICAL` 的文件必须 ≤ 800，**无论它是否在 EXEMPT 里**。
 *
 * 第二条独立于第一条成立：往 EXEMPT 里加一条新条目，会因为「不在 HISTORICAL」而红。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'src')
const CAP = 800

/**
 * ── 扫描集：显式列名（用户要求）────────────────────────────────────────────────────────────────
 *
 * 新增文件时**必须**在这里加一行 —— 漏加会被下面的完整性断言抓住，不会静默通过。
 * 排序规则：先根文件（按字母），再 `store/` 子目录（按字母）。
 */
const SCANNED = [
  'archive.ts',
  'causal.ts',
  'dedupe.ts',
  'edges.ts',
  'extract.ts',
  'filter.ts',
  'graph.ts',
  'hybrid-search.ts',
  'index.ts',
  'indexed-store.ts',
  'knowledge.ts',
  'layout.ts',
  'lease-bridge.ts',
  'lease-types.ts',
  'ledger-cache.ts',
  'ledger.ts',
  'lock.ts',
  'retrieve.ts',
  'retrieve/interning.ts',
  'retrieve/storage-tier.ts',
  'segment.ts',
  'skill-cache.ts',
  'sqlite-index.ts',
  'storage-tier.ts',
  'store.ts',
  'suggest.ts',
  'threat.ts',
  'workspace.ts',
  'zstd.ts',
  'store/clock.ts',
  'store/io.ts',
  'store/layer.ts',
  'store/lifecycle.ts',
  'store/skill.ts',
]

/**
 * ── 历史超限文件：只有这里列出的文件才允许出现在 EXEMPT 里 ────────────────────────────────────
 *
 * **只减不增。** 一个文件被拆到 800 以内之后，要同时从这里和 EXEMPT 里删掉。
 * 新文件永远不该出现在这里 —— 这正是「新文件 ≤ 800」那条断言能独立成立的原因。
 */
const HISTORICAL = new Set([
  'index.ts',
  'retrieve.ts',
  'store/skill.ts',
])

/**
 * ── EXEMPT：天花板，实测于 2026-11-15 ────────────────────────────────────────────────────────────
 *
 * 每条 ceiling 就是**当天实测的行数**。文件不许长過它；缩短永远允许。
 * 理由必须能被反驳（≥ 80 字符），不能是一句「以后再说」。
 */
const EXEMPT = new Map([
  ['index.ts', {
    ceiling: 2361,
    reason:
      'dsh-memory 的插件入口：applyInner 一个函数 1362 行（占 58%），加上工具注册、console 网络端、'
      + 'harvest 编排与 33 个导出。它是整个重构的**目标文件**，拆它需要先拆它依赖的 store/retrieve'
      + '（已完成 store 的 A1；retrieve 尚未开始）。在拆完之前把它排除在门禁之外等于开一个 2361 行的洞，'
      + '所以登记为天花板：尺寸可见、不可增长。',
  }],
  ['retrieve.ts', {
    ceiling: 2009,
    reason:
      '检索层：词法召回、IDF×鲜活度×重要度打分、两阶段 LLM 过滤、提示渲染。它与 store.ts 曾共享大量'
      + 'helper，A1 完成后其闭包已缩小但文件本身尚未拆。拆分需要先确定 Document/MemoryHit 的归属'
      + '（D-1 就落在这里的 hitOf），而 D-1 按裁定要等重构完成后再修。登记为天花板。',
  }],
  ['store/skill.ts', {
    ceiling: 985,
    reason:
      'A1 的产物：SKILL.md 的读与写两半现在同处一文件（renderSkill/parseSkillFile 共用一个格式契约，'
      + '分开住会让读者与写者漂移）。985 行里约 150 行是分步搬移时写的分节说明注释。'
      + '若将来要压到 800 以内，第一步是精简那些注释，第二步才是拆分（拆分会重新引入格式契约分裂的风险）。',
  }],
])

const countLines = (file) => {
  const parts = readFileSync(file, 'utf8').replace(/\r\n/gu, '\n').split('\n')
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length
}

const measured = new Map(
  SCANNED.map((rel) => [rel, countLines(join(SRC, rel))]),
)

/**
 * ── 判据被抽成纯函数，好让 can-red 用假数据喂它们 ──────────────────────────────────────────────
 *
 * 每个函数只吃 `{ measured, exempt, historical }` 三个 Map/Set，不碰磁盘、不读本文件的常量。
 * 于是真树与假树走**同一条**代码路径：假树上能红，等价于真树上有违规也会红。
 *
 * 这一层存在的理由是用户指出的那件事：can-red 之前只在 _scratch 里做过，
 * 而一次性验证不会在下次改动时重跑。「我验过了」不能当成门禁的一部分。
 */
const overCapUnregistered = ({ measured: m, exempt, cap = CAP }) =>
  [...m.entries()]
    .filter(([rel, lines]) => lines > cap && !exempt.has(rel))
    .map(([rel, lines]) => `${rel} (${lines})`)
    .sort()

const newFilesOverCap = ({ measured: m, historical, cap = CAP }) =>
  [...m.entries()]
    .filter(([rel, lines]) => !historical.has(rel) && lines > cap)
    .map(([rel, lines]) => `${rel} (${lines})`)
    .sort()

const staleHistorical = ({ measured: m, historical, cap = CAP }) =>
  [...historical].filter((rel) => (m.get(rel) ?? 0) <= cap).sort()

const ceilingBreaches = ({ measured: m, exempt }) =>
  [...exempt.entries()]
    .flatMap(([rel, entry]) => {
      const lines = m.get(rel)
      if (lines === undefined) return [`${rel}（不在扫描集里）`]
      return lines <= entry.ceiling ? [] : [`${rel}（${lines} > ceiling ${entry.ceiling}）`]
    })
    .sort()

const expiredExemptions = ({ measured: m, exempt, cap = CAP }) =>
  [...exempt.keys()]
    .filter((rel) => (m.get(rel) ?? 0) <= cap)
    .sort()

const orphanExemptions = ({ exempt, historical }) =>
  [...exempt.keys()].filter((rel) => !historical.has(rel)).sort()

const REAL = { measured, exempt: EXEMPT, historical: HISTORICAL }

/**
 * ── 完整性：显式名单必须等于磁盘上的真实集合 ────────────────────────────────────────────────────
 *
 * 这是「显式列名」这个选择的代价补偿：新文件不会自动进入门禁，但**漏登记**会被这里抓住。
 * 参考集用 `includes('.ts')` 而不是扫描时用的正则 —— 两个不同的谓词，
 * 这样改了一边不会让两边同时错（v130 N6b 的教训：共用同一个正则等于没有第二实现）。
 */
const walkEveryTsBearingFile = (dir, rel = '', out = []) => {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    const r = rel === '' ? entry : `${rel}/${entry}`
    if (statSync(full).isDirectory()) { walkEveryTsBearingFile(full, r, out); continue }
    if (!entry.includes('.ts')) continue
    out.push(r)
  }
  return out
}

test('cap: 显式扫描名单 == 磁盘上真实存在的 .ts 文件（漏登记即红）', () => {
  const onDisk = walkEveryTsBearingFile(SRC).sort()
  const listed = [...SCANNED].sort()
  assert.deepEqual(listed, onDisk,
    '显式名单与磁盘不一致：新增文件必须加进 SCANNED（否则它不受尺寸约束），'
    + '删除文件必须从 SCANNED 移除。参考集用 includes(".ts") 而非扫描时的正则，两个谓词不同。')
})

test('cap: 每个受扫描模块 ≤ 800 行，或已在 EXEMPT 里登记为天花板', () => {
  const over = overCapUnregistered(REAL)
  assert.deepEqual(over, [],
    `这些模块超过 ${CAP} 行上限：拆开它们，或在本文件的 EXEMPT 里登记一条带理由的天花板`)
})

/**
 * ── 独立断言：新文件 ≤ 800（与 EXEMPT 无关）────────────────────────────────────────────────────
 *
 * 这条**不看 EXEMPT**。它只问一个问题：不在 HISTORICAL 名单里的文件，是不是 ≤ 800？
 *
 * 于是往 EXEMPT 里加一个新文件的条目**不能**让它过关 —— 这正是「新文件不许超大」
 * 与「历史文件登记为天花板」两件事的分界。没有这条，EXEMPT 就是一张万能许可证。
 */
test('cap: 新文件（不在 HISTORICAL 名单里）必须 ≤ 800，无论是否登记在 EXEMPT', () => {
  const violators = newFilesOverCap(REAL)
  assert.deepEqual(violators, [],
    `${CAP} 行上限对新文件成立。${violators.length > 0 ? violators.join(', ') + ' 不在 HISTORICAL 名单里，' : ''}`
    + '往 EXEMPT 里加条目不能绕过这条 —— HISTORICAL 只减不增，新文件永远不该进来。')

  // 反向：HISTORICAL 里的每个文件都必须真的超限，否则它就是一条过期的「历史」标签。
  const noLongerOver = staleHistorical(REAL)
  assert.deepEqual(noLongerOver, [],
    `这些文件已降到 ${CAP} 行以内，必须同时从 HISTORICAL 与 EXEMPT 里删掉：${noLongerOver.join(', ')}`)
})

test('cap: EXEMPT 的每个条目都是天花板 —— 文件不得长過登记的 ceiling', () => {
  for (const [rel, entry] of EXEMPT) {
    const lines = measured.get(rel)
    assert.ok(lines !== undefined, `EXEMPT 列了 ${rel}，但它不在 SCANNED 里`)
    assert.ok(lines <= entry.ceiling,
      `${rel} 现在 ${lines} 行，超过登记的 ceiling ${entry.ceiling}。`
      + '天花板是「今天多大就是多大」的快照，不是允许继续增长。')
  }
  assert.deepEqual(ceilingBreaches(REAL), [],
    '同上，纯函数版本必须与逐条循环给出一致的结论（两个实现在这里互为对照）')
})

test('cap: EXEMPT 的每个条目都有可被反驳的理由（≥ 80 字符）', () => {
  for (const [rel, entry] of EXEMPT) {
    assert.ok(entry.reason.trim().length >= 80,
      `${rel} 的豁免理由太短，读的人无法据此反驳或同意`)
  }
})

test('cap: 降回 800 以内的文件必须删除其 EXEMPT 条目', () => {
  for (const [rel] of EXEMPT) {
    const lines = measured.get(rel) ?? 0
    assert.ok(lines > CAP,
      `${rel} 现在 ${lines} 行，已在 ${CAP} 以内 —— 删掉它的 EXEMPT 条目（以及 HISTORICAL 里的那一行）。`
      + '一条过期的豁免就是一个带标签的洞。')
  }
  assert.deepEqual(expiredExemptions(REAL), [],
    '同上，纯函数版本必须与逐条循环给出一致的结论')
})

test('cap: EXEMPT 的键必须都在 HISTORICAL 里（历史遗留才有天花板）', () => {
  const orphans = orphanExemptions(REAL)
  assert.deepEqual(orphans, [],
    `这些文件在 EXEMPT 里但不在 HISTORICAL 里：${orphans.join(', ')}。`
    + 'HISTORICAL 是「允许有天花板」的白名单，新文件不该进来。')
})

/**
 * ── can-red：判据必须真能红（用户要求写进仓内测试的那一条）──────────────────────────────────
 *
 * 之前那五次注入只在 `_scratch/` 里跑过，跑完就没了 —— 下一个人改门禁时不会重跑它。
 * 这里用假数据把同样的注入固化下来，走的是与真树**同一批**纯函数。
 *
 * 造基线的手法：从真实 EXEMPT 抄一份 ceiling 作为「假树」的测量值，
 * 于是基线天然是绿的；再逐项破坏一个条件，确认对应的判据点名。
 */
const fakeBaseline = () => {
  const m = new Map()
  for (const rel of SCANNED) m.set(rel, EXEMPT.get(rel)?.ceiling ?? 100)
  return m
}

test('can-red ①: 天花板被突破 1 行 → ceilingBreaches 必须点名', () => {
  const m = fakeBaseline()
  const target = [...HISTORICAL][0]
  m.set(target, EXEMPT.get(target).ceiling + 1)
  const hits = ceilingBreaches({ measured: m, exempt: EXEMPT })
  assert.equal(hits.length, 1, `只该点名 ${target}：${JSON.stringify(hits)}`)
  assert.match(hits[0], new RegExp(target.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
})

test('can-red ②: HISTORICAL 里的文件从 EXEMPT 移除 → 必须红（它超限却无天花板）', () => {
  const m = fakeBaseline()
  const target = [...HISTORICAL][0]
  const exemptWithout = new Map(EXEMPT)
  exemptWithout.delete(target)
  const hits = overCapUnregistered({ measured: m, exempt: exemptWithout })
  assert.deepEqual(hits, [`${target} (${m.get(target)})`])
})

test('can-red ③: 新文件 900 行未登记 → 两条判据都点名', () => {
  const m = fakeBaseline()
  m.set('brand-new.ts', 900)
  assert.deepEqual(overCapUnregistered({ measured: m, exempt: EXEMPT }), ['brand-new.ts (900)'])
  assert.deepEqual(newFilesOverCap({ measured: m, historical: HISTORICAL }), ['brand-new.ts (900)'])
})

test('can-red ④: 从 HISTORICAL 移除但仍在 EXEMPT → 独立断言必须红（用户特别点名的一条）', () => {
  /**
   * 这是「新文件 ≤ 800」那条断言能独立成立的核心场景：
   * 有人把 store/skill.ts 从 HISTORICAL 删掉，却留着 EXEMPT 里 985 行的天花板，
   * 企图让一个超大文件表现为「历史遗留」。若只有「超限者必须在 EXEMPT 里」这一条判据，
   * 它会绿 —— 所以这里必须由 newFilesOverCap 点名。
   */
  const target = 'store/skill.ts'

  const m = fakeBaseline()
  const historicalWithout = new Set([...HISTORICAL].filter((r) => r !== target))

  // 旧判据（只看 EXEMPT）此刻是绿的 —— 这正是漏洞
  assert.deepEqual(overCapUnregistered({ measured: m, exempt: EXEMPT }), [],
    '前提确认：只看「超限者是否登记」，这个注入是隐形的')

  // 独立断言必须抓住它
  assert.deepEqual(newFilesOverCap({ measured: m, historical: historicalWithout }), [`${target} (${m.get(target)})`],
    '从 HISTORICAL 移除但仍在 EXEMPT → 新文件 ≤ 800 这条必须红')

  // 顺带：EXEMPT 的键不在 HISTORICAL 里，孤儿判据也应点名同一条
  assert.deepEqual(orphanExemptions({ exempt: EXEMPT, historical: historicalWithout }), [target])
})

test('can-red ⑤: 往 EXEMPT 塞一个新文件（900）→ 仍被独立断言拦住', () => {
  const m = fakeBaseline()
  m.set('sneaky.ts', 900)
  const exemptPlus = new Map(EXEMPT)
  exemptPlus.set('sneaky.ts', { ceiling: 900, reason: 'x'.repeat(90) })

  // 有登记 → 旧判据绿
  assert.deepEqual(overCapUnregistered({ measured: m, exempt: exemptPlus }), [],
    '前提确认：登记之后，「超限者在表里」这条不再报')

  // 但它在 HISTORICAL 之外 → 独立断言红
  assert.deepEqual(newFilesOverCap({ measured: m, historical: HISTORICAL }), ['sneaky.ts (900)'])
  assert.deepEqual(orphanExemptions({ exempt: exemptPlus, historical: HISTORICAL }), ['sneaky.ts'])
})

test('can-red ⑥: 文件降回 800 以内却留着登记 → 过期豁免判据必须点名', () => {
  const m = fakeBaseline()
  const target = [...HISTORICAL][0]
  m.set(target, 700)
  assert.deepEqual(expiredExemptions({ measured: m, exempt: EXEMPT }), [target])
  assert.deepEqual(staleHistorical({ measured: m, historical: HISTORICAL }), [target])
})

test('can-red ⑦: 全部合规的假树 → 六条判据同时为空（免得把「总能报错」当成 can-red）', () => {
  const m = fakeBaseline()
  const world = { measured: m, exempt: EXEMPT, historical: HISTORICAL }
  assert.deepEqual(overCapUnregistered(world), [])
  assert.deepEqual(newFilesOverCap(world), [])
  assert.deepEqual(staleHistorical(world), [])
  assert.deepEqual(ceilingBreaches(world), [])
  assert.deepEqual(expiredExemptions(world), [])
  assert.deepEqual(orphanExemptions(world), [])
})