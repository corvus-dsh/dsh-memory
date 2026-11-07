/**
 * Dedupe gates for capability memory.
 *
 * Four gates, from hardest to softest (the user approved this order):
 *   ① name — a SKILL.md name IS the identity; same kebab name = same skill
 *   ② normalized exact — strip punctuation/whitespace/parentheticals, then compare
 *   ③ Jaccard on 3-grams of `when` — catches "换了说法但同一个方法"
 *   ④ conflict — same symptom with a different cause: keep BOTH and link them
 *
 * GATE ② DOES **NOT** STRIP DIGITS. It used to, and that merged `端口 3000 被占用` with
 * `端口 8080 被占用` — see the note on `normalizeForMatch`.
 *
 * Gate ④ matters most for negative paths: two different causes for one symptom
 * is information, not duplication. Silently merging them would teach a wrong fix.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * NORMALISE FOR EXACT MATCH — and the two-digit rule that used to live here was a data-loss bug.
 *
 * WHAT CHANGED, AND WHY IT MATTERED
 *
 * This function used to end with `.replace(/[0-9]+/gu, '')`, stripping EVERY digit. The intent was
 * defensible (`v7.4` and `v7.5` are the same skill, `seq=12` is noise), but the consequence was not:
 *
 *     端口 3000 被占用   →  端口被占用
 *     端口 8080 被占用   →  端口被占用      ← identical, so `planNegative` called them duplicates
 *
 * The second lesson was then silently dropped — a WRITE-PATH data loss with no warning. Measured while
 * looking for a concurrency bug: a fixture using `symptom + index` lost N-1 rows at every concurrency,
 * because all the fixtures normalised to the same string.
 *
 * WHAT REPLACES IT: digits are KEPT as part of the normalised token stream. Two strings still match when
 * their digits agree; `3000` and `8080` no longer do. The version-noise case is handled where it belongs —
 * a parenthetical or bracketed version is removed by the rule above (`（v7.4）`), which is a SHAPE, not a
 * blanket "all numbers are noise".
 *
 * WHAT IS STILL STRIPPED: punctuation, whitespace, parentheticals. Those are formatting.
 *
 * A NOTE ON WHY "JUST STRIP VERSION-SHAPED NUMBERS" WAS REJECTED: recognising a version in free text needs
 * a grammar (`v?1.2.3`, `#42`, `2026-11-06`), and getting that grammar wrong in either direction is a
 * silent failure — either two distinct symptoms merge, or two spellings of one symptom split. Keeping the
 * digits and removing only the parenthetical is the rule whose failure mode is VISIBLE (a missed dedupe
 * shows up as two rows; a wrong merge shows up as one row that should be two).
 */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    /** A bracketed aside is commentary — `改动迁移（v7.4）逻辑` and `改动迁移逻辑` are the same claim. */
    .replace(/[（(][^）)]*[）)]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * ONE FUNCTION, ONE QUESTION. There is no digit-ignoring variant, and that is deliberate.
 *
 * The first draft of this fix added a `normalizeIgnoringDigits()` "for the skill-name gate" — and then a
 * grep showed the skill-name gate does not use normalisation at all: gate ① compares the KEBAB NAME
 * exactly, because a name IS the identity. The helper had zero call sites.
 *
 * Deleting it is the right outcome, and worth recording: a second function that exists "in case something
 * needs it" is how the original bug happened — one normaliser silently answering two different questions.
 */

