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
 *  - Implicit: the key carries the directory mtime (covers add/remove) and the current hour
 *    (covers an in-place edit by a process that does not call the invalidation).
 *
 * The hour is a coarse net, not the primary mechanism. It exists so that a foreign writer
 * that never announces itself can still be noticed, and it is safe because every field
 * derived from `now` in this store is day-granular.
 */
export interface CachedDocuments<T> {
  key: string
  docs: T[]
}

const cache = new Map<string, CachedDocuments<unknown>>()

export function skillDocsKey(dirMtimeMs: number, now: number): string {
  return `${dirMtimeMs}|${Math.floor(now / 3_600_000)}`
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
