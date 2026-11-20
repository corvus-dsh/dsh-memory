/**
 * ── v270 (B4-0b-2 W1-9b): an EMPTY field must not borrow the next line ──────────────────────────
 *
 * `frontmatterList` (the reader W1-9 added to `merge.ts`) wrote `^${key}:\s*(.*)$`. `\s` matches a
 * newline, so an EMPTY field — `aliases: ` with nothing after it, which is what a hand edit and old code
 * both produce — let `\s*` eat the line break and `(.*)` capture the NEXT line.
 *
 * Reproduced through the shipped library before the fix: a keeper whose `aliases: ` was empty and whose
 * next line was `tags: alpha` merged to
 *
 *     aliases: tags: alpha,连数据库
 *
 * — a fake alias in the RECALL text, propagating into every later merge.
 *
 * ── WHY THIS IS A SHARED READER AND NOT A FIXED COPY ─────────────────────────────────────────
 *
 * A10 already fixed five copies of this inside `readSkillValidity`, and said so in a comment. W1-9 then
 * wrote a sixth. Two occurrences of "I fixed the copy in front of me" is enough to conclude the
 * per-copy fix does not hold, so the rule now lives in ONE function (`readFrontmatterField`) and every
 * caller goes through it. `v270 ④` pins the sharing itself; `scripts/check-frontmatter-reads.mjs` pins
 * that nobody writes a new copy.
 *
 * The dispatch's judgement:
 *   ① keeper `aliases: ` empty + next line `tags: alpha` ⇒ merged aliases contain ONLY the absorbed ones；
 *   ② both sides empty ⇒ the line is not written at all；
 *   ③ `v269` five stay green；
 *   can-red：改回 `\s*` ⇒ ① 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mergeSkills } from '../lib/store.js'
import { readFrontmatterField, readFrontmatterList } from '../lib/store.js'

const WORKSPACE = 'D:/持久层能力架构'

/**
 * A SKILL.md where `aliases:` may be EMPTY (note the trailing space, which is what a hand edit leaves)
 * and where the NEXT line is deliberately a `key: value` — the exact shape that used to leak.
 */
function writeSkill(dir, name, { aliases = '', tags = '', evidence = '' } = {}) {
  const dirPath = join(dir, name)
  mkdirSync(dirPath, { recursive: true })
  const text = [
    '---',
    `name: ${name}`,
    `description: ${name} 的说明`,
    `when_to_use: 当需要 ${name} 时`,
    'scope: project',
    `aliases: ${aliases}`,
    `tags: ${tags}`,
    `evidence: ${evidence}`,
    'valid_at: 2026-01-01',
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n')
  writeFileSync(join(dirPath, 'SKILL.md'), text, 'utf8')
  return text
}

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v270-'))
  const dir = join(root, 'skills')
  const memoryDir = join(root, 'memory')
  mkdirSync(dir, { recursive: true })
  mkdirSync(memoryDir, { recursive: true })
  return { dir, memoryDir }
}

const keeperOf = (dir, name) => readFileSync(join(dir, name, 'SKILL.md'), 'utf8')

test('v270 ①: an EMPTY aliases field does not borrow the next line', () => {
  /**
   * The reproduced bug, as a fixture. `keeper` has `aliases: ` (empty) followed by `tags: alpha`;
   * `absorbed` carries the only real alias.
   */
  const { dir, memoryDir } = scaffold()
  writeSkill(dir, 'keeper', { aliases: '', tags: 'alpha', evidence: 's@1' })
  writeSkill(dir, 'absorbed', { aliases: '连数据库', tags: 'beta', evidence: 's@2' })

  const result = mergeSkills(dir, 'keeper', 'absorbed', { memoryDir })
  assert.equal(result.ok, true, `merge failed: ${result.status}`)

  const aliases = readFrontmatterList(keeperOf(dir, 'keeper'), 'aliases')
  assert.deepEqual(aliases, ['连数据库'], `the keeper's own field was EMPTY, so only the absorbed alias belongs; got ${JSON.stringify(aliases)}`)
  for (const alias of aliases) {
    assert.doesNotMatch(alias, /^tags:/u, `the next line must never become an alias; got "${alias}"`)
  }
})

