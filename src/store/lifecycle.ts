/**
 * THE LIFECYCLE OF A STORED SKILL — step A2 of the `store.ts` split.
 *
 * WHAT IS HERE: everything that changes a skill AFTER it has been written —
 *
 *   - supersession   (`applySupersede`): a newer statement invalidates an older one, both ways linked
 *   - counter-evidence (`recordCounterEvidence`): a success weakens a rule, it never deletes it
 *   - feedback       (`applySkillFeedback` / `touchSkillUsage` / `markSkillValidated`)
 *   - migration      (`migrateBareEvidence`): old rows carry bare seqs, new ones carry sid@seq
 *   - quarantine     (`quarantineWorkspaceMemory`): clearing one workspace must MOVE its records aside
 *   - audit          (`appendMemoryAudit` / `rotateAuditIfNeeded` / `memoryAuditPath`)
 *   - conflict links (`rebuildConflictLinks` / `conflictFooter`)
 *
 * WHY THESE ARE TOGETHER: every one of them is a state TRANSITION over records that already exist on
 * disk, and every one of them writes an audit trail explaining itself. Keeping them apart would leave
 * "who is allowed to change a stored memory, and where is it recorded" answerable only by reading the
 * whole store.
 *
 * ── WHAT DID NOT COME WITH IT (measured, not assumed) ────────────────────────────────────────────
 *
 * `SkillRecord` and `listSkillRecords` sat INSIDE the moved line range but are NOT in this cluster:
 * they are the console's read-only catalogue (one row per skill for the UI) and neither calls nor is
 * called by anything here. They stay in `store.ts`, which is why this step cut two spans instead of
 * one contiguous block. `move-gate` reported the cluster as 573 lines / 22 declarations; the range
 * itself was 750 lines with those two declarations in the middle.
 *
 * NOTE ON MUTABLE STATE: this slice carries **none** (`mutable: none` measured). Every write goes
 * through `atomicWrite` or the ledger cache; there is no module-level binding here that is mutated.
 */

// node:fs / node:path 的清单是**实测**的（a2-fs-count.mjs：逐词 indexOf，不靠正则转义）：
//   lifecycle 簇用到 appendFileSync / existsSync / mkdirSync / readdirSync /
//                     readFileSync / renameSync / rmSync / statSync
//   第一版只写了 3 个 → 20 条测试红（ReferenceError: existsSync is not defined）
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ExtractedSkill } from '../extract.js'
import { replaceEdges } from '../edges.js'
import { commitLedger } from '../ledger-cache.js'
import { invalidateSkillDocs } from '../skill-cache.js'
import { acquireFileLock } from '../lock.js'
import { normalizeWorkspace } from '../workspace.js'
import { atomicWrite, readJsonl, readJsonlFresh } from './io.js'
import {
  clampConfidence, isConflictingSkill, listSkillFiles,
  parseSkillFile, readSkillValidity, readSkillWorkspace, skillPath,
} from './skill.js'
// ⚠️ SkillConflict 是 **interface** —— 构建时被 stripTypeScriptTypes 剥掉，运行时不存在。
//    放进上面的值 import 会炸 "does not provide an export named 'SkillConflict'"。
//    A1-3 的 EnvironmentDivergence、A3 的 SkillMeta 都是同一个坑，这次按类型拆开。
import type { SkillConflict } from './skill.js'

/**
 * v0.3.1: recompute every conflict edge from the current rules.
 * v1.0.0 P0: recompute into the EDGE INDEX, and do not touch SKILL.md at all.
 *
 * Needed because edges are written incrementally: a rule change (a looser earlier rule, or
 * the v1.0.0 fix to `methodSimilarity`) leaves edges in the index that no future write
 * would ever remove. The old implementation stripped `conflicts_with` and the warning
 * section out of each file and re-linked pairwise — one full rewrite per skill, then one
 * more per discovered edge, which is the same quadratic shape this release removes.
 *
 * Now: read every shape once, compute the true pair set, and REPLACE the index in one
 * write. The files are not modified, because they no longer contain edges to strip. A
 * legacy store keeps its stale inline copies; `retrieve` merges them with the index, so the
 * stale ones simply stop appearing once the file is rewritten for any other reason.
 */
export function rebuildConflictLinks(skillsDir: string): Array<{ a: string; b: string }> {
  const skills: ExtractedSkill[] = []
  for (const name of listSkillFiles(skillsDir)) {
    const path = skillPath(skillsDir, name)
    if (!existsSync(path)) continue
    try {
      skills.push(parseSkillFile(readFileSync(path, 'utf8'), name))
    } catch {
      // A broken file is skipped, not rewritten.
    }
  }
  const pairs: Array<{ a: string; b: string }> = []
  for (let leftIndex = 0; leftIndex < skills.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < skills.length; rightIndex += 1) {
      if (!isConflictingSkill(skills[leftIndex], skills[rightIndex])) continue
      pairs.push({ a: skills[leftIndex].name, b: skills[rightIndex].name })
    }
  }
  replaceEdges(
    skillsDir,
    pairs.map((pair) => [pair.a, pair.b] as const),
  )
  return pairs
}

