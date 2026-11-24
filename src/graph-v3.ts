/**
 * ── THE v3 FIELD SURFACE OF THE TASK GRAPH (B2-T1) ──────────────────────────────────────────────
 *
 * WHY THIS FILE EXISTS, MEASURED RATHER THAN PREFERRED.
 *
 * The first version of B2-T1 put the types and the twelve normalisers straight into `graph.ts` and
 * took it from 681 lines to 1,351. That file is governed by `test/v205-module-size-cap.test.mjs`: every
 * scanned module must be ≤ 800 lines, a registered ceiling may only go DOWN, and `ceiling` must equal
 * the measured value. So "just raise the ceiling" was not available, and it should not have been —
 * the ceiling exists because a file nobody can read is a file nobody reviews.
 *
 * The split is along a real seam, not a line count. `graph.ts` owns the GRAPH (nodes, edges, cycles,
 * the goal lock, history). This module owns ONE THING: how a v3 field is judged on the way in and on
 * the way out. Read and write both call into it, so the two directions cannot disagree about what a
 * valid value is — which is the property that matters, and the reason these functions are together.
 *
 * ── THE GOVERNING RULE OF EVERY FUNCTION HERE ───────────────────────────────────────────────────
 *
 * VALIDATE, DO NOT COERCE. A probability outside 0..1, a complexity of 7, an `author` without
 * `attempt`: each of those means the writer meant something this build does not understand. Coercing
 * it (clamp to 1, round to 5, default attempt to 1) turns "we do not know what this is" into "we
 * decided what this is", and the wrong value then reads back as if it were the author's intent.
 *
 * Returning `undefined` is the honest answer, and the CALLER decides what it means: on the read side
 * an unparseable field is dropped (a hand-edited file must not make the graph unreadable); on the
 * write side it is a REFUSAL (a caller that sent a field must not be told "ok" when the field did not
 * survive). That difference is the caller's business, which is why it is not decided here.
 */

/**
 * ── WHO DID THIS ────────────────────────────────────────────────────────────────────────────────
 *
 * Five fields, five different questions. Dropping any one leaves a question unanswerable:
 *
 *   kind        what sort of actor (human / model / subagent / observer / system)
 *   sessionId   WHICH one — the only value that resolves to a log
 *   generation  which generation of the chain (the premise of every cross-generation lookup)
 *   attempt     which TRY inside that session
 *   agentName   the name inside a team
 *   role        what part it played (an executor's judgement and an auditor's ruling must not be
 *               weighed the same way)
 *
 * ── WHY `attempt` EXISTS, IN ONE MEASURED LINE ──────────────────────────────────────────────────
 *
 * Six consecutive CI failures in this project happened inside ONE `sessionId`. "The diagnosis at CI
 * failure 3" and "the diagnosis at CI failure 5" are the same session and different attempts. Without
 * `attempt`, `sessionId` cannot tell them apart — and a pointer that cannot tell them apart sends the
 * next reader to the wrong paragraph.
 *
 * ── WHY `subagent` AND `observer` ARE NOT `model` ───────────────────────────────────────────────
 *
 * A subagent's output is DELEGATED WORK; an observer's is REVIEW. Folding both into "model" erases
 * the collaboration structure exactly where it matters: when a later reader asks "who decided this?",
 * "a subagent I asked to investigate" and "the reviewer that overruled me" must not read the same.
 */
/**
 * ── NO RE-EXPORT OF `graph-goal-lock` (breaks the truth cycle `graph-goal-lock ⇄ graph-v3`) ──────
 *
 * This block used to be `export { GOAL_DESTINATION_FIELDS, …, goalLockVerdict } from
 * './graph-goal-lock.js'` — fourteen names forwarded verbatim, `GOAL_DESTINATION_FIELDS` included.
 *
 * It was a **forwarding edge with no consumer of its own**: every symbol already lives in
 * `graph-goal-lock.ts`, and the one module that used them (`graph.ts`) now imports from there
 * directly. Meanwhile `graph-goal-lock → graph-v3` is a real value edge (`asPersistentConstraints`,
 * a field parser that belongs in the field module). Forwarding + that edge closed a genuine
 * runtime cycle, which `check-cycles` reported — correctly, once its type-only detection was fixed.
 *
 * **Nothing was demoted to `import type`.** Removing a forwarding re-export changes no runtime
 * behaviour: the functions were never defined here and never called through this path.
 *
 * If a consumer genuinely needs these, import them from `./graph-goal-lock.js` — the module that
 * owns them — rather than restoring this trampoline.
 */

