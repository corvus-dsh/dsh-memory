/**
 * v0.17: the semantic DOMAIN — the axis that decides what may be a conflict.
 *
 * The failure this pins down: two procedures that share a technology and a trigger
 * but are about different SYSTEMS were cross-linked as alternatives, so the hint
 * asked the user to choose between methods that were never competing. `scene`
 * ("which technology") could not express this; `domain` ("which system") can.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asDomain, sanitizeExtraction } from '../lib/extract.js'
import { skillPath, writeSkill } from '../lib/store.js'
import { retrieve } from '../lib/retrieve.js'

const WORKSPACE = 'D:\\项目A'

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-domain-'))
  return { root, skills: join(root, 'skills'), memory: join(root, 'memory') }
}

/**
 * Two skills that share a purpose and a trigger but use different methods — the
 * proven shape from the v0.3 conflict suite, plus the word "缓存" in both so this
 * is literally the audited scenario: same topic, different systems.
 */
const cachePymysql = (name, domain) => ({
  name,
  title: '缓存查询走 pymysql',
  description: '通过 pymysql 连接 MySQL 服务器执行缓存查询。',
  when: '需要用 Python 连接缓存数据库并执行查询时',
  steps: ['pip install pymysql', '用 host/port/user/password 建立连接', 'cursor.execute(SELECT ...) 并 fetchall', 'commit 后 close'],
  verify: ['查询返回预期行数，连接已关闭'],
  scope: 'project',
  domain,
  evidence: [3],
})

const cacheSqlite = (name, domain) => ({
  name,
  title: '缓存走本地 sqlite',
  description: '通过 sqlite3 打开本地库文件做缓存增删改查。',
  when: '需要用 Python 操作缓存数据库文件做 CRUD 时',
  steps: ['sqlite3.connect("app.db")', 'CREATE TABLE IF NOT EXISTS', 'executemany 插入并 commit', '按 row_factory 读回'],
  verify: ['重开数据库文件后数据仍在'],
  scope: 'project',
  domain,
  evidence: [3],
})

test('v0.17: a domain is a short latin tag, and anything else degrades to general', () => {
  assert.equal(asDomain('feishu'), 'feishu')
  assert.equal(asDomain('PROJECT-LOCAL'), 'project-local')
  assert.equal(asDomain('dsh-host'), 'dsh-host')
  assert.equal(asDomain(''), 'general')
  assert.equal(asDomain('带中文'), 'general')
  assert.equal(asDomain('has space'), 'general')
  assert.equal(asDomain(undefined), 'general')
})

test('v0.17: the sanitizer keeps the domain the extractor produced', () => {
  const episode = { sessionId: 's1', evidence: [1], turns: 1 }
  const raw = {
    facts: [{ text: '缓存重建发生在构建期', scene: 'testing', domain: 'project-local', seq: 1 }],
    experiences: [{ text: '重建后命中率恢复', scene: 'testing', domain: 'project-local', seq: 1 }],
    negatives: [{ symptom: '缓存被写坏且无法自动恢复', cause: '并发写导致脏读', avoid: '先取全局锁', scope: 'project', scene: 'testing', domain: 'feishu', evidence: [1] }],
    skills: [
      {
        name: 'cache-rebuild-lock', title: '缓存重建加锁', description: 'd', when_to_use: '当需要处理缓存失效与重建时',
        scope: 'project', scene: 'testing', domain: 'project-local',
        steps: ['先取锁', '再重建'], verify: ['命中率恢复'], evidence: [1],
      },
    ],
  }
  const result = sanitizeExtraction(raw, episode)
  assert.equal(result.dropped.length, 0, result.dropped.join('; '))
  assert.equal(result.facts[0].domain, 'project-local')
  assert.equal(result.experiences[0].domain, 'project-local')
  assert.equal(result.negatives[0].domain, 'feishu')
  assert.equal(result.skills[0].domain, 'project-local')
})

test('v0.17: the domain is written to disk and back out again', () => {
  const { skills } = dirs()
  writeSkill(skills, cachePymysql('cache-lock', 'project-local'), {
    sessionId: 's1',
    boundarySeq: 1,
    workspace: WORKSPACE,
  })
  const text = readFileSync(skillPath(skills, 'cache-lock'), 'utf8')
  assert.match(text, /^domain: project-local$/mu)
  const hit = retrieve(join(skills, '..', 'memory'), skills, '缓存失效与重建', { threshold: 0, workspace: WORKSPACE })
  assert.equal(hit.skill?.domain, 'project-local', 'and retrieval reads it back')
})

