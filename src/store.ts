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

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import type { ExtractedExperience, ExtractedFact, ExtractedNegative, ExtractedSkill } from './extract.js'
import { jaccard, planNegative, trigrams } from './dedupe.js'

export function defaultSkillsDir(): string {
  return join(homedir(), '.agents', 'skills')
}

export function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/**
 * Same rule as the ecosystem's memory plugins: memory content is DATA, never an
 * instruction. Text that tries to rewrite the reader's rules is refused at the
 * write boundary, because a later prompt will happily quote it verbatim.
 */
const THREAT = [
  /ignore\s+(all\s+)?(previous|prior|earlier|above|your)\s+(instructions?|prompts?|rules?)/iu,
  /disregard\s+(all\s+)?(previous|prior|earlier|above|your)\s+(instructions?|prompts?|rules?)/iu,
  /忽略[^。\n]{0,16}(指令|指示|提示|规则)/u,
  /无视[^。\n]{0,16}(指令|指示|提示|规则)/u,
]

export function scanThreat(text: string): string | undefined {
  for (const pattern of THREAT) if (pattern.test(text)) return 'contains prompt-injection phrasing'
  return undefined
}

export function skillPath(skillsDir: string, name: string): string {
  return join(skillsDir, name, 'SKILL.md')
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
  evidence: number[]
}

