/**
 * dsh-memory — capability memory for DSH.
 *
 * DECOUPLING. dsh-memory never imports dsh-graft-slice. The only contact is a
 * FILE contract (`.retired.json` / `.transferred.json`, read-only) plus the host
 * services `sessionQuery` and `llm`. Either plugin can be uninstalled alone.
 *
 * FLYWHEEL. Harvest mines finished sessions → skills/negatives (suggest queue by
 * default, autoApprove for the trial). Retrieval runs at `agent/pre-step` and adds
 * ONE sentence; it is a hint, never a gate.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { readLedgers } from './ledger.js'
import { resolveModelTarget, segmentSession } from './segment.js'
import { extractEpisode } from './extract.js'
import type { EvidenceRef, ExtractionResult } from './extract.js'
import { findSkillCandidate } from './dedupe.js'
import { retrieve, renderHint, retrieveWithFilter, collectScenes } from './retrieve.js'
import { currentWorkspaceOf, workspaceOfSession } from './workspace.js'
import { applySupersede, listSkillRecords, quarantineWorkspaceMemory } from './store.js'
import type { EvidenceRef, MemoryProvenance } from './extract.js'

/**
 * v0.15: derive the trust tier from the EVIDENCE, never from the model's opinion
 * of itself.
 *
 *   human    — one of the cited seqs is a `user/message` a human wrote: the
 *              procedure is the user's own statement;
 *   tool     — a cited seq is a `tool/result`: the agent ran it and it worked;
 *   inferred — neither: the model concluded it from narration.
 *
 * The order matters: a session where the user said "always run pytest -x" and the
 * agent then ran it is `human`, because the authority for the rule is the person,
 * not the successful run.
 */
export function deriveProvenance(evidence: readonly EvidenceRef[], events: readonly unknown[]): MemoryProvenance {
  if (evidence.length === 0) return 'inferred'
  const bySeq = new Map<number, { type: string; kind: string }>()
  for (const raw of events) {
    const event = raw as { seq?: number; type?: string; data?: any }
    if (typeof event?.seq !== 'number' || typeof event.type !== 'string') continue
    bySeq.set(event.seq, { type: event.type, kind: String(event.data?.source?.kind ?? '') })
  }
  let sawTool = false
  for (const ref of evidence) {
    const found = bySeq.get(Number(ref.seq))
    if (found === undefined) continue
    if (found.type === 'user/message' && found.kind === 'user') return 'human'
    if (found.type === 'tool/result') sawTool = true
  }
  return sawTool ? 'tool' : 'inferred'
}
import { approveSuggestion, listSuggestions, queueSuggestion, rejectSuggestion } from './suggest.js'
import {
  appendExperiences,
  appendFacts,
  appendNegatives,
  applySkillFeedback,
  defaultSkillsDir,
  findConflicts,
  markProcessed,
  migrateBareEvidence,
  processedKey,
  readProcessed,
  recordCounterEvidence,
  stats,
  touchSkillUsage,
  writeSkill,
} from './store.js'

export const name = 'dsh-memory'

/**
 * Cordis service injection — WITHOUT this, `ctx.tools` / `ctx.sessionQuery` are
 * undefined and every `ctx.tools?.register(...)` silently does nothing.
 *
 * Measured: the first install mounted the plugin but exposed zero tools, because
 * the optional-chaining calls all no-oped. `llm` is deliberately NOT injected:
 * it is resolved through `ctx.get('llm')` so a profile without it still mounts.
 */
export const inject = ['tools', 'sessionQuery']

export const MEMORY_PROTOCOL = 'dsh-memory/1'

/**
 * v0.4 retrieval defaults.
 *
 * `FLOOR` is the two-stage recall net; `THRESHOLD` is the strict bar kept for
 * offline mode, where no model adjudicates and a weak lexical match must not be
 * trusted on its own.
 */
export const DEFAULT_RETRIEVAL_FLOOR = 0.2
export const DEFAULT_RETRIEVAL_THRESHOLD = 0.55

export interface MemoryConfig {
  /** Where the slicing plugin keeps its ledgers. Default: sibling `dsh-graft-slice` data dir. */
  graftDataDir?: string
  /** Where SKILL.md files go. Default: `~/.agents/skills` (scanned by DSH itself). */
  skillsDir?: string
  /** `negatives.jsonl` / `processed.json` / `suggestions.jsonl`. Default: `<paths.data>/.dsh-memory`. */
  memoryDir?: string
  /** Max retired sessions per harvest call. Default 3. */
  harvestLimit?: number
  /** `llm` extracts with the host model; `off` only scans the ledger. */
  extractor?: 'llm' | 'off'
  /** Trial switch: write extractions immediately instead of queueing them. */
  autoApprove?: boolean
  /** Pre-step retrieval (M3). Default true. */
  retrieval?: boolean
  /**
   * Strict lexical threshold, used ONLY in offline mode (`semanticFilter:false`).
   * Default 0.55: without an LLM judge, a hint must be lexically convincing.
   */
  retrievalThreshold?: number
  /**
   * v0.4: recall floor for the two-stage pipeline. Default 0.20.
   *
   * Deliberately low: stage 1 is a net, not a judge. A generic ask ("write a
   * script that connects to a database") shares few words with a skill's trigger,
   * and a high floor silently loses exactly those cases. The LLM adjudicates
   * afterwards; if it cannot, nothing is injected.
   */
  retrievalFloor?: number
  /**
   * v0.2.0 stage-2 LLM relevance filter. Default true: recall at the floor, then
   * adjudicate. Set false to keep retrieval fully offline (strict threshold,
   * lexical top-1, no low-floor noise).
   */
  semanticFilter?: boolean
  /** Optional explicit route for the filter call; default is the host's current default selection. */
  filterProvider?: string
  filterModel?: string
  /**
   * v0.8 workspace isolation. Default TRUE and should stay true.
   *
   * Every memory written from a session records that session's cwd, and a
   * retrieval only sees memories whose recorded workspace equals the current one
   * (or that declare `scope: global`). Switching it off restores the old global
   * pool — which is how a constraint from one project ("delete D:\X\repair-log.cjs")
   * ended up injected into another. It exists as a switch only so a store can be
   * inspected in its unfiltered state; it is not a tuning knob.
   */
  workspaceIsolation?: boolean
}

