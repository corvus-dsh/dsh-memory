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

    const before = multisetOfRef(ref)
    const after = multisetOfTree()
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
      console.log('\n' + describe(difference))
      process.exitCode = 1
    }
  }
}
