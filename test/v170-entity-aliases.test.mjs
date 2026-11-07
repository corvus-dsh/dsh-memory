/**
 * v1.7.0 — ENTITY ALIASES.
 *
 * THE PROBLEM, CONCRETELY
 *
 * The causal walk joins nodes by the STRING in `cause`/`effect`. So `prod-db` and `生产数据库` are
 * two unrelated nodes, and a chain that runs through both stops at the boundary. From outside that
 * looks like a shallow graph; the graph is fine, the names are not.
 *
 * The fix is canonicalisation AT WRITE TIME, so the stored edge text is already one name. These
 * tests pin the rewrite rules and the type-safety of the field it touches.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const WS = process.cwd()
const dedupe = await import(pathToFileURL(join(WS, 'lib/dedupe.js')).href)
const store = await import(pathToFileURL(join(WS, 'lib/store.js')).href)
const ledger = await import(pathToFileURL(join(WS, 'lib/ledger-cache.js')).href)

test('aliases: a known alias rewrites to its canonical name', () => {
  assert.equal(dedupe.canonicalizeEntities('生产数据库'), 'prod-db')
  assert.equal(dedupe.canonicalizeEntities('prod database'), 'prod-db')
  assert.equal(dedupe.canonicalizeEntities('PROD-DB'), 'prod-db')
})

test('aliases: the rewrite works inside a sentence', () => {
  const out = dedupe.canonicalizeEntities('连接 生产数据库 时超时')
  assert.match(out, /prod-db/u, 'the entity is canonicalised')
  assert.match(out, /超时/u, 'the rest of the sentence survives')
})

test('aliases: the LONGEST spelling claims the span first', () => {
  /**
   * `生产 db` contains `生产`, and replacing the short form first would produce
   * `prod-dbc` — corrupting the string it was meant to fix.
   */
  const out = dedupe.canonicalizeEntities('生产 db 挂了')
  assert.match(out, /prod-db/u)
  assert.equal(out.includes('prod-dbdb'), false, 'no double substitution')
})

test('aliases: unknown names pass through untouched', () => {
  const text = '一个完全没见过的组件名'
  assert.equal(dedupe.canonicalizeEntities(text), text)
})

test('aliases: empty input is not an error', () => {
  assert.equal(dedupe.canonicalizeEntities(''), '')
})

test('aliases: sameEntity answers without rewriting', () => {
  assert.equal(dedupe.sameEntity('prod-db', '生产数据库'), true)
  assert.equal(dedupe.sameEntity('prod-db', 'staging-db'), false)
  assert.equal(dedupe.sameEntity('deploy', 'deploy'), true)
})

test('aliases: a custom table replaces the default', () => {
  const custom = { groups: [{ canonical: 'alpha', aliases: ['甲'] }] }
  assert.equal(dedupe.canonicalizeEntities('甲', custom), 'alpha')
  /** The default entries are NOT in this table, so they must not be rewritten. */
  assert.equal(dedupe.canonicalizeEntities('生产数据库', custom), '生产数据库')
})

/* ── the write path ─────────────────────────────────────────────────────────────────────── */

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-entity-'))
  const memoryDir = join(root, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  return { root, memoryDir }
}

test('aliases: appending a fact canonicalises its cause and effect', () => {
  const { root, memoryDir } = fixture()
  store.appendFacts(
    memoryDir,
    [{ text: '生产数据库超时导致构建失败', seq: 1, scene: 't', cause: '生产数据库', effect: '构建' }],
    { sessionId: 's', boundarySeq: 1, workspace: root, provenance: 'inferred' },
  )
  ledger.flushAllLedgers()
  const row = JSON.parse(readFileSync(join(memoryDir, 'facts.jsonl'), 'utf8').trim())
  assert.equal(row.cause, 'prod-db', 'the stored edge uses the canonical name')
  assert.equal(row.effect, 'build')
  assert.match(row.text, /生产数据库/u, 'the original wording survives for a human reader')
  rmSync(root, { recursive: true, force: true })
})

test('aliases: a POINTER cause is preserved, never stringified (the regression)', () => {
  const { root, memoryDir } = fixture()
  /**
   * `cause` may be `{sourceSessionId, seq}`. An earlier version ran `String(...)` over it
   * unconditionally, turning a pointer into the literal `[object Object]` and breaking every
   * causal chain built from an experience.
   */
  store.appendExperiences(
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
    { sessionId: 's', boundarySeq: 1, workspace: root, provenance: 'inferred' },
  )
  ledger.flushAllLedgers()
  const row = JSON.parse(readFileSync(join(memoryDir, 'experiences.jsonl'), 'utf8').trim())
  assert.deepEqual(row.cause, { sourceSessionId: 'session-causal', seq: 20 }, 'the pointer is intact')
  assert.deepEqual(row.effect, { sourceSessionId: 'session-causal', seq: 31 })
  rmSync(root, { recursive: true, force: true })
})

test('aliases: two spellings of one machine produce the SAME stored edge text', () => {
  const { root, memoryDir } = fixture()
  store.appendFacts(
    memoryDir,
    [{ text: '第一个观测', seq: 1, scene: 't', cause: '生产数据库', effect: 'down' }],
    { sessionId: 's', boundarySeq: 1, workspace: root, provenance: 'inferred' },
  )
  store.appendFacts(
    memoryDir,
    [{ text: '第二个观测', seq: 2, scene: 't', cause: 'prod-db', effect: 'down' }],
    { sessionId: 's', boundarySeq: 2, workspace: root, provenance: 'inferred' },
  )
  ledger.flushAllLedgers()
  const rows = readFileSync(join(memoryDir, 'facts.jsonl'), 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    rows.map((row) => row.cause),
    ['prod-db', 'prod-db'],
    'both records name the same node, which is what lets the walk join them',
  )
  rmSync(root, { recursive: true, force: true })
})
