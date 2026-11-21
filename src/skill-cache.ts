/**
 * SKILL DOCUMENT CACHE — shared by the writer (store) and the reader (retrieve).
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * The cache has to be invalidated when a SKILL.md is written, and used when documents are
 * read. `store.ts` must not import `retrieve.ts` (retrieve already imports store), so the
 * cache cannot live in either — it lives here and both import it. That is the whole reason
 * this file exists; it is not decorative layering.
 *
 * INVALIDATION
 *
 *  - Explicit: every writer calls `invalidateSkillDocs(dir)` after touching a SKILL.md.
 *  - Implicit: the key carries the directory mtime (covers add/remove) and the current DAY
 *    (covers an in-place edit by a process that does not call the invalidation).
 *
 * ── THE HOUR WAS A CLIFF, AND IT WAS MEASURED (B4-0b-2, 2026-11-21) ────────────────────────
 *
 * This key used to carry `Math.floor(now / 3_600_000)` — the HOUR. Measured cost of crossing that
 * boundary, same tree on disk, nothing else changed:
 *
 *     skills   warm read    first call after the boundary   ratio
 *        6       0.075 ms          1.160 ms                  15x
 *       50       0.094 ms          6.943 ms                  74x
 *      200       0.059 ms         25.467 ms                 434x
 *      800       0.061 ms        104.634 ms                1724x
 *
 * That is the shape the user reported as 「会话缓存命中断崖式下降」: every hour, on the hour, one call
 * pays a FULL rebuild — not because anything changed on disk, but because the clock moved. The cost
 * scales with the store, so the larger the memory the harder the cliff.
 *
 * ── WHY A DAY IS CORRECT HERE AND AN HOUR WAS NOT ──────────────────────────────────────────
 *
 * The comment below says the hour is safe because 「every field derived from `now` in this store is
 * day-granular」. That sentence is TRUE and it is the argument for the day, not for the hour: measured,
 * `skillDocuments` uses `now` only through `ageDaysOf` (line 182-183), which feeds the 14-day staleness
 * threshold — a value that cannot change between 10:00 and 11:00 in a way that matters. An hourly
 * bucket therefore bought **nothing** and cost a full rebuild per hour.
 *
 * What the bucket is FOR is still true: a foreign writer that never announces itself should be noticed.
 * A DAY notices that just as well for a day-granular consumer.
 *
 * ── THE RESIDUAL, STATED RATHER THAN HIDDEN ────────────────────────────────────────────────
 *
 * `ageDaysOf` returns a FLOAT (`(now - parsed) / 86_400_000`), so a rebuild at a day boundary computes
 * `ageDays` a few minutes larger than a rebuild at 00:01 would. That difference is invisible to every
 * consumer (all of them compare against integer day thresholds: 14 for staleness, 30 for unknown), and
 * the cache is per-process, so the worst case is that two live processes disagree about `ageDays` by
 * less than one day. That is the same granularity the design already claims.
 */
export interface CachedDocuments<T> {
  key: string
  docs: T[]
}

const cache = new Map<string, CachedDocuments<unknown>>()

/** One cache day. Longer than an hour on purpose — see the measurement above. */
const DAY_MS = 86_400_000

export function skillDocsKey(dirMtimeMs: number, now: number): string {
  return `${dirMtimeMs}|${Math.floor(now / DAY_MS)}`
}

export function getCachedSkillDocs<T>(skillsDir: string, key: string): T[] | undefined {
  const entry = cache.get(skillsDir)
  if (entry === undefined || entry.key !== key) return undefined
  return entry.docs as T[]
}

export function setCachedSkillDocs<T>(skillsDir: string, key: string, docs: T[]): void {
  cache.set(skillsDir, { key, docs: docs as unknown[] })
}

/** Drop one directory's cache. Every SKILL.md writer calls this. */
export function invalidateSkillDocs(skillsDir?: string): void {
  if (skillsDir === undefined) cache.clear()
  else cache.delete(skillsDir)
}

export function skillDocsCacheStats(): { entries: number } {
  return { entries: cache.size }
}