/** AUTHOR AND THE v3 FIELD SHAPES ─────────────────────────────────────────────────────────────── */
export interface Author {
  kind: 'user' | 'model' | 'subagent' | 'observer' | 'system'
  sessionId: string
  generation: number
  /** 1 = first try. Distinguishes retries WITHIN one session. Required — see the note above. */
  attempt: number
  agentName?: string
  role?: 'planner' | 'executor' | 'auditor' | 'reviewer'
  at: string
}

/**
 * ── WHERE TO FIND THE THING (user ruling 1) ─────────────────────────────────────────────────────
 *
 * Not a description of the thing — a POINTER to it. The ask was: "let a new session know WHICH
 * GENERATION's log to go back and read when it wants to find something".
 *
 * Why the new session does not simply search: 227 logs, ~6,000 user messages. A full sweep costs a
 * context window. This index is the map left by someone who already paid for the search.
 *
 * ── WHY BOTH `seq` AND `search` ─────────────────────────────────────────────────────────────────
 *
 * `seq` is exact but brittle: it holds only while the source log's numbering does. `search` is fuzzy
 * but robust. Give both and let the reader pick — the direct application of ㉒ (an exact mismatch
 * fails cheaply and loudly; a fuzzy match fails expensively and quietly). A pointer with neither is
 * refused at the writer, because it would name nothing at all.
 */
export interface LogPointer {
  /** What you are looking for, in words that appear in the log. */
  topic: string
  generation: number
  sessionId: string
  /** Exact event number; usable with `graft_read_result(sourceSessionId, seq)`. */
  seq?: number
  /** Alternative to `seq`: a phrase that appears in the log. */
  search?: string
  what: string
}

/**
 * A constraint that belongs to ONE NODE and expires with it (user ruling 5).
 *
 * RETIRED, NOT DELETED. Deleting would let the next generation see a node that never had constraints;
 * keeping `retiredAt` leaves the history readable while keeping the rule OUT of the prompt.
 */
export interface EphemeralConstraint {
  id: string
  text: string
  by: Author
  /** `node` (default) expires with the node; `session` is not carried across a slice. */
  scope?: 'node' | 'session'
  retiredAt?: string
  retiredWhy?: string
}

/**
 * A project-level constraint that outlives every node (user ruling 5).
 *
 * Its lifecycle is the point: "do not publish before B0 closes" is not a permanent truth, it is a
 * constraint whose job ends. `retiredAt` records when that happened, so a later reader can tell
 * "this was lifted" from "this was never declared".
 */
export interface PersistentConstraint {
  id: string
  text: string
  by: Author
  effectiveFrom: string
  /** Absent = still in force. Present = it did its job and was lifted. */
  retiredAt?: string
  retiredWhy?: string
  /** How it may be lifted (e.g. "the publish half needs an explicit user ruling before phase 3"). */
  note?: string
}

export interface Alternative {
  option: string
  rationale: string
  verdict: 'chosen' | 'rejected' | 'deferred'
  why?: string
  /**
   * Predicted probability 0..1.
   *
   * REQUIRED only when the branch was `rejected`/`deferred`, or when `verdictChanged` is true: those
   * are the cases where a prediction was made and then contradicted by reality, so it carries
   * calibration value. A `chosen` branch that went as expected is not filled in — "as expected"
   * contains no information, and requiring it would produce numbers nobody means.
   */
  expectedP?: number
  actualP?: number
  /** This branch was taken, then abandoned. Setting it makes expectedP/actualP required. */
  verdictChanged?: boolean
}

export interface PrunedDirection {
  direction: string
  why: string
  at: string
  by: Author
}

