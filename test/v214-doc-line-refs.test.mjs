/**
 * ── v214：文档里的 `<file>:<行号>` 不许落到文件尾之外（悬空引用）────────────────────────────────
 *
 * ── 为什么需要这条 ──────────────────────────────────────────────────────────────────────────────
 *
 * 六步搬运之后，同一类错误在文档里反复出现：`retrieve.ts:190`、`:1368`、`:1420`、`:1903` ——
 * 数字都还在，只是**指向了别的代码**。这类错误比「找不到」更糟：读者照着行号看过去会读到
 * 一段看起来相关、实际无关的实现，而且没有任何东西会红。
 *
 * 已有两条相关的处置，各管一半：
 *   · `v211` 管**命令**形状（`docs/**.md` 里不许有可执行的 `--against HEAD`）；
 *   · 裁定④ 管**定位方式**（优先符号名，行号只在括号里给当前值）。
 * 但「符号名写对了、括号里的行号却超出文件尾」这件事，两条都看不见。这条补上。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────────────────────────────
 *
 * 1. 扫 `docs/**\/*.md` 里所有 `<file>:<n>` 与 `<file>:<a>-<b>`；
 * 2. 能解析到仓内真实文件的，断言 `n <= 该文件当前行数`（区间则两端都查，且 b >= a）；
 * 3. 解析不到的（引用仓外文件、或本来就不是文件引用）**跳过** —— 判据不猜；
 * 4. **例外只有一种：`SPLIT_FILES` 里登记过的「已被拆分的文件」**。
 *    `store.ts` 从 2479 行拆到 374 行，文档里那些 `store.ts:2215` 是**历史记录**
 *    （写的时候它就在 2215 行），改写它们等于篡改历史。所以按仓里的老办法：
 *    **冻结条数 + 写明理由**，只许减不许增。
 *
 * ── 为什么要冻条数而不是整片豁免 ────────────────────────────────────────────────────────────────
 *
 * 整片豁免等于「对 store.ts 的行号引用再也不用管了」。冻条数后，新增一条进去就会红 ——
 * 于是「又手抄了一个 store.ts 行号」仍然会被拦住。
 *
 * 不依赖 typescript ⇒ **在 CI 上真跑**（不是 TD-M15 里那 13 条之一）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

/**
 * 已被拆分的文件：它们的行号在文档里是**历史坐标**，不映射到当前文件。
 *
 * `store.ts` 从 2479 行拆到 374 行，`docs/` 里的 `store.ts:2215` 是**写那份分析时的坐标**，
 * 改写它们等于篡改历史记录。所以按「冻结集合」处理：
 *
 *   **逐条冻结，增删都红。**
 *
 * 只冻条数是不够的 —— 「删掉一条旧引用、同时新增一条旧引用」在计数上不变，
 * 而那正是「又有人手抄了一个旧行号」的形状。所以下面这张表把 26 条**逐字**列出来：
 * 少一条说明有人清理了（好事，但要同步这张表）；多一条说明又抄了一个（红）。
 */
export const SPLIT_TARGETS = new Set(['src/store.ts'])

export const FROZEN_STORE_REFS = [
  'docs/A1-plan-and-handoff.md|src/store.ts:563',
  'docs/A1-plan-and-handoff.md|store.ts:2215',
  'docs/A1-plan-and-handoff.md|store.ts:545',
  'docs/A1-plan-and-handoff.md|store.ts:550',
  'docs/A1-plan-and-handoff.md|store.ts:563',
  'docs/memory-known-defects.md|store.ts:1293',
  'docs/memory-known-defects.md|store.ts:1305',
  'docs/memory-known-defects.md|store.ts:1493',
  'docs/memory-known-defects.md|store.ts:1548',
  'docs/memory-known-defects.md|store.ts:1615',
  'docs/memory-known-defects.md|store.ts:1964',
  'docs/memory-known-defects.md|store.ts:2062-2088',
  'docs/memory-known-defects.md|store.ts:2093-2102',
  'docs/memory-known-defects.md|store.ts:2148',
  'docs/memory-known-defects.md|store.ts:2215',
  'docs/memory-known-defects.md|store.ts:2215',
  'docs/memory-type-defects.md|store.ts:1615',
  'docs/memory-type-defects.md|store.ts:1615',
  'docs/memory-type-defects.md|store.ts:1615',
  'docs/memory-type-defects.md|store.ts:2093-2102',
  'docs/memory-type-defects.md|store.ts:2148',
  'docs/memory-type-defects.md|store.ts:2148',
  'docs/memory-type-defects.md|store.ts:2148',
  'docs/memory-type-defects.md|store.ts:2215',
  'docs/memory-type-defects.md|store.ts:2215',
  'docs/memory-type-defects.md|store.ts:2215',
]

