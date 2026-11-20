/**
 * ── v271 (B4-0b-2 W5-2b / 20.4): a COUNT baseline hides a SWAP; a regex-interpolated key hides a typo ──
 *
 * ── W5-2b: the gate's baseline was per-file COUNTS ────────────────────────────────────────────
 *
 * `check-frontmatter-reads.mjs` compared `observed > allowed`. Reproduced (probe, then this file): DELETE
 * one old read from `store/skill.ts` and ADD a different new one — the count is unchanged and the gate
 * stayed GREEN while a brand-new defect landed.
 *
 * That is A6's shape exactly: **a baseline that shrinks with the data cannot tell 「原班人马」 from
 * 「走一个来一个」**. The baseline is now the SET OF NORMALISED LINE TEXTS, so:
 *
 *   · a line not in the set ⇒ RED (a new copy, even if another line disappeared);
 *   · a recorded line that no longer occurs ⇒ GREEN +「baseline can go DOWN」, because removing a defect is
 *     GOOD NEWS and failing on it would punish the person who fixed it.
 *
 * ── 20.4: `key` is interpolated into a RegExp ────────────────────────────────────────────────
 *
 * All current callers pass literals, but the helper is on the public surface, so "today's callers are
 * literals" is a fact about today. A key with a metacharacter does not throw — it silently builds a
 * DIFFERENT pattern, and the read succeeds with the wrong answer. That is the same family as `\s*` eating
 * a newline: the read worked and returned something else.
 *
 * ── HOW THIS TEST DRIVES THE GATE ────────────────────────────────────────────────────────────
 *
 * Both gate directions run the REAL script against a COPY of the repo's `src/`, with one line mutated. A
 * test that re-implemented the comparison would pass while the shipped script kept its old logic — the
 * `v250` trap, one layer out. The copy is what makes "mutate and observe" safe.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readFrontmatterField, readFrontmatterList } from '../lib/store.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const GATE = join(REPO, 'scripts/check-frontmatter-reads.mjs')

/**
 * Run the shipped gate against a THROWAWAY copy of `src/` + `scripts/`.
 *
 * `scripts/` comes along because the gate resolves `src` relative to its own location — copying only `src`
 * would make it check the original tree.
 */
