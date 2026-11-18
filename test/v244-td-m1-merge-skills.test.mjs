/**
 * ── v244 (B3-5 / TD-M1): 合并两技能而一物不失 ────────────────────────────────────────────────
 *
 * TD-M1 的退出条件（照抄 ARCHITECTURE.md，未改写）：
 *
 *   `store.mergeSkills(keeper, absorbed)` 落盘：证据并集（条数 = 两边之和）、冲突链迁移、
 *   双方 provenance 保留、写审计行；`applySkillArchive` 改为先合并后归档；
 *   新增「合并后证据不丢」与「合并后冲突链完整」两条测试。
 *
 * 它自己在「为什么现在不动」里写的风险是本文件的形状：合并要动 `evidence` / `conflicts_with` /
 * `supersedes` / provenance / `last_used`，任何一处做错都是**证据丢失**。
 *
 * ── 一处必须说清的读法（写进测试，不留在注释里） ──────────────────────────────────────────────
 *
 * 「条数 = 两边之和」在一个前提下成立：两边的证据指针**互不相同**。真实的并集是
 * |A ∪ B| = |A| + |B| - |A∩B|；同一个 `sessionId@seq` 出现两次是**同一个指针**，保留两份只会
 * 把 `evidence` 这个计数灌水，并不增加任何证据。所以：
 *
 *   ① 用互不相交的夹具断言**字面**的「和」（退出条件原文）；
 *   ⑥ 另外用相交的夹具断言「并集语义」：一条不丢、重复的合并、且去重条数被如实报告。
 *
 * 两条都在，是因为只写 ① 会让「重复指针」这个真实形态永远不被测到；只写 ⑥ 则等于我擅自把
 * 退出条件改写成了另一句话。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendMemoryAudit, mergeSkills, memoryAuditPath, readSkillValidity } from '../lib/store.js'
import { getNeighbors, readEdges } from '../lib/edges.js'
import { applySkillArchive, isArchivedSkill } from '../lib/archive.js'

const WORKSPACE = 'D:/持久层能力架构'

/** Write one SKILL.md with a real frontmatter and a body we can compare byte-for-byte. */
function writeSkillFile(dir, name, { evidence = [], provenance = 'inferred', invalidAt = '', supersedes = [], archived = false } = {}) {
  const dirPath = join(dir, name)
  mkdirSync(dirPath, { recursive: true })
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${name} 的说明`,
    `when_to_use: 当需要 ${name} 时`,
    `scope: project`,
    `scene: general`,
    `workspace: ${WORKSPACE}`,
    `provenance: ${provenance}`,
    `evidence: ${evidence.join(',')}`,
    `supersedes: ${supersedes.join(',')}`,
    ...(invalidAt.length > 0 ? [`invalid_at: ${invalidAt}`] : []),
    ...(archived ? ['archived: true'] : []),
    'valid_at: 2026-01-01',
    '---',
    '',
    `# ${name}`,
    '',
    '## 何时使用',
    '',
    `当需要 ${name} 时`,
    '',
    '## 执行步骤',
    '',
    `1. 第一步（${name}）`,
    `2. 第二步（${name}）`,
    '',
    '## 验证标准',
    '',
    '- 断言通过',
    '',
    '## 已知坑',
    '',
    `- ${name} 的坑：这一节 parseSkillFile 读不到，所以合并**不许**走渲染器。`,
    '',
  ]
  const text = lines.join('\n')
  writeFileSync(join(dirPath, 'SKILL.md'), text, 'utf8')
  return text
}

const readSkill = (dir, name) => readFileSync(join(dir, name, 'SKILL.md'), 'utf8')
const bodyOf = (text) => text.slice(text.indexOf('\n---') + 4)

// ── ① 「合并后证据不丢」（退出条件原文：条数 = 两边之和） ────────────────────────────────────

