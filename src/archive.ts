/**
 * v0.21 P1 — skill ARCHIVAL, so the store cannot grow without bound.
 *
 * THE PROBLEM
 *
 * Harvest mines every finished session, and a busy week produces dozens of skills.
 * Retrieval is lexical-first with an LLM adjudicator, so a large store does not fail
 * loudly — it fails QUIETLY: the adjudicator sees more candidates, the lexical
 * denominator grows, and the skill that actually applied competes with twenty that
 * almost did. Meanwhile a hundred distinct "how to fix this one error" skills are all
 * still "active" because nothing ever retires them.
 *
 * THE RULE
 *
 * When the ACTIVE skill count crosses a threshold, run ONE maintenance pass:
 *
 *   1. merge skills whose `when_to_use` is semantically near-identical (same scene,
 *      same workspace, high token overlap) — merging keeps the union of evidence, so
 *      it loses nothing;
 *   2. if merging did not get under the threshold, ARCHIVE the least-recently-used
 *      10%: set `invalid_at` far in the future? No — a real `archived: true` mark that
 *      retrieval skips and that a human can undo.
 *
 * Deliberately NOT a delete: an archived skill is a cost (it stops being injected),
 * not a loss (its file, evidence and provenance stay).
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** TD-M6：合并相似度只有一个出处。这里 import + re-export，公开面不变。 */
import { MERGE_SIMILARITY } from './thresholds.js'
export { MERGE_SIMILARITY }

/**
 * TD-M1: the merge half lives in the store, because it owns evidence unions, the conflict index
 * and provenance. This module owns the POLICY (what to merge, what to archive); the store owns
 * the WRITE. Importing one function from the store barrel keeps that boundary while making the
 * plan actionable — and `store.js` does not import this file, so the direction stays acyclic.
 */
import { mergeSkills } from './store.js'

/** Default threshold: past this many ACTIVE skills, one pass runs. */
export const DEFAULT_SKILL_LIMIT = 100
/** Fraction of the least-recently-used skills archived when merging cannot help. */
export const ARCHIVE_FRACTION = 0.1

export interface SkillSummary {
  name: string
  when: string
  scene: string
  workspace: string
  /** ISO stamp of the last injection, or '' when never used. */
  lastUsed: string
  archived: boolean
  path: string
}

export interface ArchivePlan {
  total: number
  active: number
  /** Skills that would be merged away, as [absorbed, keptInto] pairs. */
  merges: Array<{ absorbed: string; keptInto: string }>
  /** Skills that would be archived, least-recently-used first. */
  archive: string[]
  /** True when the store is under the limit and nothing would happen. */
  underLimit: boolean
}

function field(text: string, key: string): string {
  return (text.match(new RegExp(`^${key}:\\s*(.+)$`, 'mu'))?.[1] ?? '').trim()
}

export function listSkillSummaries(skillsDir: string): SkillSummary[] {
  let names: string[] = []
  try {
    names = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const out: SkillSummary[] = []
  for (const name of names) {
    const path = join(skillsDir, name, 'SKILL.md')
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    out.push({
      name,
      when: field(text, 'when_to_use') || field(text, 'when'),
      scene: (field(text, 'scene') || 'general').toLowerCase(),
      workspace: field(text, 'workspace'),
      lastUsed: field(text, 'last_used'),
      archived: field(text, 'archived') === 'true',
      path,
    })
  }
  return out
}

/**
 * v0.21: Jaccard similarity of two `when_to_use` clauses.
 *
 * CJK is tokenized as bigrams, which inflates overlap for short Chinese phrases:
 * "处理编号 0 的独立任务时" and "处理编号 1 的独立任务时" share almost every bigram and
 * scored as duplicates in the first draft. Two guards against that:
 *
 *   1. LATIN words weigh double a CJK bigram. A shared identifier (`pymysql`,
 *      `frontmatter`, `when_to_use`) is strong evidence of the same trigger; a shared
 *      common bigram (的独, 立任) is not.
 *   2. A clause shorter than `MIN_COMPARABLE_TOKENS` returns 0: with four tokens even
 *      one accidental match clears a Jaccard threshold, so short triggers are never
 *      merged automatically. Merging is destructive-if-wrong; refusing to merge a
 *      genuinely duplicate short trigger costs one extra candidate.
 */
const MIN_COMPARABLE_TOKENS = 6

function whenTokens(text: string): { latin: Set<string>; cjk: Set<string> } {
  const lower = text.toLowerCase()
  const latin = new Set<string>()
  const cjk = new Set<string>()
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9_-]{1,}/gu)) latin.add(match[0])
  for (const run of lower.match(/[\u4e00-\u9fff]+/gu) ?? []) {
    for (let index = 0; index + 2 <= run.length; index += 1) cjk.add(run.slice(index, index + 2))
  }
  return { latin, cjk }
}

export function whenSimilarity(left: string, right: string): number {
  const a = whenTokens(left)
  const b = whenTokens(right)
  // Two identical triggers are duplicates regardless of how short they are. The
  // length guard below exists only to stop ACCIDENTAL matches on short phrases.
  if (left.trim().length > 0 && left.trim().toLowerCase() === right.trim().toLowerCase()) return 1
  const sizeOf = (set: { latin: Set<string>; cjk: Set<string> }): number => set.latin.size * 2 + set.cjk.size
  if (sizeOf(a) < MIN_COMPARABLE_TOKENS || sizeOf(b) < MIN_COMPARABLE_TOKENS) return 0
  // A shared NUMERAL is not shared meaning: "处理编号 0 的任务" and "处理编号 1 的任务"
  // describe different tasks with identical syntax. If the only difference between two
  // clauses is the digits, they are not duplicates.
  const stripDigits = (text: string): string => text.replace(/[0-9]+/gu, '#')
  if (stripDigits(left.toLowerCase()) === stripDigits(right.toLowerCase())) return 0
  let shared = 0
  for (const token of a.latin) if (b.latin.has(token)) shared += 2
  for (const token of a.cjk) if (b.cjk.has(token)) shared += 1
  const union = sizeOf(a) + sizeOf(b) - shared
  return union === 0 ? 0 : shared / union
}

