/**
 * Durable store: skills as structured SKILL.md files, negative paths as JSONL,
 * and the observation layers (facts / experiences) as append-only JSONL.
 *
 * WHY SKILL.md AND NOT A PRIVATE JSON
 *
 * DSH already has a skill loader that scans `~/.agents/skills`. Writing there
 * means the next generation picks the skill up with no plugin installed and no
 * retrieval protocol of ours in the loop. The store only has to be *correct*, not
 * clever: kebab-case name as the identity key, frontmatter the loader understands,
 * atomic writes, and a prompt-injection scan before anything is written.
 *
 * WHY THE SHAPE IS ENFORCED HERE TOO
 *
 * The extractor already refuses a skill without steps/verification. This second
 * gate exists because the store is also reachable from the review queue, where a
 * v0.1 suggestion (a single `how` line) can still arrive. One measured skill was
 * literally `测试样本必须超过阈值` — a slogan. A file that cannot guide execution
 * is not written at all; the reason is returned, never swallowed.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import type { EvidenceRef, ExtractedExperience, ExtractedFact, ExtractedNegative, ExtractedSkill, MemoryProvenance } from './extract.js'
import { jaccard, planNegative, trigrams } from './dedupe.js'
import { acquireFileLock } from './lock.js'
import { normalizeWorkspace } from './workspace.js'
import { scanThreat } from './threat.js'
import { withFileLock } from './lock.js'

export function defaultSkillsDir(): string {
  return join(homedir(), '.agents', 'skills')
}

/** Windows holds a share lock while a reader has the file open; sleep briefly. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // Fall back to a busy wait where SharedArrayBuffer is unavailable.
    const end = Date.now() + ms
    while (Date.now() < end) {
      // spin
    }
  }
}

const TRANSIENT_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * v0.23 — STRUCTURAL GATE BEFORE AN OVERWRITE.
 *
 * `atomicWrite` protects against a TORN file: a reader sees the old file or the new
 * one, never half. It says nothing about a file that was already garbage when it was
 * handed over. The failure this closes:
 *
 *   An extraction model returns a truncated reply — a reply that stops mid-value,
 *   because the response hit a token cap or the transport dropped a chunk. The
 *   caller parses what it got, or trusts a value it assembled, and writes it. The
 *   write is atomic and the file is now atomically WRONG, and the previous good
 *   contents are gone. A reader then meets a JSON document that cannot parse, and
 *   every entry after the break is invisible.
 *
 * The rule: a structured store file is validated BEFORE it replaces anything. On
 * failure nothing is overwritten — the offending payload goes to `<path>.rejected-*`
 * so it can be inspected, and the original file on disk stays exactly as it was.
 *
 * Scope is by EXTENSION, not by caller, because there are 20+ write sites and a guard
 * that each of them must remember to call is a guard that one of them will forget.
 * `.md` and `.jsonl` bodies are handled by their own writers (a skill is validated by
 * the frontmatter parser; a jsonl line is validated on read), so this gate covers the
 * single-document JSON stores where a truncation is unrecoverable.
 */
const JSON_GATE_EXT = '.json'

export class StoreWriteRejected extends Error {
  // Explicit fields rather than TypeScript parameter properties: `scripts/build.mjs`
  // strips types without transforming them, so the shorthand is not available here.
  readonly path: string
  readonly reason: string
  readonly quarantinePath: string | undefined

  constructor(path: string, reason: string, quarantinePath: string | undefined) {
    super(`[dsh-memory] refused to overwrite ${path}: ${reason}`)
    this.name = 'StoreWriteRejected'
    this.path = path
    this.reason = reason
    this.quarantinePath = quarantinePath
  }
}

/**
 * Throw when `text` is not a complete JSON document. Returns normally otherwise.
 *
 * Deliberately strict: `JSON.parse` on the whole string, no brace-matching heuristic.
 * A heuristic that "repairs" a truncated document would write a file that parses but
 * says something the model never said — worse than refusing.
 */
function assertCompleteJson(path: string, text: string): void {
  if (!path.toLowerCase().endsWith(JSON_GATE_EXT)) return
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  try {
    JSON.parse(trimmed)
  } catch (error) {
    const reason = `not a complete JSON document (${String((error as any)?.message ?? error)})`
    let quarantinePath: string | undefined
    try {
      quarantinePath = `${path}.rejected-${process.pid}-${Date.now()}`
      writeFileSync(quarantinePath, text, 'utf8')
    } catch {
      // A failed quarantine must not mask the real refusal: the caller still needs to
      // know the write did not happen.
      quarantinePath = undefined
    }
    throw new StoreWriteRejected(path, reason, quarantinePath)
  }
}

/**
 * v0.7.1: tmp-file + rename, with a retry window for Windows share locks.
 *
 * The extreme-consistency run (5 reader processes against 1 writer) proved the
 * rename can fail with EPERM while another process holds the destination open.
 * An unguarded `renameSync` therefore turned a concurrent READ into a failed
 * WRITE — the one failure mode an append-only ledger must not have. Retrying for
 * a bounded window keeps the atomicity and makes concurrent reads harmless.
 */
export function atomicWrite(path: string, text: string): void {
  // v0.23: validate BEFORE the tmp file exists, so a rejected payload never becomes
  // visible under any name that a reader could pick up.
  assertCompleteJson(path, text)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, path)
      return
    } catch (error) {
      const code = String((error as any)?.code ?? '')
      if (!TRANSIENT_RENAME.has(code) || attempt >= 40) {
        try {
          rmSync(tmp, { force: true })
        } catch {
          // The next write's own tmp file is equally disposable.
        }
        throw error
      }
      sleepSync(5 + Math.min(50, attempt * 5))
    }
  }
}

