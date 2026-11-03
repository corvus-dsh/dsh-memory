/**
 * Turn an episode into the four cognitive layers.
 *
 * WHY FOUR LAYERS
 *
 * One model call used to emit `skills` + `negatives` only, and the skill it wrote
 * was measured live as a single sentence ("测试样本必须超过阈值") that named a
 * conclusion but no procedure — useless to a session that had never seen the
 * source conversation. The fix is not "ask for longer skills"; it is to make the
 * model separate observation from conclusion from prohibition from procedure:
 *
 *   fact        — what objectively happened, with a seq pointer (auditable)
 *   experience  — the conclusion of ONE trial (can be wrong; not yet a method)
 *   negative    — the path that must never be repeated (symptom/cause/avoid)
 *   skill       — a VERIFIED procedure, rendered as structured SKILL.md
 *
 * Validation is not paranoia: a hallucinated evidence seq makes the memory
 * unauditable, and an unauditable memory is worse than none (it is a claim the
 * reader cannot check). A skill without steps or without a verification
 * criterion is refused *here*, because that is exactly the empty artifact the
 * live trial produced.
 */

import type { Episode } from './segment.js'
import { renderEpisode } from './segment.js'

/**
 * v0.6: evidence is a COMPOSITE pointer, not a bare seq.
 *
 * A seq is only unique inside one session log. Once memory accumulates across
 * generations, `evidence: 14926` is ambiguous — and `graft_read_result` needs the
 * session id to resolve anything at all. Every stored evidence entry is therefore
 * {sourceSessionId, seq}; the extractor still cites numbers, and the local side
 * attaches the session id it read them from.
 */
export interface EvidenceRef {
  sourceSessionId: string
  seq: number
}

/** v0.6: scene is the isolation axis: database / ui / plugin-dev / … */
export type MemoryScene = string

export interface ExtractedFact {
  /** What happened, in one observable sentence. */
  text: string
  /** The seq in the source log where it can be checked. Required. */
  seq: number
  /** v0.6: the domain this observation belongs to. */
  scene: MemoryScene
}

export interface ExtractedExperience {
  /** The conclusion drawn from one trial/error. */
  text: string
  /** The seq of the trial it came from. Required. */
  seq: number
  /** v0.6: the domain this lesson belongs to. */
  scene: MemoryScene
}

export type MemoryScope = 'workspace' | 'project' | 'global'

export interface ExtractedSkill {
  /** ASCII kebab-case, because that is what a SKILL.md name must be. */
  name: string
  /** Human title (may be Chinese). */
  title: string
  /** One line for the skill catalog: what this skill is. */
  description: string
  /** Frontmatter `when_to_use`: the trigger, concrete enough to decide on. */
  when: string
  /** `## 执行步骤` — ordered, replayable procedure. At least two steps. */
  steps: string[]
  /** `## 验证标准` — how the next session proves it worked. At least one. */
  verify: string[]
  /** v0.5: how far the procedure travels. Defaults to `project`. */
  scope: MemoryScope
  /** v0.6: the scene that gates retrieval. */
  scene: MemoryScene
  /** v0.5: 2-3 alternate phrasings a future session might search with. */
  aliases: string[]
  /** v0.7: operational (a tool did something) vs observational (a tool read). */
  evidenceKind?: 'operational' | 'observational'
  evidence: EvidenceRef[]
}

export interface ExtractedNegative {
  symptom: string
  cause: string
  avoid: string
  /** v0.5: same three-way scope as skills. Defaults to `project`. */
  scope: MemoryScope
  /** v0.6: scene gate. */
  scene: MemoryScene
  evidence: EvidenceRef[]
}

export interface ExtractionResult {
  facts: ExtractedFact[]
  experiences: ExtractedExperience[]
  skills: ExtractedSkill[]
  negatives: ExtractedNegative[]
  /** Names/entries refused locally, with the reason — never silently dropped. */
  dropped: string[]
}

