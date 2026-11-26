/**
 * ── v369：同一个 workspace 的大小写变体不是跨区冲突（F4 / S13）────────────────────────────────────
 *
 * 病（实测 2026-11-26，`src/store/skill.ts:1026`）：
 *
 *     const crossWorkspace = next.length > 0 && prev.length > 0 && next !== prev
 *
 * 那是**字符串比较**。而本仓的检索侧走的是 `src/workspace.ts:62 sameWorkspace()`，
 * 它对 Windows 路径做大小写归一（`workspaceKey` 在 `win32` 或 `X:/` 形状上 `toLowerCase()`）。
 *
 * 于是同一个目录的两种写法在两侧得到**相反**的答案：
 *
 *     写侧   `D:/ws/Alpha` !== `d:/ws/alpha`  ⇒ 跨区覆写 ⇒ 另存 + 记一条 workspace-conflict
 *     检索侧 sameWorkspace(...) === true      ⇒ 同一个工作区 ⇒ 两条都能被读到
 *
 * 后果不是丢数据，是**凭空制造一份副本和一条冲突记录**，而读它的人会去查一个不存在的
 * 跨区覆写。**假警比漏警更难发现**，因为它自带证据。
 *
 * ── 判据为什么必须跑真实写入，而不是只测 `sameWorkspace` ──────────────────────────────────────
 *
 * `sameWorkspace` 本来就有测试（`v08-workspace`）。这条判据要证的是**写路径用了它**——
 * 所以走 `writeSkill` 的真实入口，然后数**磁盘上到底有几份**。一个只断言
 * 「sameWorkspace 返回 true」的判据，在 `!==` 还在的时候照样绿。
 *
 * ── 夹具的形状是量出来的，不是猜的 ────────────────────────────────────────────────────────────
 *
 * 本文件的初版夹具缺 `description` / `when` / `sessionId` / `seq`，被 `writeSkill` 的前置校验
 * 拒成 `skipped:no execution steps`（第一版）与 `ref.sourceSessionId.length` 崩（第二版）——
 * 于是测的是「夹具合法吗」，不是写路径用没用 `sameWorkspace`。形状照 `v360` 的实测夹具抄：
 * `writeSkill(skills, skill, meta)`，落盘成 `<name>/SKILL.md`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { writeSkill, readSkillWorkspace } = await import('../lib/store/skill.js')

/** A skill the store accepts; the workspace under test lives in `meta`, as in v360. */
const skillFor = (name) => ({
  name,
  title: `标题 ${name}`,
  description: '一句话描述，用于通过形状检查。',
  when: '当这条判据需要一份真实形状的 SKILL.md 时。',
  steps: ['第一步：写下来。', '第二步：读回去。'],
  verify: ['判据：读回的内容与写入的一致。'],
  tags: ['v369'],
})

const metaFor = (workspace) => ({ workspace, sessionId: 'v369-session', confidence: 1 })

/** The real layout: `<name>/SKILL.md`. */
const skillFile = (skills, name) => join(skills, name, 'SKILL.md')
const skillDirs = (skills) =>
  readdirSync(skills).filter((entry) => statSync(join(skills, entry)).isDirectory())

test('v369 ①: a Windows CASE VARIANT is the same workspace — one copy, no conflict record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v369-case-'))
  const skills = join(dir, 'skills')
  mkdirSync(skills, { recursive: true })

  try {
    const name = 'case-skill'
    const first = writeSkill(skills, skillFor(name), metaFor('D:/ws/Alpha'))
    assert.equal(first, 'created', `① 第一次写入必须 created（夹具合法），实测：${first}`)

    const second = writeSkill(skills, skillFor(name), metaFor('d:/ws/alpha'))

    const dirs = skillDirs(skills)
    assert.equal(dirs.length, 1,
      `① 大小写变体不得产生第二份，实测目录 ${JSON.stringify(dirs)}（second=${second}）`)

    const body = readFileSync(skillFile(skills, dirs[0]), 'utf8')
    assert.ok(!body.includes('conflicts:'),
      `① 不得写入 conflicts —— 那是假冲突。实测 frontmatter:\n${body.slice(0, 400)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v369 ②: a GENUINELY different workspace still splits (F4 must not widen the normal path)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v369-real-'))
  const skills = join(dir, 'skills')
  mkdirSync(skills, { recursive: true })

  try {
    const name = 'real-skill'
    const first = writeSkill(skills, skillFor(name), metaFor('D:/ws/Alpha'))
    assert.equal(first, 'created', `② 第一次写入必须 created，实测：${first}`)

    const second = writeSkill(skills, skillFor(name), metaFor('D:/ws/Beta'))

    const dirs = skillDirs(skills)
    assert.equal(dirs.length, 2,
      `② 真正不同的 workspace 必须另存，实测 ${JSON.stringify(dirs)}（second=${second}）`)
    assert.ok(String(second).includes('workspace-conflict'),
      `② 必须报告 workspace-conflict，实测 ${second}`)

    /**
     * 这一侧防的是「把 `!==` 换成 `sameWorkspace` 时顺手把整个分支关掉」——
     * 那会让 ① 绿而真正该拆的场景不再拆。真假两侧必须同时成立。
     *
     * 冲突记录的位置是**量出来的**：它不在 SKILL.md 的 frontmatter 里，而在 `skills-edges.jsonl`
     * （`linkConflictBack` 写边账的地方，`v360 ②` 同款）。第一版断言 frontmatter 里的 `conflicts:`，
     * 那是我按印象写的、与真实产物不同的位置 —— **判据要读最终产物，不是中间对象**。
     */
    const altDirs = dirs.filter((entry) => entry !== name)
    assert.equal(altDirs.length, 1, `② 必须有且只有一份另存（实测 ${JSON.stringify(altDirs)}）`)
    assert.equal(readSkillWorkspace(readFileSync(skillFile(skills, altDirs[0]), 'utf8')), 'D:/ws/Beta',
      '② 另存那份的 workspace 必须是新的（否则 B 的写入凭空消失）')

    const edges = readFileSync(join(skills, 'skills-edges.jsonl'), 'utf8')
    assert.ok(edges.includes(name) && edges.includes(altDirs[0]),
      `② 冲突必须写进 skills-edges.jsonl（实测：${edges.trim().slice(0, 200) || '空'}）`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
