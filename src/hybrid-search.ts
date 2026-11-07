/**
 * HYBRID SEARCH — lexical recall first, optional semantic rerank second.
 *
 * THE MEASURED PROBLEM THIS ADDRESSES
 *
 * Retrieval here is lexical: token overlap weighted by IDF. That is exact, debuggable and cheap,
 * and it has one real weakness — SYNONYMS. "发版又炸了" shares no token with "部署脚本必报
 * SOURCE_DRIFT", so the memory that would have prevented the failure is never recalled. The
 * cross-system survey filed this as the single largest recall gap, and it is a RECALL problem,
 * not a performance one: scoring a document that was never recalled is impossible.
 *
 * WHY RERANK AND NOT A VECTOR STORE
 *
 * A vector store replaces lexical recall with an opaque similarity score, and "why was this
 * recalled" becomes unanswerable — which would dismantle the one property this whole layer is
 * built on (`evidence` → `seq` → the original event).
 *
 * So the split is asymmetric on purpose:
 *
 *   RECALL   lexical, top 50, explainable. The net is wide and transparent.
 *   RERANK   optional, only over those 50, top 5. The judge may reorder; it may not invent.
 *
 * A document the reranker promotes was ALREADY recalled lexically. That means every result still
 * has a lexical reason, and the trace records both the lexical rank and the semantic verdict —
 * so a wrong result is still debuggable.
 *
 * WHAT HAPPENS WITH NO MODEL
 *
 * Nothing. `rerank` is optional; absent it, the lexical top-N is returned unchanged and the trace
 * says `applied: false` with the reason. A silent fallback would make an offline deployment look
 * like a hybrid one in the logs and in a benchmark.
 */

/** One recalled document, before reranking. */
export interface HybridCandidate {
  /** Stable identity, used to map the reranker's verdicts back onto documents. */
  readonly id: string
  /** The text the model reads when judging relevance. */
  readonly text: string
  /** Lexical score in [0,1], from the existing scorer. */
  readonly lexical: number
  /** Lexical rank, 1-based. Reported so a promoted result can be explained. */
  readonly rank: number
  /** The opaque payload the caller wants back. */
  readonly payload: unknown
}

/** What the reranker is allowed to say. */
export interface RerankVerdict {
  readonly id: string
  /** Relevance in [0,1]. Higher is better. */
  readonly relevance: number
  /** Optional one-line justification, surfaced in the trace. */
  readonly reason?: string
}

/**
 * A reranker. Injected, so this module never imports a provider.
 *
 * It receives the QUERY and the CANDIDATES and returns verdicts for whichever subset it judges.
 * Returning nothing is legal and means "no opinion" — the lexical order then stands.
 */
export type Reranker = (
  query: string,
  candidates: readonly HybridCandidate[],
) => Promise<readonly RerankVerdict[]>

export interface HybridOptions {
  /** How many candidates lexical recall may produce. Default 50. */
  readonly recallLimit?: number
  /** How many survive to the caller. Default 5. */
  readonly limit?: number
  /** Absent means lexical-only, reported as such. */
  readonly rerank?: Reranker
  /**
   * Whether to trust the reranker over the lexical score.
   *
   * Default `true`: the whole point of a judge is that it may overrule the net. Set `false` to
   * keep lexical order and use the semantic scores only as diagnostics — useful when comparing
   * what the reranker WOULD have done without letting it change behaviour.
   */
  readonly preferRerank?: boolean
}

export interface HybridTrace {
  /** True only when a reranker produced at least one usable verdict. */
  readonly applied: boolean
  /** Why the semantic stage did or did not run. A silent fallback is a bug, not a decision. */
  readonly reason?: string
  /** How many candidates lexical recall produced. */
  readonly recalled: number
  /** How many the reranker actually returned verdicts for. */
  readonly judged: number
}

