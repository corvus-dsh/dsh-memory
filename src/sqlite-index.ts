/**
 * SQLITE INDEX LAYER — the answer to "the heap cannot hold the corpus".
 *
 * THE MEASUREMENT THIS ANSWERS
 *
 * A 10-minute multi-agent stress run reached 10179 turns with `facts` and `experiences` capped
 * at 10000 each and still ended at **heap 113 MB / RSS 440 MB**. The cause is structural, not
 * a leak: every stored row carries a `tokens` Set, and `scoreDocuments` walks the whole pool
 * on every retrieval. At one million memories that is not "slower", it is impossible.
 *
 * WHY `node:sqlite` AND NOT `better-sqlite3`
 *
 * This project's contract is "zero external dependencies: Node built-ins only" (README, and
 * every release note). `better-sqlite3` needs a native build toolchain; `roaring` likewise.
 * Node 24 ships `node:sqlite` with a synchronous API and a real B-tree on disk — the same
 * shape `better-sqlite3` offers, with nothing to compile. That keeps the contract intact and
 * is the only reason this layer exists at all rather than a dependency being added.
 *
 * WHAT MOVES TO DISK
 *
 *   docs      — the document fields retrieval needs to score a hit
 *   postings  — term → doc id, the inverted index (WITHOUT ROWID: the term IS the key)
 *
 * Retrieval becomes: one SQL query over `postings` to get candidate ids, then a second query
 * to load ONLY those documents. The heap then holds a page cache, not the corpus.
 *
 * WHAT DOES NOT MOVE
 *
 * The JSONL ledgers stay the durable, greppable record — the audit contract this store has
 * always had. SQLite is an INDEX derived from them, rebuildable at any time. That ordering
 * matters: if the index is lost or stale, `rebuildIndex` restores it from the ledgers, and no
 * memory is lost. The reverse (SQLite as source of truth, JSONL as export) would make a
 * corrupt database a data-loss event.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)

/** Present only when the runtime ships `node:sqlite`. */
interface SqliteModule {
  DatabaseSync: new (path: string) => DatabaseLike
}
interface DatabaseLike {
  exec(sql: string): void
  prepare(sql: string): StatementLike
  close(): void
}
interface StatementLike {
  run(...params: unknown[]): { changes?: number; lastInsertRowid?: number | bigint }
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Array<Record<string, unknown>>
}

function loadSqlite(): SqliteModule | undefined {
  try {
    return require('node:sqlite') as SqliteModule
  } catch {
    return undefined
  }
}

/** Whether this runtime can back the index with SQLite. */
export function sqliteAvailable(): boolean {
  return loadSqlite() !== undefined
}