export interface Subgoal {
  id: string
  text: string
  done: boolean
  verifiedBy?: string
}

export interface ComplexityBlock {
  complexity: 1 | 2 | 3 | 4 | 5
  note?: string
  closedAt?: string
}

/** The v3 fields of one node, exactly as this build understands them. */
export interface NodeV3Fields {
  origin?: { kind: 'planned' | 'inserted'; reason: string; by: Author }
  lastChange?: { by: Author; revision: number }
  objective?: string
  subgoals?: Subgoal[]
  alternatives?: Alternative[]
  pruned?: PrunedDirection[]
  estimate?: ComplexityBlock
  actual?: ComplexityBlock
  progress?: number
  /** G-9: the work was produced — NOT the same claim as `status: 'done'`. */
  executionStatus?: ExecutionStatus
  /** G-9: nobody has accepted it until an evidence-carrying call says so. */
  acceptanceStatus?: AcceptanceStatus
  standing?: string
  evidence?: string[]
  logPointers?: LogPointer[]
  ephemeralConstraints?: EphemeralConstraint[]
}

/**
 * Every key this build recognises on a node. Used for the OPPOSITE of a whitelist: `asNode` checks it
 * to decide which keys it must CARRY THROUGH UNTOUCHED rather than rebuild. Keeping it here, beside
 * the types, is what stops "added a field" and "forgot to teach the reader about it" from drifting
 * apart — they are the same file.
 */
export const KNOWN_NODE_KEYS: ReadonlySet<string> = new Set([
  'id', 'title', 'nodeType', 'node_type', 'type', 'requirements', 'status',
  'dependsOn', 'depends_on', 'knowledgePointers', 'knowledge_pointers', 'fixed',
  'harvestedAt', 'createdAt', 'updatedAt',
  'origin', 'lastChange', 'objective', 'subgoals', 'alternatives', 'pruned',
  'estimate', 'actual', 'progress', 'standing', 'evidence', 'logPointers', 'ephemeralConstraints',
])

const ATTEMPTS_MUST_BE_STATED = 'attempt 缺失不是"第一次"，是"没说"—— 补默认值会让重试读成一次'

/**
 * Resolve an author, or `undefined` when it cannot be resolved.
 *
 * `attempt` is NOT defaulted, and that is the whole point: filling a missing `attempt` with 1 converts
 * "the writer did not say which try this was" into "this was the first try" — a fact nobody
 * established (see `ATTEMPTS_MUST_BE_STATED`). The same reasoning applies to the enums: an unknown
 * `kind` is not coerced to `model`, because "some actor we do not recognise" and "the model" are
 * different claims.
 */
export function asAuthor(raw: unknown, now: () => string): Author | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const kind = r.kind
  if (kind !== 'user' && kind !== 'model' && kind !== 'subagent' && kind !== 'observer' && kind !== 'system') {
    return undefined
  }
  if (typeof r.sessionId !== 'string' || r.sessionId.trim() === '') return undefined
  if (typeof r.generation !== 'number' || !Number.isInteger(r.generation) || r.generation < 0) return undefined
  if (typeof r.attempt !== 'number' || !Number.isInteger(r.attempt) || r.attempt < 1) return undefined
  return {
    kind,
    sessionId: r.sessionId,
    generation: r.generation,
    attempt: r.attempt,
    ...(typeof r.agentName === 'string' && r.agentName.length > 0 ? { agentName: r.agentName } : {}),
    ...(r.role === 'planner' || r.role === 'executor' || r.role === 'auditor' || r.role === 'reviewer'
      ? { role: r.role }
      : {}),
    at: typeof r.at === 'string' && r.at.length > 0 ? r.at : now(),
  }
}

/** The reason string a caller shows when `asAuthor` returned nothing. One sentence, one place. */
export const AUTHOR_REQUIRED_HINT =
  'by 需要一个 Author：{ kind, sessionId, generation, attempt, at }。' + ATTEMPTS_MUST_BE_STATED + '。'

/** 0..1, or undefined. A probability outside the range is a data error, not a clamp target. */
function asProbability(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined
}

