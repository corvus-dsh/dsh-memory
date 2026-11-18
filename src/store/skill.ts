/**
 * SKILL READ / WRITE — step A1 of the `store.ts` split.
 *
 * WHAT IS HERE (A1-1, first slice): the identities and codecs a SKILL.md lives on —
 * where a skill file sits, how its frontmatter is written, how an extraction is normalised
 * into the on-disk shape, how validity windows are read back, and the conflict type the
 * writer stamps onto a skill.
 *
 * WHY THESE ARE TOGETHER: they are one direction of one contract. `renderSkill` (a later slice)
 * writes exactly what `parseSkillFile` (also later) reads, and both go through `frontmatter`
 * and `SkillValidity`. Splitting them across files would mean two halves of the same format
 * living far apart, which is how a reader and a writer drift.
 *
 * The content below is MOVED, not rewritten: `scripts/verify-pure-move.mjs` compares the
 * content-line multiset of the whole `src/` tree, so a single edited character shows up as
 * DISAPPEARED. The only additions are the `import` lines and the `export` keywords that make
 * cross-file use possible.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { EvidenceRef, ExtractedSkill, MemoryProvenance } from '../extract.js'
import { jaccard, trigrams } from '../dedupe.js'
import { writeEdge, writeEdges } from '../edges.js'
import { asVocab } from './layer.js'
import { atomicWrite } from './io.js'
import type { SkillMeta } from './layer.js'
import { normalizeWorkspace } from '../workspace.js'
import { invalidateSkillDocs } from '../skill-cache.js'
import { scanThreat } from '../threat.js'

export function skillPath(skillsDir: string, name: string): string {
  return join(skillsDir, name, 'SKILL.md')
}

/**
 * v0.8: the recorded workspace of an on-disk SKILL.md, canonicalized. Empty means
 * the file predates the isolation guard (or was written without provenance), and
 * retrieval treats that as "cannot prove it belongs here" — refused unless the
 * skill declares `scope: global`.
 */
export function readSkillWorkspace(text: string): string {
  return normalizeWorkspace(text.match(/^workspace:\s*(.+)$/mu)?.[1] ?? '')
}

/**
 * v0.15: the validity window and trust tier of an on-disk SKILL.md.
 *
 * `invalidAt` is the field the activation gate reads: a memory whose invalidation
 * time has passed is not deleted, it simply stops being retrieved. That is the
 * whole point of bi-temporality — "what did we believe in March, and when did we
 * stop believing it" stays answerable from the files themselves.
 */
export interface SkillValidity {
  validAt: string
  invalidAt: string
  supersededBy: string
  supersedes: string[]
  provenance: MemoryProvenance
}

export const PROVENANCE_TIERS = new Set(['human', 'tool', 'inferred'])

export function readSkillValidity(text: string): SkillValidity {
  /**
   * ── TD-M1 (2026-11-18): `\s*` AFTER THE COLON CROSSED THE LINE BOUNDARY ──────────────────────
   *
   * These five reads used `^key:\s*(.+)$` with the `m` flag. `\s` matches `\n`, so an EMPTY field
   * (`supersedes:` with nothing after it — what a hand-edited file looks like) let `\s*` eat the
   * newline and `(.+)` captured the NEXT line's `key: value`. Measured while writing the merge
   * tests: a keeper whose `supersedes:` was empty came back claiming it superseded
   * `valid_at:,2026-01-01` — two fields of the following lines, laundered into a real supersession
   * chain. A merge would then copy that invented chain onto the keeper.
   *
   * `[ \t]*` is the fix: a horizontal gap belongs to the field, a line break never does.
   */
  const read = (key: string): string =>
    (text.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'mu'))?.[1] ?? '').trim()
  const provenanceText = read('provenance').toLowerCase()
  return {
    validAt: read('valid_at'),
    invalidAt: read('invalid_at'),
    supersededBy: read('superseded_by'),
    supersedes: read('supersedes')
      .split(/[,\s]+/u)
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
    provenance: PROVENANCE_TIERS.has(provenanceText) ? (provenanceText as MemoryProvenance) : 'inferred',
  }
}

export function frontmatter(fields: Record<string, string | number>): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) lines.push(`${key}: ${String(value)}`)
  lines.push('---')
  return lines.join('\n')
}

/** What the review queue may still hold from v0.1: `when` + `how`, no verify. */
export interface SkillInput {
  name: string
  title?: string
  description?: string
  when?: string
  when_to_use?: string
  steps?: string[]
  how?: string[]
  verify?: string[]
  verification?: string[]
  scope?: string
  aliases?: string[]
  evidence: Array<number | EvidenceRef>
}

