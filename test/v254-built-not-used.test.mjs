/**
 * ── v254 (B4-0b-1 A10): the skill layer can finally participate in the N-generation downgrade ──
 *
 * The audit's P1-4, measured: `store/skill.ts:650` wrote `last_used = now` for a BRAND-NEW skill
 * (`… : now`), and `documents.ts:209` derived `referenced` from `last_used`. So `referenced` was
 * true from the instant of creation, and `generation.ts:118` (`if (item.referenced !== false) return
 * NONE`) made the downgrade **unreachable for skills** — the mechanism existed on paper, ran on
 * negatives, and never touched the layer that carries most of the value.
 *
 * Two changes, and the SECOND is the one that is easy to miss:
 *
 *   ① a new skill is written with an EMPTY `last_used` (created is not used); `touchSkillUsage` is
 *      the only writer that fills it;
 *   ② "field present but empty" and "field absent" are different facts:
 *        · present + empty ⇒ this build created it and nobody recalled it ⇒ `referenced === false`;
 *        · absent          ⇒ an old file, nobody knows ⇒ `undefined` = UNKNOWN, never downgraded.
 *      Collapsing them would either demote every legacy skill on upgrade day or keep new skills
 *      immune forever — the second is exactly the bug.
 *
 * ── the stop condition this file answers ──────────────────────────────────────────────────────────
 *
 * The dispatch's §六 ③ warns that changing `last_used` semantics could change the downgrade judgment
 * of the 6 skills already in the real store. It does NOT: those files already carry a `last_used`
 * value and keep it (a merge preserves an existing stamp, and this change only affects what a NEW
 * file starts with). Their judgment is byte-for-byte unchanged — they stay `referenced: true`, as
 * `v248 ③` asserts for any skill with a stamp.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generationDowngradeFor, isReferenced } from '../lib/generation.js'
import { skillDocuments } from '../lib/retrieve/documents.js'
import { renderHint, retrieveCandidates } from '../lib/retrieve.js'
import { touchSkillUsage, writeSkill } from '../lib/store.js'

const WORKSPACE = 'D:/持久层能力架构'
const meta = { sessionId: 'sess-a', workspace: WORKSPACE, provenance: 'tool', generation: 1 }

function env() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v254-'))
  const skillsDir = join(root, 'skills')
  const memoryDir = join(root, 'memory')
  mkdirSync(skillsDir, { recursive: true })
  mkdirSync(memoryDir, { recursive: true })
  return { skillsDir, memoryDir }
}

const skill = (name) => ({
  name,
  title: `${name} 的做法`,
  description: '什么时候用、怎么做、怎么验证',
  when: '场景：台账迁移',
  steps: ['先读台账', '再改记录'],
  verify: ['台账里出现新行'],
  evidence: [{ sourceSessionId: 'sess-a', seq: 1 }],
  confidence: 0.5,
})

/** An OLD skill: the field is ABSENT entirely (written by a build before A10). */
function writeLegacySkill(skillsDir, name, generation = 1) {
  mkdirSync(join(skillsDir, name), { recursive: true })
  writeFileSync(
    join(skillsDir, name, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${name} 的说明`,
      'when_to_use: 当需要处理台账迁移时',
      'scope: project',
      'scene: general',
      `workspace: ${WORKSPACE}`,
      'provenance: tool',
      'evidence: sess-a@1',
      'sources: 1',
      `generation: ${generation}`,
      'valid_at: 2026-01-01',
      '---',
      '',
      `# ${name}`,
      '',
      '## 执行步骤',
      '',
      '1. 读台账',
      '',
      '## 验证标准',
      '',
      '- 幂等',
      '',
    ].join('\n'),
    'utf8',
  )
}

const recall = (skillsDir, memoryDir, extra = {}) =>
  retrieveCandidates(memoryDir, skillsDir, '台账迁移', { threshold: 0.001, workspace: WORKSPACE, ...extra })