export interface HybridResult<T = unknown> {
  readonly hits: ReadonlyArray<{
    readonly id: string
    /** 1-based lexical rank BEFORE reranking — the explanation for a hit that was promoted. */
    readonly lexicalRank: number
    readonly lexical: number
    /** Present only when the reranker returned a verdict for this candidate. */
    readonly semantic?: number
    readonly why?: string
    readonly payload: T
  }>
  readonly trace: HybridTrace
}

/**
 * Run hybrid search over an already-recalled candidate list.
 *
 * RECALL IS THE CALLER'S JOB, deliberately. This function does not know how documents are stored
 * (JSON ledgers, SQLite index, or something not yet written), which is what lets it sit above the
 * storage tiers unchanged. The caller recalls; this decides ORDER.
 */
export async function rankHybrid(
  query: string,
  candidates: readonly HybridCandidate[],
  options: HybridOptions = {},
): Promise<HybridResult> {
  const limit = Math.max(1, Math.trunc(options.limit ?? 5))
  const recallLimit = Math.max(1, Math.trunc(options.recallLimit ?? 50))
  const recalled = candidates.slice(0, recallLimit)

  if (recalled.length === 0) {
    return { hits: [], trace: { applied: false, reason: 'no candidates recalled', recalled: 0, judged: 0 } }
  }

  /** No reranker, or no query to judge against: lexical order stands, and we say so. */
  if (options.rerank === undefined) {
    return {
      hits: recalled.slice(0, limit).map((candidate) => ({
        id: candidate.id,
        lexicalRank: candidate.rank,
        lexical: candidate.lexical,
        payload: candidate.payload,
      })),
      trace: { applied: false, reason: 'no reranker configured', recalled: recalled.length, judged: 0 },
    }
  }

  let verdicts: readonly RerankVerdict[]
  try {
    verdicts = await options.rerank(query, recalled)
  } catch (error) {
    /**
     * A reranker that throws must not lose the recall that already happened. The lexical result
     * is still correct and explainable; the trace records that the semantic stage failed.
     */
    return {
      hits: recalled.slice(0, limit).map((candidate) => ({
        id: candidate.id,
        lexicalRank: candidate.rank,
        lexical: candidate.lexical,
        payload: candidate.payload,
      })),
      trace: {
        applied: false,
        reason: `reranker failed: ${String((error as { message?: unknown })?.message ?? error)}`,
        recalled: recalled.length,
        judged: 0,
      },
    }
  }

  /**
   * MAP VERDICTS BY ID, AND IGNORE UNKNOWN IDS.
   *
   * A reranker that invents an id is either confused or hostile; either way, admitting a document
   * that lexical recall never produced would let the semantic stage INVENT a memory. Only ids that
   * are in `recalled` count.
   */
  const byId = new Map(recalled.map((candidate) => [candidate.id, candidate]))
  const verdictOf = new Map<string, RerankVerdict>()
  for (const verdict of verdicts) {
    if (!byId.has(verdict.id)) continue
    /** Clamp: a reranker returning 7.5 for relevance would otherwise dominate every other score. */
    const relevance = Number(verdict.relevance)
    verdictOf.set(verdict.id, {
      id: verdict.id,
      relevance: Number.isFinite(relevance) ? Math.min(1, Math.max(0, relevance)) : 0,
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
    })
  }

  if (verdictOf.size === 0) {
    return {
      hits: recalled.slice(0, limit).map((candidate) => ({
        id: candidate.id,
        lexicalRank: candidate.rank,
        lexical: candidate.lexical,
        payload: candidate.payload,
      })),
      trace: { applied: false, reason: 'reranker returned no usable verdicts', recalled: recalled.length, judged: 0 },
    }
  }

  const preferRerank = options.preferRerank !== false
  const ordered = [...recalled].sort((left, right) => {
    if (preferRerank) {
      const leftSemantic = verdictOf.get(left.id)?.relevance
      const rightSemantic = verdictOf.get(right.id)?.relevance
      /**
       * JUDGED CANDIDATES OUTRANK UNJUDGED ONES, then semantic beats lexical, then lexical order
       * breaks the tie. A reranker that returns verdicts for only some candidates must not push
       * the rest to the bottom — it had no opinion about them, and "no opinion" is not "irrelevant".
       */
      const leftJudged = leftSemantic !== undefined
      const rightJudged = rightSemantic !== undefined
      if (leftJudged !== rightJudged) return leftJudged ? -1 : 1
      if (leftJudged && rightJudged && leftSemantic !== rightSemantic) return rightSemantic - leftSemantic
    }
    return left.rank - right.rank
  })

  return {
    hits: ordered.slice(0, limit).map((candidate) => {
      const verdict = verdictOf.get(candidate.id)
      return {
        id: candidate.id,
        lexicalRank: candidate.rank,
        lexical: candidate.lexical,
        ...(verdict === undefined ? {} : { semantic: verdict.relevance }),
        ...(verdict?.reason === undefined ? {} : { why: verdict.reason }),
        payload: candidate.payload,
      }
    }),
    trace: { applied: true, recalled: recalled.length, judged: verdictOf.size },
  }
}

