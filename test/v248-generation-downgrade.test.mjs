/**
 * ── v248 (B3 收口 / b3-f8): N 代未引用降级 ──────────────────────────────────────────────────────
 *
 * 判据写在 `docs/gen-downgrade.md`（**先写判据再写码**）。两条定义：
 *
 *   「一代」   = memory 自己记录的 `generation`；当前代从**同一个** `.graft-targets.json` 读最大值。
 *   「被引用」 = 记录自己身上的使用痕迹（技能 `last_used` 非空 或 `sources>1`；负知识 `hits>1`），
 *                与 `memory_stats` 的四个来源同一口径。没有计数 ⇒ 未知，未知永不降级。
 *
 * 真实 store 的实测（`docs/gen-downgrade.md` §4）：6 条技能里**带 `generation` 的 0 条**，
 * 所以 N 不定、机制默认关闭。本文件用夹具证明：**规则一旦打开确实会降级**，且两条边界
 * （默认关闭 / 未知不降）与一条对照（被引用过的不降）各自独立。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_GENERATION_MODE,
  GENERATION_DOWNGRADE_WEIGHT,
  generationDowngradeFor,
  isReferenced,
  readCurrentGeneration,
} from '../lib/generation.js'
import { renderHint, retrieve, retrieveCandidates } from '../lib/retrieve.js'
/** b3-f8: the writer-side invalidation a real SKILL write performs (see test ⑤). */
import { invalidateSkillDocs } from '../lib/skill-cache.js'

const WORKSPACE = 'D:/持久层能力架构'

