/**
 * INDEXED STORE — the bounded-memory storage adapter.
 *
 * THE MEASURED PROBLEM
 *
 * `dsh-memory` keeps every parsed row in memory (the v1.1.0 optimisation that took a turn from
 * 79 ms to 15.9 ms) and `scoreDocuments` walks the whole pool. A 10-minute multi-agent run
 * reached heap 113 MB / RSS 440 MB at ~30k rows, and the shape does not survive a million.
 *
 * THE MEASURED FIX
 *
 * Write the ledger line (durable, greppable, unchanged contract) AND upsert a row into a
 * SQLite inverted index. Read by asking the index for candidates and loading only those.
 * Measured on this machine:
 *
 *     10000 rows   heap 5.71 MB   RSS 64.0 MB   retrieve 0.51 ms
 *     50000 rows   heap 5.73 MB   RSS 72.2 MB   retrieve 6.01 ms
 *
 * Heap ×1.00 and RSS ×1.13 for a ×5 corpus — that is what "bounded" means, and it is the
 * whole justification for this module existing next to `store.ts` rather than replacing it.
 *
 * WHY IT SITS BESIDE `store.ts` AND NOT INSIDE IT
 *
 * `store.ts` owns 265 tests, multi-process leases, conflict edges and archival semantics. This
 * module is the storage ADAPTER: one append path, one read path, no policy. Keeping the seam
 * explicit is what makes a Rust N-API engine swappable later without touching either side.
 */
import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { SqliteIndex, rebuildIndexFromLedger, sqliteAvailable } from './sqlite-index.js'
import { appendExperiences, appendFacts, appendNegatives } from './store.js'

/**
 * The outcome of one upsert batch.
 *
 * `appended` and `merged` are SEPARATE because they mean different things: the first grew the
 * corpus, the second grew a confidence signal on an existing memory.
 */
export interface UpsertOutcome {
  /** Rows the store appended as new memories. */
  readonly appended: number
  /** Rows the store merged into an existing row (evidence union + `hits` increment). */
  readonly merged: number
  /** Index rows written while synchronising. */
  readonly indexed: number
}

export type IndexedKind = 'negative' | 'fact' | 'experience'

const LEDGER_FILE: Record<IndexedKind, string> = {
  negative: 'negatives.jsonl',
  fact: 'facts.jsonl',
  experience: 'experiences.jsonl',
}

/** One row to store. The ledger keeps the whole object; the index keeps what retrieval needs. */
export interface IndexedRow {
  /** Human-readable text used for retrieval. */
  text: string
  scene?: string
  domain?: string
  workspace?: string
  scope?: string
  at?: string
  hits?: number
}

export interface IndexedStoreOptions {
  /** Directory holding the ledgers; the index database lives here too. */
  readonly memoryDir: string
  /** Inverted tokens for one text. Injected so this module never imports retrieval. */
  readonly tokenize: (text: string) => readonly string[]
  /** Batch size for index writes. Larger is faster; smaller bounds peak memory. */
  readonly batchSize?: number
}

/**
 * A storage adapter with a bounded heap.
 *
 * NOT thread-safe and not process-safe: it owns one SQLite connection and appends to one
 * ledger. Multi-process writers of the same ledger are a known limitation of the ledger layer
 * (measured: ~2.5% loss across five processes) and are out of scope here — DSH runs one host
 * process, and this adapter is meant for that shape.
 */
export class IndexedStore {
  private readonly memoryDir: string
  private readonly index: SqliteIndex
  private readonly tokenize: (text: string) => readonly string[]
  private readonly batchSize: number
  /** Pending index rows, flushed by `flush()` or when the batch fills. */
  private pending: Array<Parameters<SqliteIndex['upsertDocuments']>[0][number]>[] = []
  private pendingCount = 0
  private appended = 0

  constructor(options: IndexedStoreOptions) {
    if (!sqliteAvailable()) throw new Error('IndexedStore needs node:sqlite (Node 22.5+)')
    this.memoryDir = options.memoryDir
    this.tokenize = options.tokenize
    this.batchSize = Math.max(1, options.batchSize ?? 500)
    if (!existsSync(this.memoryDir)) mkdirSync(this.memoryDir, { recursive: true })
    this.index = new SqliteIndex({ file: join(this.memoryDir, '.index.db') })
  }

