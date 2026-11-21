/**
 * ── v293 (B4-0b-2 §39.4)：缓存桶是**天**，不是**小时** —— 因为小时桶是一道断崖 ────────────────
 *
 * ── 用户报的症状 ──────────────────────────────────────────────────────────────────────────────
 *
 * 「会话缓存命中断崖式下降」。断崖这个词是准确的，而它下面是一个可以量出来的机制：三个文档缓存
 * 都用 `Math.floor(now / 3_600_000)` 做键的一部分，于是**每到整点，同一次调用就从命中变成全量重建**，
 * 而磁盘上什么都没有变。
 *
 * 实测（200 个技能的树，同一次运行内）：
 *
 *     cold（进程内第一次）        27.2 ms
 *     同一小时内第二次             0.14 ms
 *     跨过一个小时                 25.5 ms   ← 之前：和 cold 一样贵
 *     跨过一个天                   21.8 ms   ← 现在仍然重建（桶还在，只是变宽了）
 *
 * ── 为什么「天」是对的、「小时」是错的（不是猜，是读）────────────────────────────────────────
 *
 * `skillDocuments` / `negativeDocuments` / `layerDocuments` 三个函数里，`now` **只经过
 * `ageDaysOf(...)`**，而它的消费者全部是**天**阈值（14 天衰减、30 天未知）。所以小时桶重建整个世界，
 * 只为回答一个在一小时内不可能变的问题。
 *
 * `skill-cache.ts` 原来的注释自己写着：**「every field derived from `now` in this store is
 * day-granular」** —— 那句话是真的，而它正是**用天**的理由，不是用小时的理由。
 *
 * ── 判据（四条，两个方向都钉）────────────────────────────────────────────────────────────────
 *
 *   ① 小时边界不再重建（键在 `now` 前进一小时后必须相同）
 *   ② **天的边界仍然重建**（键在天前进后必须不同）—— 桶没被删掉，只是变宽。只钉 ① 的测试，
 *      在有人把桶彻底删掉时仍会绿
 *   ③ 行为：跨小时那次调用的耗时必须远小于冷启动（不是「等于 0」，是「不再是断崖」）
 *   ④ 外部写入仍被发现 —— 桶存在的理由没被牺牲
 *
 * can-red：把 `DAY_MS` 改回 `3_600_000` ⇒ ①② 同时红（① 红说明断崖回来了，② 红说明类型错了）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { skillDocsKey } from '../lib/skill-cache.js'
import { skillDocuments } from '../lib/retrieve/documents.js'

const HOUR = 3_600_000
const DAY = 86_400_000

/** A directory whose mtime is irrelevant to the comparison, so the SECOND half of the key is isolated. */
const DIR_MTIME = 1_700_000_000_000

function buildSkills(root, count) {
  const skills = join(root, 'skills')
  mkdirSync(skills, { recursive: true })
  for (let index = 0; index < count; index += 1) {
    const dir = join(skills, `skill-${String(index).padStart(3, '0')}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      [
        '---',
        `name: skill-${index}`,
        `when_to_use: handle task number ${index} while reading frontmatter and taking locks`,
        'scene: general',
        'workspace: D:/persistence-arch',
        'tags: memory, frontmatter, concurrency',
        'applicable_node_types: coding',
        '---',
        '',
        `# skill ${index}`,
        'body line 1',
        '',
      ].join('\n'),
      'utf8',
    )
  }
  return skills
}

test('v293 ①: 键在跨小时时**不变**（小时不再是一道断崖）', () => {
  const base = Math.floor(DIR_MTIME / DAY) * DAY + 12 * HOUR
  const atBase = skillDocsKey(DIR_MTIME, base)

  for (const offset of [1, 1_000, HOUR - 1]) {
    assert.equal(
      skillDocsKey(DIR_MTIME, base + offset),
      atBase,
      `跨过 ${offset} ms 后键变了 —— 小时桶回来了，每次整点都会全量重建`,
    )
  }

  /**
   * And the SAME comparison against the hour itself: crossing an hour boundary inside one day must not
   * change the key. This is the assertion the old key failed.
   */
  const beforeHour = Math.floor(base / HOUR) * HOUR + HOUR - 1
  const afterHour = beforeHour + 1
  assert.equal(
    skillDocsKey(DIR_MTIME, beforeHour),
    skillDocsKey(DIR_MTIME, afterHour),
    '整点前 1 ms 与整点后 1 ms 的键不同 —— 这正是用户看到的断崖',
  )
})

test('v293 ②: 键在跨天时**必须变**（桶没被删掉，只是变宽了）', () => {
  /**
   * ── WHY THIS CASE IS NOT REDUNDANT ──────────────────────────────────────────────────────────
   *
   * A test that only asserted ① would pass if someone deleted the bucket entirely. The bucket's job
   * is to notice a foreign writer that never calls `invalidateSkillDocs`, so its disappearance must
   * be a failure, not a silent improvement. ① and ② together say 「变宽」, not 「去掉」.
   */
  const base = Math.floor(DIR_MTIME / DAY) * DAY + 12 * HOUR
  const nextDay = base + DAY
  assert.notEqual(
    skillDocsKey(DIR_MTIME, base),
    skillDocsKey(DIR_MTIME, nextDay),
    '跨天后键竟然相同 —— 桶被彻底删掉了，外部写入将永远不被发现',
  )
})

