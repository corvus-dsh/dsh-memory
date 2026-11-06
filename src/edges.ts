import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * v1.0.0 P0 — EDGE STORAGE LAYER
 *
 * THE PROBLEM THIS REPLACES
 *
 * Conflicts used to be embedded in SKILL.md itself: one `conflicts_with:` line holding
 * every neighbor, plus a `## ⚠️ 冲突提示` section repeating them as prose. Adding one edge
 * therefore rewrote a whole existing file, and since the file also GREW with each edge,
 * writing N skills cost O(N²) file IO over files that got bigger as they went. Measured:
 * 5.3 ms/skill at N=50 rising to 103.7 ms/skill at N=400 (growth exponent k=2.43).
 *
 * THE SHAPE NOW
 *
 * One append-only text file per skills directory: `skills-edges.jsonl`, one `a,b` per line,
 * canonical order (smaller name first). Appending one edge is O(1) and never touches a
 * SKILL.md. The read side loads the whole index once and caches it in memory.
 *
 * WHY AN IN-MEMORY SET IS NOT OPTIONAL
 *
 * The first version of this file did `readFileSync` + `writeFileSync` per edge to check for
 * duplicates. That is the SAME quadratic shape one layer down — every append re-reads the
 * entire index. It would have reproduced the bug with a different filename. The cache below
 * is what actually makes the write O(1); the file is only the durable copy.
 *
 * COMPATIBILITY
 *
 * Stores written before v1.0.0 still carry `conflicts_with:` inside SKILL.md. `migrateLegacyEdges`
 * reads those once and appends them here. Nothing deletes the old field — a stale hint is
 * harmless, and rewriting every legacy file to remove it is exactly the mass-rewrite this
 * change exists to stop.
 */

const FILE_NAME = 'skills-edges.jsonl'

/** dir → set of canonical "a,b" keys. Process-local; the file is the source of truth. */
const cache = new Map<string, Set<string>>()

function fileNameOf(dir: string): string {
  return join(dir, FILE_NAME)
}

function canonical(aName: string, bName: string): string {
  return aName < bName ? `${aName},${bName}` : `${bName},${aName}`
}

function loadInto(dir: string): Set<string> {
  const cached = cache.get(dir)
  if (cached !== undefined) return cached
  const keys = new Set<string>()
  const path = fileNameOf(dir)
  try {
    const text = readFileSync(path, 'utf8')
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      const comma = trimmed.indexOf(',')
      if (comma <= 0) continue
      keys.add(canonical(trimmed.slice(0, comma), trimmed.slice(comma + 1)))
    }
  } catch {
    // A missing index is an empty index, not an error.
  }
  cache.set(dir, keys)
  return keys
}

/** Append one edge. Idempotent within the process and across restarts. */
export function writeEdge(skillsDir: string, aName: string, bName: string): void {
  if (aName === bName) return
  const keys = loadInto(skillsDir)
  const key = canonical(aName, bName)
  if (keys.has(key)) return
  mkdirSync(skillsDir, { recursive: true })
  appendFileSync(fileNameOf(skillsDir), `${key}\n`, 'utf8')
  keys.add(key)
}

/** Append many edges with ONE open/close. Returns how many were actually new. */
export function writeEdges(skillsDir: string, pairs: ReadonlyArray<readonly [string, string]>): number {
  const keys = loadInto(skillsDir)
  const fresh: string[] = []
  for (const [left, right] of pairs) {
    if (left === right) continue
    const key = canonical(left, right)
    if (keys.has(key)) continue
    keys.add(key)
    fresh.push(key)
  }
  if (fresh.length === 0) return 0
  mkdirSync(skillsDir, { recursive: true })
  appendFileSync(fileNameOf(skillsDir), `${fresh.join('\n')}\n`, 'utf8')
  return fresh.length
}

export function readEdges(skillsDir: string): Array<[string, string]> {
  const keys = loadInto(skillsDir)
  return [...keys].map((key) => {
    const comma = key.indexOf(',')
    return [key.slice(0, comma), key.slice(comma + 1)] as [string, string]
  })
}

export function hasEdge(skillsDir: string, aName: string, bName: string): boolean {
  return loadInto(skillsDir).has(canonical(aName, bName))
}

export function getNeighbors(skillsDir: string, name: string): string[] {
  const out = new Set<string>()
  for (const key of loadInto(skillsDir)) {
    const comma = key.indexOf(',')
    const left = key.slice(0, comma)
    const right = key.slice(comma + 1)
    if (left === name) out.add(right)
    else if (right === name) out.add(left)
  }
  return [...out]
}

/** Edge count, for stats and tests. */
export function edgeCount(skillsDir: string): number {
  return loadInto(skillsDir).size
}

/** Drop the in-memory view. The FILE is untouched — call this after external edits. */
export function invalidateEdgeCache(skillsDir?: string): void {
  if (skillsDir === undefined) cache.clear()
  else cache.delete(skillsDir)
}

/** Remove every edge involving `name` (used when a skill is deleted). Rewrites the index once. */
export function removeEdgesFor(skillsDir: string, name: string): number {
  const keys = loadInto(skillsDir)
  const kept = [...keys].filter((key) => {
    const comma = key.indexOf(',')
    return key.slice(0, comma) !== name && key.slice(comma + 1) !== name
  })
  const removed = keys.size - kept.length
  if (removed === 0) return 0
  cache.set(skillsDir, new Set(kept))
  writeFileSync(fileNameOf(skillsDir), kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8')
  return removed
}

/** Rewrite the whole index from a precomputed pair list (bulk rebuild only). */
export function replaceEdges(skillsDir: string, pairs: ReadonlyArray<readonly [string, string]>): number {
  const keys = new Set<string>()
  for (const [left, right] of pairs) {
    if (left === right) continue
    keys.add(canonical(left, right))
  }
  mkdirSync(skillsDir, { recursive: true })
  writeFileSync(fileNameOf(skillsDir), keys.size === 0 ? '' : `${[...keys].join('\n')}\n`, 'utf8')
  cache.set(skillsDir, keys)
  return keys.size
}

/**
 * Read `conflicts_with:` out of every legacy SKILL.md and fold those edges into the index.
 *
 * Deliberately does NOT strip the field from the files: rewriting every legacy SKILL.md is
 * the mass-write this whole layer exists to avoid, and a duplicated hint is not harmful.
 * Returns the number of NEW edges added.
 */
export function migrateLegacyEdges(skillsDir: string): number {
  const pairs: Array<[string, string]> = []
  let entries
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(skillsDir, entry.name, 'SKILL.md')
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const line = text.match(/^conflicts_with:\s*(.+)$/mu)?.[1]
    if (line === undefined || line.length === 0) continue
    for (const other of line.split(/[,\s]+/u).map((item) => item.trim()).filter(Boolean)) {
      pairs.push([entry.name, other])
    }
  }
  return writeEdges(skillsDir, pairs)
}