test('v270 ②: both sides empty ⇒ the field is NOT written (and ① is not "always writes something")', () => {
  const { dir, memoryDir } = scaffold()
  writeSkill(dir, 'keeper', { aliases: '', tags: 'alpha', evidence: 's@1' })
  writeSkill(dir, 'absorbed', { aliases: '', tags: 'beta', evidence: 's@2' })

  assert.equal(mergeSkills(dir, 'keeper', 'absorbed', { memoryDir }).ok, true)
  const keeper = keeperOf(dir, 'keeper')
  assert.equal(readFrontmatterList(keeper, 'aliases').length, 0, 'no aliases on either side ⇒ no aliases on the keeper')
  /**
   * And the WRITE side must not manufacture the line either: `aliasestags`-style garbage, or a bare
   * `aliases:` claiming the field exists. `tags` must still be the real union.
   *
   * ── THE FIRST DRAFT OF THIS ASSERTION WAS ITSELF WRONG, AND INSTRUCTIVELY SO ────────────────────
   *
   * It read `assert.doesNotMatch(keeper, /^aliases:\s*tags:/mu)`. `\s` matches a NEWLINE, so that pattern
   * matches the LEGITIMATE output (`aliases: \ntags: alpha,beta`) — the assertion was written in the same
   * shape as the bug it guards against. A regex-based check of a line-boundary property has to say what
   * it means: look at the VALUE of the field (which `readFrontmatterList` already isolates), not at how
   * two lines happen to be adjacent.
   */
  const aliasValue = readFrontmatterField(keeper, 'aliases')
  assert.doesNotMatch(aliasValue, /tags:/u, `the next line must not be pasted INTO the field value; got "${aliasValue}"`)
  assert.deepEqual(readFrontmatterList(keeper, 'tags'), ['alpha', 'beta'])
})

test('v270 ③: the shared reader is the ONE place the rule lives', () => {
  /**
   * The structural half of W1-9b. A fixed copy would pass ①② and regrow a seventh time; what the review
   * actually asked for is that `merge.ts` and `retrieve/documents.ts` read through the SAME function.
   *
   * This asserts the function's behaviour DIRECTLY, so a future refactor that re-inlines it inside
   * either caller fails here rather than in a report nobody reads.
   */
  const empty = ['---', 'name: x', 'aliases: ', 'tags: alpha', '---'].join('\n')
  assert.deepEqual(readFrontmatterList(empty, 'aliases'), [], 'empty field, next line non-empty ⇒ EMPTY list')
  assert.deepEqual(readFrontmatterList(empty, 'tags'), ['alpha'], 'the next line is still readable as ITS OWN field')
  assert.equal(readFrontmatterField(empty, 'aliases'), '', 'the scalar reader agrees')

  /** A horizontal gap still belongs to the field — `[ \t]*` is not "no whitespace allowed". */
  const spaced = ['---', 'name: x', 'aliases: \t a, b', '---'].join('\n')
  assert.deepEqual(readFrontmatterList(spaced, 'aliases'), ['a', 'b'])
})

test('v270 ④: a numeric field with an empty value does not borrow either (the same bug, other shape)', () => {
  /**
   * The bug is about the GAP after the colon, not about the field's type. `sources:` empty followed by a
   * line starting with a digit is the shape that would matter for `Number(...)` callers.
   */
  const text = ['---', 'name: x', 'sources: ', 'generation: 7', '---'].join('\n')
  assert.equal(readFrontmatterField(text, 'sources'), '', 'an empty numeric field must read as empty')
  assert.equal(readFrontmatterField(text, 'generation'), '7')
})

test('v270 ⑤: the field name is matched as a WHOLE key, not a suffix', () => {
  /**
   * `^${key}:` is anchored at line start, so `counter_aliases:` must not answer for `aliases:`. Worth
   * pinning because the shared helper takes the key as a parameter — the first place a prefix match
   * could creep in.
   */
  const text = ['---', 'name: x', 'counter_aliases: decoy', 'aliases: real', '---'].join('\n')
  assert.deepEqual(readFrontmatterList(text, 'aliases'), ['real'])
})