/** 1..5 integer, or undefined. Not clamped: an out-of-range value means the writer meant something else. */
function asComplexity(value: unknown): 1 | 2 | 3 | 4 | 5 | undefined {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 ? value : undefined
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const list = (value: unknown, max: number): string[] => {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const out: string[] = []
  for (const item of raw) {
    const entry = typeof item === 'string' ? item.replace(/\s+/gu, ' ').trim() : ''
    if (entry.length === 0 || out.includes(entry)) continue
    out.push(entry)
    if (out.length >= max) break
  }
  return out
}

export function asComplexityBlock(raw: unknown, withClosedAt: boolean): ComplexityBlock | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const complexity = asComplexity(r.complexity)
  if (complexity === undefined) return undefined
  return {
    complexity,
    ...(text(r.note).length > 0 ? { note: text(r.note) } : {}),
    ...(withClosedAt && text(r.closedAt).length > 0 ? { closedAt: text(r.closedAt) } : {}),
  }
}

export function asSubgoals(raw: unknown): Subgoal[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: Subgoal[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const id = text(r.id).toLowerCase()
    const label = text(r.text)
    if (id === '' || label === '') continue
    out.push({
      id,
      text: label,
      done: r.done === true,
      ...(text(r.verifiedBy).length > 0 ? { verifiedBy: text(r.verifiedBy) } : {}),
    })
    if (out.length >= 32) break
  }
  return out.length === 0 ? undefined : out
}

export function asLogPointers(raw: unknown): LogPointer[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: LogPointer[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const topic = text(r.topic)
    const sessionId = text(r.sessionId)
    const what = text(r.what)
    if (topic === '' || sessionId === '' || what === '') continue
    if (typeof r.generation !== 'number' || !Number.isInteger(r.generation) || r.generation < 0) continue
    const seq = typeof r.seq === 'number' && Number.isInteger(r.seq) && r.seq >= 0 ? r.seq : undefined
    const search = text(r.search)
    /**
     * A pointer with neither address names nothing. Keeping it would produce a row a reader cannot
     * follow, which is worse than the row being visibly absent: an index that silently stops working
     * is indistinguishable from an index that had nothing to say.
     */
    if (seq === undefined && search === '') continue
    out.push({
      topic,
      generation: r.generation,
      sessionId,
      ...(seq === undefined ? {} : { seq }),
      ...(search === '' ? {} : { search }),
      what,
    })
    if (out.length >= 64) break
  }
  return out.length === 0 ? undefined : out
}

export function asAlternatives(raw: unknown): Alternative[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: Alternative[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const option = text(r.option)
    const verdict = r.verdict
    if (option === '' || (verdict !== 'chosen' && verdict !== 'rejected' && verdict !== 'deferred')) continue
    const expectedP = asProbability(r.expectedP)
    const actualP = asProbability(r.actualP)
    out.push({
      option,
      rationale: text(r.rationale),
      verdict,
      ...(text(r.why).length > 0 ? { why: text(r.why) } : {}),
      ...(expectedP === undefined ? {} : { expectedP }),
      ...(actualP === undefined ? {} : { actualP }),
      ...(r.verdictChanged === true ? { verdictChanged: true } : {}),
    })
    if (out.length >= 32) break
  }
  return out.length === 0 ? undefined : out
}

export function asPruned(raw: unknown, now: () => string): PrunedDirection[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: PrunedDirection[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const direction = text(r.direction)
    const why = text(r.why)
    const by = asAuthor(r.by, now)
    if (direction === '' || why === '' || by === undefined) continue
    out.push({ direction, why, at: text(r.at).length > 0 ? text(r.at) : now(), by })
    if (out.length >= 32) break
  }
  return out.length === 0 ? undefined : out
}