/** One SKILL.md carrying the fields the downgrade reads. */
function writeSkill(skillsDir, name, { generation, lastUsed = '', sources = 1 }) {
  mkdirSync(join(skillsDir, name), { recursive: true })
  writeFileSync(
    join(skillsDir, name, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${name} 的说明`,
      `when_to_use: 当需要 ${name} 处理台账迁移时`,
      'scope: project',
      'scene: general',
      `workspace: ${WORKSPACE}`,
      'provenance: tool',
      'evidence: sess-a@1',
      `sources: ${sources}`,
      ...(lastUsed.length === 0 ? [] : [`last_used: ${lastUsed}`]),
      ...(generation === undefined ? [] : [`generation: ${generation}`]),
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

function env() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v248-'))
  const skillsDir = join(root, 'skills')
  const memoryDir = join(root, 'memory')
  mkdirSync(skillsDir, { recursive: true })
  mkdirSync(memoryDir, { recursive: true })
  return { root, skillsDir, memoryDir }
}

const recall = (skillsDir, memoryDir, extra = {}) =>
  retrieveCandidates(memoryDir, skillsDir, '台账迁移', { threshold: 0.001, workspace: WORKSPACE, ...extra })

// ── ① 默认 never：行为与现状逐字相同 ────────────────────────────────────────────────────────

test('v248 ①: 默认是 never ⇒ 再老再没被引用也不降级（现状不变）', () => {
  const { skillsDir, memoryDir } = env()
  writeSkill(skillsDir, 'ancient-unused', { generation: 1 })

  assert.equal(DEFAULT_GENERATION_MODE, 'never')
  const hits = recall(skillsDir, memoryDir, { currentGeneration: 9, generationMin: 2 })
  const hit = hits.find((entry) => entry.id === 'ancient-unused')
  assert.ok(hit !== undefined, '仍然召回 —— 降级不是删除')
  assert.equal(hit.generationBehind, undefined, '默认不许降级')
  assert.equal(renderHint({ skill: hit })?.includes('代未被引用'), false)
})

// ── ② 打开后：落后 N 代 + 从未被引用 ⇒ 降级，且说出来 ───────────────────────────────────────

test('v248 ②: mode=always + N=2 + 未被引用 + 落后 2 代 ⇒ 分数减半并在文案里说明', () => {
  const { skillsDir, memoryDir } = env()
  writeSkill(skillsDir, 'old-unused', { generation: 1 })
  writeSkill(skillsDir, 'old-used', { generation: 1, lastUsed: '2026-03-01T00:00:00.000Z' })

  const off = recall(skillsDir, memoryDir, { generationMode: 'never', currentGeneration: 3, generationMin: 2 })
  const on = recall(skillsDir, memoryDir, { generationMode: 'always', currentGeneration: 3, generationMin: 2 })

  const unusedOff = off.find((entry) => entry.id === 'old-unused')
  const unusedOn = on.find((entry) => entry.id === 'old-unused')
  assert.ok(unusedOff !== undefined && unusedOn !== undefined, '打开前后都必须召回')
  assert.equal(unusedOn.generationBehind, 2, '落后 2 代必须被写出来')
  assert.ok(
    unusedOn.score < unusedOff.score,
    `降级必须真的落在分数上：on=${unusedOn.score} off=${unusedOff.score}`,
  )
  assert.ok(
    Math.abs(unusedOn.score / unusedOff.score - GENERATION_DOWNGRADE_WEIGHT) < 0.02,
    '权重就是公开的常量（0.5），不是另一个私下的数',
  )

  const hint = renderHint({ skill: unusedOn })
  assert.ok(hint !== undefined)
  assert.ok(hint.includes('[2 代未被引用]'), `文案必须写明原因与代数：${hint}`)
})

// ── ③ 对照：被引用过的不降级 ────────────────────────────────────────────────────────────────

test('v248 ③: 对照 —— 被引用过的老记录**不**降级（只看「老」会奖励一个把什么都降权的实现）', () => {
  const { skillsDir, memoryDir } = env()
  /** Two equally old records; only one has ever been used. */
  writeSkill(skillsDir, 'old-used', { generation: 1, lastUsed: '2026-03-01T00:00:00.000Z' })
  writeSkill(skillsDir, 'old-unused', { generation: 1 })
  /** And the other usage shape: confirmation by two independent writes. */
  writeSkill(skillsDir, 'old-confirmed', { generation: 1, sources: 3 })

  const hits = recall(skillsDir, memoryDir, { generationMode: 'always', currentGeneration: 5, generationMin: 2 })
  const byId = new Map(hits.map((hit) => [hit.id, hit]))

  assert.equal(byId.get('old-unused')?.generationBehind, 4, '没用过的那条必须降级（对照组）')
  assert.equal(byId.get('old-used')?.generationBehind, undefined, 'last_used 非空 ⇒ 不降级')
  assert.equal(byId.get('old-confirmed')?.generationBehind, undefined, 'sources > 1 ⇒ 不降级')
})

// ── ④ 未知不降级：三条 ──────────────────────────────────────────────────────────────────────

test('v248 ④: 未知永不降级 —— 无 generation / 无当前代 / N 未给，三种都不许动', () => {
  const { skillsDir, memoryDir } = env()
  writeSkill(skillsDir, 'no-generation', {})
  writeSkill(skillsDir, 'old-unused', { generation: 1 })

  /** No `generation` on the record ⇒ cannot be compared. */
  const a = recall(skillsDir, memoryDir, { generationMode: 'always', currentGeneration: 5, generationMin: 2 })
  assert.equal(a.find((hit) => hit.id === 'no-generation')?.generationBehind, undefined)

  /** No current generation (an unreadable targets file) ⇒ unknown. */
  const b = recall(skillsDir, memoryDir, { generationMode: 'always', generationMin: 2 })
  assert.equal(b.find((hit) => hit.id === 'old-unused')?.generationBehind, undefined)

  /** `always` without N ⇒ N has not been decided ⇒ nothing happens. */
  const c = recall(skillsDir, memoryDir, { generationMode: 'always', currentGeneration: 5 })
  assert.equal(c.find((hit) => hit.id === 'old-unused')?.generationBehind, undefined)

  /** And the pure rule says the same thing (one answer, two layers). */
  assert.equal(generationDowngradeFor({ generation: 1, referenced: false }, { currentGeneration: 5, mode: 'always' }).downgrade, false)
  assert.equal(generationDowngradeFor({ generation: 1, referenced: undefined }, { currentGeneration: 5, mode: 'always', minGenerations: 2 }).downgrade, false)
})

// ── ⑤ 可逆：被引用之后就不再降级（文件没被删、也没被改写） ──────────────────────────────────

test('v248 ⑤: 降级可逆 —— 记下一次引用后，同一份记录下一轮不再降级', () => {
  const { skillsDir, memoryDir } = env()
  writeSkill(skillsDir, 'old-unused', { generation: 1 })
  const before = recall(skillsDir, memoryDir, { generationMode: 'always', currentGeneration: 4, generationMin: 2 })
  assert.equal(before.find((hit) => hit.id === 'old-unused')?.generationBehind, 3)

  /** A later injection writes `last_used`; nothing else about the file changes. */
  writeSkill(skillsDir, 'old-unused', { generation: 1, lastUsed: '2026-11-19T00:00:00.000Z' })
  /**
   * A REAL WRITER announces itself: `writeSkill` calls `invalidateSkillDocs` after writing, which
   * is the primary invalidation mechanism. The cache's hour-granular fallback exists only for a
   * FOREIGN writer, and rewriting a file inside the same hour does not change the DIRECTORY mtime
   * — so a test that skipped this call would be measuring the cache's blind spot, not the rule.
   */
  invalidateSkillDocs(skillsDir)
  const after = recall(skillsDir, memoryDir, { generationMode: 'always', currentGeneration: 4, generationMin: 2 })
  assert.equal(after.find((hit) => hit.id === 'old-unused')?.generationBehind, undefined, '用过之后自动恢复')
})

// ── ⑥ 「被引用」与「未知」是两个答案，且 generation 读的是同一个文件 ──────────────────────

test('v248 ⑥: isReferenced 的三态 / readCurrentGeneration 读同一个 targets 文件', () => {
  assert.equal(isReferenced({ lastUsed: '', sources: 1 }), false, '有计数且都没用过 ⇒ false')
  assert.equal(isReferenced({ lastUsed: '2026-01-01' }), true)
  assert.equal(isReferenced({ sources: 2 }), true)
  assert.equal(isReferenced({ hits: 3 }), true)
  assert.equal(isReferenced({}), undefined, '没有任何计数 ⇒ 未知（不是 false）')

  const root = mkdtempSync(join(tmpdir(), 'dsh-v248-targets-'))
  const graftDir = join(root, 'graft')
  mkdirSync(graftDir, { recursive: true })
  assert.equal(readCurrentGeneration(graftDir), 0, '文件不存在 ⇒ 0 = 未知')
  writeFileSync(
    join(graftDir, '.graft-targets.json'),
    JSON.stringify({ s1: { generation: 1 }, s2: { generation: 4 }, s3: { generation: 2 } }),
    'utf8',
  )
  assert.equal(readCurrentGeneration(graftDir), 4, '取最大值')

  /** And the real path agrees with the pure rule: `retrieve` (stage 1 + hint) carries it too. */
  const { skillsDir, memoryDir } = env()
  writeSkill(skillsDir, 'old-unused', { generation: 1 })
  const result = retrieve(memoryDir, skillsDir, '台账迁移', {
    threshold: 0.001,
    workspace: WORKSPACE,
    generationMode: 'always',
    currentGeneration: 5,
    generationMin: 2,
  })
  assert.equal(result.skill?.generationBehind, 4)
  assert.ok(renderHint(result)?.includes('[4 代未被引用]'))
})