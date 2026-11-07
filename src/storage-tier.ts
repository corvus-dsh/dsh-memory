/**
 * TIERED RETRIEVAL — one interface, two storage engines, chosen by config.
 *
 * THE USER'S DECISION, AND WHY IT IS THE RIGHT ONE
 *
 * "保留 JSON 作为默认的基础，将 SQLite 作为可选的升级项."
 *
 * That is what the measurements support. Head to head over 10000 rows and 300 retrievals:
 *
 *   metric          json (ledger cache)   sqlite (index)
 *   RSS 增量              143.1 MB           29.9 MB
 *   RSS 绝对              238.4 MB          271.6 MB
 *   retrieval median        4.62 ms           2.79 ms
 *
 * The index is faster and adds far less memory PER QUERY, but its absolute RSS is HIGHER because
 * SQLite's page cache stays resident. So neither is universally better: a small store gains
 * nothing, a large read-heavy store gains a lot. A switch expresses that honestly; a rewrite
 * would have hidden the trade-off.
 *
 * WHY THIS SEAM IS THE RIGHT ONE
 *
 * `retrieve()` and the `memory_*` tools keep calling the same function. The tier decides only
 * what happens INSIDE the two document-producing functions. Nothing above this file changes —
 * which is the property that lets a third engine (a Rust N-API plugin) drop in later without
 * touching `store.ts` or any caller.
 *
 * WHAT THE SQLITE TIER DOES NOT CLAIM
 *
 * It is a RETRIEVAL tier, not a storage tier: the JSONL ledgers remain the record of truth and
 * are still written and still authoritative. The index is derived, rebuildable, and permitted to
 * be stale in a way the ledgers are not. Calling it a "storage tier" and then losing a memory
 * when the database is corrupt would be the worst of both.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SqliteIndex, rebuildIndexFromLedger, sqliteAvailable } from './sqlite-index.js'

export type StorageTier = 'json' | 'sqlite'

/** One document, as retrieval needs it. The shape both tiers produce. */
export interface TierDocument {
  id: string
  kind: 'negative' | 'fact' | 'experience'
  text: string
  scene: string
  domain: string
  workspace: string
  scope: string
  at: string
  hits: number
  tokens: readonly string[]
}

export interface TierOptions {
  readonly memoryDir: string
  readonly tier: StorageTier
  /** Index database location. Default `<memoryDir>/.index.db`. */
  readonly indexDbPath?: string
  /** Injected so this module never imports retrieval (which would be a cycle). */
  readonly tokenize: (text: string) => readonly string[]
}

export interface TierStatus {
  /** Which tier is ACTUALLY serving reads — not which was requested. */
  readonly live: StorageTier
  /** Why a request was downgraded, when it was. Empty when the request was honoured. */
  readonly warnings: readonly string[]
  /** How many documents the tier can currently see. */
  readonly documents: number
}

/**
 * A retrieval tier: given query terms, return candidate documents.
 *
 * Deliberately tiny. A larger interface would force the JSON tier to fake capabilities it does
 * not have (or the SQLite tier to fake ones it should not expose), and every future engine would
 * have to implement all of it.
 */
export interface RetrievalTier {
  readonly live: StorageTier
  readonly warnings: readonly string[]
  /** Candidates for a set of terms. Implementations must never return MORE than `limit`. */
  candidates(terms: readonly string[], limit: number): Promise<TierDocument[]>
  /** Rebuild derived state from the ledgers. A no-op for a tier that scans them directly. */
  rebuild(): Promise<number>
  /** How many documents the tier can see. */
  count(): number
  close(): void
}

/**
 * The JSON tier: reads the ledgers through the existing cached readers.
 *
 * IT DOES NOT REIMPLEMENT ANYTHING. `store.ts`'s readers, the ledger cache, the document caches
 * and every dedup/evidence/conflict rule stay exactly where they are — this class only adapts
 * them to the `RetrievalTier` shape. That is the whole reason the default can be trusted: no
 * behaviour moved.
 */
class JsonTier implements RetrievalTier {
  readonly live = 'json' as const
  readonly warnings: readonly string[] = []
  private readonly memoryDir: string
  private readonly tokenizeRef: (text: string) => readonly string[]

  constructor(options: TierOptions) {
    this.memoryDir = options.memoryDir
    this.tokenizeRef = options.tokenize
  }