export function asEphemeral(raw: unknown, now: () => string): EphemeralConstraint[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: EphemeralConstraint[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const id = text(r.id).toLowerCase()
    const body = text(r.text)
    const by = asAuthor(r.by, now)
    if (id === '' || body === '' || by === undefined) continue
    const scope = r.scope === 'session' ? 'session' : r.scope === 'node' ? 'node' : undefined
    out.push({
      id,
      text: body,
      by,
      ...(scope === undefined ? {} : { scope }),
      ...(text(r.retiredAt).length > 0 ? { retiredAt: text(r.retiredAt) } : {}),
      ...(text(r.retiredWhy).length > 0 ? { retiredWhy: text(r.retiredWhy) } : {}),
    })
    if (out.length >= 64) break
  }
  return out.length === 0 ? undefined : out
}

export function asPersistentConstraints(raw: unknown, now: () => string): PersistentConstraint[] {
  if (!Array.isArray(raw)) return []
  const out: PersistentConstraint[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const id = text(r.id).toLowerCase()
    const body = text(r.text)
    const by = asAuthor(r.by, now)
    if (id === '' || body === '' || by === undefined) continue
    out.push({
      id,
      text: body,
      by,
      effectiveFrom: text(r.effectiveFrom).length > 0 ? text(r.effectiveFrom) : by.at,
      ...(text(r.retiredAt).length > 0 ? { retiredAt: text(r.retiredAt) } : {}),
      ...(text(r.retiredWhy).length > 0 ? { retiredWhy: text(r.retiredWhy) } : {}),
      ...(text(r.note).length > 0 ? { note: text(r.note) } : {}),
    })
    if (out.length >= 128) break
  }
  return out
}

export function asEvidence(raw: unknown): string[] | undefined {
  const items = list(raw, 32)
  return items.length === 0 ? undefined : items
}

/** 0..100 integer, or undefined. Out of range is a data error, not a clamp target. */
export function asProgress(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 100 ? raw : undefined
}

/**
 * ── G-9 (MEMORY-04): DID THE WORK EXIST, AND WAS IT ACCEPTED? ────────────────────────────────────
 *
 * `status: 'done'` answers 「no longer in flight」. It does NOT answer 「the work was produced」 or
 * 「somebody accepted it」, and treating one as all three is how a model's self-declared 「做完了」 became
 * finished work with no evidence (measured: `acceptance` had ZERO occurrences in `src/`).
 *
 * The vocabulary is closed on purpose: an unlisted value reads back as `undefined` rather than being
 * carried as free text, so a typo becomes 「unknown」 instead of a fifth state nobody checks.
 */
export type ExecutionStatus = 'produced' | 'failed' | 'not-started'
export type AcceptanceStatus = 'pending' | 'accepted' | 'rejected'

export function asExecutionStatus(raw: unknown): ExecutionStatus | undefined {
  return raw === 'produced' || raw === 'failed' || raw === 'not-started' ? raw : undefined
}

export function asAcceptanceStatus(raw: unknown): AcceptanceStatus | undefined {
  return raw === 'pending' || raw === 'accepted' || raw === 'rejected' ? raw : undefined
}

export function asOrigin(raw: unknown, now: () => string): NodeV3Fields['origin'] | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const kind = r.kind === 'planned' || r.kind === 'inserted' ? r.kind : undefined
  const reason = text(r.reason)
  const by = asAuthor(r.by, now)
  if (kind === undefined || reason === '' || by === undefined) return undefined
  return { kind, reason, by }
}

/**
 * ── `harvestedAt` IS A TIMESTAMP, AND AN UNPARSEABLE ONE MUST NOT COUNT ────────────────────────
 *
 * `harvestedAt` answers exactly one question — "did this finished phase record what it learned?" — and
 * the pre-step reminder, the `complete` receipt and the `unharvested` statistic all read it as a
 * BOOLEAN (non-empty means "answered"). The file is a plain JSON document that an external writer, a
 * hand edit, or a half-finished migration can touch. Before this check any non-empty string counted,
 * so `harvestedAt: "yes"` — or a stale `"pending"` — would silently silence the reminder FOREVER for
 * that node, and nothing would report it.
 *
 * THE DIRECTION OF THE FAILURE MATTERS. Treating a bad value as `''` means "not harvested yet", so the
 * worst outcome is ONE reminder too many rather than a phase whose lesson is silently lost — the same
 * asymmetry the rest of this store uses for unreadable ledgers (fail toward asking again).
 *
 * The accepted form is a full ISO-8601 instant, which is what `new Date().toISOString()` produces: the
 * only thing this plugin ever writes. A date without a time (`2026-11-08`) is refused on purpose — it
 * parses, but it cannot order two harvests from the same day, and every consumer compares instants.
 */
