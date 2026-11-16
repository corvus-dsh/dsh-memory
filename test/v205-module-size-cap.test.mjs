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
  'retrieve/commit-cache.ts',
  'retrieve/documents.ts',
  'retrieve/interning.ts',
  'retrieve/scene.ts',
  'retrieve/storage-tier.ts',
  'retrieve/types.ts',
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
    ceiling: 1078,
    reason:
      '检索层：词法召回、IDF×鲜活度×重要度打分、两阶段 LLM 过滤、提示渲染。它与 store.ts 曾共享大量'
      + 'helper。2026-11-16 已完成六步搬运：'
      + '① 14 声明 → retrieve/interning.ts，② 6 声明 → retrieve/storage-tier.ts，'
      + '③ 5 声明 → retrieve/commit-cache.ts，④ 8 声明 → retrieve/documents.ts，'
      + '⑤ 10 声明 → retrieve/scene.ts，⑥ 12 个纯类型声明 → retrieve/types.ts'
      + '（2009 → 1763 → 1718 → 1673 → 1419 → 1294 → 1074）。'
      + '第五步之后**模块级可变状态归零**（由 v212 机械断言）。'
      + '第六步另外删掉 2 个零引用常量（CJK / LATIN）—— 那是**删除**，不是位移。'
      + '剩余主干 22 声明 / 557 行。'
      + '**2026-11-16 D-1 修复后 1074 → 1078（+4）**：`hitOf` 补了 `ageDays` 与 `hits` 两行条件展开，'
      + '`types.ts` 补了 `MemoryHit.ageDays` 与 `Document.hits` 两处声明。'
      + '这 4 行是**功能修复**，不是膨胀 —— 它们把一条断掉的链接上（生产者算出年龄、消费者要年龄、'
      + '中间的复制函数没搬），由 `test/v217-d1-agedays.test.mjs` 的四条断言钉住。'
      + '棘轮按实测收紧到 1078：它仍然只能降，不能因为「这次是修复」就放松。'
      + '层账（由 `node scripts/retrieve-report.mjs` 的「层账」一节算，不手抄）：旧值 1074 行时'
      + '搬完 L1+L2+L3 是 689 行，**已经 ≤ 800**；再搬 L0（335）只剩 354 —— '
      + '那 354 行是 import / re-export / 文件头注释 / 空行，不是可搬的声明。'
      + '所以「按层搬」到 L1+L2+L3 就够了；继续动 L0 是「要不要把它变成纯壳」的战略决定，'
      + '需要另立一次「入口点归位」，并接受本文件变成 store.ts 那种壳。'
      + 'ceiling 随每次搬运收紧到新实测值 —— 这是棘轮，不是自觉'
      + '（由「ceiling 必须等于实测」那条断言强制）。'
      + 'D-1 已于 2026-11-16 修复（原欠账「hitOf 不复制 ageDays/hits」已清）。',
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

/**
 * ── ceiling 必须等于实测，而不是大于等于 ────────────────────────────────────────────────────────
 *
 * `ceilingBreaches` 判的是「不许长过天花板」（`lines <= ceiling`）。它允许**天花板虚高**：
 * 一个文件被拆小了，但 ceiling 还是旧的大数字，于是**下一次增长**仍有空间 ——
 * 棘轮只在「降 ceiling」这个动作上咬合，而那个动作没有任何断言要求它发生。
 *
 * 实测（2026-11-15）：`retrieve.ts` 的 ceiling 写 2009，实际 1718。差 291 行是**白送的配额**。
 * 换句话说，一步搬运把文件缩小了 291 行，门禁却允许它再长回去 291 行而不报。
 *
 * 这条纯函数把「ceiling == 实测」变成判据：收紧是**强制**的，不是自觉的。
 *
 * 判据写法：`seen` 是当天实测值，`entry.ceiling` 是登记值。只允许 `ceiling === lines`。
 *   · `ceiling > lines` → 天花板虚高，必须收紧（这条测试红）
 *   · `ceiling < lines` → 已经长过天花板，由 `ceilingBreaches` 负责（两处都红也可以）
 */
const slackCeilings = ({ measured: m, exempt }) =>
  [...exempt.entries()]
    .flatMap(([rel, entry]) => {
      const lines = m.get(rel)
      if (lines === undefined) return []
      return entry.ceiling === lines ? [] : [`${rel}（ceiling ${entry.ceiling}，实测 ${lines}，差 ${entry.ceiling - lines}）`]
    })
    .sort()

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

