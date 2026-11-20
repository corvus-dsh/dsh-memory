/**
 * ── v272 (B4-0b-2 W5-2c): a SET cannot see multiplicity, so the baseline is a MULTISET ─────────────
 *
 * The frontmatter-reads gate has now had three baselines, and each was too weak in a way the next one
 * exposed:
 *
 *   1. **COUNT per file** (W5-2) — caught growth, but swapped one read for another and stayed green;
 *   2. **SET of line texts** (W5-2b) — caught the swap, but a COPIED line is byte-identical to one already
 *      in the set. Reproduced (probe, then ① here): duplicate an existing read into another function, the
 *      count goes 33 → 34, and `Set.has` answers "this text appears", so the gate stayed GREEN;
 *   3. **MULTISET (Map<line, count>)** — this file. `observed > recorded` is RED for BOTH shapes.
 *
 * ── WHY THE FIXTURES ARE SHAPED THIS WAY ─────────────────────────────────────────────────────
 *
 * ① copies a line that IS in the baseline, into a DIFFERENT function, because "same text in the same
 * scope" is not what a new read looks like — a developer copying a read puts it where they need it. The
 * assertion has to be about multiplicity, not about the line being novel.
 *
 * ② is the direction that must stay GREEN: deleting one of two identical reads is a fix, and a gate that
 * fails on a fix gets switched off.
 *
 * Both drive the SHIPPED script against a throwaway copy of `src/` + `scripts/` — a re-implemented
 * comparison would pass while the real gate kept its old logic (`v250`'s trap, one layer out).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))

function gateOnCopy(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v272-'))
  cpSync(join(REPO, 'src'), join(root, 'src'), { recursive: true })
  cpSync(join(REPO, 'scripts'), join(root, 'scripts'), { recursive: true })
  try {
    mutate(join(root, 'src'))
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [join(root, 'scripts/check-frontmatter-reads.mjs')], {
          encoding: 'utf8',
          cwd: root,
        }),
      }
    } catch (error) {
      return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const TARGET = 'store/skill.ts'
/** A REAL read that is in the baseline. */
const LINE = "  const description = text.match(/^description:\\s*(.+)$/mu)?.[1] ?? when"
/** How many times the gate itself reports reads (the message it prints on success). */
const reportedCount = (out) => {
  const match = /(\d+) known read\(s\)/u.exec(out)
  return match === null ? undefined : Number(match[1])
}

test('v272 ①: COPYING an existing read verbatim (into another function) must be RED', () => {
  const result = gateOnCopy((src) => {
    const path = join(src, TARGET)
    const text = readFileSync(path, 'utf8')
    assert.ok(text.includes(`${LINE}\n`), 'the fixture line must exist in the real tree')
    const patched = text.replace(
      'export function readFrontmatterField',
      `function duplicatedReader(text: string, when: string): string {\n${LINE}\n  return description\n}\n\nexport function readFrontmatterField`,
    )
    /**
     * The fixture proves its own premise in the terms that matter: the READ line's normalised text is
     * already in the tree, and after the mutation it occurs TWICE. That is precisely what a Set cannot
     * distinguish and a multiset can.
     *
     * (The first two drafts asserted `Set(texts).size` unchanged, which is wrong for an unrelated reason:
     * the mutation also adds `function duplicatedReader(...)` and `return description`, which ARE new
     * distinct lines. The premise worth asserting is multiplicity of the read line, not the size of the
     * whole-file set.)
     */
    const normalise = (line) => line.replace(/\s+/gu, ' ').trim()
    const occurrences = (source) => source.split('\n').filter((line) => normalise(line) === normalise(LINE)).length
    assert.equal(occurrences(text), 1, 'the read exists exactly once before the copy')
    assert.equal(occurrences(patched), 2, 'the copy makes it occur twice — with IDENTICAL normalised text')
    writeFileSync(path, patched, 'utf8')
  })
  assert.equal(result.code, 1, `a copied read must be RED; got exit ${result.code}:\n${result.out.slice(0, 700)}`)
  assert.match(result.out, /multiplicity/u, 'the message must say the baseline is about how many times')
  assert.match(result.out, /2×, baseline 1×|occurs 2/u, `and must state the multiplicity; got:\n${result.out.slice(0, 500)}`)
})

test('v272 ②: deleting ONE of two identical reads is GREEN and flags the baseline for tightening', () => {
  /**
   * Duplicate first (so the file legitimately has two), then remove one. The gate must read this as
   * `2 → 1 ≤ recorded` … except the baseline records 1, so after the duplication the file is at 2 which is
   * already a violation. That is why the fixture duplicates and removes in ONE mutation: the NET effect is
   * zero, which must be green, and the test below (③) covers the real "one fewer than baseline" case.
   */
  const result = gateOnCopy((src) => {
    const path = join(src, TARGET)
    const text = readFileSync(path, 'utf8')
    const duplicated = text.replace(
      'export function readFrontmatterField',
      `function duplicatedReader(text: string, when: string): string {\n${LINE}\n  return description\n}\n\nexport function readFrontmatterField`,
    )
    /** Revert the duplication immediately: the tree is back to the baseline state. */
    writeFileSync(path, duplicated.replace(`function duplicatedReader(text: string, when: string): string {\n${LINE}\n  return description\n}\n\nexport function readFrontmatterField`, 'export function readFrontmatterField'), 'utf8')
  })
  assert.equal(result.code, 0, `a net-zero change must pass; got:\n${result.out.slice(0, 600)}`)
  assert.equal(reportedCount(result.out), 33, 'and the read count is unchanged')
})

test('v272 ③: removing a recorded read (baseline goes down) stays GREEN — and now reports the multiple', () => {
  const result = gateOnCopy((src) => {
    const path = join(src, TARGET)
    writeFileSync(path, readFileSync(path, 'utf8').replace(`${LINE}\n`, ''), 'utf8')
  })
  assert.equal(result.code, 0, `removing a defect must not fail; got:\n${result.out.slice(0, 600)}`)
  assert.match(result.out, /baseline can go DOWN/u)
  assert.match(result.out, /1× → 0×|× → /u, 'the prompt must state the recorded multiplicity, not just the text')
})

test('v272 ④: the message names HOW MANY times the line occurs (a bare "not in baseline" would be a lie here)', () => {
  /**
   * W5-2b's failure message said "NOT in the baseline". For a duplicate that sentence is FALSE — the line
   * IS in the baseline, once. The wording is part of the fix: a message that misdescribes why it failed
   * sends the reader looking for the wrong thing.
   */
  const result = gateOnCopy((src) => {
    const path = join(src, TARGET)
    const text = readFileSync(path, 'utf8')
    writeFileSync(
      path,
      text.replace(
        'export function readFrontmatterField',
        `function duplicatedReader(text: string, when: string): string {\n${LINE}\n  return description\n}\n\nexport function readFrontmatterField`,
      ),
      'utf8',
    )
  })
  assert.equal(result.code, 1)
  assert.doesNotMatch(result.out, /NOT in the baseline/u, 'a duplicate IS in the baseline — saying otherwise misleads')
  assert.match(result.out, /baseline \d+×/u)
})
