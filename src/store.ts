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

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import type { EvidenceRef, ExtractedExperience, ExtractedFact, ExtractedNegative, ExtractedSkill, MemoryProvenance } from './extract.js'
import { canonicalizeEntities, jaccard, planNegative, trigrams } from './dedupe.js'
import { replaceEdges, writeEdge, writeEdges } from './edges.js'
import { commitLedger, replaceRecords } from './ledger-cache.js'
import { invalidateSkillDocs } from './skill-cache.js'
import { acquireFileLock } from './lock.js'
import { normalizeWorkspace } from './workspace.js'
import { scanThreat } from './threat.js'
import { withFileLock } from './lock.js'
import { monotonicTimestamp } from './store/clock.js'
import { readJsonl, readJsonlFresh } from './store/io.js'
import { atomicWrite } from './store/io.js'
/**
 * v0.32 的写入时钟（`monotonicTimestamp` / `resetMonotonicClockForTest` / `lastIssuedMs`）
 * 已搬进 `store/clock.ts`（第 0 步）。
 *
 * 这里 **re-export** 是为了保住既有 import 路径：`index.ts` / `causal.ts` 等仍从 `store.js` 取这两个名字，
 * 所以搬移对外零改动。
 *
 * ⚠️ 那个 `let lastIssuedMs` 仍是**模块级**——它必须如此（per-process ordering guarantee），
 * 注释随代码一起搬到了 `store/clock.ts`，不要把它参数化。
 */
export { monotonicTimestamp, resetMonotonicClockForTest } from './store/clock.js'

/**
 * B 步骤：IO 原语（`atomicWrite` / `assertCompleteJson` / `StoreWriteRejected` / `readJsonl` /
 * `readJsonlFresh` / `sleepSyncLocal` / `JSON_GATE_EXT` / `TRANSIENT_RENAME`）已搬进 `store/io.ts`。
 *
 * 这里 **re-export** 是为了保住既有 import 路径：`graph.ts` / `knowledge.ts` / `suggest.ts` 与
 * `test/v023-json-gate.test.mjs` 仍从 `store.js` 取 `atomicWrite` / `StoreWriteRejected`，所以搬移对外零改动。
 * `readJsonl` / `readJsonlFresh` 搬前就不是公开面（本文件内部使用），因此只 import 不 re-export。
 */
export { atomicWrite, StoreWriteRejected } from './store/io.js'

/**
 * A3 步骤：JSONL 层写入（16 个声明）已搬进 `store/layer.ts`。
 *
 * 这里 **re-export** 是为了保住既有 import 路径 —— `index.ts` / `indexed-store.ts` /
 * `suggest.ts` / `test/v025-lost-update.test.mjs` 都从 `store.js` 取这些名字，搬移对外零改动。
 *
 * ⚠️ `SkillMeta` / `asVocab` / `VOCAB_TAG` **随 A3 走了**，不是留在 store.ts。
 * 原因：`appendNegatives` 用 `SkillMeta` 做写入戳、用 `asVocab` 规范化 tags，
 * 把它们留在 store.ts 再由 layer.ts 反向 import，会造出 `store.ts ⇄ layer.ts` 的**值边**，
 * 而 `check-cycles.mjs` 是计值边的（type-only 才豁免）。搬过去才保持单向：`store.ts → layer.ts`。
 * 这对 A1 是有约束力的：skill 写入链要用这三个名字，得从 `store/layer.js` import，
 * 不要再声明一份 —— 除非将来的 `store/types.ts` 把它们搬出去（那时是**移走**，不是复制）。
 */
export {
  asVocab,
  MAX_NEGATIVES,
  NEGATIVE_ARCHIVE_FILE,
  planNegativeArchive,
  appendNegatives,
  MAX_LAYER_RECORDS,
  appendFacts,
  appendExperiences,
} from './store/layer.js'
/**
 * 三个**类型**必须走 `export type`：`scripts/build.mjs` 用 `stripTypeScriptTypes` 剥类型，
 * 在值的 re-export 列表里写类型名会让产物出现 `does not provide an export named 'SkillMeta'`
 * —— 这是构建期错误，不是类型错误（`tsc` 反而不会拦）。
 */
export type { SkillMeta, NegativeArchivePlan } from './store/layer.js'

/**
 * A3 之后 store.ts **自己还在用**的三个名字（`asVocab` 9 处、`SkillMeta` 3 处），
 * 必须 import 进来 —— 光有上面的 re-export 不算本文件可用。
 *
 * ⚠️ 这类缺口构建不报、`tsc` 也只报"未声明"，**运行期才炸成 `ReferenceError`**。
 * 所以搬完任何一步，都要跑全套测试，不能只看 `built N module(s)`。
 */
import { asVocab } from './store/layer.js'
import type { SkillMeta } from './store/layer.js'




export function defaultSkillsDir(): string {
  return join(homedir(), '.agents', 'skills')
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

import { clampConfidence, environmentTokensOf, findConflicts, frontmatter, invalidateSkillShape, isConflictingSkill, listSkillFiles, methodSimilarity, normalizeSkill, parseEvidenceField, parseSkillFile, purposeTokens, readSkillValidity, readSkillWorkspace, renderSkill, skillPath, triggerSimilarity } from './store/skill.js'
import type { EnvironmentDivergence, SkillConflict, SkillInput } from './store/skill.js'

/**
 * A1-1：段1+2+3（13 声明）已搬进 `store/skill.ts`。
 *
 * 这里 re-export 是为了保住既有 import 路径与**导出面不变**（业务面仍是 50）。
 * 实测：13 个里只有 5 个在 store.js 运行时导出面上，其余 8 个搬前就是私有。
 * `frontmatter` / `purposeTokens` / `methodSimilarity` 因跨文件而在 skill.ts 导出，
 * 但**不**进 store.js 公开面 —— 搬前私有，搬后仍私有。
 *
 * ⚠️ 用 `export { … }`（不带 from）复用上面的 import 绑定：
 * 若写 `export { … } from './store/skill.js'`，同一个名字就有两处来源绑定。
 */
export { clampConfidence, environmentTokensOf, findConflicts, invalidateSkillShape, isConflictingSkill, normalizeSkill, parseSkillFile, readSkillValidity, readSkillWorkspace, skillPath }
export { clearSkillShapeCache, conflictStrength, environmentDivergence, linkConflictBack, resetShapeCacheForTest, writeSkill } from './store/skill.js'


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


function sharedPurpose(a: ExtractedSkill, b: ExtractedSkill): number {
  const left = purposeTokens(a)
  const right = purposeTokens(b)
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared
}


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
  /** GLOBAL KNOWLEDGE BASE: cross-workspace subject tags, and the phases this skill serves. */
  tags: string[]
  applicableNodeTypes: string[]
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
      tags: asVocab(field('tags')),
      applicableNodeTypes: asVocab(field('applicable_node_types')),
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