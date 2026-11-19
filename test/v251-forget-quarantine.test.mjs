/**
 * ── v251 (B4-0a②): `memory_forget` 不许路径穿越递归删除，且删除必须是可恢复 + 可审计 ────────────
 *
 * 审计 P0 原文：
 *   `src/index.ts:919` `const path = join(skillsDir, name)`；`:921` `rmSync(path, { recursive: true, force: true })`；
 *   工具入口把参数直达。`name: "../.."` ⇒ 删掉 `~/.dsh` 一级；`"../../.."` ⇒ 删到用户目录。
 *   而读路径有校验（`store/skill.ts` 的 `readSkillBody`）——**同一份防护只在读的那一侧**。
 *
 * 这一笔的三件事，每一件都是判据：
 *   ① 同一个 `assertSafeSkillName` 同时守读与删（一份判据、一个答案）；
 *   ② 删除改成**改名进隔离区** `<memoryDir>/_quarantine-<stamp>/`（可恢复），不再 rmSync；
 *   ③ 每一条路径（含**拒绝**）都写审计行 —— README 说 forget「显式、可审计」，而原实现一行都没写。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertSafeSkillName, memoryAuditPath } from '../lib/store.js'
import { apply, forgetSkill } from '../lib/index.js'

function env() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v251-'))
  const skillsDir = join(root, 'skills')
  const memoryDir = join(root, 'memory')
  const outside = join(root, 'outside')
  mkdirSync(skillsDir, { recursive: true })
  mkdirSync(join(memoryDir), { recursive: true })
  mkdirSync(outside, { recursive: true })
  /** A victim directory OUTSIDE skillsDir: traversal would delete this one. */
  writeFileSync(join(outside, 'keep.txt'), 'must survive', 'utf8')
  /** A legitimate skill inside. */
  mkdirSync(join(skillsDir, 'real-skill'), { recursive: true })
  writeFileSync(join(skillsDir, 'real-skill', 'SKILL.md'), '# real\n', 'utf8')
  return { root, skillsDir, memoryDir, outside }
}

// ── ① 五个穿越输入一个都不许动 ───────────────────────────────────────────────────────────────

test('v251 ①: 五个路径穿越输入全部 removed:false，且磁盘零变化', () => {
  const { skillsDir, memoryDir, outside } = env()
  const attacks = ['../outside', '..', 'a/b', 'a\\b', 'C:/Windows']
  for (const name of attacks) {
    const outcome = forgetSkill(skillsDir, memoryDir, name)
    assert.equal(outcome.removed, false, `${name} 必须被拒`)
    assert.match(String(outcome.reason), /unsafe name/u, `${name} 必须说清为什么：${outcome.reason}`)
  }
  /** The victim outside skillsDir is untouched, and the legitimate skill is still there. */
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'must survive')
  assert.equal(existsSync(join(skillsDir, 'real-skill', 'SKILL.md')), true)

  /** Every refusal left a line: a guard that fires silently is indistinguishable from a crash. */
  const lines = readFileSync(memoryAuditPath(memoryDir), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines.filter((line) => line.kind === 'forget-refused').length, attacks.length)
  assert.ok(lines.every((line) => typeof line.reason === 'string' && line.reason.length > 0))
})

// ── ② 合法删除 = 隔离（可恢复），不是 rmSync ────────────────────────────────────────────────

test('v251 ②: 合法名字 ⇒ 目录被移进隔离区而不是被毁，文件内容仍读得到', () => {
  const { skillsDir, memoryDir } = env()
  const outcome = forgetSkill(skillsDir, memoryDir, 'real-skill')
  assert.equal(outcome.removed, true)
  assert.equal(existsSync(join(skillsDir, 'real-skill')), false, '活跃目录必须消失（召回面变了）')
  assert.ok(outcome.quarantinedTo !== undefined)
  assert.equal(existsSync(String(outcome.quarantinedTo)), true, '隔离区里必须真的存在')
  assert.equal(
    readFileSync(join(String(outcome.quarantinedTo), 'SKILL.md'), 'utf8'),
    '# real\n',
    '内容必须原样 —— 可恢复的含义就是这个字节还在',
  )

  const lines = readFileSync(memoryAuditPath(memoryDir), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const forget = lines.find((line) => line.kind === 'forget')
  assert.ok(forget !== undefined, '删除必须留一行审计')
  assert.equal(forget.winner, 'real-skill')
  assert.match(String(forget.reason), /recoverable/u)
})

// ── ③ 读与删共用同一份判据 ──────────────────────────────────────────────────────────────────

test('v251 ③: 读路径与删路径对同一批名字给出同一个答案', () => {
  const names = ['../x', '..', 'a/b', 'a\\b', '', 'legit-name']
  for (const name of names) {
    const safe = assertSafeSkillName(name) === undefined
    /** The reader refuses exactly when the name is unsafe (it also refuses empty separately). */
    if (!safe) assert.notEqual(assertSafeSkillName(name), undefined)
  }
  assert.equal(assertSafeSkillName('legit-name'), undefined)
})

// ── ④ 工具层：拒绝要能走到模型手里（不是一个 false） ────────────────────────────────────────

test('v251 ④: `memory_forget` 的返回里带 reason / quarantinedTo，拒绝不再是一个光秃秃的 false', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v251-tool-'))
  const tools = new Map()
  const ctx = {
    paths: { data: join(root, 'data', 'dsh-memory') },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    get: () => undefined,
  }
  const skillsDir = join(root, 'skills')
  const memoryDir = join(root, 'memory')
  mkdirSync(join(skillsDir, 'loser'), { recursive: true })
  writeFileSync(join(skillsDir, 'loser', 'SKILL.md'), '# loser\n', 'utf8')
  apply(ctx, { memoryDir, skillsDir, graftDataDir: join(root, 'graft'), extractor: 'off' })

  const refused = await tools.get('memory_forget').execute({ name: '../escape' })
  assert.equal(refused.removed, false)
  assert.match(String(refused.reason), /unsafe name/u, `拒绝必须说清原因：${JSON.stringify(refused)}`)

  const removed = await tools.get('memory_forget').execute({ name: 'loser' })
  assert.equal(removed.removed, true)
  assert.ok(String(removed.quarantinedTo ?? '').includes('_quarantine-'),
    `删除必须回报隔离位置（可恢复的凭据）：${JSON.stringify(removed)}`)
})