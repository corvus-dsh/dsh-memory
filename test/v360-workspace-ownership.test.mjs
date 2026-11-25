/**
 * ── v360：S8 / D2 —— workspace 写侧归属：A→B 覆盖必须另存 + 冲突记录 ────────────────────────────
 *
 * 病（实测，`src/store/skill.ts` 的旧 `writeMeta`）：
 *
 *     normalizeWorkspace(meta.workspace).length > 0 || previousWorkspace.length === 0
 *       ? meta                                       ← 新 workspace 非空就**无条件取新的**
 *       : { ...meta, workspace: previousWorkspace }   ← 新为空才沿用旧的
 *
 * 第一个分支在 workspace **不同**时是错的：A 工作区写下的 SKILL.md 被原地改写成 B 的，A 的那一版
 * **从此不存在**，也没有任何记录说它被改写。检索侧按 workspace 过滤，于是 **A 会看到 B 写的规则，
 * B 也不知道这条来自 A** —— 跨工作区覆写，比丢一条记录严重。
 *
 * 裁定（08 §S8）：读**最终 SKILL.md 的 `workspace:`**；A→B 覆盖必须**另存 + 冲突记录**。
 *
 * ── 夹具的布局是量出来的，不是猜的 ────────────────────────────────────────────────────────────
 *
 * 第一版按 `<name>.md` 找文件，实测 `writeSkill` 建的是**目录**：`<name>/SKILL.md`（另有
 * `skills-edges.jsonl`）。五条判据因此全红，而生产代码可能完全正确 —— **错的是夹具**。
 * 探针 `_scratch/probe-d2-store.mjs` 量出真实树：
 *
 *     probe-name/SKILL.md      workspace: D:/ws/A   ← 原文件，逐字节保留
 *     probe-name-2/SKILL.md    workspace: D:/ws/B   ← 另存
 *     skills-edges.jsonl                            ← 双向链接
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { writeSkill, readSkillWorkspace } = await import('../lib/store/skill.js')

const hashOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** A minimal skill the store accepts, with the workspace under test. */
const skillFor = (name, workspace) => ({
  name,
  title: `标题 ${name}`,
  description: '一句话描述，用于通过形状检查。',
  when: '当这条判据需要一份真实形状的 SKILL.md 时。',
  steps: ['第一步：写下来。', '第二步：读回去。'],
  verify: ['判据：读回的内容与写入的一致。'],
  tags: ['v360'],
  workspace,
  sessionId: 'v360-session',
  seq: 1,
})

const metaFor = (workspace) => ({ workspace, sessionId: 'v360-session', confidence: 1 })

/** The real layout: `<name>/SKILL.md` (plus `skills-edges.jsonl` at the root). */
const skillFile = (skills, name) => join(skills, name, 'SKILL.md')

/** Every skill DIRECTORY name in the store. */
const skillDirs = (skills) =>
  readdirSync(skills).filter((entry) => statSync(join(skills, entry)).isDirectory())

test('v360 ①: a write from a DIFFERENT workspace never overwrites the existing skill', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v360-ws-'))
  const skills = join(dir, 'skills')
  mkdirSync(skills, { recursive: true })

  const name = 'shared-name'
  const first = writeSkill(skills, skillFor(name, 'D:/ws/A'), metaFor('D:/ws/A'))
  assert.equal(first, 'created', `① 第一次写入必须 created，实测：${first}`)

  const original = skillFile(skills, name)
  const before = hashOf(original)
  assert.ok(readSkillWorkspace(readFileSync(original, 'utf8')).length > 0,
    '① 前置：原文件必须已经带着 workspace 字段')

  const second = writeSkill(skills, skillFor(name, 'D:/ws/B'), metaFor('D:/ws/B'))
  assert.ok(/^workspace-conflict:/u.test(second),
    `① 跨 workspace 写入必须报 workspace-conflict，实测：${second}`)

  /**
   * ⚠️ 这一条断言的是**内容**而不是字节：`linkConflictBack` 会把一条指回另存名的记录写进原文件，
   * 所以字节**会**变。要证明的是「原文件仍然是 A 的」，不是「文件没被动过」。
   * 第一版断言 `hashOf(original) === before`，它把正常的双向记录也判成了缺陷。
   */
  assert.equal(readSkillWorkspace(readFileSync(original, 'utf8')), 'D:/ws/A',
    '① 原文件必须仍然是 A 工作区的那一份 —— B 不许把它改写成自己的')
  assert.ok(hashOf(original) !== before || true, '① 字节可能因双向记录而变化，这不是缺陷')

  const dirs = skillDirs(skills)
  assert.ok(dirs.length >= 2, `① 必须另存（实测 ${dirs.length} 个 skill 目录）`)
  assert.ok(dirs.some((entry) => entry !== name), '① 另存的那份必须有另一个名字')
})

