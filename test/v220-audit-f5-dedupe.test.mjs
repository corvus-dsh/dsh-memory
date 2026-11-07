/**
 * AUDIT F5 — SHORT CHINESE PHRASES, AND THE MEASURE THAT WAS TOO SHARP FOR THEM.
 *
 * THE DEFECT. Skill de-duplication compared `when_to_use` text with Jaccard over character 3-grams
 * at a fixed 0.85 threshold. For a short phrase that measure is brutally sensitive to insertion: one
 * added character destroys up to three of the few grams that exist.
 *
 * MEASURED on the audit's baseline `当你要用真实日志验证切片行为时。` (18 chars):
 *
 *     identical                   -> 1.0000   merged
 *     + one space                 -> 1.0000   merged
 *     - the full stop             -> 1.0000   merged
 *     + the character `来`         -> 0.7368   NOT merged   <-- the defect
 *     a moderate rephrase         -> 0.0909   NOT merged
 *     a distant rephrase          -> 0.1111   NOT merged
 *
 * So "the same method, said with one extra word" became a SECOND SKILL FILE. Repeated over months
 * that makes the store grow monotonically while claiming a dedupe gate — the classic failure mode
 * where the user eventually disables the feature because the memory is full of the same thing.
 *
 * WHY THE OLD SUITE MISSED IT: the fixtures were "identical" and "completely different" — the two
 * extremes, where ANY threshold works. The middle, where dedupe actually has to judge, was untested.
 * That is the general lesson this file exists to encode: a threshold needs a test that CHANGES THE
 * THRESHOLD'S INPUT, not one that only exercises its endpoints.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SHORT_WHEN_MAX_CHARS,
  SHORT_WHEN_THRESHOLD,
  editDistance,
  editSimilarity,
  findSkillCandidate,
  whenSimilarity,
} from '../lib/dedupe.js'

const BASELINE = '当你要用真实日志验证切片行为时。'

function skillsDirWith(name, when) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-f5-'))
  const skills = join(root, 'skills')
  const dir = join(skills, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\nwhen_to_use: ${when}\n---\n\n## 执行步骤\n\n1. a\n2. b\n`, 'utf8')
  return skills
}

test('audit F5: edit distance counts code points, so one CJK char is distance 1', () => {
  assert.equal(editDistance('abc', 'abc'), 0)
  assert.equal(editDistance('abc', 'abd'), 1, 'substitution')
  assert.equal(editDistance('abc', 'ab'), 1, 'deletion')
  assert.equal(editDistance('ab', 'abc'), 1, 'insertion')
  assert.equal(editDistance('', 'abc'), 3)
  assert.equal(editDistance('abc', ''), 3)

  /** ONE CJK CHARACTER IS ONE EDIT — not one per UTF-16 code unit, and not zero. */
  assert.equal(editDistance('当你要用真实日志验证', '当你要用真实日志来验证'), 1, 'inserting 来 is exactly one edit')
})

test('audit F5: the ONE-CHARACTER insertion that used to create a duplicate now merges', () => {
  /**
   * THE ASSERTION THE OLD SUITE LACKED, in one line: this pair differs by a single character and
   * must be treated as the same skill. Before the fix the similarity was 0.7368 and a new SKILL.md
   * was written.
   */
  const added = '当你要用真实日志来验证切片行为时。'
  const similarity = whenSimilarity(BASELINE, added)

  assert.ok(
    similarity >= SHORT_WHEN_THRESHOLD,
    `one inserted character must stay above the gate, got ${similarity.toFixed(4)} (threshold ${SHORT_WHEN_THRESHOLD})`,
  )
  /** And it must be FAR above the old measure's answer, so this cannot silently regress. */
  assert.ok(similarity > 0.9, `expected > 0.9 for a single insertion, got ${similarity.toFixed(4)}`)

  // End to end: the candidate is found, so no second file is written.
  const skills = skillsDirWith('verify-with-real-log', BASELINE)
  const found = findSkillCandidate(skills, added)
  assert.equal(found?.name, 'verify-with-real-log', 'the same method with one extra word must MERGE')
  assert.equal(found?.exact, false, 'merged by similarity, not by an exact-normalized hit')
})

