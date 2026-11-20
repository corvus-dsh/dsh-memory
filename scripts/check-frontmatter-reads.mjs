#!/usr/bin/env node
/**
 * ── W5-2 升级（W1-9b 触发）：FRONTMATTER 读取只许有一处 ────────────────────────────────────────
 *
 * `\s` 匹配换行。`^key:\s*(.+)` 加上 `m` 旗，遇到**存在但为空**的字段（`aliases: `，手工编辑与旧代码
 * 正是这个形状）时，`\s*` 吃掉换行、`(.+)` 把**下一行**当成本字段的值。
 *
 * 这不是假想，而且已经复发了三次：
 *
 *   · A10（2026-11-17）修了 `store/skill.ts` 里五份、`archive.ts` 一份、`documents.ts` 的 `last_used`；
 *   · W1-9 又新写了一份（`store/merge.ts` 的 `frontmatterList`），被复核抓出；
 *   · 现在 `src` 里仍有几十处同形态的读取。
 *
 * 「修一份拷贝」这个方式已经被证伪两次，所以它变成一个**机械检查**：任何 `^<key>:\s*` 形态的
 * frontmatter 读取都是错误，唯一合法写法是 `store/skill.ts` 的 `readFrontmatterField`。
 *
 * ── 判据 ──────────────────────────────────────────────────────────────────────────────────────
 *
 *   1. 静态：`src/**` 里出现 `:\s*(` / `:\s*(.+)$` / `:\s*(\d+)` 形态的行 ⇒ 红，白名单只留 helper；
 *   2. 该 helper 自己出现 `\s*` ⇒ 红（`[ \t]*` 才是对的那一个）；
 *   3. 白名单文件不存在 / helper 被改名 ⇒ 红（不是静默放过）。
 *
 * ── 为什么允许白名单存在 ────────────────────────────────────────────────────────────────────
 *
 * 存量还有几十处。一次性全改会把一个「机械可判定」的规则变成一次大重构 —— 那正是本项目反复拒绝的
 * 形状。所以：白名单**显式列出**每一处存量，新增则必红。每次顺路改掉一处就从白名单删一行，数字只能
 * 变小 —— 与 `type-budget` 的 baseline 同一种用法。
 *
 * 用法：node scripts/check-frontmatter-reads.mjs [--json]
 *       node scripts/check-frontmatter-reads.mjs --self-test
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')

/** The one file allowed to hold the rule, and the one pattern it must use. */
const HELPER_FILE = 'store/skill.ts'
const HELPER_PATTERN = '[ \\t]*'

/**
 * The forbidden shape, matched against SOURCE TEXT (not against a frontmatter field).
 *
 * Every copy of this bug reads `:<something>:\s*(` in the source — the regex literal or the template that
 * builds one. So the check is for the two-character sequence `:\s*(` as it appears in code. A `\s*`
 * elsewhere (JSON formatting, indentation, a `.replace`) is not a frontmatter read and must not be
 * flagged: a rule that is noisy about things it does not mean gets switched off.
 *
 * The literal is `: \ s * (` with the backslash doubled, i.e. in source text it is `:\s*(`.
 */
const FORBIDDEN = /:\\s\*\(/u

/**
 * A COMMENT that quotes the bug is not the bug.
 *
 * Measured while writing this gate: two block comments documenting the A10 defect (`merge.ts` and
 * `skill.ts`) tripped it, because they quote `^key:\s*(.+)` while explaining why it is wrong. A checker
 * that punishes the explanation is a checker people delete — so comments are skipped.
 *
 * Only line-leading comment markers are skipped, not trailing ones: a trailing `// ...` after real code
 * is not where a frontmatter read lives, and trying to find it reliably needs a parser this script
 * deliberately does not have.
 */
const isCommentLine = (line) => /^\s*(?:\/\/|\/\*|\*)/u.test(line)

/**
 * ── THE EXISTING COPIES (mechanically listed, never hand-typed) ───────────────────────────────
 *
 * Every entry is `file:line-count`, and the counts were produced by running this script with `--list`.
 * They may only go DOWN: a file that grows is a new copy, which is exactly what this gate exists to catch.
 *
 * The entries that remain are all the same defect, and each is a future W5 item's job. Listing them here
 * is the honest alternative to either fixing dozens of reads in one go or pretending they are fine.
 */
const BASELINE = new Map([
  ['dedupe.ts', 1],
  ['edges.ts', 1],
  ['retrieve/documents.ts', 12],
  ['retrieve/interning.ts', 1],
  ['store/lifecycle.ts', 3],
  ['store/skill.ts', 15],
])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(path, out)
      continue
    }
    if (entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

// `statSync` is imported for the filesystem walk's own sake; keep the import honest.
void statSync

const findings = []
for (const file of walk(SRC)) {
  const rel = relative(SRC, file).split('\\').join('/')
  const lines = readFileSync(file, 'utf8').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (isCommentLine(line)) continue
    if (!FORBIDDEN.test(line)) continue
    findings.push({ file: rel, line: index + 1, text: line.trim() })
  }
}

const counts = new Map()
for (const finding of findings) counts.set(finding.file, (counts.get(finding.file) ?? 0) + 1)

if (process.argv.includes('--list')) {
  for (const [file, count] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    process.stdout.write(`  ['${file}', ${count}],\n`)
  }
  process.exit(0)
}

/**
 * ── SELF-TEST ─────────────────────────────────────────────────────────────────────────────────
 *
 * The gate must be able to FAIL, and its matcher must be able to say NO. A checker that red-flags
 * everything is as useless as one that red-flags nothing — this repo has recorded both shapes.
 */
