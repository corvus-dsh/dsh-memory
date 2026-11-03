/**
 * Turn an episode into skills and negative paths.
 *
 * The extraction is ONE model call with a strict JSON contract, then local
 * validation. Validation is not paranoia: a hallucinated evidence seq makes the
 * memory unauditable, and an unauditable memory is worse than none (it is a
 * claim the reader cannot check).
 */

import type { Episode } from './segment.js'
import { renderEpisode } from './segment.js'

export interface ExtractedSkill {
  /** ASCII kebab-case, because that is what a SKILL.md name must be. */
  name: string
  /** Human title (may be Chinese). */
  title: string
  when: string
  how: string[]
  evidence: number[]
}

export interface ExtractedNegative {
  symptom: string
  cause: string
  avoid: string
  evidence: number[]
}

export interface ExtractionResult {
  skills: ExtractedSkill[]
  negatives: ExtractedNegative[]
  /** Names/entries refused locally, with the reason — never silently dropped. */
  dropped: string[]
}

export const EXTRACT_SYSTEM_PROMPT = [
  'You are a capability-memory extractor for a coding agent.',
  'Read the episode and extract only what is REUSABLE in a later, different session.',
  '',
  'Rules:',
  '1. A skill is a METHOD: "when <situation>, do <steps>". If it cannot be replayed by someone who never saw this session, drop it.',
  '2. A negative path is a FAILURE with cause and avoidance. Symptom + cause + what to do instead.',
  '3. Never invent evidence. Every entry cites seqs present in the episode. An entry with a seq that is not listed is discarded.',
  '4. Reject generic advice ("be careful", "test thoroughly", "write clean code"). Only concrete, session-specific lessons.',
  '5. At most 2 skills and 2 negative paths. Fewer is better: precision beats recall.',
  '5b. Be terse: each `how` step <= 40 words, at most 4 steps; `when` <= 25 words. The JSON must stay complete.',
  '6. `name` must be ASCII kebab-case (a-z, 0-9, hyphens, <= 48 chars). `title` may be Chinese.',
  '',
  'Return ONLY JSON:',
  '{"skills":[{"name":"kebab-name","title":"...","when":"...","how":["..."],"evidence":[12,34]}],',
  ' "negatives":[{"symptom":"...","cause":"...","avoid":"...","evidence":[56]}]}',
].join('\n')

const GENERIC = /(要小心|注意安全|多加测试|注意细节|保持整洁|be careful|test thoroughly|write clean|pay attention|good luck)/iu
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function asText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
}

function asSeqList(value: unknown, allowed: Set<number>): number[] {
  if (!Array.isArray(value)) return []
  const out: number[] = []
  for (const item of value) {
    const seq = Number(item)
    if (!Number.isFinite(seq)) continue
    // Only seqs the episode actually contains: this is the anti-hallucination gate.
    if (!allowed.has(seq)) continue
    if (!out.includes(seq)) out.push(seq)
  }
  return out
}

export function sanitizeExtraction(raw: unknown, episode: Episode): ExtractionResult {
  const dropped: string[] = []
  const allowed = new Set(episode.evidence)
  const skills: ExtractedSkill[] = []
  const negatives: ExtractedNegative[] = []
  if (raw === null || typeof raw !== 'object') return { skills, negatives, dropped: ['payload is not an object'] }

  const rawSkills = Array.isArray((raw as any).skills) ? (raw as any).skills : []
  for (const item of rawSkills) {
    if (skills.length >= 2) break
    if (item === null || typeof item !== 'object') continue
    const name = asText(item.name).toLowerCase()
    const title = asText(item.title)
    const when = asText(item.when)
    const how = (Array.isArray(item.how) ? item.how : []).map(asText).filter((step) => step.length > 0).slice(0, 5)
    const evidence = asSeqList(item.evidence, allowed)
    const label = name || title || '(unnamed skill)'
    if (!KEBAB.test(name) || name.length > 48) {
      dropped.push(`${label}: name is not ASCII kebab-case`)
      continue
    }
    if (when.length < 6) {
      dropped.push(`${label}: ` + 'when is missing')
      continue
    }
    if (how.length === 0) {
      dropped.push(`${label}: ` + 'no replayable steps')
      continue
    }
    if (evidence.length === 0) {
      dropped.push(`${label}: ` + 'no evidence seq from this session')
      continue
    }
    if (GENERIC.test(`${title} ${when} ${how.join(' ')}`.slice(0, 600)) && how.length < 2) {
      dropped.push(`${label}: ` + 'generic advice')
      continue
    }
    skills.push({ name, title: title || name, when: when.slice(0, 200), how, evidence })
  }

  const rawNegatives = Array.isArray((raw as any).negatives) ? (raw as any).negatives : []
  for (const item of rawNegatives) {
    if (negatives.length >= 3) break
    if (item === null || typeof item !== 'object') continue
    const symptom = asText(item.symptom)
    const cause = asText(item.cause)
    const avoid = asText(item.avoid)
    const evidence = asSeqList(item.evidence, allowed)
    const label = symptom.slice(0, 40) || '(unnamed negative)'
    if (symptom.length < 6 || cause.length < 4 || avoid.length < 4) {
      dropped.push(`${label}: symptom/cause/avoid incomplete`)
      continue
    }
    if (evidence.length === 0) {
      dropped.push(`${label}: ` + 'no evidence seq from this session')
      continue
    }
    negatives.push({ symptom: symptom.slice(0, 200), cause: cause.slice(0, 200), avoid: avoid.slice(0, 200), evidence })
  }

  return { skills, negatives, dropped }
}

