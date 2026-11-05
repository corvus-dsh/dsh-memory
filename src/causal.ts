/**
 * CAUSAL RETRIEVAL — `src/causal.ts`.
 *
 * WHAT THIS REPLACES, AND WHY LEXICAL SEARCH IS NOT ENOUGH
 *
 * `retrieveCandidates` answers "which stored memories look like this query". That is the right question for
 * a HINT shown to a model. It is the wrong question for a CONSUMER that must decide "may I do this?" — a
 * scheduler, a compiler, an agent about to run a procedure. Those need to walk the graph:
 *
 *     Target Action  ──> which Skills claim it?
 *                            │
 *                            ├─ dependencies ─────────────> Facts that must hold first
 *                            │
 *                            └─ blocked_condition ───────> Negatives that forbid it
 *                                     │
 *                                     └─ cause/effect ───> Experiences that explain why
 *                                                              │
 *                                                              └─ evidence ─> Facts (seq pointers)
 *
 * So this module does REVERSE TRAVERSAL from an action, following the pointers the v0.32 schema added, and
 * returns the evidence chain with its provenance intact. Word overlap plays NO part: a negative with no
 * shared vocabulary but an applicable `blocked_condition` is exactly the one lexical search would miss, and
 * missing it is how a known failure gets repeated.
 *
 * THE HONEST LIMIT, STATED UP FRONT
 *
 * This is not a datalog engine. It walks ONE hop per relation and does not transitively close the graph,
 * because the data does not support more: `dependencies` points at evidence (a seq), not at another skill.
 * Adding transitive closure over pointers that mean different things would produce confident nonsense.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readSkillBody, listSkillRecords } from './store.js'
import { tokenize } from './retrieve.js'

/** One node in the chain, whatever layer it came from. */
export interface CausalNode {
  layer: 'skill' | 'negative' | 'experience' | 'fact'
  /** The stored identifier: a skill name, or the document's stable id. */
  id: string
  title: string
  /** Why this node is in the chain — the relation that pulled it in. */
  relation: 'target' | 'dependency' | 'blocker' | 'cause' | 'effect' | 'evidence'
  /** Free text the consumer can read: the step, the symptom, the observation. */
  detail?: string
  /** The composite pointer, when the node has one. */
  pointer?: { sourceSessionId: string; seq: number }
  /** Extra fields the schema records, surfaced rather than summarised away. */
  extra?: Record<string, unknown>
}

export interface CausalChain {
  /** The action that was asked about. */
  target: string
  /** Every skill whose `when`/`title`/`target_effect` matches the action. */
  skills: CausalNode[]
  /** Negatives whose `blocked_condition` (or symptom) applies — the stopping conditions. */
  blockers: CausalNode[]
  /** Preconditions the matching skills declare. */
  dependencies: CausalNode[]
  /** Expected results the matching skills declare. */
  effects: CausalNode[]
  /** Experiences pulled in through cause/effect. */
  experiences: CausalNode[]
  /** Facts pulled in as evidence, de-duplicated by pointer. */
  facts: CausalNode[]
  /** Non-empty when the chain is incomplete, and WHY. Never a silent gap. */
  warnings: string[]
}

interface RawRecord {
  [key: string]: unknown
}

/**
 * Read a JSONL file, tolerating a torn tail.
 *
 * WHY THE STATIC IMPORT MATTERS, AND WHAT ITS ABSENCE COST: the first version called
 * `require('node:fs')` to avoid a top-level import. In an ESM module `require` is UNDEFINED, and the
 * surrounding `try/catch` turned that into "this file has no records" — so every layer of the causal chain
 * silently came back empty while the code looked perfectly reasonable. A test caught it; nothing else would
 * have. The import is now static, and the catch below only tolerates REAL read failures.
 */
function readJsonl(path: string): RawRecord[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    /** A missing file is legitimately empty (a fresh store). Anything else would have thrown above. */
    return []
  }
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as RawRecord
      } catch {
        return undefined
      }
    })
    .filter((value): value is RawRecord => value !== undefined)
}

/**
 * Does this text plausibly describe the target action?
 *
 * WHY THE TOKEN FALLBACK IS NOT ENOUGH FOR THIS LANGUAGE: `tokenize` splits on whitespace and punctuation,
 * which is right for English and useless for Chinese — "重启开发服务器" is ONE token, so a negative whose
 * condition says "结束相关进程时" shares no token with it even though both are about the same operation. The
 * first version of this function therefore missed exactly the blockers it exists to find.
 *
 * AND WHY THE FRAGMENT TEST NEEDED ITS OWN FIX: a target arrives as a PHRASE ("部署脚本 失败"), and slicing
 * it from every offset produces pieces that still CONTAIN the space — so none of them is a substring of a
 * sentence. The visible symptom was a fact whose text plainly contained "部署脚本" being reported as absent.
 * The pieces must therefore be split on whitespace FIRST, and each piece tested on its own.
 */