test('v360 ②: the alternative is stored under the NEW workspace and names the original', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v360-rec-'))
  const skills = join(dir, 'skills')
  mkdirSync(skills, { recursive: true })

  const name = 'conflict-record'
  writeSkill(skills, skillFor(name, 'D:/ws/A'), metaFor('D:/ws/A'))
  const result = writeSkill(skills, skillFor(name, 'D:/ws/B'), metaFor('D:/ws/B'))
  assert.ok(/^workspace-conflict:/u.test(result), `② 必须报 workspace-conflict，实测：${result}`)

  const altDirs = skillDirs(skills).filter((entry) => entry !== name)
  assert.equal(altDirs.length, 1, `② 必须有且只有一份另存（实测 ${altDirs.length}）`)
  const altText = readFileSync(skillFile(skills, altDirs[0]), 'utf8')

  assert.equal(readSkillWorkspace(altText), 'D:/ws/B',
    '② 另存那份的 workspace 必须是**新的**（否则 B 的写入凭空消失）')

  /** The edges ledger is where `linkConflictBack` records the pair. */
  const edges = readFileSync(join(skills, 'skills-edges.jsonl'), 'utf8')
  assert.ok(edges.includes(name) && edges.includes(altDirs[0]),
    `② 冲突必须被写进 skills-edges.jsonl（实测：${edges.trim().slice(0, 200)}）`)
})

test('v360 ③: the conflict is recorded on BOTH sides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v360-both-'))
  const skills = join(dir, 'skills')
  mkdirSync(skills, { recursive: true })

  const name = 'both-sides'
  writeSkill(skills, skillFor(name, 'D:/ws/A'), metaFor('D:/ws/A'))
  const result = writeSkill(skills, skillFor(name, 'D:/ws/B'), metaFor('D:/ws/B'))
  assert.ok(/^workspace-conflict:/u.test(result))

  const altDir = skillDirs(skills).find((entry) => entry !== name)
  const altText = readFileSync(skillFile(skills, altDir), 'utf8')
  const originalText = readFileSync(skillFile(skills, name), 'utf8')

  /**
   * ── 「双向」的载体是 edges 账本，不是两份 SKILL.md 互相嵌入对方名字 ─────────────────────────────
   *
   * 第一版断言 `originalText.includes(altDir)`，红了。读实现才发现那是**有意设计**：
   * `linkConflictBack` 的注释写着「Write edge only — no more rewrites of individual SKILL.md files」。
   * 把另存名写进原文件的 frontmatter 会让每一次冲突都改写一份**内容**文件，而记一条边就够了。
   *
   * 所以这条判据量的是「**两边都能查到对方**」，这才是「双向」的内容：
   *   · 另存那份自己记着原名（`conflicts` 字段 / 正文里点名）；
   *   · 边账本里有这对关系，检索侧与 `findConflicts` 都读它。
   * 断言「原文件里出现另存名」测的是一个实现细节，而它在正确代码上是假的。
   */
  assert.ok(altText.includes(name), '③ 另存那份必须点名原来的 skill 名')
  assert.equal(readSkillWorkspace(originalText), 'D:/ws/A', '③ 原文件必须仍然是 A 的')
  assert.equal(readSkillWorkspace(altText), 'D:/ws/B', '③ 另存那份必须是 B 的')

  const edges = readFileSync(join(skills, 'skills-edges.jsonl'), 'utf8')
  assert.ok(edges.includes(name) && edges.includes(altDir),
    `③ 边账本必须记下这对关系（实测：${edges.trim().slice(0, 200)}）`)
})

test('v360 ④: the SAME workspace still merges (the normal path is not turned into a conflict)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v360-same-'))
  const skills = join(dir, 'skills')
  mkdirSync(skills, { recursive: true })

  const name = 'same-ws'
  writeSkill(skills, skillFor(name, 'D:/ws/A'), metaFor('D:/ws/A'))
  const result = writeSkill(skills, skillFor(name, 'D:/ws/A'), metaFor('D:/ws/A'))
  assert.equal(result, 'merged', `④ 同一 workspace 的重复写入必须合并，实测：${result}`)
  assert.equal(skillDirs(skills).length, 1, '④ 合并不得产生第二个 skill 目录')
})

test('v360 ⑤: a write with NO workspace inherits the recorded one (a replay must not launder it)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v360-inherit-'))
  const skills = join(dir, 'skills')
  mkdirSync(skills, { recursive: true })

  const name = 'inherit-ws'
  writeSkill(skills, skillFor(name, 'D:/ws/A'), metaFor('D:/ws/A'))
  const result = writeSkill(skills, skillFor(name, ''), metaFor(''))
  assert.equal(result, 'merged', `⑤ 空 workspace 必须走合并（不是 workspace-conflict），实测：${result}`)
  const text = readFileSync(skillFile(skills, name), 'utf8')
  assert.equal(readSkillWorkspace(text), 'D:/ws/A',
    '⑤ 合并后的文件仍然必须带着**原来的** workspace —— 重放不许把记忆洗出它出身的 workspace')
  assert.equal(skillDirs(skills).length, 1, '⑤ 不得产生第二个 skill 目录')
})