/**
 * Same rule as the ecosystem's memory plugins: memory content is DATA, never an
 * instruction. Text that tries to rewrite the reader's rules is refused at the
 * write boundary, because a later prompt will happily quote it verbatim.
 *
 * v0.8.1: the patterns moved to `threat.ts` so the INJECTION boundary can apply
 * the same rule to content that is already on disk (an older writer, a hand-edited
 * file, another tool). Re-exported here because this is where callers know to
 * look for it.
 */
export { scanThreat } from './threat.js'

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

const PROVENANCE_TIERS = new Set(['human', 'tool', 'inferred'])

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

/** v0.15: is this memory inside its validity window at `now`? */
export function isValidAt(validity: { validAt?: string; invalidAt?: string }, now = Date.now()): boolean {
  const invalid = parseInstant(validity.invalidAt)
  if (invalid !== undefined && invalid <= now) return false
  const valid = parseInstant(validity.validAt)
  if (valid !== undefined && valid > now) return false
  return true
}

/** A parseable instant, or undefined. A malformed stamp never hides a memory. */
export function parseInstant(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const parsed = Date.parse(value.length <= 10 ? `${value}T00:00:00Z` : value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function frontmatter(fields: Record<string, string | number>): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) lines.push(`${key}: ${String(value)}`)
  lines.push('---')
  return lines.join('\n')
}

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
  /** v0.15: bi-temporal start. Defaults to `at` (the write time). */
  validAt?: string
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
const PURPOSE_NOISE = new Set([
  'python', 'py', 'code', 'script', '简单', '一个', '使用', '实现', '封装', '方法', '步骤', '测试', '操作',
  // v0.3.1: TESTING vocabulary was the false-positive engine. Measured on the
  // battle store: "阈值样本设计" and "SQLite 封装测试" shared 验证/真实/用例/覆盖
  // and were cross-linked as alternatives, which is nonsense — they are not the
  // same decision. The distinguishing token has to be about the SUBJECT, not
  // about how the subject was checked.
  '验证', '断言', '真实', '回归', '覆盖', '失败', '通过', '用例', '轮次', '重复',
  '编写', '调用', '打开', '读取', '返回', '记录', '结果', '情况', '保证', '确认',
])

function purposeTokens(skill: { description: string; when: string }): Set<string> {
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

function sharedPurpose(a: ExtractedSkill, b: ExtractedSkill): number {
  const left = purposeTokens(a)
  const right = purposeTokens(b)
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared
}

function methodSimilarity(a: ExtractedSkill, b: ExtractedSkill): number {
  return jaccard(
    trigrams(`${a.description} ${a.steps.join(' ')}`),
    trigrams(`${b.description} ${b.steps.join(' ')}`),
  )
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
 * v0.3.1: recompute every conflict edge from the current rules.
 *
 * Needed because links are written incrementally: a rule change (or a looser
 * earlier rule) leaves edges on disk that no future write would ever remove.
 * The rebuild strips the edges and the warning sections, then re-links pairs
 * from scratch — the same discipline as `check-docs`, applied to memory.
 */
export function rebuildConflictLinks(skillsDir: string): Array<{ a: string; b: string }> {
  const skills = new Map<string, ExtractedSkill>()
  for (const name of listSkillFiles(skillsDir)) {
    const path = skillPath(skillsDir, name)
    if (!existsSync(path)) continue
    try {
      skills.set(name, parseSkillFile(readFileSync(path, 'utf8'), name))
    } catch {
      // A broken file is skipped, not rewritten.
    }
  }
  for (const name of skills.keys()) {
    const path = skillPath(skillsDir, name)
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    text = text.replace(/^conflicts_with:.*\r?\n/mu, '')
    const cut = text.search(/\r?\n## ⚠️ 冲突提示/u)
    if (cut >= 0) text = `${text.slice(0, cut).trimEnd()}\n`
    atomicWrite(path, text)
  }
  const pairs: Array<{ a: string; b: string }> = []
  const list = [...skills.values()]
  for (let leftIndex = 0; leftIndex < list.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < list.length; rightIndex += 1) {
      const left = list[leftIndex]
      const right = list[rightIndex]
      if (!isConflictingSkill(left, right)) continue
      linkConflictBack(skillsDir, { name: left.name, title: left.title }, right)
      linkConflictBack(skillsDir, { name: right.name, title: right.title }, left)
      pairs.push({ a: left.name, b: right.name })
    }
  }
  return pairs
}

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
  // Two names for the same steps is a duplicate, not a conflict.
  if (methodSimilarity(a, b) >= 0.85) return false
  // v0.17: `scene` is the technology, `domain` is the SYSTEM. Two procedures about
  // different systems are not two ways of doing one thing, however similar their
  // wording — linking them asked the user to choose between unrelated methods.
  if (
    a.domain !== undefined &&
    b.domain !== undefined &&
    a.domain !== 'general' &&
    b.domain !== 'general' &&
    a.domain !== b.domain
  ) {
    return false
  }
  // v0.17: `scene` is the technology, `domain` is the SYSTEM. Two procedures about
  // different systems are not two ways of doing one thing, however similar their
  // wording — linking them asked the user to choose between unrelated methods.
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
    confidence,
    evidence,
  }
}

