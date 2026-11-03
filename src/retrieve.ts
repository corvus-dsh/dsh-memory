/**
 * dsh-memory retrieval: lexical recall, then an optional LLM relevance filter.
 *
 * THE TWO-STAGE SHAPE
 *
 * Stage 1 (always, offline): IDF × freshness × importance. Cheap, explainable,
 * and it decides *what might be relevant*. It cannot decide *what is relevant*:
 * measured live, a prompt about a commit-digest bug surfaced
 * `divergent-rebuild-probe` at the same time as the skill that actually applied,
 * because both share the words "prepare/commit/字段". Lexical scoring has no way
 * to know one of them is the wrong topic.
 *
 * Stage 2 (only when >1 candidate clears the threshold): one short model call
 * that answers "which of these truly apply?" and returns ids. It can only DROP
 * candidates, never add one: every returned id is validated against the stage-1
 * list, so a hallucinated or injected name is discarded. If the call fails, the
 * lexical top-1 stands — the filter may improve a hint, never break it.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { selectApplicableSkills } from './filter.js'
import type { LlmLike } from './extract.js'

export interface MemoryHit {
  kind: 'skill' | 'negative'
  id: string
  /** Display title: the skill's `# heading`, or the negative's symptom. */
  title: string
  score: number
  when?: string
  detail?: string
}

interface Document {
  kind: 'skill' | 'negative'
  id: string
  title: string
  when?: string
  detail?: string
  tokens: Set<string>
  ageDays: number
  importance: number
}

interface Scored {
  document: Document
  coverage: number
  score: number
}

const CJK = /[\u4e00-\u9fff]/u
const LATIN = /[a-z0-9]/u

/** Latin words (≥2 chars) + CJK bigrams. Dependency-free and explainable. */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const out: string[] = []
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9_-]{1,}/gu)) out.push(match[0])
  const runs = lower.match(/[\u4e00-\u9fff]+/gu) ?? []
  for (const run of runs) {
    if (run.length === 1) out.push(run)
    for (let index = 0; index + 2 <= run.length; index += 1) out.push(run.slice(index, index + 2))
  }
  return [...new Set(out)]
}

/**
 * Clip a display title at punctuation, never mid-clause.
 *
 * Measured live: a negative title rendered as `…即使没有任何外部改动，` — a hard
 * 60-char slice landed on a comma, so the hint read like a damaged sentence.
 */
function clipTitle(text: string, max = 60): string {
  const clean = text.replace(/\s+/gu, ' ').trim()
  if (clean.length <= max) return clean
  const window = clean.slice(0, max)
  // Prefer a sentence end; a comma is only a fallback and must not be KEPT —
  // `改动，…` still reads as a broken clause.
  const sentence = Math.max(...['。', '；', '！', '？'].map((mark) => window.lastIndexOf(mark)))
  if (sentence >= 20) return `${window.slice(0, sentence + 1)}…`
  const comma = Math.max(...['，', '、', '：'].map((mark) => window.lastIndexOf(mark)))
  if (comma >= 20) return `${window.slice(0, comma)}…`
  return `${window}…`
}

/** High-frequency words that carry no task signal; down-weighted, not removed. */
const STOPWORDS = new Set([
  '的', '了', '在', '是', '和', '与', '也', '就', '都', '而', '及', '或', '把', '被', '对', '从', '为', '以', '这', '那', '有', '个',
  '我们', '你们', '他们', '这个', '那个', '一个', '可以', '需要', '应该', '如果', '然后', '就是', '还是', '已经', '进行', '没有',
  '逻辑', '修复', '改动', '修改', '问题', '测试', '方法', '做法', '时候', '其中', '以及', '并且', '所以', '但是', '因为',
])
const STOPWORD_WEIGHT = 0.25

function ageDaysOf(iso: string | undefined, now: number): number {
  if (iso === undefined) return 30
  const parsed = Date.parse(iso.length <= 10 ? `${iso}T00:00:00Z` : iso)
  if (!Number.isFinite(parsed)) return 30
  return Math.max(0, (now - parsed) / 86_400_000)
}

function freshness(days: number): number {
  // 30-day half-life, floored so an older-but-relevant memory still surfaces.
  return 0.5 + 0.5 * Math.exp(-days / 30)
}

/** Frontmatter trigger: `when_to_use` (v0.2.0) or legacy `when`. */
function triggerOf(text: string): string {
  return text.match(/^when_to_use:\s*(.+)$/mu)?.[1] ?? text.match(/^when:\s*(.+)$/mu)?.[1] ?? ''
}

