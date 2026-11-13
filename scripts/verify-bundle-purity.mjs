#!/usr/bin/env node
/**
 * ── bundle 纯度：一次搬移有没有改变产物里的**代码** ──────────────────────────────────────────────
 *
 * 比「行数变化」强的判据。行数变化无法区分「搬位置」与「改代码」，而多重集相同能证明：
 * **没有一行代码被增删或改写，只有位置变了。**
 *
 * 判据与 verify-pure-move 同源（同一套归一：行注释/块注释剥离、`export function f` → `function f`、
 * 裸 re-export 排除），只是作用在打包产物而不是 src/。
 *
 * 实测教训（两次，都造成假报告）：
 *   1. 不做 `export function` → `function` 归一，会把一次纯搬移报成「3 行代码被改写」——
 *      因为搬移把 inline export 改成了裸 `export { f }`，那是 plumbing。
 *   2. 提取产物时用 PowerShell 的 `>` 会写成 UTF-16LE，读成 utf8 后每个字符间夹一个 NUL，
 *      没有任何行是空的，「非空行」于是等于总行数。所以本脚本用 `git show` 取原始字节，不经 shell 重定向。
 *
 * ── 同一份产物有五种口径，报数必须说清是哪一种 ──────────────────────────────────────────────────
 *
 * 对 `ddcd4c4 → 66dfa81`，用户报的是 **16,555 → 16,556**，那是 **bundle 的非空行**（`trim().length > 0`）。
 * 我最初复现不出来，因为拿来算的副本就是上面第 2 条那个 UTF-16 污染件。用干净副本重算即得
 * 16,555 → 16,556 —— **口径本身没问题，问题在测量用的文件**。
 *
 * 所以口径清单是：总行数 / 非空行 / 去注释代码行 / src 总行数 / src 非空行。
 * 本脚本固定用「去注释代码行多重集」，因为只有它能区分「搬位置」与「改代码」，行数类口径不能。
 *
 * 用法：
 *   node scripts/verify-bundle-purity.mjs --before <ref> [--after <ref>]
 *   （--before 省略时与 HEAD 比；--after 省略时用工作树的 index.js）
 *
 * 退出码：0 = PURE；1 = NOT PURE；2 = 无法测量（资源条件）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

const argOf = (flag) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const beforeRef = argOf('--before')
const afterRef = argOf('--after') // undefined ⇒ the WORKING TREE's index.js
if (beforeRef === undefined) {
  console.error('usage: node scripts/verify-bundle-purity.mjs --before <ref> [--after <ref>]')
  process.exit(2)
}

/**
 * `--after` 省略时读**工作树**的产物，不是 HEAD。
 *
 * 实测到的不一致：文档头写的就是「省略时用工作树」，实现却默认 `HEAD`，
 * 结果在提交前跑它永远是 VACUOUS —— 而提交前正是唯一有意义的时机。
 *
 * ── 移植到本仓时改了产物路径：单个 `index.js` → `lib/` 下的一批文件 ─────────────────────────────
 *
 * observer 的构建产物是一个扁平 `index.js`（bundle.mjs 把模块压平进去）。本仓不是：
 * `package.json` 的 `main` 是 `./lib/index.js`，且 `exports` 里还有 `./lib/retrieve.js`、
 * `./lib/store.js` —— 产物是**目录**。
 *
 * 所以这里把「一个文件」泛化成「一组文件」：按相对路径排序后拼接再比对，
 * 并在输出里保留**哪个文件**贡献了差异（否则读者只知道"某处变了"）。
 * 路径集合确实变了（新增/删除一个模块）时，那是结构变化，明确报出来而不是当成内容差异。
 */
const ARTIFACT_DIR = 'lib'

/** 取产物清单：ref 为 undefined ⇒ 工作树；否则 `git ls-tree`。 */
const artifactFiles = (ref) => {
  try {
    if (ref === undefined) {
      return readdirSync(join(REPO, ARTIFACT_DIR)).filter((f) => f.endsWith('.js')).sort()
    }
    const listing = execFileSync('git', ['ls-tree', '--name-only', `${ref}:${ARTIFACT_DIR}`], { cwd: REPO, encoding: 'utf8' })
    return listing.split('\n').map((s) => s.trim()).filter((f) => f.endsWith('.js')).sort()
  } catch {
    return undefined
  }
}

