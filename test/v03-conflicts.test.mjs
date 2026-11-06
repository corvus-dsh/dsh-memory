/**
 * v0.3: conflicting capabilities must be RECORDED as alternatives.
 * v1.0.0: the recording MOVED — from inline frontmatter/hero prose into `skills-edges.jsonl`.
 *
 * The battle case is unchanged: one session learns "connect MySQL with pymysql", another
 * learns "open SQLite with sqlite3". Both are correct procedures for the same purpose and
 * they are mutually exclusive. A later retrieval must still name the fork.
 *
 * WHY THE ASSERTIONS CHANGED: v1.0.0 removed `conflicts_with:` and the `## ⚠️ 冲突提示`
 * footer from SKILL.md. Inlining them made one edge rewrite a whole existing file, so
 * writing N skills cost O(N²) file IO over files that grew with every edge (measured:
 * 103.7 ms/skill at N=400, single files at 104 KB). The edges are now an index; these
 * tests assert the INDEX and, through retrieval, the user-visible behaviour that matters.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findConflicts, isConflictingSkill, normalizeSkill, parseSkillFile, skillPath, writeSkill } from '../lib/store.js'
import * as storeModule from '../lib/store.js'
import { readEdges, hasEdge, getNeighbors, edgeCount } from '../lib/edges.js'
import { renderHint, retrieve } from '../lib/retrieve.js'
import { selectApplicableSkills } from '../lib/filter.js'
import { writeFileSync as atomicWriteForTest } from 'node:fs'

const MYSQL = {
  name: 'mysql-query-pymysql',
  title: '用 pymysql 连接 MySQL 并查询',
  description: '通过 pymysql 连接 MySQL 服务器执行查询。',
  when: '需要用 Python 连接 MySQL 数据库并执行查询时',
  steps: ['pip install pymysql', '用 host/port/user/password 建立连接', 'cursor.execute(SELECT ...) 并 fetchall', 'commit 后 close'],
  verify: ['查询返回预期行数，连接已关闭'],
  evidence: [101],
}

const SQLITE = {
  name: 'sqlite-local-crud',
  title: '用 sqlite3 封装本地 CRUD',
  description: '通过 sqlite3 打开本地库文件做增删改查。',
  when: '需要用 Python 操作 SQLite 本地数据库文件做 CRUD 时',
  steps: ['sqlite3.connect("app.db")', 'CREATE TABLE IF NOT EXISTS', 'executemany 插入并 commit', '按 row_factory 读回'],
  verify: ['重开数据库文件后数据仍在'],
  evidence: [202],
}

const UNRELATED = {
  name: 'source-drift-probe',
  title: '提交漂移时用 boundarySeq',
  description: '两阶段提交的漂移排查。',
  when: 'graft_commit 返回 SOURCE_DRIFT 时',
  steps: ['停用可变 lastSeq', '改用 boundarySeq 校验'],
  verify: ['连续两次 commit 不再漂移'],
  evidence: [303],
}

function dir() {
  return mkdtempSync(join(tmpdir(), 'dsh-mem-conflict-'))
}

test('conflict: pymysql and sqlite3 are alternatives, not duplicates', () => {
  const a = normalizeSkill(MYSQL)
  const b = normalizeSkill(SQLITE)
  assert.equal(isConflictingSkill(a, b), true)
  assert.equal(isConflictingSkill(a, a), true, 'same name = the same identity')
  assert.equal(isConflictingSkill(a, normalizeSkill(UNRELATED)), false)
  // Same steps under two names is a duplicate, not a conflict.
  const clone = { ...b, name: 'sqlite-crud-copy', steps: [...a.steps] }
  const sameMethod = { ...clone, description: a.description, when: a.when, steps: a.steps }
  assert.equal(isConflictingSkill(a, normalizeSkill(sameMethod)), false)
})

test('conflict: writing the second skill records both edges in the index (not in the files)', () => {
  const skills = dir()
  assert.equal(writeSkill(skills, MYSQL, { sessionId: 's-a', boundarySeq: 9 }), 'created')
  assert.equal(writeSkill(skills, SQLITE, { sessionId: 's-b', boundarySeq: 12 }), 'created')

  // The edge exists, in both directions, in the index.
  assert.equal(hasEdge(skills, MYSQL.name, SQLITE.name), true, 'the link must be symmetric (unordered)')
  assert.equal(hasEdge(skills, SQLITE.name, MYSQL.name), true)
  assert.equal(edgeCount(skills), 1, 'one unordered pair is ONE edge, not two lines')

  // Retrieval-side neighbour lookup returns the alternative for both sides.
  assert.deepEqual(getNeighbors(skills, MYSQL.name), [SQLITE.name])
  assert.deepEqual(getNeighbors(skills, SQLITE.name), [MYSQL.name])

  // And NOTHING was inlined into the skill files.
  const mysqlText = readFileSync(skillPath(skills, MYSQL.name), 'utf8')
  const sqliteText = readFileSync(skillPath(skills, SQLITE.name), 'utf8')
  assert.doesNotMatch(sqliteText, /^conflicts_with:/mu, 'v1.0.0: the edge is not a frontmatter line')
  assert.doesNotMatch(mysqlText, /^conflicts_with:/mu)
  assert.doesNotMatch(sqliteText, /## ⚠️ 冲突提示/u, 'v1.0.0: no footer prose in the stored file')
  assert.doesNotMatch(mysqlText, /## ⚠️ 冲突提示/u)
})

test('conflict: rewriting a skill does not duplicate the edge', () => {
  const skills = dir()
  writeSkill(skills, MYSQL, { sessionId: 's-a', boundarySeq: 9 })
  writeSkill(skills, SQLITE, { sessionId: 's-b', boundarySeq: 12 })
  writeSkill(skills, { ...SQLITE, evidence: [203] }, { sessionId: 's-c', boundarySeq: 20 })
  assert.equal(edgeCount(skills), 1, 'the same pair must stay a single edge')
  assert.deepEqual(getNeighbors(skills, MYSQL.name), [SQLITE.name])
})

test('conflict: an unrelated skill carries no conflict metadata and no edges', () => {
  const skills = dir()
  writeSkill(skills, MYSQL, { sessionId: 's-a', boundarySeq: 9 })
  writeSkill(skills, UNRELATED, { sessionId: 's-c', boundarySeq: 30 })
  const text = readFileSync(skillPath(skills, UNRELATED.name), 'utf8')
  assert.doesNotMatch(text, /conflicts_with/u)
  assert.doesNotMatch(text, /冲突提示/u)
  assert.equal(edgeCount(skills), 0, 'no pair, no edge')
})

test('conflict: retrieval surfaces the fork instead of "both worked"', () => {
  const skills = dir()
  const memory = dir()
  writeSkill(skills, MYSQL, { sessionId: 's-a', boundarySeq: 9 })
  writeSkill(skills, SQLITE, { sessionId: 's-b', boundarySeq: 12 })

  const result = retrieve(memory, skills, '用 Python 连接数据库并做一个简单的查询', { threshold: 0.3 })
  assert.ok(result.skill !== undefined)
  const ids = [result.skill.id, ...(result.alternatives ?? []).map((hit) => hit.id)]
  assert.ok(ids.includes(MYSQL.name) && ids.includes(SQLITE.name), `both must be visible: ${ids}`)
  assert.ok((result.skill.conflictsWith ?? []).length > 0, 'the hit carries its alternative')

  const hint = renderHint(result)
  assert.ok(hint !== undefined)
  assert.match(hint, /互斥/u)
  assert.match(hint, /先确认用哪一套/u)
  assert.ok(hint.length <= 120, `hint too long: ${hint.length}`)
})

test('conflict: harvest does NOT merge two methods that share one trigger', async () => {
  const { apply } = await import('../lib/index.js')
  const { mkdirSync, readdirSync, writeFileSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-harvest-conflict-'))
  const graft = join(root, 'graft')
  mkdirSync(graft, { recursive: true })
  writeFileSync(join(graft, '.retired.json'), JSON.stringify(['session-duel']), 'utf8')
  const skills = join(root, 'skills')
  const memory = join(root, 'memory')

  const whenOf = (tech) => `用 Python 连接 ${tech} 数据库并执行查询时，需要选择驱动`
  const skillsPayload = [
    {
      name: MYSQL.name,
      title: MYSQL.title,
      description: MYSQL.description,
      when_to_use: whenOf('MySQL'),
      steps: MYSQL.steps,
      verify: MYSQL.verify,
      evidence: [5],
    },
    {
      name: SQLITE.name,
      title: SQLITE.title,
      description: SQLITE.description,
      when_to_use: whenOf('SQLite'),
      steps: SQLITE.steps,
      verify: SQLITE.verify,
      evidence: [5],
    },
  ]
  const assistant = (seq) => ({
    type: 'assistant/message',
    seq,
    data: {
      message: {
        role: 'assistant',
        source: { kind: 'model' },
        content: [{ type: 'text', text: '结论：连接数据库并把操作封装成可复用的一层，参数化查询，事务失败要回滚，验证用真实数据。' }],
      },
    },
  })
  const tools = new Map()
  const ctx = {
    paths: { data: join(root, 'data') },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    sessionQuery: { readSession: async () => ({ events: [assistant(2), { type: 'tool/call', seq: 3, data: { callId: 'c1', name: 'pwsh' } }, { type: 'tool/result', seq: 5, data: { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] } } }, assistant(4)] }) },
    get: (name) =>
      name === 'llm'
        ? {
            async *stream() {
              yield { type: 'text-delta', text: JSON.stringify({ skills: skillsPayload }) }
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }
        : undefined,
  }
  apply(ctx, { graftDataDir: graft, memoryDir: memory, skillsDir: skills, extractor: 'llm', autoApprove: true })
  const report = await tools.get('memory_harvest').execute({})

  assert.equal(report.harvested.length, 1)
  const statuses = report.harvested[0].skills.map((item) => item.status)
  assert.deepEqual(statuses, ['created', 'created'], 'the second skill must be a new file, not a merge')
  /**
   * The skills directory now also holds the edge INDEX (`skills-edges.jsonl`), so the name
   * list is filtered to directories. Asserting the raw readdir would fail for a reason that
   * has nothing to do with conflict behaviour — an example of a test that would push a
   * future reader toward "put the index somewhere else" instead of fixing the real question.
   */
  const names = readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(names, [MYSQL.name, SQLITE.name].sort())
  // v1.0.0: the fork is recorded in the index, and the two files are NOT merged into one.
  assert.equal(hasEdge(skills, MYSQL.name, SQLITE.name), true, 'harvest must record the fork as an edge')
  assert.equal(edgeCount(skills), 1)
})

