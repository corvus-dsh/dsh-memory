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
 * `max` 是当前文档里这类引用的**条数**。只能减，不能增（增了说明又有人手抄了一个旧行号）。
 * 每次真的减下来，就把 max 收紧到新值 —— 这是棘轮，不是自觉。
 */
export const SPLIT_FILES = new Map([
  ['src/store.ts', {
    max: 26,
    reason:
      'store.ts 从 2479 行拆到 374 行（第0步 / B / A3 / A1 / A2）。docs/ 里的 '
      + '`store.ts:2215` 之类的引用是**写那份分析时的坐标**，改写它们等于篡改历史记录。'
      + '因此按「冻结条数 + 写明理由」处理：只许减不许增。新写的引用请用符号名。',
  }],
])

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

/** 按目标文件分桶：被拆分文件里超出 `max` 的部分要单独报。 */
export const splitFileOverBudget = (dangling, splitFiles) => {
  const used = new Map()
  for (const d of dangling) used.set(d.target, (used.get(d.target) ?? 0) + 1)
  const over = []
  for (const [target, entry] of splitFiles) {
    const n = used.get(target) ?? 0
    if (n > entry.max) over.push({ target, max: entry.max, now: n })
  }
  return over
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
  const exempt = dangling.filter((d) => SPLIT_FILES.has(d.target))
  const bad = dangling.filter((d) => !SPLIT_FILES.has(d.target))
  const detail = bad.map((d) => `${d.doc}: ${d.raw}  → ${d.target} 现在只有 ${d.lines} 行`)
  assert.deepEqual(detail, [],
    '这些文档里的行号引用指向了文件尾之外 —— 读者照过去会看到不存在的位置。'
    + '处置：改用**符号名**定位（裁定④），行号只在括号里给当前值，或干脆不给：\n  '
    + detail.join('\n  '))
  // 兜底：确认扫描不是空转（docs 里确实有成百上千处引用，其中必然有能解析的）
  assert.ok(exempt.length > 0 || bad.length === 0, 'sanity: 至少扫到了东西')
})

test('v214 ②: 被拆分文件（store.ts）的旧行号引用只许减不许增', (t) => {
  const dangling = allDangling()
  const over = splitFileOverBudget(dangling, SPLIT_FILES)
  assert.deepEqual(over.map((o) => `${o.target}: 冻结 ${o.max}，现有 ${o.now}`), [],
    '已登记为「被拆分文件」的旧行号引用增加了 —— 说明又有人手抄了一个过时行号。'
    + '新增引用请用符号名；只有真的清理掉一条时，才把 SPLIT_FILES 的 max 收紧。')
  // 减少时提示收紧（不判红，只是让棘轮能继续前进）
  for (const [target, entry] of SPLIT_FILES) {
    const now = dangling.filter((d) => d.target === target).length
    if (now < entry.max) t.diagnostic(`${target}: 旧行号引用已降到 ${now}（冻结 ${entry.max}）— 可以把 max 收紧到 ${now}`)
  }
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

test('v214 ⑧ can-red: 被拆分文件的条数涨了必须红', () => {
  const split = new Map([['src/store.ts', { max: 2, reason: 'x' }]])
  const dangling = [
    { target: 'src/store.ts' }, { target: 'src/store.ts' }, { target: 'src/store.ts' },
  ]
  assert.deepEqual(splitFileOverBudget(dangling, split).map((o) => o.now), [3])
  assert.deepEqual(splitFileOverBudget(dangling.slice(0, 2), split), [], '等于上限不算超')
})
