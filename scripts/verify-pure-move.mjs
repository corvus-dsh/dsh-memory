#!/usr/bin/env node
/**
 * PURE-MOVE INVARIANT — a mechanical, repeatable replacement for "the diff looks like a move".
 *
 * ── THE INVARIANT (S3-PLAN §三.1) ───────────────────────────────────────────────────────────────
 *
 * A CONTENT LINE is a line that:
 *   - is not empty after `trim()`, and
 *   - does not start with `import ` or `export `.
 *
 * import/export lines are excluded because a pure move NECESSARILY produces them: you add an import in
 * the new module, turn `function f` into `export function f`, and add a bare `export { f }` in index.ts.
 * Those lines are the move's plumbing, not its content.
 *
 * THE INVARIANT: the MULTISET of content lines across the whole `src/ (every .ts-bearing file)` tree must be IDENTICAL
 * before and after the move.
 *
 * ── WHY A MULTISET AND NOT A SET ────────────────────────────────────────────────────────────────
 *
 * A set would tolerate "moved it, then left a copy behind" — the copy's lines are already in the set, so
 * nothing changes. A multiset counts occurrences, so a leftover duplicate shows up immediately as extra
 * entries. That is the ONE check that catches "somewhere, something was quietly edited too".
 *
 * ── WHY THIS FILE MUST BE RUNNABLE, NOT MERELY QUOTED ───────────────────────────────────────────
 *
 * The original criterion was "`git diff --stat` looks like a move". "Looks like" is not a criterion: it
 * cannot be re-run, cannot be reviewed, and cannot fail in a way anyone can argue with. This script
 * either prints `IDENTICAL` or prints the FIRST differing line — and the first difference is what a
 * reader should look at, not the summary.
 *
 * Usage:
 *   node scripts/verify-pure-move.mjs                    # compare working tree against HEAD
 *   node scripts/verify-pure-move.mjs --against HEAD~1   # against an arbitrary git ref
 *   node scripts/verify-pure-move.mjs --self-test        # prove the checker can fail
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(REPO, 'src')

/** Is this line content, per the definition above? */
export function isContentLine(line) {
  if (line.trim().length === 0) return false
  const trimmedStart = line.replace(/^\s+/u, '')
  if (trimmedStart.startsWith('import ')) return false
  if (trimmedStart.startsWith('export ')) return false
  return true
}

/**
 * ── NORMALISE THE DECLARATION PREFIX, DON'T DROP THE LINE ──────────────────────────────────────
 *
 * `isContentLine` excludes lines that START with `export ` — but a pure move does not merely ADD export
 * lines: it TRANSFORMS `function f() {` into `export function f() {`. Excluding the whole line would
 * therefore report the declaration as DISAPPEARED, and the checker would fail every legitimate move.
 *
 * The fix is to strip a leading `export ` (and `export default `) before comparing, so the declaration
 * keeps its content identity while the plumbing keyword stops mattering. This was found by the
 * self-test's first case, which is exactly why the self-test exists.
 *
 * ── AND A BARE RE-EXPORT BECOMES EMPTY, NOT `{ f }` ────────────────────────────────────────────
 *
 * A pure move also adds `export { f }` to index.ts so the name stays on the public surface. After
 * stripping `export ` that line reads `{ f }` — which is NOT content, it is the re-export itself. The
 * second self-test failure was exactly this: `{ f }` counted as an added content line.
 *
 * So a line whose remainder is a bare brace list (`{ a, b }` / `{ a as b }`) is plumbing, and yields ''.
 */