export function conflictFooter(conflicts: readonly SkillConflict[]): string[] {
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
  /**
   * `merge` is TD-M1's line: a compaction that moved evidence between two skills is as auditable
   * as an invalidation — "which record absorbed which, and what came with it" has to be answerable
   * from the ledger, not from a diff nobody kept.
   */
  kind: 'supersede' | 'supersede-refused' | 'merge'
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

/**
 * v1.0.0 P0 — THE AUDIT LEDGER IS EVIDENCE, BUT EVIDENCE NEEDS A SHELF.
 *
 * The audit flagged `.memory-audit.jsonl` as unbounded with no rotation, and the old
 * implementation was worse than "append-only": it did `readFileSync` + `atomicWrite` — a
 * full read and a full rewrite per line. So the Nth audit entry cost O(N) IO, and the file
 * was carried in memory on every append. A long-lived profile pays that forever.
 *
 * ROTATION POLICY: archive, never delete.
 *
 * An audit trail whose oldest entries are silently dropped is not an audit trail. So when
 * the active file passes `AUDIT_ROTATE_BYTES`, it is RENAMED to a timestamped sibling and a
 * fresh active file starts. The most recent `AUDIT_KEEP` archives are retained; older ones
 * are removed because at that point the storage cost is the thing being managed. If the
 * rename fails, the append still happens to the active file — an audit write must never
 * lose the line it was asked to record.
 */
export const AUDIT_ROTATE_BYTES = 4 * 1024 * 1024
export const AUDIT_KEEP = 3

/** Rotate `path` when it has grown past `limitBytes`. Returns the archive name, or undefined. */
export function rotateAuditIfNeeded(path: string, limitBytes = AUDIT_ROTATE_BYTES, keep = AUDIT_KEEP): string | undefined {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return undefined
  }
  if (size < limitBytes) return undefined
  const dir = dirname(path)
  const base = path.slice(dir.length + 1)
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const archive = join(dir, `${base}.${stamp}`)
  try {
    renameSync(path, archive)
  } catch {
    return undefined
  }
  /**
   * Prune old archives. Sorted by name, which sorts by ISO timestamp — no mtime parsing.
   * A failure here is ignored: a leftover archive costs disk, not correctness.
   */
  try {
    const prefix = `${base}.`
    const archives = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort()
    for (const name of archives.slice(0, Math.max(0, archives.length - keep))) {
      try {
        rmSync(join(dir, name), { force: true })
      } catch {
        /* a stuck archive is not worth failing the append */
      }
    }
  } catch {
    /* ignore */
  }
  return archive
}

export function appendMemoryAudit(memoryDir: string, entry: MemoryAuditEntry): void {
  try {
    mkdirSync(memoryDir, { recursive: true })
    const path = memoryAuditPath(memoryDir)
    /**
     * APPEND, not read-all-rewrite. The previous version read the whole ledger and wrote it
     * back with one more line, which made the Nth entry cost O(N) IO. `appendFileSync` is
     * the operation the file's name always implied.
     *
     * Rotation runs BEFORE the append so a single append can never be split across the
     * rotate boundary — the line lands wholly in one file.
     */
    rotateAuditIfNeeded(path)
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8')
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
    /**
     * v1.1.0 — NO CLEAR-AND-REFILL.
     *
     * This used to be `records.length = 0; records.push(...readJsonl(path))`, a re-read
     * inside the lock to defeat a stale pre-lock snapshot. With the ledger cache that is
     * catastrophic: `readJsonl` returns the SAME array instance, so clearing it and then
     * spreading it yields an empty array — every negative silently deleted. The cache is
     * already stat-validated under the lock, so the re-read is unnecessary; `invalidate`
     * first to be certain we are not looking at a snapshot another process invalidated.
     */
    const live = readJsonlFresh(path)
    updated.length = 0
    dirty = false
    for (const record of live) {
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
    if (dirty) commitLedger(path, [], { patched: true })
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
    /** v1.1.0: a usage stamp changes last_used/decay, which retrieval derives from. */
    invalidateSkillDocs(skillsDir)
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
  /** v1.1.0: confidence feeds scoring, so the cached documents are now stale. */
  if (updated.length > 0) invalidateSkillDocs(skillsDir)
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
    /** v1.1.0: re-validation clears the stale flag, which the cached document still carries. */
    invalidateSkillDocs(skillsDir)
    return true
  } catch {
    return false
  }
}