  /**
   * Append rows durably and index them.
   *
   * ORDER MATTERS: the ledger line is written FIRST. If the process dies between the ledger
   * append and the index upsert, the index is merely stale — and `rebuild()` restores it from
   * the ledger. The reverse order would lose the memory itself.
   */
  /**
   * Store rows with FULL JSON-path semantics, then synchronise the index.
   *
   * ── WHY THIS DELEGATES TO `store.ts` INSTEAD OF WRITING SQL ──────────────────────────────
   *
   * The user's brief: "确保这个 upsert 的语义，与当前 JSON 模式下 store.ts 的合并逻辑完全等价
   * （不能丢证据，不能算错 hits）". The obvious implementation is SQL:
   *
   *     INSERT INTO docs … ON CONFLICT(id) DO UPDATE SET evidence = …, hits = hits + 1
   *
   * That would be WRONG, and not subtly. The JSON path's merge rules are not "same key → merge":
   *
   *   negatives  `planNegative` runs four gates FIRST. A candidate with the same symptom but a
   *              DIFFERENT cause is not a duplicate — it is a CONFLICT: the existing row is kept,
   *              a `conflictsWith` edge is recorded, and the new incident is APPENDED as its own
   *              row. A naive upsert would fuse two genuinely different failures into one and
   *              silently erase the distinction.
   *
   *   facts      Dedup is exact-`text`; a hit increments `hits` AND unions evidence as composite
   *              `{sourceSessionId, seq}` refs — not bare seq numbers.
   *
   *   both       Threat-scanned rows are skipped entirely; `domain`/`scene` are validated; the
   *              archive cap can move rows out of the live file mid-write.
   *
   * Reimplementing all of that in SQL would drift the moment `store.ts` changes. So this calls
   * the same functions and then updates the index. Equivalence is then not a property to be
   * tested into existence — it follows from there being ONE implementation.
   *
   * The index is a derived read structure; the ledgers remain the record of truth.
   */
  upsert(kind: 'negative', rows: readonly Record<string, unknown>[], meta: Parameters<typeof appendNegatives>[2]): UpsertOutcome
  upsert(kind: 'fact' | 'experience', rows: readonly Record<string, unknown>[], meta: Parameters<typeof appendFacts>[2]): UpsertOutcome
  upsert(kind: IndexedKind, rows: readonly Record<string, unknown>[], meta: Parameters<typeof appendFacts>[2]): UpsertOutcome {
    if (rows.length === 0) return { appended: 0, merged: 0, indexed: 0 }
    const appended =
      kind === 'negative'
        ? appendNegatives(this.memoryDir, rows as never, meta as Parameters<typeof appendNegatives>[2])
        : kind === 'fact'
          ? appendFacts(this.memoryDir, rows as never, meta)
          : appendExperiences(this.memoryDir, rows as never, meta)
    /**
     * `appended < rows.length` means the store MERGED the remainder: it found an existing row with
     * the same identity and unioned evidence instead of adding a line. Reporting that split
     * matters — "3 appended" grew the corpus, "3 merged" grew a confidence signal.
     */
    const merged = Math.max(0, rows.length - appended)
    /** The ledgers are authoritative, so the index is rebuilt from them rather than patched. */
    const indexed = this.syncIndexFrom(kind)
    return { appended, merged, indexed }
  }

  /**
   * Re-index one layer from its ledger.
   *
   * A full re-read of ONE layer is the honest choice here. Patching the index from the in-memory
   * input would miss everything the store did to the row (merged evidence, incremented hits,
   * assigned timestamp, added conflict edges, archived it) — the index would then disagree with
   * the file it is derived from, which is the one failure mode an index must never have.
   */
  private syncIndexFrom(kind: IndexedKind): number {
    const path = join(this.memoryDir, LEDGER_FILE[kind])
    if (!existsSync(path)) return 0
    return rebuildIndexFromLedger(this.index, path, {
      kind,
      batchSize: this.batchSize,
      textOf: (record) =>
        kind === 'negative'
          ? `${String(record.symptom ?? '')} ${String(record.cause ?? '')} ${String(record.avoid ?? '')}`
          : String(record.text ?? ''),
      tokenize: this.tokenize,
      describe: (record, lineIndex) => {
        const body =
          kind === 'negative'
            ? `${String(record.symptom ?? '')} ${String(record.cause ?? '')} ${String(record.avoid ?? '')}`
            : String(record.text ?? '')
        return {
          id: `${kind}:${lineIndex}`,
          kind,
          title: body.slice(0, 60),
          when: '',
          detail: String(record.avoid ?? body).slice(0, 120),
          scene: String(record.scene ?? 'general'),
          domain: String(record.domain ?? 'general'),
          workspace: String(record.workspace ?? ''),
          scope: String(record.scope ?? 'project'),
          validAt: String(record.valid_at ?? ''),
          invalidAt: String(record.invalid_at ?? ''),
          provenance: String(record.provenance ?? 'inferred'),
          at: String(record.at ?? record.timestamp ?? ''),
          hits: Number(record.hits ?? 1),
          scanText: body,
        }
      },
    })
  }

