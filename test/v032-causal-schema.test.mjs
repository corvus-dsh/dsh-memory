/**
 * THE CAUSAL SCHEMA — the four layers, made explicit about time and causation.
 *
 * WHAT THIS SUITE PINS, AND WHY EACH ITEM IS WORTH A TEST
 *
 *   1. MONOTONIC TIME. A physical trace that can run backwards is not a trace. A wall clock CAN run
 *      backwards (NTP, VM restore), so the writer must refuse to.
 *   2. ABSENCE IS NOT FABRICATION. A v0.31 record has no `timestamp`; loading it must not invent one, because
 *      a fabricated ordering is worse than an admitted gap.
 *   3. THE SKILL IS A MACRO. `dependencies` in, `target_effect` out — written to frontmatter and read back.
 *   4. THE NEGATIVE IS A STOP ASSERTION. `blocked_condition` makes applicability decidable instead of a
 *      matter of interpreting prose.
 *   5. THE CHAIN IS FOLLOWED, NOT GUESSED. `causalChain` must find a blocker whose wording shares nothing
 *      with the target, when its condition applies — the exact case lexical search loses.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendExperiences,
  appendFacts,
  appendNegatives,
  causalChain,
  describeCausalChain,
  monotonicTimestamp,
  resetMonotonicClockForTest,
  readSkillBody,
  writeSkill,
} from '../lib/index.js'

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'memory-causal-'))
  const memoryDir = join(root, 'memory')
  const skillsDir = join(root, 'skills')
  /** The real store creates these on write; a test that writes a raw file must do it itself. */
  mkdirSync(memoryDir, { recursive: true })
  mkdirSync(skillsDir, { recursive: true })
  return { memoryDir, skillsDir, root }
}

const META = { sessionId: 'session-causal', boundarySeq: 7, workspace: '/work/demo', provenance: 'tool' }

/* ── 1. monotonic time ──────────────────────────────────────────────────────────────────── */

test('causal: the write clock NEVER goes backwards, even when the wall clock does', () => {
  resetMonotonicClockForTest(0)
  const first = monotonicTimestamp(1_000)
  /** A clock that jumped backwards — NTP correction, VM restore, two machines a few seconds apart. */
  const second = monotonicTimestamp(500)
  const third = monotonicTimestamp(500)

  assert.equal(new Date(first).getTime(), 1_000, 'the first stamp is the real time')
  assert.equal(
    new Date(second).getTime() > new Date(first).getTime(),
    true,
    'a backwards clock still produces a FORWARD stamp',
  )
  assert.equal(
    new Date(third).getTime() > new Date(second).getTime(),
    true,
    'and two stamps at the same millisecond are still ordered',
  )
  resetMonotonicClockForTest(0)
})