/**
 * v0.21: decide what a maintenance pass would do, WITHOUT doing it.
 *
 * Pure over the summaries, so the policy is testable and the caller (activation, or a
 * tool) only has to apply the plan.
 */
export function planSkillArchive(
  summaries: readonly SkillSummary[],
  limit = DEFAULT_SKILL_LIMIT,
  mergeThreshold = MERGE_SIMILARITY,
): ArchivePlan {
  const active = summaries.filter((summary) => !summary.archived)
  const plan: ArchivePlan = { total: summaries.length, active: active.length, merges: [], archive: [], underLimit: true }
  if (active.length <= limit) return plan
  plan.underLimit = false

  // 1. MERGE first: it is the only option that preserves every skill.
  //
  // Only same scene AND same workspace are candidates: two skills that answer the same
  // trigger in DIFFERENT projects are not duplicates, and merging them would move one
  // project's method into the other's memory.
  const claimed = new Set<string>()
  const ordered = [...active].sort((left, right) => left.name.localeCompare(right.name))
  for (let i = 0; i < ordered.length; i += 1) {
    const keeper = ordered[i]
    if (claimed.has(keeper.name)) continue
    for (let j = i + 1; j < ordered.length; j += 1) {
      const other = ordered[j]
      if (claimed.has(other.name)) continue
      if (other.scene !== keeper.scene || other.workspace !== keeper.workspace) continue
      if (whenSimilarity(keeper.when, other.when) < mergeThreshold) continue
      plan.merges.push({ absorbed: other.name, keptInto: keeper.name })
      claimed.add(other.name)
    }
  }

  // 2. If merging is not enough, archive the least-recently-used 10% of what remains.
  //
  // "Least recently used" sorts never-used (lastUsed '') FIRST: a skill that has never
  // been injected is the cheapest to stop injecting. Ties break by name so the pass is
  // deterministic — an archive pass that picks randomly is impossible to audit.
  const survivors = active.filter((summary) => !claimed.has(summary.name))
  const stillOver = survivors.length - plan.merges.length
  if (stillOver > limit) {
    const need = stillOver - limit
    const byAge = [...survivors].sort((left, right) => {
      if (left.lastUsed === right.lastUsed) return left.name.localeCompare(right.name)
      if (left.lastUsed === '') return -1
      if (right.lastUsed === '') return 1
      return left.lastUsed.localeCompare(right.lastUsed)
    })
    const quota = Math.max(need, Math.ceil(survivors.length * ARCHIVE_FRACTION))
    plan.archive = byAge.slice(0, Math.min(quota, byAge.length)).map((summary) => summary.name)
  }
  return plan
}

/**
 * v0.21: apply a plan — MERGE first, then archive.
 *
 * ── TD-M1: THE MERGE HALF NOW RUNS (2026-11-18) ───────────────────────────────────────────────
 *
 * Until this change the plan's `merges` were only REPORTED: the archive pass archived the
 * least-recently-used skills while the near-duplicate pairs it had identified stayed on disk,
 * which meant the first line of defence against an unbounded store never fired at all.
 *
 * ORDER IS THE POINT. Merging runs BEFORE archiving, and both read the plan computed on the
 * pre-merge store: `plan.archive` was chosen from the SURVIVORS of merging (see
 * `planSkillArchive`), so a keeper can never also be archived in the same pass. The counter
 * returned here is the number of merges that actually landed, not the number proposed — a
 * skipped pair (a missing file, an invalidated absorbed skill) must not be counted as done.
 *
 * `memoryDir` is optional so existing callers keep working; when present, each merge writes an
 * audit line. A merge that cannot reach the audit ledger still merges — the audit is evidence,
 * never a gate (same rule as `appendMemoryAudit`).
 */
export function applySkillArchive(
  skillsDir: string,
  plan: ArchivePlan,
  options: { memoryDir?: string; at?: string } = {},
): { archived: string[]; merged: number } {
  let merged = 0
  for (const pair of plan.merges) {
    try {
      const result = mergeSkills(skillsDir, pair.keptInto, pair.absorbed, options)
      if (result.ok) merged += 1
    } catch {
      /** One bad pair must not stop the pass; the next activation retries it. */
    }
  }
  const archived: string[] = []
  for (const name of plan.archive) {
    const path = join(skillsDir, name, 'SKILL.md')
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const next = /^archived:/mu.test(text)
      ? text.replace(/^archived:.*$/mu, 'archived: true')
      : text.replace(/^(name:.*)$/mu, '$1\narchived: true')
    try {
      writeFileSync(path, next, 'utf8')
      archived.push(name)
    } catch {
      // A skill that cannot be written stays active; the next pass retries.
    }
  }
  return { archived, merged }
}

/** Is this record archived, according to its own frontmatter? */
export function isArchivedSkill(text: string): boolean {
  return /^archived:\s*true\s*$/mu.test(text)
}