test('v244 ①: 合并后证据不丢 —— 条数 = 两边之和，且每一条都在', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v244-evidence-'))
  const dir = join(root, 'skills')
  const memoryDir = join(root, 'memory')
  mkdirSync(memoryDir, { recursive: true })

  const keeperEvidence = ['sess-keeper@1', 'sess-keeper@2']
  const absorbedEvidence = ['sess-absorbed@7', 'sess-absorbed@8', 'sess-absorbed@9']
  writeSkillFile(dir, 'keeper', { evidence: keeperEvidence, provenance: 'human' })
  writeSkillFile(dir, 'absorbed', { evidence: absorbedEvidence, provenance: 'tool' })

  /** The body is the part a renderer-routed merge would silently delete. */
  const keeperBodyBefore = bodyOf(readSkill(dir, 'keeper'))
  const absorbedBodyBefore = bodyOf(readSkill(dir, 'absorbed'))

  const result = mergeSkills(dir, 'keeper', 'absorbed', { memoryDir })
  assert.equal(result.ok, true, `合并必须成功：${result.status}`)
  assert.equal(result.status, 'merged')
  assert.equal(result.evidenceBefore.keeper, keeperEvidence.length)
  assert.equal(result.evidenceBefore.absorbed, absorbedEvidence.length)
  assert.equal(result.evidence, keeperEvidence.length + absorbedEvidence.length, '条数必须 = 两边之和')
  assert.equal(result.evidenceBefore.shared, 0, '这组夹具本来就是不相交的')

  /** Every ref survived, and the union is what the FILE says — not just what the return said. */
  const mergedText = readSkill(dir, 'keeper')
  const evidenceLine = mergedText.match(/^evidence:\s*(.+)$/mu)?.[1]?.trim() ?? ''
  const mergedRefs = evidenceLine.split(',').filter(Boolean)
  assert.equal(mergedRefs.length, keeperEvidence.length + absorbedEvidence.length)
  for (const ref of [...keeperEvidence, ...absorbedEvidence]) {
    assert.ok(mergedRefs.includes(ref), `合并后必须仍带着 ${ref}`)
  }

  /** The BODY is untouched on both sides: no re-render, no lost human section. */
  assert.equal(bodyOf(mergedText), keeperBodyBefore, 'keeper 的正文必须逐字不变（人类小节不许被渲染器吃掉）')
  assert.equal(bodyOf(readSkill(dir, 'absorbed')), absorbedBodyBefore, 'absorbed 的正文也必须原样留着')

  /** Archived, never deleted: the file still exists and says where it went. */
  const absorbedText = readSkill(dir, 'absorbed')
  assert.equal(isArchivedSkill(absorbedText), true, 'absorbed 必须被标 archived')
  assert.match(absorbedText, /^merged_into:\s*keeper$/mu)
})

// ── ② 「合并后冲突链完整」 ───────────────────────────────────────────────────────────────────

test('v244 ②: 合并后冲突链完整 —— 旧边改指 keeper，索引里不再有 absorbed 这个名字', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v244-edges-'))
  const dir = join(root, 'skills')
  mkdirSync(dir, { recursive: true })

  writeSkillFile(dir, 'keeper', { evidence: ['s1@1'] })
  writeSkillFile(dir, 'absorbed', { evidence: ['s2@1'] })
  writeSkillFile(dir, 'rival-a', { evidence: ['s3@1'] })
  writeSkillFile(dir, 'rival-b', { evidence: ['s3@2'] })
  writeSkillFile(dir, 'rival-c', { evidence: ['s3@3'] })

  /** The absorbed skill is the far end of two edges; the keeper already has its own one. */
  writeFileSync(join(dir, 'skills-edges.jsonl'), 'absorbed,rival-a\nabsorbed,rival-b\nkeeper,rival-c\n', 'utf8')

  const result = mergeSkills(dir, 'keeper', 'absorbed')
  assert.equal(result.ok, true, `合并必须成功：${result.status}`)
  assert.equal(result.conflictsMoved, 2, '两条旧边必须被挪走')

  const keeperNeighbours = getNeighbors(dir, 'keeper').sort()
  assert.deepEqual(keeperNeighbours, ['rival-a', 'rival-b', 'rival-c'], 'keeper 必须继承 absorbed 的全部冲突对象')

  const dangling = readEdges(dir).filter(([left, right]) => left === 'absorbed' || right === 'absorbed')
  assert.deepEqual(dangling, [], `索引里不许留下指向已合并名字的边：${JSON.stringify(dangling)}`)

  /** And the edge count did not silently shrink: 2 old + 1 own = 3, no duplication. */
  assert.equal(readEdges(dir).length, 3, '一边都没丢，也没有重复边')
})

// ── ③ 双方 provenance 保留 + ④ 审计行 ───────────────────────────────────────────────────────