interface ContextLike {
  paths?: { data?: string }
  get?: (name: string) => unknown
  on?: (event: string, handler: (payload: any, next: any) => Promise<unknown>) => void
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
  tools?: { register: (definition: unknown) => void }
  sessionQuery?: { readSession: (id: string) => Promise<unknown> }
}

/**
 * DSH's ToolService refuses any registration whose `output` is missing
 * `{ schema, render }`. Measured live: without this the whole plugin fiber
 * fails with `TypeError: tool \"memory_harvest\" must declare output` and no
 * tool ever appears. JSON-in-a-code-block is enough for a diagnostic surface.
 */
function textOutput() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args: unknown, value: any) => [
      { type: 'text' as const, text: JSON.stringify(value, null, 2).slice(0, 6000) },
    ],
  }
}

function resolveConfig(ctx: ContextLike, config: MemoryConfig) {
  // Cordis contexts are proxies: reading an unknown service property can THROW
  // ("service not found"), which marks the plugin fiber `failed` and silently
  // loses every registration. The slicing plugin learned this too and always
  // goes through `ctx.get('paths')` inside a try/catch.
  const dataRoot = (() => {
    try {
      const paths = ctx.get?.('paths') as { data?: unknown } | undefined
      if (paths !== null && typeof paths === 'object' && typeof paths.data === 'string' && paths.data.length > 0) {
        return paths.data
      }
    } catch {
      // fall through
    }
    return process.cwd()
  })()
  return {
    memoryDir: config.memoryDir && config.memoryDir.length > 0 ? config.memoryDir : join(dataRoot, '.dsh-memory'),
    graftDataDir:
      config.graftDataDir && config.graftDataDir.length > 0 ? config.graftDataDir : join(dataRoot, '..', 'dsh-graft-slice'),
    skillsDir: config.skillsDir && config.skillsDir.length > 0 ? config.skillsDir : defaultSkillsDir(),
    harvestLimit: Number.isFinite(Number(config.harvestLimit)) ? Math.max(1, Math.min(20, Number(config.harvestLimit))) : 3,
    extractor: config.extractor === 'off' ? ('off' as const) : ('llm' as const),
    autoApprove: config.autoApprove === true,
    retrieval: config.retrieval !== false,
    threshold: Number.isFinite(Number(config.retrievalThreshold)) ? Number(config.retrievalThreshold) : DEFAULT_RETRIEVAL_THRESHOLD,
    floor:
      Number.isFinite(Number(config.retrievalFloor)) && Number(config.retrievalFloor) > 0
        ? Math.min(0.9, Number(config.retrievalFloor))
        : DEFAULT_RETRIEVAL_FLOOR,
    semanticFilter: config.semanticFilter !== false,
    filterProvider: typeof config.filterProvider === 'string' && config.filterProvider.length > 0 ? config.filterProvider : undefined,
    filterModel: typeof config.filterModel === 'string' && config.filterModel.length > 0 ? config.filterModel : undefined,
    workspaceIsolation: config.workspaceIsolation !== false,
  }
}

/**
 * The model route for the filter call.
 *
 * Measured: `llm.stream()` without a provider fails with
 * `no adapter registered for provider "undefined"`, and the failure was invisible
 * because the filter falls back to the lexical answer. The host's own default
 * selection is the right route for a decision that is not about any one session;
 * an explicit config pair overrides it.
 */
function resolveFilterTarget(ctx: ContextLike, filterProvider?: string, filterModel?: string): { provider?: string; model?: string } {
  if (filterProvider !== undefined && filterModel !== undefined) return { provider: filterProvider, model: filterModel }
  let provider = filterProvider
  let model = filterModel
  const asId = (value: unknown): string | undefined => {
    if (typeof value === 'string' && value.length > 0) return value
    if (value !== null && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
      const id = (value as { id: string }).id
      return id.length > 0 ? id : undefined
    }
    return undefined
  }
  try {
    const service = ctx.get?.('agentDefaultModel') as { currentSelection?: () => unknown } | undefined
    const selection = typeof service?.currentSelection === 'function' ? (service.currentSelection() as Record<string, unknown> | undefined) : undefined
    provider = provider ?? asId(selection?.provider)
    model = model ?? asId(selection?.model)
  } catch {
    // A profile without the service keeps retrieval lexical.
  }
  return { ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }) }
}

export interface HarvestReport {
  ok: boolean
  scanned: number
  harvested: Array<{
    sessionId: string
    turns: number
    skills: Array<{ name: string; status: string }>
    negatives: number
    facts: number
    experiences: number
    dropped: string[]
    /** v0.5: write-phase retries (never a second model call). */
    writeRetries?: number
    /** v0.5: another writer committed while the model was thinking; merged. */
    mergedConcurrentWrites?: number
    /** v0.5: negatives weakened by a successful run of the forbidden tool. */
    counterEvidence?: number
  }>
  skipped: string[]
  warnings: string[]
  suggestionsQueued: number
  stats: ReturnType<typeof stats>
}

/**
 * v0.5 optimistic-concurrency stamp.
 *
 * Covers the files harvest reads and writes; a change between "read" and "write"
 * means another harvest finished in between. The write phase merges (read-modify-
 * write inside the store), so the correct response is a merge + retry of the
 * WRITE — never a second LLM extraction, which is the expensive part.
 */