export function asHarvestedAt(value: unknown): string {
  if (typeof value !== 'string') return ''
  const stamp = value.trim()
  if (stamp.length === 0) return ''
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(stamp)) return ''
  return Number.isFinite(Date.parse(stamp)) ? stamp : ''
}

export function asLastChange(raw: unknown, now: () => string): NodeV3Fields['lastChange'] | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const by = asAuthor(r.by, now)
  if (by === undefined) return undefined
  const revision = typeof r.revision === 'number' && Number.isInteger(r.revision) && r.revision >= 0 ? r.revision : 0
  return { by, revision }
}

/**
 * ── ONE CALL THAT RESOLVES ALL TWELVE v3 FIELDS ────────────────────────────────────────────────
 *
 * `asNode` used to spell out twelve `...optional(...)` spreads inline, which is 12 lines of the same
 * shape and — more importantly — the place where a new field gets forgotten. This function is the ONE
 * table: add a field here and both the reader and the writer learn about it at once, because both go
 * through `asNode`.
 *
 * It deliberately returns only the fields that RESOLVED. `undefined` is not a value a caller should
 * have to strip, and an object with a dozen `undefined` keys written to JSON is noise in the store.
 */
export function resolveNodeV3(record: Record<string, unknown>, now: () => string): NodeV3Fields {
  const origin = asOrigin(record.origin, now)
  const lastChange = asLastChange(record.lastChange, now)
  const objective = text(record.objective)
  const subgoals = asSubgoals(record.subgoals)
  const alternatives = asAlternatives(record.alternatives)
  const pruned = asPruned(record.pruned, now)
  const estimate = asComplexityBlock(record.estimate, false)
  const actual = asComplexityBlock(record.actual, true)
  const progress = asProgress(record.progress)
  /**
   * ── G-9 (MEMORY-04): THE TWO AXES, READ BACK ────────────────────────────────────────────────────
   *
   * 「produced」 and 「accepted」 are different claims, and a phase that was merely produced is not
   * finished work. These are read through the same whitelist as every other v3 field — a field that is
   * written but not listed here is silently dropped on the next read, which is the 「生产者多产出、
   * 投递时少给」 shape this batch keeps removing.
   */
  const executionStatus = asExecutionStatus(record.executionStatus)
  const acceptanceStatus = asAcceptanceStatus(record.acceptanceStatus)
  const standing = text(record.standing)
  const evidence = asEvidence(record.evidence)
  const logPointers = asLogPointers(record.logPointers)
  const ephemeralConstraints = asEphemeral(record.ephemeralConstraints, now)
  return {
    ...(origin === undefined ? {} : { origin }),
    ...(lastChange === undefined ? {} : { lastChange }),
    ...(objective.length === 0 ? {} : { objective }),
    ...(subgoals === undefined ? {} : { subgoals }),
    ...(alternatives === undefined ? {} : { alternatives }),
    ...(pruned === undefined ? {} : { pruned }),
    ...(estimate === undefined ? {} : { estimate }),
    ...(actual === undefined ? {} : { actual }),
    ...(progress === undefined ? {} : { progress }),
    ...(executionStatus === undefined ? {} : { executionStatus }),
    ...(acceptanceStatus === undefined ? {} : { acceptanceStatus }),
    ...(standing.length === 0 ? {} : { standing }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(logPointers === undefined ? {} : { logPointers }),
    ...(ephemeralConstraints === undefined ? {} : { ephemeralConstraints }),
  }
}

/**
 * ── WHICH SUPPLIED FIELDS DID NOT SURVIVE (B2-T1, write side) ──────────────────────────────────
 *
 * Applied on the READ side, dropping a malformed field is correct: a hand-edited file must not make
 * the graph unreadable. Applied on the WRITE side it is the "quietly dropped" failure — the caller
 * believes it wrote a pointer, the store holds nothing, and no error is anywhere.
 *
 * So the writer asks this question after normalising: "of the fields I was GIVEN, which produced
 * nothing?" An empty field (`[]`) counts as nothing, because a caller that sends a list and gets an
 * empty list back has been told the list was acceptable.
 */
export function vanishedFields(supplied: Record<string, unknown>, resolved: NodeV3Fields): string[] {
  const table: Array<[string, unknown]> = [
    ['origin', resolved.origin],
    ['objective', resolved.objective],
    ['subgoals', resolved.subgoals],
    ['alternatives', resolved.alternatives],
    ['pruned', resolved.pruned],
    ['estimate', resolved.estimate],
    ['actual', resolved.actual],
    ['progress', resolved.progress],
    ['standing', resolved.standing],
    ['evidence', resolved.evidence],
    ['logPointers', resolved.logPointers],
    ['ephemeralConstraints', resolved.ephemeralConstraints],
  ]
  return table
    .filter(([key, value]) => supplied[key] !== undefined)
    .filter(([, value]) => value === undefined || (Array.isArray(value) && value.length === 0))
    .map(([key]) => key)
}

/** The sentence a caller gets when a supplied field vanished. One wording, one place. */
export const VANISHED_FIELDS_HINT =
  '这些字段给了但无法通过校验（形状不对，或必填项缺失）。读写两侧用的是同一个归一化函数 —— ' +
  '它允许修剪与纠正，不允许让一个参数凭空消失。检查 logPointers（需要 topic/sessionId/what/generation，' +
  '且 seq 与 search 至少一个）、alternatives（verdict 三值、概率 0..1）、estimate/actual（complexity 1..5）。'

/**
 * ── KEYS KEPT THROUGH, AND KEYS REPORTED ───────────────────────────────────────────────────────
 *
 * A rebuild-from-whitelist reader plus a whole-document writer is a data shredder: read the file, keep
 * the keys you recognise, write the object back — and every key you did not recognise is gone, with no
 * error anywhere. Measured 2026-11-17 on the live store: 18 nodes present, but the file held only the
 * eleven v1 keys, and the 8 `persistentConstraints` were already gone.
 *
 * So unknown keys are carried through as-is, AND reported. The two halves are one mechanism: "kept
 * quietly" and "dropped quietly" are the same failure with opposite signs, and both leave the next
 * reader unable to tell what happened. A warning rather than a refusal, because refusing to read a
 * graph over one extra key breaks the repair path — the tool needed to fix the file could not read it.
 */
export function carryUnknownKeys<T extends object>(target: T, raw: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(raw)) {
    if (KNOWN_NODE_KEYS.has(key) || value === undefined) continue
    ;(target as Record<string, unknown>)[key] = value
  }
  return target
}