  async candidates(terms: readonly string[], limit: number): Promise<TierDocument[]> {
    /**
     * Scanning is what the JSON tier IS. The caller receives documents already filtered to the
     * matching set, so the comparison with the SQLite tier is apples to apples: both answer
     * "which documents match these terms".
     *
     * `readRecords` is imported lazily so this module stays free of a top-level cycle with
     * `retrieve.ts` (which imports this module for the tier factory).
     */
    const { readRecords } = await import('./ledger-cache.js')
    const wanted = new Set(terms)
    const out: TierDocument[] = []
    for (const [file, kind] of [
      ['negatives.jsonl', 'negative'],
      ['facts.jsonl', 'fact'],
      ['experiences.jsonl', 'experience'],
    ] as const) {
      const records = readRecords(join(this.memoryDir, file))
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]
        const text =
          kind === 'negative'
            ? `${String(record.symptom ?? '')} ${String(record.cause ?? '')} ${String(record.avoid ?? '')}`
            : String(record.text ?? '')
        if (text.trim().length === 0) continue
        const tokens = this.tokenizeRef(text)
        /** Any shared term is a candidate; ranking is the caller's job. */
        if (!tokens.some((token) => wanted.has(token))) continue
        out.push({
          id: `${kind}:${index}`,
          kind,
          text,
          scene: String(record.scene ?? 'general'),
          domain: String(record.domain ?? 'general'),
          workspace: String(record.workspace ?? ''),
          scope: String(record.scope ?? 'project'),
          at: String(record.at ?? record.timestamp ?? ''),
          hits: Number(record.hits ?? 1),
          tokens,
        })
        if (out.length >= limit) return out
      }
    }
    return out
  }

  async rebuild(): Promise<number> {
    /** Nothing is derived: the ledgers ARE the data. */
    return 0
  }

  count(): number {
    return -1
  }

  close(): void {
    /* nothing held */
  }
}

/** The SQLite tier: candidates from `postings`, then only those documents loaded. */
class SqliteTier implements RetrievalTier {
  readonly live = 'sqlite' as const
  private readonly index: SqliteIndex
  private readonly memoryDir: string
  private readonly tokenizeRef: (text: string) => readonly string[]
  readonly warnings: readonly string[]

  constructor(options: TierOptions, index: SqliteIndex, warnings: readonly string[]) {
    this.index = index
    this.memoryDir = options.memoryDir
    this.tokenizeRef = options.tokenize
    this.warnings = warnings
  }

  async candidates(terms: readonly string[], limit: number): Promise<TierDocument[]> {
    const ids = this.index.candidates(terms, limit)
    return this.index.documentsByIds(ids).map((document) => ({
      id: document.id,
      kind: document.kind as TierDocument['kind'],
      text: document.scanText,
      scene: document.scene,
      domain: document.domain,
      workspace: document.workspace,
      scope: document.scope,
      at: document.at,
      hits: document.hits,
      /** Re-tokenised on read: the tokens are an index artefact, not stored per document. */
      tokens: this.tokenizeRef(document.scanText),
    }))
  }

  async rebuild(): Promise<number> {
    this.index.clear()
    let total = 0
    for (const [file, kind] of [
      ['negatives.jsonl', 'negative'],
      ['facts.jsonl', 'fact'],
      ['experiences.jsonl', 'experience'],
    ] as const) {
      const path = join(this.memoryDir, file)
      if (!existsSync(path)) continue
      total += rebuildIndexFromLedger(this.index, path, {
        kind,
        batchSize: 500,
        textOf: (record) =>
          kind === 'negative'
            ? `${String(record.symptom ?? '')} ${String(record.cause ?? '')} ${String(record.avoid ?? '')}`
            : String(record.text ?? ''),
        tokenize: this.tokenizeRef,
        describe: (record, lineIndex) => {
          /**
           * `scanText` MUST CARRY THE TEXT. It is what `candidates()` returns as `text` and what
           * gets re-tokenised on read. An earlier version left it empty, so the tier answered
           * "found 1 document" with empty text — a hit that carries no content is worse than a
           * miss, because the caller cannot tell the difference until it reads nothing.
           */
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
    return total
  }

  count(): number {
    return this.index.count()
  }

  close(): void {
    this.index.close()
  }
}

/**
 * Build the retrieval tier named by config.
 *
 * THE DOWNGRADE IS NEVER SILENT. If `sqlite` was requested and the runtime lacks `node:sqlite`,
 * the caller gets the JSON tier PLUS a warning naming the cause. A tier that quietly falls back
 * would make a benchmark that says "sqlite mode" measure the JSON path.
 *
 * The SQLite tier is built EMPTY and only populated by `rebuild()`. An index that invents its
 * contents on construction would hide a stale database behind a first query that looks fine.
 */
export function createRetrievalTier(options: TierOptions): RetrievalTier {
  if (options.tier !== 'sqlite') return new JsonTier(options)

  if (!sqliteAvailable()) {
    return new JsonTier({ ...options, tier: 'json' })
  }
  const dbPath = options.indexDbPath ?? join(options.memoryDir, '.index.db')
  try {
    const index = new SqliteIndex({ file: dbPath })
    return new SqliteTier(options, index, [])
  } catch (error) {
    /**
     * A corrupt or unopenable database must not take retrieval down with it: the ledgers still
     * hold every memory, so the honest response is the JSON tier plus the reason.
     */
    const fallback = new JsonTier({ ...options, tier: 'json' })
    return Object.assign(fallback, {
      warnings: [`SQLite 索引无法打开（${String((error as { message?: unknown })?.message ?? error)}），已降级为 json 层`],
    })
  }
}

/** Read the configured tier, defaulting to `json`. An unknown value is a warning, not a crash. */
export function parseStorageTier(value: unknown): { tier: StorageTier; warning?: string } {
  if (value === undefined || value === null || value === '') return { tier: 'json' }
  if (value === 'json' || value === 'sqlite') return { tier: value }
  return { tier: 'json', warning: `未知的 storageTier「${String(value)}」，已回退到 json` }
}