test('v254 ①: 新建技能 ⇒ last_used 是空字段，referenced === false', () => {
  const { skillsDir, memoryDir } = env()
  writeSkill(skillsDir, skill('brand-new'), meta)

  const text = readFileSync(join(skillsDir, 'brand-new', 'SKILL.md'), 'utf8')
  const line = text.match(/^last_used:[ \t]*(.*)$/mu)
  assert.ok(line !== null, '字段必须存在（present + empty），否则「老文件」与「新技能」又分不开了')
  assert.equal(line[1], '', `新建时不许写时间戳；实测 ${JSON.stringify(line[1])}`)

  const hits = recall(skillsDir, memoryDir, { generationMode: 'never', currentGeneration: 3 })
  const hit = hits.find((entry) => entry.id === 'brand-new')
  assert.ok(hit !== undefined)
  /**
   * Asserted on the DOCUMENT, not on the hit: `referenced` is a field of the retrieval document
   * (`documents.ts` decides it); the scored hit is a different shape and does not carry every field.
   * The point of ① is the decision itself, so the decision is what gets asserted.
   */
  const doc = skillDocuments(skillsDir, Date.now()).find((entry) => entry.id === 'brand-new')
  assert.equal(doc?.referenced, false, 'created ≠ used：新技能必须能被判为「未被引用」')
})

test('v254 ②: 真被引用一次之后 ⇒ referenced === true（靠 touchSkillUsage 填值）', () => {
  const { skillsDir, memoryDir } = env()
  writeSkill(skillsDir, skill('used-later'), meta)
  assert.equal(touchSkillUsage(skillsDir, 'used-later', '2026-11-19T03:00:00.000Z'), true)

  const hits = recall(skillsDir, memoryDir, { generationMode: 'never', currentGeneration: 3 })
  assert.ok(hits.some((entry) => entry.id === 'used-later'), '仍然召回')
  const doc = skillDocuments(skillsDir, Date.now()).find((entry) => entry.id === 'used-later')
  assert.equal(doc?.referenced, true)
  assert.match(readFileSync(join(skillsDir, 'used-later', 'SKILL.md'), 'utf8'), /^last_used: 2026-11-19T03:00:00.000Z$/mu)
})

test('v254 ③: 降级真的会落在新技能上（mode=always + 落后 N 代）—— A10 之前这条永远不可能', () => {
  const { skillsDir, memoryDir } = env()
  writeSkill(skillsDir, skill('downgradable'), meta)

  const off = recall(skillsDir, memoryDir, { generationMode: 'never', currentGeneration: 4, generationMin: 2 })
  const on = recall(skillsDir, memoryDir, { generationMode: 'always', currentGeneration: 4, generationMin: 2 })
  const before = off.find((entry) => entry.id === 'downgradable')
  const after = on.find((entry) => entry.id === 'downgradable')

  assert.equal(before.generationBehind, undefined, '默认模式不许改变行为')
  assert.equal(after.generationBehind, 3, `落后 3 代必须被写出来，实测 ${after.generationBehind}`)
  assert.ok(after.score < before.score, '降级必须落在分数上')
  assert.match(String(renderHint({ skill: after })), /代未被引用/u)
})

test('v254 ④: 老文件（字段完全缺失）⇒ 未知 ⇒ 永不降级（人工数据不许被自动判死）', () => {
  const { skillsDir, memoryDir } = env()
  writeLegacySkill(skillsDir, 'legacy-unknown', 1)

  const hits = recall(skillsDir, memoryDir, { generationMode: 'always', currentGeneration: 9, generationMin: 2 })
  const hit = hits.find((entry) => entry.id === 'legacy-unknown')
  assert.ok(hit !== undefined, '仍然召回')
  const doc = skillDocuments(skillsDir, Date.now()).find((entry) => entry.id === 'legacy-unknown')
  assert.equal(doc?.referenced, undefined, '没有字段 ⇒ 未知，不是「从未用过」')
  assert.equal(hit.generationBehind, undefined, '未知永不降级')
})

test('v254 ⑤: 两个判据各自独立 —— present+empty 与 absent 走不同分支（不是同一个答案的两种写法）', () => {
  assert.equal(isReferenced({ lastUsed: '', sources: 1 }), false, '空字段 ⇒ 真·未被引用')
  assert.equal(isReferenced({ sources: 1 }), false, '只有 sources 时 isReferenced 本身不知道「有没有字段」')
  assert.equal(isReferenced({}), undefined, '一个计数器都没有 ⇒ 未知')
  /** And the downgrade refuses both `true` and `undefined`. */
  const options = { currentGeneration: 9, minGenerations: 2, mode: 'always' }
  assert.equal(generationDowngradeFor({ generation: 1, referenced: undefined }, options).downgrade, false)
  assert.equal(generationDowngradeFor({ generation: 1, referenced: true }, options).downgrade, false)
  assert.equal(generationDowngradeFor({ generation: 1, referenced: false }, options).downgrade, true)
})