function listSkillFiles(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** Existing skills whose purpose matches but whose method differs. */
export function findConflicts(skillsDir: string, skill: ExtractedSkill): SkillConflict[] {
  const out: SkillConflict[] = []
  for (const name of listSkillFiles(skillsDir)) {
    if (name === skill.name) continue
    const path = skillPath(skillsDir, name)
    if (!existsSync(path)) continue
    let other: ExtractedSkill
    try {
      other = parseSkillFile(readFileSync(path, 'utf8'), name)
    } catch {
      continue
    }
    if (isConflictingSkill(skill, other)) out.push({ name, title: other.title })
  }
  return out
}

function conflictFooter(conflicts: readonly SkillConflict[]): string[] {
  if (conflicts.length === 0) return []
  return [
    '',
    '## ⚠️ 冲突提示',
    '',
    ...conflicts.map(
      (conflict) => `- 与 \`${conflict.name}\`（${conflict.title}）用途相近但方法不同，选用前先确认场景，不要混用。`,
    ),
    '',
  ]
}
  function parseEvidenceField(raw: string, fallbackSession: string): EvidenceRef[] {
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

function renderSkill(
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
    domain: skill.domain ?? 'general',
    domain: skill.domain ?? 'general',
    // v0.8: provenance for the isolation gate (see workspace.ts). Written even for
    // a `global` skill: `global` decides ELIGIBILITY, the path stays on record for
    // audit. Omitted only when the caller genuinely had no workspace.
    ...(workspace.length === 0 ? {} : { workspace }),
    scene: skill.scene,
    ...(skill.aliases.length === 0 ? {} : { aliases: skill.aliases.join(', ') }),
    confidence: clampConfidence(skill.confidence).toFixed(2),
    evidence: skill.evidence
      .map((ref) => (ref.sourceSessionId.length > 0 ? `${ref.sourceSessionId}@${ref.seq}` : String(ref.seq)))
      .join(','),
    sources: previous === undefined ? 1 : previous.sources,
    ...(conflicts.length === 0 ? {} : { conflicts_with: conflicts.map((conflict) => conflict.name).join(',') }),
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
    '',
    ...conflictFooter(conflicts),
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

function triggerSimilarity(left: string, right: string): number {
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
    for (const conflict of conflicts) linkConflictBack(skillsDir, conflict, skill)
    return 'merged'
  }
  atomicWrite(path, renderSkill(withSession, meta, undefined, conflicts))
  for (const conflict of conflicts) linkConflictBack(skillsDir, conflict, skill)
  return 'created'
}

/**
 * Add the reverse edge on the skill that was already on disk.
 *
 * A one-way link is a trap: whichever skill happens to be retrieved first carries
 * the warning, the other looks authoritative. Both files must name their
 * alternative, and re-writing either one must not duplicate the warning.
 */
function linkConflictBack(skillsDir: string, target: SkillConflict, other: { name: string; title: string }): void {
  const path = skillPath(skillsDir, target.name)
  if (!existsSync(path)) return
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }
  const existing = (text.match(/^conflicts_with:\s*(.+)$/mu)?.[1] ?? '').split(/[,\s]+/u).filter(Boolean)
  const merged = [...new Set([...existing, other.name])]
  const line = `conflicts_with: ${merged.join(',')}`
  if (/^conflicts_with:/mu.test(text)) {
    text = text.replace(/^conflicts_with:.*$/mu, line)
  } else {
    text = text.replace(/^(name:.*)$/mu, `$1\n${line}`)
  }
  const marker = `与 \`${other.name}\`（`
  if (!text.includes(marker)) {
    const mention = `- 与 \`${other.name}\`（${other.title}）用途相近但方法不同，选用前先确认场景，不要混用。`
    text = text.includes('## ⚠️ 冲突提示')
      ? `${text.trimEnd()}\n${mention}\n`
      : `${text.trimEnd()}\n\n## ⚠️ 冲突提示\n\n${mention}\n`
  }
  atomicWrite(path, text)
}

/**
 * v0.15: append one auditable decision line.
 *
 * Why a file and not a log line: the supersede decision is made by a MODEL during
 * retrieval, and it changes what future sessions believe. "Which memory was
 * invalidated, by whom, on what grounds, and when" has to survive the process that
 * made the decision — including a refused decision, which is the more interesting
 * half (it means a guard fired).
 */
export interface MemoryAuditEntry {
  at: string
  kind: 'supersede' | 'supersede-refused'
  winner?: string
  loser?: string
  reason?: string
  detail?: string
  query?: string
  source?: string
}

export function memoryAuditPath(memoryDir: string): string {
  return join(memoryDir, '.memory-audit.jsonl')
}

export function appendMemoryAudit(memoryDir: string, entry: MemoryAuditEntry): void {
  try {
    mkdirSync(memoryDir, { recursive: true })
    const path = memoryAuditPath(memoryDir)
    // APPEND, not replace: the ledger is the point. (atomicWrite writes a whole
    // file, so the previous content is read back and carried forward — the same
    // pattern the JSONL layers use.)
    const previous = existsSync(path) ? readFileSync(path, 'utf8') : ''
    atomicWrite(path, `${previous}${JSON.stringify(entry)}\n`)
  } catch {
    // Audit is evidence, never a gate: a failed line must not change the outcome.
  }
}

export interface SupersedeDecision {
  winner: string
  loser: string
  reason: string
  provenance?: { winner: string; loser: string }
}

export interface SupersedeResult {
  applied: boolean
  status: string
  invalidAt?: string
}

/**
 * v0.15: invalidate an old memory in favour of a new one.
 *
 * The old record is NOT deleted. It gets `invalid_at` (the successor's valid_at),
 * `superseded_by`, and a footer that says why; the successor gets the reverse
 * `supersedes` link. Retrieval then stops activating the old one by the ordinary
 * validity rule, so there is exactly one gate, not two.
 *
 * The human guard lives HERE, not only in the prompt: an inference may not
 * invalidate what a human stated. A prompt rule is a request; this is the refusal.
 */
export function applySupersede(
  memoryDir: string,
  skillsDir: string,
  decision: SupersedeDecision,
  options: { at?: string; query?: string } = {},
): SupersedeResult {
  const winner = String(decision.winner ?? '').trim()
  const loser = String(decision.loser ?? '').trim()
  const at = options.at ?? new Date().toISOString()
  const audit = (kind: MemoryAuditEntry['kind'], extra: Partial<MemoryAuditEntry> = {}): void => {
    appendMemoryAudit(memoryDir, {
      at,
      kind,
      winner,
      loser,
      reason: decision.reason,
      ...(options.query === undefined ? {} : { query: options.query.slice(0, 200) }),
      source: 'llm-filter',
      ...extra,
    })
  }
  if (winner.length === 0 || loser.length === 0 || winner === loser) {
    audit('supersede-refused', { detail: 'winner and loser must be two different skills' })
    return { applied: false, status: 'refused:winner-or-loser-invalid' }
  }
  const winnerPath = skillPath(skillsDir, winner)
  const loserPath = skillPath(skillsDir, loser)
  if (!existsSync(winnerPath) || !existsSync(loserPath)) {
    audit('supersede-refused', { detail: 'one of the two skills is not on disk' })
    return { applied: false, status: 'refused:missing-skill' }
  }
  const winnerSkill = readFileSync(winnerPath, 'utf8')
  const loserSkill = readFileSync(loserPath, 'utf8')
  const winnerValidity = readSkillValidity(winnerSkill)
  const loserValidity = readSkillValidity(loserSkill)

  // The guard: a machine-inferred rule may not retire a human-stated one.
  if (loserValidity.provenance === 'human' && winnerValidity.provenance !== 'human') {
    audit('supersede-refused', {
      detail: `refused: the loser is human-sourced and the winner is ${winnerValidity.provenance}`,
    })
    return { applied: false, status: 'refused:human-loser-protected' }
  }
  // An already-invalidated record is a timeline, not a conflict to re-open.
  if (loserValidity.invalidAt.length > 0) {
    return { applied: false, status: 'skipped:already-invalid' }
  }

  const reason = String(decision.reason ?? '').replace(/\s+/gu, ' ').trim().slice(0, 300)
  let loserText = loserSkill
  const invalidLine = `invalid_at: ${at}`
  loserText = /^invalid_at:/mu.test(loserText)
    ? loserText.replace(/^invalid_at:.*$/mu, invalidLine)
    : loserText.replace(/^(name:.*)$/mu, `$1\n${invalidLine}`)
  const supersededLine = `superseded_by: ${winner}`
  loserText = /^superseded_by:/mu.test(loserText)
    ? loserText.replace(/^superseded_by:.*$/mu, supersededLine)
    : loserText.replace(/^(name:.*)$/mu, `$1\n${supersededLine}`)
  if (!loserText.includes(`\`${winner}\``)) {
    const mention = `- 已被 \`${winner}\` 取代（${at.slice(0, 10)}${reason.length === 0 ? '' : `：${reason}`}）；不要再按本技能执行。`
    loserText = loserText.includes('## ⚠️ 已被取代')
      ? `${loserText.trimEnd()}\n${mention}\n`
      : `${loserText.trimEnd()}\n\n## ⚠️ 已被取代\n\n${mention}\n`
  }

  let winnerText = winnerSkill
  const existingSupersedes = winnerValidity.supersedes
  const merged = [...new Set([...existingSupersedes, loser])]
  const supersedesLine = `supersedes: ${merged.join(',')}`
  winnerText = /^supersedes:/mu.test(winnerText)
    ? winnerText.replace(/^supersedes:.*$/mu, supersedesLine)
    : winnerText.replace(/^(name:.*)$/mu, `$1\n${supersedesLine}`)
  if (!winnerText.includes(`\`${loser}\``)) {
    const mention = `- 取代了 \`${loser}\`（${at.slice(0, 10)}${reason.length === 0 ? '' : `：${reason}`}）。`
    winnerText = winnerText.includes('## 取代')
      ? `${winnerText.trimEnd()}\n${mention}\n`
      : `${winnerText.trimEnd()}\n\n## 取代\n\n${mention}\n`
  }

  atomicWrite(loserPath, loserText)
  atomicWrite(winnerPath, winnerText)
  audit('supersede')
  return { applied: true, status: 'superseded', invalidAt: at }
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object') out.push(parsed)
    } catch {
      // A torn line must not erase the rest of the ledger.
    }
  }
  return out
}