/**
 * A reranker backed by any chat model that can answer with plain JSON.
 *
 * WHY ONE CALL AND NOT N EMBEDDINGS: an embedding API is a second credential, a second failure
 * mode and a second bill. A single chat call asking for relevance scores over 50 short texts
 * reaches the same goal with what the system already has, and it is trivially replaceable by a
 * real embedding reranker behind the same `Reranker` type.
 *
 * WHAT IT COSTS: one extra model call per retrieval. That is why `rerank` is optional and why the
 * recall list is capped — the point is to judge a shortlist, never the corpus.
 */
export function createLlmReranker(options: {
  /** Streaming chat function, shaped like the extractor's `LlmLike.stream`. */
  readonly stream: (request: {
    system: string
    messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>
    maxTokens?: number
  }) => AsyncIterable<{ type?: string; text?: string }>
  /** Hard cap on how much candidate text is shown to the judge. */
  readonly maxCharsPerCandidate?: number
}): Reranker {
  const maxChars = Math.max(60, Math.trunc(options.maxCharsPerCandidate ?? 400))
  return async (query, candidates) => {
    if (candidates.length === 0) return []
    const listing = candidates
      .map((candidate, index) => `[${index}] ${candidate.text.slice(0, maxChars).replace(/\s+/gu, ' ')}`)
      .join('\n')
    const prompt = [
      `查询：${query}`,
      '',
      '候选记忆：',
      listing,
      '',
      '给每条候选打一个 0 到 1 的相关度分数（1 = 直接回答了查询，0 = 完全无关）。',
      '只输出一个 JSON 数组，每项 {"index": 序号, "relevance": 分数, "reason": "一句话理由"}。',
      '不要输出解释、不要代码围栏。',
    ].join('\n')

    let raw = ''
    const stream = options.stream({
      system: '你是一个检索重排器。只按相关度打分，只输出 JSON 数组。',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 2000,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
    }
    const parsed = parseVerdicts(raw, candidates)
    return parsed
  }
}

/** Extract `[{index, relevance, reason}]` from a model reply; tolerant of fences and prose. */
export function parseVerdicts(raw: string, candidates: readonly HybridCandidate[]): RerankVerdict[] {
  const match = /\[[\s\S]*\]/u.exec(raw)
  if (match === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: RerankVerdict[] = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue
    const index = Number((item as { index?: unknown }).index)
    const relevance = Number((item as { relevance?: unknown }).relevance)
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) continue
    if (!Number.isFinite(relevance)) continue
    const reason = typeof (item as { reason?: unknown }).reason === 'string' ? String((item as { reason?: unknown }).reason) : undefined
    out.push({
      id: candidates[index].id,
      relevance,
      ...(reason === undefined ? {} : { reason }),
    })
  }
  return out
}