export function snapshotStoreVersion(memoryDir: string, skillsDir: string): string {
  const parts: string[] = []
  for (const file of ['negatives.jsonl', 'processed.json', 'facts.jsonl', 'experiences.jsonl', 'suggestions.jsonl']) {
    try {
      const state = statSync(join(memoryDir, file))
      parts.push(`${file}:${state.size}:${Math.round(state.mtimeMs)}`)
    } catch {
      parts.push(`${file}:-`)
    }
  }
  try {
    const names = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    for (const name of names) {
      try {
        const state = statSync(join(skillsDir, name, 'SKILL.md'))
        parts.push(`${name}:${state.size}:${Math.round(state.mtimeMs)}`)
      } catch {
        // a vanished skill is simply absent from the stamp
      }
    }
  } catch {
    // no skills dir yet
  }
  return parts.join('|')
}

/**
 * v0.6 strong verification: re-open the cited seqs in the REAL session log.
 *
 * A 240-character conclusion is not proof that the code ran. A skill is written
 * only when at least one cited seq is a tool call that produced a successful
 * result. v0.7: `observational` tools (read/grep/glob/…) also count — a code
 * READING session can produce a real architecture lesson even though it never
 * wrote anything. The kind is recorded so a later reader knows whether the skill
 * was demonstrated operationally or only observed.
 */
const OBSERVATIONAL_TOOLS = new Set([
  'read', 'read_file', 'grep', 'rg', 'glob', 'find', 'ls', 'dir', 'list', 'cat', 'head', 'tail', 'view', 'search', 'codebase_search',
])

export function buildEvidenceVerifier(
  events: readonly any[],
): (refs: readonly EvidenceRef[]) => { ok: boolean; observation?: boolean; reason?: string } {
  const bySeq = new Map<number, any>()
  const callNames = new Map<string, string>()
  const successful = new Map<string, string>() // callId -> tool name
  for (const event of events) {
    const seq = Number(event?.seq)
    if (Number.isFinite(seq)) bySeq.set(seq, event)
    if (event?.type === 'tool/call') {
      const callId = event.data?.callId
      const name = String(event.data?.name ?? '')
      if (typeof callId === 'string' && name.length > 0) callNames.set(callId, name)
    }
  }
  for (const event of events) {
    if (event?.type !== 'tool/result') continue
    const message = event.data?.message
    if (message?.isError === true || event.data?.error !== undefined) continue
    const callId = message?.source?.callId ?? message?.toolCallId
    if (typeof callId === 'string') successful.set(callId, callNames.get(callId) ?? '')
  }
  return (refs) => {
    if (refs.length === 0) return { ok: false, reason: 'no evidence ref' }
    let operational = false
    let observational = false
    for (const ref of refs) {
      const event = bySeq.get(Number(ref.seq))
      if (event === undefined) return { ok: false, reason: `seq ${ref.seq} is not in the session log` }
      if (event.type === 'tool/result') {
        const message = event.data?.message
        if (message?.isError === true || event.data?.error !== undefined) {
          return { ok: false, reason: `seq ${ref.seq} is a failed tool result` }
        }
        const callId = message?.source?.callId ?? message?.toolCallId
        const tool = typeof callId === 'string' ? callNames.get(callId) ?? '' : ''
        if (OBSERVATIONAL_TOOLS.has(tool)) observational = true
        else operational = true
        continue
      }
      if (event.type === 'tool/call') {
        const callId = event.data?.callId
        if (typeof callId !== 'string' || !successful.has(callId)) {
          return { ok: false, reason: `tool call at seq ${ref.seq} has no successful result` }
        }
        const tool = callNames.get(callId) ?? ''
        if (OBSERVATIONAL_TOOLS.has(tool)) observational = true
        else operational = true
      }
    }
    if (operational) return { ok: true, observation: false }
    if (observational) return { ok: true, observation: true }
    return { ok: false, reason: 'evidence is narration only (no tool result)' }
  }
}

