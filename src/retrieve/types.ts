/**
 * ── retrieve 的**契约类型**：12 个声明，没有一行会执行 ──────────────────────────────────────────
 *
 * 这些是 retrieve.ts 与它的调用方之间的形状约定：命中的记录长什么样（MemoryHit）、
 * 取数层的内部记录（Document）、候选过滤的选项与结果（CandidateOptions / RetrieveResult /
 * FilterOptions / FilterTrace），以及三个门禁与缓存条目的形状。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────────────────────────────────
 *
 * 它们**只被类型引用**（构建时按 `stripTypeScriptTypes` 整行擦除），所以在运行期图上，
 * 这个文件与任何人之间都没有边。把它们搬出来后，retrieve.ts 剩下的每一行都是会被执行的代码，
 * 读者不必在两种东西之间来回切换：**能执行的**和**只是形状的**。
 *
 * 这一步也顺手解决了一次误读：`retrieve.ts` 里 242 行「类型」让它的行数看起来比实际要重；
 * 而这些行从来不会变成任何指令。
 *
 * ── 依赖方向 ────────────────────────────────────────────────────────────────────────────────────
 *
 * 只有三条**类型**导入，全部在运行时消失：
 *   `../extract.js`     LlmLike / MemoryProvenance
 *   `../filter.js`      FilterSupersedeDecision
 * 因此本文件在值依赖图上是**孤立的**（`check-cycles` 看不到任何 value edge）。
 * 反方向的类型边确实构成一个 type-only 环（types → filter → retrieve → types），
 * 但 type-only 边在构建时擦除，不是环 —— 与仓里已有的那一条同性质。
 *
 * ── 导出面 ──────────────────────────────────────────────────────────────────────────────────────
 *
 * `package.json` 的 `"types"` 指向 `src/index.ts` 且 `files` 含 `src`，
 * 所以**源码本身就是发布出去的类型面**。这个面没有任何门禁（导出面门禁是
 * `import('../lib/store.js')` 那种运行期断言，`export type` 它看不见），
 * 因此 `retrieve.ts` 里那 12 行 `export type` 是**手写**的 —— 现在由
 * `test/v213-type-surface-reexports.test.mjs` 机械检查，不再是「漏了没人会红」。
 */
import type { LlmLike, MemoryProvenance } from '../extract.js'
import type { FilterSupersedeDecision } from '../filter.js'

/** v0.6: all four layers participate in retrieval. */
export type DocumentKind = 'skill' | 'negative' | 'fact' | 'experience'

export interface MemoryHit {
  kind: DocumentKind
  id: string
  /** Display title: the skill's `# heading`, or the negative's symptom. */
  title: string
  score: number
  when?: string
  detail?: string
  /** v0.3: mutually exclusive alternatives recorded at write time. */
  conflictsWith?: string[]
  /** v0.5: workspace / project / global. */
  scope?: string
  /** v0.5: alternate phrasings used for recall. */
  aliases?: string[]
  /** v0.5: set when the skill is older than the validation window. */
  stale?: boolean
  lastValidated?: string
  /** v0.5: negatives only — lowered by counter-evidence. */
  confidence?: number
  counterEvidence?: number[]
  /** v0.21: negatives only — how many times this failure has recurred (1 = once). */
  hits?: number
  /** v0.6: scene tag and the composite pointer for "look this up" hints. */
  scene?: string
  /** v0.17: the project/system this memory is about; different domains never conflict. */
  domain?: string
  /** v0.8: the workspace that produced this memory (isolation provenance). */
  workspace?: string
  /** v0.15: trust tier (human / tool / inferred), rendered in the hint. */
  provenance?: MemoryProvenance
  sessionId?: string
  seq?: number
  /** v0.32 P1: the graft generation this experience belongs to. */
  generation?: number
  /** v0.32 P1: the code commit it was extracted against. */
  commitHash?: string
  /** v0.32 P1: true when the current checkout is a DIFFERENT commit. */
  commitDrift?: boolean
  /** v0.32 P1: what the current checkout is at, for the hint's wording. */
  currentCommit?: string
}