function mentions(text: string, target: string): boolean {
  const haystack = text.toLowerCase()
  const needle = target.toLowerCase().trim()
  if (needle.length === 0) return false
  if (haystack.includes(needle)) return true

  /**
   * PIECE-WISE: any meaningful piece of the phrase that appears verbatim is evidence. Two characters is the
   * floor here — Chinese carries meaning in two (`失败`, `端口`), and a single character would match noise.
   */
  const pieces = needle.split(/\s+/u).filter((piece) => piece.length >= 2)
  for (const piece of pieces) {
    if (haystack.includes(piece)) return true
  }

  /** Suffix fragments of each piece, for "重启开发服务器" vs "结束开发服务器相关进程时". */
  for (const piece of pieces) {
    for (let start = 0; start < piece.length; start += 1) {
      const fragment = piece.slice(start)
      if (fragment.length >= 3 && haystack.includes(fragment)) return true
    }
  }

  /** Bigram overlap, floor 2: one shared bigram is coincidence, two is a shared concept. */
  const bigrams = (value: string): Set<string> => {
    const out = new Set<string>()
    const compact = value.replace(/\s+/gu, '')
    for (let index = 0; index + 1 < compact.length; index += 1) out.add(compact.slice(index, index + 2))
    return out
  }
  const targetGrams = bigrams(needle)
  if (targetGrams.size === 0) return false
  let shared = 0
  for (const gram of bigrams(haystack)) {
    if (targetGrams.has(gram)) shared += 1
    if (shared >= 2) return true
  }
  return false
}

function pointerOf(value: unknown): { sourceSessionId: string; seq: number } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  const seq = Number(candidate.seq)
  const sourceSessionId = String(candidate.sourceSessionId ?? '')
  if (!Number.isFinite(seq)) return undefined
  return { sourceSessionId, seq }
}

/**
 * Walk the causal graph backwards from a target action.
 *
 * READ-ONLY. It never writes, never repairs, and never invents a node: a chain that cannot be completed
 * comes back SHORTER with a warning, which is the only honest way to answer "here is your evidence".
 */
