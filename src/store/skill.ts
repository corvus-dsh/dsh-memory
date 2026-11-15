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