export async function harvest(ctx: ContextLike, config: MemoryConfig): Promise<HarvestReport> {
  const resolved = resolveConfig(ctx, config)
  const warnings: string[] = []
  const skipped: string[] = []
  const harvested: HarvestReport['harvested'] = []
  const ledgers = readLedgers(resolved.graftDataDir)
  const processed = readProcessed(resolved.memoryDir)
  const seen = new Set([...processed].map((key) => key.split(':')[0]))
  const queue = ledgers.retired.filter((id) => !seen.has(id)).slice(0, resolved.harvestLimit)
  let queued = 0

  for (const sessionId of queue) {
    try {
      const log = await ctx.sessionQuery?.readSession?.(sessionId)
      if (log === undefined || log === null) {
        warnings.push(`${sessionId}: readSession returned nothing`)
        continue
      }
      const episode = segmentSession(sessionId, log as { events?: unknown[] })
      // v0.5: version stamp taken BEFORE the slow extraction call. A change here
      // means another harvest wrote meanwhile; the write phase merges, and the
      // model is never called twice for it.
      const versionAtExtractStart = snapshotStoreVersion(resolved.memoryDir, resolved.skillsDir)
      const key = processedKey(sessionId, episode.boundarySeq)
      if (processed.has(key)) {
        skipped.push(`${sessionId}: already processed at seq ${episode.boundarySeq}`)
        continue
      }
      let extraction: ExtractionResult = { facts: [], experiences: [], skills: [], negatives: [], dropped: [] }
      if (resolved.extractor === 'llm') {
        const llm = (() => {
          try {
            return ctx.get?.('llm') as any
          } catch {
            return undefined
          }
        })()
        const target = resolveModelTarget(log as { session?: unknown; events?: unknown[] })
        const result = await extractEpisode(llm, episode, {
          ...target,
          // v0.7.1: reuse the domains already in the store instead of minting a
          // synonym for the same scene on every harvest.
          scenes: collectScenes(resolved.memoryDir, resolved.skillsDir),
          // v0.6: no skill survives without a real, successful tool result behind
          // its evidence. `log` is the actual session, not the 240-char digest.
          verify: buildEvidenceVerifier(((log as any).events ?? []) as any[]),
        })
        if (!result.ok) {
          // A failed CALL is not "this session had no lessons": leave the session
          // unprocessed so the next harvest can retry it instead of skipping it
          // forever (measured: the first live harvest marked it done with zero
          // skills written).
          try {
            mkdirSync(resolved.memoryDir, { recursive: true })
            writeFileSync(
              join(resolved.memoryDir, `last-extraction-raw-${new Date().toISOString().replace(/[:.]/gu, '-')}.txt`),
              String(result.rawText ?? '(empty reply)'),
              'utf8',
            )
          } catch {
            // diagnostics must not mask the failure
          }
          warnings.push(`${sessionId}: extraction failed (${result.dropped[0] ?? 'unknown'})`)
          continue
        }
        extraction = result
      }
      const meta = {
        sessionId,
        boundarySeq: episode.boundarySeq,
        // v0.8: provenance for the isolation gate. Read from the session log
        // header, never from the extraction model, so a prompt cannot forge it.
        ...(workspaceOfSession(log).length === 0 ? {} : { workspace: workspaceOfSession(log) }),
        // v0.15: one timestamp for everything this harvest writes, so a whole
        // generation of memories shares one point on the timeline.
        validAt: new Date().toISOString(),
      }
      const harvestedEvents = ((log as any).events ?? []) as readonly unknown[]
      const written: Array<{ name: string; status: string }> = []
      let negatives = 0
      // v0.5 optimistic writes: the LLM call above can take a minute, and another
      // harvest may have written meanwhile. We re-read the version ONCE, then
      // merge (never re-call the model). A failed write is retried, not re-mined.
      const versionBeforeWrites = snapshotStoreVersion(resolved.memoryDir, resolved.skillsDir)
      const mergedConcurrentWrites = versionBeforeWrites !== versionAtExtractStart ? 1 : 0
      let writeRetries = 0
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          written.length = 0
          negatives = 0
          for (const skill of extraction.skills) {
            // Gates ①/②/③: an existing skill wins the name, so the merge lands in it.
            //
            // v0.3 exception: a similar TRIGGER with a DIFFERENT METHOD is not the
            // same skill. Merging there would overwrite one of two mutually exclusive
            // procedures; the alternative is recorded as a conflict instead.
            const candidate = findSkillCandidate(resolved.skillsDir, skill.when)
            const conflicts = findConflicts(resolved.skillsDir, skill)
            const mergeInto = candidate !== undefined && !conflicts.some((conflict) => conflict.name === candidate.name)
            const target = mergeInto ? { ...skill, name: candidate!.name } : skill
            // v0.15: the tier is per record, derived from THAT record's evidence.
            const recordMeta = { ...meta, provenance: deriveProvenance(target.evidence, harvestedEvents) }
            if (mergeInto || resolved.autoApprove) {
              written.push({ name: target.name, status: writeSkill(resolved.skillsDir, target, recordMeta) })
            } else {
              queueSuggestion(resolved.memoryDir, 'skill', skill, recordMeta)
              queued += 1
              written.push({ name: skill.name, status: 'queued' })
            }
          }
          if (resolved.autoApprove) {
            // v0.15: negatives carry their own tier; the array shares one meta.
            negatives = appendNegatives(
              resolved.memoryDir,
              extraction.negatives.map((negative) => ({
                ...negative,
                provenance: deriveProvenance(negative.evidence, harvestedEvents),
              })),
              meta,
            )
          } else {
            for (const negative of extraction.negatives) {
              queueSuggestion(
                resolved.memoryDir,
                'negative',
                { ...negative, provenance: deriveProvenance(negative.evidence, harvestedEvents) },
                meta,
              )
              queued += 1
            }
          }
          // Facts and experiences are evidence pointers, not instructions: they are
          // written straight to their own JSONL (with seq), even when skills wait for
          // review. That keeps the 4-layer model auditable instead of prompt-only.
          const facts = appendFacts(resolved.memoryDir, extraction.facts, meta)
          const experiences = appendExperiences(resolved.memoryDir, extraction.experiences, meta)
          markProcessed(resolved.memoryDir, key)
          // v0.5: a finished session may FALSIFY an older negative ("A always
          // fails" — yet A just succeeded). Record the receipt before reporting.
          const counter = recordCounterEvidence(resolved.memoryDir, ((log as any).events ?? []) as any[])
          harvested.push({
            sessionId,
            turns: episode.turns,
            skills: written,
            negatives,
            facts,
            experiences,
            dropped: extraction.dropped,
            ...(writeRetries === 0 ? {} : { writeRetries }),
            ...(mergedConcurrentWrites === 0 ? {} : { mergedConcurrentWrites }),
            ...(counter.updated.length === 0 ? {} : { counterEvidence: counter.updated.length }),
          })
          break
        } catch (error) {
          writeRetries += 1
          if (attempt === 2) throw error
        }
      }
    } catch (error) {
      warnings.push(`${sessionId}: ${String((error as any)?.message ?? error)}`)
    }
  }

  return {
    ok: warnings.length === 0,
    scanned: queue.length,
    harvested,
    skipped,
    warnings,
    suggestionsQueued: queued,
    stats: stats(resolved.memoryDir, resolved.skillsDir),
  }
}