/**
 * v0.15 UI: the catalogue the console renders.
 *
 * One row per stored skill, carrying exactly what a human needs to judge it —
 * scene, scope, workspace, provenance, validity window, supersession — because a
 * list that shows only names forces the user back into the filesystem, which is
 * the problem the console exists to remove.
 */
export interface SkillRecord {
  name: string
  title: string
  description: string
  when: string
  scope: string
  scene: string
  workspace: string
  provenance: MemoryProvenance
  validAt: string
  invalidAt: string
  supersededBy: string
  supersedes: string[]
  evidence: number
  path: string
}

export function listSkillRecords(skillsDir: string): SkillRecord[] {
  const out: SkillRecord[] = []
  let names: string[] = []
  try {
    names = readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return out
  }
  for (const name of names) {
    const path = skillPath(skillsDir, name)
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const validity = readSkillValidity(text)
    const field = (key: string): string => (text.match(new RegExp(`^${key}:\\s*(.+)$`, 'mu'))?.[1] ?? '').trim()
    const scene = field('scene').toLowerCase()
    out.push({
      name,
      title: (text.match(/^#\s+(.+)$/mu)?.[1] ?? name).trim(),
      description: field('description'),
      when: field('when_to_use') || field('when'),
      scope: field('scope') || 'project',
      scene: /^[a-z][a-z0-9-]{1,23}$/u.test(scene) ? scene : 'general',
      workspace: validity.validAt === '' && field('workspace') === '' ? '' : normalizeWorkspace(field('workspace')),
      provenance: validity.provenance,
      validAt: validity.validAt,
      invalidAt: validity.invalidAt,
      supersededBy: validity.supersededBy,
      supersedes: validity.supersedes,
      evidence: (field('evidence').split(',').filter((part) => part.trim().length > 0)).length,
      path,
    })
  }
  out.sort((left, right) => left.name.localeCompare(right.name))
  return out
}

export interface QuarantineResult {
  quarantineDir: string
  skills: string[]
  negatives: number
  kept: number
}

/**
 * v0.15 UI: "clear this workspace's memory" — as a MOVE, never a delete.
 *
 * A debugging convenience that erases data is a trap: the user clicks it once,
 * loses three weeks of learned rules, and never trusts the console again. So the
 * records are moved into a timestamped quarantine next to the store (same volume,
 * so the move is atomic) and the report names every file, which is also the
 * restore list.
 *
 * Matching is by the SAME rule retrieval uses (`memoryAllowsWorkspace`): records
 * from the given workspace, plus unscoped ones when `includeUnscoped` is set.
 * `global` records are never touched — they were deliberately made global.
 */
export function quarantineWorkspaceMemory(
  memoryDir: string,
  skillsDir: string,
  workspace: string,
  options: { includeUnscoped?: boolean; at?: string; skillsOnly?: boolean } = {},
): QuarantineResult {
  const stamp = (options.at ?? new Date().toISOString()).replace(/[:.]/gu, '-')
  const quarantineDir = join(memoryDir, `_quarantine-${stamp}`)
  const moved: string[] = []
  let negatives = 0
  let kept = 0

  let names: string[] = []
  try {
    names = readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    names = []
  }
  for (const name of names) {
    const path = skillPath(skillsDir, name)
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const validity = readSkillValidity(text)
    const scope = (text.match(/^scope:\s*(.+)$/mu)?.[1] ?? 'project').trim().toLowerCase()
    if (scope === 'global') {
      kept += 1
      continue
    }
    const recorded = readSkillWorkspace(text)
    const unscoped = recorded.length === 0
    const same = unscoped ? options.includeUnscoped === true : recorded === normalizeWorkspace(workspace)
    if (!same) {
      kept += 1
      continue
    }
    mkdirSync(join(quarantineDir, 'skills', name), { recursive: true })
    renameSync(path, join(quarantineDir, 'skills', name, 'SKILL.md'))
    rmSync(join(skillsDir, name), { recursive: true, force: true })
    moved.push(name)
    void validity
  }

  if (options.skillsOnly !== true) {
    /**
     * v0.31 P0 — THE QUARANTINE PATH WAS AN UNLOCKED READ-MODIFY-WRITE.
     *
     * This block reads ALL of `negatives.jsonl`, partitions it, and rewrites the
     * remainder. It took no lock, so a harvest appending a record at that moment had its
     * row silently erased by the rewrite — the same lost update the other five paths
     * were fixed for, in the one place nobody looked: a maintenance/diagnostic operation
     * that "cannot happen concurrently" in theory, and does in practice because a
     * harvest runs on its own timer.
     *
     * The lock is taken around the read AND the writes, and the read is INSIDE it — a
     * value read before taking the lock is stale by definition.
     */
    const path = join(memoryDir, 'negatives.jsonl')
    if (existsSync(path)) {
      const release = acquireFileLock(`${path}.lock`, { label: 'quarantineNegatives' })
      try {
        const records = readJsonl(path)
        const keep: Array<Record<string, unknown>> = []
        const drop: Array<Record<string, unknown>> = []
        for (const record of records) {
          const scope = String(record.scope ?? 'project').toLowerCase()
          if (scope === 'global') {
            keep.push(record)
            continue
          }
          const recorded = normalizeWorkspace(record.workspace)
          const unscoped = recorded.length === 0
          const same = unscoped ? options.includeUnscoped === true : recorded === normalizeWorkspace(workspace)
          if (same) drop.push(record)
          else keep.push(record)
        }
        if (drop.length > 0) {
          mkdirSync(quarantineDir, { recursive: true })
          atomicWrite(join(quarantineDir, 'negatives.jsonl'), drop.map((record) => JSON.stringify(record)).join('\n') + '\n')
          atomicWrite(path, keep.map((record) => JSON.stringify(record)).join('\n') + (keep.length > 0 ? '\n' : ''))
          negatives = drop.length
        }
      } finally {
        release()
      }
    }
  }

  if (moved.length > 0 || negatives > 0) {
    mkdirSync(quarantineDir, { recursive: true })
    atomicWrite(
      join(quarantineDir, 'MANIFEST.json'),
      JSON.stringify({ at: new Date().toISOString(), workspace: normalizeWorkspace(workspace), skills: moved, negatives, kept }, null, 2) + '\n',
    )
  }
  return { quarantineDir, skills: moved, negatives, kept }
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

export function appendNegatives(memoryDir: string, negatives: ExtractedNegative[], meta: SkillMeta): number {
  if (negatives.length === 0) return 0
  const workspace = normalizeWorkspace(meta.workspace)
  const path = join(memoryDir, 'negatives.jsonl')
  const existing = readJsonl(path)
  let appended = 0
  let dirty = false
  // v0.25 P1: the read above and the write below are ONE critical section. Two
  // harvests appending different negatives used to keep only the later file, silently
  // dropping the other session's warning.
  const release = acquireFileLock(`${path}.lock`, { label: 'appendNegatives' })
  try {
    // Re-read INSIDE the lock: whatever we saw before may already be stale.
    existing.length = 0
    existing.push(...readJsonl(path))
    appended = 0
    dirty = false
    for (const negative of negatives) {
      if (scanThreat(`${negative.symptom} ${negative.cause} ${negative.avoid}`) !== undefined) continue
      // Gates ② (exact) and ④ (same symptom, different cause → link, never merge).
      const plan = planNegative(existing as never, negative)
      if (plan.duplicate) {
        const same = existing.find((record) =>
          plan.conflicts.length === 0 &&
          String(record.symptom) === negative.symptom &&
          String(record.cause) === negative.cause,
        )
        if (same !== undefined) {
          const keyOf = (ref: any): string => (ref !== null && typeof ref === 'object' ? `${ref.sourceSessionId}@${ref.seq}` : String(ref))
          const merged = [...new Map([...(Array.isArray(same.evidence) ? same.evidence : []), ...negative.evidence].map((ref) => [keyOf(ref), ref])).values()]
          same.evidence = merged
          same.hits = Number(same.hits ?? 0) + 1
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
        at: meta.at ?? new Date().toISOString(),
        hits: 1,
        // v0.8: same isolation contract as SKILL.md.
        ...(workspace.length === 0 ? {} : { workspace }),
        // v0.15: the same bi-temporal + trust contract as SKILL.md, so a negative
        // can be superseded (and stop being retrieved) without being deleted.
        provenance: negative.provenance ?? meta.provenance ?? 'inferred',
        valid_at: meta.validAt ?? meta.at ?? new Date().toISOString(),
        ...(plan.conflicts.length === 0 ? {} : { conflictsWith: plan.conflicts }),
      })
      appended += 1
      dirty = true
    }
    if (!dirty) return 0
    atomicWrite(path, existing.map((record) => JSON.stringify(record)).join('\n') + '\n')
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

/**
 * v0.5: counter-evidence — the ONLY mechanism that can weaken a stored rule.
 *
 * A negative path says "doing A fails". When a later session does A and it
 * SUCCEEDS, the rule has been falsified in practice. Silently keeping it at full
 * weight is how a stale rule becomes a permanent prohibition; deleting it on one
 * success is the opposite mistake (the old failure may still happen elsewhere).
 * So: record the seq as `counterEvidence`, lower `confidence` by a step, and let
 * retrieval rank it down. The rule survives, visibly weakened, with its receipt.
 */
export interface CounterEvidenceResult {
  updated: Array<{ symptom: string; seq: number; confidence: number }>
  scannedResults: number
}

export function recordCounterEvidence(
  memoryDir: string,
  events: readonly { type?: string; seq?: number; data?: any }[],
): CounterEvidenceResult {
  const path = join(memoryDir, 'negatives.jsonl')
  const records = readJsonl(path)
  if (records.length === 0) return { updated: [], scannedResults: 0 }

  const callNames = new Map<string, string>()
  const successes: Array<{ seq: number; tool: string; text: string }> = []
  for (const event of events) {
    if (event?.type === 'tool/call') {
      const callId = typeof event.data?.callId === 'string' ? event.data.callId : ''
      const name = typeof event.data?.name === 'string' ? event.data.name : ''
      if (callId.length > 0 && name.length > 0) callNames.set(callId, name)
      continue
    }
    if (event?.type !== 'tool/result') continue
    const message = event.data?.message
    if (message?.isError === true || event.data?.error !== undefined) continue
    const callId = message?.source?.callId ?? message?.toolCallId
    const tool = typeof callId === 'string' ? (callNames.get(String(callId)) ?? '') : ''
    if (tool.length === 0) continue
    const content = Array.isArray(message?.content) ? message.content : []
    const text = content
      .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
      .map((block: any) => block.text)
      .join(' ')
    successes.push({ seq: Number(event.seq ?? 0), tool, text: text.slice(0, 2000) })
  }

  const updated: CounterEvidenceResult['updated'] = []
  let dirty = false
  // v0.25 P1: read and write in ONE critical section. This function rewrites the whole
  // negatives file; without the lock, a concurrent `appendNegatives` or a second
  // counter sweep would be erased by whichever wrote last.
  const release = acquireFileLock(`${path}.lock`, { label: 'recordCounterEvidence' })
  try {
    records.length = 0
    records.push(...readJsonl(path))
    updated.length = 0
    dirty = false
    for (const record of records) {
      const symptom = String(record.symptom ?? '')
      const cause = String(record.cause ?? '')
      const avoid = String(record.avoid ?? '')
      const haystack = `${symptom} ${cause} ${avoid}`
      const tokens = new Set(
        (haystack.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/gu) ?? []).filter(
          (token) => !['the', 'and', 'with', 'for', 'this', 'that', 'from', 'then', 'than', 'into'].includes(token),
        ),
      )
      if (tokens.size === 0) continue
      const seen = new Set((Array.isArray(record.counterEvidence) ? record.counterEvidence : []).map(Number))
      for (const success of successes) {
        if (seen.has(success.seq)) continue
        if (!tokens.has(success.tool.toLowerCase())) continue
        // The success must not still show the symptom it is supposed to refute.
        const symptomWords = (symptom.match(/[\u4e00-\u9fff]{2,}/gu) ?? []).slice(0, 3)
        if (symptomWords.some((word) => success.text.includes(word))) continue
        const counter = [...seen, success.seq]
        seen.add(success.seq)
        record.counterEvidence = counter
        const confidence = Number(record.confidence ?? 1)
        record.confidence = Math.max(0.2, Math.round((confidence - 0.2) * 100) / 100)
        record.lastCounterAt = new Date().toISOString()
        updated.push({ symptom: symptom.slice(0, 80), seq: success.seq, confidence: Number(record.confidence) })
        dirty = true
      }
    }
    if (dirty) atomicWrite(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
    return { updated, scannedResults: successes.length }
  } finally {
    release()
  }
}

/** v0.7: record that a recalled skill was actually used (drives decay). */
export function touchSkillUsage(skillsDir: string, name: string, at?: string): boolean {
  const path = skillPath(skillsDir, name)
  if (!existsSync(path)) return false
  try {
    let text = readFileSync(path, 'utf8')
    const stamp = at ?? new Date().toISOString()
    text = /^last_used:/mu.test(text)
      ? text.replace(/^last_used:.*$/mu, `last_used: ${stamp}`)
      : text.replace(/^(name:.*)$/mu, `$1\nlast_used: ${stamp}`)
    atomicWrite(path, text)
    return true
  } catch {
    return false
  }
}

export type SkillFeedback = 'positive' | 'negative'

export interface FeedbackResult {
  updated: Array<{ name: string; outcome: SkillFeedback; confidence: number }>
  missing: string[]
}

/**
 * v0.7.1: the use-effect loop.
 *
 * Extraction can only prove that a procedure was written down; it cannot prove
 * the procedure still works. turn-stopping knows the outcome of the turn that
 * actually used the skill: a clean turn (no failed tool result) confirms it, a
 * turn that retried after an error weakens it. This is the ONLY automatic
 * mechanism that can raise confidence — and it raises it by a small step, so a
 * lucky turn cannot launder a bad skill.
 */
export function applySkillFeedback(
  skillsDir: string,
  names: readonly string[],
  outcome: SkillFeedback,
  at?: string,
): FeedbackResult {
  const stamp = at ?? new Date().toISOString()
  const updated: FeedbackResult['updated'] = []
  const missing: string[] = []
  const seen = new Set<string>()
  for (const raw of names) {
    const name = String(raw ?? '').trim()
    if (name.length === 0 || seen.has(name)) continue
    seen.add(name)
    const path = skillPath(skillsDir, name)
    if (!existsSync(path)) {
      missing.push(name)
      continue
    }
    try {
      let text = readFileSync(path, 'utf8')
      const previous = clampConfidence(text.match(/^confidence:\s*(.+)$/mu)?.[1])
      const next = outcome === 'positive' ? Math.min(1, Math.round((previous + 0.05) * 100) / 100) : Math.max(0.2, Math.round((previous - 0.1) * 100) / 100)
      text = /^confidence:/mu.test(text)
        ? text.replace(/^confidence:.*$/mu, `confidence: ${next.toFixed(2)}`)
        : text.replace(/^(name:.*)$/mu, `$1\nconfidence: ${next.toFixed(2)}`)
      text = /^last_feedback:/mu.test(text)
        ? text.replace(/^last_feedback:.*$/mu, `last_feedback: ${outcome}`)
        : text.replace(/^(name:.*)$/mu, `$1\nlast_feedback: ${outcome}`)
      if (outcome === 'positive') {
        // Confirmed in use = validated now; this restarts the decay clock.
        text = /^last_validated:/mu.test(text)
          ? text.replace(/^last_validated:.*$/mu, `last_validated: ${stamp}`)
          : text.replace(/^(name:.*)$/mu, `$1\nlast_validated: ${stamp}`)
      }
      atomicWrite(path, text)
      updated.push({ name, outcome, confidence: next })
    } catch {
      missing.push(name)
    }
  }
  return { updated, missing }
}

export interface EvidenceMigrationResult {
  sessionId: string
  /** SKILL.md files whose `evidence:` tokens were rewritten. */
  skills: Array<{ name: string; rewritten: number }>
  negatives: number
  facts: number
  experiences: number
  /** Entries that already carried `session@seq` (or a sourceSessionId). */
  already: number
}

/**
 * v0.7.1: ONE-SHOT legacy repair for the v0.5/v0.6 bare-seq era.
 *
 * Before the composite key, `evidence: 14926` was stored without a session id.
 * After a generation hop that seq is meaningless: `graft_read_result` needs the
 * session. The migration attaches the given session id to every bare pointer. It
 * is explicit (a tool the user calls), never a silent rewrite on activation: a
 * wrong attribution is worse than a visible missing one.
 */
export function migrateBareEvidence(memoryDir: string, skillsDir: string, sessionId: string): EvidenceMigrationResult {
  const session = String(sessionId ?? '').trim()
  if (session.length === 0) throw new Error('migrateBareEvidence: a sourceSessionId is required')
  const result: EvidenceMigrationResult = { sessionId: session, skills: [], negatives: 0, facts: 0, experiences: 0, already: 0 }

  for (const name of listSkillFiles(skillsDir)) {
    const path = skillPath(skillsDir, name)
    if (!existsSync(path)) continue
    try {
      let text = readFileSync(path, 'utf8')
      const line = text.match(/^evidence:\s*(.+)$/mu)
      if (line === null) continue
      const tokens = line[1].split(/[,\s]+/u).filter(Boolean)
      let rewritten = 0
      let composite = 0
      const next = tokens.map((token) => {
        if (token.includes('@')) {
          composite += 1
          return token
        }
        rewritten += 1
        return `${session}@${token}`
      })
      result.already += composite
      if (rewritten === 0) continue
      text = text.replace(/^evidence:.*$/mu, `evidence: ${next.join(',')}`)
      atomicWrite(path, text)
      result.skills.push({ name, rewritten })
    } catch {
      // A file that cannot be parsed keeps its pointers; it is reported elsewhere.
    }
  }

  const migrateJsonl = (file: string, key: 'negatives' | 'facts' | 'experiences'): void => {
    const path = join(memoryDir, file)
    if (!existsSync(path)) return
    // v0.25 P1: this is a whole-file rewrite (attach a sessionId to every bare seq), so
    // it takes the same lock as the writers it would otherwise clobber. The read must be
    // INSIDE the lock, or a concurrent append is silently dropped.
    const release = acquireFileLock(`${path}.lock`, { label: `migrateEvidence:${file}` })
    try {
      const records = readJsonl(path)
      let changed = 0
      for (const record of records) {
        const evidence = Array.isArray(record.evidence) ? record.evidence : []
        let dirty = false
        const merged: unknown[] = []
        for (const item of evidence) {
          if (item !== null && typeof item === 'object' && Number.isFinite(Number((item as any).seq))) {
            if (typeof (item as any).sourceSessionId !== 'string' || String((item as any).sourceSessionId).length === 0) {
              merged.push({ sourceSessionId: session, seq: Number((item as any).seq) })
              dirty = true
            } else {
              merged.push(item)
            }
            result.already += 1
            continue
          }
          const seq = Number(item)
          if (Number.isFinite(seq)) {
            merged.push({ sourceSessionId: session, seq })
            dirty = true
            continue
          }
          merged.push(item)
        }
        if (!dirty) continue
        record.evidence = merged
        if (typeof record.sourceSessionId !== 'string' || String(record.sourceSessionId).length === 0) record.sourceSessionId = session
        changed += 1
      }
      if (changed > 0) atomicWrite(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
      result[key] = changed
    } finally {
      release()
    }
  }
  migrateJsonl('negatives.jsonl', 'negatives')
  migrateJsonl('facts.jsonl', 'facts')
  migrateJsonl('experiences.jsonl', 'experiences')
  return result
}

/** v0.7: new evidence re-validates a skill (cancels decay for 14 days). */
export function markSkillValidated(skillsDir: string, name: string, at?: string): boolean {
  const path = skillPath(skillsDir, name)
  if (!existsSync(path)) return false
  try {
    let text = readFileSync(path, 'utf8')
    const stamp = at ?? new Date().toISOString()
    text = /^last_validated:/mu.test(text)
      ? text.replace(/^last_validated:.*$/mu, `last_validated: ${stamp}`)
      : text.replace(/^(name:.*)$/mu, `$1\nlast_validated: ${stamp}`)
    atomicWrite(path, text)
    return true
  } catch {
    return false
  }
}

/** Append facts/experiences, merging evidence (never instructions, only pointers). */
function appendLayer(
  memoryDir: string,
  file: string,
  entries: ReadonlyArray<{ text: string; seq: number; scene?: string }>,
  meta: SkillMeta,
): number {
  if (entries.length === 0) return 0
  const workspace = normalizeWorkspace(meta.workspace)
  const path = join(memoryDir, file)
  const existing = readJsonl(path) as unknown as LayerRecord[]
  let appended = 0
  let dirty = false
  // v0.25 P1: facts and experiences are appended by whole-file rewrite too, so two
  // harvests racing here lose one session's observations exactly as negatives would.
  const release = acquireFileLock(`${path}.lock`, { label: `appendLayer:${file}` })
  try {
    existing.length = 0
    existing.push(...(readJsonl(path) as unknown as LayerRecord[]))
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
      dirty = true
      continue
    }
    existing.push({
      text: entry.text,
      scene: /^[a-z][a-z0-9-]{1,23}$/u.test(String(entry.scene ?? '')) ? String(entry.scene) : 'general',
      domain: /^[a-z][a-z0-9-]{1,31}$/u.test(String(entry.domain ?? '').toLowerCase()) ? String(entry.domain).toLowerCase() : 'general',
      domain: /^[a-z][a-z0-9-]{1,31}$/u.test(String(entry.domain ?? '').toLowerCase()) ? String(entry.domain).toLowerCase() : 'general',
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
    atomicWrite(path, existing.map((record) => JSON.stringify(record)).join('\n') + '\n')
    return appended
  } finally {
    release()
  }
}

export function appendFacts(memoryDir: string, facts: readonly ExtractedFact[], meta: SkillMeta): number {
  return appendLayer(memoryDir, 'facts.jsonl', facts, meta)
}

export function appendExperiences(memoryDir: string, experiences: readonly ExtractedExperience[], meta: SkillMeta): number {
  return appendLayer(memoryDir, 'experiences.jsonl', experiences, meta)
}

export function processedKey(sessionId: string, boundarySeq: number): string {
  return `${sessionId}:${boundarySeq}`
}

/**
 * v0.22 P0: read-modify-write a JSON array under a FILE LOCK.
 *
 * `atomicWrite` closes the torn-read window; it does not close the lost-update
 * window. Two harvests that both read `processed.json`, add their own key and write
 * back will keep only the second key — the first session looks unprocessed and gets
 * mined again. The lock is what makes the RMW a single step.
 */
function updateJsonArrayFile(path: string, mutate: (keys: Set<string>) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  withFileLock(`${path}.lock`, () => {
    const keys = (() => {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'))
        if (!Array.isArray(parsed)) return new Set<string>()
        return new Set(parsed.filter((value): value is string => typeof value === 'string'))
      } catch {
        return new Set<string>()
      }
    })()
    mutate(keys)
    atomicWrite(path, JSON.stringify([...keys], null, 2) + '\n')
  })
}

export function readProcessed(memoryDir: string): Set<string> {
  const path = join(memoryDir, 'processed.json')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((value): value is string => typeof value === 'string'))
  } catch {
    return new Set()
  }
}

/**
 * Record that a session boundary was mined.
 *
 * v0.22 P0: locked RMW. The previous version read, mutated in memory and replaced the
 * whole file, so a concurrent harvest's key vanished. `processed.json` is the ONLY
 * guard against mining the same boundary twice, which makes a lost key a duplicate
 * skill, not a cosmetic counter.
 *
 * Pass `{ expected: false }` to make this a no-op when the boundary is already
 * recorded — that is what a retry-after-failure needs, and it must not resurrect a
 * cursor another writer already advanced.
 */
export function markProcessed(memoryDir: string, key: string): void {
  updateJsonArrayFile(join(memoryDir, 'processed.json'), (keys) => {
    keys.add(key)
  })
}

/** v0.22: is this boundary already recorded? A READ, safe without the lock. */
export function isProcessed(memoryDir: string, key: string): boolean {
  return readProcessed(memoryDir).has(key)
}

export interface MemoryStats {
  skills: number
  negatives: number
  facts: number
  experiences: number
  processed: number
  memoryDir: string
  skillsDir: string
}

function countJsonl(path: string): number {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean).length
  } catch {
    return 0
  }
}

export function stats(memoryDir: string, skillsDir: string): MemoryStats {
  const skills = (() => {
    try {
      return readdirNames(skillsDir).length
    } catch {
      return 0
    }
  })()
  return {
    skills,
    negatives: countJsonl(join(memoryDir, 'negatives.jsonl')),
    facts: countJsonl(join(memoryDir, 'facts.jsonl')),
    experiences: countJsonl(join(memoryDir, 'experiences.jsonl')),
    processed: readProcessed(memoryDir).size,
    memoryDir,
    skillsDir,
  }
}

function readdirNames(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

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
  }
}