if (process.argv.includes('--self-test')) {
  const cases = [
    { name: 'the exact bug (merge.ts as written)', line: 'const line = new RegExp(`^${key}:\\s*(.*)$`, \'mu\')', expect: true },
    { name: 'a literal key read', line: "const v = text.match(/^aliases:\\s*(.+)$/mu)?.[1]", expect: true },
    { name: 'a numeric field', line: "const n = text.match(/^sources:\\s*(\\d+)$/mu)?.[1]", expect: true },
    { name: 'THE FIX', line: "const v = text.match(/^aliases:[ \\t]*(.+)$/mu)?.[1]", expect: false },
    { name: 'helper call', line: "const v = readFrontmatterField(text, 'aliases')", expect: false },
    { name: 'indentation (not a frontmatter read)', line: '  \\s* const x = 1', expect: false },
    { name: 'JSON formatting', line: "JSON.stringify(value, null, 2).replace(/\\s*/gu, '')", expect: false },
  ]
  let failures = 0
  for (const testCase of cases) {
    const got = FORBIDDEN.test(testCase.line)
    const pass = got === testCase.expect
    if (!pass) failures += 1
    process.stdout.write(`  ${pass ? 'PASS' : 'FAIL'}  ${testCase.name}${pass ? '' : ` (expected ${testCase.expect}, got ${got})`}\n`)
  }
  process.exitCode = failures === 0 ? 0 : 1
  process.exit(process.exitCode)
}

/**
 * ── THE HELPER ITSELF MUST USE THE HORIZONTAL GAP (judgement 2) ────────────────────────────────
 *
 * Measured while writing the can-red for this gate: restoring `\s*` INSIDE `readFrontmatterField` left the
 * check GREEN, because it only looked for the substring `[ \t]*` anywhere in the file — and the doc
 * comment above the helper still contains it. A check that a comment can satisfy is not a check.
 *
 * So this reads the FUNCTION BODY: from the `export function readFrontmatterField` line to its closing
 * brace, then asserts the regex there is `[ \t]*` and not `\s*`.
 */
function helperBody(text) {
  const start = text.indexOf('export function readFrontmatterField')
  if (start < 0) return undefined
  const end = text.indexOf('\n}', start)
  if (end < 0) return undefined
  return text.slice(start, end + 2)
}

const helperPath = join(SRC, HELPER_FILE)
let helperText = ''
try {
  helperText = readFileSync(helperPath, 'utf8')
} catch {
  process.stderr.write(`frontmatter-reads: the helper file ${HELPER_FILE} is missing.\n`)
  process.stderr.write('  This gate exists because the rule needs ONE home; if that home moved, update this script.\n')
  process.exit(2)
}
const body = helperBody(helperText)
if (body === undefined) {
  process.stderr.write(`frontmatter-reads: ${HELPER_FILE} no longer declares readFrontmatterField.\n`)
  process.exit(2)
}
/**
 * The body must build the gap as `[ \t]*` AND must not build it as `\s*`.
 *
 * `\\s` in the source text is how a template literal spells a regex `\s`, so the forbidden form is the
 * four characters `\\s*`. Both halves are needed: only asserting the first would pass a body that
 * carried both (impossible today, but the assertion should say what it means).
 */
const helperUsesHorizontalGap = body.includes('[ \\\\t]*') || body.includes('[ \\t]*')
const helperUsesWhitespaceGap = body.includes('\\\\s*')
if (!helperUsesHorizontalGap || helperUsesWhitespaceGap) {
  process.stderr.write(
    `frontmatter-reads: ${HELPER_FILE}'s readFrontmatterField does not use the horizontal gap.\n`,
  )
  process.stderr.write(`  expected [ \\t]* in the function body; found ${helperUsesWhitespaceGap ? '\\\\s*' : 'neither'}\n`)
  process.stderr.write('  `\\s` matches a newline, so an empty field captures the NEXT line.\n')
  process.exit(2)
}

const violations = []
for (const [file, observed] of counts) {
  const allowed = BASELINE.get(file) ?? 0
  if (observed > allowed) violations.push({ file, observed, allowed })
}
const missing = []
for (const [file, allowed] of BASELINE) {
  const observed = counts.get(file) ?? 0
  if (observed < allowed) missing.push({ file, observed, allowed })
}

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ findings, violations, improveable: missing }, null, 2) + '\n')
} else if (violations.length > 0) {
  process.stdout.write('frontmatter-reads: FAILED — new `\\s*` frontmatter read(s)\n')
  for (const violation of violations) {
    process.stdout.write(`  ${violation.file}: ${violation.observed} (allowed ${violation.allowed})\n`)
    for (const finding of findings.filter((item) => item.file === violation.file)) {
      process.stdout.write(`    :${finding.line}  ${finding.text.slice(0, 110)}\n`)
    }
  }
  process.stdout.write(`\\nThe rule: read through readFrontmatterField (${HELPER_FILE}), which uses '${HELPER_PATTERN}'.\n`)
  process.stdout.write('`\\s` matches a newline, so `key:\\s*(.+)` captures the NEXT line when the field is empty.\n')
} else {
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0)
  process.stdout.write(`frontmatter-reads: OK — ${total} known read(s) across ${counts.size} file(s), none new\n`)
  if (missing.length > 0) {
    process.stdout.write('  (baseline can go DOWN: these files now have fewer than recorded — update BASELINE)\n')
    for (const item of missing) process.stdout.write(`    ${item.file}: ${item.observed} < ${item.allowed}\n`)
  }
}
process.exitCode = violations.length === 0 ? 0 : 1