/** Pull the outermost JSON object out of a model reply (fenced or chatty). */
export function parseExtractionJson(raw: string, episode: Episode): ExtractionResult & { parsedOk: boolean } {
  const start = raw.indexOf('{')
  // A reply cut off mid-object has no closing brace; try the last complete object
  // first, then give the caller a clear 'truncated' reason to retry with a bigger budget.
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) {
    const truncated = start >= 0
    return {
      skills: [],
      negatives: [],
      dropped: [truncated ? 'reply truncated before the JSON closed' : 'no JSON object in the reply'],
      parsedOk: false,
    }
  }
  try {
    return { ...sanitizeExtraction(JSON.parse(raw.slice(start, end + 1)), episode), parsedOk: true }
  } catch (error) {
    return { skills: [], negatives: [], dropped: [`invalid JSON: ${String((error as any)?.message ?? error)}`], parsedOk: false }
  }
}

export interface LlmLike {
  stream(options: {
    provider?: string
    model?: string
    system?: string
    messages: Array<{ role: string; content: Array<{ type: 'text'; text: string }> }>
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<{ type?: string; text?: string; reason?: { kind?: string; failure?: { message?: string } } }>
}

export interface ExtractOptions {
  provider?: string
  model?: string
  timeoutMs?: number
}

/** One extraction call. Returns an empty result (with a reason) rather than throwing. */
export async function extractEpisode(
  llm: LlmLike | undefined,
  episode: Episode,
  options: ExtractOptions = {},
): Promise<ExtractionResult & { rawChars: number; ok: boolean; rawText?: string }> {
  if (llm === undefined || typeof llm.stream !== 'function') {
    return { skills: [], negatives: [], dropped: ['llm service unavailable'], rawChars: 0, ok: false }
  }
  const input = renderEpisode(episode)
  const timeoutMs = options.timeoutMs ?? 60_000
  let lastError = 'extraction failed'
  let lastRaw = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const stream = llm.stream({
        ...(options.provider === undefined ? {} : { provider: options.provider }),
        ...(options.model === undefined ? {} : { model: options.model }),
        system:
          attempt === 0
            ? EXTRACT_SYSTEM_PROMPT
            : `${EXTRACT_SYSTEM_PROMPT}\n\n上一次回复里没有 JSON 对象。只输出一个 JSON 对象本身：不要解释、不要代码围栏、不要前后缀。`,
        messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
        maxTokens: 3200,
        ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? { signal: AbortSignal.timeout(timeoutMs) }
          : {}),
      })
      let raw = ''
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
        if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
          throw new Error(chunk.reason.failure?.message ?? 'llm finish error')
        }
      }
      lastRaw = raw
      const parsed = parseExtractionJson(raw, episode)
      if (parsed.parsedOk) {
        return { ...parsed, rawChars: raw.length, ok: true, rawText: raw.slice(0, 4000) }
      }
      lastError = `${parsed.dropped[0] ?? 'no JSON'}`
      // A reply without JSON is a FAILED CALL, not "no lessons": retry once with
      // the stricter instruction above, then report failure so the caller can
      // leave the session unprocessed and retry later.
    } catch (error) {
      lastError = String((error as any)?.message ?? error)
    }
  }
  return {
    skills: [],
    negatives: [],
    dropped: [`${lastError}; raw: ${lastRaw.replace(/\s+/gu, ' ').slice(0, 300)}`],
    rawChars: lastRaw.length,
    ok: false,
    ...(lastRaw.length === 0 ? {} : { rawText: lastRaw.slice(0, 4000) }),
  }
}