// ── 判据（纯函数，好让 can-red 喂假数据）──────────────────────────────────────────────────────

/** 文档正文里的 `<file>:<n>` / `<file>:<a>-<b>`。 */
export const scanRefs = (text) =>
  [...text.matchAll(/([A-Za-z0-9_\-./]+\.(?:ts|mjs|js|md|json|yml)):(\d+)(?:-(\d+))?/gu)]
    .map((m) => ({ raw: m[0], file: m[1], start: Number(m[2]), end: m[3] === undefined ? undefined : Number(m[3]) }))

/** 把 `retrieve.ts` / `src/retrieve.ts` 这类写法解析到仓内真实文件（解析不到返回 undefined）。 */
export const PREFIXES = ['', 'src/', 'src/retrieve/', 'src/store/', 'test/', 'scripts/', 'docs/']
export const resolveRef = (file, lineCountOf) => {
  for (const prefix of PREFIXES) {
    const rel = `${prefix}${file}`
    const n = lineCountOf(rel)
    if (n !== undefined) return { rel, lines: n }
  }
  return undefined
}

/**
 * 悬空引用：`start`（或区间的 `end`）超出目标文件当前行数。
 * 区间还要求 `end >= start` —— 反过来写也是错，只是换了个错法。
 */
export const danglingRefs = (refs, lineCountOf) => {
  const out = []
  for (const ref of refs) {
    const hit = resolveRef(ref.file, lineCountOf)
    if (hit === undefined) continue
    if (ref.end !== undefined && ref.end < ref.start) {
      out.push({ ...ref, target: hit.rel, lines: hit.lines, why: 'range-reversed' })
      continue
    }
    const worst = ref.end === undefined ? ref.start : Math.max(ref.start, ref.end)
    if (worst > hit.lines) out.push({ ...ref, target: hit.rel, lines: hit.lines, why: 'past-eof' })
  }
  return out
}

/** 一条悬空引用的稳定标识：`文档|原文`。 */
export const refKey = (d) => `${d.doc}|${d.raw}`

/**
 * 与实际悬挂集合的比较：**增**（实际有、冻结里没有）与**减**（冻结里有、实际没有）分别报。
 * 两边都要报，因为「清理掉一条却不更新表」和「新抄一条」一样会让这张表失去意义。
 */
export const frozenSetDiff = (actualKeys, frozenKeys) => {
  const tally = (keys) => {
    const m = new Map()
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1)
    return m
  }
  const a = tally(actualKeys)
  const f = tally(frozenKeys)
  const extra = []
  const missing = []
  for (const [k, n] of a) { const frozen = f.get(k) ?? 0; for (let i = frozen; i < n; i++) extra.push(k) }
  for (const [k, n] of f) { const now = a.get(k) ?? 0; for (let i = now; i < n; i++) missing.push(k) }
  return { extra: extra.sort(), missing: missing.sort() }
}

// ── 文件系统 ────────────────────────────────────────────────────────────────────────────────────

const docsFiles = () => {
  const out = []
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) { walk(abs, `${rel}/${entry.name}`); continue }
      if (entry.name.endsWith('.md')) out.push({ abs, rel: `${rel}/${entry.name}` })
    }
  }
  walk(join(REPO, 'docs'), 'docs')
  return out
}

const counts = new Map()
const lineCountOf = (rel) => {
  if (counts.has(rel)) return counts.get(rel)
  const abs = join(REPO, rel)
  let n
  if (existsSync(abs) && statSync(abs).isFile()) {
    const parts = readFileSync(abs, 'utf8').replace(/\r\n/gu, '\n').split('\n')
    n = parts[parts.length - 1] === '' ? parts.length - 1 : parts.length
  }
  counts.set(rel, n)
  return n
}

const allDangling = () => {
  const out = []
  for (const doc of docsFiles()) {
    const refs = scanRefs(readFileSync(doc.abs, 'utf8'))
    for (const d of danglingRefs(refs, lineCountOf)) out.push({ ...d, doc: doc.rel })
  }
  return out
}

// ── 测试 ─────────────────────────────────────────────────────────────────────────────────────

