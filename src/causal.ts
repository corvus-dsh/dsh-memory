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
import type { SkillBody, SkillRecord } from './store.js'

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
 * WHERE A CHAIN READS ITS RECORDS FROM — the seam that keeps this module path-free.
 *
 * WHY THIS EXISTS AT ALL
 *
 * Every layer below used to be reached by joining a directory and a filename, which welded the causal
 * chain to one storage layout: the skills as a directory of `SKILL.md` files, the three layers as
 * jsonl files beside it. That is the layout the L0 tier happens to use. It is NOT the contract, and a
 * tier that keeps its hot layers in memory (the L1 driver) has no such paths at all — so a chain that
 * insisted on joining paths could only ever answer for L0.
 *
 * WHAT IT IS NOT: a storage engine. It is three narrow questions — "which skills have I got", "read
 * this skill's body", "read these records" — because those are the only reads the traversal performs.
 * A wider interface would tempt this module to care about writing, and it never writes.
 *
 * THE DEFAULT IS THE FILE LAYOUT, EXACTLY AS BEFORE. `fileCausalSource()` is what `causalChain()`
 * builds when a caller passes only directories, so every existing call site — and every test that
 * asserts on real files — keeps the behaviour it had, byte for byte.
 */
export interface CausalRecordSource {
  /** Every stored skill, newest state of each. */
  skills(): SkillRecord[]
  /** One skill's markdown body, or undefined when it is absent/unreadable. */
  skillBody(name: string): SkillBody | undefined
  /** The records of one layer, in file order. A missing layer is an empty list, never an error. */
  layer(name: 'negatives' | 'facts' | 'experiences'): RawRecord[]
}