export const EXTRACT_SYSTEM_PROMPT = [
  'You are a capability-memory extractor for a coding agent.',
  'Read the episode and extract FOUR layers, ordered from raw observation to reusable asset:',
  '  fact        = what objectively happened (MUST cite a seq from the episode)',
  '  experience  = the conclusion of ONE trial or failure (one seq is enough)',
  '  negative    = a path that must NEVER be repeated: symptom + cause + avoid',
  '  skill       = a VERIFIED, replayable procedure. Only promote an experience when the episode shows the method actually worked or was confirmed.',
  '',
  'HARD RULES:',
  '1. Never invent evidence. Every entry cites seqs listed in the episode; an entry with an unlisted seq is discarded. The runner re-opens the cited seq in the real session log and drops any skill whose evidence does not show the operation actually succeeding.',
  '1b. Every entry (fact, experience, negative, skill) carries a `scene`: a short latin tag naming the domain, e.g. database, ui, plugin-dev, testing, session-ops, docs. Retrieval only activates memories of the query\'s scene, so a mislabelled scene hides the memory.',
  '2. A skill is a PROCEDURE, not a slogan. It needs at least 2 execution steps and at least 1 verification criterion. "样本必须超过阈值" alone is a REFUSAL, not a skill.',
  '2b. If the session BUILT a reusable artifact (a client, ORM, wrapper, migration, protocol), one of the two skills MUST be that artifact\'s core technique: driver/setup, connection and transaction shape, and the pitfall that shaped it. Process lessons may take the other slot. Do not reduce such a session to process lessons ("test in rounds") when the method itself is the reusable asset.',
  '3. A skill must state WHEN it applies, concretely enough that a fresh session can decide yes or no.',
  '4. Reject generic advice (要小心 / 注意细节 / test thoroughly / write clean code). Only session-specific, checkable content.',
  '5. At most 3 facts, 3 experiences, 2 skills and 3 negatives. Precision beats recall.',
  '6. name is ASCII kebab-case (a-z, 0-9, hyphens, <= 48 chars). title/description/when_to_use may be Chinese.',
  '6b. Every skill and negative carries `scope`: workspace (only this repo/dir), project (this project family) or global (any DSH session). Be conservative: when unsure, use project.',
  '6c. Every skill carries 2-3 `aliases`: other phrasings a future session might use to ask for this, e.g. ["连数据库", "mysql 查询", "pymysql 客户端"]. They feed lexical recall, so prefer the words a human would type.',
  '7. Be terse: step <= 40 words, verify <= 25 words, description <= 30 words. The JSON must stay complete.',
  '',
  'Every skill becomes one SKILL.md with exactly this shape:',
  '---',
  'name: threshold-fixture-sizing',
  'description: 处理阈值型逻辑测试时的样本量设计规范。',
  'when_to_use: 当你在编写涉及 `>`, `<`, `>=`, `<=` 判断的测试用例时。',
  'scope: project',
  'aliases: 阈值测试, 边界样本, threshold tests',
  '---',
  '## 执行步骤',
  '1. 查看源码中的阈值变量（如 `MAX_RETRIES = 3`）。',
  '2. 测试用例的输入数据必须设为 `阈值 + 1`。',
  '3. 必须写两个测试：一个传 `阈值` 断言不触发，一个传 `阈值 + 1` 断言触发。',
  '## 验证标准',
  '运行测试，确保覆盖了跨越边界的正反两种情况。',
  '',
  'So: description = what it is; when_to_use = the trigger; steps = the procedure; verify = how the next session proves it worked.',
  '',
  'Return ONLY JSON:',
  '{"facts":[{"text":"...","scene":"database","seq":12}],',
  ' "experiences":[{"text":"...","scene":"database","seq":12}],',
  ' "negatives":[{"symptom":"...","cause":"...","avoid":"...","scope":"project","scene":"database","evidence":[56]}],',
  ' "skills":[{"name":"kebab-name","title":"...","description":"...","when_to_use":"...",',
  '            "scope":"project","scene":"database","aliases":["连数据库","mysql 查询"],',
  '            "steps":["...","..."],"verify":["..."],"evidence":[12,34]}]}',
].join('\n')

const GENERIC = /(要小心|注意安全|多加测试|注意细节|保持整洁|be careful|test thoroughly|write clean|pay attention|good luck)/iu
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SCOPES = new Set(['workspace', 'project', 'global'])

/** v0.5: scope is a stated claim, never inferred from wording. Bad/missing → project. */
function asScope(value: unknown): MemoryScope {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return SCOPES.has(text) ? (text as MemoryScope) : 'project'
}

const SCENE = /^[a-z][a-z0-9-]{1,23}$/

/** v0.6: scene must be a simple latin tag; anything else degrades to `general`. */
export function asScene(value: unknown): MemoryScene {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return SCENE.test(text) ? text : 'general'
}