export interface Document {
  kind: DocumentKind
  id: string
  title: string
  when?: string
  detail?: string
  /**
   * v1.1.0 P0+ — the injection scan result, computed ONCE.
   *
   * `isPoisoned` re-ran the threat regex over `contentOf(document)` for every document on
   * every retrieval. With documents now cached, that scan was the largest remaining CPU cost
   * after scoring (measured 7.2% of the turn) — for text that had already been scanned when
   * it was added to the cache.
   *
   * `undefined` means "not yet decided" (a document built by an older path); the caller
   * falls back to scanning, so this is a cache and never a bypass.
   */
  poisoned?: boolean
  conflictsWith?: string[]
  scope?: string
  aliases?: string[]
  stale?: boolean
  /** v0.32 P1: provenance for the commit-drift demotion. */
  generation?: number
  commitHash?: string
  lastValidated?: string
  updatedAt?: string
  confidence?: number
  counterEvidence?: number[]
  scene?: string
  /** v0.17: the project/system this memory is about. */
  domain?: string
  /** v0.8: the workspace this memory was written from; empty = unknown. */
  workspace?: string
  /**
   * v0.8.1: the stored text the threat scan reads. For a SKILL.md this is the
   * whole file (frontmatter + body), because an instruction hidden in `## 执行步骤`
   * is still an instruction even though the current hint does not render it.
   */
  scanText?: string
  /**
   * v0.15 bi-temporal validity. `invalidAt` in the past = the memory stopped being
   * true and is no longer activated; in the future = still in force until then.
   * Absent = always valid. `supersededBy` names the successor, for the audit.
   */
  validAt?: string
  invalidAt?: string
  /** v0.21: retired by the archive pass (see archive.ts), not by time. */
  archived?: boolean
  supersededBy?: string
  /** v0.15: trust tier; absent on a legacy record and read as `inferred`. */
  provenance?: MemoryProvenance
  sessionId?: string
  seq?: number
  tokens: Set<string>
  ageDays: number
  importance: number
}

export interface Scored {
  document: Document
  coverage: number
  score: number
  /** v0.32 P1: set when the skill's commit no longer matches the checkout. */
  commitDrift?: boolean
  currentCommit?: string
}

export interface WorkspaceGate {
  /** The workspace of the session asking. Absent = no gate (offline callers). */
  workspace?: string
}

export interface TaskAlignmentGate {
  /** The task's distinctive terms. Empty = no gate (offline callers). */
  terms?: ReadonlySet<string>
  /** v0.20: relax the incident-log rule (differential tests, diagnostics). */
  enabled?: boolean
  /** v0.20: the ask itself is about a failure, so incident logs are in scope. */
  askIsFixIntent?: boolean
  /** v0.20: terms that are rare in this pool; an incident log may match on them. */
  distinctive?: ReadonlySet<string>
}

export interface DocumentCacheEntry {
  version: number
  patchCount: number
  /** How many records have already been converted into `docs`. */
  built: number
  hour: number
  docs: Document[]
}

export interface CandidateOptions {
  threshold?: number
  now?: number
  kind?: 'skill' | 'negative'
  limit?: number
  /** v0.7.1: explicit scene gate (from `classifyScene`). */
  scene?: string
  /** v0.8: the asking session's workspace; memories from elsewhere are refused. */
  workspace?: string
  /** v0.20: the current task's distinctive terms (the second semantic gate). */
  taskTerms?: ReadonlySet<string>
  /** v0.20: set false to relax the incident-log rule (differential tests). */
  taskAlignment?: boolean
}