test('conflict: testing vocabulary alone is NOT a conflict (measured false positive)', () => {
  const { isConflictingSkill: conflicts, normalizeSkill: norm } = storeModule
  const threshold = norm({
    name: 'threshold-fixture-sizing',
    title: '阈值型判定的样本量设计',
    description: '为时效/阈值判定编写真正跨过阈值并能在真实数据上验证的测试。',
    when: '当被测逻辑含阈值常量（如 500 事件、N 条记录）用于触发某判定时。',
    steps: ['定位阈值常量', '造阈值 + 1 的 fixture', '等阈值与超阈值各一个用例'],
    verify: ['超阈值触发、等阈值不触发'],
    evidence: [1],
  })
  const sqliteTests = norm({
    name: 'sqlite-wrapper-round-testing',
    title: '按功能分轮扩充 SQLite 封装测试',
    description: '按功能分轮扩充测试，并用真实文件库关闭重开验证持久化。',
    when: '当你要为自写的 SQLite 封装编写测试集时。',
    steps: ['按功能分轮加用例', '每轮全量跑绿', '关闭重开库验证持久化'],
    verify: ['每一轮全量测试通过'],
    evidence: [2],
  })
  assert.equal(conflicts(threshold, sqliteTests), false, 'shared 测试/验证 words must not link unrelated subjects')
})