/** Retrieval preview under the old tool name (kept for compatibility). */
export function searchSkills(skillsDir: string, query: string, limit = 5): Array<{ name: string; score: number; when: string }> {
  const result = retrieve(join(skillsDir, '..'), skillsDir, query, { threshold: 0 })
  const hits: Array<{ name: string; score: number; when: string }> = []
  if (result.skill !== undefined) hits.push({ name: result.skill.id, score: result.skill.score, when: result.skill.when ?? '' })
  return hits.slice(0, limit)
}

export function forgetSkill(skillsDir: string, name: string): boolean {
  const path = join(skillsDir, name)
  if (!existsSync(path)) return false
  rmSync(path, { recursive: true, force: true })
  return true
}

function lastUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === null || typeof message !== 'object') continue
    if ((message as any).role !== 'user') continue
    const content = (message as any).content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block: any) => block?.type === 'text')
      .map((block: any) => String(block.text ?? ''))
      .join('\n')
      .trim()
    if (text.length > 0) return text
  }
  return undefined
}

/**
 * v0.16 CONSOLE: the memory knobs the panel may write, and the one place that
 * knows how to persist them.
 *
 * A whitelist plus a spread of `current`: the console exists so the user does not
 * have to hand-edit the patch, not so a UI click can produce a config that the
 * Loader rejects on the next restart.
 */
const MEMORY_CONSOLE_KEYS = new Set(['retrieval', 'workspaceIsolation', 'semanticFilter', 'autoApprove'])
const MEMORY_CONSOLE_PATCH_ID = 'dsh-memory'

export async function writeMemoryConsoleSetting(
  ctx: ContextLike,
  rawInput: string,
): Promise<{ ok: boolean; text: string }> {
  const parts = String(rawInput ?? '').trim().split(/\s+/u).filter((part) => part.length > 0)
  if (parts.length < 2) {
    return { ok: false, text: `需要两个参数：<key> <true|false>；可写键：${[...MEMORY_CONSOLE_KEYS].join(', ')}` }
  }
  const [key, raw] = parts
  if (!MEMORY_CONSOLE_KEYS.has(key)) {
    return { ok: false, text: `未知的配置键 ${key}；可写键：${[...MEMORY_CONSOLE_KEYS].join(', ')}` }
  }
  const value = raw.toLowerCase()
  if (value !== 'true' && value !== 'false') return { ok: false, text: `${key} 只接受 true / false（收到 ${raw}）` }
  const editor = (() => {
    try {
      return ctx.get?.('configEditor') as any
    } catch {
      return undefined
    }
  })()
  if (editor === undefined || editor === null || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
    return { ok: false, text: 'configEditor 服务不可用：本次改动没有落盘，请手动修改 profile 的 cordis.patch.yml。' }
  }
  const entry = (editor.entries() as any[]).find((row) => row?.patchId === MEMORY_CONSOLE_PATCH_ID || row?.id === MEMORY_CONSOLE_PATCH_ID)
  if (entry === undefined) return { ok: false, text: `找不到 ${MEMORY_CONSOLE_PATCH_ID} 的配置行。` }
  try {
    await editor.edit(entry, (current: Record<string, unknown>) => ({ ...(current ?? {}), [key]: value === 'true' }))
  } catch (error) {
    return { ok: false, text: `写入失败：${String((error as any)?.message ?? error)}` }
  }
  return { ok: true, text: `已保存 ${key}=${value}（无需重启：下一条提示就按新值过滤）` }
}

export function apply(ctx: ContextLike, config: MemoryConfig = {}): void {
  try {
    applyInner(ctx, config)
  } catch (error) {
    // A fiber that fails silently is worse than one that fails loudly: write the
    // reason where the author can find it, then rethrow so the loader reports it.
    try {
      const dir = (() => {
        try {
          const paths = ctx.get?.('paths') as { data?: string } | undefined
          return typeof paths?.data === 'string' ? paths.data : process.cwd()
        } catch {
          return process.cwd()
        }
      })()
      mkdirSync(dir, { recursive: true })
      writeFileSync(`${dir}/activate-error.txt`, String((error as any)?.stack ?? error), 'utf8')
    } catch {
      // diagnostics must not mask the original failure
    }
    throw error
  }
}