test('v244 ③④: 双方 provenance 保留在两个文件里，并写进一条审计行', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v244-provenance-'))
  const dir = join(root, 'skills')
  const memoryDir = join(root, 'memory')
  mkdirSync(memoryDir, { recursive: true })

  writeSkillFile(dir, 'keeper', { evidence: ['s1@1'], provenance: 'human' })
  writeSkillFile(dir, 'absorbed', { evidence: ['s2@1'], provenance: 'tool' })

  const result = mergeSkills(dir, 'keeper', 'absorbed', { memoryDir, at: '2026-11-18T00:00:00.000Z' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.provenance, { keeper: 'human', absorbed: 'tool' })
  assert.equal(result.audited, true, '给了 memoryDir 就必须写审计行')

  /** Each file keeps its OWN tier: a merge must not launder a tool-derived claim into a human one. */
  assert.match(readSkill(dir, 'keeper'), /^provenance:\s*human$/mu, 'keeper 的 provenance 不许被改掉')
  assert.match(readSkill(dir, 'absorbed'), /^provenance:\s*tool$/mu, 'absorbed 的 provenance 必须留在它自己的文件里')

  const auditLines = readFileSync(memoryAuditPath(memoryDir), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const mergeLines = auditLines.filter((entry) => entry.kind === 'merge')
  assert.equal(mergeLines.length, 1, '一次合并一条审计行')
  const line = mergeLines[0]
  assert.equal(line.winner, 'keeper')
  assert.equal(line.loser, 'absorbed')
  assert.match(line.detail, /evidence 1 \+ 1 = 2/u, `审计行必须留下「N + M = K」这笔账：${line.detail}`)
  assert.match(line.detail, /provenance human\/tool/u)
  assert.equal(line.at, '2026-11-18T00:00:00.000Z')

  /** A missing memoryDir is NOT a silent success: `audited:false` says no line was written. */
  const noAudit = mergeSkills(dir, 'keeper', 'rival-x')
  assert.equal(noAudit.ok, false)
  assert.equal(noAudit.status, 'skipped:missing file')
})

test('v244 ④b: 没给 memoryDir ⇒ 合并照做，但 audited:false 明说没写审计行', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v244-noaudit-'))
  const dir = join(root, 'skills')
  writeSkillFile(dir, 'keeper', { evidence: ['s1@1'] })
  writeSkillFile(dir, 'absorbed', { evidence: ['s2@1'] })
  const result = mergeSkills(dir, 'keeper', 'absorbed')
  assert.equal(result.ok, true, '审计不是门禁（与 appendMemoryAudit 同一条规则）')
  assert.equal(result.audited, false, '但它必须是可读的事实，不是沉默')
})

// ── ⑤ applySkillArchive 先合并后归档 ────────────────────────────────────────────────────────

test('v244 ⑤: applySkillArchive 先合并后归档 —— 合并真的落盘，计数是实际做到的', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v244-apply-'))
  const dir = join(root, 'skills')
  const memoryDir = join(root, 'memory')
  mkdirSync(memoryDir, { recursive: true })

  writeSkillFile(dir, 'keeper', { evidence: ['s1@1'] })
  writeSkillFile(dir, 'absorbed', { evidence: ['s2@1'] })
  writeSkillFile(dir, 'least-used', { evidence: ['s3@1'] })

  const plan = {
    total: 3,
    active: 3,
    merges: [{ absorbed: 'absorbed', keptInto: 'keeper' }],
    archive: ['least-used'],
    underLimit: false,
  }
  const applied = applySkillArchive(dir, plan, { memoryDir })
  assert.equal(applied.merged, 1, '合并必须被执行，而不是只报告')
  assert.deepEqual(applied.archived, ['least-used'])

  assert.match(readSkill(dir, 'keeper'), /^evidence:.*s2@1/mu, 'keeper 合并后必须带着 absorbed 的证据')
  assert.equal(isArchivedSkill(readSkill(dir, 'absorbed')), true)
  assert.equal(isArchivedSkill(readSkill(dir, 'least-used')), true, '归档那一半照旧')

  /** A pair that cannot merge is NOT counted as merged — the counter reports what happened. */
  const repeat = applySkillArchive(dir, { ...plan, merges: [{ absorbed: 'absorbed', keptInto: 'keeper' }], archive: [] }, { memoryDir })
  assert.equal(repeat.merged, 0, '第二次跑同一个计划必须报 0：文件已经合并过了')
})

// ── ⑥ 并集语义：重复指针合并，且如实报告（见文件头的读法说明） ──────────────────────────────