export function trigrams(text: string): Set<string> {
  const normalized = normalizeForMatch(text)
  const out = new Set<string>()
  if (normalized.length === 0) return out
  const padded = `  ${normalized} `
  for (let index = 0; index + 3 <= padded.length; index += 1) out.add(padded.slice(index, index + 3))
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) if (b.has(item)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * ENTITY ALIASES — one name for one thing, so the causal graph stays connected
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * THE PROBLEM THIS SOLVES, MEASURED
 *
 * `recursiveCausalChain` matches edges by the STRING in `cause` / `effect`. So a memory that says
 * `prod-db` and another that says `生产数据库` are two unrelated nodes, and the chain that runs
 * through both of them stops at the boundary. From the outside that looks like "the graph is
 * shallow" when the graph is fine — the names are not.
 *
 * WHY AN ALIAS TABLE AND NOT REAL ENTITY RESOLUTION
 *
 * General entity resolution (NER + coreference + clustering) needs a model, a training set and a
 * false-merge budget. This store needs something much narrower: "these two strings mean the same
 * machine". A declared table is auditable, has zero false-positive rate for the entries a human
 * wrote, and covers the failures that actually occur — the same subsystem named in Chinese in one
 * session and in English in another.
 *
 * THE HONEST LIMIT: an alias table only knows what it was told. It closes the gap the operator
 * observed; it does not discover new aliases. Discovered aliases are a different feature, and
 * conflating the two would make this look more capable than it is.
 */
export interface EntityAliases {
  /** Canonical name → every other spelling that means it. */
  readonly groups: ReadonlyArray<{ readonly canonical: string; readonly aliases: readonly string[] }>
}

/**
 * The default table. Deliberately SMALL and deliberately editable.
 *
 * Every entry is a pair an operator actually hit. Adding a speculative entry costs a wrong merge
 * later, so the bar is "this has caused a broken chain", not "this might be the same thing".
 */
export const DEFAULT_ENTITY_ALIASES: EntityAliases = {
  groups: [
    { canonical: 'prod-db', aliases: ['生产数据库', '生产库', '线上数据库', 'prod database', 'proddb', '生产 db'] },
    { canonical: 'staging-db', aliases: ['预发数据库', '预发库', 'staging database', 'stagingdb'] },
    { canonical: 'deploy', aliases: ['部署', '发版', '发布', 'deployment'] },
    { canonical: 'build', aliases: ['构建', '编译', 'compilation'] },
    { canonical: 'boundary-seq', aliases: ['boundaryseq', '边界序号', '边界 seq', 'boundary sequence'] },
    { canonical: 'source-drift', aliases: ['源漂移', '源码漂移', 'source drift'] },
  ],
}

/** Lowercase, strip punctuation, collapse whitespace — the form aliases are compared in. */
function aliasKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s_\-./\\]+/gu, '')
    .trim()
}

/** One compiled lookup, built once per table. Rebuilt per call would be O(N) per comparison. */
function compileAliases(aliases: EntityAliases): Map<string, string> {
  const map = new Map<string, string>()
  for (const group of aliases.groups) {
    map.set(aliasKey(group.canonical), group.canonical)
    for (const alias of group.aliases) map.set(aliasKey(alias), group.canonical)
  }
  return map
}

const compileCache = new WeakMap<EntityAliases, Map<string, string>>()

function lookupOf(aliases: EntityAliases): Map<string, string> {
  const cached = compileCache.get(aliases)
  if (cached !== undefined) return cached
  const compiled = compileAliases(aliases)
  compileCache.set(aliases, compiled)
  return compiled
}

/**
 * Rewrite every known alias in `text` to its canonical name.
 *
 * LONGEST MATCH FIRST, and that is not a detail: `生产 db` contains `生产`, and `prod-db` contains
 * `prod`. Replacing the short form first would produce `prod-canonical-db` and corrupt the string
 * it was supposed to fix.
 */
export function canonicalizeEntities(text: string, aliases: EntityAliases = DEFAULT_ENTITY_ALIASES): string {
  if (text.length === 0) return text
  const lookup = lookupOf(aliases)
  if (lookup.size === 0) return text
  /** Every spelling, longest first, so a longer alias claims its span before a shorter one. */
  const spellings = [...lookup.keys()].sort((left, right) => right.length - left.length)
  let out = text
  for (const spelling of spellings) {
    if (spelling.length === 0) continue
    const canonical = lookup.get(spelling)
    if (canonical === undefined) continue
    /**
     * MATCH ON A NORMALISED VIEW, REPLACE ON THE ORIGINAL.
     *
     * A direct string replace would miss `Production DB` for the alias `productiondb`. So the text
     * is normalised with an index map back to the original, and each accepted match is rewritten
     * in place.
     */
    const { normalized, positions } = normalizeWithMap(out)
    let result = ''
    let cursor = 0
    let searchFrom = 0
    for (;;) {
      const found = normalized.indexOf(spelling, searchFrom)
      if (found === -1) break
      const startOriginal = positions[found]
      const endOriginal = positions[found + spelling.length - 1] + 1
      if (startOriginal === undefined || endOriginal === undefined) break
      result += out.slice(cursor, startOriginal) + canonical
      cursor = endOriginal
      searchFrom = found + spelling.length
    }
    if (cursor > 0) out = result + out.slice(cursor)
  }
  return out
}

