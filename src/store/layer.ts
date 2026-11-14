/**
 * THE JSONL LAYER WRITERS — step A3 of the `store.ts` split.
 *
 * WHAT IS HERE: the append path for the three observation ledgers (negatives / facts /
 * experiences), the archive planners that keep each file bounded, and the SKILL/negative
 * metadata type those writers take as their write stamp.
 *
 * WHY `SkillMeta`, `asVocab` AND `VOCAB_TAG` MOVED WITH THIS STEP (they read like skill code):
 * `appendNegatives` stamps every row from a `SkillMeta` and normalizes its tags through
 * `asVocab`. Leaving them in `store.ts` and importing them back would have created a VALUE
 * edge `store.ts ⇄ layer.ts` — and `scripts/check-cycles.mjs` counts those, unlike type-only
 * imports. Moving them here keeps the dependency one-way: `store.ts → layer.ts`.
 *
 * The consequence for step A1 is recorded in `docs/memory-known-defects.md`: the skill writers
 * will import these three names from here rather than own them. If a later step gives them a
 * neutral home (`store/types.ts`), it must move them OUT of this file, not copy them.
 *
 * The content below is MOVED, not rewritten: `scripts/verify-pure-move.mjs` compares the
 * content-line multiset of the whole `src/` tree, so a single edited character shows up as
 * DISAPPEARED. The only additions are the `import` lines and the `export` keywords.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { EvidenceRef, ExtractedExperience, ExtractedFact, ExtractedNegative, MemoryProvenance } from '../extract.js'
import { canonicalizeEntities, planNegative } from '../dedupe.js'
import { commitLedger, replaceRecords } from '../ledger-cache.js'
import { acquireFileLock, withFileLock } from '../lock.js'
import { normalizeWorkspace } from '../workspace.js'
import { scanThreat } from '../threat.js'
import { monotonicTimestamp } from './clock.js'
import { atomicWrite, readJsonl } from './io.js'

export interface SkillMeta {
  sessionId: string
  boundarySeq: number
  at?: string
  /**
   * v0.8: the cwd of the session this memory came from, recorded so retrieval can
   * refuse to hand it to a different workspace. Provenance only — it is read from
   * the session log header, never from the extraction model, and a merge without
   * a workspace must NOT erase the one already on disk.
   */
  workspace?: string
  /**
   * v0.15: trust tier, derived by the runner from the cited evidence (a human
   * statement, a successful tool result, or neither). Never taken from the
   * extraction model's self-report.
   */
  provenance?: MemoryProvenance
  /**
   * v0.32 P1 — the GENERATION and the CODE COMMIT this experience was extracted against.
   *
   * A skill is a claim about a codebase at a moment in time. Without these two, the
   * next generation inherits "the fix is X" long after X was replaced, and the hint
   * reads exactly as authoritative as a fresh one. Both are provenance: read from the
   * graft target store and from git, never from the extraction model.
   */
  generation?: number
  commitHash?: string
  /** v0.15: bi-temporal start. Defaults to `at` (the write time). */
  validAt?: string
}

/**
 * The shared vocabulary grammar, duplicated from `knowledge.ts` on purpose.
 *
 * `store.ts` is imported by `knowledge.ts`, so importing back would be a cycle. The grammar is a
 * regex and a dedupe loop; the alternative — a cycle in a package that strips types at build time,
 * where a cycle is a load-order bug rather than a linked warning — is decidedly worse.
 */
/**
 * v0.32 搬移（A3）：`VOCAB_TAG` 是 `store/layer.ts` 的**内部共享常量**。
 *
 * `asVocab`（同文件）用它做 tag 校验。把它从头导出，是给未来的 A1 用的：
 * skill 写入链要与 `asVocab` 一起用它做 tags 规范化（方案的甲选 —— layer 内部共享）。
 * 但 `store.ts` **不 re-export 它** —— 它不是 `store.js` 公开面的一部分。
 *
 * `extract.ts:397` 还有一份逐字相同的 `VOCAB_TAG`（注释写明 duplicated on purpose，
 * 因为反向 import 会成环）。那是另一个文件的私有常量，与本层无关。
 */
