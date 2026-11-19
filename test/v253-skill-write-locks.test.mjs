/**
 * ── v253 (B4-0b-1 A9): skill writes take the same sibling lock the rest of the store uses ───────
 *
 * The audit (P1-3): `writeSkill` / `touchSkillUsage` / `applySkillFeedback` are all
 * read → mutate → write on one SKILL.md, with NO lock. The rest of the store already serialises on a
 * sibling `<file>.lock` (`updateJsonlFile`, `markProcessed`, the graph, the knowledge refs), so this
 * was one path outside the store's own discipline — and it is the path two windows hit most: the same
 * skill is recalled and confirmed in both.
 *
 * Measured consequence: window A and window B each read the old file, each merge their own evidence,
 * and the later `atomicWrite` replaces the earlier — evidence gone, both callers reporting success.
 * The same for `confidence`: two confirmations become one, and nothing anywhere says a confirmation
 * was lost.
 *
 * ── how this is measured ────────────────────────────────────────────────────────────────────────
 *
 * `lock.ts` carries an ENV-GATED acquisition counter (`DSH_LOCK_TRACE=1`) that exists precisely for
 * "on which paths do we actually take locks". This file turns it on BEFORE any module loads (dynamic
 * imports, so the flag is read at module init) and then asserts the exact lock path. That is a
 * behavioural measurement of the lock, not a grep for `withFileLock(` in the source.
 */

process.env.DSH_LOCK_TRACE = '1'

const store = await import('../lib/store.js')
const lock = await import('../lib/lock.js')
const fs = await import('node:fs')
const os = await import('node:os')
const path = await import('node:path')
const test = (await import('node:test')).default
const assert = (await import('node:assert/strict')).default

delete process.env.DSH_LOCK_TRACE

const { applySkillFeedback, touchSkillUsage, writeSkill } = store
const { lockTraceSnapshot, lockTraceReset } = lock
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = fs
const { tmpdir } = os
const { join } = path

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v253-'))
  const skillsDir = join(root, 'skills')
  mkdirSync(skillsDir, { recursive: true })
  return { root, skillsDir }
}

const skill = (name, evidenceSeq) => ({
  name,
  title: `${name} 的做法`,
  description: '什么时候用、怎么做、怎么验证',
  when: '场景：api 调试',
  steps: ['先读日志', '再改配置'],
  verify: ['日志里出现 OK'],
  evidence: [{ sourceSessionId: 'session-x', seq: evidenceSeq }],
  confidence: 0.5,
})

const meta = { sessionId: 'session-x', workspace: '', at: '2026-11-19T00:00:00.000Z', provenance: 'session' }

const paths = (skillsDir, name) => ({
  skill: join(skillsDir, name, 'SKILL.md'),
  lock: join(skillsDir, name, 'SKILL.md.lock'),
})

test('v253 ①: writeSkill 在写 SKILL.md 期间持有 `<SKILL.md>.lock`', () => {
  const { skillsDir } = scaffold()
  lockTraceReset()
  const status = writeSkill(skillsDir, skill('locked-skill', 1), meta)
  assert.equal(status, 'created')

  const snapshot = lockTraceSnapshot()
  assert.equal(snapshot.enabled, true, '计数器必须真的开着（否则这条测的是零次与零次的相等）')
  const expected = paths(skillsDir, 'locked-skill').lock
  const hit = snapshot.byPath.find((row) => row.path === expected)
  assert.ok(hit !== undefined, `必须按 ${expected} 取锁；实测 ${JSON.stringify(snapshot.byPath)}`)
  assert.ok(hit.count >= 1)
  /** And it is released: the lock directory must NOT survive the write. */
  assert.equal(existsSync(paths(skillsDir, 'locked-skill').lock), false, '锁必须被释放，否则下一次写会等 30 秒后抛错')
})

test('v253 ②: touchSkillUsage 与 applySkillFeedback 用同一把锁', () => {
  const { skillsDir } = scaffold()
  writeSkill(skillsDir, skill('touch-skill', 2), meta)
  const target = paths(skillsDir, 'touch-skill')

  lockTraceReset()
  assert.equal(touchSkillUsage(skillsDir, 'touch-skill', '2026-11-19T01:00:00.000Z'), true)
  assert.ok(lockTraceSnapshot().byPath.some((row) => row.path === target.lock), 'touchSkillUsage 必须取同一把锁')

  lockTraceReset()
  const feedback = applySkillFeedback(skillsDir, ['touch-skill'], 'positive', '2026-11-19T02:00:00.000Z')
  assert.equal(feedback.updated.length, 1)
  assert.ok(lockTraceSnapshot().byPath.some((row) => row.path === target.lock), 'applySkillFeedback 必须取同一把锁')
})

test('v253 ③: 写之前重读磁盘 —— 另一个写者刚落盘的证据不许被手里的旧文本覆盖', () => {
  const { skillsDir } = scaffold()
  writeSkill(skillsDir, skill('merge-skill', 10), meta)
  const target = paths(skillsDir, 'merge-skill')

  /** Another window wrote evidence seq=20 straight to disk (its own locked write, done already). */
  const text = readFileSync(target.skill, 'utf8')
  writeFileSync(target.skill, text.replace(/^evidence:.*$/mu, 'evidence: session-x@10,session-x@20'), 'utf8')

  /** Our write merges seq=30. If it re-read the file, all three survive. */
  const status = writeSkill(skillsDir, skill('merge-skill', 30), meta)
  assert.equal(status, 'merged')

  const merged = readFileSync(target.skill, 'utf8').match(/^evidence:\s*(.+)$/mu)?.[1] ?? ''
  for (const seq of [10, 20, 30]) {
    assert.match(merged, new RegExp(`session-x@${seq}`, 'u'), `evidence 必须含 seq=${seq}；实测 ${merged}`)
  }
})