test('v0.17: the same trigger in two different domains is NOT a conflict', () => {
  const { skills } = dirs()
  // Same trigger, genuinely different methods — the shape that used to be linked.
  writeSkill(skills, cachePymysql('cache-lock', 'project-local'), {
    sessionId: 's1', boundarySeq: 1, workspace: WORKSPACE,
  })
  writeSkill(skills, cacheSqlite('cache-async-refresh', 'feishu'), {
    sessionId: 's2', boundarySeq: 2, workspace: WORKSPACE,
  })

  const local = readFileSync(skillPath(skills, 'cache-lock'), 'utf8')
  const feishu = readFileSync(skillPath(skills, 'cache-async-refresh'), 'utf8')
  assert.doesNotMatch(local, /^conflicts_with:/mu, 'a different domain is not an alternative')
  assert.doesNotMatch(feishu, /^conflicts_with:/mu)
  assert.doesNotMatch(local, /## ⚠️ 冲突提示/u)
})

test('v0.17: the same trigger in the SAME domain is still linked (the gate is not over-eager)', () => {
  const { skills } = dirs()
  writeSkill(skills, cachePymysql('cache-lock', 'project-local'), {
    sessionId: 's1', boundarySeq: 1, workspace: WORKSPACE,
  })
  writeSkill(skills, cacheSqlite('cache-async-2', 'project-local'), {
    sessionId: 's2', boundarySeq: 2, workspace: WORKSPACE,
  })
  const both = [
    readFileSync(skillPath(skills, 'cache-lock'), 'utf8'),
    readFileSync(skillPath(skills, 'cache-async-2'), 'utf8'),
  ]
  assert.ok(
    both.some((text) => /^conflicts_with:/mu.test(text)),
    'two methods in ONE domain are still a fork the user must choose between',
  )
})

test('v0.17: a legacy record without a domain still conflicts (general is "not stated")', () => {
  const { skills } = dirs()
  writeSkill(skills, cacheSqlite('legacy-cache', 'general'), {
    sessionId: 's1', boundarySeq: 1, workspace: WORKSPACE,
  })
  writeSkill(skills, cachePymysql('cache-lock-2', 'project-local'), {
    sessionId: 's2', boundarySeq: 2, workspace: WORKSPACE,
  })
  const legacy = readFileSync(skillPath(skills, 'legacy-cache'), 'utf8')
  const local = readFileSync(skillPath(skills, 'cache-lock-2'), 'utf8')
  assert.ok(
    /^conflicts_with:/mu.test(legacy) || /^conflicts_with:/mu.test(local),
    'refusing to compare an untagged record against a tagged one would silently disable conflicts for everything written before v0.17',
  )
})

test('v0.17: the judge prompt carries the domain and the rule about it', async () => {
  const { FILTER_SYSTEM_PROMPT, selectApplicableSkillsDetailed } = await import('../lib/filter.js')
  assert.match(FILTER_SYSTEM_PROMPT, /Each candidate also shows its DOMAIN/u)
  assert.match(FILTER_SYSTEM_PROMPT, /never treat them as alternatives/u)

  const seen = []
  const llm = {
    async *stream(options) {
      seen.push(options.messages[0].content[0].text)
      yield { type: 'text-delta', text: JSON.stringify({ apply: ['a'] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  await selectApplicableSkillsDetailed(
    llm,
    'query',
    [
      { kind: 'skill', id: 'a', title: 'A', score: 0.9, provenance: 'tool', domain: 'feishu' },
      { kind: 'skill', id: 'b', title: 'B', score: 0.8, provenance: 'tool', domain: 'project-local' },
    ],
    { bypassCache: true },
  )
  assert.match(seen[0], /domain=feishu/u, 'the judge sees which system each candidate is about')
  assert.match(seen[0], /domain=project-local/u)
})

test('v0.17: domain travels to the JSONL layers too', async () => {
  const { appendNegatives } = await import('../lib/store.js')
  const { memory } = dirs()
  mkdirSync(memory, { recursive: true })
  appendNegatives(
    memory,
    [{ symptom: '飞书缓存写坏', cause: '并发', avoid: '加锁', scope: 'project', scene: 'testing', domain: 'feishu', evidence: [1] }],
    { sessionId: 's', boundarySeq: 1, workspace: WORKSPACE },
  )
  const record = JSON.parse(readFileSync(join(memory, 'negatives.jsonl'), 'utf8').trim())
  assert.equal(record.domain, 'feishu')
  const hit = retrieve(memory, join(memory, '..', 'skills'), '飞书缓存 并发 加锁', { threshold: 0, workspace: WORKSPACE })
  assert.equal(hit.negative?.domain, 'feishu')
})

void writeFileSync
