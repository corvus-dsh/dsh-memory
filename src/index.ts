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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { readLedgers, describeLedgerSkips, describeMissingLedgerDir, SUPPORTED_LEDGER_EPOCH } from './ledger.js'
import { MEMORY_LAYOUT_FILES, MEMORY_LAYOUT_VERSION, writeLayoutManifest } from './layout.js'
import { resolveModelTarget, segmentSession } from './segment.js'
import { extractEpisode } from './extract.js'
import type { EvidenceRef, ExtractionResult } from './extract.js'
import { findSkillCandidate } from './dedupe.js'
import { retrieve, renderHint, retrieveWithFilter, collectScenes, extractTaskTerms, askAsksForFix, DEFAULT_RETRIEVAL_THRESHOLD, isolateHint, currentCommitOf } from './retrieve.js'
import { applySkillArchive, listSkillSummaries, planSkillArchive, DEFAULT_SKILL_LIMIT } from './archive.js'
import { currentWorkspaceOf, memoryAllowsWorkspace, workspaceOfSession } from './workspace.js'
import { applySupersede, listSkillRecords, quarantineWorkspaceMemory, readSkillBody } from './store.js'
import { installLedgerExitFlush, startLedgerFlushTimer } from './ledger-cache.js'
import {
  defaultKnowledgeDir,
  normalizeVocabList,
  queryKnowledge,
  readKnowledge,
  renderPhaseHint,
  writeKnowledge,
} from './knowledge.js'
import {
  GOAL_NODE_ID,
  START_NODE_ID,
  describeGraph,
  graphPath,
  harvestingPrompt,
  markHarvested,
  readGraph,
  renderNodeBanner,
  updateGraph,
} from './graph.js'

/**
 * v0.32 — THE STORE'S WRITE SURFACE, re-exported for the causal layer's tests and for any consumer that
 * needs to write a layer record directly.
 *
 * These already existed and were reachable through `lib/store.js`; they are surfaced from the package entry
 * so the causal schema can be exercised without importing an internal module path — which is what a test
 * SHOULD be able to do, and what a downstream consumer will be able to do tomorrow.
 */
export {
  appendExperiences,
  appendFacts,
  appendNegatives,
  appendMemoryAudit,
  listSkillRecords,
  readSkillBody,
  writeSkill,
} from './store.js'
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
// v0.22 P1: the strict bar moved to `retrieve.ts`, which is where the degradation path
// needs it. It is re-exported here so every existing importer keeps working.
export { DEFAULT_RETRIEVAL_THRESHOLD } from './retrieve.js'
/**
 * v0.32 — CAUSAL RETRIEVAL, exported for the consumer that must DECIDE rather than be hinted.
 *
 * `memory_search` answers "what looks like this"; `causalChain` answers "what must be true first, what
 * forbids this, and what evidence supports it". The second question is what a scheduler or a compiler asks,
 * and it is answered by following the schema's pointers rather than by word overlap.
 *
 * v0.38 — `recursiveCausalChain` is the SAME walk repeated downward, with a hard depth limit. The
 * one-hop answer is a level; a compiler needs a graph, and a graph is what this returns.
 */
export { causalChain, describeCausalChain, recursiveCausalChain, describeCausalGraph, fileCausalSource } from './causal.js'
export type {
  CausalChain,
  CausalNode,
  CausalGraph,
  CausalGraphNode,
  CausalGraphEdge,
  CausalRecordSource,
  RecursiveChainOptions,
} from './causal.js'
/* ── THE TEST-SEAM SURFACE ────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS IS: exports that exist so the TEST SUITES can reset or inspect internal state. They are
 * exported because a test can only reach what a module exports; none of them is a feature.
 *
 * THE SEAMS, AND WHERE EACH LIVES (module-level ones are imported by tests directly from `lib/`):
 *   - `resetMonotonicClockForTest`      (src/store.ts)     — re-exports the clock reset
 *   - `resolveMemoryConfigForTest`      (here)             — the real resolver, not a copy
 *   - `clearFilterCache` / `filterCacheStats`   (src/filter.ts)
 *   - `clearSceneCache` / `sceneCacheStats` / `clearCommitCache`   (src/retrieve.ts)
 *
 * THEY ARE NOT PUBLIC API. A change here is not a breaking change and no documentation promises them.
 *
 * THE INVENTORY IS LOCKED BY A TEST (`test/v102-seam-inventory.test.mjs`): the entry's export surface
 * is pinned as literals, and each module-level seam above is asserted to still be exported. THE RULE
 * WHEN YOU NEED A NEW ONE: give it a `…ForTest` / `clear…` / `…Stats` name so the convention test
 * sees it, prefer a module-level export over widening the ENTRY, and register it in the inventory test
 * in the same commit. A production-sounding name that only tests use is the thing this rule prevents.
 *
 * MEASURED, NOT ASSUMED (2026-11-08): the entry exports 31 names, TWO of which are seam-shaped. The
 * wider measure — every export with no consumer outside the tests, across all four repositories and
 * their scripts — is 54 names today, of which these are the 7 that are seams by shape. The audit's
 * earlier figure for this repository was 22; the difference is the METHOD (that list was filtered by
 * seam heuristics, this one by "no non-test consumer"), and the honest statement is the measured one.
 * The remaining 47 are ordinary helpers exercised by unit tests, not seams — they stay untouched.
 */
export { monotonicTimestamp, resetMonotonicClockForTest } from './store.js'

export interface MemoryConfig {
  /** Where the slicing plugin keeps its ledgers. Default: sibling `dsh-graft-slice` data dir. */
  graftDataDir?: string
  /** Where SKILL.md files go. Default: `~/.agents/skills` (scanned by DSH itself). */
  skillsDir?: string
  /** `negatives.jsonl` / `processed.json` / `suggestions.jsonl`. Default: `<paths.data>/.dsh-memory`. */
  memoryDir?: string
  /**
   * v1.4.0 — WHICH STORAGE TIER RETRIEVAL READS THROUGH.
   *
   *   'json'   (default) the ledger cache + full scan. Every tested behaviour lives here.
   *   'sqlite' an inverted index on disk. Faster and lower-heap at scale, but it is DERIVED
   *            data: the JSONL ledgers remain the record of truth, and the index must be built
   *            or rebuilt from them.
   *
   * THE DEFAULT IS 'json' ON PURPOSE, and not out of conservatism. The two tiers were measured
   * head to head over 10000 rows and 300 retrievals:
   *
   *   RSS增量   json 143.1 MB   sqlite  29.9 MB
   *   RSS绝对   json 238.4 MB   sqlite 271.6 MB
   *   retrieval json   4.62 ms  sqlite   2.79 ms
   *
   * The index wins on marginal memory and latency, and LOSES on absolute RSS because SQLite's
   * page cache is resident. So it is an upgrade for a large, read-heavy store, not a universal
   * replacement — which is exactly why it is a switch and not a rewrite.
   */
  storageTier?: 'json' | 'sqlite'
  /** Where the SQLite index lives when `storageTier: 'sqlite'`. Default `<memoryDir>/.index.db`. */
  indexDbPath?: string
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
  /**
   * v0.20 TASK ALIGNMENT. Default TRUE.
   *
   * The workspace gate answers "was this memory produced here"; this one answers
   * "is it about what I am doing now". Inside one repository the dominant memory
   * shape is the incident log — "when X reports SOURCE_DRIFT, …" — which is
   * valuable for the task that hit it and actively harmful in an unrelated one: a
   * model handed a confident, specific instruction about a problem it does not have
   * will follow it.
   *
   * A memory whose SHAPE is an incident log and which shares NO distinctive term
   * with the user's ask is removed from the pool before scoring. A METHOD-shaped
   * memory only needs the existing scene/workspace gates, because a user's phrasing
   * rarely matches a skill's trigger word and recall must not die for that.
   *
   * Off exists for a differential test and for an operator debugging the gate; it
   * is not a tuning knob.
   */
  taskAlignment?: boolean
  /**
   * v0.21 P1: ACTIVE skills above which one archival pass runs at activation.
   * Default 100 (see `DEFAULT_SKILL_LIMIT`). 0 disables the pass.
   */
  skillLimit?: number
  /**
   * GLOBAL KNOWLEDGE BASE — where the cross-workspace store lives.
   * Default `~/.dsh/global-knowledge`, deliberately outside every profile and workspace.
   */
  knowledgeDir?: string
  /**
   * PHASE NUDGE — inject the current DAG node's phase banner at `agent/pre-step`. Default true.
   *
   * It fires only when a graph exists AND the active node changed since the last banner, so a
   * session parked on one node is told once instead of every turn. Off exists for a differential
   * test, not as a tuning knob.
   */
  phaseNudge?: boolean
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
    // v0.20: on by default. A filter that is off by default protects nobody.
    taskAlignment: config.taskAlignment !== false,
    // v0.21: 0 disables the archival pass; absent means the default threshold.
    skillLimit:
      Number.isFinite(Number(config.skillLimit)) && Number(config.skillLimit) >= 0
        ? Math.trunc(Number(config.skillLimit))
        : DEFAULT_SKILL_LIMIT,
    knowledgeDir:
      typeof config.knowledgeDir === 'string' && config.knowledgeDir.length > 0
        ? config.knowledgeDir
        : defaultKnowledgeDir(),
    // GLOBAL KNOWLEDGE BASE: on by default, same reasoning as `taskAlignment` — a phase banner
    // that is off by default protects nobody. It fires once per node, not once per turn.
    phaseNudge: config.phaseNudge !== false,
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
  /**
   * v0.18: the epoch each ledger file was read at, and the files that had to be
   * REFUSED this round. `deferred: true` means a retry is owed — the harvest that
   * returns it mined only the ledgers it could trust.
   */
  ledger: {
    epoch: { retired: number; transferred: number }
    supportedEpoch: number
    skipped: Array<{ file: string; epoch: number; reason: string }>
    deferred: boolean
  }
}

