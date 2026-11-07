/**
 * THE TIER SWITCH — json by default, sqlite as an opt-in upgrade.
 *
 * WHY THIS FILE EXISTS
 *
 * The switch is only honest if a benchmark cannot accidentally measure the wrong path. So the
 * critical test here is not "sqlite mode recalls things" — a decorative switch would pass that
 * by silently falling through to the JSON scan. The critical test is the NEGATIVE one: with the
 * tier set to `sqlite` and the index EMPTY, retrieval must find nothing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
/**
 * `pathToFileURL` on every dynamic import: on Windows an absolute path handed to `import()` is
 * read as a URL with scheme `d:` and Node refuses it. Other tests in this repo use the same
 * pattern for the same reason.
 */
const WS = process.cwd()
const store = await import(pathToFileURL(join(WS, 'lib/store.js')).href)
const retrieve = await import(pathToFileURL(join(WS, 'lib/retrieve.js')).href)
const ledger = await import(pathToFileURL(join(WS, 'lib/ledger-cache.js')).href)
const tierModule = await import(pathToFileURL(join(WS, 'lib/storage-tier.js')).href)
const { SqliteIndex, rebuildIndexFromLedger } = await import(pathToFileURL(join(WS, 'lib/sqlite-index.js')).href)

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tier-'))
  const memoryDir = join(root, 'memory')
  const skillsDir = join(root, 'skills')
  mkdirSync(memoryDir, { recursive: true })
  mkdirSync(skillsDir, { recursive: true })
  for (let index = 0; index < 20; index += 1) {
    store.appendFacts(
      memoryDir,
      [{ text: `tierfact${index} about deploypipeline`, seq: index + 1, scene: 'tier' }],
      { sessionId: 's', boundarySeq: index, workspace: root, provenance: 'inferred' },
    )
  }
  ledger.flushAllLedgers()
  return { root, memoryDir, skillsDir }
}

function buildIndex(memoryDir, dbPath) {
  const index = new SqliteIndex({ file: dbPath })
  rebuildIndexFromLedger(index, join(memoryDir, 'facts.jsonl'), {
    kind: 'fact',
    batchSize: 100,
    textOf: (record) => String(record.text ?? ''),
    tokenize: (text) => retrieve.tokenize(text),
    describe: (record, lineIndex) => ({
      id: `fact:${lineIndex}`,
      kind: 'fact',
      title: String(record.text ?? '').slice(0, 60),
      when: '',
      detail: '',
      scene: String(record.scene ?? 'general'),
      domain: String(record.domain ?? 'general'),
      workspace: String(record.workspace ?? ''),
      scope: String(record.scope ?? 'project'),
      validAt: '',
      invalidAt: '',
      provenance: 'inferred',
      at: String(record.at ?? ''),
      hits: Number(record.hits ?? 1),
      scanText: String(record.text ?? ''),
    }),
  })
  index.close()
}

/** Every test restores the default so one test cannot change the meaning of the next. */
test.afterEach(() => {
  retrieve.setStorageTier('json')
})

/**
 * Clean up WITHOUT asserting.
 *
 * `rmSync` on a directory holding an open SQLite handle throws EPERM on Windows. That is a
 * teardown artefact, not a product failure, and letting it fail the test reports a bug that is
 * not there. The handle is closed by `setStorageTier('json')` in `afterEach`; this is the
 * best-effort sweep afterwards.
 */
function cleanup(root) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true })
      return
    } catch {
      /* Windows may hold the handle for a moment; retry, then give up silently. */
    }
  }
}

test('tier: the default is json', () => {
  assert.equal(retrieve.getStorageTier(), 'json')
})

test('tier: json mode recalls memories (unchanged behaviour)', () => {
  const { root, memoryDir, skillsDir } = fixture()
  const hit = retrieve.retrieve(memoryDir, skillsDir, 'tierfact7 deploypipeline', { threshold: 0, workspace: root })
  assert.notEqual(hit.fact, undefined, 'json mode must recall')
  cleanup(root)
})