/** v0.6: numbers become composite refs against the episode's own session id. */
function asEvidenceRefs(value: unknown, allowed: Set<number>, sourceSessionId: string): EvidenceRef[] {
  const out: EvidenceRef[] = []
  const raw = Array.isArray(value) ? value : []
  for (const item of raw) {
    const seq = Number(typeof item === 'object' && item !== null ? (item as any).seq : item)
    if (!Number.isFinite(seq)) continue
    if (!allowed.has(seq)) continue
    if (out.some((ref) => ref.seq === seq)) continue
    out.push({ sourceSessionId, seq })
  }
  return out
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
}

/** Strings only, trimmed and de-duplicated, bounded by `max`. */
function asTextList(value: unknown, max: number): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const out: string[] = []
  for (const item of raw) {
    const text = asText(item)
    if (text.length === 0 || out.includes(text)) continue
    out.push(text)
    if (out.length >= max) break
  }
  return out
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

/** One seq that must exist in the episode, or undefined. */
function asSeq(value: unknown, allowed: Set<number>): number | undefined {
  const seq = Number(value)
  return Number.isFinite(seq) && allowed.has(seq) ? seq : undefined
}

export function sanitizeExtraction(raw: unknown, episode: Episode): ExtractionResult {
  const dropped: string[] = []
  const allowed = new Set(episode.evidence)
  const facts: ExtractedFact[] = []
  const experiences: ExtractedExperience[] = []
  const skills: ExtractedSkill[] = []
  const negatives: ExtractedNegative[] = []
  if (raw === null || typeof raw !== 'object') {
    return { facts, experiences, skills, negatives, dropped: ['payload is not an object'] }
  }

  const rawFacts = Array.isArray((raw as any).facts) ? (raw as any).facts : []
  for (const item of rawFacts) {
    if (facts.length >= 3) break
    if (item === null || typeof item !== 'object') continue
    const text = asText(item.text)
    const label = text.slice(0, 40) || '(unnamed fact)'
    if (text.length < 8) {
      dropped.push(`${label}: fact is too short to be an observation`)
      continue
    }
    const seq = asSeq(item.seq, allowed)
    if (seq === undefined) {
      // A fact without a pointer is an opinion; the whole point of this layer is auditability.
      dropped.push(`${label}: fact has no valid seq pointer`)
      continue
    }
    facts.push({ text: text.slice(0, 240), seq, scene: asScene(item.scene) })
  }

  const rawExperiences = Array.isArray((raw as any).experiences) ? (raw as any).experiences : []
  for (const item of rawExperiences) {
    if (experiences.length >= 3) break
    if (item === null || typeof item !== 'object') continue
    const text = asText(item.text)
    const label = text.slice(0, 40) || '(unnamed experience)'
    if (text.length < 6) {
      dropped.push(`${label}: experience is too short to be a conclusion`)
      continue
    }
    const seq = asSeq(item.seq, allowed)
    if (seq === undefined) {
      dropped.push(`${label}: experience has no valid seq pointer`)
      continue
    }
    experiences.push({ text: text.slice(0, 240), seq, scene: asScene(item.scene) })
  }

  const rawSkills = Array.isArray((raw as any).skills) ? (raw as any).skills : []
  for (const item of rawSkills) {
    if (skills.length >= 2) break
    if (item === null || typeof item !== 'object') continue
    const name = asText(item.name).toLowerCase()
    const title = asText(item.title)
    const when = asText(item.when_to_use) || asText(item.when)
    // `how`/`steps` and `when`/`when_to_use` aliases keep an already-queued v0.1
    // suggestion readable; the shape written to disk is always the new one.
    const steps = asTextList(item.steps ?? item.how, 5)
    const verify = asTextList(item.verify ?? item.verification, 3)
    const evidence = asEvidenceRefs(item.evidence, allowed, episode.sessionId)
    const description = asText(item.description) || when.slice(0, 160)
    const label = name || title || '(unnamed skill)'
    if (!KEBAB.test(name) || name.length > 48) {
      dropped.push(`${label}: name is not ASCII kebab-case`)
      continue
    }
    if (when.length < 6) {
      dropped.push(`${label}: when_to_use is missing`)
      continue
    }
    if (steps.length < 2) {
      // The live failure this rule exists for: a one-line "skill" that states a
      // conclusion and calls it a method.
      dropped.push(`${label}: needs at least 2 execution steps (got ${steps.length})`)
      continue
    }
    if (verify.length === 0 || verify.every((line) => line.length < 4)) {
      dropped.push(`${label}: no verification criterion`)
      continue
    }
    if (evidence.length === 0) {
      dropped.push(`${label}: no evidence seq from this session`)
      continue
    }
    if (GENERIC.test(`${title} ${when} ${steps.join(' ')}`.slice(0, 600)) && steps.length < 3) {
      dropped.push(`${label}: generic advice`)
      continue
    }
    skills.push({
      name,
      title: title || name,
      description: description.slice(0, 160),
      when: when.slice(0, 200),
      steps,
      verify,
      scope: asScope(item.scope),
      scene: asScene(item.scene),
      aliases: asTextList(item.aliases ?? item.alias, 3),
      evidence,
    })
  }

  const rawNegatives = Array.isArray((raw as any).negatives) ? (raw as any).negatives : []
  for (const item of rawNegatives) {
    if (negatives.length >= 3) break
    if (item === null || typeof item !== 'object') continue
    const symptom = asText(item.symptom)
    const cause = asText(item.cause)
    const avoid = asText(item.avoid)
    const evidence = asEvidenceRefs(item.evidence, allowed, episode.sessionId)
    const label = symptom.slice(0, 40) || '(unnamed negative)'
    if (symptom.length < 6 || cause.length < 4 || avoid.length < 4) {
      dropped.push(`${label}: symptom/cause/avoid incomplete`)
      continue
    }
    if (evidence.length === 0) {
      dropped.push(`${label}: no evidence seq from this session`)
      continue
    }
    negatives.push({
      symptom: symptom.slice(0, 200),
      cause: cause.slice(0, 200),
      avoid: avoid.slice(0, 200),
      scope: asScope(item.scope),
      scene: asScene(item.scene),
      evidence,
    })
  }

  return { facts, experiences, skills, negatives, dropped }
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
      facts: [],
      experiences: [],
      skills: [],
      negatives: [],
      dropped: [truncated ? 'reply truncated before the JSON closed' : 'no JSON object in the reply'],
      parsedOk: false,
    }
  }
  try {
    return { ...sanitizeExtraction(JSON.parse(raw.slice(start, end + 1)), episode), parsedOk: true }
  } catch (error) {
    return {
      facts: [],
      experiences: [],
      skills: [],
      negatives: [],
      dropped: [`invalid JSON: ${String((error as any)?.message ?? error)}`],
      parsedOk: false,
    }
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
  /**
   * v0.6 strong verification: called with the cited evidence refs. The caller
   * re-opens the REAL session log and confirms the operation happened and
   * succeeded. A skill that cannot be confirmed is dropped with a reason — a
   * summarised 240-char conclusion is not proof that the code ran.
   */
  verify?: (refs: readonly EvidenceRef[]) => { ok: boolean; observation?: boolean; reason?: string }
}