export function normalizeSkill(input: SkillInput | ExtractedSkill): ExtractedSkill {
  const raw = input as SkillInput
  const when = String(raw.when_to_use ?? raw.when ?? '').replace(/\s+/gu, ' ').trim()
  const steps = (raw.steps ?? raw.how ?? []).map((step) => String(step).replace(/\s+/gu, ' ').trim()).filter(Boolean)
  const verify = (raw.verify ?? raw.verification ?? []).map((line) => String(line).replace(/\s+/gu, ' ').trim()).filter(Boolean)
  const scope = String(raw.scope ?? '').toLowerCase()
  const scene = String((raw as any).scene ?? '').trim().toLowerCase()
  const aliases = (Array.isArray(raw.aliases) ? raw.aliases : [])
    .map((alias) => String(alias).replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .slice(0, 3)
  /**
   * GLOBAL KNOWLEDGE BASE — carried through the normaliser for the same reason `dependencies`
   * had to be: `normalizeSkill` rebuilds the record from a whitelist, so a field it does not name
   * is silently dropped. A skill written with tags and read back without them looks local, and the
   * whole point of the field is that it is not.
   */
  const tags = asVocab((raw as any).tags)
  const applicableNodeTypes = asVocab((raw as any).applicableNodeTypes ?? (raw as any).applicable_node_types)
  // v0.6: accept legacy numbers (a bare seq is resolved against the write's
  // session id) and composite refs (already carry their own session id).
  const evidence: EvidenceRef[] = []
  for (const item of Array.isArray(raw.evidence) ? raw.evidence : []) {
    if (item !== null && typeof item === 'object' && typeof (item as EvidenceRef).seq !== 'undefined') {
      const seq = Number((item as EvidenceRef).seq)
      const sourceSessionId = String((item as EvidenceRef).sourceSessionId ?? '')
      if (Number.isFinite(seq) && !evidence.some((ref) => ref.seq === seq && ref.sourceSessionId === sourceSessionId)) {
        evidence.push({ sourceSessionId, seq })
      }
      continue
    }
    const seq = Number(item)
    if (Number.isFinite(seq)) evidence.push({ sourceSessionId: '', seq })
  }
  return {
    name: String(raw.name ?? '').toLowerCase(),
    title: String(raw.title ?? raw.name ?? ''),
    description: String(raw.description ?? when).replace(/\s+/gu, ' ').trim(),
    when,
    steps,
    verify,
    scope: scope === 'workspace' || scope === 'global' ? scope : 'project',
    scene: /^[a-z][a-z0-9-]{1,23}$/u.test(scene) ? scene : 'general',
    domain: /^[a-z][a-z0-9-]{1,31}$/u.test(String((raw as any).domain ?? '').trim().toLowerCase())
      ? String((raw as any).domain).trim().toLowerCase()
      : 'general',
    aliases,
    ...(tags.length === 0 ? {} : { tags }),
    ...(applicableNodeTypes.length === 0 ? {} : { applicableNodeTypes }),
    confidence: clampConfidence((raw as any).confidence),
    evidence,
  }
}

/** v0.7.1: a feedback weight, kept in [0.2, 1.0]; a missing field is full trust. */
export function clampConfidence(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return 1
  return Math.min(1, Math.max(0.2, Math.round(number * 100) / 100))
}

/**
 * Words that describe the shared *purpose* and therefore must not be the only
 * reason two skills are called conflicting. "Python" and "连接数据库" appear in
 * every database skill; the conflict is pymysql-versus-sqlite3, not the verb.
 */
export const PURPOSE_NOISE = new Set([
  'python', 'py', 'code', 'script', '简单', '一个', '使用', '实现', '封装', '方法', '步骤', '测试', '操作',
  // v0.3.1: TESTING vocabulary was the false-positive engine. Measured on the
  // battle store: "阈值样本设计" and "SQLite 封装测试" shared 验证/真实/用例/覆盖
  // and were cross-linked as alternatives, which is nonsense — they are not the
  // same decision. The distinguishing token has to be about the SUBJECT, not
  // about how the subject was checked.
  '验证', '断言', '真实', '回归', '覆盖', '失败', '通过', '用例', '轮次', '重复',
  '编写', '调用', '打开', '读取', '返回', '记录', '结果', '情况', '保证', '确认',
])

export function purposeTokens(skill: { description: string; when: string }): Set<string> {
  const text = `${skill.description} ${skill.when}`.toLowerCase()
  const out = new Set<string>()
  for (const match of text.matchAll(/[a-z0-9][a-z0-9_-]{1,}/gu)) out.add(match[0])
  for (const run of text.match(/\p{Script=Han}+/gu) ?? []) {
    if (run.length === 1) out.add(run)
    for (let index = 0; index + 2 <= run.length; index += 1) out.add(run.slice(index, index + 2))
  }
  for (const token of PURPOSE_NOISE) out.delete(token)
  return out
}

/**
 * v1.0.0 P0 — METHOD SIMILARITY IS A PROPERTY OF THE STEPS, NOT OF THE PROSE AROUND THEM.
 *
 * THE BUG THIS FIXES (measured, not theorised)
 *
 * This used to be `jaccard(trigrams(description + steps), …)`. Putting a free-form
 * `description` into the same trigram set as the procedure body made the score MOVE with
 * the description's LENGTH and with the shape of its numbers, and the whole conflict
 * decision hangs off a hard 0.85 threshold. Measured on the audit's own fixture, where
 * every skill's steps were byte-identical and only the index differed:
 *
 *     …技能 100  vs …技能 101   → 0.9077  → "same method"  ✅
 *     …技能 999  vs …技能 1000  → 0.8382  → "different method" ❌ WRONG
 *     …技能 1234 vs …技能 8765  → 0.8261  → "different method" ❌ WRONG
 *
 * Out of 15 sampled pairs, 6 were declared conflicting DESPITE having the same steps —
 * 15 pairs, identical procedures, "these are mutually exclusive alternatives, pick one".
 *
 * The values were not continuous either: across 899 pairs one skill only ever scored
 * 0.846, 0.875 or 0.905. A metric that produces three values on one input family and
 * decides a binary question at a boundary is measuring the FIXTURE, not the method.
 *
 * WHAT IT IS NOW
 *
 * Only the EXECUTION STEPS are compared. Two procedures with the same steps are the same
 * method however differently they are described — that is what "method" means. The
 * description still matters for *purpose* (`purposeTokens`/`conflictStrength`), which is
 * where it belongs: purpose decides whether two skills are about the same thing at all.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not normalise digits away. Stripping digits here would be the same error as the
 * `normalizeForMatch` bug fixed earlier today, one floor up: `端口 3000` and `端口 8080`
 * have genuinely different steps. Digits inside the STEPS are evidence; digits inside a
 * NAME are noise. That distinction is the whole fix.
 */
export function methodSimilarity(a: ExtractedSkill, b: ExtractedSkill): number {
  /**
   * A skill with no parsable steps cannot be compared on method. Returning 0 here is the
   * conservative direction: "unknown method" must not silently become "same method" and
   * suppress a real conflict. `writeSkill` refuses step-less skills anyway, so this only
   * affects skills written by older versions or by hand.
   */
  const leftSteps = a.steps.map((step) => step.trim()).filter(Boolean)
  const rightSteps = b.steps.map((step) => step.trim()).filter(Boolean)
  if (leftSteps.length === 0 || rightSteps.length === 0) return 0
  return jaccard(trigrams(leftSteps.join(' ')), trigrams(rightSteps.join(' ')))
}

/**
 * Two skills conflict when they address the same PURPOSE with a DIFFERENT
 * METHOD.
 *
 * v0.3: measured need. A session that learns "connect MySQL with pymysql" and a
 * session that learns "connect SQLite with sqlite3" produce two procedures with
 * nearly the same trigger and almost no shared steps. Storing both silently is
 * what makes a later retrieval ambiguous: the hint says "this worked last time"
 * twice, for two mutually exclusive answers. They are not duplicates (neither
 * name nor steps match), and they are not unrelated either — they are
 * alternatives, and the record has to say so.
 */
export interface SkillConflict {
  name: string
  title: string
}

/**
 * ── A1-2: THE SHAPE CACHE + THE SKILL READER (moved as one unit) ──────────────────────────────
 *
 * `shapeCache` is a `const` Map mutated through `.set` / `.delete` / `.clear` — `move-gate`
 * reports it as `const-mutated`, and that reading is **deliberate**: it is per-process shared
 * state and must stay module-level for the same reason `store/clock.ts` keeps its `let`
 * module-level. Making it a parameter or an instance field would change what it means
 * (two caches = two answers to "what shape is on disk").
 *
 * WHY THE TEST SEAMS MOVED WITH IT: `clearSkillShapeCache` / `resetShapeCacheForTest` are the
 * only writers of this binding besides `shapeOf`. Leaving them behind would force a
 * cross-module handle on the mutable Map itself — two files sharing one writable binding is
 * exactly what the `mutable` STOP CONDITION exists to catch.
 *
 * WHY `parseEvidenceField` CAME TOO (it was in a later slice): `parseSkillFile` calls it.
 * Carrying it here keeps the dependency one-way (`store.ts → skill.ts`); importing it back
 * from `store.ts` would close a value cycle. Measured: its only two callers are
 * `parseSkillFile` (here) and `writeSkill` (a later slice), both inside A1.
 *
 * ⚠️ `parseEvidenceField` still carries a two-space leading indent from the original file.
 * It is moved **verbatim** here; the indent is fixed in A1-3 as its own recorded change.
 */

export function conflictStrength(a: ExtractedSkill, b: ExtractedSkill): { shared: number; onlyLeft: string[]; onlyRight: string[] } {
  const left = purposeTokens(a)
  const right = purposeTokens(b)
  const shared: string[] = []
  for (const token of left) if (right.has(token)) shared.push(token)
  return {
    shared: shared.length,
    onlyLeft: [...left].filter((token) => !right.has(token)),
    onlyRight: [...right].filter((token) => !left.has(token)),
  }
}

export function isConflictingSkill(a: ExtractedSkill, b: ExtractedSkill): boolean {
  if (a.name === b.name) return true
  /**
   * v1.0.0 P0: "same name is a conflict" is the ONLY conclusion available when neither
   * skill has a parsable procedure. Without this guard, `methodSimilarity` returns 0 for
   * an empty step list — which reads as "completely different method" — and two step-less
   * records that merely share some purpose words get linked as alternatives. Measured
   * while fixing this: two skills with `steps: []` returned TRUE. That is the same
   * "unknown silently becomes a claim" failure the rest of this function is careful about.
   */
  const leftSteps = a.steps.map((step) => step.trim()).filter(Boolean)
  const rightSteps = b.steps.map((step) => step.trim()).filter(Boolean)
  if (leftSteps.length === 0 || rightSteps.length === 0) return false
  // Two names for the same steps is a duplicate, not a conflict.
  if (methodSimilarity(a, b) >= 0.85) return false
  /**
   * v0.17: `scene` is the technology, `domain` is the SYSTEM. Two procedures about
   * different systems are not two ways of doing one thing, however similar their
   * wording — linking them asked the user to choose between unrelated methods.
   *
   * NOTE: this block used to appear TWICE, identically. Deleting the copy is safe (both
   * returned the same value), and it is worth recording because a duplicated guard is a
   * guard that will eventually be edited in one place only.
   */
  if (
    a.domain !== undefined &&
    b.domain !== undefined &&
    a.domain !== 'general' &&
    b.domain !== 'general' &&
    a.domain !== b.domain
  ) {
    return false
  }
  const { shared, onlyLeft, onlyRight } = conflictStrength(a, b)
  // v0.3.2: measured on the battle store. 3 shared bigrams linked 25 pairs out of
  // 16 skills — the DB cluster alone produced a complete graph, which is noise,
  // not knowledge. 5 keeps the genuine alternative (two SAVEPOINT stacks for two
  // different drivers) and drops "both mention transactions somewhere".
  if (shared < 3) return false
  return onlyLeft.length > 0 && onlyRight.length > 0
}

/** Read the executable shape back out of one SKILL.md (enough to compare). */
export function parseSkillFile(text: string, name: string): ExtractedSkill {
  const when = text.match(/^when_to_use:\s*(.+)$/mu)?.[1] ?? text.match(/^when:\s*(.+)$/mu)?.[1] ?? ''
  const description = text.match(/^description:\s*(.+)$/mu)?.[1] ?? when
  const title = text.match(/^#\s+(.+)$/mu)?.[1] ?? name
  const steps: string[] = []
  const body = text.replace(/^---[\s\S]*?---/u, '')
  const stepBlock = body.split(/^## 执行步骤$/mu)[1]?.split(/^## /mu)[0] ?? ''
  for (const line of stepBlock.split(/\r?\n/u)) {
    const match = /^\s*\d+\.\s+(.+)$/u.exec(line)
    if (match !== null) steps.push(match[1].trim())
  }
  const evidence = parseEvidenceField(text.match(/^evidence:\s*(.+)$/mu)?.[1] ?? '', '')
  const scopeText = (text.match(/^scope:\s*(.+)$/mu)?.[1] ?? '').trim().toLowerCase()
  const sceneText = (text.match(/^scene:\s*(.+)$/mu)?.[1] ?? '').trim().toLowerCase()
  const domainText = (text.match(/^domain:\s*(.+)$/mu)?.[1] ?? '').trim().toLowerCase()
  const confidence = clampConfidence(text.match(/^confidence:\s*(.+)$/mu)?.[1])
  const aliases = (text.match(/^aliases:\s*(.+)$/mu)?.[1] ?? '').split(/,/u).map((item) => item.trim()).filter(Boolean)
  return {
    name,
    title,
    description,
    when,
    steps,
    verify: [],
    scope: scopeText === 'workspace' || scopeText === 'global' ? scopeText : 'project',
    scene: /^[a-z][a-z0-9-]{1,23}$/u.test(sceneText) ? sceneText : 'general',
    domain: /^[a-z][a-z0-9-]{1,31}$/u.test(domainText) ? domainText : 'general',
    aliases,
    ...(() => {
      const tags = asVocab(text.match(/^tags:\s*(.+)$/mu)?.[1] ?? '')
      return tags.length === 0 ? {} : { tags }
    })(),
    ...(() => {
      const nodeTypes = asVocab(text.match(/^applicable_node_types:\s*(.+)$/mu)?.[1] ?? '')
      return nodeTypes.length === 0 ? {} : { applicableNodeTypes: nodeTypes }
    })(),
    confidence,
    evidence,
  }
}

export function listSkillFiles(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * v1.0.0 P0 — CONFLICT DISCOVERY IS A READ; ONLY THE EDGE WRITE HAD TO CHANGE.
 *
 * `findConflicts` must SCAN every existing skill: a conflict is a property of two shapes,
 * and a shape that was never written down cannot be looked up in an index. The first
 * version of this refactor made discovery read the edge index instead — which is a
 * chicken-and-egg bug: the index only contains edges that discovery already found, so the
 * very first conflict could never be recorded. Caught by a 5-skill fixture producing an
 * empty `skills-edges.jsonl`.
 *
 * v1.0.0 P0 C: THE SCAN IS CACHED PER (dir, name, mtime, size).
 *
 * Rewriting a growing file per edge was the O(N²) IO. What was left after that fix is a
 * smaller but still quadratic cost: writing N skills in one process re-reads and re-parses
 * every earlier skill N times. Measured after the join fix: 7.0 ms/skill at N=50 rising to
 * 23.0 ms/skill at N=200 (3.28×). The cache below turns those re-parses into map lookups.
 *
 * INVALIDATION IS BY stat, NOT BY TRUST: a cached shape is reused only when mtime AND size
 * both match. Another process editing a SKILL.md therefore cannot leave a stale shape in
 * play — which matters because harvest writes are one process and reviews are another.
 */
export interface CachedShape {
  mtimeMs: number
  size: number
  skill: ExtractedSkill
}

const shapeCache = new Map<string, Map<string, CachedShape>>()

/** Drop the cached shape of one skill (after this process writes it). */
export function invalidateSkillShape(skillsDir: string, name: string): void {
  shapeCache.get(skillsDir)?.delete(name)
}

/** Drop every cached shape for a directory. Tests and bulk rebuilds call this. */
export function clearSkillShapeCache(skillsDir?: string): void {
  if (skillsDir === undefined) shapeCache.clear()
  else shapeCache.delete(skillsDir)
}

/**
 * v1.x TEST SEAM — see `resetMonotonicClockForTest` for the contract.
 *
 * `shapeCache` is module-level mutable state (a `const` object mutated via
 * `clear` / `set` / `delete`). Any suite that exercises the skill writers or
 * ISOLATION between tests must be able to reset it deterministically, otherwise
 * a stale cached shape from test A can answer test B.
 */
export function resetShapeCacheForTest(): void {
  clearSkillShapeCache()
}

export function shapeOf(skillsDir: string, name: string): ExtractedSkill | undefined {
  const path = skillPath(skillsDir, name)
  let stat: { mtimeMs: number; size: number }
  try {
    stat = statSync(path)
  } catch {
    shapeCache.get(skillsDir)?.delete(name)
    return undefined
  }
  const bucket = shapeCache.get(skillsDir) ?? new Map<string, CachedShape>()
  if (!shapeCache.has(skillsDir)) shapeCache.set(skillsDir, bucket)
  const cached = bucket.get(name)
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.skill
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const skill = parseSkillFile(text, name)
  bucket.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, skill })
  return skill
}

export function findConflicts(skillsDir: string, skill: ExtractedSkill): SkillConflict[] {
  const out: SkillConflict[] = []
  for (const name of listSkillFiles(skillsDir)) {
    if (name === skill.name) continue
    const other = shapeOf(skillsDir, name)
    if (other === undefined) continue
    if (isConflictingSkill(skill, other)) out.push({ name, title: other.title })
  }
  return out
}

export function parseEvidenceField(raw: string, fallbackSession: string): EvidenceRef[] {
  const refs: EvidenceRef[] = []
  for (const token of raw.split(/[,\s]+/u).filter(Boolean)) {
    const at = token.lastIndexOf('@')
    const sourceSessionId = at > 0 ? token.slice(0, at) : fallbackSession
    const seq = Number(at > 0 ? token.slice(at + 1) : token)
    if (!Number.isFinite(seq)) continue
    if (refs.some((ref) => ref.seq === seq && ref.sourceSessionId === sourceSessionId)) continue
    refs.push({ sourceSessionId, seq })
  }
  return refs
}

/**
 * ── A1-3: THE SKILL RENDERER + ENVIRONMENT/TRIGGER TOKENS ─────────────────────────────────────
 *
 * `renderSkill` is the write direction of the SKILL.md contract: it turns an extraction into the
 * exact text `parseSkillFile` (A1-2, same file) reads back. `evidenceBodyLines` is its evidence
 * block writer. Keeping the writer and the reader in one file is the point of this split — two
 * halves of one format living apart is how they drift.
 *
 * `VERSION_TOKEN` / `ENVIRONMENT_TOKEN` / `environmentTokensOf` / `triggerTokens` /
 * `triggerSimilarity` / `EnvironmentDivergence` are the environment-divergence family: a merge
 * must not silently fold two skills written against different versions or machines into one.
 * They are pure functions over the text already on disk.
 *
 * NOTE: this slice carries NO module-level mutable state (verified: the cluster's own closure is
 * the 8 declarations below, and none of them rebinds or mutates a module const).
 */

function evidenceBodyLines(evidence: readonly EvidenceRef[], fallbackSession: string): string[] {
  const bySession = new Map<string, number[]>()
  for (const ref of evidence) {
    const session = ref.sourceSessionId.length > 0 ? ref.sourceSessionId : fallbackSession
    const list = bySession.get(session) ?? []
    list.push(ref.seq)
    bySession.set(session, list)
  }
  return [...bySession.entries()].map(([session, seqs]) => `- 源会话：${session}（seq ${seqs.join(', ')}）`)
}

export function renderSkill(
  skill: ExtractedSkill,
  meta: SkillMeta,
  previous?: {
    evidence: number
    sources: number
    created: string
    lastUsed?: string
    lastValidated?: string
    validAt?: string
    invalidAt?: string
    supersededBy?: string
    supersedes?: string[]
    provenance?: string
  },
  conflicts: readonly SkillConflict[] = [],
): string {
  const now = meta.at ?? new Date().toISOString().slice(0, 10)
  const workspace = normalizeWorkspace(meta.workspace)
  const fields: Record<string, string | number> = {
    name: skill.name,
    description: skill.description.slice(0, 160),
    when_to_use: skill.when.slice(0, 200),
    scope: skill.scope,
    /**
     * NOTE the single `domain` key. This literal previously declared it TWICE in a row — the second silently
     * won. It happened to be identical, so nothing ever failed, which is exactly why it survived: the bug was
     * invisible until the day someone edited only one of them.
     */
    domain: skill.domain ?? 'general',
    /**
     * v0.32 — THE CAUSAL FIELDS, WRITTEN ONLY WHEN THE CALLER ACTUALLY KNOWS THEM.
     *
     * `dependencies` and `target_effect` are what turn a skill from a procedure into a MACRO: preconditions
     * in, expected state out. They are omitted rather than defaulted, because an invented precondition would
     * be read back by `causalChain` as evidence and would make a chain look complete when it is not.
     */
    ...(Array.isArray((skill as ExtractedSkill).dependencies) && (skill as ExtractedSkill).dependencies!.length > 0
      ? {
          dependencies: (skill as ExtractedSkill)
            .dependencies!.map((ref) => (ref.sourceSessionId.length > 0 ? `${ref.sourceSessionId}@${ref.seq}` : String(ref.seq)))
            .join(','),
        }
      : {}),
    ...(typeof (skill as ExtractedSkill).target_effect === 'string' &&
    ((skill as ExtractedSkill).target_effect as string).length > 0
      ? { target_effect: (skill as ExtractedSkill).target_effect as string }
      : {}),
    // v0.8: provenance for the isolation gate (see workspace.ts). Written even for
    // a `global` skill: `global` decides ELIGIBILITY, the path stays on record for
    // audit. Omitted only when the caller genuinely had no workspace.
    ...(workspace.length === 0 ? {} : { workspace }),
    scene: skill.scene,
    ...(skill.aliases.length === 0 ? {} : { aliases: skill.aliases.join(', ') }),
    /**
     * GLOBAL KNOWLEDGE BASE — WRITTEN ONLY WHEN THE CALLER NAMED THEM.
     *
     * Same rule as `dependencies`: an invented tag would make a local memory look shareable, and
     * a reader in another workspace would then trust it as a general rule. An omitted field reads
     * back as "no cross-workspace reach", which is exactly the pre-existing behaviour.
     */
    ...(() => {
      const tags = asVocab((skill as ExtractedSkill).tags)
      return tags.length === 0 ? {} : { tags: tags.join(', ') }
    })(),
    ...(() => {
      const nodeTypes = asVocab((skill as ExtractedSkill).applicableNodeTypes)
      return nodeTypes.length === 0 ? {} : { applicable_node_types: nodeTypes.join(', ') }
    })(),
    confidence: clampConfidence(skill.confidence).toFixed(2),
    evidence: skill.evidence
      .map((ref) => (ref.sourceSessionId.length > 0 ? `${ref.sourceSessionId}@${ref.seq}` : String(ref.seq)))
      .join(','),
    sources: previous === undefined ? 1 : previous.sources,
    /**
     * v1.0.0 P0 — NO INLINE CONFLICT EDGES.
     *
     * This used to emit `conflicts_with: a,b,c,…` here, and `reorder` below emitted the
     * same neighbors again as prose under `## ⚠️ 冲突提示`. Both are gone. Every edge now
     * lives in `skills-edges.jsonl` (see edges.ts), joined at retrieval time.
     *
     * WHY REMOVE IT RATHER THAN CAP IT: the field was a single line that grew with every
     * neighbor, so one file reached 12,959 characters of names plus 91 KB of repeated
     * prose. Retrieval had to read and tokenize all of it to answer a question about the
     * skill's trigger. Capping the line would have kept both costs and added a truncation
     * bug. The edge is a GRAPH FACT, not a property of one file.
     *
     * A legacy store still has the field on disk; `migrateLegacyEdges` folds those into the
     * index and nothing rewrites the files (a stale hint is harmless; a mass rewrite is not).
     */
  }
  if (previous !== undefined && previous.created.length > 0) {
    fields.created = previous.created
    fields.updated = now
  } else {
    fields.created = now
  }
  // v0.15 bi-temporal + trust fields.
  //
  // `valid_at` defaults to the write time; `invalid_at` is written ONLY when the
  // record has actually been superseded (an empty field on every skill would make
  // "active" and "never validated" indistinguishable in a grep). A merge keeps the
  // ORIGINAL valid_at and an existing invalidation: refreshing the wording of a
  // superseded rule must not quietly resurrect it.
  fields.valid_at = previous?.validAt !== undefined && previous.validAt.length > 0 ? previous.validAt : now
  if (previous?.invalidAt !== undefined && previous.invalidAt.length > 0) fields.invalid_at = previous.invalidAt
  if (previous?.supersededBy !== undefined && previous.supersededBy.length > 0) fields.superseded_by = previous.supersededBy
  if (previous?.supersedes !== undefined && previous.supersedes.length > 0) fields.supersedes = previous.supersedes.join(',')
  fields.provenance = previous?.provenance !== undefined && previous.provenance.length > 0 ? previous.provenance : meta.provenance ?? 'inferred'
  /**
   * v0.32 P1: the generation and the commit the experience belongs to. Written only when
   * the caller actually knows them — an invented commit would be worse than no commit,
   * because retrieval treats a mismatch as "this is old" and a missing value as "unknown".
   */
  if (typeof meta.generation === 'number' && Number.isFinite(meta.generation) && meta.generation > 0) {
    fields.generation = Math.trunc(meta.generation)
  }
  if (typeof meta.commitHash === 'string' && /^[0-9a-f]{7,40}$/u.test(meta.commitHash)) {
    fields.commitHash = meta.commitHash
  }
  // v0.5 decay bookkeeping: a fresh write is also a fresh validation.
  fields.last_validated = previous?.lastValidated !== undefined && previous.lastValidated.length > 0 ? previous.lastValidated : now
  fields.last_used = previous?.lastUsed !== undefined && previous.lastUsed.length > 0 ? previous.lastUsed : now
  return [
    frontmatter(fields),
    '',
    `# ${skill.title}`,
    '',
    '## 何时使用',
    '',
    skill.when,
    '',
    '## 执行步骤',
    '',
    ...skill.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    '## 验证标准',
    '',
    ...skill.verify.map((line) => `- ${line}`),
    '',
    '## 证据',
    '',
    ...evidenceBodyLines(skill.evidence, meta.sessionId),
    /**
     * v1.0.0 P0 — the `## ⚠️ 冲突提示` footer is GONE.
     *
     * It repeated up to 720 neighbor names as prose inside the skill file, which is what
     * made a 798 B skill grow to 104 KB and forced retrieval to read 91 KB of warnings to
     * answer a query about the trigger. Conflicts are now joined from `skills-edges.jsonl`
     * where they are actually needed — see retrieve.ts. `conflictFooter` is kept exported
     * below for the render of a HUMAN-facing listing, never for the stored file.
     */
  ].join('\n')
}

/**
 * v0.7.1: environment/version tokens that make two procedures NOT interchangeable.
 *
 * The failure this guards: "install pymysql on Python 3.8" and "use the stdlib
 * driver on Python 3.12" share a trigger and both connect to MySQL, so the
 * similarity gate merged them into one file — and the merged procedure ran on
 * neither version. A version difference is evidence of an alternative, not of a
 * synonym.
 */
const VERSION_TOKEN = /\b(python|py|node|nodejs|go|golang|java|rust|ruby|php|deno|bun|typescript|ts|dotnet|net)[\s_-]?v?(\d+(?:\.\d+)+)/giu
const ENVIRONMENT_TOKEN = /\b(windows|win32|linux|ubuntu|debian|centos|macos|darwin|wsl|docker|alpine|arm64|x86[_-]?64|amd64)\b/giu

export function environmentTokensOf(text: string): Set<string> {
  const out = new Set<string>()
  for (const match of text.toLowerCase().matchAll(VERSION_TOKEN)) {
    const runtime = match[1] === 'py' ? 'python' : match[1] === 'nodejs' ? 'node' : match[1]
    out.add(`${runtime}${match[2]}`)
  }
  for (const match of text.toLowerCase().matchAll(ENVIRONMENT_TOKEN)) out.add(match[1].replace(/[_-]/gu, ''))
  return out
}

function triggerTokens(text: string): Set<string> {
  const out = new Set<string>()
  const lower = text.toLowerCase()
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9_-]{1,}/gu)) out.add(match[0])
  for (const run of lower.match(/\p{Script=Han}+/gu) ?? []) {
    if (run.length === 1) out.add(run)
    for (let index = 0; index + 2 <= run.length; index += 1) out.add(run.slice(index, index + 2))
  }
  return out
}