/** Node keys this build does not recognise. */
export function unknownNodeKeys(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object') return []
  return Object.keys(raw as Record<string, unknown>).filter((key) => !KNOWN_NODE_KEYS.has(key))
}

/**
 * Apply a v3 patch onto a node: returns the fields to merge and the names that actually changed.
 *
 * ── WHY THIS IS A FUNCTION AND NOT A LOOP AT THE CALL SITE ─────────────────────────────────────
 *
 * The `update` branch in `graph.ts` has to do three things per field — normalise, refuse if a supplied
 * field vanished, and record the name only when the value really moved. Written inline that is twelve
 * near-identical blocks, which is where a new field gets forgotten in two of the three. Here it is one
 * table, and the "record only what moved" comparison is the same `JSON.stringify` for every field.
 */
export function applyV3Patch(
  patch: Record<string, unknown>,
  current: Record<string, unknown>,
  now: () => string,
): { ok: true; fields: Record<string, unknown>; changed: string[] } | { ok: false; reason: string } {
  const resolved = resolveNodeV3(patch, now)
  const missing = vanishedFields(patch, resolved)
  if (missing.length > 0) return { ok: false, reason: `${VANISHED_FIELDS_HINT}（涉及 ${missing.join(', ')}）` }
  const changed: string[] = []
  for (const [key, value] of Object.entries(resolved)) {
    if (JSON.stringify(value) === JSON.stringify(current[key])) continue
    changed.push(key)
  }
  return { ok: true, fields: resolved as Record<string, unknown>, changed }
}