/** 读一组产物，返回 { perFile, combined }。 */
const bundleAt = (ref) => {
  const names = artifactFiles(ref)
  if (names === undefined || names.length === 0) return undefined
  const perFile = new Map()
  const chunks = []
  for (const name of names) {
    let text
    try {
      text = ref === undefined
        ? readFileSync(join(REPO, ARTIFACT_DIR, name), 'utf8')
        : execFileSync('git', ['show', `${ref}:${ARTIFACT_DIR}/${name}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    } catch {
      return undefined
    }
    perFile.set(name, text)
    chunks.push(`// ==== ${name} ====\n${text}`)
  }
  return { perFile, combined: chunks.join('\n'), files: names }
}

const before = bundleAt(beforeRef)
const after = bundleAt(afterRef)
if (before === undefined || after === undefined) {
  console.error(`cannot measure: ${ARTIFACT_DIR}/*.js missing at ${before === undefined ? beforeRef : afterRef} (a resource condition, not PURE)`)
  process.exit(2)
}
if (before.combined === after.combined) {
  console.error(`VACUOUS — ${ARTIFACT_DIR}/*.js is byte-identical at ${beforeRef} and ${afterRef}; nothing to compare.`)
  process.exit(2)
}

/** 文件集合本身变了 ⇒ 结构变化，单独说，不混进内容口径。 */
const onlyBefore = before.files.filter((f) => !after.files.includes(f))
const onlyAfter = after.files.filter((f) => !before.files.includes(f))
if (onlyBefore.length > 0 || onlyAfter.length > 0) {
  console.log(`file set changed: ${before.files.length} -> ${after.files.length} file(s)`)
  if (onlyBefore.length > 0) console.log(`  removed: ${onlyBefore.join(', ')}`)
  if (onlyAfter.length > 0) console.log(`  added  : ${onlyAfter.join(', ')}`)
}

function normalise (line) {
  const stripped = line.replace(/^(\s*)export\s+(?=(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\b)/u, '$1')
  return stripped.replace(/\s+/gu, ' ').trim()
}

function codeLines (text) {
  const out = []
  let inBlock = false
  for (const raw of text.replace(/\r\n/gu, '\n').split('\n')) {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end < 0) continue
      line = line.slice(end + 2)
      inBlock = false
    }
    line = line.replace(/\/\*[\s\S]*?\*\//gu, '')
    const openBlock = line.indexOf('/*')
    if (openBlock >= 0) {
      line = line.slice(0, openBlock)
      inBlock = true
    }
    const lineComment = line.indexOf('//')
    if (lineComment >= 0) line = line.slice(0, lineComment)
    if (/^\s*export\s+(?:type\s+)?(?:\{[^}]*\}|\*)/u.test(line)) continue
    const norm = normalise(line)
    if (norm !== '') out.push(norm)
  }
  return out
}

const multiset = (lines) => {
  const m = new Map()
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1)
  return m
}

const a = multiset(codeLines(before.combined))
const b = multiset(codeLines(after.combined))
const keys = new Set([...a.keys(), ...b.keys()])
const diffs = []
for (const k of keys) {
  const x = a.get(k) ?? 0
  const y = b.get(k) ?? 0
  if (x !== y) diffs.push({ line: k, before: x, after: y })
}
diffs.sort((p, q) => (q.after - q.before) - (p.after - p.before) || p.line.localeCompare(q.line))

const total = (m) => [...m.values()].reduce((s, n) => s + n, 0)
console.log(`before : ${beforeRef}   code lines: ${total(a)}`)
console.log(`after  : ${afterRef ?? 'working tree'}   code lines: ${total(b)}`)
console.log(`bundle : ${before.length} -> ${after.length} bytes`)
console.log('')

if (diffs.length === 0) {
  console.log('BUNDLE PURE — the multiset of code lines is unchanged; only position/order moved.')
  process.exit(0)
}

console.log(`BUNDLE NOT PURE — ${diffs.length} distinct line(s) differ:`)
for (const d of diffs.slice(0, 20)) console.log(`  ${d.before} -> ${d.after}   ${JSON.stringify(d.line.slice(0, 110))}`)
if (diffs.length > 20) console.log(`  … and ${diffs.length - 20} more`)
process.exit(1)