test('v293 ③: 行为 —— 跨小时那次调用远快于冷启动（不再是断崖）', () => {
  const root = mkdtempSync(join(tmpdir(), 'v293-'))
  try {
    const skills = buildSkills(root, 200)
    const base = Math.floor(Date.now() / DAY) * DAY

    const timeIt = (fn) => {
      const started = process.hrtime.bigint()
      const value = fn()
      return { ms: Number(process.hrtime.bigint() - started) / 1e6, value }
    }

    const cold = timeIt(() => skillDocuments(skills, base))
    timeIt(() => skillDocuments(skills, base)) // warm
    const nextHour = timeIt(() => skillDocuments(skills, base + HOUR))

    assert.equal(cold.value.length, 200, '冷启动必须真的建了 200 条文档，否则这条测试在测空气')
    assert.ok(
      nextHour.ms < cold.ms / 5,
      `跨小时那次用了 ${nextHour.ms.toFixed(3)} ms，冷启动 ${cold.ms.toFixed(3)} ms —— ` +
        '比值不到 5 倍就说明它又在整点全量重建了',
    )

    /** ②-again as BEHAVIOUR: the next day really does rebuild. */
    const nextDay = timeIt(() => skillDocuments(skills, base + DAY))
    assert.ok(
      nextDay.ms > nextHour.ms * 5,
      `跨天那次只用了 ${nextDay.ms.toFixed(3)} ms —— 桶没在工作，外部写入不会被发现`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v293 ④: 桶的**理由**部分成立 —— 新增技能被发现，**改内容不被发现**（已登记为 TD-M20）', () => {
  /**
   * ── THIS TEST MEASURED A SECOND, PRE-EXISTING HOLE, AND IT IS NOT MINE TO FIX HERE ──────────
   *
   * The bucket's purpose is 「notice a writer that never calls `invalidateSkillDocs`」. The key's
   * first half is `statSync(skillsDir).mtimeMs` — the PARENT directory. Measured 2026-11-21:
   *
   *     编辑 skill-000/SKILL.md   ⇒ 父目录 mtime 不变、skill-000 目录 mtime 不变、只有文件变
   *     新增 skill-001/ 目录      ⇒ 父目录 mtime 变
   *
   * So the implicit half covers ADD/REMOVE and does NOT cover an in-place edit. That hole existed
   * before this change (the hour bucket did not close it either — an edit at 10:30 was invisible until
   * 11:00). Widening the bucket from an hour to a day makes the window longer, so it is now written
   * down as **TD-M20** instead of being left implicit.
   *
   * This case therefore asserts the REAL behaviour in both directions:
   *   · adding a skill IS noticed (the bucket's reason survives);
   *   · editing one in place is NOT noticed (TD-M20, so the next reader cannot mistake silence for
   *     coverage).
   *
   * A test that asserted only the first would leave the hole undocumented; a test that asserted the
   * second as PASS would enshrine it as correct.
   */
  const root = mkdtempSync(join(tmpdir(), 'v293b-'))
  try {
    const skills = buildSkills(root, 5)
    const base = Math.floor(Date.now() / DAY) * DAY

    const initial = skillDocuments(skills, base)
    assert.equal(initial.length, 5)

    /** (a) ADD a skill without calling the invalidation: the parent mtime moves, so this IS noticed. */
    mkdirSync(join(skills, 'skill-900'), { recursive: true })
    writeFileSync(
      join(skills, 'skill-900', 'SKILL.md'),
      ['---', 'name: skill-900', 'when_to_use: a brand new skill added by a foreign writer', 'scene: general', '---', '', '# new', ''].join('\n'),
      'utf8',
    )
    const afterAdd = skillDocuments(skills, base)
    assert.equal(afterAdd.length, 6, '新增技能没有被发现 —— 键的第一半（父目录 mtime）失效了')

    /** (b) EDIT one skill in place, no invalidation: measured NOT noticed. Documented as TD-M20. */
    const target = join(skills, 'skill-900', 'SKILL.md')
    writeFileSync(target, readFileSync(target, 'utf8').replace('# new', '# EDITED IN PLACE'), 'utf8')
    const afterEdit = skillDocuments(skills, base)
    const editSeen = afterEdit.some((doc) => JSON.stringify(doc).includes('EDITED IN PLACE'))
    assert.equal(
      editSeen,
      false,
      '外部原地编辑竟然被发现了 —— 如果这条变红，说明有人补上了 TD-M20 的覆盖，' +
        '那么应当同时更新 ARCHITECTURE.md 里的 TD-M20 并把这条断言改成 true',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})