/** The record source for the L0 (file) layout: a memory directory and a skills directory. */
export function fileCausalSource(memoryDir: string, skillsDir: string): CausalRecordSource {
  return {
    skills: () => listSkillRecords(skillsDir),
    skillBody: (name) => readSkillBody(skillsDir, name),
    layer: (name) => readJsonl(join(memoryDir, `${name}.jsonl`)),
  }
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
 *
 * THE TWO DIRECTORIES ARE STILL THE SIGNATURE, AND STILL MEAN WHAT THEY MEANT. They are how a caller
 * says "read the L0 layout at this location"; `options.source` overrides where the records come from
 * without changing what the traversal does. Keeping the positional form is deliberate: 20 call sites
 * and four test files already use it, and a refactor that made the chain reach a different set of
 * records would be a behaviour change wearing a tidy-up's clothes.
 */
export function causalChain(
  memoryDir: string,
  skillsDir: string,
  target: string,
  options: { limit?: number; source?: CausalRecordSource } = {},
): CausalChain {
  const source = options.source ?? fileCausalSource(memoryDir, skillsDir)
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : 20
  const warnings: string[] = []
  const skills: CausalNode[] = []
  const blockers: CausalNode[] = []
  const dependencies: CausalNode[] = []
  const effects: CausalNode[] = []

  /* ── 1. which skills claim this action ─────────────────────────────────────────────────── */

  let records: SkillRecord[] = []
  try {
    records = source.skills()
  } catch (error) {
    warnings.push(`技能目录不可读：${String((error as any)?.message ?? error)}`)
  }

  for (const record of records) {
    const body = (() => {
      try {
        return source.skillBody(record.name)
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

  const negatives = source.layer('negatives')
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

  const experiences = source.layer('experiences')
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

  const factsRaw = source.layer('facts')
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

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE RECURSIVE WALK — `recursiveCausalChain`
 *
 * WHY THE ONE-HOP WALK IS NOT ENOUGH FOR A SCHEDULER
 *
 * `causalChain` answers "what does this action touch?" — one hop from the target, which is what a HINT
 * needs. A COMPILER asks a different question: "what must be true before I may schedule this, and
 * what must be true before THAT?" That is a graph, and a one-hop answer is a single level of it.
 *
 * So this walk follows pointers DOWNWARD: an experience's `cause` and `effect` are themselves
 * pointers into a session log, and a fact cited as evidence can itself be the cause of a deeper
 * experience. Repeating the hop is what turns the list into a DAG.
 *
 * WHAT IS ACTUALLY FOLLOWED, AND WHAT IS NOT — stated so the graph cannot be over-read
 *
 *   skill  ──dependencies/target_effect──> facts (by pointer)      ✔ followed
 *   negative ──evidence──> fact                                     ✔ followed
 *   experience ──cause/effect──> fact                               ✔ followed
 *   fact ──(no outgoing pointer)                                    ✘ terminal by construction
 *
 * A FACT IS A LEAF. The records carry one pointer each (`evidence[0]`), pointing INTO a session log;
 * a session event has no memory-layer pointers at all. That is a property of the DATA, not a choice
 * made here — inventing an edge from a fact to another fact would mean matching text, which is the
 * "confident nonsense" this module's header warns about.
 *
 * WHY DEPTH IS A HARD LIMIT AND NOT A SUGGESTION
 *
 * Two reasons, and the second is the one that matters operationally:
 *   1. the graph is finite but the POINTER SPACE is not (a corrupt record can point at itself);
 *   2. a scheduler that recurses must bound its own work, or a bad store turns a compile step into a
 *      hang. `maxDepth` is therefore enforced by the walker, not by the caller's patience.
 *
 * CYCLES ARE DETECTED BY NODE IDENTITY, and a revisited node is recorded as such rather than silently
 * dropped: a consumer that sees `revisited: true` knows the graph looped, which is different from
 * "there was nothing further".
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/** One node in the recursive graph, carrying how far from the target it sits. */
export interface CausalGraphNode extends CausalNode {
  /** 0 = the target's own layer; 1 = one hop down; … */
  depth: number
  /** The node that pulled this one in, when it was pulled in by another node. */
  via?: string
  /** True when this node was already visited on this walk — a cycle, reported rather than hidden. */
  revisited?: boolean
}

/** One edge of the graph, oriented cause → effect (or blocker → blocked action). */
export interface CausalGraphEdge {
  from: string
  to: string
  /** Which pointer produced this edge. */
  relation: 'dependency' | 'blocker' | 'cause' | 'effect' | 'evidence'
}

export interface CausalGraph {
  target: string
  /** Every node reached, breadth-first, deepest last. */
  nodes: CausalGraphNode[]
  edges: CausalGraphEdge[]
  /** How deep the walk actually got (0 when nothing was found). */
  depthReached: number
  /** Nodes whose outgoing pointers were NOT followed because `maxDepth` was hit. */
  truncatedAt: string[]
  warnings: string[]
}

export interface RecursiveChainOptions {
  /** How many hops below the target to follow. Default 3. Values below 1 are clamped to 1. */
  maxDepth?: number
  /** Cap on TOTAL nodes, so a wide graph cannot blow up a prompt. Default 60. */
  maxNodes?: number
  /** Cap per layer at each hop, so one noisy layer cannot crowd out the others. Default 20. */
  limitPerHop?: number
  /** Where records come from. Defaults to the L0 file layout. */
  source?: CausalRecordSource
}

/**
 * Walk the causal graph BACKWARDS from an action, following pointers `maxDepth` hops down.
 *
 * READ-ONLY, like its one-hop sibling: it never writes, never repairs, and never invents a node.
 *
 * THE ENTRY POINT IS THE ONE-HOP WALK. Reusing it means the two functions can never disagree about
 * what "this action's skill" means — a second, separately-written matcher is how a hint and a
 * scheduler end up seeing different graphs for the same action.
 */
export function recursiveCausalChain(
  memoryDir: string,
  skillsDir: string,
  target: string,
  options: RecursiveChainOptions = {},
): CausalGraph {
  const source = options.source ?? fileCausalSource(memoryDir, skillsDir)
  const maxDepth = Math.max(1, Math.trunc(Number(options.maxDepth ?? 3)))
  const maxNodes = Math.max(1, Math.trunc(Number(options.maxNodes ?? 60)))
  const limitPerHop = Math.max(1, Math.trunc(Number(options.limitPerHop ?? 20)))

  const warnings: string[] = []
  const nodes: CausalGraphNode[] = []
  const edges: CausalGraphEdge[] = []
  const seen = new Set<string>()
  const truncatedAt: string[] = []

  /**
   * THE POINTER INDEX — built ONCE, from every layer.
   *
   * WHY AN INDEX AND NOT A RE-SCAN PER HOP: a hop from a pointer would otherwise re-read and re-match
   * every record in every layer. With four layers and a depth of five that is twenty scans of the same
   * files for one graph, and the results could differ between scans if a harvest writes concurrently.
   *
   * WHY **EVERY** EVIDENCE ENTRY IS INDEXED, NOT JUST THE FIRST: a fact is often supported by several
   * events, and the one that CHAINS to a deeper record is not always the first one written. Indexing
   * only `evidence[0]` made the walk stop at depth 1 for every graph whose second citation was the
   * interesting one — measured, not hypothesised: the first version of this function reached exactly
   * one hop on a five-level fixture.
   */
  const factsByPointer = new Map<string, RawRecord[]>()
  const experiencesByCause = new Map<string, RawRecord[]>()
  const negativesByEvidence = new Map<string, RawRecord[]>()

  const indexPointer = (map: Map<string, RawRecord[]>, pointer: { sourceSessionId: string; seq: number } | undefined, record: RawRecord): void => {
    if (pointer === undefined) return
    const key = `${pointer.sourceSessionId}@${pointer.seq}`
    const bucket = map.get(key)
    if (bucket === undefined) map.set(key, [record])
    else if (!bucket.includes(record)) bucket.push(record)
  }
  const indexAllEvidence = (map: Map<string, RawRecord[]>, record: RawRecord): void => {
    for (const ref of Array.isArray(record.evidence) ? record.evidence : []) indexPointer(map, pointerOf(ref), record)
  }

  for (const record of source.layer('facts')) indexAllEvidence(factsByPointer, record)
  for (const record of source.layer('experiences')) {
    indexPointer(experiencesByCause, pointerOf(record.cause), record)
    indexPointer(experiencesByCause, pointerOf(record.effect), record)
    indexAllEvidence(experiencesByCause, record)
  }
  for (const record of source.layer('negatives')) indexAllEvidence(negativesByEvidence, record)

  const push = (node: CausalGraphNode): boolean => {
    if (nodes.length >= maxNodes) return false
    if (seen.has(node.id)) {
      // A REVISIT IS DATA. Recorded once, not expanded again — expanding it is how a cycle hangs.
      if (!nodes.some((existing) => existing.id === node.id && existing.revisited === true)) {
        nodes.push({ ...node, revisited: true })
      }
      return false
    }
    seen.add(node.id)
    nodes.push(node)
    return true
  }

  /* ── hop 0: the target's own layer, via the one-hop walk ─────────────────────────────── */

  const base = causalChain(memoryDir, skillsDir, target, { limit: limitPerHop, source })
  warnings.push(...base.warnings)

  const seed: Array<{ node: CausalNode; via?: string }> = [
    ...base.skills.map((node) => ({ node })),
    ...base.blockers.map((node) => ({ node })),
    ...base.experiences.map((node) => ({ node })),
    ...base.dependencies.map((node) => ({ node })),
    ...base.effects.map((node) => ({ node })),
    ...base.facts.map((node) => ({ node })),
  ]

  /** The frontier for the next hop: pointers that still have something to pull in. */
  let frontier: Array<{ fromId: string; pointers: Array<{ sourceSessionId: string; seq: number }>; depth: number }> = []

  for (const entry of seed) {
    const node = entry.node
    push({ ...node, depth: 0, ...(entry.via === undefined ? {} : { via: entry.via }) })
    if (node.pointer !== undefined && maxDepth > 1) {
      frontier.push({ fromId: node.id, pointers: [node.pointer], depth: 1 })
    }
  }

  /**
   * A SKILL'S DECLARED PRECONDITION IS AN EDGE, not just a label.
   *
   * `causalChain` reports `dependencies` as separate nodes; here they are also connected to the skill
   * that declared them, because a compiler needs to know WHICH procedure requires them.
   */
  for (const dependency of base.dependencies) {
    for (const skill of base.skills) {
      if (dependency.pointer === undefined) continue
      edges.push({ from: dependency.id, to: skill.id, relation: 'dependency' })
      break
    }
  }
  for (const skill of base.skills) {
    for (const effect of base.effects) {
      if (!effect.id.startsWith(`${skill.id}:effect`)) continue
      edges.push({ from: skill.id, to: effect.id, relation: 'effect' })
    }
  }
  for (const blocker of base.blockers) {
    for (const skill of base.skills) {
      edges.push({ from: blocker.id, to: skill.id, relation: 'blocker' })
    }
  }

  /* ── hops 1..maxDepth: follow pointers downward ────────────────────────────────────── */

  let depthReached = 0

  while (frontier.length > 0) {
    const next: typeof frontier = []
    for (const item of frontier) {
      if (item.depth > maxDepth) continue

      /**
       * EVERY POINTER ON THE NODE IS FOLLOWED, not just the first one.
       *
       * The first version followed `evidence[0]` alone, and that is why an experience whose CAUSE
       * pointed somewhere useful never expanded: an experience's `evidence` is usually empty, so the
       * walk stopped at depth 1 no matter how deep the graph really was. A scheduler does not care
       * which field a pointer happened to be stored in — it cares that the edge exists.
       */
      const deeper: Array<{ record: RawRecord; relation: CausalGraphEdge['relation']; layer: CausalNode['layer']; id: string; title: string; detail?: string }> = []

      for (const pointer of item.pointers) {
        const key = `${pointer.sourceSessionId}@${pointer.seq}`

        for (const record of factsByPointer.get(key) ?? []) {
          const text = String(record.text ?? '')
          deeper.push({ record, relation: 'evidence', layer: 'fact', id: `fact:${text.slice(0, 40)}`, title: text.slice(0, 120) })
        }
        for (const record of experiencesByCause.get(key) ?? []) {
          const text = String(record.text ?? '')
          const action = typeof record.action === 'string' ? record.action : ''
          deeper.push({
            record,
            relation: 'cause',
            layer: 'experience',
            id: `experience:${text.slice(0, 40)}`,
            title: text.slice(0, 120),
            ...(action.length === 0 ? {} : { detail: action }),
          })
        }
        for (const record of negativesByEvidence.get(key) ?? []) {
          const symptom = String(record.symptom ?? '')
          deeper.push({
            record,
            relation: 'blocker',
            layer: 'negative',
            id: `negative:${symptom.slice(0, 40)}`,
            title: symptom,
            ...(typeof record.cause === 'string' ? { detail: record.cause } : {}),
          })
        }
      }

      if (deeper.length === 0) continue

      const accepted = deeper.slice(0, limitPerHop)
      if (deeper.length > accepted.length) {
        warnings.push(`节点 ${item.fromId} 在第 ${item.depth} 层有 ${deeper.length} 个后继，只展开了前 ${accepted.length} 个`)
      }

      depthReached = Math.max(depthReached, item.depth)

      for (const entry of accepted) {
        /**
         * THE DEEPER NODE'S OWN POINTERS ARE COLLECTED FIRST — before `push`, because a node already
         * visited still has edges worth recording even when it is not expanded twice.
         */
        const ownPointers: Array<{ sourceSessionId: string; seq: number }> = []
        if (Array.isArray(entry.record.evidence)) {
          for (const ref of entry.record.evidence) {
            const pointer = pointerOf(ref)
            if (pointer !== undefined) ownPointers.push(pointer)
          }
        }
        for (const field of ['cause', 'effect'] as const) {
          const pointer = pointerOf(entry.record[field])
          if (pointer !== undefined) ownPointers.push(pointer)
        }

        const added = push({
          layer: entry.layer,
          id: entry.id,
          title: entry.title,
          relation: entry.relation,
          ...(entry.detail === undefined ? {} : { detail: entry.detail }),
          ...(ownPointers.length === 0 ? {} : { pointer: ownPointers[0] }),
          depth: item.depth,
          via: item.fromId,
        })
        edges.push({ from: item.fromId, to: entry.id, relation: entry.relation })
        if (!added) continue
        /**
         * A deeper node's OWN pointers are what the next hop follows — this is the recursion.
         *
         * TRUNCATION IS RECORDED AT THE MOMENT IT HAPPENS, not inferred afterwards from the node
         * depths. The first version tried to reconstruct it at the end by collecting nodes whose depth
         * equalled `maxDepth`, which reported zero for a graph that HAD been cut — because a node that
         * was never expanded is, by definition, not in `nodes` to be found. The honest place to notice
         * "I stopped here" is the branch that stops.
         */
        if (ownPointers.length === 0) continue
        if (item.depth + 1 > maxDepth) {
          if (!truncatedAt.includes(entry.id)) truncatedAt.push(entry.id)
          continue
        }
        next.push({ fromId: entry.id, pointers: ownPointers, depth: item.depth + 1 })
      }
    }
    if (next.length === 0) break
    frontier = next
  }

  /**
   * TRUNCATION IS REPORTED, NOT ASSUMED SILENT. A consumer must be able to tell "the graph ends here"
   * from "I stopped looking", because the first is a fact about the memory and the second is a fact
   * about this call's parameters.
   *
   * `truncatedAt` was filled at the branch that stopped (see the hop loop); this only turns it into a
   * sentence, so the warning and the list cannot disagree.
   */
  if (truncatedAt.length > 0) {
    warnings.push(`已达深度上限 ${maxDepth}：${truncatedAt.length} 个节点没有再向下展开（这是本函数的参数，不是记忆的边界）`)
  }
  if (nodes.length >= maxNodes) {
    warnings.push(`已达节点上限 ${maxNodes}：图被截断，更深的关系没有进入结果`)
  }

  return { target, nodes, edges, depthReached, truncatedAt, warnings }
}

/** A one-line summary of the graph, so a scheduler can log it without dumping every node. */
export function describeCausalGraph(graph: CausalGraph): string {
  const byDepth = new Map<number, number>()
  for (const node of graph.nodes) byDepth.set(node.depth, (byDepth.get(node.depth) ?? 0) + 1)
  const levels = [...byDepth.entries()].sort((a, b) => a[0] - b[0]).map(([depth, count]) => `L${depth}:${count}`).join(' ')
  return (
    `因果图「${graph.target}」：${graph.nodes.length} 节点 / ${graph.edges.length} 边 / ` +
    `深度 ${graph.depthReached}${levels.length === 0 ? '' : `（${levels}）`}` +
    `${graph.warnings.length === 0 ? '' : `（${graph.warnings.length} 条警告）`}`
  )
}