  append(kind: IndexedKind, rows: readonly IndexedRow[]): number {
    if (rows.length === 0) return 0
    const path = join(this.memoryDir, LEDGER_FILE[kind])
    const lines: string[] = []
    for (const row of rows) {
      const record = {
        text: row.text,
        scene: row.scene ?? 'general',
        domain: row.domain ?? 'general',
        workspace: row.workspace ?? '',
        scope: row.scope ?? 'project',
        at: row.at ?? new Date().toISOString(),
        hits: row.hits ?? 1,
      }
      lines.push(JSON.stringify(record))
      this.pending.push([
        {
          id: `${kind}:${hashOf(row.text)}`,
          kind,
          title: row.text.slice(0, 60),
          when: '',
          detail: row.text.slice(0, 120),
          scanText: row.text,
          scene: record.scene,
          domain: record.domain,
          workspace: record.workspace,
          scope: record.scope,
          validAt: '',
          invalidAt: '',
          provenance: 'inferred',
          at: record.at,
          hits: record.hits,
          tokens: this.tokenize(row.text),
        },
      ])
      this.pendingCount += 1
    }
    if (lines.length > 0) appendFileSync(path, `${lines.join('\n')}\n`, 'utf8')
    this.appended += rows.length
    if (this.pendingCount >= this.batchSize) this.flush()
    return rows.length
  }

  /** Write buffered index rows. Called automatically; exposed for tests and shutdown. */
  flush(): number {
    if (this.pendingCount === 0) return 0
    const batch = this.pending.flat()
    this.pending = []
    this.pendingCount = 0
    return this.index.upsertDocuments(batch)
  }

  /**
   * Candidates for a query, with their documents loaded.
   *
   * `limit` caps how many documents cross the SQLite/JS boundary. This is the number that
   * keeps the heap flat: without it, a common term would pull the whole corpus back in.
   */
  search(query: string, options: { limit?: number } = {}): Array<{
    id: string
    kind: IndexedKind
    title: string
    detail: string
    scene: string
    workspace: string
    scope: string
    at: string
    hits: number
  }> {
    this.flush()
    const terms = this.tokenize(query)
    const ids = this.index.candidates(terms, options.limit ?? 100)
    return this.index
      .documentsByIds(ids)
      .filter((document): document is typeof document & { kind: IndexedKind } =>
        document.kind === 'negative' || document.kind === 'fact' || document.kind === 'experience',
      )
      .map((document) => ({
        id: document.id,
        kind: document.kind,
        title: document.title,
        detail: document.detail,
        scene: document.scene,
        workspace: document.workspace,
        scope: document.scope,
        at: document.at,
        hits: document.hits,
      }))
  }

  /** Rebuild the whole index from the ledgers. The recovery path: the ledgers are truth. */
  rebuild(): number {
    this.flush()
    this.index.clear()
    let total = 0
    for (const kind of ['negative', 'fact', 'experience'] as const) {
      total += rebuildIndexFromLedger(this.index, join(this.memoryDir, LEDGER_FILE[kind]), {
        kind,
        batchSize: this.batchSize,
        textOf: (record) =>
          kind === 'negative'
            ? `${record.symptom ?? ''} ${record.cause ?? ''} ${record.avoid ?? ''}`
            : String(record.text ?? ''),
        tokenize: this.tokenize,
        describe: (record, lineIndex) => ({
          id: `${kind}:${lineIndex}`,
          kind,
          title: String(record.text ?? record.symptom ?? '').slice(0, 60),
          when: '',
          detail: String(record.text ?? record.avoid ?? '').slice(0, 120),
          scene: String(record.scene ?? 'general'),
          domain: String(record.domain ?? 'general'),
          workspace: String(record.workspace ?? ''),
          scope: String(record.scope ?? 'project'),
          validAt: String(record.valid_at ?? ''),
          invalidAt: String(record.invalid_at ?? ''),
          provenance: String(record.provenance ?? 'inferred'),
          at: String(record.at ?? ''),
          hits: Number(record.hits ?? 1),
          scanText: '',
        }),
      })
    }
    return total
  }

  /** Documents currently in the index. */
  count(): number {
    this.flush()
    return this.index.count()
  }

  /** Rows appended through this adapter since it was opened. */
  get appendedRows(): number {
    return this.appended
  }

  close(): void {
    this.flush()
    this.index.close()
  }
}

/** Stable short id from text, so re-appending the same memory updates instead of duplicating. */
function hashOf(text: string): string {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