/** One extraction call. Returns an empty result (with a reason) rather than throwing. */
function verifySkills(
  parsed: ExtractionResult,
  verify: (refs: readonly EvidenceRef[]) => { ok: boolean; observation?: boolean; reason?: string },
): ExtractionResult {
  const skills: ExtractedSkill[] = []
  const dropped = [...parsed.dropped]
  for (const skill of parsed.skills) {
    const check = verify(skill.evidence)
    if (check.ok) {
      skills.push(check.observation === true ? { ...skill, evidenceKind: 'observational' } : { ...skill, evidenceKind: 'operational' })
    } else {
      dropped.push(`${skill.name}: evidence not confirmed (${check.reason ?? 'raw log check failed'})`)
    }
  }
  return { ...parsed, skills, dropped }
}
export async function extractEpisode(
  llm: LlmLike | undefined,
  episode: Episode,
  options: ExtractOptions = {},
): Promise<ExtractionResult & { rawChars: number; ok: boolean; rawText?: string }> {
  if (llm === undefined || typeof llm.stream !== 'function') {
    return { facts: [], experiences: [], skills: [], negatives: [], dropped: ['llm service unavailable'], rawChars: 0, ok: false }
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
        maxTokens: 4000,
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
        const verified = options.verify === undefined ? parsed : verifySkills(parsed, options.verify)
        return { ...verified, rawChars: raw.length, ok: true, rawText: raw.slice(0, 4000) }
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
    facts: [],
    experiences: [],
    skills: [],
    negatives: [],
    dropped: [`${lastError}; raw: ${lastRaw.replace(/\s+/gu, ' ').slice(0, 300)}`],
    rawChars: lastRaw.length,
    ok: false,
    ...(lastRaw.length === 0 ? {} : { rawText: lastRaw.slice(0, 4000) }),
  }
}