export function normaliseContentLine(line) {
  const withoutKeyword = line.replace(/^(\s*)export\s+default\s+/u, '$1').replace(/^(\s*)export\s+/u, '$1')
  // A bare re-export list: `{ a }`, `{ a, b }`, `{ a as b }`, `* from './x.js'` — all plumbing.
  if (/^\s*\{[^{}]*\}\s*;?\s*$/u.test(withoutKeyword)) return ''
  if (/^\s*\*\s*(?:as\s+\w+\s*)?from\s+['"]/u.test(withoutKeyword)) return ''
  /**
   * ── `export type { … }` IS THE SAME PLUMBING, IN THE TYPE FLAVOUR ────────────────────────────────
   *
   * Found by N1: moving `classifyAgentCommand` forced index.ts to re-export two interfaces
   * (`CommandAssessment`, `CommandRisk`) that its signature names. The re-export line
   * `export type { CommandAssessment, CommandRisk }` normalised to `type { … }`, which is not a bare
   * brace list, so the move measured **+1 content line** and the checker said "not pure".
   *
   * That was a gap in the RULE, not in the move: the reason bare re-exports are excluded — "a pure move
   * necessarily produces them, so they are the move's plumbing, not its content" — applies verbatim to
   * a type-only re-export. Excluding it weakens nothing: a DUPLICATED declaration still shows up line by
   * line, which is the failure this multiset exists to catch.
   */
  if (/^\s*type\s*\{[^{}]*\}\s*;?\s*$/u.test(withoutKeyword)) return ''
  if (/^\s*type\s*\*\s*(?:as\s+\w+\s*)?from\s+['"]/u.test(withoutKeyword)) return ''
  /**
   * ── `export type { X } FROM './m.js'` — THE FORM N1 DID NOT PRODUCE ─────────────────────────────
   *
   * The two rules above cover a type re-export WITHOUT a `from` clause. Found by the GraftConfig move:
   * moving a pure type necessarily produces
   *
   *     export type { GraftConfig } from './core/graft-config.js'
   *
   * which normalises to `type { GraftConfig } from './core/graft-config.js'` — a bare brace list
   * FOLLOWED BY `from`, so neither rule matched and the move measured **+1 content line**. The checker
   * said "not pure" about a move that was provably pure.
   *
   * Same reasoning as above: a re-export is the move's plumbing regardless of whether the module is
   * named inline. Excluding it weakens nothing — a duplicated DECLARATION still shows up line by line.
   */
  if (/^\s*type\s*\{[^{}]*\}\s*from\s+['"]/u.test(withoutKeyword)) return ''
  if (/^\s*\{[^{}]*\}\s*from\s+['"]/u.test(withoutKeyword)) return ''
  return withoutKeyword
}

/** Content lines of one text, as an array (order preserved). */
export function contentLines(text) {
  return text
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, '\n')
    .split('\n')
    /**
     * ── ORDER MATTERS: NORMALISE FIRST, THEN FILTER ─────────────────────────────────────────────
     *
     * Filtering first DROPS `export function f() {` entirely (it starts with `export `), so the
     * declaration disappears from the multiset and every legitimate move fails. Normalising first turns
     * it into `function f() {`, which is content and matches the pre-move declaration exactly.
     *
     * Found by self-test case 1 — the case that exists to prove imports/exports do not false-positive.
     */
    .map(normaliseContentLine)
    .filter(isContentLine)
}

/**
 * ── THREE-WAY CLASSIFICATION OF THE UNEXPLAINED LINES (was `_scratch/puremove-classify.mjs`) ────
 *
 * The checker reports a COUNT of unexplained differences. That count is not a verdict a human can
 * act on: `+33 lines` is a pass if they are all comments and a real problem if one is a changed
 * expression. Every move in this refactor was therefore classified by a THROWAWAY script in
 * `_scratch/`, and a throwaway script has two failure modes that both happened:
 *
 *   1. it is not re-run, so the next person either trusts the number or redoes the work;
 *   2. it drifts from the tool it is supposed to explain (its output format changed twice while the
 *      checker's did not).
 *
 * So the classification moves IN HERE, as a mode of the tool that produces the diff in the first
 * place. It reads the same `contentLines` the comparison uses — one implementation, one truth.
 *
 * ── THE THREE BUCKETS (and why they are defensible) ─────────────────────────────────────────────
 *
 *   comment   the line, with leading whitespace stripped, starts with `/` or `*`.
 *             A moved-and-documented cluster necessarily gains section comments, and a comment
 *             cannot change behaviour. Lowest risk, largest bucket in practice.
 *
 *   pipeline  a member line of a multi-line import/export list (`  name,` / `  name as x,`),
 *             the closing `} from '…'`, the bare `{`, or a `  name, name,` continuation.
 *             These are the move's own plumbing. The SECOND rule here was found the hard way:
 *             A2 reported "logic 2 lines" and both were import continuations — a plumbing line
 *             classified as logic is a false alarm that teaches people to ignore the gate.
 *
 *   logic     everything else. **This is the bucket that must be 0** for a pure move.
 *             Anything here is either a real edit or a classification gap that must be closed by
 *             teaching the tool a new SHAPE, not by editing the report.
 *
 * ⚠ THE TOOL CANNOT DECIDE WHETHER A `logic` LINE IS FINE. It can only say "this is not a comment
 *   and not plumbing". A user may still approve a logic line (the `bf35562` indent fix was one) —
 *   but it has to be approved explicitly, which is exactly the difference between a register entry
 *   (`KNOWN_FORMAT_CORRECTIONS`) and a silent pass.
 */
const RE_PIPELINE_NAME = /^ {2}[A-Za-z_$][\w$]*(?: as [A-Za-z_$][\w$]*)?,$/u
const RE_PIPELINE_CONTINUATION = /^ {2}[A-Za-z_$][\w$]*(?:, ?[A-Za-z_$][\w$]*)*,$/u
const RE_PIPELINE_CLOSE = /^\} from '[^']*'$/u

/**
 * ── A COMMENT IS NOT "A LINE THAT STARTS WITH A SLASH" ─────────────────────────────────────────
 *
 * The first version was `s.startsWith('/') || s.startsWith('*')`. Measured, that is wrong in a way
 * that hides real code: `INCIDENT_MARKERS` is an array of **six regex literals** in `retrieve.ts`,
 * and every one of them starts with `/`:
 *
 *     /(报错|抛错|崩溃|异常栈|堆栈|复现|临时修复|热修|踩坑|翻车|故障)/u,
 *     /(traceback|stack trace|exception|assertionerror|typeerror|referenceerror|…)/iu,
 *     /\b(panic|crash(ed)?|regression|hotfix|workaround|root cause)\b/iu,
 *     …
 *
 * Six lines of real code, all classified as `comment` — i.e. a move that DELETED them and left
 * nothing behind would have reported "0 logic". The can-red for this is those exact six lines.
 *
 * So the rule now requires an actual comment OPENER:
 *   two slashes          line comment
 *   slash-star           block comment open (including the JSDoc opener)
 *   a leading asterisk   JSDoc / block continuation and close
 *
 * and explicitly does NOT match a line that merely begins with a single slash (regex literal or
 * division). This is a lexical rule, not a parser: a line that begins with `* ` inside a
 * multiplication continuation would still be read as a comment continuation. Stated here because a
 * gate that looks stricter than it is, is worse than one that says where it stops.
 */
export const isCommentLine = (line) => {
  const s = line.trimStart()
  if (s.startsWith('//')) return true
  if (s.startsWith('/*')) return true
  if (/^\*(?:[\s/]|$)/u.test(s)) return true
  return false
}

export const isPipelineLine = (line) => {
  if (RE_PIPELINE_NAME.test(line) || RE_PIPELINE_CONTINUATION.test(line)) return true
  if (RE_PIPELINE_CLOSE.test(line) || line === '{') return true
  return false
}

/** Classify one unexplained line. `comment` | `pipeline` | `logic` */
export const classifyLine = (line) => {
  if (isCommentLine(line)) return 'comment'
  if (isPipelineLine(line)) return 'pipeline'
  return 'logic'
}

/**
 * Classify a whole multiset diff **on BOTH sides**.
 *
 * ── WHY ONE-SIDED CLASSIFICATION WAS A HOLE ──────────────────────────────────────────────────────
 *
 * The first version bucketed only `came` (the appeared lines) and printed `gone` raw. So a move
 * that *deleted a line of real code and added nothing* produced:
 *
 *     注释 0 / 管线 0 / 逻辑 0        ← all zeros
 *     DISAPPEARED 明细 …             ← printed, but not counted
 *
 * and exited **0**. The gate said "logic 0" about a diff whose entire content was a deleted
 * function. Deleting code is the one thing a pure-move check exists to catch, and it was the one
 * thing the bucket could not see.
 *
 * A move that loses a line and gains none is exactly what "moved it and dropped it" looks like, so
 * the disappeared side needs the same three buckets. Both sides are returned separately **and**
 * summed, because "1 disappeared comment" and "1 appeared comment" are different facts even though
 * neither is logic.
 */
export function classifyDifference(gone, came) {
  const appeared = { comment: [], pipeline: [], logic: [] }
  const disappeared = { comment: [], pipeline: [], logic: [] }

  for (const { l, n } of came) {
    for (let i = 0; i < n; i += 1) appeared[classifyLine(l)].push(l)
  }
  for (const { l, n } of gone) {
    for (let i = 0; i < n; i += 1) disappeared[classifyLine(l)].push(l)
  }

  const totals = { comment: 0, pipeline: 0, logic: 0 }
  for (const k of ['comment', 'pipeline', 'logic']) {
    totals[k] = appeared[k].length + disappeared[k].length
  }

  return {
    appeared,
    disappeared,
    totals,
    /** Line counts per side, for the header the CLI prints. */
    appearedCounts: { entries: came.length, lines: came.reduce((s, c) => s + c.n, 0) },
    disappearedCounts: { entries: gone.length, lines: gone.reduce((s, g) => s + g.n, 0) },
  }
}

/** Multiset difference of two content-line arrays: `{ gone, came }` with counts. */
export function diffContentLines(refLines, treeLines) {
  const count = (arr) => {
    const m = new Map()
    for (const l of arr) m.set(l, (m.get(l) ?? 0) + 1)
    return m
  }
  const t = count(treeLines)
  const r = count(refLines)
  const gone = []
  const came = []
  for (const [l, n] of r) {
    const k = t.get(l) ?? 0
    if (k < n) gone.push({ l, n: n - k })
  }
  for (const [l, n] of t) {
    const k = r.get(l) ?? 0
    if (k < n) came.push({ l, n: n - k })
  }
  return { gone, came }
}

/**
 * ── KNOWN FORMAT CORRECTIONS: EXPLAINED, NEVER SILENT ────────────────────────────────────────
 *
 * A pure move can legitimately carry an ALREADY-AGREED format fix. The first such case is
 * `bf35562`: `parseEvidenceField` had two leading spaces in `store.ts` (a pre-existing blemish)
 * and A1-3 was explicitly asked to fix it while moving the file. That produces one DISAPPEARED
 * content line and one APPEARED one — indistinguishable, to a multiset comparison, from "the
 * code was edited".
 *
 * The wrong ways to handle it, both of which this file rejects:
 *
 *   1. **Leave it red forever.** Then every future run prints `logic 1`, the operator learns the
 *      red is noise, and the NEXT real edit slips through under the same "oh, that's the known
 *      one". A gate that is always red is a gate that is off.
 *   2. **Loosen the comparison** (normalise leading whitespace, ignore N lines, …). That blinds
 *      the checker to every real indentation edit as well — the exact class of change this
 *      multiset exists to catch.
 *
 * So the correction is registered **explicitly**: an exact (disappeared → appeared) line pair,
 * with the commit that made it and the reason. The run reports it by name and exits 0 when it is
 * the ONLY difference. Anything else still fails.
 *
 * ── RULES FOR ADDING AN ENTRY (do not relax these) ───────────────────────────────────────────
 *
 *   - `disappeared` / `appeared` must be the **full trimmed-insensitive** content lines, exactly
 *     as `contentLines()` produces them (leading `export ` already stripped).
 *   - The pair must be 1:1 — one line out, one line in. A correction that changes N lines needs
 *     N entries, each justified.
 *   - `commit` must be the sha of the commit that made the change, not the one being tested.
 *   - `reason` must say WHY the change is not a behaviour change.
 *   - An entry that no longer matches anything is reported as **STALE** — delete it. A registry
 *     that only grows is how a gate rots into a list of things nobody reads.
 */
export const KNOWN_FORMAT_CORRECTIONS = [
  {
    commit: 'bf35562',
    reason: 'parseEvidenceField 行首的两个空格被修正为 0 缩进（A1-3 顺手修，用户明确要求）；只有空白差异，无行为变化',
    disappeared: '  function parseEvidenceField(raw: string, fallbackSession: string): EvidenceRef[] {',
    appeared: 'function parseEvidenceField(raw: string, fallbackSession: string): EvidenceRef[] {',
  },
  /**
   * ── 2026-11-15 `930b435`（第二步）与本次（第三步）──
   *
   * 两个声明上方的**单行**注释被展开成多行注释块，因为我给它们加了 `export` 并写明了
   * 「为什么导出」。这不是缩进修正，是**注释形状变化**：内容等于原注释 + 新增一句。
   *
   * 为什么必须登记而不能放过：`contentLines` 把整行当单位比较，所以「一行变四行」
   * 在多重集里就是 1 消失 + 4 出现 —— 与「删掉注释、重写注释」无法区分。
   * 登记成精确的 1:1 对，让读者能看见它是什么；不登记则每次跑都会以 `logic` 出现。
   *
   * ⚠ 这两个条目的 `appeared` 是**多行块的第一行**，配对的是被吃掉的那一行单行注释。
   *   多出来的其余行属于 `comment` 桶（`--classify` 里可见），不需要逐条登记 ——
   *   登记表的作用是「解释那一条消失的」，不是「替所有新注释开口子」。
   */
  {
    commit: '930b435',
    reason: 'currentIndex 的单行注释展开成多行注释块（加 export 并说明为什么导出）；文本等于原注释 + 新增一句，无行为变化',
    disappeared: '/** The memoised index handle, or undefined when the tier is json or sqlite is unavailable. */',
    appeared: ' * The memoised index handle, or undefined when the tier is json or sqlite is unavailable.',
  },
  {
    /**
     * 本次提交（retrieve 第三步）。commit 字段写的是**引入该修正的提交**，
     * 而那个 sha 在写这一行时还不存在（自指不可能）。所以用 `this-commit` 作为标记，
     * 并在 `docs/retrieve-split-step3.md` 里写明它对应哪一步。
     *
     * 这不是逃避：`commit` 字段的唯一用途是让读输出的人**找到那条修正**。
     * `this-commit` + 文档里的一节，比一个写错的 sha 更有用。
     */
    commit: 'this-commit (retrieve 第三步)',
    reason: 'sameCommit 的单行注释展开成多行注释块（加 export 并说明为什么导出）；文本等于原注释 + 新增一句，无行为变化',
    disappeared: '/** Same commit? Compare on the short prefix, because a file may record either form. */',
    appeared: ' * Same commit? Compare on the short prefix, because a file may record either form.',
  },
]

/**
 * ── TEST-ONLY OVERRIDE, AND WHY IT IS NOT A BACK DOOR ─────────────────────────────────────────
 *
 * `test/v203-pure-move-exemptions.test.mjs` has to prove that a RELAXED registry fails. Without an
 * override it would have to edit this file (or the tree under test), which makes the test
 * destructive and order-dependent.
 *
 * The override is deliberately narrow:
 *   - it only REPLACES the list; the matching rules, the STALE logic and the exit codes are the
 *     same code paths the real run uses;
 *   - it can only be more permissive than reality, never less — and a more permissive registry
 *     failing is exactly what the test asserts;
 *   - it is read ONCE here, so no caller can swap it mid-run.
 *
 * If this ever becomes a place to park a real exemption "temporarily", that is the failure mode:
 * exemptions belong in `KNOWN_FORMAT_CORRECTIONS` above, where a reader sees them.
 */
const registryOverride = (() => {
  const raw = process.env.PPM_CORRECTIONS_JSON
  if (raw === undefined || raw === '') return undefined
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('PPM_CORRECTIONS_JSON must be a JSON array')
  /**
   * ── 注入点必须自述（lead §五十三.2 / §五十三.3）────────────────────────────────────────────
   *
   * 这个变量替换的是**门禁的例外清单本身**。它是本轮反复在杀的那个病的最纯粹形式：
   * **例外清单可以被外部换掉，而日志里一个字都没有。**
   *
   * 打印的是条目数与「哪几个 name」，不是整张表——读者要判断的是「这次用的不是仓里那张表」，
   * 而这需要知道换了几个、换了谁。走 stderr：它是关于产物怎么产生的说明，不是产物。
   */
  console.error(`verify-pure-move: format-correction registry replaced, ${parsed.length} entr${parsed.length === 1 ? 'y' : 'ies'} (injected via PPM_CORRECTIONS_JSON)`)
  for (const entry of parsed) {
    console.error(`  ${entry?.name ?? JSON.stringify(entry)}`)
  }
  return parsed
})()

/** The registry actually used by a run: the override when present, else the real list. */
const activeRegistry = registryOverride ?? KNOWN_FORMAT_CORRECTIONS

/** Every `.ts`-bearing file under src/, as absolute paths. */
function sourceFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.ts(?:\.|$)/u.test(entry)) continue
      out.push(full)
    }
  }
  walk(SRC)
  return out
}

/** The multiset for the working tree: line → count. */
export function multisetOfTree() {
  const counts = new Map()
  for (const file of sourceFiles()) {
    for (const line of contentLines(readFileSync(file, 'utf8'))) {
      counts.set(line, (counts.get(line) ?? 0) + 1)
    }
  }
  return counts
}

/** The multiset for a git ref, by reading each file's content out of the object store. */
export function multisetOfRef(ref) {
  const list = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, '--', 'src'], { cwd: REPO, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((path) => /\.ts(?:\.|$)/u.test(path))
  const counts = new Map()
  for (const path of list) {
    let text
    try {
      text = execFileSync('git', ['show', `${ref}:${path}`], { cwd: REPO, encoding: 'utf8' })
    } catch {
      continue // a path deleted in this ref cannot be read; the caller's diff explains it
    }
    for (const line of contentLines(text)) counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  return counts
}

/** Compare two multisets; returns the first difference found, or undefined. */
export function firstDifference(before, after) {
  const keys = new Set([...before.keys(), ...after.keys()])
  // Deterministic order so "the first difference" is reproducible run to run.
  for (const key of [...keys].sort()) {
    const b = before.get(key) ?? 0
    const a = after.get(key) ?? 0
    if (b !== a) return { line: key, before: b, after: a }
  }
  return undefined
}

function describe(difference) {
  const { line, before, after } = difference
  const sign = after > before ? 'APPEARED' : 'DISAPPEARED'
  return [
    `FIRST DIFFERENCE (${sign}: ${before} → ${after} occurrences)`,
    `  ${JSON.stringify(line.slice(0, 140))}`,
    after > before
      ? '  A line was ADDED or DUPLICATED. If the move was pure, this is the "moved it and left a copy" failure.'
      : '  A line was REMOVED or EDITED. If the move was pure, the content did not survive verbatim.',
  ].join('\n')
}

// ── self-test: prove the checker can fail, and can stay green for plumbing-only edits ─────────
function selfTest() {
  const base = ['function f() {', '  return 1', '}', '']
  const plumbing = ['import { g } from "./x.js"', 'export function f() {', '  return 1', '}', 'export { f }']
  const duplicated = ['function f() {', '  return 1', '}', 'function f() {', '  return 1', '}']

  const ms = (lines) => {
    const counts = new Map()
    // Use the SAME normalisation the tree comparison uses; a self-test with its own pipeline would be
    // testing the test rather than the checker (the failure above was exactly that).
    for (const line of contentLines(lines.join('\n'))) counts.set(line, (counts.get(line) ?? 0) + 1)
    return counts
  }

  const plumbingDiff = firstDifference(ms(base), ms(plumbing))
  const dupDiff = firstDifference(ms(base), ms(duplicated))

  /**
   * Self-test 3: the TYPE-flavoured re-export must be plumbing too (found by N1). Kept as its own case
   * because the first version of this rule only recognised bare brace lists and reported a legitimate
   * `export type { A, B }` as an added content line.
   */
  const typedPlumbing = ['export interface A { x: number }', 'export type B = string',
    'function f() {', '  return 1', '}', 'export type { A, B }', 'export { f }']
  const typedBase = ['export interface A { x: number }', 'export type B = string',
    'function f() {', '  return 1', '}']
  const typedDiff = firstDifference(ms(typedBase), ms(typedPlumbing))

  console.log('self-test 1 (import/export plumbing only): ' + (plumbingDiff === undefined ? 'IDENTICAL as required' : 'FALSE POSITIVE — ' + describe(plumbingDiff)))
  console.log('self-test 2 (content duplicated):          ' + (dupDiff !== undefined ? 'DIFFERENT as required' : 'FALSE NEGATIVE — the multiset missed a duplicate'))
  console.log('self-test 3 (type re-export is plumbing):  ' + (typedDiff === undefined ? 'IDENTICAL as required' : 'FALSE POSITIVE — ' + describe(typedDiff)))

  const ok = plumbingDiff === undefined && dupDiff !== undefined && typedDiff === undefined
  if (dupDiff !== undefined) console.log(describe(dupDiff))
  console.log(ok ? '\nSELF-TEST PASS' : '\nSELF-TEST FAIL')
  return ok
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  if (process.argv.includes('--self-test')) {
    process.exitCode = selfTest() ? 0 : 1
  } else {
    const againstIndex = process.argv.indexOf('--against')
    const ref = againstIndex >= 0 ? process.argv[againstIndex + 1] : 'HEAD'
    if (ref === undefined) throw new Error('--against needs a git ref')

    /**
     * ── `--classify` : the same diff, bucketed into comment / pipeline / logic ──────────────────
     *
     * Print-only mode. It does NOT decide pass/fail — that stays with the main path and the
     * registry. It exists so the "33 lines appeared" answer becomes actionable: the reader sees
     * immediately whether the 33 are comments (fine) or whether one is a changed expression.
     *
     * Exit code: 0 when `logic` is 0, 1 when it is not, 2 when the comparison is VACUOUS.
     * That mirrors the main path's severity without pretending to replace it — an approved
     * `logic` line still needs a registry entry to make the real gate pass.
     */
    const classifyMode = process.argv.includes('--classify')

    const before = multisetOfRef(ref)
    const after = multisetOfTree()

    if (classifyMode) {
      const beforeArr = []
      for (const [line, n] of before) for (let i = 0; i < n; i += 1) beforeArr.push(line)
      const afterArr = []
      for (const [line, n] of after) for (let i = 0; i < n; i += 1) afterArr.push(line)

      const srcDiffClassify = (() => {
        try {
          execFileSync('git', ['diff', '--quiet', ref, '--', 'src'], { cwd: REPO, stdio: 'ignore' })
          return ''
        } catch { return 'changed' }
      })()
      const srcStatusClassify = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: REPO, encoding: 'utf8' }).trim()
      if (srcDiffClassify === '' && srcStatusClassify === '') {
        console.log(`ref     : ${ref}`)
        console.log('tree    : working')
        console.log('')
        console.log('VACUOUS — src/ has NO differences from the ref, so there is nothing to classify.')
        console.log('This is NOT a pass. Run it against the commit BEFORE the move.')
        process.exit(2)
      }

      const { gone, came } = diffContentLines(beforeArr, afterArr)
      const result = classifyDifference(gone, came)
      const { appeared, disappeared, totals, appearedCounts, disappearedCounts } = result

      console.log(`ref  ${ref}: ${beforeArr.length} 内容行`)
      console.log(`tree      : ${afterArr.length} 内容行  （差 ${afterArr.length - beforeArr.length}）`)
      console.log('')
      console.log(`DISAPPEARED ${disappearedCounts.entries} 条 / ${disappearedCounts.lines} 行`)
      console.log(`APPEARED   ${appearedCounts.entries} 条 / ${appearedCounts.lines} 行`)
      console.log('')
      console.log('                   注释   管线   逻辑')
      console.log(`  APPEARED       ${String(appeared.comment.length).padStart(5)}  ${String(appeared.pipeline.length).padStart(5)}  ${String(appeared.logic.length).padStart(5)}`)
      console.log(`  DISAPPEARED    ${String(disappeared.comment.length).padStart(5)}  ${String(disappeared.pipeline.length).padStart(5)}  ${String(disappeared.logic.length).padStart(5)}`)
      console.log(`  ── 合计 ──     ${String(totals.comment).padStart(5)}  ${String(totals.pipeline).padStart(5)}  ${String(totals.logic).padStart(5)}   ← 逻辑必须为 0`)
      console.log('')
      console.log(`  三类合计 ${totals.comment + totals.pipeline + totals.logic} 行`
        + `（应等于 新增 ${appearedCounts.lines} + 消失 ${disappearedCounts.lines} = ${appearedCounts.lines + disappearedCounts.lines}）`)

      if (totals.logic > 0) {
        console.log('')
        console.log('非注释、非管线的行（要逐条解释，或把它的形状教给工具）：')
        for (const line of appeared.logic) console.log(`  + ! ${JSON.stringify(line)}`)
        for (const line of disappeared.logic) console.log(`  - ! ${JSON.stringify(line)}`)
      }
      if (totals.pipeline > 0) {
        console.log('')
        console.log('管线明细：')
        for (const line of appeared.pipeline) console.log(`  + | ${JSON.stringify(line)}`)
        for (const line of disappeared.pipeline) console.log(`  - | ${JSON.stringify(line)}`)
      }
      if (gone.length > 0) {
        console.log('')
        console.log('DISAPPEARED 明细（每一行都要说得清）：')
        for (const { l, n } of gone) console.log(`  - ${n}× ${JSON.stringify(l)}`)
      }

      /**
       * ── THE EXIT CODE IS ABOUT `logic`, ON EITHER SIDE ──────────────────────────────────────────
       *
       * Not about `appeared`, and not about "is the total delta positive". A deleted function is
       * logic on the disappeared side; a rewritten expression is logic on the appeared side; both
       * must fail. Anything else (comments, plumbing) is reported and allowed.
       */
      process.exitCode = totals.logic === 0 ? 0 : 1
    } else {

    const difference = firstDifference(before, after)

    /**
     * ── A COMPARISON WITH NOTHING ON THE OTHER SIDE IS NOT A PASS ────────────────────────────────
     *
     * Measured: running this with the default `--against HEAD` on a clean tree printed
     * `IDENTICAL — the content-line multiset is unchanged (pure move)` and exited 0. Both sides were
     * the same commit, so of course they matched. That is a VACUOUS run, and it is the most dangerous
     * possible output for this tool: every future move would "pass" if the check were ever invoked
     * after the commit instead of before it, and nobody would notice because the word IDENTICAL is
     * the one everybody looks for.
     *
     * So: if `src/` has no differences from the ref at all — no modified file, no untracked module —
     * there is nothing to compare, and this exits 2 (a RESOURCE/usage condition, never a pass).
     *
     * Checked with both `git diff` (tracked changes) and `git status --porcelain` (which also sees
     * untracked new modules — a move creates exactly one of those).
     */
    const srcDiff = (() => {
      try {
        execFileSync('git', ['diff', '--quiet', ref, '--', 'src'], { cwd: REPO, stdio: 'ignore' })
        return '' // exit 0 → no tracked changes
      } catch {
        return 'changed' // exit 1 → differences exist
      }
    })()
    const srcStatus = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: REPO, encoding: 'utf8' }).trim()
    if (srcDiff === '' && srcStatus === '') {
      console.log(`ref     : ${ref}`)
      console.log('tree    : working')
      console.log('')
      console.log('VACUOUS — src/ has NO differences from the ref, so there is nothing to compare.')
      console.log('This is NOT a pass: a pure-move check with no diff on one side cannot fail.')
      console.log(`Run it against the commit BEFORE the move (e.g. --against <parent>), not against ${ref}.`)
      process.exit(2)
    }

    const total = (counts) => [...counts.values()].reduce((sum, n) => sum + n, 0)
    console.log(`ref     : ${ref}   content lines: ${total(before)}`)
    console.log(`tree    : working   content lines: ${total(after)}`)

    if (difference === undefined) {
      console.log('\nIDENTICAL — the content-line multiset is unchanged (pure move)')
      process.exitCode = 0
    } else {
      /**
       * ── MATCH AGAINST THE EXPLICIT REGISTRY INSTEAD OF FAILING ON DIFF #1 ───────────────────
       *
       * The old behaviour printed only the FIRST difference and exited 1. That is fine for a raw
       * check but useless once a correction is registered: the registry entry and the first
       * difference may be different lines. So the whole difference set is computed, then the
       * registry is subtracted from it — exactly and 1:1 (see the rules above).
       */
      const allDifferences = []
      for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
        const b = before.get(key) ?? 0
        const a = after.get(key) ?? 0
        if (b !== a) allDifferences.push({ line: key, before: b, after: a })
      }

      // 1:1 subtraction. Each registry entry may absorb exactly one DISAPPEARED **and** one
      // APPEARED line — so the two sides are tracked separately. (The first version used a single
      // `used` flag, so absorbing the disappeared half made the appeared half unmatched, and a
      // pure correction still failed. Measured by the three-scenario probe.)
      const absorbed = []
      const remaining = []
      const registryLeft = activeRegistry.map((entry) => ({ ...entry, usedGone: false, usedCame: false }))

      for (const diff of allDifferences) {
        if (diff.before > 0 && diff.after === 0) {
          const hit = registryLeft.find((e) => !e.usedGone && e.disappeared === diff.line)
          if (hit !== undefined) { hit.usedGone = true; absorbed.push({ kind: 'disappeared', entry: hit, diff }); continue }
        }
        if (diff.after > 0 && diff.before === 0) {
          const hit = registryLeft.find((e) => !e.usedCame && e.appeared === diff.line)
          if (hit !== undefined) { hit.usedCame = true; absorbed.push({ kind: 'appeared', entry: hit, diff }); continue }
        }
        remaining.push(diff)
      }

      // An entry that matched nothing is NOT automatically rot. Once the fix is committed, comparing
      // against a ref that already contains it produces no diff — the normal, healthy state.
      // So distinguish two cases by asking: is the corrected line present in the tree?
      //
      //   appeared line present  → the correction is already in the baseline; the entry simply does
      //                            not apply to THIS comparison. Informational, never a failure.
      //   appeared line ABSENT   → the code no longer looks like either side of the registered pair,
      //                            so the entry describes something that no longer exists. That IS
      //                            rot (or an unregistered edit nearby) and it must fail, because a
      //                            registry nobody prunes is a list nobody reads.
      const alreadyApplied = []
      const stale = []
      for (const entry of registryLeft) {
        if (entry.usedGone && entry.usedCame) continue
        const appearedInTree = (after.get(entry.appeared) ?? 0) > 0
        if (appearedInTree) alreadyApplied.push(entry)
        else stale.push(entry)
      }

      if (absorbed.length > 0) {
        console.log('')
        // One line per ENTRY, not per half: a 1:1 correction produces two absorbed diffs.
        const reported = new Set()
        for (const { entry } of absorbed) {
          if (reported.has(entry.commit)) continue
          reported.add(entry.commit)
          console.log(`KNOWN FORMAT CORRECTION (see ${entry.commit}): ${entry.reason}`)
        }
      }
      if (alreadyApplied.length > 0) {
        console.log('')
        for (const entry of alreadyApplied) {
          console.log(`REGISTERED CORRECTION ALREADY IN BASELINE (${entry.commit}): not part of this comparison.`)
        }
      }
      if (stale.length > 0) {
        console.log('')
        for (const entry of stale) {
          console.log(`STALE REGISTRY ENTRY (${entry.commit}): the corrected line is gone from the tree — delete the entry.`)
          console.log(`  disappeared: ${JSON.stringify(entry.disappeared)}`)
          console.log(`  appeared   : ${JSON.stringify(entry.appeared)}`)
        }
      }

      if (remaining.length === 0 && stale.length === 0) {
        const parts = []
        if (absorbed.length > 0) parts.push(`${absorbed.length / 2} REGISTERED FORMAT CORRECTION(S)`)
        if (alreadyApplied.length > 0) parts.push(`${alreadyApplied.length} ALREADY IN BASELINE`)
        console.log(`\nPURE MOVE${parts.length > 0 ? ` + ${parts.join(' + ')}` : ''} — nothing unexplained.`)
        process.exitCode = 0
      } else {
        console.log('\n' + describe(remaining[0] ?? allDifferences[0]))
        if (remaining.length > 1) console.log(`  …and ${remaining.length - 1} more unexplained difference(s).`)
        if (stale.length > 0) console.log('  (A stale registry entry is also a failure — see above.)')
        process.exitCode = 1
      }
    }
    }
  }
}