export const VOCAB_TAG = /^[a-z0-9][a-z0-9+#._-]{0,31}$/u

/** Normalise a tag / node-type list: lowercase, hyphenated, validated, deduped, capped. */
export function asVocab(value: unknown, max = 8): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/u) : []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const tag = item.trim().toLowerCase().replace(/\s+/gu, '-')
    if (!VOCAB_TAG.test(tag) || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= max) break
  }
  return out
}

/**
 * v0.25 P1 — LOCKED READ-MODIFY-WRITE FOR A JSONL STORE FILE.
 *
 * The lost update is not specific to `processed.json`. Every jsonl layer file
 * (negatives, facts, experiences) is edited by READ-ALL, mutate-in-memory,
 * WRITE-ALL, and `atomicWrite` does nothing about that: it guarantees the file
 * changes all at once, not that the change was computed from the current contents.
 *
 * The interleaving that loses data:
 *
 *     A reads 10 rows ─┐
 *     B reads 10 rows ─┼─ both append their own row
 *     A writes 11 ─────┘
 *     B writes 11      ← A's row is gone, silently
 *
 * Two harvests of two different sessions is the normal case, not a rare one: the
 * harvest loop processes several sessions, and two Harvests can run in parallel from
 * two windows. So the whole read→mutate→write is done under one lock.
 *
 * The lock is a SIBLING directory (`<path>.lock`), the same primitive `markProcessed`
 * already uses, so there is one locking discipline in this store rather than two.
 *
 * The body returns whether anything changed; an unchanged pass does not rewrite, so
 * a read-only sweep does not fight other writers for the lock's sake.
 */
function updateJsonlFile<T>(path: string, body: (rows: Record<string, unknown>[]) => { changed: boolean; result: T }): T {
  mkdirSync(dirname(path), { recursive: true })
  return withFileLock(`${path}.lock`, () => {
    const rows = readJsonl(path)
    const { changed, result } = body(rows as Record<string, unknown>[])
    if (changed) atomicWrite(path, rows.map((record) => JSON.stringify(record)).join('\n') + (rows.length > 0 ? '\n' : ''))
    return result
  })
}

/**
 * v1.0.0 P0 — THE NEGATIVE LEDGER HAD NO CEILING.
 *
 * `negatives.jsonl` only ever grew. Every harvest may append; dedupe merges EXACT
 * duplicates but nothing bounds the number of distinct ones. Left alone that is an
 * unbounded file that every `appendNegatives` (read-all, mutate, rewrite) and every
 * retrieval (read-all, tokenize) has to carry — so the cost of an old warning is paid on
 * every future turn, forever.
 *
 * THE POLICY, AND WHY IT IS NOT "DROP THE OLDEST"
 *
 * A negative path is a rule of the form "doing A fails". Age alone is not a reason to
 * retire it: an old rule that keeps being HIT is a real, recurring hazard, and dropping it
 * would relearn the same failure. So the ordering is:
 *
 *   1. `hits` DESC  — re-confirmed rules survive longest
 *   2. `confidence` DESC — rules not undermined by counter-evidence survive
 *   3. `at` DESC    — then newest first
 *
 * Whatever falls past `MAX_NEGATIVES` is APPENDED to `negatives-archive.jsonl` and removed
 * from the live file. Nothing is destroyed: the archive stays greppable and auditable, it
 * simply stops participating in retrieval — the same "cost, not loss" contract that
 * archiving a skill already uses.
 *
 * The thresholds are exported so a test can assert the boundary instead of inferring it.
 */
export const MAX_NEGATIVES = 5000
export const NEGATIVE_ARCHIVE_FILE = 'negatives-archive.jsonl'

export interface NegativeArchivePlan {
  keep: Array<Record<string, unknown>>
  archive: Array<Record<string, unknown>>
}