/**
 * v0.5 optimistic-concurrency stamp.
 *
 * Covers the files harvest reads and writes; a change between "read" and "write"
 * means another harvest finished in between. The write phase merges (read-modify-
 * write inside the store), so the correct response is a merge + retry of the
 * WRITE — never a second LLM extraction, which is the expensive part.
 *
 * v1.0.0 P0 — THE EDGE INDEX IS PART OF THE STORE VERSION.
 *
 * v1.0.0 moved conflict edges out of SKILL.md and into `skills-edges.jsonl`. That made a
 * new piece of durable state that the stamp could not see: an operation can now change
 * the store's conflict graph while every SKILL.md stays byte-identical. Without this entry,
 * `versionBeforeWrites !== versionAtExtractStart` would report "no concurrent write" for a
 * change that DID happen.
 *
 * Found by auditing my own change rather than by a failing test — which is the honest
 * status: it is a correctness gap that no current test exercises, because the edge index is
 * append-only and idempotent, so a missed merge costs a redundant retry, not data. It is
 * still wrong to leave a state file outside the stamp.
 */
export const STORE_VERSION_MEMORY_FILES = [
  'negatives.jsonl',
  'negatives-archive.jsonl',
  'processed.json',
  'facts.jsonl',
  'experiences.jsonl',
  'suggestions.jsonl',
] as const
/** Files that live in the SKILLS directory rather than the memory directory. */
export const STORE_VERSION_SKILL_FILES = ['skills-edges.jsonl'] as const