/** The v3 field names, so a spread can be limited to them (see the `add` branch in `graph.ts`). */
export const V3_NODE_KEYS = [
  'origin', 'lastChange', 'objective', 'subgoals', 'alternatives', 'pruned',
  'estimate', 'actual', 'progress', 'standing', 'evidence', 'logPointers', 'ephemeralConstraints',
] as const

/**
 * Copy ONLY the v3 fields out of a caller's `node` payload.
 *
 * Spreading the whole object is the tempting version and it is wrong: the tool layer forwards
 * `id: undefined` for a caller that named the node in `nodeId`, so a wholesale spread overwrites
 * `id: targetId` with `undefined` and the node is refused for having an illegal id — a refusal about
 * the wrong thing, which then reads like a bug in the id parser.
 */
export function pickV3(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of V3_NODE_KEYS) {
    const value = payload?.[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

/** Present in the input ⇒ replace the list. Absent ⇒ carry the existing list through untouched. */
export function mergePersistentConstraints(
  current: PersistentConstraint[],
  supplied: unknown,
  now: () => string,
): { ok: true; list: PersistentConstraint[] } | { ok: false; reason: string } {
  if (supplied === undefined) return { ok: true, list: current }
  const list = asPersistentConstraints(supplied, now)
  const given = Array.isArray(supplied) ? supplied.length : 0
  if (given > 0 && list.length === 0) {
    return {
      ok: false,
      reason:
        'persistentConstraints 给了但一条都没通过校验：每一条都需要 id / text / by' +
        '（by 需要 kind/sessionId/generation/attempt）。',
    }
  }
  return { ok: true, list }
}

/**
 * The warning buffer a read accumulates, drained by the caller.
 *
 * A read-only function that logs has a side effect; one that refuses breaks the repair path. So the
 * reader RETURNS its graph and leaves its findings here, and the caller decides whether to show them.
 * Draining empties the list, so a caller reports "once per read" rather than once per node.
 */
const readGraphWarnings: string[] = []

export function drainGraphWarnings(): string[] {
  return readGraphWarnings.splice(0, readGraphWarnings.length)
}

export function noteGraphWarning(message: string): void {
  readGraphWarnings.push(message)
}

/**
 * The warning sentence for keys that were kept but not understood, or `undefined` when there are none.
 *
 * One sentence for the whole read rather than one per node: a graph with 40 nodes and one typo would
 * otherwise produce forty identical lines, and a warning nobody reads is not a warning.
 */
export function unknownKeyWarning(nodes: readonly unknown[], top: Record<string, unknown>): string | undefined {
  const nodeKeys = new Set<string>()
  for (const raw of nodes) for (const key of unknownNodeKeys(raw)) nodeKeys.add(key)
  const topKeys = Object.keys(top).filter((key) => !KNOWN_GRAPH_KEYS.has(key))
  if (nodeKeys.size === 0 && topKeys.length === 0) return undefined
  return (
    'graph: 保留了本版本不认识的字段（既不丢弃也不解释）—— ' +
    [
      nodeKeys.size > 0 ? `节点级 ${[...nodeKeys].sort().join(', ')}` : '',
      topKeys.length > 0 ? `图级 ${topKeys.sort().join(', ')}` : '',
    ]
      .filter((part) => part.length > 0)
      .join('；') +
    '。它们可能是更新版本写的字段（保留是对的），也可能是手改的错字（该被发现）。'
  )
}

/** Top-level graph keys this build understands; anything else is preserved and reported. */
const KNOWN_GRAPH_KEYS: ReadonlySet<string> = new Set([
  'version', 'id', 'goal', 'goalLockedAt', 'persistentConstraints', 'nodes', 'history', 'createdAt', 'updatedAt',
])
