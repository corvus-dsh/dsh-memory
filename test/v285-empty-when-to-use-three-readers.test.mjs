/**
 * ── v285 (B4-0b-2 W5-2): AN EMPTY `when_to_use:` MUST NOT BECOME THE NEXT LINE, IN ALL THREE ────
 *                                                                                               ──
 * `\s` matches a NEWLINE. Written as `^key:\s*(.+)$` with the `m` flag, an EMPTY field
 * (`when_to_use:` with nothing after it — what a hand edit leaves) lets `\s*` eat the line break and
 * `(.+)` capture the NEXT line, so the trigger of a skill becomes `scene: general`.
 *
 * A10 and W1-9 fixed the regex-LITERAL copies. Three copies survived, all written as a TEMPLATE
 * LITERAL, which spells the same regex with TWO backslashes in the source text:
 *
 *     new RegExp(`^${key}:\\s*(.+)$`, 'mu')
 *
 * `scripts/check-frontmatter-reads.mjs` matched `:\s*(` — one backslash — so all three of these were
 * invisible to it, and the gate was GREEN over three files that had the bug. That is the shape this
 * batch keeps recording: the check looked at a dimension where the right and the wrong answer are
 * identical. Reading the same field through three different PUBLIC readers is what makes this a
 * behavioural test instead of a source-string test.
 *
 *   reader                              file            what it returns
 *   listSkillSummaries(skillsDir)       archive.ts      SkillSummary.when   (the archive plan)
 *   listSkillRecords(skillsDir)         store.ts        SkillRecord.when    (the store listing)
 *   readSkillBody(skillsDir, name)      store/skill.ts  SkillBody.when      (the body re-read)
 *
 * 判据：
 *   ① 空 `when_to_use:` + 下一行 `scene: general` ⇒ 三个读者都返回 `when === ''`；
 *   ② 同一份 fixture 的 `scene` 仍然是 `general` —— 证明读取没有停在这一行，而是**这一行合法地是空的**；
 *   ③ 对照：`when_to_use: 处理编号 0 的任务时` ⇒ 三个读者返回的正是这句话（不是空、也不是别的行）。
 *
 * can-red：把任一处改回 `\s*` ⇒ 那一个读者的断言变红（实测三次，逐一）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listSkillSummaries } from '../lib/archive.js'
import { listSkillRecords, readSkillBody } from '../lib/store.js'

const WORKSPACE = 'D:/持久层能力架构'

/**
 * A skill whose `when_to_use:` is EMPTY and whose very next line is `scene: general`.
 *
 * The trailing space after the colon is deliberate: it is what a hand edit and the old writer both
 * produce, and `\s*` needs nothing but the line break to run on.
 */
function writeEmptyTriggerSkill(root, name = 'probe') {
  const skills = join(root, 'skills')
  mkdirSync(join(skills, name), { recursive: true })
  writeFileSync(
    join(skills, name, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      'when_to_use: ',
      'scene: general',
      `workspace: ${WORKSPACE}`,
      '---',
      '',
      `# ${name}`,
      '',
      'body',
      '',
    ].join('\n'),
    'utf8',
  )
  return skills
}

/** The positive control: the same shape, with a trigger that MUST come back verbatim. */
function writeFilledTriggerSkill(root, name = 'filled') {
  const skills = join(root, 'skills')
  mkdirSync(join(skills, name), { recursive: true })
  writeFileSync(
    join(skills, name, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      'when_to_use: 处理编号 0 的任务时',
      'scene: general',
      `workspace: ${WORKSPACE}`,
      '---',
      '',
      `# ${name}`,
      '',
      'body',
      '',
    ].join('\n'),
    'utf8',
  )
  return skills
}

test('v285 ①: an EMPTY when_to_use must not borrow `scene:` — in listSkillSummaries, listSkillRecords and readSkillBody', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-v285-'))
  try {
    const skills = writeEmptyTriggerSkill(root)

    const summary = listSkillSummaries(skills)[0]
    assert.equal(summary.when, '', 'archive.listSkillSummaries borrowed the next line as the trigger')

    const record = listSkillRecords(skills)[0]
    assert.equal(record.when, '', 'store.listSkillRecords borrowed the next line as the trigger')

    const body = readSkillBody(skills, 'probe')
    assert.ok(body !== undefined, 'readSkillBody returned undefined for a readable skill')
    assert.equal(body.when, '', 'store/skill.readSkillBody borrowed the next line as the trigger')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v285 ②: the NEXT line is still READ — the field is empty, not the reader blind', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-v285-'))
  try {
    const skills = writeEmptyTriggerSkill(root)

    /**
     * If the readers had simply stopped at the empty trigger, `scene` would also be lost. The defect
     * was never 「the reader cannot see」 — it was 「the reader saw the wrong line」, and the fix has to
     * keep seeing the right ones.
     */
    assert.equal(listSkillSummaries(skills)[0].scene, 'general', 'archive reader lost the scene line')
    assert.equal(listSkillRecords(skills)[0].scene, 'general', 'store reader lost the scene line')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v285 ③: a FILLED when_to_use comes back verbatim through all three readers (the empty case is not the only one)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-v285-'))
  try {
    const skills = writeFilledTriggerSkill(root)
    const expected = '处理编号 0 的任务时'

    assert.equal(listSkillSummaries(skills)[0].when, expected, 'archive reader changed a filled trigger')
    assert.equal(listSkillRecords(skills)[0].when, expected, 'store reader changed a filled trigger')
    assert.equal(readSkillBody(skills, 'filled')?.when, expected, 'readSkillBody changed a filled trigger')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})