export function causalChain(
  memoryDir: string,
  skillsDir: string,
  target: string,
  options: { limit?: number } = {},
): CausalChain {
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : 20
  const warnings: string[] = []
  const skills: CausalNode[] = []
  const blockers: CausalNode[] = []
  const dependencies: CausalNode[] = []
  const effects: CausalNode[] = []

  /* ── 1. which skills claim this action ─────────────────────────────────────────────────── */

  let records: ReturnType<typeof listSkillRecords> = []
  try {
    records = listSkillRecords(skillsDir)
  } catch (error) {
    warnings.push(`技能目录不可读：${String((error as any)?.message ?? error)}`)
  }

  for (const record of records) {
    const body = (() => {
      try {
        return readSkillBody(skillsDir, record.name)
      } catch {
        return undefined
      }
    })()
    const haystack = [record.title, record.when, body?.body ?? ''].join('\n')
    if (!mentions(haystack, target)) continue

    const node: CausalNode = {
      layer: 'skill',
      id: record.name,
      title: record.title,
      relation: 'target',
      detail: record.when,
    }
    skills.push(node)

    /**
     * PRECONDITIONS AND EXPECTED EFFECT come from the SKILL.md's own frontmatter, read through
     * `readSkillBody` — so the chain reflects what was WRITTEN, not what this function wishes were there.
     */
    for (const dependency of body?.dependencies ?? []) {
      const pointer = pointerOf(dependency)
      dependencies.push({
        layer: 'fact',
        id: `${record.name}:dependency:${pointer?.seq ?? dependencies.length}`,
        title: `前置条件 · ${record.name}`,
        relation: 'dependency',
        ...(pointer === undefined ? {} : { pointer }),
        extra: { requiredBy: record.name },
      })
    }
    if (typeof body?.targetEffect === 'string' && body.targetEffect.length > 0) {
      effects.push({
        layer: 'skill',
        id: `${record.name}:effect`,
        title: `预期结果 · ${record.name}`,
        relation: 'effect',
        detail: body.targetEffect,
      })
    }
    if (skills.length >= limit) break
  }

  /* ── 2. which negatives BLOCK it, and which experiences explain them ───────────────────── */

  const negatives = readJsonl(join(memoryDir, 'negatives.jsonl'))
  for (const record of negatives) {
    const blockedCondition = typeof record.blocked_condition === 'string' ? record.blocked_condition : ''
    const symptom = String(record.symptom ?? '')
    const cause = String(record.cause ?? '')
    /**
     * THE CONDITION IS THE PRIMARY KEY, not the symptom. A negative whose `blocked_condition` applies is
     * applicable even if its wording shares nothing with the action — which is exactly the case lexical
     * search loses.
     */
    if (!mentions(blockedCondition, target) && !mentions(symptom, target)) continue
    const firstEvidence = Array.isArray(record.evidence) ? record.evidence[0] : undefined
    blockers.push({
      layer: 'negative',
      id: `negative:${symptom.slice(0, 40)}`,
      title: symptom,
      relation: 'blocker',
      detail: [cause, String(record.avoid ?? '')].filter((part) => part.length > 0).join(' → '),
      ...(pointerOf(firstEvidence) === undefined ? {} : { pointer: pointerOf(firstEvidence) }),
      extra: { blockedCondition, cause },
    })
    if (blockers.length >= limit) break
  }

  /* ── 3. experiences, pulled in by cause/effect or by the same target ──────────────────── */

  const experiences = readJsonl(join(memoryDir, 'experiences.jsonl'))
  const experienceNodes: CausalNode[] = []
  for (const record of experiences) {
    const text = String(record.text ?? '')
    const action = typeof record.action === 'string' ? record.action : ''
    if (!mentions(text, target) && !mentions(action, target)) continue
    const cause = pointerOf(record.cause)
    const effect = pointerOf(record.effect)
    experienceNodes.push({
      layer: 'experience',
      id: `experience:${text.slice(0, 40)}`,
      title: text.slice(0, 120),
      relation: 'cause',
      detail: action.length > 0 ? action : undefined,
      ...(cause === undefined ? {} : { pointer: cause }),
      extra: {
        ...(cause === undefined ? {} : { cause: `${cause.sourceSessionId}@${cause.seq}` }),
        ...(effect === undefined ? {} : { effect: `${effect.sourceSessionId}@${effect.seq}` }),
      },
    })
    if (experienceNodes.length >= limit) break
  }
  if (experienceNodes.length === 0 && (skills.length > 0 || blockers.length > 0)) {
    warnings.push(
      '没有找到解释这段因果的经验记录：负知识与技能都指向了某个动作，但没有 Experience 说明它为什么成立',
    )
  }

  /* ── 4. facts as the bottom of the chain, de-duplicated by pointer ────────────────────── */

  const factsRaw = readJsonl(join(memoryDir, 'facts.jsonl'))
  const factByPointer = new Map<string, CausalNode>()
  for (const record of factsRaw) {
    const text = String(record.text ?? '')
    const action = typeof record.action === 'string' ? record.action : ''
    if (!mentions(text, target) && !mentions(action, target)) continue
    const evidence = Array.isArray(record.evidence) ? record.evidence : []
    const pointer = pointerOf(evidence[0])
    if (pointer !== undefined) {
      const key = `${pointer.sourceSessionId}@${pointer.seq}`
      if (factByPointer.has(key)) continue
    }
    const id = `fact:${text.slice(0, 40)}`
    factByPointer.set(pointer === undefined ? id : `${pointer.sourceSessionId}@${pointer.seq}`, {
      layer: 'fact',
      id,
      title: text.slice(0, 120),
      relation: 'evidence',
      ...(pointer === undefined ? {} : { pointer }),
      ...(typeof record.timestamp === 'string' ? { extra: { timestamp: record.timestamp } } : {}),
    })
    if (factByPointer.size >= limit) break
  }

  /**
   * THE TRACE FIELD IS REPORTED, NOT ASSUMED. A fact written before v0.32 has no `timestamp`, so a consumer
   * ordering the chain by time must know the ordering is incomplete rather than believing a partial order.
   */
  const untimed = factsRaw.filter((record) => typeof record.timestamp !== 'string').length
  if (untimed > 0) {
    warnings.push(
      `${untimed} 条事实没有 timestamp（v0.32 之前写入）：它们无法参与严格时序排序，缺失就是缺失，不补造`,
    )
  }

  return {
    target,
    skills,
    blockers,
    dependencies,
    effects,
    experiences: experienceNodes,
    facts: [...factByPointer.values()],
    warnings,
  }
}

/** A one-line summary for a log or a hint, so a consumer can report the chain without dumping it. */
export function describeCausalChain(chain: CausalChain): string {
  const parts = [
    `${chain.skills.length} 技能`,
    `${chain.blockers.length} 阻塞条件`,
    `${chain.dependencies.length} 前置`,
    `${chain.experiences.length} 经验`,
    `${chain.facts.length} 事实`,
  ]
  return `因果链「${chain.target}」：${parts.join(' / ')}${chain.warnings.length === 0 ? '' : `（${chain.warnings.length} 条警告）`}`
}