/**
 * ── 独立断言：ceiling 必须**恰好**等于当天实测 ─────────────────────────────────────────────────
 *
 * 与上一条的区别是「≤」还是「==」。上一条允许天花板虚高（文件缩小了但 ceiling 没跟着收紧），
 * 于是棘轮只在自觉的情况下咬合。这一条把它变成强制的：不收紧就红。
 *
 * 为什么它必须独立成一条：`ceilingBreaches` 用的是 `lines <= ceiling`，把判据改成 `==`
 * 会让它同时承担两件事（「不许超」和「不许虚高」），失败信息也会混。两条各有各的措辞。
 */
test('cap: EXEMPT 的 ceiling 必须等于实测（棘轮强制收紧，不许留虚高配额）', () => {
  const slack = slackCeilings(REAL)
  assert.deepEqual(slack, [],
    '这些文件的 ceiling 与实测不一致。**ceiling 是「今天实测多少就是多少」的快照，不是上限许可**：\n  '
    + slack.join('\n  ')
    + '\n文件被拆小了 ⇒ 把 ceiling 收紧到新的实测值（这一步是强制动作，不是自觉）；'
    + '\n文件长大了 ⇒ 由「不得长過 ceiling」那条负责。')
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

test('can-red ⑦: 全部合规的假树 → 七条判据同时为空（免得把「总能报错」当成 can-red）', () => {
  const m = fakeBaseline()
  const world = { measured: m, exempt: EXEMPT, historical: HISTORICAL }
  assert.deepEqual(overCapUnregistered(world), [])
  assert.deepEqual(newFilesOverCap(world), [])
  assert.deepEqual(staleHistorical(world), [])
  assert.deepEqual(ceilingBreaches(world), [])
  assert.deepEqual(expiredExemptions(world), [])
  assert.deepEqual(orphanExemptions(world), [])
  assert.deepEqual(slackCeilings(world), [])
})

/**
 * ── can-red ⑧：虚高的 ceiling 必须被点名 ───────────────────────────────────────────────────────
 *
 * 这条对应用户裁定的第 ③ 项：`retrieve.ts` 曾登记 ceiling 2009 而实测 1718（差 291 行白送配额）。
 *
 * **不依赖真实 ceiling**：用合成的 `{ ceiling: 2009, measured: 1900 }` 精确复现那个形状
 * （实测低于登记）。若用 `fakeBaseline()`（它从真实 EXEMPT 抄 ceiling），一旦真实 ceiling 被
 * 收紧到 1718，1900 反而变成「突破天花板」，测的就不是这条判据了 —— 这类
 * 「测试数据跟着被测常量漂移」的坑会让 can-red 静默地测错东西。
 *
 * ⚠ 与 `ceilingBreaches` 的关系：后者判 `lines <= ceiling`，对「虚高」是**绿**的。
 * 所以先断言「旧判据此刻是绿的」，再断言新判据点名 —— 否则这条 can-red 是同义反复。
 */
test('can-red ⑧: ceiling 虚高（实测 1900 < 登记 2009）必须点名，而「不得长過」那条对它无感', () => {
  const target = 'retrieve.ts'
  const m = new Map([[target, 1900]])
  const exempt = new Map([[target, { ceiling: 2009, reason: 'x'.repeat(90) }]])

  // 旧判据（≤）对虚高无感 —— 这正是漏洞存在的证明
  assert.deepEqual(ceilingBreaches({ measured: m, exempt }), [],
    '前提确认：只看「不超过 ceiling」时，虚高的天花板是隐形的')

  // 新判据必须点名，并给出差额
  assert.deepEqual(slackCeilings({ measured: m, exempt }),
    [`${target}（ceiling 2009，实测 1900，差 109）`],
    '虚高的 ceiling 必须被点名，且差额要写出来（读的人才知道要收紧多少）')

  // 收紧到实测值之后必须转绿（判据不是「总有违规」）
  const tightened = new Map([[target, { ceiling: 1900, reason: 'x'.repeat(90) }]])
  assert.deepEqual(slackCeilings({ measured: m, exempt: tightened }), [],
    '把 ceiling 收紧到 1900 之后必须转绿')

  // 反向：文件长大了（实测 > ceiling）—— 这条判据也点名，措辞给出负差额
  assert.deepEqual(slackCeilings({ measured: new Map([[target, 2009 + 1]]), exempt }),
    [`${target}（ceiling 2009，实测 2010，差 -1）`],
    '长过 ceiling 时也要点名（与 ≤ 那条职责重叠，但措辞不同：这里显示负差额）')
})