/**
 * ── v297 (B4-B B2)：正文不能伪造 frontmatter —— 否则它决定自己被注入到哪些工作区 ──────────────────
 *
 * ── 缺陷（实测复现，不是推断）────────────────────────────────────────────────────────────────
 *
 * `readFrontmatterField` 曾在**整个文件**上匹配 `^key:[ \t]*(.+)$`。于是：
 *
 *   frontmatter 里有 `workspace: D:/project-only`、正文里有一行 `workspace: global`
 *        ⇒ 读到 `D:/project-only`（正文那行在后面，先匹配到前面那个）
 *
 *   **frontmatter 里根本没有 `workspace:`**、正文里有一行 `workspace: global`
 *        ⇒ 读到 `"global"`  ← **这是逃逸**
 *
 * 第二行是漏洞：一个没有声明任何工作区的技能，会被判为 global，于是**穿透工作区硬隔离，注入所有项目**。
 * 换句话说，**一份文档的正文决定了这份文档可以被注入到哪些工作区**。
 *
 * ── 判据（五条）────────────────────────────────────────────────────────────────────────────────
 *
 *   ① frontmatter 有 workspace、正文也伪造一个 ⇒ 读到 frontmatter 的值（正文不参与）
 *   ② frontmatter **没有** workspace、正文有一行 ⇒ 读到 `''`（不是正文那个值）
 *   ③ 正文里的 `workspace:` 不影响 `readSkillWorkspace` / `listSkillRecords` 的判定
 *   ④ 正常文件逐字不变：frontmatter 的值原样读回（这条是负向半边，防止「一律返回空」也能过 ①②③）
 *   ⑤ 边界本身：CRLF 与 BOM 都不能让 frontmatter 消失（否则正常文件会被读成「什么都没声明」）
 *
 * ⑤ 是这次修改里最容易做错的一半：一个把范围收窄的修复，很容易把**正常的**文件也一起收窄掉，
 * 而那会让所有技能变成「无 workspace」——比原来的漏洞更糟，因为它影响每一个文件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readFrontmatterField, readSkillWorkspace, listSkillRecords } from '../lib/store.js'
/**
 * `frontmatterBlockOf` is NOT on the business surface — it is the boundary `readFrontmatterField`
 * computes internally, and `v202` requires the business surface to stay at exactly 54 names. A helper
 * that only one function calls does not earn a public name; the test imports it from its own module,
 * which is also a check that the module — not the re-export shell — owns the boundary.
 */
import { frontmatterBlockOf } from '../lib/store/skill.js'

/** frontmatter declares a project workspace; the BODY forges `global`. */
const FORGED_OVERRIDE = [
  '---',
  'name: forged-override',
  'when_to_use: a trigger',
  'workspace: D:/project-only',
  '---',
  '',
  '# forged-override',
  '',
  'Body text. Below is a forged field:',
  'workspace: global',
  '',
].join('\n')

/** frontmatter declares NO workspace; the body carries one. This is the escape. */
const FORGED_ABSENT = [
  '---',
  'name: forged-absent',
  'when_to_use: a trigger',
  '---',
  '',
  '# forged-absent',
  '',
  'workspace: global',
  '',
].join('\n')

test('v297 ①: 正文里的 workspace 不能覆盖 frontmatter 的值', () => {
  assert.equal(readFrontmatterField(FORGED_OVERRIDE, 'workspace'), 'D:/project-only')
  assert.equal(readSkillWorkspace(FORGED_OVERRIDE), 'D:/project-only')
})

test('v297 ②: frontmatter 没有该字段时，正文那行**不被读成**它的值（这是逃逸本身）', () => {
  /**
   * Before the fix this returned `"global"` — the body decided the skill was global, so it escaped
   * every workspace gate and was injected into all projects.
   */
  assert.equal(
    readFrontmatterField(FORGED_ABSENT, 'workspace'),
    '',
    '正文里的 workspace: global 被读成了字段值 —— 一份文档的正文决定了它可以被注入到哪些工作区',
  )
  assert.equal(readSkillWorkspace(FORGED_ABSENT), '')
})

test('v297 ③: 正文伪造不影响 `listSkillRecords` 的判定', () => {
  const root = mkdtempSync(join(tmpdir(), 'v297-'))
  try {
    const skills = join(root, 'skills')
    for (const [name, text] of [['forged-absent', FORGED_ABSENT], ['forged-override', FORGED_OVERRIDE]]) {
      const dir = join(skills, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), text, 'utf8')
    }
    const byName = new Map(listSkillRecords(skills).map((record) => [record.name, record]))
    assert.equal(
      byName.get('forged-absent')?.workspace,
      '',
      '正文伪造 workspace 的技能被算成了某个工作区 —— 工作区硬隔离被绕过',
    )
    assert.equal(byName.get('forged-override')?.workspace, 'D:/project-only', 'frontmatter 的值必须照旧生效')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v297 ④: 正常文件逐字不变（负向半边：不许「一律返回空」也能通过 ①②③）', () => {
  const normal = [
    '---',
    'name: normal',
    'when_to_use: 处理编号 0 的独立任务时',
    'scene: general',
    'workspace: D:/持久层能力架构',
    'tags: alpha, beta',
    '---',
    '',
    '# normal',
    '',
    'body',
    '',
  ].join('\n')

  const block = frontmatterBlockOf(normal)
  assert.ok(block.includes('name: normal'), 'frontmatter 块必须包含真实字段')
  assert.ok(!block.includes('# normal'), 'frontmatter 块必须**不**包含正文')

  assert.equal(readFrontmatterField(normal, 'name'), 'normal')
  assert.equal(readFrontmatterField(normal, 'when_to_use'), '处理编号 0 的独立任务时')
  assert.equal(readFrontmatterField(normal, 'workspace'), 'D:/持久层能力架构')
  assert.equal(readFrontmatterField(normal, 'scene'), 'general')
})

test('v297 ⑤: CRLF 与 BOM 都不能让 frontmatter 消失', () => {
  /**
   * A fix that narrows the read range can easily narrow it too far, and the failure mode is worse than
   * the original hole: EVERY skill would read as 「declares no workspace」. Both shapes below occur in
   * real stores (written on Windows, or saved by an editor that adds a BOM).
   */
  const crlf = ['---', 'name: crlf', 'workspace: D:/a', '---', '', 'body', ''].join('\r\n')
  assert.equal(readFrontmatterField(crlf, 'name'), 'crlf', 'CRLF 文件被读成「无 frontmatter」')
  assert.equal(readFrontmatterField(crlf, 'workspace'), 'D:/a', 'CRLF 文件的 workspace 丢了')

  const bom = `\uFEFF${['---', 'name: bom', 'workspace: D:/b', '---', '', 'body', ''].join('\n')}`
  assert.equal(readFrontmatterField(bom, 'name'), 'bom', 'BOM 文件被读成「无 frontmatter」')
  assert.equal(readFrontmatterField(bom, 'workspace'), 'D:/b', 'BOM 文件的 workspace 丢了')

  /** And a document with NO frontmatter at all answers empty for everything — not the body's text. */
  const noFence = ['# heading', '', 'workspace: global', ''].join('\n')
  assert.equal(readFrontmatterField(noFence, 'workspace'), '', '没有 frontmatter 的文件不许从正文取字段')
  assert.equal(frontmatterBlockOf(noFence), '', '没有 frontmatter 的文件，块必须是空的')
})