test('conflict: rebuilding links rewrites the index and keeps the real pair', async () => {
  const { rebuildConflictLinks } = storeModule
  const skills = dir()
  writeSkill(skills, MYSQL, { sessionId: 's-a', boundarySeq: 9 })
  writeSkill(skills, SQLITE, { sessionId: 's-b', boundarySeq: 12 })
  writeSkill(skills, { ...UNRELATED, description: '提交漂移排查。', when: '当 graft_commit 返回 SOURCE_DRIFT 时' }, { sessionId: 's-c', boundarySeq: 30 })
  /**
   * v1.0.0: a stale edge is simulated by writing it into the INDEX — which is where edges
   * now live. Writing it into SKILL.md would only test the legacy-migration path, not the
   * rebuild that this test is named after.
   */
  const { writeEdge } = await import('../lib/edges.js')
  writeEdge(skills, UNRELATED.name, MYSQL.name)
  assert.equal(edgeCount(skills), 2, 'precondition: the bogus edge exists')

  const pairs = rebuildConflictLinks(skills)
  assert.deepEqual(pairs, [{ a: MYSQL.name, b: SQLITE.name }])
  assert.equal(hasEdge(skills, UNRELATED.name, MYSQL.name), false, 'the stale edge is gone')
  assert.equal(hasEdge(skills, MYSQL.name, SQLITE.name), true, 'the real pair survives')
  assert.doesNotMatch(readFileSync(skillPath(skills, UNRELATED.name), 'utf8'), /conflicts_with/u)
})

test('conflict: the LLM filter is told to keep both sides of a fork', async () => {
  const skills = dir()
  writeSkill(skills, MYSQL, { sessionId: 's-a', boundarySeq: 9 })
  writeSkill(skills, SQLITE, { sessionId: 's-b', boundarySeq: 12 })
  const sqlite = parseSkillFile(readFileSync(skillPath(skills, SQLITE.name), 'utf8'), SQLITE.name)
  assert.deepEqual(findConflicts(skills, sqlite).map((item) => item.name), [MYSQL.name])

  let input = ''
  const llm = {
    async *stream(options) {
      input = options.messages[0].content[0].text
      yield { type: 'text-delta', text: JSON.stringify({ apply: [MYSQL.name, SQLITE.name] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const candidates = [
    { kind: 'skill', id: MYSQL.name, title: MYSQL.title, score: 0.9, when: MYSQL.when },
    { kind: 'skill', id: SQLITE.name, title: SQLITE.title, score: 0.8, when: SQLITE.when, conflictsWith: [MYSQL.name] },
  ]
  const picked = await selectApplicableSkills(llm, '连接数据库并查询', candidates)
  assert.deepEqual(picked, [MYSQL.name, SQLITE.name])
  assert.match(input, /conflicts_with=/u, 'the filter must see which candidates are alternatives')
})