test('causal: facts carry a strictly increasing timestamp in write order', () => {
  resetMonotonicClockForTest(0)
  const { memoryDir } = dirs()
  appendFacts(
    memoryDir,
    [
      { text: '第 1 条观察：端口被占用', seq: 10, scene: 'general', domain: 'host' },
      { text: '第 2 条观察：旧进程仍在运行', seq: 11, scene: 'general', domain: 'host' },
      { text: '第 3 条观察：结束进程后恢复', seq: 12, scene: 'general', domain: 'host' },
    ],
    META,
  )
  const rows = readFileSync(join(memoryDir, 'facts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(rows.length, 3)
  const stamps = rows.map((row) => new Date(row.timestamp).getTime())
  assert.equal(
    stamps.every((value, index) => index === 0 || value > stamps[index - 1]),
    true,
    `timestamps must strictly increase, got ${JSON.stringify(rows.map((r) => r.timestamp))}`,
  )
  resetMonotonicClockForTest(0)
})

/* ── 2. legacy records are not given invented ordering ─────────────────────────────────── */

test('causal: a LEGACY fact without a timestamp is reported as an ordering gap, not silently ordered', () => {
  const { memoryDir, skillsDir } = dirs()
  /** Exactly the v0.31 shape: no `timestamp` field at all. */
  writeFileSync(
    join(memoryDir, 'facts.jsonl'),
    `${JSON.stringify({ text: '旧记录：部署脚本曾在 Windows 上失败', scene: 'general', domain: 'general', evidence: [{ sourceSessionId: 'old', seq: 3 }] })}\n`,
    'utf8',
  )
  const chain = causalChain(memoryDir, skillsDir, '部署脚本 失败', {})
  assert.equal(chain.facts.length, 1, 'the legacy fact is still findable')
  assert.equal(chain.facts[0].extra?.timestamp, undefined, 'no timestamp is INVENTED for it')
  assert.match(
    chain.warnings.join(' '),
    /没有 timestamp/u,
    'the gap is stated, so a consumer will not order the chain by a field half the nodes lack',
  )
})

/* ── 3. the skill is a macro ───────────────────────────────────────────────────────────── */

test('causal: a skill records its PRECONDITIONS and TARGET EFFECT, and they survive a round trip', () => {
  const { skillsDir } = dirs()
  writeSkill(
    skillsDir,
    {
      name: 'restart-dev-server',
      title: '重启开发服务器',
      description: '端口被占用时，安全重启开发服务器并验证端口释放',
      when: '当端口 3000 被占用、或需要重启开发服务器时',
      steps: ['确认占用端口的进程', '结束该进程', '重新启动服务'],
      verify: ['端口不再被占用', '健康检查返回 200'],
      scope: 'project',
      scene: 'general',
      aliases: [],
      evidence: [{ sourceSessionId: 'session-causal', seq: 10 }],
      dependencies: [{ sourceSessionId: 'session-causal', seq: 10 }],
      target_effect: '端口 3000 释放且开发服务器可用',
    },
    META,
  )

  const body = readSkillBody(skillsDir, 'restart-dev-server')
  assert.notEqual(body, undefined)
  assert.equal(body?.targetEffect, '端口 3000 释放且开发服务器可用', 'the expected STATE is read back')
  assert.deepEqual(body?.dependencies, [{ sourceSessionId: 'session-causal', seq: 10 }], 'and so are the preconditions')
})

/* ── 4. the negative is a stop assertion ──────────────────────────────────────────────── */

test('causal: a negative records the CONDITION that blocks, as a predicate not advice', () => {
  const { memoryDir } = dirs()
  appendNegatives(
    memoryDir,
    [
      {
        symptom: '强制结束进程后服务无法启动',
        cause: '把监听进程和守护进程一起杀掉了',
        avoid: '只结束监听端口的那个进程',
        blocked_condition: '准备结束开发服务器相关进程时',
        scope: 'project',
        scene: 'general',
        evidence: [{ sourceSessionId: 'session-causal', seq: 20 }],
      },
    ],
    META,
  )
  const rows = readFileSync(join(memoryDir, 'negatives.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].blocked_condition, '准备结束开发服务器相关进程时', 'the condition is stored verbatim')
  assert.equal(typeof rows[0].timestamp, 'string', 'and it carries the monotonic trace')
})

/* ── 5. the chain is FOLLOWED ─────────────────────────────────────────────────────────── */

test('causal: the chain finds a BLOCKER whose wording shares nothing with the target', () => {
  /**
   * THE CASE LEXICAL SEARCH LOSES, stated as the test: the target is "重启开发服务器", and the negative's
   * symptom mentions none of those words. Only its `blocked_condition` ("准备结束开发服务器相关进程时") — and
   * the shared concept of terminating a process — makes it applicable. A word-overlap search would return
   * nothing, and the known failure would be repeated.
   */
  const { memoryDir, skillsDir } = dirs()
  writeSkill(
    skillsDir,
    {
      name: 'restart-dev-server',
      title: '重启开发服务器',
      description: '端口占用时重启开发服务器',
      when: '需要重启开发服务器时',
      steps: ['确认占用进程', '结束进程', '重新启动'],
      verify: ['端口释放'],
      scope: 'project',
      scene: 'general',
      aliases: [],
      evidence: [{ sourceSessionId: 'session-causal', seq: 10 }],
      target_effect: '端口 3000 释放',
    },
    META,
  )
  appendNegatives(
    memoryDir,
    [
      {
        symptom: '守护进程被误杀导致服务全部下线',
        cause: '结束进程时没有区分监听进程与守护进程',
        avoid: '只结束监听端口的进程',
        blocked_condition: '重启开发服务器并结束相关进程时',
        scope: 'project',
        scene: 'general',
        evidence: [{ sourceSessionId: 'session-causal', seq: 20 }],
      },
    ],
    META,
  )

  const chain = causalChain(memoryDir, skillsDir, '重启开发服务器')
  assert.equal(chain.skills.length, 1, 'the skill claims the action')
  assert.equal(chain.skills[0].id, 'restart-dev-server')
  assert.equal(
    chain.blockers.length,
    1,
    'the BLOCKER is reached through its condition, not through shared vocabulary',
  )
  assert.match(chain.blockers[0].title, /守护进程被误杀/u)
  assert.equal(chain.effects.length, 1, 'the expected effect is part of the chain')
  assert.match(chain.effects[0].detail ?? '', /端口 3000 释放/u)
})

test('causal: an EXPERIENCE contributes cause, action and effect as separate, checkable fields', () => {
  const { memoryDir, skillsDir } = dirs()
  appendExperiences(
    memoryDir,
    [
      {
        text: '结束监听进程而不动守护进程，服务可以正常重启',
        seq: 30,
        scene: 'general',
        action: '只结束监听 3000 端口的进程',
        cause: { sourceSessionId: 'session-causal', seq: 20 },
        effect: { sourceSessionId: 'session-causal', seq: 31 },
      },
    ],
    META,
  )
  const chain = causalChain(memoryDir, skillsDir, '结束监听进程')
  assert.equal(chain.experiences.length, 1)
  const node = chain.experiences[0]
  assert.equal(node.extra?.cause, 'session-causal@20', 'the PRECEDING state is a pointer, not prose')
  assert.equal(node.extra?.effect, 'session-causal@31', 'and so is the RESULTING state')
  assert.equal(node.detail, '只结束监听 3000 端口的进程', 'the ACTION between them is kept')
})

test('causal: an empty chain says so, and does not pretend the store is empty', () => {
  const { memoryDir, skillsDir } = dirs()
  const chain = causalChain(memoryDir, skillsDir, '一个从未记录过的动作')
  assert.equal(chain.skills.length, 0)
  assert.equal(chain.blockers.length, 0)
  assert.equal(typeof describeCausalChain(chain), 'string')
  assert.match(describeCausalChain(chain), /因果链/u)
})