function gateOnCopy(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v271-'))
  mkdirSync(root, { recursive: true })
  cpSync(join(REPO, 'src'), join(root, 'src'), { recursive: true })
  cpSync(join(REPO, 'scripts'), join(root, 'scripts'), { recursive: true })
  try {
    mutate(join(root, 'src'))
    try {
      const out = execFileSync(process.execPath, [join(root, 'scripts/check-frontmatter-reads.mjs')], {
        encoding: 'utf8',
        cwd: root,
      })
      return { code: 0, out }
    } catch (error) {
      return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** The one file with the most recorded reads, so a swap is easy to construct. */
const TARGET = 'store/skill.ts'
const OLD_LINE = "  const sources = Number(previousText.match(/^sources:\\s*(\\d+)$/mu)?.[1] ?? '1')\n"
const NEW_LINE = "const SWAPPED_READ = (t: string) => t.match(/^freshness:\\s*(\\w+)$/mu)?.[1] ?? ''\n"

test('v271 ①: SWAPPING one read for another changes the count by zero and must still be RED', () => {
  /**
   * The hole W5-2b exists to close. Note the fixture asserts the COUNT is unchanged — that is what made
   * the old gate blind, and stating it here keeps the test honest about what it is demonstrating.
   */
  const result = gateOnCopy((src) => {
    const path = join(src, TARGET)
    const text = readFileSync(path, 'utf8')
    const before = (text.match(/:\s\*\(/gu) ?? []).length
    const patched = text.replace(OLD_LINE, '').replace('export function readFrontmatterField', `${NEW_LINE}\nexport function readFrontmatterField`)
    const after = (patched.match(/:\s\*\(/gu) ?? []).length
    assert.equal(after, before, 'the fixture must keep the COUNT identical, or it proves nothing about W5-2b')
    writeFileSync(path, patched, 'utf8')
  })
  assert.equal(result.code, 1, `the swap must be RED; got exit ${result.code}:\n${result.out.slice(0, 600)}`)
  /**
   * ── W5-2c CHANGED THE WORDING, SO THIS ASSERTION CHANGED WITH IT ─────────────────────────────
   *
   * The old assertion was `/NOT in the baseline/`, which was TRUE for a swap (the new line's text really
   * is absent) and is FALSE for a duplicate (its text IS in the baseline, once). W5-2c replaced the message
   * with one that states the MULTIPLICITY (`this line now occurs N×, baseline M×`) because that sentence is
   * true for both shapes — and a message that misdescribes why it failed sends the reader looking for the
   * wrong thing.
   *
   * The BEHAVIOUR this test guards (a swap must be red) is unchanged; only the sentence it matches moved.
   */
  assert.match(result.out, /multiplicity|baseline \d+×/u, 'the message must state the multiplicity')
  assert.match(result.out, /SWAPPED_READ/u, 'and NAME the new line')
})

test('v271 ②: REMOVING one read (adding nothing) is GREEN and flags the baseline for tightening', () => {
  /**
   * The other direction, and the one that decides whether people keep the gate switched on: fixing a
   * defect must not be a failure. It must, however, be VISIBLE — otherwise the baseline rots into a list
   * of lines that no longer exist.
   */
  const result = gateOnCopy((src) => {
    const path = join(src, TARGET)
    writeFileSync(path, readFileSync(path, 'utf8').replace(OLD_LINE, ''), 'utf8')
  })
  assert.equal(result.code, 0, `removing a defect must not fail the gate; got:\n${result.out.slice(0, 600)}`)
  assert.match(result.out, /baseline can go DOWN/u, 'and it must SAY the baseline can be tightened')
  assert.match(result.out, /sources/u, 'and name which recorded line is gone')
})

test('v271 ③: an UNTOUCHED copy is green (the gate is not vacuous)', () => {
  const result = gateOnCopy(() => {})
  assert.equal(result.code, 0, `a clean tree must pass; got:\n${result.out.slice(0, 600)}`)
  assert.match(result.out, /none new/u)
})

test('v271 ④: `key` must be an identifier — a metacharacter throws instead of building another pattern', () => {
  /**
   * 20.4's judgement. `'aliases.'` would match `aliasesX`; `'a|b'` matches two different fields and the
   * caller never learns which line it got. Both are PROGRAMMING errors, so throwing is correct — silently
   * returning something is what this whole batch is about.
   */
  const text = ['---', 'name: x', 'aliases: a', 'aliasesX: decoy', '---'].join('\n')
  assert.equal(readFrontmatterField(text, 'aliases'), 'a', 'the literal still works')
  for (const bad of ['aliases.', 'a|b', 'a*', 'a(b)', 'a b', '', 'a\nb', '$']) {
    assert.throws(
      () => readFrontmatterField(text, bad),
      /is not a frontmatter field name/u,
      `${JSON.stringify(bad)} must be refused, not interpolated`,
    )
  }
  /** And the list reader inherits the guard (it delegates). */
  assert.throws(() => readFrontmatterList(text, 'aliases.'), /is not a frontmatter field name/u)
})

test('v271 ⑤: the guard does not reject legitimate key shapes', () => {
  /** Frontmatter keys in this repo include digits and underscores; the guard must not be tighter than that. */
  const text = ['---', 'applicable_node_types: a,b', 'v2_field: c', '_private: d', '---'].join('\n')
  assert.deepEqual(readFrontmatterList(text, 'applicable_node_types'), ['a', 'b'])
  assert.equal(readFrontmatterField(text, 'v2_field'), 'c')
  assert.equal(readFrontmatterField(text, '_private'), 'd')
})