function applyInner(ctx: ContextLike, config: MemoryConfig): void {
  const resolved = resolveConfig(ctx, config)
  const llmAvailable = (() => {
    try {
      return ctx.get?.('llm') !== undefined
    } catch {
      return false
    }
  })()

  ctx.tools?.register({
    name: 'memory_harvest',
    description:
      'Mine finished (retired) sessions for the four cognitive layers: facts (with seq pointers), experiences, negative paths, and structured SKILL.md skills ' +
      '(frontmatter with when_to_use + 执行步骤 + 验证标准). Reads the handoff ledger, extracts with the host model, ' +
      'then queues suggestions (default) or writes directly when autoApprove is on. Idempotent per (session, boundarySeq).',
    parameters: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: false },
    output: textOutput(),
    execute: async (args: { limit?: number } = {}) => {
      const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(20, Number(args.limit))) : resolved.harvestLimit
      return harvest(ctx, { ...config, harvestLimit: limit })
    },
  })

  ctx.tools?.register({
    name: 'memory_suggestions',
    description: 'List the review queue (skills/negatives extracted but not yet approved).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput(),
    execute: async () => ({
      items: listSuggestions(resolved.memoryDir).map((item) => ({ id: item.id, kind: item.kind, at: item.at, payload: item.payload })),
    }),
  })

  ctx.tools?.register({
    name: 'memory_approve',
    description: 'Approve one queued suggestion: writes the skill (merging if similar) or appends the negative, then removes it from the queue.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    output: textOutput(),
    execute: async (args: { id: string }) => approveSuggestion(resolved.memoryDir, resolved.skillsDir, String(args.id ?? '')),
  })

  ctx.tools?.register({
    name: 'memory_reject',
    description: 'Reject one queued suggestion (auditable: it is removed, never written).',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    output: textOutput(),
    execute: async (args: { id: string }) => ({ removed: rejectSuggestion(resolved.memoryDir, String(args.id ?? '')) }),
  })

  ctx.tools?.register({
    name: 'memory_stats',
    description: 'Skills, negatives, processed sessions, queue length and both directory paths.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput(),
    execute: async () => ({
      ...stats(resolved.memoryDir, resolved.skillsDir),
      queued: listSuggestions(resolved.memoryDir).length,
      graftDataDir: resolved.graftDataDir,
      extractor: resolved.extractor,
      autoApprove: resolved.autoApprove,
      llmAvailable,
    }),
  })

  ctx.tools?.register({
    name: 'memory_migrate_evidence',
    description:
      'One-shot legacy repair: attach a sourceSessionId to every bare-seq evidence pointer in SKILL.md, negatives.jsonl, facts.jsonl and experiences.jsonl. ' +
      'When sessionId is omitted, the newest session in the handoff ledger is used. Explicit and auditable; never runs on activation.',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } }, additionalProperties: false },
    output: textOutput(),
    execute: async (args: { sessionId?: string } = {}) => {
      let sessionId = String(args.sessionId ?? '').trim()
      if (sessionId.length === 0) {
        const ledgers = readLedgers(resolved.graftDataDir)
        const stamped = Object.values(ledgers.transferred)
          .map((record) => ({ id: record.newSessionId, at: Number(record.at ?? 0) }))
          .sort((left, right) => right.at - left.at)
        sessionId = stamped[0]?.id ?? ledgers.retired.at(-1) ?? ''
      }
      if (sessionId.length === 0) {
        return { error: 'no sessionId given and the handoff ledger is empty; pass sessionId explicitly' }
      }
      return migrateBareEvidence(resolved.memoryDir, resolved.skillsDir, sessionId)
    },
  })

  ctx.tools?.register({
    name: 'memory_search',
    description:
      'Two-stage retrieval preview: lexical recall at a LOW floor (0.20), then one LLM adjudication that keeps only semantically applicable skills. ' +
      'semantic:false forces the old offline lexical mode. If the adjudicator is unavailable or returns none, no hint is produced.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        threshold: { type: 'number' },
        semantic: { type: 'boolean' },
        workspace: {
          type: 'string',
          description:
            'Workspace to search as. Defaults to the current working directory; memories recorded in another workspace are excluded unless they declare scope: global.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: textOutput(),
    execute: async (args: { query: string; threshold?: number; semantic?: boolean; workspace?: string }) => {
      const query = String(args.query ?? '')
      const explicitThreshold = Number.isFinite(Number(args.threshold)) ? Number(args.threshold) : undefined
      // v0.8: a manual search is still a read of memory, so it obeys the same
      // gate. The caller may name the workspace explicitly; the default is where
      // this plugin process runs, and an unscoped legacy memory stays invisible
      // either way.
      const gate = resolved.workspaceIsolation
        ? { workspace: currentWorkspaceOf(undefined, typeof args.workspace === 'string' ? args.workspace : undefined) }
        : {}
      // Default is the two-stage pipeline; `semantic:false` is the offline escape hatch.
      const wantSemantic = args.semantic !== false && llmAvailable && resolved.semanticFilter
      const llm = (() => {
        if (!wantSemantic) return undefined
        try {
          return ctx.get?.('llm') as never
        } catch {
          return undefined
        }
      })()
      const result = wantSemantic
        ? await retrieveWithFilter(resolved.memoryDir, resolved.skillsDir, query, {
            floor: explicitThreshold ?? resolved.floor,
            ...gate,
            llm,
            ...resolveFilterTarget(ctx, resolved.filterProvider, resolved.filterModel),
          })
        : retrieve(resolved.memoryDir, resolved.skillsDir, query, {
            threshold: explicitThreshold ?? resolved.threshold,
            ...gate,
          })
      const hint = renderHint(result)
      // `hint: undefined` is not lossless JSON: the ToolService validates the raw
      // value, not its stringified form, and rejects the whole call.
      if (result.skill !== undefined) touchSkillUsage(resolved.skillsDir, result.skill.id)
      return { ...result, ...(hint === undefined ? {} : { hint }) }
    },
  })

  ctx.tools?.register({
    name: 'memory_forget',
    description: 'Delete one stored skill by name. Explicit, auditable, never automatic.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    output: textOutput(),
    execute: async (args: { name: string }) => ({ removed: forgetSkill(resolved.skillsDir, String(args.name ?? '')) }),
  })

  // -------------------------------------------------------------------------
  // M3: the flywheel. One sentence at most, once per user turn, never blocking.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // v0.5: live counter-evidence sweep. Tool results are the only place where a
  // stored prohibition can be falsified by reality; turn-stopping is the host's
  // quiet boundary, so the sweep never competes with an in-flight step.
  // -------------------------------------------------------------------------
  /**
   * v0.7.1: skills whose hint was injected in the current turn, awaiting the
   * outcome signal from turn-stopping. One turn, then discarded.
   */
  const pendingFeedback = new Map<string, { names: string[]; at: number }>()
  const counterSweptTo = new Map<string, number>()
  ctx.on?.('agent/turn-stopping', async (payload: any) => {
    try {
      const agentId = typeof payload?.agent?.id === 'string' ? payload.agent.id : ''
      if (agentId.length === 0) return
      const live = (() => {
        try {
          return (ctx.get?.('sessions') as any)?.get?.(agentId)
        } catch {
          return undefined
        }
      })()
      if (live === undefined || typeof live.snapshotEvents !== 'function') return
      const events = live.snapshotEvents(0) as any[]
      const from = counterSweptTo.get(agentId) ?? 0
      const fresh = events.filter((event) => Number(event?.seq ?? 0) > from)
      if (fresh.length === 0) return
      const result = recordCounterEvidence(resolved.memoryDir, fresh)
      counterSweptTo.set(agentId, Number(events.at(-1)?.seq ?? from))
      if (result.updated.length > 0) {
        ctx.logger?.info?.(`[dsh-memory] counter-evidence recorded for ${result.updated.length} negative(s)`)
      }
      // v0.7.1 use-effect loop: a turn that finished cleanly confirms the skill
      // it used; a turn that hit a failed tool result weakens it (confidence -0.1).
      // This is the only path that can raise confidence automatically.
      const pending = pendingFeedback.get(agentId)
      if (pending !== undefined && pending.names.length > 0 && Date.now() - pending.at < 30 * 60_000) {
        const errored = fresh.some(
          (event) => event?.type === 'tool/result' && (event.data?.message?.isError === true || event.data?.error !== undefined),
        )
        const feedback = applySkillFeedback(resolved.skillsDir, pending.names, errored ? 'negative' : 'positive')
        pendingFeedback.delete(agentId)
        if (feedback.updated.length > 0) {
          ctx.logger?.info?.(
            `[dsh-memory] feedback ${errored ? 'negative' : 'positive'} for ${feedback.updated
              .map((item) => `${item.name}@${item.confidence}`)
              .join(', ')}`,
          )
        }
      }
    } catch {
      // The sweep is maintenance; it must never break the closing turn.
    }
  })

  const nudgeState = new Map<string, { userKey: string; lastId: string; lastAt: number }>()
  if (resolved.retrieval) {
    ctx.on?.('agent/pre-step', async (payload: any, next: any) => {
      let decision: any
      try {
        decision = typeof next === 'function' ? await next() : undefined
      } catch {
        return undefined
      }
      try {
        if (decision === undefined || decision === null) return decision
        if (decision.kind === 'reject') return decision
        const agentId = typeof payload?.agent?.id === 'string' ? payload.agent.id : ''
        const userText = lastUserText(payload?.messages)
        if (userText === undefined || userText.length < 4) return decision
        const state = nudgeState.get(agentId) ?? { userKey: '', lastId: '', lastAt: 0 }
        const key = userText.trim().slice(0, 160)
        if (key === state.userKey) return decision
        state.userKey = key
        nudgeState.set(agentId, state)
        const llm = (() => {
          if (!resolved.semanticFilter) return undefined
          try {
            return ctx.get?.('llm') as never
          } catch {
            return undefined
          }
        })()
        const result = await retrieveWithFilter(resolved.memoryDir, resolved.skillsDir, userText, {
          // v0.4: recall at the LOW floor, then let the model adjudicate. If the
          // model cannot answer (no llm, timeout, malformed reply) the function
          // returns no hit at all — low-floor candidates are never injected raw.
          floor: resolved.floor,
          // A per-turn hint must stay cheap: a slow adjudicator costs the hint,
          // never the turn.
          timeoutMs: 4000,
          // v0.8: the isolation gate. The workspace of THIS turn, resolved the same
          // way the store records it (session cwd), so a memory from another
          // repository never reaches the hint — even one that scores highest.
          ...(resolved.workspaceIsolation ? { workspace: currentWorkspaceOf(payload) } : {}),
          // v0.15: the supersede verdict is PERSISTED here — this is the one path
          // where a real turn is being served. `applySupersede` refuses a machine
          // verdict against a human memory and appends the audit line; the manual
          // `memory_search` preview stays read-only on purpose.
          onSupersede: (decision) => {
            const result = applySupersede(resolved.memoryDir, resolved.skillsDir, decision, { query: userText })
            if (result.applied) {
              ctx.logger?.info?.(`[dsh-memory] superseded ${decision.loser} by ${decision.winner}: ${decision.reason}`)
            }
          },
          ...(llm === undefined ? {} : { llm, ...resolveFilterTarget(ctx, resolved.filterProvider, resolved.filterModel) }),
        })
        const hint = renderHint(result)
        if (hint === undefined) return decision
        // v0.5 decay bookkeeping: a recalled skill that is actually injected has
        // been used; its decay clock restarts.
        if (result.skill !== undefined) touchSkillUsage(resolved.skillsDir, result.skill.id)
        // v0.7.1: remember what this turn was told, so turn-stopping can score the
        // outcome (clean turn = confirmed, retried turn = weakened).
        const feedbackNames = [result.skill?.id, ...(result.alternatives ?? []).map((hit) => hit.id)].filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        )
        if (feedbackNames.length > 0) pendingFeedback.set(agentId, { names: [...new Set(feedbackNames)], at: Date.now() })
        const bestId =
          [result.skill?.id ?? '', ...(result.alternatives ?? []).map((hit) => hit.id), result.negative?.id ?? '']
            .filter((id) => id.length > 0)
            .join('+')
        const now = Date.now()
        if (bestId === state.lastId && now - state.lastAt < 30 * 60_000) return decision
        state.lastId = bestId
        state.lastAt = now
        const base = Array.isArray(decision.messages) ? decision.messages : Array.isArray(payload?.messages) ? payload.messages : []
        return {
          ...decision,
          messages: [
            ...base,
            {
              id: `memory-hint-${agentId || 'session'}-${now}`,
              role: 'user',
              content: [{ type: 'text', text: hint }],
              source: { kind: 'plugin:dsh-memory' },
            },
          ],
        }
      } catch (error) {
        try {
          ctx.logger?.warn?.(`[dsh-memory] retrieval skipped: ${String((error as any)?.message ?? error)}`)
        } catch {
          // Never let the hint break the step.
        }
        return decision
      }
    })
  }

  /**
   * v0.16 CONSOLE: the Host half of the memory panel.
   *
   * Same reasoning as the graft console: the panel needs a live read and a live
   * write, both exposed as commands so the UI and the slash command share one
   * implementation, and the write goes through `configEditor.edit` so the value
   * lands in the profile patch instead of a shadow copy that dies with the process.
   *
   * The "clear this workspace" action is the one destructive-looking button in
   * either console, so it MOVES rather than deletes (`quarantineWorkspaceMemory`)
   * and reports every file it touched — a debug convenience that eats three weeks
   * of learned rules is a debug convenience nobody uses twice.
   */
  const liveWorkspaceOf = (agentId: string): string => {
    if (agentId.length === 0) return ''
    try {
      const session = (ctx.get?.('sessions') as any)?.get?.(agentId)
      if (session === undefined || session === null) return currentWorkspaceOf(undefined)
      const wd = ctx.get?.('workingDirectory') as any
      if (wd !== undefined && wd !== null && typeof wd.get === 'function') {
        const value = wd.get(session)
        if (typeof value === 'string' && value.trim().length > 0) return value.trim()
      }
      const cwd = (session as any)?.header?.cwd
      if (typeof cwd === 'string' && cwd.trim().length > 0) return cwd.trim()
    } catch {
      // An unresolvable workspace falls back to the process directory, and the
      // panel says which one it used instead of guessing silently.
    }
    return currentWorkspaceOf(undefined)
  }

  const memoryConsoleState = (agentId: string): Record<string, unknown> => {
    const workspace = liveWorkspaceOf(agentId)
    const skills = listSkillRecords(resolved.skillsDir)
    const scenes = [...new Set(skills.map((skill) => skill.scene))].sort()
    const active = skills.filter((skill) => skill.invalidAt.length === 0 || Date.parse(skill.invalidAt) > Date.now())
    return {
      config: {
        retrieval: resolved.retrieval,
        workspaceIsolation: resolved.workspaceIsolation,
        semanticFilter: resolved.semanticFilter,
        autoApprove: resolved.autoApprove,
        extraction: resolved.extractor,
        floor: resolved.floor,
        threshold: resolved.threshold,
      },
      workspace,
      memoryDir: resolved.memoryDir,
      skillsDir: resolved.skillsDir,
      counts: {
        skills: skills.length,
        active: active.length,
        superseded: skills.length - active.length,
        scenes: scenes.length,
        queued: listSuggestions(resolved.memoryDir).length,
      },
      scenes,
      skills,
      generatedAt: new Date().toISOString(),
    }
  }

  const writeMemorySetting = async (rawInput: string) => writeMemoryConsoleSetting(ctx, rawInput)

  const registerMemoryConsole = (): void => {
    const commands = (() => {
      try {
        return ctx.get?.('commands') as any
      } catch {
        return undefined
      }
    })()
    if (commands === undefined || commands === null || typeof commands.register !== 'function') {
      ctx.logger?.warn?.('[dsh-memory] ctx.commands unavailable; the memory console falls back to its tools')
      return
    }
    commands.register({
      name: 'memory-console',
      description: '读取记忆库控制台状态（开关、技能清单、场景、失效计数）。Read the memory console state.',
      handler: async (invocation: any) => ({
        kind: 'success' as const,
        text: JSON.stringify(memoryConsoleState(String(invocation?.agent?.id ?? ''))),
      }),
    })
    commands.register({
      name: 'memory-console-set',
      description:
        '修改记忆开关并存盘（无需重启）：<retrieval|workspaceIsolation|semanticFilter|autoApprove> <true|false>。' +
        'Set a memory knob live, e.g. `/memory-console-set retrieval true`.',
      input: { hint: '<retrieval|workspaceIsolation|semanticFilter|autoApprove> <true|false>' },
      handler: async (invocation: any) => {
        const result = await writeMemorySetting(String(invocation?.rawInput ?? ''))
        return { kind: result.ok ? ('success' as const) : ('error' as const), text: result.text }
      },
    })
    commands.register({
      name: 'memory-console-clear',
      description:
        '把「当前工作区」的记忆移入隔离区（不删除，报告清单）：可选 `include-unscoped`。' +
        'Quarantine this workspace\'s memories; add `include-unscoped` for pre-v0.8 rows.',
      input: { hint: '[include-unscoped]' },
      handler: async (invocation: any) => {
        const agentId = String(invocation?.agent?.id ?? '')
        const workspace = liveWorkspaceOf(agentId)
        const includeUnscoped = /include-unscoped/iu.test(String(invocation?.rawInput ?? ''))
        const result = quarantineWorkspaceMemory(resolved.memoryDir, resolved.skillsDir, workspace, { includeUnscoped })
        const moved = result.skills.length + result.negatives
        if (moved === 0) {
          return { kind: 'success' as const, text: `当前工作区（${workspace}）没有可清理的记忆；保留 ${result.kept} 条。` }
        }
        return {
          kind: 'success' as const,
          text: [
            `已隔离 ${result.skills.length} 条技能、${result.negatives} 条负知识（工作区 ${workspace}）。`,
            `保留 ${result.kept} 条（其它工作区 + global）。`,
            `隔离目录：${result.quarantineDir}（含 MANIFEST.json，可直接移回）`,
          ].join('\n'),
        }
      },
    })
  }
  registerMemoryConsole()

  try {
    ctx.logger?.info?.(
      `[dsh-memory] ready: ledger=${resolved.graftDataDir} memory=${resolved.memoryDir} skills=${resolved.skillsDir} ` +
        `extractor=${resolved.extractor} autoApprove=${resolved.autoApprove} retrieval=${resolved.retrieval} semanticFilter=${resolved.semanticFilter} ` +
        `workspaceIsolation=${resolved.workspaceIsolation}`,
    )
  } catch {
    // Logging must not block activation.
  }
}

export const activate = apply