export interface HybridRecallOptions extends CandidateOptions {
  /** How many to recall lexically before reranking. Default 50. */
  recallLimit?: number
  /** Absent means lexical-only; the trace states which happened. */
  rerank?: import('./hybrid-search.js').Reranker
  /** Set false to keep lexical order while still collecting semantic scores (diagnostics). */
  preferRerank?: boolean
}

export interface RetrieveResult {
  skill?: MemoryHit
  negative?: MemoryHit
  /** v0.6: the observation layers, retrievable in their own right. */
  fact?: MemoryHit
  experience?: MemoryHit
  /** Further skill candidates that cleared the threshold, best first (max 2). */
  alternatives?: MemoryHit[]
  /** Stage-2 diagnostics. Present only on `retrieveWithFilter` results. */
  filter?: FilterTrace
  /** What stage 1 recalled, before adjudication (diagnostics only). */
  candidates?: MemoryHit[]
  /**
   * Coverage of the best hit before freshness/importance, for debugging.
   *
   * v0.8 refused-by-workspace count; v0.8.1 refused-by-injection-scan count. Both
   * are reported even when nothing is injected: a silent refusal is
   * indistinguishable from "no memory of that kind", and those need different
   * responses from an operator.
   */
  debug: {
    terms: number
    matched: number
    blockedByWorkspace?: number
    blockedByThreat?: number
    /** v0.15: memories refused because their invalidation time has passed. */
    blockedByInvalid?: number
    /** v0.20: incident logs refused for sharing nothing with the current task. */
    blockedByTask?: number
  }
}

/** Why the LLM stage ran, or did not — a silent fallback is a bug, not a decision. */
export interface FilterTrace {
  attempted: boolean
  applied: boolean
  kept?: string[]
  reason?: string
  /** v0.15: supersede verdicts this turn (applied through `onSupersede`). */
  supersede?: FilterSupersedeDecision[]
  /** v0.22: how many candidates were offered to the judge, after truncation. */
  offered?: number
}

export interface FilterOptions {
  llm?: LlmLike
  /** Recall floor for stage 1. Default 0.20. */
  floor?: number
  /** Legacy alias for `floor`. */
  threshold?: number
  now?: number
  timeoutMs?: number
  provider?: string
  model?: string
  /** v0.7.1: skip classification and use this scene (`general` = no gate). */
  scene?: string
  /** v0.7.1: budget for the scene call. Default 2000ms. */
  sceneTimeoutMs?: number
  /** v0.8: the asking session's workspace. Memories from another workspace are
   *  removed from the pool before scoring, so they cannot be injected at all. */
  workspace?: string
  /**
   * v1.0.2: the checkout this search runs against (short or full hash). Defaults to the
   * workspace's git HEAD, cached for a minute; tests pin it to assert commit drift.
   */
  currentCommit?: string
  /**
   * v0.20: the current task's distinctive terms (from the user's own ask).
   *
   * The second semantic gate. A stale INCIDENT LOG that shares none of these terms
   * is removed from the pool before scoring — the same treatment a foreign
   * workspace gets, and for the same reason: it must neither be injected nor shift
   * the weights of a memory that is on-task. Absent = no gate (offline callers).
   */
  taskTerms?: ReadonlySet<string>
  /** v0.20: set false to relax the incident-log rule (differential tests). */
  taskAlignment?: boolean
  /**
   * v0.22 P1: degrade to STRICT lexical recall when the judge is slow or fails.
   *
   * Set by the pre-step path, where the latency budget belongs to the TURN. Never set
   * by `memory_search`, where the honest answer to "the judge could not decide" is
   * that answer rather than a guess.
   */
  degradeOnTimeout?: boolean
  /**
   * v0.15: persist one supersede verdict. Retrieval is a READ path, so the write
   * is injected by the caller; `store.applySupersede` enforces the human guard and
   * appends the audit line. A throwing callback is swallowed: a failed write must
   * never cost the hint.
   */
  onSupersede?: (decision: FilterSupersedeDecision) => void
}