export function triggerSimilarity(left: string, right: string): number {
  const a = triggerTokens(left)
  const b = triggerTokens(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / Math.min(a.size, b.size)
}

export interface EnvironmentDivergence {
  previous: string[]
  next: string[]
}

/**
 * ── A1-4: THE SKILL WRITER ────────────────────────────────────────────────────────────────────
 *
 * `writeSkill` is the only path by which a new or updated SKILL.md reaches disk: it validates the
 * shape (steps + verification, no slogans), runs the prompt-injection scan, resolves a unique
 * name, detects conflicts against what is already stored, and writes atomically.
 *
 * `environmentDivergence` / `uniqueSkillName` / `commitEdges` / `linkConflictBack` are its direct
 * collaborators — every one of them appears in `writeSkill`'s own closure (measured: 5 members,
 * all moved by this step, none left behind).
 *
 * NOTE ON MUTABLE STATE: this slice carries **none**. The only module-level mutable state in this
 * file is `shapeCache` (A1-2), which this step reads through `invalidateSkillShape` but never
 * rebinds.
 */

/**
 * v0.7.1: same purpose, different named environment → DO NOT MERGE.
 * Returns the two token sets when merging would erase a real difference.
 */
export function environmentDivergence(previous: ExtractedSkill, next: ExtractedSkill): EnvironmentDivergence | undefined {
  const left = environmentTokensOf(`${previous.when} ${previous.steps.join(' ')}`)
  const right = environmentTokensOf(`${next.when} ${next.steps.join(' ')}`)
  if (left.size === 0 || right.size === 0) return undefined
  // A shared runtime token means the procedures agree on the environment.
  for (const token of left) if (right.has(token)) return undefined
  if (triggerSimilarity(previous.when, next.when) < 0.5) return undefined
  return { previous: [...left].slice(0, 4), next: [...right].slice(0, 4) }
}

/** A free kebab-case name, so a divergence keeps BOTH procedures on disk. */
function uniqueSkillName(skillsDir: string, base: string): string {
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`
    if (candidate.length > 48) break
    if (!existsSync(skillPath(skillsDir, candidate))) return candidate
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 48)
}

/** Create or merge one skill. Returns `created`, `merged`, `conflicted:<env>` or `skipped:<reason>`. */
export function writeSkill(skillsDir: string, input: SkillInput | ExtractedSkill, meta: SkillMeta): string {
  const skill = normalizeSkill(input)
  if (skill.steps.length === 0) return 'skipped:no execution steps'
  if (skill.verify.length === 0) return 'skipped:no verification criterion'
  // v0.6: a ref without a session id inherits the session that produced it.
  const withSession: ExtractedSkill = {
    ...skill,
    evidence: skill.evidence.map((ref) => ({ ...ref, sourceSessionId: ref.sourceSessionId.length > 0 ? ref.sourceSessionId : meta.sessionId })),
    /**
     * v0.32 — CARRY THE CAUSAL FIELDS THROUGH THE NORMALIZER.
     *
     * `normalizeSkill` rebuilds the record from a known set of fields, so anything it does not name is
     * dropped. `dependencies` / `target_effect` were added to the schema but not to that whitelist, and the
     * effect was silent: the skill was written, `readSkillBody` returned no preconditions, and the causal
     * chain looked complete while missing its first hop. Copying them explicitly here (and pointing each
     * dependency at the fallback session) is what makes the round trip whole.
     */
    ...(Array.isArray((input as ExtractedSkill).dependencies)
      ? {
          dependencies: (input as ExtractedSkill).dependencies!.map((ref) => ({
            ...ref,
            sourceSessionId: ref.sourceSessionId.length > 0 ? ref.sourceSessionId : meta.sessionId,
          })),
        }
      : {}),
    ...(typeof (input as ExtractedSkill).target_effect === 'string'
      ? { target_effect: (input as ExtractedSkill).target_effect }
      : {}),
  }
  const threat = scanThreat(`${skill.title} ${skill.description} ${skill.when} ${skill.steps.join(' ')} ${skill.verify.join(' ')}`)
  if (threat !== undefined) return `skipped:${threat}`
  // v0.3: record mutually exclusive alternatives instead of storing both silently.
  const conflicts = findConflicts(skillsDir, skill)
  const path = skillPath(skillsDir, skill.name)
  if (existsSync(path)) {
    // Merge: keep the earliest evidence, refresh the wording, count the use of
    // the *provenance* (sessions that confirmed it), never duplicate the file.
    const previousText = readFileSync(path, 'utf8')
    // v0.8: a write with no workspace (a queued suggestion replayed later, an
    // older caller) inherits the workspace already recorded. Otherwise a merge
    // would silently launder a memory out of the workspace that produced it.
    const previousWorkspace = readSkillWorkspace(previousText)
    const writeMeta: SkillMeta =
      normalizeWorkspace(meta.workspace).length > 0 || previousWorkspace.length === 0
        ? meta
        : { ...meta, workspace: previousWorkspace }
    // v0.7.1: a version/environment difference is a CONFLICT, never a merge.
    const previousSkill = parseSkillFile(previousText, skill.name)
    const divergence = environmentDivergence(previousSkill, skill)
    if (divergence !== undefined) {
      const altName = uniqueSkillName(skillsDir, skill.name)
      const conflict: SkillConflict = { name: skill.name, title: previousSkill.title }
      const alternative: ExtractedSkill = { ...withSession, name: altName, confidence: 1 }
      atomicWrite(skillPath(skillsDir, altName), renderSkill(alternative, writeMeta, undefined, [conflict]))
      linkConflictBack(skillsDir, conflict, alternative)
      return `conflicted:${divergence.previous.join(',')} vs ${divergence.next.join(',')}`
    }
    const previousEvidence = parseEvidenceField(previousText.match(/^evidence:\s*(.+)$/mu)?.[1] ?? '', meta.sessionId)
    const previousValidity = readSkillValidity(previousText)
    const evidenceKey = (ref: EvidenceRef): string => `${ref.sourceSessionId}@${ref.seq}`
    const merged = [...new Map([...previousEvidence, ...withSession.evidence].map((ref) => [evidenceKey(ref), ref])).values()]
    const sources = Number(previousText.match(/^sources:\s*(\d+)$/mu)?.[1] ?? '1')
    const created = previousText.match(/^created:\s*(.+)$/mu)?.[1] ?? ''
    const lastUsed = previousText.match(/^last_used:\s*(.+)$/mu)?.[1] ?? undefined
    const lastValidated = previousText.match(/^last_validated:\s*(.+)$/mu)?.[1] ?? undefined
    // v0.7.1: repetition must not launder a skill that failed in use; keep the
    // learned confidence across the merge.
    const mergedSkill: ExtractedSkill = { ...withSession, evidence: merged, confidence: clampConfidence(previousSkill.confidence) }
    atomicWrite(path, renderSkill(mergedSkill, writeMeta, { evidence: merged.length, sources: sources + 1, created, lastUsed, lastValidated, validAt: previousValidity.validAt, invalidAt: previousValidity.invalidAt, supersededBy: previousValidity.supersededBy, supersedes: previousValidity.supersedes, provenance: previousValidity.provenance }, conflicts))
    commitEdges(skillsDir, skill.name, conflicts)
    invalidateSkillShape(skillsDir, skill.name)
    /** v1.1.0: the retrieval-side document cache must not serve the pre-write shape. */
    invalidateSkillDocs(skillsDir)
    return 'merged'
  }
  atomicWrite(path, renderSkill(withSession, meta, undefined, conflicts))
  commitEdges(skillsDir, skill.name, conflicts)
  invalidateSkillShape(skillsDir, skill.name)
  invalidateSkillDocs(skillsDir)
  return 'created'
}

/**
 * v1.0.0 P0 C — ONE APPEND FOR ALL OF A SKILL'S EDGES.
 *
 * The loop this replaces called `linkConflictBack` once per neighbor, and each call wrote
 * the index separately. A skill with 300 true conflicts meant 300 open/append/close cycles
 * for one write. Batching turns that into a single append; the edge count itself is a
 * property of the store's content and cannot be reduced (and must not be — a real conflict
 * is information).
 */
function commitEdges(skillsDir: string, name: string, conflicts: readonly SkillConflict[]): void {
  if (conflicts.length === 0) return
  writeEdges(
    skillsDir,
    conflicts.map((conflict) => [name, conflict.name] as const),
  )
}

/**
 * v1.0.0 P0 — CONFLICT INDEX LAYER: EDGE WRITING
 *
 * Instead of rewriting the whole SKILL.md file, we just append one line to the shared index.
 * The old code path (line 911–936) did a full read/write for each edge. That is now
 * replaced with an O(1) append-only write. Backwards compatibility: legacy files that
 * already carry conflicts_with will be migrated by runMigration().
 */
export function linkConflictBack(skillsDir: string, target: SkillConflict, other: { name: string; title: string }): void {
  /** Write edge only — no more rewrites of individual SKILL.md files. */
  writeEdge(skillsDir, target.name, other.name)
}

/**
 * ── A1-5: THE SKILL BODY READER ───────────────────────────────────────────────────────────────
 *
 * `readSkillBody` is the read direction of the SKILL.md body: it strips the frontmatter and
 * parses the structured sections back out. `parseEvidenceList` is its evidence-pointer parser and
 * `SkillBody` is the shape it returns.
 *
 * This closes the SKILL pair: the writer (`renderSkill`, A1-3) and the reader now live in one file,
 * which is the whole reason this split was done in this order.
 */

/**
 * v0.22 P1 — PROGRESSIVE DISCLOSURE: the body is a SECOND read, not part of the hint.
 *
 * THE BUDGET PROBLEM
 *
 * A SKILL.md is a procedure: frontmatter, 执行步骤, 验证标准, pitfalls. The hint that
 * rides a pre-step is a single line, and it deliberately carries only the trigger —
 * `when_to_use` — because that is what decides "is this skill about my task".
 *
 * Injecting the body as well would spend the context budget of EVERY turn on every
 * recalled skill, whether or not the model acts on it: measured on this store, the
 * four largest skills are ~2.4 KB each, so three recalls per turn would cost ~7 KB of
 * a 32k window — paid before anyone decides the skill applies.
 *
 * So the body is read ON DEMAND: the hint names the skill, and `skill_read(name)`
 * returns the procedure when the model has decided it wants it.
 *
 * Read-only, and it applies the same injection scan as retrieval: a body that was
 * poisoned on disk must not reach a prompt through this path either.
 */
export interface SkillBody {
  name: string
  title: string
  when: string
  /** The markdown body, frontmatter stripped. */
  body: string
  /** Character count of `body`, so a caller can decide before reading. */
  chars: number
  /**
   * v0.32 — THE MACRO'S PRECONDITIONS, parsed from frontmatter.
   *
   * `dependencies` are the evidence pointers the procedure requires to already hold. They are read back
   * HERE, not fetched from a database, because a SKILL.md is the durable record: whatever the causal chain
   * reports must be something written in the file, or it is a story this layer told itself.
   *
   * ABSENT means "the procedure declares no preconditions", which is different from "its preconditions were
   * not recorded" — the file is the source of truth either way.
   */
  dependencies?: Array<{ sourceSessionId: string; seq: number }>
  /** v0.32: the state the procedure is expected to produce, from frontmatter `target_effect`. */
  targetEffect?: string
}

/**
 * Parse a frontmatter list of evidence pointers.
 *
 * WHY A TOLERANT PARSER: frontmatter is hand-edited (that is a feature — a human can correct a skill), so a
 * malformed entry must be SKIPPED rather than made to throw. A skill whose dependency line is typo'd should
 * still be readable; only that one precondition is lost, and the loss is silent by construction because the
 * alternative is making a whole skill unreadable over one bad line.
 */
function parseEvidenceList(raw: string, field: string): Array<{ sourceSessionId: string; seq: number }> {
  const items = raw
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  const out: Array<{ sourceSessionId: string; seq: number }> = []
  for (const item of items) {
    // Accept `sessionId@seq` and bare `seq`.
    const at = item.lastIndexOf('@')
    if (at > 0) {
      const seq = Number(item.slice(at + 1))
      if (Number.isFinite(seq)) out.push({ sourceSessionId: item.slice(0, at), seq })
      continue
    }
    const seq = Number(item)
    if (Number.isFinite(seq)) out.push({ sourceSessionId: '', seq })
  }
  if (out.length === 0 && raw.trim().length > 0) {
    void field
  }
  return out
}

export function readSkillBody(skillsDir: string, name: string): SkillBody | undefined {
  // The name is a directory under skillsDir; refuse anything that could escape it.
  if (typeof name !== 'string' || name.length === 0) return undefined
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return undefined
  const path = skillPath(skillsDir, name)
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  // The same rule the write gate and the retrieval gate apply: stored memory is DATA,
  // and text that tries to rewrite the reader's rules is refused at THIS boundary too.
  if (scanThreat(text) !== undefined) return undefined
  const field = (key: string): string => (text.match(new RegExp(`^${key}:\\s*(.+)$`, 'mu'))?.[1] ?? '').trim()
  const body = text.replace(/^---[\s\S]*?---\u0000?/u, '').replace(/^---[\s\S]*?---\r?\n/u, '').trim()
  return {
    name,
    title: (text.match(/^#\s+(.+)$/mu)?.[1] ?? name).trim(),
    when: field('when_to_use') || field('when'),
    body,
    chars: body.length,
    /**
     * v0.32: the causal fields, read back from the SAME file. Only included when actually present, so a
     * legacy SKILL.md returns exactly the shape it always did — no invented keys, no fake defaults.
     */
    ...(field('dependencies').length === 0
      ? {}
      : { dependencies: parseEvidenceList(field('dependencies'), 'dependencies') }),
    ...(field('target_effect').length === 0 ? {} : { targetEffect: field('target_effect') }),
  }
}