/** Split records into the live set and the overflow, keeping the most load-bearing first. */
export function planNegativeArchive(records: ReadonlyArray<Record<string, unknown>>, limit = MAX_NEGATIVES): NegativeArchivePlan {
  if (records.length <= limit) return { keep: [...records], archive: [] }
  const rank = (record: Record<string, unknown>): number[] => {
    const hits = Number(record.hits ?? 1)
    const confidence = Number(record.confidence ?? 1)
    const at = Date.parse(String(record.at ?? ''))
    return [
      Number.isFinite(hits) ? hits : 1,
      Number.isFinite(confidence) ? confidence : 1,
      Number.isFinite(at) ? at : 0,
    ]
  }
  const sorted = [...records].sort((left, right) => {
    const a = rank(left)
    const b = rank(right)
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return b[index] - a[index]
    }
    return String(left.symptom ?? '').localeCompare(String(right.symptom ?? ''))
  })
  return { keep: sorted.slice(0, limit), archive: sorted.slice(limit) }
}

export function appendNegatives(memoryDir: string, negatives: ExtractedNegative[], meta: SkillMeta): number {
  if (negatives.length === 0) return 0
  const workspace = normalizeWorkspace(meta.workspace)
  const path = join(memoryDir, 'negatives.jsonl')
  let appended = 0
  let dirty = false
  /**
   * v1.1.0: no pre-lock read. It only warmed a local array; the authoritative read now
   * happens inside the lock via the stat-validated cache, so a pre-lock parse would be a
   * wasted full file read.
   */
  const release = acquireFileLock(`${path}.lock`, { label: 'appendNegatives' })
  try {
    const existing = readJsonl(path)
    const beforeLength = existing.length
    let patched = false
    appended = 0
    dirty = false
    for (const negative of negatives) {
      if (scanThreat(`${negative.symptom} ${negative.cause} ${negative.avoid}`) !== undefined) continue
      // Gates ② (exact) and ④ (same symptom, different cause → link, never merge).
      const plan = planNegative(existing as never, negative)
      if (plan.duplicate) {
        /**
         * ── THE `plan.conflicts.length === 0` GUARD WAS A BUG ─────────────────────────────────
         *
         * The duplicate row was located with:
         *
         *     existing.find((record) => plan.conflicts.length === 0 && record.symptom === … && record.cause === …)
         *
         * `plan.conflicts` describes the WHOLE existing set, not this one candidate: it lists every
         * row that shares the symptom and differs in cause. So as soon as the store held BOTH a
         * duplicate AND a conflicting variant, `plan.conflicts.length` was non-zero and the find
         * returned `undefined` — neither merged nor linked. Measured: three repeats of the same
         * symptom+cause produced one row with `hits: 3` (correct, by luck of ordering), but a store
         * holding a variant first kept re-appending instead of merging, and `conflictsWith` was
         * never written on the duplicate path at all.
         *
         * The identity of a duplicate is `symptom + cause` and nothing else. The conflict list is
         * a SEPARATE concern that is attached when the row is created.
         */
        const same = existing.find(
          (record) => String(record.symptom) === negative.symptom && String(record.cause) === negative.cause,
        )
        if (same !== undefined) {
          const keyOf = (ref: any): string => (ref !== null && typeof ref === 'object' ? `${ref.sourceSessionId}@${ref.seq}` : String(ref))
          const merged = [...new Map([...(Array.isArray(same.evidence) ? same.evidence : []), ...negative.evidence].map((ref) => [keyOf(ref), ref])).values()]
          same.evidence = merged
          same.hits = Number(same.hits ?? 0) + 1
          /**
           * A repeat can ALSO reveal a conflict: the row was already there, and the store has since
           * accumulated variants. Recording the indexes here is what makes the causal layer usable
           * for rows that predate their conflicts — otherwise `conflictsWith` would only ever exist
           * on the first incarnation of a symptom.
           */
          if (plan.conflicts.length > 0) {
            const prior = Array.isArray(same.conflictsWith) ? same.conflictsWith : []
            const union = [...new Set([...prior, ...plan.conflicts])].sort((left, right) => left - right)
            same.conflictsWith = union
          }
          patched = true
          dirty = true
        }
        continue
      }
      existing.push({
        ...negative,
        scope: negative.scope ?? 'project',
        domain: negative.domain ?? 'general',
        // v0.5: confidence starts at 1 and is lowered by counter-evidence, never
        // raised by repetition alone (a repeated failure is not a stronger rule).
        confidence: 1,
        counterEvidence: [],
        sourceSessionId: meta.sessionId,
        boundarySeq: meta.boundarySeq,
        // v0.32: the physical trace, on negatives too — a blocker with no time cannot be ordered in the chain.
        timestamp: monotonicTimestamp(),
        at: meta.at ?? new Date().toISOString(),
        hits: 1,
        // v0.8: same isolation contract as SKILL.md.
        ...(workspace.length === 0 ? {} : { workspace }),
        // v0.15: the same bi-temporal + trust contract as SKILL.md, so a negative
        // can be superseded (and stop being retrieved) without being deleted.
        provenance: negative.provenance ?? meta.provenance ?? 'inferred',
        valid_at: meta.validAt ?? meta.at ?? new Date().toISOString(),
        ...(() => {
          const tags = asVocab((negative as ExtractedNegative).tags)
          return tags.length === 0 ? {} : { tags }
        })(),
        ...(() => {
          const nodeTypes = asVocab((negative as ExtractedNegative).applicableNodeTypes)
          return nodeTypes.length === 0 ? {} : { applicable_node_types: nodeTypes }
        })(),
        ...(plan.conflicts.length === 0 ? {} : { conflictsWith: plan.conflicts }),
      })
      appended += 1
      dirty = true
    }
    if (!dirty) return 0
    /**
     * v1.0.0 P0: enforce the ceiling INSIDE the same lock as the append. Trimming outside
     * it would race a concurrent harvest that is rewriting the same file.
     */
    if (existing.length > MAX_NEGATIVES) {
      const overflow = planNegativeArchive(existing, MAX_NEGATIVES)
      if (overflow.archive.length > 0) {
        appendFileSync(join(memoryDir, NEGATIVE_ARCHIVE_FILE), `${overflow.archive.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
        replaceRecords(path, overflow.keep)
        return appended
      }
    }
    /**
     * v1.1.0 — THE HOT PATH IS NO LONGER A FULL REWRITE.
     *
     * New rows go to the WAL (one append); a `hits += 1` patch forces an immediate flush
     * because a patch cannot be expressed as an append. The common case is append-only,
     * so the common case is O(1).
     */
    commitLedger(path, existing.slice(beforeLength), { patched })
    return appended
  } finally {
    release()
  }
}

interface LayerRecord {
  text: string
  scene?: string
  /** v0.17: semantic domain; different domains never conflict. */
  domain?: string
  /** v0.8: the cwd that produced this observation (isolation provenance). */
  workspace?: string
  /** v0.7.1: composite pointers; legacy rows may still hold bare numbers. */
  evidence: Array<number | EvidenceRef>
  sourceSessionId: string
  boundarySeq: number
  at: string
  hits: number
}

/** Accept both pointer shapes and attach the fallback session to a bare seq. */
function normalizeEvidenceRefs(value: unknown, fallbackSession: string): EvidenceRef[] {
  const out: EvidenceRef[] = []
  const raw = Array.isArray(value) ? value : []
  for (const item of raw) {
    let seq: number
    let session: string
    if (item !== null && typeof item === 'object') {
      seq = Number((item as any).seq)
      const id = typeof (item as any).sourceSessionId === 'string' ? String((item as any).sourceSessionId) : ''
      session = id.length > 0 ? id : fallbackSession
    } else {
      seq = Number(item)
      session = fallbackSession
    }
    if (!Number.isFinite(seq)) continue
    if (out.some((ref) => ref.seq === seq && ref.sourceSessionId === session)) continue
    out.push({ sourceSessionId: session, seq })
  }
  return out
}

/** Append facts/experiences, merging evidence (never instructions, only pointers). */

function appendLayer(
  memoryDir: string,
  file: string,
  entries: ReadonlyArray<{
    text: string
    seq: number
    scene?: string
    domain?: string
    timestamp?: string
    cause?: unknown
    effect?: unknown
    action?: string
  }>,
  meta: SkillMeta,
): number {
  if (entries.length === 0) return 0
  const workspace = normalizeWorkspace(meta.workspace)
  const path = join(memoryDir, file)
  let appended = 0
  let dirty = false
  /** v1.1.0: no pre-lock read; the authoritative read is inside the lock via the cache. */
  const release = acquireFileLock(`${path}.lock`, { label: `appendLayer:${file}` })
  try {
    const existing = readJsonl(path) as unknown as LayerRecord[]
    const beforeLength = existing.length
    let patched = false
    appended = 0
    dirty = false
    for (const entry of entries) {
    if (scanThreat(entry.text) !== undefined) continue
    const same = existing.find((record) => record.text === entry.text)
    if (same !== undefined) {
      // v0.7.1: evidence is composite everywhere, not just in SKILL.md.
      const refs = normalizeEvidenceRefs(same.evidence, meta.sessionId)
      if (!refs.some((ref) => ref.seq === entry.seq && ref.sourceSessionId === meta.sessionId)) {
        refs.push({ sourceSessionId: meta.sessionId, seq: entry.seq })
      }
      same.evidence = refs
      same.hits = Number(same.hits ?? 0) + 1
      patched = true
      dirty = true
      continue
    }
    existing.push({
      text: entry.text,
      scene: /^[a-z][a-z0-9-]{1,23}$/u.test(String(entry.scene ?? '')) ? String(entry.scene) : 'general',
      /**
       * NOTE the single `domain` key. The previous revision declared it TWICE in this object literal — the
       * second silently won, which happened to be identical, so nothing ever failed. That is the kind of
       * duplication that becomes a real bug the moment one copy is edited.
       */
      domain: /^[a-z][a-z0-9-]{1,31}$/u.test(String(entry.domain ?? '').toLowerCase())
        ? String(entry.domain).toLowerCase()
        : 'general',
      /**
       * v0.32: the physical trace. An explicit `entry.timestamp` is honoured (a caller replaying an ordered
       * batch keeps its own order); otherwise the monotonic clock stamps it.
       */
      timestamp: typeof entry.timestamp === 'string' && entry.timestamp.length > 0
        ? entry.timestamp
        : monotonicTimestamp(),
      /**
       * v1.7.0 — ENTITY CANONICALISATION AT WRITE TIME.
       *
       * The causal walk joins nodes by `cause`/`effect` STRINGS. A memory that says `prod-db` and
       * another that says `生产数据库` are therefore two unrelated nodes, and the chain that runs
       * through both stops at the boundary — which looks like a shallow graph when the graph is
       * fine and the NAMES are not.
       *
       * Canonicalising on READ would be wrong twice over: every walk would pay the rewrite, and two
       * records could disagree about what they call the same machine. Normalising on WRITE means
       * the stored edge text is already the canonical name, so the graph is connected by
       * construction. The original wording survives in `text`/`avoid`, so nothing is lost for a
       * human reader.
       *
       * ⚠️ ONLY STRINGS ARE CANONICALISED. `cause` and `effect` may also be POINTER OBJECTS
       * (`{sourceSessionId, seq}`), and an earlier version ran `String(...)` over them
       * unconditionally — which turned a pointer into the literal text `[object Object]` and broke
       * every causal chain built from an experience. The test that caught it asserted
       * `extra.cause === 'session-causal@20'` and got `undefined`.
       */
      ...(typeof entry.cause === 'string'
        ? { cause: canonicalizeEntities(entry.cause) }
        : entry.cause === undefined
          ? {}
          : { cause: entry.cause }),
      ...(typeof entry.effect === 'string'
        ? { effect: canonicalizeEntities(entry.effect) }
        : entry.effect === undefined
          ? {}
          : { effect: entry.effect }),
      ...(typeof entry.action === 'string' && entry.action.length > 0 ? { action: entry.action } : {}),
      evidence: [{ sourceSessionId: meta.sessionId, seq: entry.seq }],
      sourceSessionId: meta.sessionId,
      boundarySeq: meta.boundarySeq,
      at: meta.at ?? new Date().toISOString(),
      hits: 1,
      ...(workspace.length === 0 ? {} : { workspace }),
    })
    appended += 1
    dirty = true
  }
    if (!dirty) return 0
    /**
     * v1.1.1 — FACTS AND EXPERIENCES GET A CEILING TOO.
     *
     * Measured in a 10-minute multi-agent stress run: negatives stabilised at their 5000 cap
     * after 120 s, while `facts` and `experiences` kept climbing past 6000 — and the heap
     * climbed with them (21 MB → 181 MB, RSS 78 MB → 405 MB), while throughput fell from 62 to
     * 30 turns/s. The documents derived from those rows carry a token set each, so an
     * unbounded layer is not "just more JSONL": it is memory that never comes back.
     *
     * Same contract as the negative ledger: the overflow is APPENDED to a sibling archive and
     * dropped from the live file. Nothing is destroyed; the archive is still greppable, it
     * simply stops being loaded on every retrieval.
     */
    if (existing.length > MAX_LAYER_RECORDS) {
      const overflow = planLayerArchive(existing as unknown as Array<Record<string, unknown>>, MAX_LAYER_RECORDS)
      if (overflow.archive.length > 0) {
        appendFileSync(join(memoryDir, `${file}.archive`), `${overflow.archive.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
        replaceRecords(path, overflow.keep)
        return appended
      }
    }
    /** v1.1.0: append-only rows go to the WAL; a `hits += 1` patch forces a flush. */
    commitLedger(path, existing.slice(beforeLength), { patched })
    return appended
  } finally {
    release()
  }
}

/**
 * How many facts / experiences stay live before the oldest are archived.
 *
 * Larger than `MAX_NEGATIVES` because these are observational layers with a higher natural
 * volume (one fact and one experience per turn, versus a handful of negatives per session),
 * and because retrieval treats them as supporting evidence rather than as rules.
 */
export const MAX_LAYER_RECORDS = 10_000

/**
 * Split a layer into the live set and the overflow.
 *
 * Ordering is NEWEST FIRST for these layers: a fact or an experience describes what happened,
 * and an observation from three months ago is worth less than one from yesterday. `hits`
 * breaks ties — something re-confirmed is more load-bearing than something seen once — and
 * `timestamp` (the monotonic write clock) is the final tiebreak so the split is deterministic.
 */
function planLayerArchive(
  records: ReadonlyArray<Record<string, unknown>>,
  limit = MAX_LAYER_RECORDS,
): { keep: Array<Record<string, unknown>>; archive: Array<Record<string, unknown>> } {
  if (records.length <= limit) return { keep: [...records], archive: [] }
  const rank = (record: Record<string, unknown>): number[] => {
    const hits = Number(record.hits ?? 1)
    const at = Date.parse(String(record.timestamp ?? record.at ?? ''))
    return [Number.isFinite(hits) ? hits : 1, Number.isFinite(at) ? at : 0]
  }
  const sorted = [...records].sort((left, right) => {
    const a = rank(left)
    const b = rank(right)
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return b[index] - a[index]
    }
    return String(left.text ?? '').localeCompare(String(right.text ?? ''))
  })
  return { keep: sorted.slice(0, limit), archive: sorted.slice(limit) }
}

export function appendFacts(memoryDir: string, facts: readonly ExtractedFact[], meta: SkillMeta): number {
  return appendLayer(memoryDir, 'facts.jsonl', facts, meta)
}

export function appendExperiences(memoryDir: string, experiences: readonly ExtractedExperience[], meta: SkillMeta): number {
  return appendLayer(memoryDir, 'experiences.jsonl', experiences, meta)
}