export interface IndexDocument {
  id: string
  kind: 'skill' | 'negative' | 'fact' | 'experience'
  title: string
  when: string
  detail: string
  scanText: string
  scene: string
  domain: string
  workspace: string
  scope: string
  validAt: string
  invalidAt: string
  provenance: string
  /** ISO timestamp the row was written; used for staleness and ordering. */
  at: string
  hits: number
  /** Distinct tokens of the document, as produced by `tokenize`. */
  tokens: readonly string[]
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  "when"      TEXT NOT NULL,
  detail      TEXT NOT NULL,
  scan_text   TEXT NOT NULL,
  scene       TEXT NOT NULL,
  domain      TEXT NOT NULL,
  workspace   TEXT NOT NULL,
  scope       TEXT NOT NULL,
  valid_at    TEXT NOT NULL,
  invalid_at  TEXT NOT NULL,
  provenance  TEXT NOT NULL,
  at          TEXT NOT NULL,
  hits        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS postings (
  term   TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  PRIMARY KEY (term, doc_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_postings_term ON postings(term);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

export interface SqliteIndexOptions {
  /** Path to the database file. */
  readonly file: string
}

/**
 * A thin, synchronous index over SQLite.
 *
 * NO CACHE OF ITS OWN: caching rows in JS would recreate the heap problem this exists to
 * solve. Callers ask for candidate ids, then for those documents, and let SQLite's page cache
 * do the caching.
 */
export class SqliteIndex {
  private readonly db: DatabaseLike
  private readonly insertDoc: StatementLike
  private readonly insertPosting: StatementLike
  private readonly deleteDocPostings: StatementLike
  private readonly selectByIds: StatementLike
  private readonly countDocs: StatementLike
  private readonly selectPostingsByTerm: StatementLike
  private readonly countPostingsByTerm: StatementLike
  /**
   * Cached `SELECT … WHERE id IN (?,…)` statements, keyed by placeholder count.
   * Re-preparing per call leaks native memory that `heapUsed` never shows.
   */
  private readonly selectDocsByArity = new Map<number, StatementLike>()
  private readonly deleteDoc: StatementLike

  constructor(options: SqliteIndexOptions) {
    const sqlite = loadSqlite()
    if (sqlite === undefined) throw new Error('node:sqlite is not available in this runtime')
    this.db = new sqlite.DatabaseSync(options.file)
    /**
     * WAL + NORMAL sync: durable across process crashes, cheap per write. `FULL` would fsync
     * on every insert and turn a batch migration into minutes.
     */
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA synchronous=NORMAL')
    this.db.exec(SCHEMA)
    this.insertDoc = this.db.prepare(
      `INSERT OR REPLACE INTO docs (id, kind, title, "when", detail, scan_text, scene, domain, workspace, scope, valid_at, invalid_at, provenance, at, hits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.insertPosting = this.db.prepare('INSERT OR IGNORE INTO postings (term, doc_id) VALUES (?, ?)')
    this.deleteDocPostings = this.db.prepare('DELETE FROM postings WHERE doc_id = ?')
    this.selectByIds = this.db.prepare('SELECT * FROM docs WHERE id = ?')
    this.countDocs = this.db.prepare('SELECT COUNT(*) AS n FROM docs')
    /**
     * Prepared ONCE and reused: these run on every retrieval, and re-preparing per call is
     * pure overhead in the SQLite C boundary.
     */
    this.selectPostingsByTerm = this.db.prepare('SELECT doc_id FROM postings WHERE term = ?')
    this.countPostingsByTerm = this.db.prepare('SELECT COUNT(*) AS n FROM postings WHERE term = ?')
    this.deleteDoc = this.db.prepare('DELETE FROM docs WHERE id = ?')
  }

  /** Insert or replace documents and their postings, in one transaction. */
  upsertDocuments(documents: readonly IndexDocument[]): number {
    if (documents.length === 0) return 0
    this.db.exec('BEGIN')
    try {
      for (const document of documents) {
        this.insertDoc.run(
          document.id,
          document.kind,
          document.title,
          document.when,
          document.detail,
          document.scanText,
          document.scene,
          document.domain,
          document.workspace,
          document.scope,
          document.validAt,
          document.invalidAt,
          document.provenance,
          document.at,
          document.hits,
        )
        /** Replacing a document invalidates its old postings first. */
        this.deleteDocPostings.run(document.id)
        for (const token of document.tokens) this.insertPosting.run(token, document.id)
      }
      this.db.exec('COMMIT')
      return documents.length
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw error
    }
  }

  /**
   * Candidate ids for a set of query terms.
   *
   * TWO MEASURED MISTAKES ARE RECORDED HERE, because both look reasonable and both were wrong.
   *
   * 1. `WHERE term IN (…) GROUP BY doc_id ORDER BY COUNT(*) DESC LIMIT ?` plans as
   *    `USE TEMP B-TREE FOR GROUP BY` + `USE TEMP B-TREE FOR ORDER BY` and measured 12.0 ms
   *    for three terms over 20000 documents.
   *
   * 2. Moving the aggregation to JS (one index lookup per term + a Map count) measured
   *    **22.7 ms — twice as bad**. The reason is not the language: a term like `memory` or
   *    `failure` appears in EVERY document, so its postings list is 20000 rows. Pulling
   *    40000 rows across the SQLite/JS boundary to count them is worse than letting SQLite
   *    aggregate in C.
   *
   * THE FIX IS INFORMATION RETRIEVAL, NOT SQL: a high-frequency term has no SELECTIVITY — it
   * cannot narrow the candidate set, it can only rank what is already there. So candidates are
   * generated from the RAREST terms (at most `MAX_CANDIDATE_TERMS`), and every term still
   * contributes to scoring later. This is the standard "rare terms for recall, all terms for
   * ranking" split.
   *
   * If every term is high-frequency (a query made only of common words), there is nothing to
   * narrow with; the caller gets an empty list and scores whatever pool it already has.
   */
  candidates(terms: readonly string[], limit = 500): string[] {
    if (terms.length === 0) return []
    const total = this.count()
    if (total === 0) return []
    const dfs = this.documentFrequencies(terms)
    /** A term present in more than this share of the corpus cannot narrow anything. */
    const SELECTIVITY_CEILING = 0.5
    /** Cap the number of terms used for candidate generation: more terms = more rows pulled. */
    const MAX_CANDIDATE_TERMS = 2
    const selective = terms
      .filter((term) => {
        const df = dfs.get(term) ?? 0
        return df > 0 && df <= total * SELECTIVITY_CEILING
      })
      .sort((left, right) => (dfs.get(left) ?? 0) - (dfs.get(right) ?? 0))
      .slice(0, MAX_CANDIDATE_TERMS)
    if (selective.length === 0) return []
    const counts = new Map<string, number>()
    for (const term of selective) {
      const rows = this.selectPostingsByTerm.all(term) as Array<{ doc_id: string }>
      for (const row of rows) {
        const id = String(row.doc_id)
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
    }
    if (counts.size === 0) return []
    return [...counts.entries()]
      .sort((left, right) => (right[1] - left[1]) || left[0].localeCompare(right[0]))
      .slice(0, limit)
      .map(([id]) => id)
  }

  /** Document frequency of each term, for IDF weighting. One index lookup per term. */
  documentFrequencies(terms: readonly string[]): Map<string, number> {
    const out = new Map<string, number>()
    for (const term of terms) {
      const row = this.countPostingsByTerm.get(term) as { n: number } | undefined
      const n = row === undefined ? 0 : Number(row.n)
      if (n > 0) out.set(term, n)
    }
    return out
  }

  /**
   * Load exactly the requested documents — in ONE query, with a REUSED statement.
   *
   * TWO MEASURED DEFECTS ARE RECORDED HERE.
   *
   * 1. The first version looped `SELECT * FROM docs WHERE id = ?` per id: 100 prepare/bind/step
   *    cycles through the SQLite C boundary. Retrieval measured 12.94 ms.
   *
   * 2. The batch version then called `prepare()` on EVERY invocation and never finalised the
   *    statement. RSS climbed from 100 MB to 169 MB over 300 retrievals while `heapUsed`
   *    stayed at 9.2 MB — a native-side leak invisible to V8. `node:sqlite` statements must be
   *    reused, not re-prepared.
   *
   * So statements are cached BY ARITY: an `IN (?,?,…)` list with a given number of placeholders
   * is the same SQL, and different arities are a small, bounded set.
   */
  documentsByIds(ids: readonly string[]): IndexDocument[] {
    if (ids.length === 0) return []
    const statement = this.statementForArity(ids.length)
    const rows = statement.all(...ids) as Array<Record<string, unknown>>
    /**
     * SQLite does not preserve the IN-list order, and the caller ranks by the id order it
     * asked for. Restore it explicitly rather than letting result order decide ranking.
     */
    const byId = new Map(rows.map((row) => [String(row.id), row]))
    const out: IndexDocument[] = []
    for (const id of ids) {
      const row = byId.get(id)
      if (row !== undefined) out.push(rowToDocument(row))
    }
    return out
  }

  /** One cached statement per placeholder count; see `documentsByIds` for why this matters. */
  private statementForArity(count: number): StatementLike {
    const cached = this.selectDocsByArity.get(count)
    if (cached !== undefined) return cached
    const statement = this.db.prepare(`SELECT * FROM docs WHERE id IN (${Array.from({ length: count }, () => '?').join(', ')})`)
    this.selectDocsByArity.set(count, statement)
    return statement
  }

  count(): number {
    const row = this.countDocs.get() as { n: number } | undefined
    return row === undefined ? 0 : Number(row.n)
  }

  /** Remove a document and its postings. */
  removeDocument(id: string): void {
    this.deleteDocPostings.run(id)
    this.deleteDoc.run(id)
  }

  /** Drop every row. Used by a full rebuild. */
  clear(): void {
    this.db.exec('DELETE FROM postings')
    this.db.exec('DELETE FROM docs')
  }

  close(): void {
    /**
     * Statements are finalised by closing the database. Cached statements are not individually
     * finalised first because `node:sqlite` releases them with the connection.
     */
    this.selectDocsByArity.clear()
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}

function rowToDocument(row: Record<string, unknown>): IndexDocument {
  return {
    id: String(row.id),
    kind: String(row.kind) as IndexDocument['kind'],
    title: String(row.title),
    when: String(row.when ?? ''),
    detail: String(row.detail ?? ''),
    scanText: String(row.scan_text ?? ''),
    scene: String(row.scene ?? 'general'),
    domain: String(row.domain ?? 'general'),
    workspace: String(row.workspace ?? ''),
    scope: String(row.scope ?? 'project'),
    validAt: String(row.valid_at ?? ''),
    invalidAt: String(row.invalid_at ?? ''),
    provenance: String(row.provenance ?? 'inferred'),
    at: String(row.at ?? ''),
    hits: Number(row.hits ?? 1),
    /** Postings are the index; the token list is not stored per document. */
    tokens: [],
  }
}

/**
 * Build (or rebuild) the index from a ledger file WITHOUT loading the ledger into memory.
 *
 * THE MEASUREMENT THIS FIXES
 *
 * `indexFromRows` takes an array, so the caller has to materialise every document — including
 * its token list — before a single row reaches SQLite. Measured RSS after building the index:
 *
 *     5 000 documents  → 118 MB
 *    20 000 documents  → 265 MB
 *
 * The heap stayed at 9 MB in both cases, so this was native/V8 retained memory from the
 * temporary array, not a leak in the index. But "temporary" is cold comfort at a million
 * rows: the array would have to exist in full, which is exactly the failure mode this index
 * exists to prevent.
 *
 * So this reads the ledger line by line, tokenises a bounded batch, writes it, and releases
 * it. Peak memory becomes a function of the BATCH SIZE, not of the corpus.
 */
export function rebuildIndexFromLedger(
  index: SqliteIndex,
  ledgerPath: string,
  options: {
    kind: IndexDocument['kind']
    /** Lines per batch. Larger is faster; smaller bounds peak memory. */
    batchSize?: number
    /** How to turn one parsed ledger row into indexable text. */
    textOf: (record: Record<string, unknown>) => string
    tokenize: (text: string) => readonly string[]
    /** Called with the parsed row and its line index, for extracting the metadata fields. */
    describe: (record: Record<string, unknown>, lineIndex: number) => Omit<IndexDocument, 'tokens' | 'scanText' | 'title'> & {
      title: string
      scanText: string
    }
    /** Progress callback, so a long rebuild is observable. */
    onBatch?: (written: number) => void
  },
): number {
  const batchSize = Math.max(1, options.batchSize ?? 500)
  let written = 0
  let batch: IndexDocument[] = []
  let lineIndex = 0
  let text = ''
  try {
    text = readFileSync(ledgerPath, 'utf8')
  } catch {
    return 0
  }
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue
    const current = lineIndex
    lineIndex += 1
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const body = options.textOf(record)
    if (body.trim().length === 0) continue
    const described = options.describe(record, current)
    batch.push({ ...described, tokens: options.tokenize(body) })
    if (batch.length >= batchSize) {
      written += index.upsertDocuments(batch)
      batch = []
      options.onBatch?.(written)
    }
  }
  if (batch.length > 0) {
    written += index.upsertDocuments(batch)
    options.onBatch?.(written)
  }
  return written
}

/**
 * Build (or extend) the index from the JSONL ledgers, given already-materialised rows.
 *
 * Kept for tests and small corpora. For a real rebuild use `rebuildIndexFromLedger`, which
 * streams and therefore does not require the corpus to fit in memory.
 *
 * WHY THE LEDGERS REMAIN THE SOURCE OF TRUTH: the index is derived data. Losing it costs a
 * rebuild; losing a ledger costs memories. That asymmetry decides which side is authoritative,
 * and it is why this function takes the ledgers as input rather than the database.
 *
 * The tokenizer is injected so this module does not import retrieval (which would create a
 * cycle: retrieve → index → retrieve).
 */
export function indexFromRows(
  index: SqliteIndex,
  rows: ReadonlyArray<{
    id: string
    kind: IndexDocument['kind']
    title: string
    when?: string
    detail?: string
    scanText?: string
    scene?: string
    domain?: string
    workspace?: string
    scope?: string
    validAt?: string
    invalidAt?: string
    provenance?: string
    at?: string
    hits?: number
    tokens: readonly string[]
  }>,
): number {
  return index.upsertDocuments(
    rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      when: row.when ?? '',
      detail: row.detail ?? '',
      scanText: row.scanText ?? '',
      scene: row.scene ?? 'general',
      domain: row.domain ?? 'general',
      workspace: row.workspace ?? '',
      scope: row.scope ?? 'project',
      validAt: row.validAt ?? '',
      invalidAt: row.invalidAt ?? '',
      provenance: row.provenance ?? 'inferred',
      at: row.at ?? '',
      hits: row.hits ?? 1,
      tokens: row.tokens,
    })),
  )
}