export function normalizeSkill(input: SkillInput | ExtractedSkill): ExtractedSkill {
  const raw = input as SkillInput
  const when = String(raw.when_to_use ?? raw.when ?? '').replace(/\s+/gu, ' ').trim()
  const steps = (raw.steps ?? raw.how ?? []).map((step) => String(step).replace(/\s+/gu, ' ').trim()).filter(Boolean)
  const verify = (raw.verify ?? raw.verification ?? []).map((line) => String(line).replace(/\s+/gu, ' ').trim()).filter(Boolean)
  const scope = String(raw.scope ?? '').toLowerCase()
  const aliases = (Array.isArray(raw.aliases) ? raw.aliases : [])
    .map((alias) => String(alias).replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .slice(0, 3)
  return {
    name: String(raw.name ?? '').toLowerCase(),
    title: String(raw.title ?? raw.name ?? ''),
    description: String(raw.description ?? when).replace(/\s+/gu, ' ').trim(),
    when,
    steps,
    verify,
    scope: scope === 'workspace' || scope === 'global' ? scope : 'project',
    aliases,
    evidence: Array.isArray(raw.evidence) ? raw.evidence.map(Number).filter(Number.isFinite) : [],
  }
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
  const evidence = (text.match(/^evidence:\s*(.+)$/mu)?.[1] ?? '').split(/[,\s]+/u).filter(Boolean).map(Number)
  const scopeText = (text.match(/^scope:\s*(.+)$/mu)?.[1] ?? '').trim().toLowerCase()
  const aliases = (text.match(/^aliases:\s*(.+)$/mu)?.[1] ?? '').split(/,/u).map((item) => item.trim()).filter(Boolean)
  return {
    name,
    title,
    description,
    when,
    steps,
    verify: [],
    scope: scopeText === 'workspace' || scopeText === 'global' ? scopeText : 'project',
    aliases,
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
  function renderSkill(
  skill: ExtractedSkill,
  meta: SkillMeta,
  previous?: { evidence: number; sources: number; created: string; lastUsed?: string; lastValidated?: string },
  conflicts: readonly SkillConflict[] = [],
): string {
  const now = meta.at ?? new Date().toISOString().slice(0, 10)
  const fields: Record<string, string | number> = {
    name: skill.name,
    description: skill.description.slice(0, 160),
    when_to_use: skill.when.slice(0, 200),
    scope: skill.scope,
    ...(skill.aliases.length === 0 ? {} : { aliases: skill.aliases.join(', ') }),
    evidence: skill.evidence.join(','),
    sources: previous === undefined ? 1 : previous.sources,
    ...(conflicts.length === 0 ? {} : { conflicts_with: conflicts.map((conflict) => conflict.name).join(',') }),
  }
  if (previous !== undefined && previous.created.length > 0) {
    fields.created = previous.created
    fields.updated = now
  } else {
    fields.created = now
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
    `- 源会话：${meta.sessionId}（seq ${skill.evidence.join(', ')}）`,
    '',
    ...conflictFooter(conflicts),
  ].join('\n')
}

/** Create or merge one skill. Returns `created`, `merged`, or `skipped:<reason>`. */
export function writeSkill(skillsDir: string, input: SkillInput | ExtractedSkill, meta: SkillMeta): string {
  const skill = normalizeSkill(input)
  if (skill.steps.length === 0) return 'skipped:no execution steps'
  if (skill.verify.length === 0) return 'skipped:no verification criterion'
  const threat = scanThreat(`${skill.title} ${skill.description} ${skill.when} ${skill.steps.join(' ')} ${skill.verify.join(' ')}`)
  if (threat !== undefined) return `skipped:${threat}`
  // v0.3: record mutually exclusive alternatives instead of storing both silently.
  const conflicts = findConflicts(skillsDir, skill)
  const path = skillPath(skillsDir, skill.name)
  if (existsSync(path)) {
    // Merge: keep the earliest evidence, refresh the wording, count the use of
    // the *provenance* (sessions that confirmed it), never duplicate the file.
    const previousText = readFileSync(path, 'utf8')
    const evidence = previousText.match(/^evidence:\s*(.+)$/mu)?.[1] ?? ''
    const merged = [...new Set([...evidence.split(/[,\s]+/u).filter(Boolean), ...skill.evidence.map(String)])]
    const sources = Number(previousText.match(/^sources:\s*(\d+)$/mu)?.[1] ?? '1')
    const created = previousText.match(/^created:\s*(.+)$/mu)?.[1] ?? ''
    const lastUsed = previousText.match(/^last_used:\s*(.+)$/mu)?.[1] ?? undefined
    const lastValidated = previousText.match(/^last_validated:\s*(.+)$/mu)?.[1] ?? undefined
    const mergedSkill: ExtractedSkill = { ...skill, evidence: merged.map(Number).filter(Number.isFinite) }
    atomicWrite(path, renderSkill(mergedSkill, meta, { evidence: merged.length, sources: sources + 1, created, lastUsed, lastValidated }, conflicts))
    for (const conflict of conflicts) linkConflictBack(skillsDir, conflict, skill)
    return 'merged'
  }
  atomicWrite(path, renderSkill(skill, meta, undefined, conflicts))
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

export function appendNegatives(memoryDir: string, negatives: ExtractedNegative[], meta: SkillMeta): number {
  if (negatives.length === 0) return 0
  const path = join(memoryDir, 'negatives.jsonl')
  const existing = readJsonl(path)
  let appended = 0
  let dirty = false
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
        const merged = [...new Set([...(Array.isArray(same.evidence) ? same.evidence.map(Number) : []), ...negative.evidence])]
        same.evidence = merged
        same.hits = Number(same.hits ?? 0) + 1
        dirty = true
      }
      continue
    }
    existing.push({
      ...negative,
      scope: negative.scope ?? 'project',
      // v0.5: confidence starts at 1 and is lowered by counter-evidence, never
      // raised by repetition alone (a repeated failure is not a stronger rule).
      confidence: 1,
      counterEvidence: [],
      sourceSessionId: meta.sessionId,
      boundarySeq: meta.boundarySeq,
      at: meta.at ?? new Date().toISOString(),
      hits: 1,
      ...(plan.conflicts.length === 0 ? {} : { conflictsWith: plan.conflicts }),
    })
    appended += 1
    dirty = true
  }
  if (!dirty) return 0
  atomicWrite(path, existing.map((record) => JSON.stringify(record)).join('\n') + '\n')
  return appended
}

interface LayerRecord {
  text: string
  evidence: number[]
  sourceSessionId: string
  boundarySeq: number
  at: string
  hits: number
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
}

/** v0.5: record that a recalled skill was actually used (drives decay). */
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

/** v0.5: new evidence re-validates a skill (cancels decay for 14 days). */
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
function appendLayer(memoryDir: string, file: string, entries: ReadonlyArray<{ text: string; seq: number }>, meta: SkillMeta): number {
  if (entries.length === 0) return 0
  const path = join(memoryDir, file)
  const existing = readJsonl(path) as unknown as LayerRecord[]
  let appended = 0
  let dirty = false
  for (const entry of entries) {
    if (scanThreat(entry.text) !== undefined) continue
    const same = existing.find((record) => record.text === entry.text)
    if (same !== undefined) {
      const merged = [...new Set([...(Array.isArray(same.evidence) ? same.evidence.map(Number) : []), entry.seq])]
      same.evidence = merged
      same.hits = Number(same.hits ?? 0) + 1
      dirty = true
      continue
    }
    existing.push({
      text: entry.text,
      evidence: [entry.seq],
      sourceSessionId: meta.sessionId,
      boundarySeq: meta.boundarySeq,
      at: meta.at ?? new Date().toISOString(),
      hits: 1,
    })
    appended += 1
    dirty = true
  }
  if (!dirty) return 0
  atomicWrite(path, existing.map((record) => JSON.stringify(record)).join('\n') + '\n')
  return appended
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

export function markProcessed(memoryDir: string, key: string): void {
  const keys = readProcessed(memoryDir)
  keys.add(key)
  atomicWrite(join(memoryDir, 'processed.json'), JSON.stringify([...keys], null, 2) + '\n')
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