test('tier: sqlite mode with an EMPTY index recalls nothing — proving the switch is real', () => {
  const { root, memoryDir, skillsDir } = fixture()
  /**
   * A decorative switch would pass "sqlite recalls things" by falling through to the scan.
   * This is the test that cannot be passed by pretending.
   */
  retrieve.setStorageTier('sqlite', { indexDbPath: join(root, 'empty.db') })
  const hit = retrieve.retrieve(memoryDir, skillsDir, 'tierfact7 deploypipeline', { threshold: 0, workspace: root })
  assert.equal(hit.fact, undefined, 'an empty index must not recall anything')
  cleanup(root)
})

test('tier: sqlite mode recalls once the index is built', () => {
  const { root, memoryDir, skillsDir } = fixture()
  const dbPath = join(root, 'built.db')
  buildIndex(memoryDir, dbPath)
  retrieve.setStorageTier('sqlite', { indexDbPath: dbPath })
  const hit = retrieve.retrieve(memoryDir, skillsDir, 'tierfact7 deploypipeline', { threshold: 0, workspace: root })
  assert.notEqual(hit.fact, undefined, 'a built index must recall')
  cleanup(root)
})

test('tier: switching back to json restores recall', () => {
  const { root, memoryDir, skillsDir } = fixture()
  retrieve.setStorageTier('sqlite', { indexDbPath: join(root, 'none.db') })
  assert.equal(
    retrieve.retrieve(memoryDir, skillsDir, 'tierfact7 deploypipeline', { threshold: 0, workspace: root }).fact,
    undefined,
  )
  retrieve.setStorageTier('json')
  assert.notEqual(
    retrieve.retrieve(memoryDir, skillsDir, 'tierfact7 deploypipeline', { threshold: 0, workspace: root }).fact,
    undefined,
    'the JSON path is intact after a round trip through sqlite',
  )
  cleanup(root)
})

test('tier: an unknown value falls back to json WITH a warning', () => {
  const parsed = tierModule.parseStorageTier('mongo')
  assert.equal(parsed.tier, 'json')
  assert.match(String(parsed.warning), /mongo/u, 'the warning names the rejected value')
})

test('tier: undefined and empty mean json, silently', () => {
  assert.equal(tierModule.parseStorageTier(undefined).tier, 'json')
  assert.equal(tierModule.parseStorageTier('').tier, 'json')
  assert.equal(tierModule.parseStorageTier(undefined).warning, undefined)
})

test('tier: createRetrievalTier reports the tier that is actually live', () => {
  const { root, memoryDir } = fixture()
  const json = tierModule.createRetrievalTier({ memoryDir, tier: 'json', tokenize: (text) => retrieve.tokenize(text) })
  assert.equal(json.live, 'json')
  assert.deepEqual([...json.warnings], [])
  json.close()

  const sqlite = tierModule.createRetrievalTier({
    memoryDir,
    tier: 'sqlite',
    indexDbPath: join(root, 't.db'),
    tokenize: (text) => retrieve.tokenize(text),
  })
  assert.equal(sqlite.live, 'sqlite')
  sqlite.close()
  cleanup(root)
})

test('tier: the json tier answers candidates from the ledgers', async () => {
  const { root, memoryDir } = fixture()
  const tier = tierModule.createRetrievalTier({ memoryDir, tier: 'json', tokenize: (text) => retrieve.tokenize(text) })
  const found = await tier.candidates(retrieve.tokenize('tierfact7 deploypipeline'), 50)
  assert.ok(found.length > 0, 'the json tier must find the stored fact')
  assert.ok(found.some((document) => document.text.includes('tierfact7')))
  tier.close()
  cleanup(root)
})

test('tier: the sqlite tier answers candidates after rebuild', async () => {
  const { root, memoryDir } = fixture()
  const tier = tierModule.createRetrievalTier({
    memoryDir,
    tier: 'sqlite',
    indexDbPath: join(root, 'r.db'),
    tokenize: (text) => retrieve.tokenize(text),
  })
  const written = await tier.rebuild()
  assert.ok(written > 0, 'rebuild wrote documents')
  const found = await tier.candidates(retrieve.tokenize('tierfact7 deploypipeline'), 50)
  assert.ok(found.some((document) => document.text.includes('tierfact7')))
  tier.close()
  cleanup(root)
})