test('v214 ①: docs/ 里的行号引用不得超出目标文件当前行数（被拆分文件除外）', () => {
  const dangling = allDangling()
  const exempt = dangling.filter((d) => SPLIT_TARGETS.has(d.target))
  const bad = dangling.filter((d) => !SPLIT_TARGETS.has(d.target))
  const detail = bad.map((d) => `${d.doc}: ${d.raw}  → ${d.target} 现在只有 ${d.lines} 行`)
  assert.deepEqual(detail, [],
    '这些文档里的行号引用指向了文件尾之外 —— 读者照过去会看到不存在的位置。'
    + '处置：改用**符号名**定位（裁定④），行号只在括号里给当前值，或干脆不给：\n  '
    + detail.join('\n  '))
  // 兜底：确认扫描不是空转（docs 里确实有成百上千处引用，其中必然有能解析的）
  assert.ok(exempt.length > 0 || bad.length === 0, 'sanity: 至少扫到了东西')
})

test('v214 ②: 被拆分文件（store.ts）的旧行号引用逐条冻结 —— 增删都红', () => {
  const actual = allDangling().filter((d) => SPLIT_TARGETS.has(d.target)).map(refKey)
  const { extra, missing } = frozenSetDiff(actual, FROZEN_STORE_REFS)
  assert.deepEqual(extra, [],
    '新增了指向**已拆分文件**的旧行号引用（又有人手抄了一个过时行号？）。'
    + '新写的引用请用符号名；确实需要记历史坐标时，改这一张冻结表并写明理由：\n  ' + extra.join('\n  '))
  assert.deepEqual(missing, [],
    '冻结表里的旧行号引用**少了** —— 说明有人清理掉了（好事），'
    + '但冻结表必须同步：把对应条目删掉，让这和事实一致：\n  ' + missing.join('\n  '))
})

test('v214 ③: 判据本身能在真实文档上读到东西（防「空数组恒绿」）', () => {
  const docs = docsFiles()
  assert.ok(docs.length >= 10, `docs/*.md 只找到 ${docs.length} 个 —— 扫描器可能指错了目录`)
  let refs = 0
  let resolvable = 0
  for (const doc of docs) {
    for (const ref of scanRefs(readFileSync(doc.abs, 'utf8'))) {
      refs += 1
      if (resolveRef(ref.file, lineCountOf) !== undefined) resolvable += 1
    }
  }
  assert.ok(refs > 50, `只解析到 ${refs} 处 <file>:<n> —— 正则可能坏了`)
  assert.ok(resolvable > 0, '一处都解析不到 —— PREFIXES 可能坏了')
})

// ── can-red ───────────────────────────────────────────────────────────────────────────────────

test('v214 ④ can-red: 超出文件尾必须被点名', () => {
  const fake = (rel) => (rel === 'src/a.ts' ? 10 : undefined)
  const refs = scanRefs('看 `a.ts:9` 与 `a.ts:11`')
  const bad = danglingRefs(refs, fake)
  assert.deepEqual(bad.map((d) => d.raw), ['a.ts:11'], '正好点名越界那条，不误报界内那条')
})

test('v214 ⑤ can-red: 区间尾端越界必须被点名', () => {
  const fake = (rel) => (rel === 'src/a.ts' ? 10 : undefined)
  const bad = danglingRefs(scanRefs('`a.ts:8-12`'), fake)
  assert.deepEqual(bad.map((d) => d.why), ['past-eof'])
  assert.deepEqual(danglingRefs(scanRefs('`a.ts:1-10`'), fake), [], '正好落在末尾不算越界')
})

test('v214 ⑥ can-red: 区间写反必须被点名（换了个错法也是错）', () => {
  const fake = (rel) => (rel === 'src/a.ts' ? 100 : undefined)
  assert.deepEqual(danglingRefs(scanRefs('`a.ts:50-10`'), fake).map((d) => d.why), ['range-reversed'])
})

test('v214 ⑦ can-red: 解析不到的文件必须跳过，不能猜', () => {
  const fake = () => undefined
  assert.deepEqual(danglingRefs(scanRefs('`nowhere.ts:99999`'), fake), [])
})

test('v214 ⑧ can-red: 冻结表增一条或减一条都必须红', () => {
  const frozen = ['a|X:1', 'b|Y:2']
  assert.deepEqual(frozenSetDiff(['a|X:1', 'b|Y:2', 'c|Z:3'], frozen).extra, ['c|Z:3'], '多出来要报')
  assert.deepEqual(frozenSetDiff(['a|X:1'], frozen).missing, ['b|Y:2'], '少了要报')
  assert.deepEqual(frozenSetDiff(['a|X:1', 'b|Y:2'], frozen), { extra: [], missing: [] }, '一致时不报')
  // 重复项也计次：「删一条旧的、加一条新的」在总数上相同，逐条冻结才抓得住
  const dup = ['a|X:1', 'a|X:1']
  const { extra, missing } = frozenSetDiff(['a|X:1', 'b|Y:2'], dup)
  assert.deepEqual(extra, ['b|Y:2'])
  assert.deepEqual(missing, ['a|X:1'])
})