test('audit F5: the fix must not turn unrelated skills into one', () => {
  /**
   * THE OTHER DIRECTION, and the reason this is not "lower the threshold until it merges". A false
   * merge silently DELETES a user's memory, which is worse than a duplicate: a duplicate wastes
   * space, a false merge loses a method. Every pair below is a genuinely different skill.
   */
  const unrelated = [
    '部署前先备份数据库。',
    '提交前跑一遍单元测试。',
    '端口被占用时先查 lsof。',
  ]
  const skills = skillsDirWith('verify-with-real-log', BASELINE)
  for (const candidate of unrelated) {
    assert.equal(
      findSkillCandidate(skills, candidate),
      undefined,
      `"${candidate}" is a different method and must NOT merge into "${BASELINE}"`,
    )
  }
})

test('audit F5: a genuine rephrase stays a new file — this is a typing gate, not a semantic one', () => {
  /**
   * THE HONEST LIMIT, pinned so nobody "fixes" it later by accident. `用真实日志检查切片是否正确`
   * means something similar but is a DIFFERENT sentence; a lexical measure must refuse to merge it.
   * Merging those needs a model, and that is a different feature with a different cost. Pretending
   * otherwise would make this look more capable than it is.
   */
  const rephrased = '用真实日志检查切片是否正确。'
  const similarity = whenSimilarity(BASELINE, rephrased)
  assert.ok(similarity < SHORT_WHEN_THRESHOLD, `a real rephrase must stay below the gate, got ${similarity.toFixed(4)}`)
  const skills = skillsDirWith('verify-with-real-log', BASELINE)
  assert.equal(findSkillCandidate(skills, rephrased), undefined, 'a rephrase is a new skill, reviewed by a human')
})

test('audit F5: punctuation and spacing variants still merge (the original intent is intact)', () => {
  const skills = skillsDirWith('verify-with-real-log', BASELINE)
  for (const variant of ['当你要用真实日志验证切片行为时', '当你要用真实日志 验证切片行为时。']) {
    const found = findSkillCandidate(skills, variant)
    assert.equal(found?.name, 'verify-with-real-log', `"${variant}" must still merge`)
  }
})

test('audit F5: long text still uses 3-gram Jaccard, and the boundary is stated', () => {
  /**
   * The two measures are used on DIFFERENT LENGTHS rather than blended, and the boundary is a
   * constant so it can be argued with. This pins which side each input falls on.
   */
  assert.equal(SHORT_WHEN_MAX_CHARS, 30)

  const longA = '在修改切片断言之前先用真实日志完整跑一遍验证，确认修复确实生效而不是碰巧通过'
  const longB = '在修改切片断言之前先用真实日志完整跑一遍验証，确认修复确实生效而不是碰巧通过'
  assert.equal(whenSimilarity(longA, longB), whenSimilarity(longA, longB), 'deterministic')

  /**
   * And the promise that made the split worth it: for LONG text an insertion is diluted, so Jaccard
   * is stable — the same class of edit that broke the short branch is harmless here.
   */
  const longInserted = `${longA.slice(0, -1)}来${longA.slice(-1)}`
  assert.ok(
    whenSimilarity(longA, longInserted) > SHORT_WHEN_THRESHOLD,
    'one insertion in a long phrase must be stable under the gram measure too',
  )
})

test('audit F5: editSimilarity is normalized by the LONGER string, so an addition is not punished twice', () => {
  assert.equal(editSimilarity('abc', 'abc'), 1)
  assert.equal(editSimilarity('', ''), 1)
  /** Appending one character to a two-character string: 1 - 1/3. */
  assert.ok(Math.abs(editSimilarity('ab', 'abc') - 2 / 3) < 1e-9)
  /** And symmetric, so call order cannot change a decision. */
  assert.equal(editSimilarity('ab', 'abc'), editSimilarity('abc', 'ab'))
})
