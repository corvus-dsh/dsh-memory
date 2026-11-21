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
 * Every copy of this bug reads `:<something>:<backslash>s*(` in the source — the regex literal or the
 * template that builds one. So the check is for that sequence as it appears in code. A `\s*` elsewhere
 * (JSON formatting, indentation, a `.replace`) is not a frontmatter read and must not be flagged: a
 * rule that is noisy about things it does not mean gets switched off.
 *
 * ── W5-2: THE SAME BUG HAS TWO SPELLINGS, AND THE FIRST VERSION ONLY MATCHED ONE ──────────────
 *
 * Measured 2026-11-21 (B4-0b-2 W5-2, the week this gate shipped): `FORBIDDEN` was `/:\\s\*\(/u` —
 * exactly one backslash — because the copies that had been fixed were regex LITERALS:
 *
 *     /^aliases:\s*(.+)$/mu                     ← source text has ONE backslash
 *
 * A copy written as a TEMPLATE LITERAL spells the same regex with TWO:
 *
 *     new RegExp(`^${key}:\\s*(.+)$`, 'mu')     ← source text has TWO
 *
 * The gate was GREEN over three files that carried the bug (`src/archive.ts` , `src/store.ts`,
 * `src/store/skill.ts` — the interpolated-key helper is the most natural way to write a new copy).
 * This is the same family as `v284 ④`: a check whose dimension cannot tell the right answer from the
 * wrong one. `[\\]+` accepts both spellings; the self-test below pins the two-backslash case, which is
 * the one that was invisible.
 */