test('v244 ⑥: 同一条证据指针出现两次 ⇒ 合并成一条，去重条数如实报告', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v244-overlap-'))
  const dir = join(root, 'skills')
  writeSkillFile(dir, 'keeper', { evidence: ['s1@1', 's1@2'] })
  writeSkillFile(dir, 'absorbed', { evidence: ['s1@2', 's2@5'] })

  const result = mergeSkills(dir, 'keeper', 'absorbed')
  assert.equal(result.ok, true)
  assert.equal(result.evidence, 3, '并集是 3 条（|A∪B|），不是 4')
  assert.equal(result.evidenceBefore.shared, 1, '被合并掉的重复指针必须被数出来，不能悄悄吞掉')
  const mergedRefs = (readSkill(dir, 'keeper').match(/^evidence:\s*(.+)$/mu)?.[1] ?? '').split(',').filter(Boolean)
  assert.deepEqual(mergedRefs.sort(), ['s1@1', 's1@2', 's2@5'], '一条都不许丢')
})

// ── ⑦ 已失效的 absorbed 不许被「复活式压缩」 ────────────────────────────────────────────────

test('v244 ⑦: absorbed 已 invalid_at ⇒ 拒绝合并，两个文件一个字节都不动', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v244-invalid-'))
  const dir = join(root, 'skills')
  const keeperBefore = writeSkillFile(dir, 'keeper', { evidence: ['s1@1'] })
  const absorbedBefore = writeSkillFile(dir, 'absorbed', { evidence: ['s2@1'], invalidAt: '2026-02-02' })

  const result = mergeSkills(dir, 'keeper', 'absorbed')
  assert.equal(result.ok, false)
  assert.equal(result.status, 'skipped:absorbed is invalidated')
  assert.equal(readSkill(dir, 'keeper'), keeperBefore, 'keeper 必须逐字不变')
  assert.equal(readSkill(dir, 'absorbed'), absorbedBefore, 'absorbed 必须逐字不变')

  /** Same refusal for a missing file and for a bad name: named, never thrown. */
  assert.equal(mergeSkills(dir, 'keeper', 'nobody').status, 'skipped:missing file')
  assert.equal(mergeSkills(dir, 'keeper', '../keeper').status.includes('unsafe name'), true)
})

// ── ⑨ 顺带修掉的一个真缺陷：空字段不许吃掉下一行 ──────────────────────────────────────────

test('v244 ⑨: `supersedes:` 为空时不许把下一行当值读进来', () => {
  /**
   * 这不是夹具洁癖。`readSkillValidity` 原来用 `^key:\s*(.+)$` 配 `m` 标志，而 `\s` 能匹配换行：
   * 一个**空**的 `supersedes:` 会让 `\s*` 吃掉换行、`(.+)` 捕获下一行的字段。实测到的后果是
   * keeper 声称自己 supersede 了 `valid_at:,2026-01-01` —— 两行字段被洗成一条真实的替代链，
   * 而合并会把它原样抄到 keeper 上。
   */
  const empty = ['---', 'name: probe', 'supersedes:', 'valid_at: 2026-01-01', 'invalid_at:', '---'].join('\n')
  const validity = readSkillValidity(empty)
  assert.deepEqual(validity.supersedes, [], '空字段必须读成空链，不是下一行')
  assert.equal(validity.validAt, '2026-01-01', '下一行的字段仍要读到它自己的值')
  assert.equal(validity.invalidAt, '', '空的 invalid_at 同样是空，不是下一行')

  /** A genuinely non-empty chain is still parsed — the fix must not stop reading real values. */
  const filled = ['---', 'name: probe', 'supersedes: old-a,old-b', '---'].join('\n')
  assert.deepEqual(readSkillValidity(filled).supersedes, ['old-a', 'old-b'])
})

// ── ⑧ 旧式断言（既有行为不许变） ────────────────────────────────────────────────────────────

test('v244 ⑧: 归档不带合并时仍按原样工作（applySkillArchive 的旧契约）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v244-legacy-'))
  const dir = join(root, 'skills')
  writeSkillFile(dir, 'only-one', { evidence: ['s1@1'] })
  const applied = applySkillArchive(dir, { total: 1, active: 1, merges: [], archive: ['only-one'], underLimit: false })
  assert.deepEqual(applied.archived, ['only-one'])
  assert.equal(applied.merged, 0)
  assert.equal(isArchivedSkill(readFileSync(join(dir, 'only-one', 'SKILL.md'), 'utf8')), true)
})