export function snapshotStoreVersion(memoryDir: string, skillsDir: string): string {
  const parts: string[] = []
  for (const file of STORE_VERSION_MEMORY_FILES) {
    try {
      const state = statSync(join(memoryDir, file))
      parts.push(`${file}:${state.size}:${Math.round(state.mtimeMs)}`)
    } catch {
      parts.push(`${file}:-`)
    }
  }
  /** Non-skill files inside the skills directory (the edge index) participate too. */
  for (const file of STORE_VERSION_SKILL_FILES) {
    try {
      const state = statSync(join(skillsDir, file))
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
  // v0.18: a refused ledger is announced, not silently treated as empty. The
  // harvest still runs over the files it COULD trust, and the next round retries
  // the refused one — never "read half a record and generate a skill from it".
  if (ledgers.deferred) {
    warnings.push(`handoff ledger deferred: ${describeLedgerSkips(ledgers)}`)
  }
  /**
   * P1-4 (live finding): an ABSENT directory is not an empty history.
   *
   * Measured on the running host: this reader and the slicing plugin disagreed about where the ledger
   * lives, the directory here did not exist, and the report said `retired: 0` with no complaint —
   * which reads exactly like "nothing has been retired yet". The two facts have different next
   * actions (configure the directory / nothing to do), so the report carries the difference. It stays
   * a WARNING rather than a deferral: there is nothing to be wrong about in a directory that is not
   * there, so no gate changes and no round is wasted.
   */
  const missingLedgerDir = describeMissingLedgerDir(ledgers)
  if (missingLedgerDir.length > 0) warnings.push(missingLedgerDir)
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
      // v0.22 P0: was this source ALREADY retired when we started?
      //
      // Harvest normally mines finished (retired) sessions, so `true` is the common
      // case. It is the BASELINE that makes the race detectable: only a source that
      // becomes retired DURING the work has moved under us.
      const retiredAtStart =
        ledgers.transferred[sessionId] !== undefined || ledgers.retired.includes(sessionId)
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
        /**
         * v1.0.2 — THE GENERATION AND THE COMMIT THIS EXPERIENCE BELONGS TO.
         *
         * Read from the graft target store and from git — never from the model. Without
         * them a skill extracted against commit A reads exactly as authoritative after the
         * code moved to B; with them retrieval can demote it and the hint can say so.
         */
        ...(() => {
          const workspace = workspaceOfSession(log)
          const commitHash = workspace.length === 0 ? '' : currentCommitOf(workspace)
          return commitHash.length === 0 ? {} : { commitHash }
        })(),
        ...(() => {
          try {
            const parsed = JSON.parse(readFileSync(join(resolved.graftDataDir, '.graft-targets.json'), 'utf8'))
            const generation = Number(parsed?.[sessionId]?.generation)
            return Number.isFinite(generation) && generation > 0 ? { generation: Math.trunc(generation) } : {}
          } catch {
            return {}
          }
        })(),
      }
      const harvestedEvents = ((log as any).events ?? []) as readonly unknown[]
      /**
       * v0.22 P0: THE RETIREMENT RACE.
       *
       * `harvest` reads a session, spends up to a minute in the model call, then
       * writes. Meanwhile dsh-graft-slice may be SLICING that very session: the source
       * is mid-handoff, its log is still growing, and `boundarySeq` was computed from a
       * prefix that no longer represents the finished episode.
       *
       * Two things must hold if that happens:
       *
       *   1. no cursor is written — a `processed` key for a boundary the source had not
       *      actually reached would make the FINISHED session look already mined, and
       *      its real lessons would never be extracted;
       *   2. whatever was already written stays (skills are additive and the merge path
       *      is idempotent), so the retry does not duplicate them.
       *
       * Detection is by re-reading the LEDGER, not the log: a source present in
       * `.transferred.json` after we started has been handed off, which is exactly the
       * "it moved under us" condition.
       */
      const retiredWhileWorking = (() => {
        const now = readLedgers(resolved.graftDataDir)
        const transferredNow = now.transferred[sessionId] !== undefined || now.retired.includes(sessionId)
        if (!transferredNow) return false
        // It was ALREADY retired when we started (the normal case: harvest mines
        // finished sessions) → not a race. It became retired DURING the work → race.
        return !retiredAtStart
      })()
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
          if (retiredWhileWorking) {
            // v0.22 P0: DO NOT advance the cursor. The source was sliced while we were
            // extracting, so the boundary we segmented is a prefix of a log that kept
            // growing: recording it would mark the FINISHED session as already mined and
            // its real lessons would never be read. Everything already written stays —
            // the merge path is idempotent — so the retry adds the rest, not duplicates.
            warnings.push(
              `${sessionId}: the source was retired during extraction (a slice landed mid-harvest); ` +
                'the processed cursor was NOT advanced, so the finished session will be re-mined on the next run',
            )
            skipped.push(`${sessionId}: deferred — retired mid-harvest, cursor left untouched`)
            break
          }
          // v0.22 P0: guard the cursor against a boundary that moved for any OTHER
          // reason too. `processed` is the only thing standing between the store and a
          // duplicate mining of the same episode, so it is written from a fresh read.
          const latestBoundary = segmentSession(sessionId, log as { events?: unknown[] }).boundarySeq
          if (latestBoundary !== episode.boundarySeq) {
            warnings.push(
              `${sessionId}: boundary moved during extraction (${episode.boundarySeq} -> ${latestBoundary}); ` +
                'the cursor was NOT advanced',
            )
            skipped.push(`${sessionId}: deferred — boundary moved, cursor left untouched`)
            break
          }
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
    ledger: {
      epoch: ledgers.epoch,
      supportedEpoch: SUPPORTED_LEDGER_EPOCH,
      skipped: ledgers.skipped.map((skip) => ({ file: skip.file, epoch: skip.epoch, reason: skip.reason })),
      deferred: ledgers.deferred,
    },
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
/**
 * v0.20: `taskAlignment` joins the console's writable set.
 *
 * A gate an operator cannot toggle is a gate that gets disabled by editing YAML and
 * restarting — which is the experience the console exists to remove.
 */
const MEMORY_CONSOLE_KEYS = new Set(['retrieval', 'workspaceIsolation', 'semanticFilter', 'autoApprove', 'taskAlignment'])
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

/**
 * Test-only entry point for the resolved config.
 *
 * `resolveConfig` stays module-private because it is an implementation detail of
 * every entry point; veiling it behind a named export keeps the test honest (it
 * exercises the real resolver, not a copy) without widening the public surface.
 */
export function resolveMemoryConfigForTest(ctx: ContextLike, config: MemoryConfig = {}) {
  return resolveConfig(ctx, config)
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

/**
 * The nodes a `knowledge_harvest` call is expected to mark as answered.
 *
 * THE ACTIVE NODE IS THE ONE THAT WAS ASKED. A `complete` returns its prompt for the node that just
 * finished, and that node is usually activated-then-completed; but the model may harvest one step
 * later, when a DIFFERENT node is active. So the answer marks every node that is `done` without a
 * `harvestedAt` — the exact set the warning is about — which is also what keeps the reminder honest
 * across a restart. `markHarvested` is idempotent, so an over-broad list costs nothing.
 */
function activeNodeIdsForHarvest(memoryDir: string): string[] {
  try {
    const graph = readGraph(memoryDir)
    return graph.nodes
      .filter((node) => node.status === 'done' && node.harvestedAt.length === 0 && node.id !== START_NODE_ID)
      .map((node) => node.id)
  } catch {
    return []
  }
}

function applyInner(ctx: ContextLike, config: MemoryConfig): void {
  const resolved = resolveConfig(ctx, config)
  /**
   * v1.1.0 — START THE LEDGER FLUSH LOOP.
   *
   * Writes now land in a WAL and are merged into the main ledger on a schedule. Without this
   * timer the deferral would only end at process exit, so a long-lived plugin would hold an
   * ever-growing WAL and a reader in ANOTHER process would not see the rows.
   *
   * The timer is `unref`ed inside `startLedgerFlushTimer`, so it never keeps the host alive.
   * The exit hook is a best-effort last flush; a hard kill loses at most one interval, which
   * is the documented durability window.
   *
   * Tests run with `NODE_TEST_CONTEXT` set and flush per write, so the timer changes nothing
   * under test.
   */
  try {
    startLedgerFlushTimer()
    installLedgerExitFlush()
  } catch {
    // A plugin must not fail to activate because a timer could not be created.
  }
  /**
   * P1-2: PUBLISH THIS STORE'S LAYOUT, so the reader on the other side can REFUSE rather than guess.
   *
   * `dsh-graft-slice` reads four files out of this directory by name and degrades every unreadable
   * one to `[]` — so a rename here reads to it as "this workspace recorded nothing", a silent zero.
   * `.layout.json` is what turns that into a named refusal. See `layout.ts`.
   *
   * Written at ACTIVATION, not on first write: the contract must exist before the other plugin has
   * anything to read, otherwise the first read of a brand-new store is unversioned by construction.
   * `writeLayoutManifest` is idempotent by content, so this does not touch the directory's mtime on
   * every reload.
   */
  try {
    writeLayoutManifest(resolved.memoryDir, {
      layout: MEMORY_LAYOUT_VERSION,
      producer: 'dsh-memory',
      files: MEMORY_LAYOUT_FILES,
    })
  } catch {
    // A store that cannot be stamped is still usable. The other side then sees an absent manifest
    // and proceeds — the pre-P1-2 behaviour — which is the safe direction for a failed marker.
  }
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
    execute: async (_args: unknown, exec: any) => ({
      ...stats(resolved.memoryDir, resolved.skillsDir),
      queued: listSuggestions(resolved.memoryDir).length,
      graftDataDir: resolved.graftDataDir,
      extractor: resolved.extractor,
      autoApprove: resolved.autoApprove,
      llmAvailable,
      /**
       * ── TD-12: THE TASK GRAPH HAS NEVER BEEN CREATED ────────────────────────────────────────────
       *
       * `memory_graph_read`, `memory_graph_update` and the cross-slice phase nudge are all
       * implemented and `phaseNudge` defaults to ON — and the whole chain is inert, because
       * `readGraph` returns an EMPTY graph for a missing file instead of throwing, so a session
       * that never called `memory_graph_update` looks exactly like one with an empty plan.
       *
       * The graph is created by the MODEL, deliberately: an auto-created graph would have no
       * author, and "who decided this is phase 2" is the one thing a task graph is for. The cost
       * of that choice is that nothing gets built unless something SAYS so — and nothing did.
       *
       * So this is not a behaviour change, it is one line of text at the only moment the model is
       * already looking: `task-graph.json` absent ⇒ say so, and say what to do about it.
       */
      taskGraph: (() => {
        const path = graphPath(resolved.memoryDir)
        const present = existsSync(path)
        const graph = readGraph(resolved.memoryDir)
        const phaseNodes = graph.nodes.filter((node) => node.fixed !== true)
        return {
          present,
          path,
          nodes: graph.nodes.length,
          /** Nodes the model created. The fixed START node is not a phase. */
          phaseNodes: phaseNodes.length,
          ...(present
            ? {}
            : {
                hint:
                  '[提示] 尚无任务图。多步任务建议先调用 memory_graph_update 创建阶段节点，' +
                  '之后每完成一个阶段更新状态；跨切片的阶段提示依赖它。',
              }),
        }
      })(),
      /**
       * ── AUDIT ROUND 3 (P1-1): "6 skills" IS NOT AN ANSWER; "0 of 6 usable HERE" IS ──────────────
       *
       * `stats()` reports a bare DIRECTORY COUNT. On the audited machine it said `skills: 6` while
       * retrieval matched zero — every skill was `scope: project` recorded in a DIFFERENT workspace,
       * so the fail-closed gate was behaving correctly and the number was still misleading. The only
       * readout that explained it lived in `graft_debug_status`, i.e. in another plugin.
       *
       * These fields are computed with the SAME `memoryAllowsWorkspace` predicate retrieval uses, so
       * they cannot disagree with what a turn would actually be offered. Nothing about eligibility
       * changes — the answer is merely printed.
       */
      ...(() => {
        const visibility = skillVisibilityFor(liveWorkspaceOf(callingAgentIdOf(exec)))
        return {
          counts: {
            skills: visibility.total,
            matchedInWorkspace: visibility.eligible,
            blockedByWorkspace: visibility.blocked,
          },
          workspace: visibility.workspace,
          ...(visibility.note === '' ? {} : { visibilityNote: visibility.note }),
        }
      })(),
      // v0.18: so the console can say WHY nothing was harvested after a version
      // change instead of showing an empty ledger that looks like "no sessions".
      ledger: (() => {
        const snapshot = readLedgers(resolved.graftDataDir)
        return {
          epoch: snapshot.epoch,
          supportedEpoch: SUPPORTED_LEDGER_EPOCH,
          deferred: snapshot.deferred,
          skipped: snapshot.skipped,
          graftDataDir: snapshot.directory.path,
          graftDataDirPresent: snapshot.directory.present,
          /**
           * The COUNTS, not just the epoch. "Which directory did you read, and did you see anything"
           * is the question a misconfigured deployment makes urgent, and answering it from this tool
           * is what turns a silent empty ledger into one line a reader can check.
           */
          retired: snapshot.retired.length,
          transferred: Object.keys(snapshot.transferred).length,
          ...(snapshot.layoutRefusal === undefined ? {} : { layoutRefusal: snapshot.layoutRefusal }),
        }
      })(),
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
        // v0.18: "the newest session in the ledger" is a GUESS, and a refused
        // ledger is exactly when guessing would stamp evidence onto the wrong
        // source. Skip, say why, and let the caller retry with an explicit id.
        if (ledgers.deferred) {
          return {
            error:
              `handoff ledger is not trustworthy this round, so the newest session is not guessed: ` +
              `${describeLedgerSkips(ledgers)}. Retry after the next complete write, or pass sessionId explicitly.`,
          }
        }
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

  /**
   * v0.32 — the workspace of a LIVE session, resolved from the session, not the payload.
   *
   * The bug this replaces, measured on 0.2.2-rc.1: `agent/pre-step` hands over
   * `{ agent: { id } }` and nothing else — `Agent` is `{ readonly id: SessionId }`,
   * with no `cwd`, no `workspace`, no `workingDirectory`. `currentWorkspaceOf(payload)`
   * therefore fell through to `process.cwd()`, which is the Electron app directory, so
   * the isolation gate compared "D:/workspace" against the app path and refused
   * EVERY project-scoped memory. The gate failed closed so quietly that the only
   * symptom was "no hint was ever injected", which is indistinguishable from an empty
   * store. `memory_search` had the same hole for the same reason.
   *
   * Returns '' when nothing resolvable is available, so the caller can fall back
   * explicitly instead of inheriting an app directory as if it were the workspace.
   */
  const sessionWorkspaceOf = (agentId: string): string => {
    if (agentId.length === 0) return ''
    try {
      const session = (ctx.get?.('sessions') as any)?.get?.(agentId)
      if (session !== undefined && session !== null) {
        const wd = ctx.get?.('workingDirectory') as any
        if (wd !== undefined && wd !== null && typeof wd.get === 'function') {
          const value = wd.get(session)
          if (typeof value === 'string' && value.trim().length > 0) return value.trim()
        }
        const cwd = (session as any)?.header?.cwd
        if (typeof cwd === 'string' && cwd.trim().length > 0) return cwd.trim()
      }
    } catch {
      // An unresolvable session is "unknown workspace", never "any workspace".
    }
    return ''
  }

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
    execute: async (args: { query: string; threshold?: number; semantic?: boolean; workspace?: string }, exec?: { agent?: { id?: string } }) => {
      const query = String(args.query ?? '')
      const explicitThreshold = Number.isFinite(Number(args.threshold)) ? Number(args.threshold) : undefined
      // v0.8: a manual search is still a read of memory, so it obeys the same
      // gate. The caller may name the workspace explicitly; otherwise the answer is
      // the CALLING session's directory (v0.32 — it used to be `process.cwd()`,
      // which is the app directory and matched no memory at all).
      const explicitWorkspace =
        typeof args.workspace === 'string' && args.workspace.trim().length > 0 ? args.workspace : undefined
      const gate = resolved.workspaceIsolation
        ? {
            workspace:
              explicitWorkspace ??
              (sessionWorkspaceOf(typeof exec?.agent?.id === 'string' ? exec.agent.id : '') || currentWorkspaceOf(undefined)),
          }
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

  /**
   * ── GLOBAL KNOWLEDGE BASE ──────────────────────────────────────────────────────────────────────
   *
   * These four tools are the cross-workspace surface. Keep them clearly separate from the workspace
   * memory tools above: `memory_*` answers "what did THIS project learn", `knowledge_*` answers
   * "what is known about this SUBJECT and this PHASE, anywhere". Conflating them would either
   * weaken the workspace gate or make the phase query depend on prompt wording.
   */
  ctx.tools?.register({
    name: 'knowledge_query',
    description:
      'Cross-workspace retrieval by vocabulary: find skills and pitfalls whose tags and applicable node types match, regardless of which project produced them. ' +
      'Use it when entering a DAG phase (pass nodeType) or when the task names a subject you may have solved before. Returns metadata only; read a skill body with knowledge_read.',
    parameters: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: 'Subject tags, e.g. ["python","api","auth"].' },
        nodeType: { type: 'string', description: 'Phase key, e.g. analysis / coding / testing / refactoring.' },
        kinds: { type: 'array', items: { type: 'string' }, description: 'Restrict to ["skill"] or ["negative"].' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    output: textOutput(),
    execute: async (args: { tags?: unknown; nodeType?: string; kinds?: unknown; limit?: number } = {}) => {
      const result = queryKnowledge(resolved.knowledgeDir, {
        tags: args.tags,
        nodeType: args.nodeType,
        kinds: args.kinds,
        limit: args.limit,
      })
      /**
       * THE BANNER ONLY WHEN A PHASE WAS NAMED. `renderPhaseHint('', …)` produces "you are entering
       * [当前]" — a sentence that announces nothing — because an empty phase key makes the label a
       * placeholder. A tag-only query is a subject search, not a phase entry, so it returns the
       * hits and no banner.
       */
      const nodeType = typeof args.nodeType === 'string' ? args.nodeType.trim() : ''
      const hint = nodeType.length === 0 ? undefined : renderPhaseHint(nodeType, result)
      return { ...result, knowledgeDir: resolved.knowledgeDir, ...(hint === undefined ? {} : { hint }) }
    },
  })

  ctx.tools?.register({
    name: 'knowledge_harvest',
    description:
      'Write what this phase taught you into the GLOBAL knowledge base: a reusable skill or a pitfall, plus the tags (subject) and applicable node types (phase) that make it reachable from other projects. ' +
      'Entries with neither tags nor node types are stored but will not travel — that is the honest option for a project-specific lesson.',
    parameters: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Lowercase kebab-case identity; a repeat id merges.' },
              kind: { type: 'string', enum: ['skill', 'negative'] },
              title: { type: 'string' },
              when: { type: 'string', description: 'The trigger: when does this apply.' },
              body: { type: 'string', description: 'The procedure, or the pitfall in plain text.' },
              tags: { type: 'array', items: { type: 'string' } },
              applicable_node_types: { type: 'array', items: { type: 'string' } },
              evidence: { type: 'array', items: { type: 'string' } },
            },
            required: ['id'],
            additionalProperties: false,
          },
        },
        workspace: { type: 'string', description: 'Provenance only. Defaults to the calling session workspace.' },
      },
      required: ['entries'],
      additionalProperties: false,
    },
    output: textOutput(),
    execute: async (args: { entries?: unknown; workspace?: string } = {}, exec?: { agent?: { id?: string } }) => {
      const raw = Array.isArray(args.entries) ? args.entries : []
      if (raw.length === 0) return { error: 'entries is required and must be a non-empty array' }
      const workspace =
        typeof args.workspace === 'string' && args.workspace.trim().length > 0
          ? args.workspace
          : sessionWorkspaceOf(typeof exec?.agent?.id === 'string' ? exec.agent.id : '') || currentWorkspaceOf(undefined)
      const result = writeKnowledge(
        resolved.knowledgeDir,
        raw.map((item) => {
          const record = (item ?? {}) as Record<string, unknown>
          return {
            id: String(record.id ?? ''),
            kind: record.kind === 'negative' ? ('negative' as const) : ('skill' as const),
            title: typeof record.title === 'string' ? record.title : undefined,
            when: typeof record.when === 'string' ? record.when : undefined,
            body: typeof record.body === 'string' ? record.body : undefined,
            tags: record.tags,
            applicableNodeTypes: record.applicable_node_types ?? record.applicableNodeTypes,
            evidence: record.evidence,
          }
        }),
        { workspace },
      )
      /**
       * AN ACTUAL WRITE IS WHAT CLEARS THE WARNING.
       *
       * A refused entry does not count: `written + merged === 0` means the store learned nothing,
       * so stamping the node would silence the reminder without answering it. The active node is
       * stamped, which is the node the warning was about.
       */
      const recorded = result.written + result.merged
      const harvested = recorded === 0 ? [] : markHarvested(resolved.memoryDir, activeNodeIdsForHarvest(resolved.memoryDir))
      return {
        ...result,
        knowledgeDir: resolved.knowledgeDir,
        workspace,
        ...(harvested.length === 0 ? {} : { harvestedNodes: harvested }),
      }
    },
  })

  ctx.tools?.register({
    name: 'knowledge_read',
    description: 'Read one global knowledge entry in full (body included) by id, after knowledge_query named it.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    output: textOutput(),
    execute: async (args: { id?: string } = {}) => {
      const id = String(args.id ?? '').trim().toLowerCase()
      if (id.length === 0) return { error: 'id is required' }
      const entry = readKnowledge(resolved.knowledgeDir).find((item) => item.id === id)
      if (entry === undefined) {
        return {
          error: `no knowledge entry "${id}" in ${resolved.knowledgeDir}`,
          total: readKnowledge(resolved.knowledgeDir).length,
        }
      }
      return entry
    },
  })

  ctx.tools?.register({
    name: 'knowledge_stats',
    description: 'How large the global knowledge base is, by tag and by node type, and how many entries have ever been referenced by a task node.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput(),
    execute: async () => {
      const entries = readKnowledge(resolved.knowledgeDir)
      const tags = new Map<string, number>()
      const nodeTypes = new Map<string, number>()
      for (const entry of entries) {
        for (const tag of entry.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1)
        for (const nodeType of entry.applicableNodeTypes) nodeTypes.set(nodeType, (nodeTypes.get(nodeType) ?? 0) + 1)
      }
      const counts = describeGraph(resolved.memoryDir, entries)
      return {
        knowledgeDir: resolved.knowledgeDir,
        memoryDir: resolved.memoryDir,
        entries: entries.length,
        skills: entries.filter((entry) => entry.kind === 'skill').length,
        negatives: entries.filter((entry) => entry.kind === 'negative').length,
        /** An entry with neither axis can never be reached from another workspace — worth counting. */
        localOnly: entries.filter((entry) => entry.tags.length === 0 && entry.applicableNodeTypes.length === 0).length,
        tags: [...tags.entries()].sort((left, right) => right[1] - left[1]).map(([tag, count]) => ({ tag, count })),
        nodeTypes: [...nodeTypes.entries()].sort((left, right) => right[1] - left[1]).map(([nodeType, count]) => ({ nodeType, count })),
        graph: counts.counts,
        /**
         * THE WRITE HALF'S REPORT LINE.
         *
         * `graph.done` counts finished phases; `unharvested` counts the ones that finished WITHOUT
         * recording anything. A DAG that keeps growing while this number keeps growing is a project
         * learning nothing, and that is invisible from either number alone.
         */
        unharvested: counts.nodes.filter(
          (node) => node.status === 'done' && node.harvestedAt.length === 0 && node.id !== START_NODE_ID,
        ).length,
      }
    },
  })

  /**
   * ── DYNAMIC TASK GRAPH ────────────────────────────────────────────────────────────────────────
   *
   * `memory_graph_read` is the read half (the DAG view, plus what each node is anchored to);
   * `memory_graph_update` is the write half. They are two tools rather than one with a `read` op
   * because a read must never take the write lock, and because a model that only wants to look at
   * the graph should not have to construct a mutation.
   */
  ctx.tools?.register({
    name: 'memory_graph_read',
    description:
      'Read the dynamic task DAG: the fixed start node, the (optionally locked) goal, every phase node with its node_type / requirements / status, ' +
      'the resolved knowledge each node points at, and the reverse links. Use it before editing the graph or when asked what phase you are in.',
    parameters: { type: 'object', properties: { graphId: { type: 'string' } }, additionalProperties: false },
    output: textOutput(),
    execute: async (args: { graphId?: string } = {}) => {
      const id = typeof args.graphId === 'string' && args.graphId.length > 0 ? args.graphId : 'default'
      const entries = readKnowledge(resolved.knowledgeDir)
      const described = describeGraph(resolved.memoryDir, entries, id)
      const active = described.nodes.find((node) => node.status === 'active')
      return {
        ...described,
        graphId: described.graph.id,
        goalLocked: described.graph.goalLockedAt.length > 0,
        activeNodeId: active?.id ?? '',
        activeBanner: renderNodeBanner(active) ?? '',
        path: join(resolved.memoryDir, 'task-graph.json'),
      }
    },
  })

  ctx.tools?.register({
    name: 'memory_graph_update',
    description:
      'Edit the dynamic task DAG. op: add | update | deprecate | activate | complete | lock-goal | unlock-goal. ' +
      'The START node is fixed and the GOAL node becomes immutable once locked (unlock-goal needs a reason). ' +
      'Nodes may carry knowledge_pointers; every accepted edit also records the reverse link in the global knowledge base.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['add', 'update', 'deprecate', 'activate', 'complete', 'lock-goal', 'unlock-goal'] },
        nodeId: { type: 'string' },
        graphId: { type: 'string' },
        goal: { type: 'string', description: 'For lock-goal: the objective that becomes immutable.' },
        reason: { type: 'string', description: 'Required for unlock-goal; recorded on every accepted edit.' },
        node: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            node_type: { type: 'string' },
            requirements: { type: 'array', items: { type: 'string' } },
            status: { type: 'string' },
            depends_on: { type: 'array', items: { type: 'string' } },
            knowledge_pointers: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: textOutput(),
    execute: async (args: Record<string, unknown> = {}) => {
      const node = (args.node ?? {}) as Record<string, unknown>
      const result = updateGraph(resolved.memoryDir, {
        graphId: typeof args.graphId === 'string' ? args.graphId : undefined,
        op: String(args.op ?? 'update') as never,
        nodeId: typeof args.nodeId === 'string' ? args.nodeId : typeof node.id === 'string' ? node.id : undefined,
        node: {
          id: typeof node.id === 'string' ? node.id : undefined,
          title: typeof node.title === 'string' ? node.title : undefined,
          nodeType: typeof node.node_type === 'string' ? node.node_type : typeof node.nodeType === 'string' ? node.nodeType : undefined,
          requirements: node.requirements,
          status: typeof node.status === 'string' ? node.status : undefined,
          dependsOn: node.depends_on ?? node.dependsOn,
          knowledgePointers: node.knowledge_pointers ?? node.knowledgePointers,
        },
        goal: typeof args.goal === 'string' ? args.goal : undefined,
        reason: typeof args.reason === 'string' ? args.reason : undefined,
        // The reverse anchor is written here, by the tool, so a caller cannot forget it.
        knowledgeDir: resolved.knowledgeDir,
      })
      /**
       * A refusal is a normal result, not an error: the model must READ why and try again. When the
       * edit gained pointers, the same call returns what those pointers resolve to, so the model
       * does not have to make a second query to know what it just anchored.
       */
      if (!result.ok) return result
      const pointers = result.node?.knowledgePointers ?? []
      const knowledge =
        pointers.length === 0
          ? undefined
          : queryKnowledge(resolved.knowledgeDir, { limit: Math.min(50, pointers.length) })
      return { ...result, ...(knowledge === undefined ? {} : { knowledge }) }
    },
  })

  /**
   * v0.22 P1: PROGRESSIVE DISCLOSURE — read a skill's procedure on demand.
   *
   * The pre-step hint carries only the trigger (`when_to_use`), because that is what
   * decides whether a skill is about the current task. The BODY — steps, verification,
   * pitfalls — is spent only when the model has decided it wants it, which is what
   * keeps a recall from costing every turn ~2 KB it may never use.
   */
  ctx.tools?.register({
    name: 'skill_read',
    description:
      'Read one stored skill\'s full procedure (执行步骤 / 验证标准 / pitfalls) by name, after a 记忆提示 named it. ' +
      'Metadata (name + when_to_use) already arrived with the hint; call this only when you have decided the skill applies.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The skill name exactly as the hint printed it.' } },
      required: ['name'],
      additionalProperties: false,
    },
    output: textOutput(),
    execute: async (args: { name?: string } = {}) => {
      const name = String(args.name ?? '').trim()
      if (name.length === 0) return { error: 'name is required' }
      const body = readSkillBody(resolved.skillsDir, name)
      if (body === undefined) {
        // Two different causes, one honest answer: not on disk, or refused by the
        // injection scan. Both mean "do not use this text", and the reply says which
        // without quoting the poisoned content.
        const records = listSkillRecords(resolved.skillsDir).find((record) => record.name === name)
        return {
          error:
            records === undefined
              ? `no skill named "${name}" in ${resolved.skillsDir}`
              : `skill "${name}" exists but its text was refused by the injection scan and cannot be read`,
        }
      }
      return {
        name: body.name,
        title: body.title,
        when: body.when,
        chars: body.chars,
        body: body.body,
      }
    },
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

  /**
   * v0.20: the task-alignment gate, kept per agent.
   *
   * The terms ACCUMULATE across the session's human turns. A follow-up ("继续",
   * "修一下", "然后呢") carries no task signal, and a gate rebuilt from it alone
   * would refuse every memory — which is the failure mode that gets a filter
   * switched off. Accumulating keeps the ask's original vocabulary in force while
   * still letting a genuinely new instruction widen it.
   *
   * `taskAlignment: false` disables the gate entirely (the differential switch).
   */
  const taskTermsByAgent = new Map<string, Set<string>>()
  const taskGate = (
    settings: { taskAlignment: boolean },
    agentId: string,
    userText: string,
  ): { taskTerms?: ReadonlySet<string>; taskAlignment?: boolean; taskFixIntent?: boolean } => {
    if (!settings.taskAlignment) return { taskAlignment: false }
    if (agentId.length === 0) return {}
    const fresh = extractTaskTerms(userText)
    const merged = taskTermsByAgent.get(agentId) ?? new Set<string>()
    for (const term of fresh) merged.add(term)
    taskTermsByAgent.set(agentId, merged)
    // Whether the CURRENT ask is about a failure. Read per turn, not accumulated:
    // "fix this" is a property of this request, and a debugging turn early in the
    // session must not keep incident logs in scope for a design turn later on.
    const fixIntent = askAsksForFix(userText)
    return {
      ...(merged.size === 0 ? {} : { taskTerms: merged as ReadonlySet<string> }),
      ...(fixIntent ? { taskFixIntent: true } : {}),
    }
  }

  const nudgeState = new Map<string, { userKey: string; lastId: string; lastAt: number }>()

  /**
   * ── PHASE NUDGE: "YOU ARE ENTERING [TESTING]" ─────────────────────────────────────────────────
   *
   * WHAT THIS IS: when the DAG's ACTIVE node changes, one sentence names the phase and how much
   * global knowledge applies to it. It is the read half of the phase loop; the write half is
   * `knowledge_harvest`, which the model calls when it finishes the node.
   *
   * WHAT IT IS NOT: a repeat. The key is `graphId:nodeId`, so a session parked on one node is told
   * once — a banner printed every turn is a banner the reader learns to skip, which is the same
   * reason the standing constraints are delivered once per process.
   *
   * IT DOES NOT RENDER A PROCEDURE. Only a count and up to three titles. The body is spent when the
   * model calls `knowledge_read`, which is the progressive-disclosure rule the rest of this plugin
   * already follows.
   *
   * FAILURE IS SILENT BY DESIGN. No graph, no active node, no matching knowledge, or a knowledge
   * directory that cannot be read all mean "nothing to say" — a phase lookup must never break a
   * step. The `lastPhaseKey` map is only advanced when a banner was actually produced, so a
   * temporarily empty knowledge base does not permanently silence the phase.
   */
  const lastPhaseKey = new Map<string, string>()
  /**
   * The un-harvested reminder, keyed `graphId:nodeId` like the phase banner.
   *
   * WHY THIS IS A SECOND CHANNEL AND NOT PART OF THE BANNER. The banner fires when a phase STARTS;
   * this fires when one finished without a harvest. They are about different nodes at different
   * moments, and folding them together would make the third repetition of the same `complete`
   * prompt the only reminder — which is exactly the case where the model ignored it.
   */
  const lastHarvestWarn = new Map<string, string>()
  const harvestWarningFor = (agentId: string): { id: string; role: 'user'; content: Array<{ type: 'text'; text: string }>; source: { kind: string } } | undefined => {
    if (!resolved.phaseNudge) return undefined
    try {
      const graph = readGraph(resolved.memoryDir)
      const pending = graph.nodes.filter(
        (node) => node.status === 'done' && node.harvestedAt.length === 0 && node.id !== START_NODE_ID,
      )
      if (pending.length === 0) return undefined
      const key = `${graph.id}:${pending.map((node) => node.id).join(',')}`
      if (lastHarvestWarn.get(agentId) === key) return undefined
      lastHarvestWarn.set(agentId, key)
      const names = pending
        .slice(0, 3)
        .map((node) => `${node.id}${node.nodeType.length > 0 ? `（${node.nodeType}）` : ''}`)
      return {
        id: `memory-harvest-warn-${agentId || 'session'}-${pending.map((node) => node.id).join('_')}`,
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `[系统提示] 节点 ${names.join('、')} 已完成，但还没有写入全局知识库。` +
              '请调用 knowledge_harvest 把本阶段的技能与踩坑点写进去，并标注 tags 与 applicable_node_types。' +
              '不写，下一个工作区就学不到这次的教训。',
          },
        ],
        source: { kind: 'plugin:dsh-memory' },
      }
    } catch {
      return undefined
    }
  }

  const phaseNudgeFor = (agentId: string): { id: string; role: 'user'; content: Array<{ type: 'text'; text: string }>; source: { kind: string } } | undefined => {
    if (!resolved.phaseNudge) return undefined
    try {
      const graph = readGraph(resolved.memoryDir)
      const active = graph.nodes.find((node) => node.status === 'active' && node.id !== START_NODE_ID)
      if (active === undefined) return undefined
      const key = `${graph.id}:${active.id}`
      if (lastPhaseKey.get(agentId) === key) return undefined
      // Requirements are the node's own words; using them as tags would query with prose. The
      // phase is the reliable axis, so the query is by node type only.
      const result = queryKnowledge(resolved.knowledgeDir, { nodeType: active.nodeType, limit: 5 })
      const banner = renderPhaseHint(active.nodeType, result)
      if (banner === undefined) return undefined
      lastPhaseKey.set(agentId, key)
      const requirements = active.requirements.length === 0 ? '' : `\n本阶段要求：${active.requirements.slice(0, 3).join('；')}`
      return {
        id: `memory-phase-${agentId || 'session'}-${active.id}`,
        role: 'user',
        content: [{ type: 'text', text: `${banner}${requirements}` }],
        source: { kind: 'plugin:dsh-memory' },
      }
    } catch {
      return undefined
    }
  }

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
        /**
         * THE PHASE BANNER IS COMPUTED FIRST AND INDEPENDENTLY.
         *
         * It must not depend on the lexical hint's gates: the phase is known from the graph, not
         * from the prompt, and the lexical path can legitimately return nothing (`userText` too
         * short, no match above the floor). Folding it in after those checks would mean "entering
         * testing" is announced only when the user's sentence happened to resemble a skill.
         */
        const phaseMessage = agentId.length === 0 ? undefined : phaseNudgeFor(agentId)
        const harvestMessage = agentId.length === 0 ? undefined : harvestWarningFor(agentId)
        const phaseMessages =
          phaseMessage === undefined && harvestMessage === undefined
            ? []
            : [phaseMessage, harvestMessage].filter(
                (message): message is { id: string; role: 'user'; content: Array<{ type: 'text'; text: string }>; source: { kind: string } } =>
                  message !== undefined,
              )
        const userText = lastUserText(payload?.messages)
        if (userText === undefined || userText.length < 4) {
          // Even without a retrievable ask, a phase change is still worth one line.
          if (phaseMessages.length === 0) return decision
          const base = Array.isArray(decision.messages) ? decision.messages : Array.isArray(payload?.messages) ? payload.messages : []
          return { ...decision, messages: [...base, ...phaseMessages] }
        }
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
          // v0.22 P1: a slow judge must not cost the TURN. Degrade to strict lexical
          // recall instead of injecting nothing; memory_search keeps fail-closed.
          degradeOnTimeout: true,
          // v0.8: the isolation gate. v0.32: the workspace comes from the SESSION
          // (`workingDirectory` / `session.header.cwd`), because the pre-step payload's
          // `Agent` is `{ id }` only — the old `currentWorkspaceOf(payload)` fell back
          // to `process.cwd()` (the app directory) and refused every project-scoped
          // memory, silently. The payload fallback stays for a host that does carry
          // the directory, and an unresolvable one still fails closed.
          ...(resolved.workspaceIsolation
            ? { workspace: sessionWorkspaceOf(agentId) || currentWorkspaceOf(payload) }
            : {}),
          // v0.20 TASK ALIGNMENT: the second semantic gate, after the workspace one.
          //
          // The terms come from the USER'S ASK, and are accumulated across the
          // session's human turns rather than taken from this turn alone: a follow-up
          // like "继续" or "修一下" carries no task signal, and a gate built from it
          // would refuse everything (or, worse, match only generic words). The ask is
          // remembered per agent so the gate stays stable as the work proceeds.
          ...taskGate(resolved, agentId, userText),
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
        // v0.20: record the task gate's refusals BEFORE the hint decision, so the
        // panel can explain a turn that produced no hint at all.
        const taskBlocked = Number((result.debug as { blockedByTask?: number } | undefined)?.blockedByTask ?? 0)
        if (taskBlocked > 0) lastTaskBlocks.set(agentId, taskBlocked)
        else lastTaskBlocks.delete(agentId)
        const hint = renderHint(result)
        /**
         * "NO LEXICAL HINT" IS NOT "NOTHING TO SAY".
         *
         * This used to `return decision`, which silently discarded the phase banner computed above
         * — the phase is known from the graph, so it must survive an empty lexical result. The
         * banner is delivered and the lexical path simply contributes nothing.
         */
        if (hint === undefined) {
          if (phaseMessages.length === 0) return decision
          const base = Array.isArray(decision.messages) ? decision.messages : Array.isArray(payload?.messages) ? payload.messages : []
          return { ...decision, messages: [...base, ...phaseMessages] }
        }
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
        /**
         * ── HOST CONTRACT (2026-11-07 live-crash fix): THE PRE-STEP CARRIER MUST BE `user` ──────
         *
         * The previous round changed this to `role: 'developer'` to move the memory out of the
         * instruction slot. The reasoning about model semantics was right; the assumption about
         * THIS host was wrong, and acting on it killed live sessions.
         *
         * MEASURED IN THE HOST (the step loop, not an inference):
         *
         *     for (const message of decision.messages)
         *       this.session.append('user/message', message, { surfaceOp: 'append' })
         *
         * Every pre-step message is recorded as a `user/message`, with the message object used
         * verbatim as the event's data. The host's validator then requires event type and role
         * to agree:
         *
         *     (event.type === 'developer/message') !== (message.role === 'developer')
         *       → throw `session event "user/message" at seq N developer/message and
         *                developer role must occur together`
         *
         * A `developer` role here is therefore not "context instead of instruction" — it is a
         * fatal append error raised inside the agent step. Measured on a live run: the process
         * died at seq 1046. No role in this channel can produce a real `developer/message`
         * event; that event is writable only directly, against an OPEN turn/step, which a
         * pre-step listener does not own.
         *
         * So the carrier is `user`, and the message SAYS it is a system note: `[系统提示]` is
         * the same prefix dsh-graft-slice puts on its standing constraints. The authority
         * argument is unchanged — `authority="none"` and the "not a current instruction"
         * preamble carry it — and `source.kind` keeps the plugin provenance that stops a later
         * reader from mistaking this for something the human typed.
         */
        const hintMessage = {
          id: `memory-hint-${agentId || 'session'}-${now}`,
          role: 'user',
          content: [{ type: 'text', text: `[系统提示] ${isolateHint(hint)}` }],
          source: { kind: 'plugin:dsh-memory' },
        }
        /**
         * LAST LINE OF DEFENCE. Deliberately a THROW, not a silent rewrite: quietly repairing a
         * carrier would hide the next regression. The throw lands in this handler's catch, which
         * logs and skips the hint — the turn survives, which is exactly what a developer-role
         * message here does NOT do to the host.
         */
        if (String(hintMessage.role) === 'developer') {
          throw new Error(
            '拒绝注入 developer 角色的 pre-step 消息：DSH 会把它记成 user/message，' +
              '校验器随后以 "developer/message and developer role must occur together" 终止会话',
          )
        }
        // The phase banner, when one was produced, precedes the lexical hint: it is context for the
        // WHOLE turn, while the lexical hint is about the sentence in front of it.
        return { ...decision, messages: [...base, ...phaseMessages, hintMessage] }
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
  const liveWorkspaceOf = (agentId: string): string =>
    agentId.length === 0 ? '' : sessionWorkspaceOf(agentId) || currentWorkspaceOf(undefined)

  /**
   * v0.20: the last turn's task-gate refusals, for the panel.
   *
   * "It did not recall" and "it refused three stale incident logs" are different
   * states, and only one of them is a problem. Reporting the count is what lets an
   * operator tell a working gate from a gate that ate the recall.
   */
  const lastTaskBlocks = new Map<string, number>()

  /** The session a tool call came from, or '' when the host did not supply one. */
  const callingAgentIdOf = (exec: any): string => {
    const id = exec?.agent?.id
    return typeof id === 'string' ? id : ''
  }

  /**
   * ── AUDIT ROUND 3 (P1-1): ONE IMPLEMENTATION OF "HOW MANY ARE USABLE HERE" ─────────────────────
   *
   * Both `memory_stats` and the panel need this number, and if they each computed it they would
   * eventually disagree — which is the failure being fixed in the first place (graft's panel said
   * `matched: 0` while memory's said `skills: 6`).
   *
   * THE PREDICATE IS THE SAME ONE RETRIEVAL USES. `memoryAllowsWorkspace` decides eligibility at
   * injection time, so using it here means the reported count cannot drift from what a turn would
   * actually be offered. A diagnostic that answers a slightly different question than the runtime is
   * how an operator ends up debugging the wrong subsystem.
   *
   * The note is returned as '' when nothing is blocked: a warning that fires unconditionally is one
   * nobody reads, and `memory_stats` is called often.
   */
  function skillVisibilityFor(workspace: string): {
    total: number
    eligible: number
    blocked: number
    workspace: string
    note: string
  } {
    const records = listSkillRecords(resolved.skillsDir)
    const eligible = records.filter((record) =>
      memoryAllowsWorkspace({ scope: record.scope, workspace: record.workspace, current: workspace }),
    )
    const dirty = records.filter(
      (record) => !memoryAllowsWorkspace({ scope: record.scope, workspace: record.workspace, current: workspace }),
    )
    const sample = dirty.find((record) => record.workspace.trim().length > 0)
    const note =
      dirty.length === 0
        ? ''
        : `${eligible.length}/${records.length} 可用；${dirty.length} 条被工作区隔离拦下` +
          (sample === undefined
            ? '（未记录工作区，视为无法证明属于此处）'
            : `（例如「${sample.name}」记录于 ${sample.workspace}，当前工作区是 ${workspace || '(未知)'}）`) +
          '。这是 fail-closed 的预期行为；若这条知识本身跨工作区通用，把它的 scope 改为 global。'
    return { total: records.length, eligible: eligible.length, blocked: dirty.length, workspace, note }
  }

  const memoryConsoleState = (agentId: string): Record<string, unknown> => {
    /**
     * v0.32 P1 — A ROOT-SCOPED PANEL HAS NO SESSION, BUT THE STORE STILL HAS ONE.
     *
     * The client sends the constant placeholder id (`dsh-memory-console-global`) when no
     * session is bound. `sessions.get(placeholder)` is undefined, so the workspace read
     * "(未知)" even though a session was open in this window — the panel then labelled
     * every memory as belonging to nowhere. Falling back to the newest LIVE session is
     * the same rule the graft console uses for its "most recent" default, and it is only
     * used to LABEL and to scope a read, never to write.
     */
    const newestLiveSessionId = (): string => {
      try {
        const sessions = ctx.get?.('sessions') as any
        const list = typeof sessions?.list === 'function' ? sessions.list() : undefined
        if (!Array.isArray(list) || list.length === 0) return ''
        const last = list[list.length - 1]
        return typeof last?.id === 'string' ? last.id : ''
      } catch {
        return ''
      }
    }
    const workspace = liveWorkspaceOf(agentId) || liveWorkspaceOf(newestLiveSessionId())
    const skills = listSkillRecords(resolved.skillsDir)
    const scenes = [...new Set(skills.map((skill) => skill.scene))].sort()
    const active = skills.filter((skill) => skill.invalidAt.length === 0 || Date.parse(skill.invalidAt) > Date.now())
    /**
     * ── AUDIT ROUND 3 (P1-1): SAY HOW MANY ARE USABLE, NOT JUST HOW MANY EXIST ────────────────────
     *
     * THE MEASURED CONFUSION. `counts.skills` reported the TOTAL (6 on the audited machine) while
     * retrieval silently matched ZERO, because every skill was `scope: project` recorded in a
     * DIFFERENT workspace. The only tool that said so was `graft_debug_status`, in another plugin's
     * panel. A user reading "skills: 6" and getting no injections has no way to connect the two, and
     * concludes the feature is broken — when in fact the gate was working exactly as designed.
     *
     * WHY THIS IS NOT "LOOSENING THE GATE". Nothing about eligibility changes: the same
     * `memoryAllowsWorkspace` predicate that retrieval uses decides these numbers, so the count
     * cannot disagree with what a real turn would see. It is the SAME answer, finally printed.
     *
     * Computed by `skillVisibilityFor`, shared with `memory_stats`, so the two readouts of one store
     * cannot tell different stories.
     */
    const visibility = skillVisibilityFor(workspace)
    return {
      config: {
        retrieval: resolved.retrieval,
        workspaceIsolation: resolved.workspaceIsolation,
        semanticFilter: resolved.semanticFilter,
        // v0.20: the task-alignment gate, so the panel can show and toggle it.
        taskAlignment: resolved.taskAlignment,
        autoApprove: resolved.autoApprove,
        extraction: resolved.extractor,
        floor: resolved.floor,
        threshold: resolved.threshold,
      },
      workspace,
      memoryDir: resolved.memoryDir,
      skillsDir: resolved.skillsDir,
      // v0.20: how many memories the task gate refused on the last turn.
      ...(lastTaskBlocks.get(agentId) === undefined ? {} : { blockedByTask: lastTaskBlocks.get(agentId) }),
      ...(visibility.note === '' ? {} : { visibilityNote: visibility.note }),
      counts: {
        skills: skills.length,
        active: active.length,
        superseded: skills.length - active.length,
        scenes: scenes.length,
        queued: listSuggestions(resolved.memoryDir).length,
        /** AUDIT ROUND 3: what a turn in THIS workspace would actually be offered. */
        matchedInWorkspace: visibility.eligible,
        blockedByWorkspace: visibility.blocked,
      },
      scenes,
      skills,
      /**
       * v0.28 P0: EVERY LIVE SESSION, produced where `sessions.list()` actually exists.
       *
       * The panel needs this to render its session selector. The CLIENT cannot enumerate
       * sessions — its `sessions` service has no `list()`, and `useSessions` only projects
       * what the owner chose to publish, which on a root-scoped panel can be nothing at
       * all. The HOST has the list, so it is shipped with the state instead of being
       * guessed at on the other side of the wire.
       */
      sessions: (() => {
        try {
          const sessions = ctx.get?.('sessions') as any
          if (sessions === undefined || sessions === null || typeof sessions.list !== 'function') return []
          const out: Array<{ sessionId: string; cwd: string }> = []
          for (const agent of sessions.list() as any[]) {
            const sessionId = typeof agent?.id === 'string' ? agent.id : ''
            if (sessionId.length === 0) continue
            let cwd = ''
            try {
              const live = sessions.get?.(sessionId) as any
              const header = live?.header
              if (header !== null && typeof header === 'object' && typeof header.cwd === 'string') cwd = header.cwd
              else if (typeof live?.cwd === 'string') cwd = live.cwd
            } catch {
              cwd = ''
            }
            out.push({ sessionId, cwd })
          }
          return out
        } catch {
          return []
        }
      })(),
      // v0.18: the panel answers "why has nothing been harvested?" — a refused
      // ledger shows up here instead of looking like an empty one.
      ledger: (() => {
        const snapshot = readLedgers(resolved.graftDataDir)
        return {
          graftDataDir: resolved.graftDataDir,
          epoch: snapshot.epoch,
          supportedEpoch: SUPPORTED_LEDGER_EPOCH,
          deferred: snapshot.deferred,
          skipped: snapshot.skipped,
          ...(snapshot.layoutRefusal === undefined ? {} : { layoutRefusal: snapshot.layoutRefusal }),
          graftDataDirPresent: snapshot.directory.present,
          retired: snapshot.retired.length,
          transferred: Object.keys(snapshot.transferred).length,
        }
      })(),
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
    /**
     * v0.28 P0 — A COMMAND THAT NEEDS NO SESSION, AND ITS OWN SESSION LIST.
     *
     * The panel could not obtain an agent from a root-scoped sidebar. Every attempt to
     * resolve one on the CLIENT side failed, because the Client `sessions` service has
     * no `list()` and `useSessions` only projects what the owner decided to publish.
     *
     * But most of what the console shows does not depend on a session at all: the knobs,
     * the skill catalogue, the scenes, the ledger epoch, the memory totals. Only the
     * "which session am I acting on" part does.
     *
     * So this command answers the GLOBAL question, and returns the session list the
     * panel needs to offer a choice. The `agent` argument the gateway demands is supplied
     * by the caller purely to satisfy the contract; nothing here reads it.
     */
    commands.register({
      name: 'memory-console-global',
      description:
        '读取不依赖具体会话的记忆库状态，并附上全部活动会话列表。Read the session-independent memory state plus the live session list.',
      handler: async () => ({
        kind: 'success' as const,
        text: JSON.stringify(memoryConsoleState('')),
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

  /**
   * v0.21 P1: one ARCHIVAL pass at activation, so the store cannot grow unbounded.
   *
   * Runs at activation rather than after every harvest on purpose: the pass is a
   * policy decision about the whole store, it is cheap (a directory listing plus
   * frontmatter reads), and doing it mid-harvest would interleave with writes.
   *
   * Under the limit it does nothing at all — no listing is even written.
   */
  try {
    const summaries = listSkillSummaries(resolved.skillsDir)
    const plan = planSkillArchive(summaries, resolved.skillLimit)
    if (!plan.underLimit) {
      const applied = applySkillArchive(resolved.skillsDir, plan)
      ctx.logger?.warn?.(
        `[dsh-memory] skill store over the limit (${plan.active}/${resolved.skillLimit} active): ` +
          `merged ${applied.merged} pair(s), archived ${applied.archived.length} least-recently-used skill(s). ` +
          'Archived skills stay on disk and are skipped by retrieval.',
      )
    }
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-memory] archival pass skipped: ${String((error as any)?.message ?? error)}`)
  }

  try {
    ctx.logger?.info?.(
      `[dsh-memory] ready: ledger=${resolved.graftDataDir} memory=${resolved.memoryDir} skills=${resolved.skillsDir} ` +
        `extractor=${resolved.extractor} autoApprove=${resolved.autoApprove} retrieval=${resolved.retrieval} semanticFilter=${resolved.semanticFilter} ` +
        `workspaceIsolation=${resolved.workspaceIsolation} taskAlignment=${resolved.taskAlignment}`,
    )
  } catch {
    // Logging must not block activation.
  }

  /**
   * v0.21 P1: say LOUDLY that harvesting is dead.
   *
   * A missing `llm` service (no API key, provider not signed in, model unavailable) is
   * not an outage that announces itself: `harvest` returns an empty extraction and the
   * store simply stops growing. Weeks later the memory库 looks "quiet" rather than
   * "broken", and every retrieval afterwards is served from a frozen corpus. A warning
   * at activation is the only moment anyone is looking.
   *
   * `extractor: 'off'` is a DELIBERATE choice (scan-only mode), so it is not warned
   * about — a warning that fires on a configured state trains people to ignore it.
   */
  if (!llmAvailable && resolved.extractor === 'llm') {
    try {
      // `warn` is called with the literal sentence the operator asked for, so it can
      // be grepped in a log without decoding a structure.
      ctx.logger?.warn?.('[dsh-memory] LLM unavailable. Harvesting is disabled.')
      ctx.logger?.warn?.(
        `[dsh-memory] reason: ctx.get('llm') is undefined (provider not signed in, API key missing, or the model is unreachable). ` +
          'memory_harvest will run and return nothing; existing memories are still retrievable. ' +
          "Set extractor: 'off' to silence this if scan-only is intended.",
      )
    } catch {
      // Logging must not block activation.
    }
  }
}

export const activate = apply