const FORBIDDEN = /:[\\]+s\*\(/u

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
 * ── W5-2b: THE BASELINE IS A SET OF LINES, NOT A COUNT ─────────────────────────────────────────
 *
 * The first version recorded `file → count` and compared `observed > allowed`. Reproduced through this
 * very script (probe, then `v271`): DELETE one old read from `store/skill.ts` and ADD a different new one
 * — the count is unchanged, and the gate stays GREEN while a brand-new defect just landed.
 *
 * That is the same shape as A6: **a baseline that shrinks with the data cannot tell 「原班人马」 from
 * 「走一个来一个」**. It is also the shape the review named first for this batch, so the baseline is now
 * the SET OF NORMALISED LINE TEXTS per file:
 *
 *   · a line NOT in the set ⇒ RED (a new copy, even if a different line disappeared);
 *   · a line in the set that no longer exists ⇒ reported as "baseline can go DOWN", which is a prompt,
 *     not a failure (a fixed read SHOULD be removed from the baseline).
 *
 * Normalisation collapses runs of whitespace and trims, so re-indenting a line is not a "new" copy —
 * the identity of a read is its code, not its column.
 */
const normaliseLine = (text) => String(text).replace(/\s+/gu, ' ').trim()

const BASELINE_LINES = new Map([
  ['dedupe.ts', [
    "return text.match(/^(?:when_to_use|when):\\s*(.+)$/mu)?.[1] ?? ''",
  ]],
  ['edges.ts', [
    "const line = text.match(/^conflicts_with:\\s*(.+)$/mu)?.[1]",
  ]],
  ['retrieve/documents.ts', [
    "const sources = Number(text.match(/^sources:\\s*(\\d+)$/mu)?.[1] ?? '1')",
    "const updated = text.match(/^updated:\\s*(.+)$/mu)?.[1] ?? text.match(/^created:\\s*(.+)$/mu)?.[1]",
    "const inlineConflicts = (text.match(/^conflicts_with:\\s*(.+)$/mu)?.[1] ?? '')",
    "const scopeText = (text.match(/^scope:\\s*(.+)$/mu)?.[1] ?? '').trim().toLowerCase()",
    "const workspace = normalizeWorkspace(text.match(/^workspace:\\s*(.+)$/mu)?.[1] ?? '')",
    "const domainText = (text.match(/^domain:\\s*(.+)$/mu)?.[1] ?? '').trim().toLowerCase()",
    "const lastValidated = text.match(/^last_validated:\\s*(.+)$/mu)?.[1]",
    "const sceneText = (text.match(/^scene:\\s*(.+)$/mu)?.[1] ?? '').trim().toLowerCase()",
    "const confidenceValue = Number(text.match(/^confidence:\\s*(.+)$/mu)?.[1] ?? '1')",
    "const generationValue = Number(text.match(/^generation:\\s*(\\d+)$/mu)?.[1] ?? '')",
    "const commitText = (text.match(/^commitHash:\\s*([0-9a-f]{7,40})$/mu)?.[1] ?? '').trim()",
    "const evidenceRaw = text.match(/^evidence:\\s*(.+)$/mu)?.[1] ?? ''",
  ]],
  ['retrieve/interning.ts', [
    "return text.match(/^when_to_use:\\s*(.+)$/mu)?.[1] ?? text.match(/^when:\\s*(.+)$/mu)?.[1] ?? ''",
  ]],
  ['store/lifecycle.ts', [
    "const scope = (text.match(/^scope:\\s*(.+)$/mu)?.[1] ?? 'project').trim().toLowerCase()",
    "const previous = clampConfidence(text.match(/^confidence:\\s*(.+)$/mu)?.[1])",
    "const line = text.match(/^evidence:\\s*(.+)$/mu)",
  ]],
  ['store/skill.ts', [
    "const when = text.match(/^when_to_use:\\s*(.+)$/mu)?.[1] ?? text.match(/^when:\\s*(.+)$/mu)?.[1] ?? ''",
    "const description = text.match(/^description:\\s*(.+)$/mu)?.[1] ?? when",
    "const evidence = parseEvidenceField(text.match(/^evidence:\\s*(.+)$/mu)?.[1] ?? '', '')",
    "const scopeText = (text.match(/^scope:\\s*(.+)$/mu)?.[1] ?? '').trim().toLowerCase()",
    "const sceneText = (text.match(/^scene:\\s*(.+)$/mu)?.[1] ?? '').trim().toLowerCase()",
    "const domainText = (text.match(/^domain:\\s*(.+)$/mu)?.[1] ?? '').trim().toLowerCase()",
    "const confidence = clampConfidence(text.match(/^confidence:\\s*(.+)$/mu)?.[1])",
    "const aliases = (text.match(/^aliases:\\s*(.+)$/mu)?.[1] ?? '').split(/,/u).map((item) => item.trim()).filter(Boolean)",
    "const tags = asVocab(text.match(/^tags:\\s*(.+)$/mu)?.[1] ?? '')",
    "const nodeTypes = asVocab(text.match(/^applicable_node_types:\\s*(.+)$/mu)?.[1] ?? '')",
    "const previousEvidence = parseEvidenceField(previousText.match(/^evidence:\\s*(.+)$/mu)?.[1] ?? '', meta.sessionId)",
    "const sources = Number(previousText.match(/^sources:\\s*(\\d+)$/mu)?.[1] ?? '1')",
    "const created = previousText.match(/^created:\\s*(.+)$/mu)?.[1] ?? ''",
    "const lastUsed = previousText.match(/^last_used:\\s*(.+)$/mu)?.[1] ?? undefined",
    "const lastValidated = previousText.match(/^last_validated:\\s*(.+)$/mu)?.[1] ?? undefined",
  ]],
])

/**
 * ── W5-2c: A SET CANNOT SEE MULTIPLICITY — SO THE BASELINE IS A MULTISET ────────────────────────
 *
 * W5-2b replaced a per-file COUNT with a Set of normalised line texts, which closed the swap ("remove
 * one different one, add one"). Reproduced immediately afterwards (probe, then `v272 ①`): the most natural
 * way to create a new read is to COPY AN EXISTING LINE — same template, same field — and a copied line is
 * byte-identical to one already in the baseline. The count rose 33 → 34 and the gate stayed GREEN, because
 * `Set.has` answers "does this text appear at all", not "how many times".
 *
 * So the baseline is now `Map<normalisedLine, count>` — a MULTISET. Both directions are still honest:
 *
 *   observed > baseline  ⇒ RED   (a duplicate is a new copy, whatever its text)
 *   observed < baseline  ⇒ GREEN + "baseline can go DOWN" (fixing one is good news)
 *
 * This is the third shape of the same baseline (count → set → multiset), and each step was found by
 * asking "what does this comparison NOT see" rather than by waiting for a failure.
 */
const BASELINE = new Map(
  [...BASELINE_LINES].map(([file, lines]) => {
    const counts = new Map()
    for (const line of lines) {
      const key = normaliseLine(line)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [file, counts]
  }),
)

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
    { name: 'a regex LITERAL (one backslash in source)', line: "const v = text.match(/^aliases:\\s*(.+)$/mu)?.[1]", expect: true },
    /**
     * ── THE CASE THAT WAS MISSING, AND THE THREE FILES IT HID ──────────────────────────────────
     *
     * A template literal spells `\s` with TWO backslashes in the source text. The first version of
     * this gate matched one, so it was green over `archive.ts`, `store.ts` and `store/skill.ts`.
     * Written here with four because this string literal needs two to produce two.
     */
    { name: 'a template literal (TWO backslashes in source, the ignored spelling)', line: "const field = (key) => (text.match(new RegExp(`^${key}:\\\\s*(.+)$`, 'mu'))?.[1] ?? '').trim()", expect: true },
    { name: 'a numeric field', line: "const n = text.match(/^sources:\\s*(\\d+)$/mu)?.[1]", expect: true },
    { name: 'THE FIX, regex literal', line: "const v = text.match(/^aliases:[ \\t]*(.+)$/mu)?.[1]", expect: false },
    { name: 'THE FIX, template literal', line: "const field = (key) => readFrontmatterField(text, key)", expect: false },
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

/**
 * ── THE COMPARISON: MULTIPLICITY, NOT MEMBERSHIP ───────────────────────────────────────────────
 *
 * `violations` = a line observed MORE TIMES than the baseline records it for. This is what catches both
 * shapes the two earlier baselines missed:
 *
 *   · a DIFFERENT new line (W5-2b) — its text is not in the baseline at all, observed 1 > 0;
 *   · a COPIED line (W5-2c) — its text IS in the baseline, but observed 2 > 1.
 *
 * `improveable` = a line observed FEWER times than recorded. That is GOOD NEWS — the file got fixed — and
 * the script says so instead of failing, because failing would punish the person who removed the defect.
 */
const observedByFile = new Map()
for (const finding of findings) {
  if (!observedByFile.has(finding.file)) observedByFile.set(finding.file, [])
  observedByFile.get(finding.file).push(finding)
}

const violations = []
for (const [file, observed] of observedByFile) {
  const allowed = BASELINE.get(file) ?? new Map()
  const seen = new Map()
  for (const finding of observed) {
    const key = normaliseLine(finding.text)
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    const permitted = allowed.get(key) ?? 0
    if (count > permitted) {
      violations.push({
        file,
        line: finding.line,
        text: finding.text,
        observed: count,
        permitted,
      })
    }
  }
}

const improveable = []
for (const [file, allowed] of BASELINE) {
  const seen = new Map()
  for (const finding of observedByFile.get(file) ?? []) {
    const key = normaliseLine(finding.text)
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  const gone = []
  for (const [line, permitted] of allowed) {
    const observedCount = seen.get(line) ?? 0
    if (observedCount < permitted) gone.push({ line, observed: observedCount, permitted })
  }
  if (gone.length > 0) improveable.push({ file, gone })
}

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ findings, violations, improveable }, null, 2) + '\n')
} else if (violations.length > 0) {
  process.stdout.write('frontmatter-reads: FAILED — frontmatter read(s) beyond the recorded multiplicity\n')
  for (const violation of violations) {
    process.stdout.write(
      `  ${violation.file}:${violation.line}  ` +
        `(this line now occurs ${violation.observed}×, baseline ${violation.permitted}×)\n`,
    )
    process.stdout.write(`    ${violation.text.slice(0, 120)}\n`)
  }
  process.stdout.write('\n')
  process.stdout.write(`The rule: read through readFrontmatterField (${HELPER_FILE}), which uses [ \\t]*.\n`)
  process.stdout.write('The baseline is a MULTISET: copying an existing read is still a new read.\n')
} else {
  process.stdout.write(
    `frontmatter-reads: OK — ${findings.length} known read(s) across ${observedByFile.size} file(s), none new\n`,
  )
  if (improveable.length > 0) {
    process.stdout.write('  (baseline can go DOWN — these recorded reads are gone; delete them from BASELINE_LINES)\n')
    for (const item of improveable) {
      for (const gone of item.gone) {
        process.stdout.write(`    ${item.file}: ${gone.line.slice(0, 90)} (${gone.permitted}× → ${gone.observed}×)\n`)
      }
    }
  }
}
process.exitCode = violations.length === 0 ? 0 : 1