/**
 * Normalise for alias matching while keeping a map back to the original offsets.
 *
 * The map has one entry per character of `normalized`, holding its index in `source`. That is what
 * makes a case-insensitive, punctuation-insensitive match rewriteable in the original text.
 */
function normalizeWithMap(source: string): { normalized: string; positions: number[] } {
  let normalized = ''
  const positions: number[] = []
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index].toLowerCase()
    /** Same character class the alias keys drop: whitespace, separators and punctuation. */
    if (/[\s_\-./\\]/u.test(char)) continue
    normalized += char
    positions.push(index)
  }
  return { normalized, positions }
}

/**
 * Are these two names the same entity under the alias table?
 *
 * Used by the causal walk to decide whether two pointer strings may join. Exported separately from
 * `canonicalizeEntities` because a caller sometimes needs the QUESTION answered without rewriting
 * the text it is holding.
 */
export function sameEntity(left: string, right: string, aliases: EntityAliases = DEFAULT_ENTITY_ALIASES): boolean {
  if (aliasKey(left) === aliasKey(right)) return true
  const lookup = lookupOf(aliases)
  const leftCanonical = lookup.get(aliasKey(left)) ?? left
  const rightCanonical = lookup.get(aliasKey(right)) ?? right
  return aliasKey(leftCanonical) === aliasKey(rightCanonical)
}

export interface SkillCandidate {
  name: string
  when: string
  /** 1 when the normalized `when` is identical, else Jaccard of 3-grams. */
  similarity: number
  exact: boolean
}

function readWhen(path: string): string {
  try {
    const text = readFileSync(path, 'utf8')
    // v0.2.0 writes `when_to_use`; legacy files still carry `when`.
    return text.match(/^(?:when_to_use|when):\s*(.+)$/mu)?.[1] ?? ''
  } catch {
    return ''
  }
}

/** The closest existing skill, or undefined when nothing is remotely similar. */
export function findSkillCandidate(skillsDir: string, when: string, threshold = 0.85): SkillCandidate | undefined {
  const target = normalizeForMatch(when)
  const grams = trigrams(when)
  let best: SkillCandidate | undefined
  let names: string[] = []
  try {
    names = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return undefined
  }
  for (const name of names) {
    const existingWhen = readWhen(join(skillsDir, name, 'SKILL.md'))
    if (existingWhen.length === 0) continue
    if (normalizeForMatch(existingWhen) === target) return { name, when: existingWhen, similarity: 1, exact: true }
    const score = jaccard(grams, trigrams(existingWhen))
    if (score >= threshold && (best === undefined || score > best.similarity)) {
      best = { name, when: existingWhen, similarity: score, exact: false }
    }
  }
  return best
}

export interface NegativeRecord {
  symptom: string
  cause: string
  avoid: string
  evidence: number[]
  conflictsWith?: number[]
}

export interface NegativePlan {
  /** Indexes of existing negatives that share the symptom but differ in cause. */
  conflicts: number[]
  /** Whether an identical (symptom + cause) entry already exists. */
  duplicate: boolean
}

/** Gate ②+④ for negative paths: exact duplicate vs. same-symptom-different-cause. */
export function planNegative(existing: readonly NegativeRecord[], candidate: NegativeRecord): NegativePlan {
  const symptom = normalizeForMatch(candidate.symptom)
  const cause = normalizeForMatch(candidate.cause)
  const conflicts: number[] = []
  let duplicate = false
  existing.forEach((record, index) => {
    const sameSymptom = normalizeForMatch(record.symptom) === symptom
    if (!sameSymptom) return
    if (normalizeForMatch(record.cause) === cause) duplicate = true
    else conflicts.push(index)
  })
  return { conflicts, duplicate }
}