function skillDocuments(skillsDir: string, now: number): Document[] {
  let names: string[] = []
  try {
    names = readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
  const out: Document[] = []
  for (const name of names) {
    const path = join(skillsDir, name, 'SKILL.md')
    if (!existsSync(path)) continue
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const when = triggerOf(text)
    const sources = Number(text.match(/^sources:\s*(\d+)$/mu)?.[1] ?? '1')
    const updated = text.match(/^updated:\s*(.+)$/mu)?.[1] ?? text.match(/^created:\s*(.+)$/mu)?.[1]
    const heading = text.match(/^#\s+(.+)$/mu)?.[1] ?? name
    out.push({
      kind: 'skill',
      id: name,
      title: clipTitle(heading.trim(), 60),
      when,
      detail: when,
      tokens: new Set(tokenize(`${name} ${heading} ${when} ${text.replace(/^---[\s\S]*?---/u, '')}`)),
      ageDays: ageDaysOf(updated, now),
      importance: 1 + Math.min(0.5, 0.15 * Math.log(1 + Math.max(1, sources) - 1) + (sources > 1 ? 0.1 : 0)),
    })
  }
  return out
}

function negativeDocuments(memoryDir: string, now: number): Document[] {
  const path = join(memoryDir, 'negatives.jsonl')
  if (!existsSync(path)) return []
  const out: Document[] = []
  let lines: string[] = []
  try {
    lines = readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean)
  } catch {
    return []
  }
  lines.forEach((line, index) => {
    try {
      const record = JSON.parse(line)
      if (record === null || typeof record !== 'object') return
      const symptom = String(record.symptom ?? '')
      const cause = String(record.cause ?? '')
      const avoid = String(record.avoid ?? '')
      const hits = Number(record.hits ?? 1)
      out.push({
        kind: 'negative',
        id: `neg-${index}`,
        title: clipTitle(symptom, 60),
        detail: avoid.slice(0, 80),
        tokens: new Set(tokenize(`${symptom} ${cause} ${avoid}`)),
        ageDays: ageDaysOf(typeof record.at === 'string' ? record.at : undefined, now),
        importance: 1 + Math.min(0.5, 0.15 * Math.log(1 + Math.max(1, hits))),
      })
    } catch {
      // Skip a torn line.
    }
  })
  return out
}

/** Stage 1: score every stored document against the query. */
function scoreDocuments(memoryDir: string, skillsDir: string, query: string, now: number): { terms: string[]; scored: Scored[] } {
  const terms = tokenize(query)
  const documents = [...skillDocuments(skillsDir, now), ...negativeDocuments(memoryDir, now)]
  if (terms.length === 0 || documents.length === 0) return { terms, scored: [] }

  const df = new Map<string, number>()
  for (const term of terms) {
    let count = 0
    for (const document of documents) if (document.tokens.has(term)) count += 1
    if (count > 0) df.set(term, count)
  }
  const weightOf = (term: string, value: number): number =>
    Math.log(1 + documents.length / value) * (STOPWORDS.has(term) ? STOPWORD_WEIGHT : 1)
  // A query made only of high-frequency words has nothing distinctive to match on.
  // Weighting alone cannot catch it: both numerator and denominator shrink, so
  // coverage stays 1.0. Detect it explicitly and recall nothing.
  if ([...df.keys()].every((term) => STOPWORDS.has(term))) return { terms, scored: [] }
  // Top-8 denominator: a long prompt must not dilute its own best signal.
  // Measured live: a delegated subagent's multi-paragraph prompt scored below the
  // threshold even though it contained `SOURCE_DRIFT`, `graft_commit` and `边界 seq`,
  // because the denominator grew with every extra word.
  const weighted = [...df.entries()].map(([term, value]) => ({ term, weight: weightOf(term, value) }))
  weighted.sort((a, b) => b.weight - a.weight)
  const denominator = weighted.slice(0, Math.min(8, weighted.length)).reduce((sum, item) => sum + item.weight, 0)

  const scored = documents.map((document) => {
    let matched = 0
    for (const item of weighted) if (document.tokens.has(item.term)) matched += item.weight
    // Numerator is capped at the denominator: extra matches beyond the top-8 must
    // never push coverage above 1.
    const coverage = denominator === 0 ? 0 : Math.min(1, matched / denominator)
    const score = Math.min(1, coverage * freshness(document.ageDays) * document.importance)
    return { document, coverage, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return { terms, scored }
}

function hitOf(document: Document, score: number): MemoryHit {
  return {
    kind: document.kind,
    id: document.id,
    title: document.title,
    score: Number(score.toFixed(3)),
    ...(document.when === undefined ? {} : { when: document.when }),
    ...(document.detail === undefined ? {} : { detail: document.detail }),
  }
}

export interface CandidateOptions {
  threshold?: number
  now?: number
  kind?: 'skill' | 'negative'
  limit?: number
}

/** Stage 1 as a list: every document above the threshold, best first. */
export function retrieveCandidates(
  memoryDir: string,
  skillsDir: string,
  query: string,
  options: CandidateOptions = {},
): MemoryHit[] {
  const now = options.now ?? Date.now()
  const threshold = options.threshold ?? 0.55
  const limit = Math.max(1, Math.min(20, options.limit ?? 4))
  const { scored } = scoreDocuments(memoryDir, skillsDir, query, now)
  const out: MemoryHit[] = []
  for (const item of scored) {
    if (options.kind !== undefined && item.document.kind !== options.kind) continue
    if (item.score < threshold) continue
    out.push(hitOf(item.document, item.score))
    if (out.length >= limit) break
  }
  return out
}

export interface RetrieveResult {
  skill?: MemoryHit
  negative?: MemoryHit
  /** Further skill candidates that cleared the threshold, best first (max 2). */
  alternatives?: MemoryHit[]
  /** Stage-2 diagnostics. Present only on `retrieveWithFilter` results. */
  filter?: FilterTrace
  /** Coverage of the best hit before freshness/importance, for debugging. */
  debug: { terms: number; matched: number }
}

/** Why the LLM stage ran, or did not — a silent fallback is a bug, not a decision. */
export interface FilterTrace {
  attempted: boolean
  applied: boolean
  kept?: string[]
  reason?: string
}

export function retrieve(
  memoryDir: string,
  skillsDir: string,
  query: string,
  options: { threshold?: number; now?: number } = {},
): RetrieveResult {
  const now = options.now ?? Date.now()
  const threshold = options.threshold ?? 0.55
  const { terms, scored } = scoreDocuments(memoryDir, skillsDir, query, now)
  if (scored.length === 0) return { debug: { terms: terms.length, matched: 0 } }

  const best = scored[0]
  const debug = { terms: terms.length, matched: Math.round(best.coverage * terms.length) }
  const above = (kind: 'skill' | 'negative'): Scored[] => scored.filter((item) => item.document.kind === kind && item.score >= threshold)
  const skills = above('skill')
  const negatives = above('negative')
  return {
    ...(skills.length === 0 ? {} : { skill: hitOf(skills[0].document, skills[0].score) }),
    ...(negatives.length === 0 ? {} : { negative: hitOf(negatives[0].document, negatives[0].score) }),
    ...(skills.length <= 1 ? {} : { alternatives: skills.slice(1, 3).map((item) => hitOf(item.document, item.score)) }),
    debug,
  }
}

export interface FilterOptions {
  llm?: LlmLike
  threshold?: number
  now?: number
  timeoutMs?: number
  provider?: string
  model?: string
}

/**
 * Stage 2 retrieval: lexical candidates, narrowed by one model call.
 *
 * Only skills are filtered. A negative path is a warning about a failure that
 * happened; keeping one extra warning costs a clause, dropping a real one costs
 * a repeated incident, so negatives stay lexical.
 */
export async function retrieveWithFilter(
  memoryDir: string,
  skillsDir: string,
  query: string,
  options: FilterOptions = {},
): Promise<RetrieveResult> {
  const lexical = retrieve(memoryDir, skillsDir, query, {
    ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const candidates = retrieveCandidates(memoryDir, skillsDir, query, {
    ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
    ...(options.now === undefined ? {} : { now: options.now }),
    kind: 'skill',
    limit: 4,
  })
  // 0 or 1 candidate: nothing to disambiguate, and no token spent.
  if (candidates.length <= 1) {
    return { ...lexical, filter: { attempted: false, applied: false, reason: 'no disambiguation needed' } }
  }
  if (options.llm === undefined) {
    return { ...lexical, filter: { attempted: false, applied: false, reason: 'llm unavailable' } }
  }

  let applicable: string[]
  try {
    applicable = await selectApplicableSkills(options.llm, query, candidates, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
    })
  } catch (error) {
    // Fail open to the lexical answer. A filter that cannot answer must not
    // suppress a hint the old version would have produced — but the reason is
    // reported, so a silent fallback is visible in `memory_search`.
    return {
      ...lexical,
      filter: { attempted: true, applied: false, reason: String((error as any)?.message ?? error) },
    }
  }

  const kept = candidates.filter((candidate) => applicable.includes(candidate.id))
  if (kept.length === 0) {
    // The filter judged every skill irrelevant. Keep the negative (it is not
    // filtered) and drop the skills it rejected.
    return {
      ...(lexical.negative === undefined ? {} : { negative: lexical.negative }),
      debug: lexical.debug,
      filter: { attempted: true, applied: true, kept: [] },
    }
  }
  return {
    skill: kept[0],
    ...(kept.length <= 1 ? {} : { alternatives: kept.slice(1, 3) }),
    ...(lexical.negative === undefined ? {} : { negative: lexical.negative }),
    debug: lexical.debug,
    filter: { attempted: true, applied: true, kept: kept.map((candidate) => candidate.id) },
  }
}

/** One sentence, ≤120 chars, no imperatives. */
export function renderHint(result: RetrieveResult): string | undefined {
  const parts: string[] = []
  if (result.skill !== undefined) {
    const titles = [result.skill.title, ...(result.alternatives ?? []).map((hit) => hit.title)].slice(0, 2).map((title) =>
      clipTitle(title, 30),
    )
    parts.push(titles.length > 1 ? `这类任务上次「${titles.join('」「')}」有效` : `这类任务上次「${titles[0]}」有效`)
  }
  const negative = result.negative
  if (negative !== undefined) parts.push(`另有一次「${negative.title}」翻车，先核对再重跑`)
  if (parts.length === 0) return undefined
  return `（记忆提示：${parts.join('；')}。）`.slice(0, 120)
}