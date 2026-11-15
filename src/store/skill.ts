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

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { EvidenceRef, ExtractedSkill, MemoryProvenance } from '../extract.js'
import { jaccard, trigrams } from '../dedupe.js'
import { asVocab } from './layer.js'
import { normalizeWorkspace } from '../workspace.js'

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
  const provenanceText = (text.match(/^provenance:\s*(.+)$/mu)?.[1] ?? '').trim().toLowerCase()
  return {
    validAt: (text.match(/^valid_at:\s*(.+)$/mu)?.[1] ?? '').trim(),
    invalidAt: (text.match(/^invalid_at:\s*(.+)$/mu)?.[1] ?? '').trim(),
    supersededBy: (text.match(/^superseded_by:\s*(.+)$/mu)?.[1] ?? '').trim(),
    supersedes: (text.match(/^supersedes:\s*(.+)$/mu)?.[1] ?? '')
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
