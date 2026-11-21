/**
 * GLOBAL KNOWLEDGE BASE — the layer that stops every workspace being an island.
 *
 * ── THE PROBLEM THIS EXISTS FOR ────────────────────────────────────────────────────────────────
 *
 * `workspace.ts` gates retrieval by the cwd that PRODUCED a memory, and that gate is correct: a
 * constraint from project A injected into project B is a wrong action waiting to happen. But it
 * answers only "was this produced here". It cannot answer "have I solved this before, anywhere" —
 * which is the question a persistent layer is FOR. Measured cost of the old behaviour: the same
 * SQLite WAL deadlock was diagnosed and written down in three consecutive workspaces, each one
 * unable to see the other two records.
 *
 * ── WHAT IS DIFFERENT HERE, AND WHAT IS NOT ────────────────────────────────────────────────────
 *
 * This is NOT a second copy of the skill store with the gate switched off. Two things make a
 * memory eligible to live here, and both are explicit:
 *
 *   1. it carries `tags` — the cross-cutting vocabulary ("python", "api", "auth") that is
 *      meaningful outside one repository, and
 *   2. it carries `applicableNodeTypes` — the PHASE it is useful in ("coding", "testing",
 *      "refactoring"). A memory with neither is a locAL fact and stays in its workspace.
 *
 * A query names tags and/or a node type. Matching is by vocabulary, never by cwd, so it works
 * across workspaces by construction. The entry still RECORDS the workspace it came from —
 * provenance is not the gate here, but a reader must be able to go back and ask "where did this
 * come from, is that still how that project works".
 *
 * ── THE REVERSE ANCHOR ────────────────────────────────────────────────────────────────────────
 *
 * A DAG node points AT knowledge (`knowledge_pointers`). That is only half a link: a reader
 * holding a knowledge entry cannot tell whether anyone ever used it. `knowledge-refs.jsonl` is the
 * other half — written when a node anchors an entry — so `referencedBy` answers "which task
 * nodes used this, and when". Append-only, deduplicated on read, because a reference is an
 * observation and rewriting it would destroy the history that makes it useful.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import type { MemoryProvenance } from './extract.js'
import { atomicWrite } from './store.js'
import { withFileLock } from './lock.js'
import { scanThreat } from './threat.js'
import { normalizeWorkspace } from './workspace.js'

/** `~/.dsh/global-knowledge` — deliberately OUTSIDE any profile or workspace directory. */
export function defaultKnowledgeDir(): string {
  return join(homedir(), '.dsh', 'global-knowledge')
}

/**
 * The vocabulary shape. Lowercase latin, digits, and the punctuation that appears in real tags
 * (`c++`, `c#`, `node.js`, `ui-ux`). Deliberately ASCII: a Chinese tag would be a search term
 * masquerading as a category, and the store already has free-text triggers for that.
 *
 * ── TD-M18 (2026-11-18): THE RULE IS NOW ALSO WRITTEN IN WORDS ─────────────────────────────────
 *
 * Measured twice in one session: `declaration-binds-to-measured-artifact` (38 chars) and
 * `state-file-backup-copy-test-apply` (33) were refused with "id must be lowercase latin
 * kebab-case" — a sentence whose rule BOTH ids satisfied. The refusal was true and useless: the
 * caller was told about a rule it had not broken. The two facts this regex knows and the message
 * did not: the total length cap (32) and the four extra characters (`+ # . _`).
 */
const VOCAB = /^[a-z0-9][a-z0-9+#._-]{0,31}$/u

/** The rule, spelled out ONCE so the id refusal and the tag refusal cannot drift apart. */
const VOCAB_RULE = '1-32 chars, first [a-z0-9], rest [a-z0-9+#._-]'

/**
 * Normalise a tag list: lowercase, dedupe, validate, cap.
 *
 * `dropped` (TD-M18) is an OPTIONAL collector: when given, every entry this function throws away
 * is pushed as one readable line naming the entry, its length, and the rule it missed. Two reasons
 * it is a parameter rather than a return value:
 *
 *   1. the old contract is a plain `string[]` and dozens of call sites rely on it;
 *   2. the two callers that must REPORT are the writers; readers (`asEntry`) have no one to tell.
 *
 * Cap overflow is NOT reported here (see the note in the report): it is a different kind of loss —
 * the entries are valid and were simply not kept — and folding the two into one array would make
 * "invalid" and "over quota" indistinguishable to whoever reads it.
 */
export function normalizeVocabList(value: unknown, max = 8, dropped?: string[], overCap?: string[]): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/u) : []
  const out: string[] = []
  const kept = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const tag = item.trim().toLowerCase().replace(/\s+/gu, '-')
    if (!VOCAB.test(tag)) {
      /**
       * A REFUSED TAG IS A DENIED TAG, and the difference matters: an id refusal keeps the entry
       * out of the store (visible), while a tag refusal used to leave the entry in place with the
       * tag quietly gone. `dropped` is how the writer gets to say so.
       */
      dropped?.push(`${tag || '(empty)'} (${tag.length} chars): tag must be ${VOCAB_RULE}`)
      continue
    }
    if (kept.has(tag)) continue
    /**
     * ── W5-6: OVER QUOTA IS REPORTED, AND THE LOOP NO LONGER STOPS AT THE CAP ─────────────────
     *
     * This used to `break` the moment `out.length >= max`, which had two effects: the entry was
     * silently SHORT, and — because nothing counted what came after — nobody could say how short.
     * The second is what made it unfixable from the result: 「4 tags were dropped」 and 「0 tags were
     * dropped」 produced the same output.
     *
     * Now the scan continues over the remaining items and records every VALID tag that did not fit.
     * The cap is unchanged (8) and the kept set is identical — only the silence is gone. The names go
     * into `overCap`, which is a DIFFERENT array from `dropped` on purpose: 「this tag is malformed」
     * and 「this tag is valid but there was no room」 are two different facts and one array would make
     * them indistinguishable.
     */
    if (out.length >= max) {
      overCap?.push(tag)
      continue
    }
    kept.add(tag)
    out.push(tag)
  }
  return out
}

/** Tags and node types share one grammar; the aliases exist because the call sites differ. */
export const normalizeTags = normalizeVocabList
export const normalizeNodeTypes = normalizeVocabList

export interface KnowledgeEntry {
  /** Kebab-case identity; a re-write with the same id MERGES rather than duplicating. */
  id: string
  kind: 'skill' | 'negative'
  title: string
  /** The trigger: when does this apply. Free text. */
  when: string
  /** The procedure or the pitfall, in plain text. Never markup — this file is data. */
  body: string
  tags: string[]
  applicableNodeTypes: string[]
  /** Provenance only. A global entry is NOT restricted to this workspace. */
  workspace: string
  provenance: MemoryProvenance
  confidence: number
  evidence: string[]
  sources: number
  createdAt: string
  updatedAt: string
}

export interface KnowledgeRef {
  knowledgeId: string
  graphId: string
  nodeId: string
  at: string
}

function knowledgePath(dir: string): string {
  return join(dir, 'knowledge.jsonl')
}

function refsPath(dir: string): string {
  return join(dir, 'knowledge-refs.jsonl')
}

function readJsonlLocal<T>(path: string): T[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out: T[] = []
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line)
      // A torn line must not hide the rest of the store — the same rule the ledgers use.
      if (parsed !== null && typeof parsed === 'object') out.push(parsed as T)
    } catch {
      // skip the single corrupt line
    }
  }
  return out
}

/** Coerce one stored row into the current shape, tolerating a hand-edited or older file. */
function asEntry(raw: Record<string, unknown>): KnowledgeEntry | undefined {
  const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : ''
  if (!VOCAB.test(id)) return undefined
  const kind = raw.kind === 'negative' ? 'negative' : 'skill'
  const provenance: MemoryProvenance =
    raw.provenance === 'human' || raw.provenance === 'tool' || raw.provenance === 'inferred' ? raw.provenance : 'inferred'
  return {
    id,
    kind,
    title: typeof raw.title === 'string' ? raw.title : id,
    when: typeof raw.when === 'string' ? raw.when : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    /**
   * ── W5-6: THE READ PATH MUST NOT RE-APPLY A WRITE-TIME CAP ────────────────────────────────────
   *
   * These two calls used the DEFAULT `max = 8`, so a row that legitimately holds 12 tags (a merge is
   * allowed 12) was read back as 8 — the loss happened on the way OUT, long after anyone could report
   * it, and the caller had no field that could have told them. 「Reading」 is not the place for a quota:
   * the quota belongs to what this writer agrees to store, and once a row exists it should be read as
   * it is. A hand-edited file with 40 tags also reads as 40 — which is honest, because it IS 40.
   */
  tags: normalizeVocabList(raw.tags, Number.POSITIVE_INFINITY),
  applicableNodeTypes: normalizeVocabList(
    raw.applicable_node_types ?? raw.applicableNodeTypes ?? raw.nodeTypes,
    Number.POSITIVE_INFINITY,
  ),
    workspace: normalizeWorkspace(raw.workspace),
    provenance,
    confidence: Number.isFinite(Number(raw.confidence)) ? Math.min(1, Math.max(0.2, Number(raw.confidence))) : 1,
    evidence: (Array.isArray(raw.evidence) ? raw.evidence : []).filter((item): item is string => typeof item === 'string'),
    sources: Number.isFinite(Number(raw.sources)) ? Math.max(1, Math.trunc(Number(raw.sources))) : 1,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
  }
}

export function readKnowledge(dir: string): KnowledgeEntry[] {
  const out: KnowledgeEntry[] = []
  for (const raw of readJsonlLocal<Record<string, unknown>>(knowledgePath(dir))) {
    const entry = asEntry(raw)
    if (entry !== undefined) out.push(entry)
  }
  out.sort((left, right) => left.id.localeCompare(right.id))
  return out
}

export function readKnowledgeRefs(dir: string): KnowledgeRef[] {
  const out: KnowledgeRef[] = []
  for (const raw of readJsonlLocal<Record<string, unknown>>(refsPath(dir))) {
    const knowledgeId = typeof raw.knowledgeId === 'string' ? raw.knowledgeId : ''
    const graphId = typeof raw.graphId === 'string' ? raw.graphId : ''
    const nodeId = typeof raw.nodeId === 'string' ? raw.nodeId : ''
    if (knowledgeId.length === 0 || graphId.length === 0 || nodeId.length === 0) continue
    out.push({ knowledgeId, graphId, nodeId, at: typeof raw.at === 'string' ? raw.at : '' })
  }
  return out
}

/** Serialise one entry back to the on-disk field names (`applicable_node_types`, not camelCase). */
function toRow(entry: KnowledgeEntry): Record<string, unknown> {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    when: entry.when,
    body: entry.body,
    tags: entry.tags,
    applicable_node_types: entry.applicableNodeTypes,
    workspace: entry.workspace,
    provenance: entry.provenance,
    confidence: entry.confidence,
    evidence: entry.evidence,
    sources: entry.sources,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

export interface KnowledgeWriteInput {
  id: string
  kind?: 'skill' | 'negative'
  title?: string
  when?: string
  body?: string
  tags?: unknown
  applicableNodeTypes?: unknown
  evidence?: unknown
  provenance?: MemoryProvenance
}

export interface KnowledgeWriteResult {
  written: number
  merged: number
  /** Refused entries with a reason. Never silent: a dropped entry is a memory the user thinks exists. */
  refused: string[]
  /**
   * TD-M18: every tag / node-type this write did NOT keep, as one readable line each.
   *
   * ALWAYS an array (never `undefined`): "nothing was dropped" is a fact the caller can print, and
   * an absent field is indistinguishable from "this build does not report". The entry is still
   * written — the tag is what was denied, not the skill.
   */
  droppedTags: string[]
  /**
   * W5-6: VALID vocabulary this write did NOT keep because of a cap (8 on write, 12 on merge).
   *
   * Separate from `droppedTags` on purpose: that array means 「this tag is malformed」, this one means
   * 「this tag is fine, there was no room」. Folding them together would make the two indistinguishable
   * — the same reason `refused` and `droppedTags` are separate. ALWAYS an array.
   */
  truncatedTags: string[]
  /** The entries as stored (after normalisation), so a caller can report exact ids. */
  entries: KnowledgeEntry[]
}

/**
 * Write (or merge) entries into the global store.
 *
 * MERGE, NOT DUPLICATE: the id is the identity. A second write of the same id unions the tag and
 * node-type vocabularies instead of replacing them — a skill learned in one task and re-learned in
 * another should accumulate the phases it is useful in, not lose the first one.
 *
 * REFUSED WHEN: the id is not kebab-case, or the text trips the injection scan. Both are cheap
 * filters on what gets STORED; neither is the defence against a poisoned entry already on disk
 * (`queryKnowledge` re-scans on read for exactly that reason).
 */
export function writeKnowledge(
  dir: string,
  inputs: readonly KnowledgeWriteInput[],
  options: { at?: string; workspace?: string; sessionId?: string } = {},
): KnowledgeWriteResult {
  const refused: string[] = []
  /** TD-M18: denied vocabularies are REPORTED, not swallowed (see `normalizeVocabList`). */
  const droppedTags: string[] = []
  /**
   * W5-6: VALID vocabulary that did not fit under the cap is reported in its own list. Malformed and
   * over-quota are different facts (one is a refusal, one is a quota) and merging them would leave the
   * reader unable to tell 「fix your tag」 from 「split the entry」.
   */
  const truncatedTags: string[] = []
  const accepted: KnowledgeEntry[] = []
  const at = options.at ?? new Date().toISOString()
  const workspace = normalizeWorkspace(options.workspace)

  for (const input of inputs) {
    const id = typeof input.id === 'string' ? input.id.trim().toLowerCase() : ''
    if (!VOCAB.test(id)) {
      /**
       * THE REAL RULE, and the measured length. The old sentence ("id must be lowercase latin
       * kebab-case") was true about characters and silent about the cap — the only rule the two
       * measured refusals had actually broken. A refusal that describes a different rule makes the
       * next attempt fail the same way.
       */
      refused.push(`${id || '(empty)'} (${id.length} chars): id must be ${VOCAB_RULE}`)
      continue
    }
    const title = typeof input.title === 'string' && input.title.trim().length > 0 ? input.title.trim() : id
    const when = typeof input.when === 'string' ? input.when.trim() : ''
    const body = typeof input.body === 'string' ? input.body.trim() : ''
    const threat = scanThreat(`${title} ${when} ${body}`)
    if (threat !== undefined) {
      refused.push(`${id}: ${threat}`)
      continue
    }
    const evidence = (Array.isArray(input.evidence) ? input.evidence : [])
      .map((item) => (typeof item === 'string' ? item : ''))
      .filter((item) => item.length > 0)
    /**
     * Collect the denied vocabularies FIRST, then prefix the lines with the field they came from.
     * The prefix is what makes the report actionable: `tags: …` and `applicable_node_types: …` are
     * different fields of the frontmatter, and "a tag was dropped" without saying which one sends
     * the reader looking at the wrong line.
     */
    const tagDrops: string[] = []
    const nodeDrops: string[] = []
    const tagOverCap: string[] = []
    const nodeOverCap: string[] = []
    const tags = normalizeVocabList(input.tags, 8, tagDrops, tagOverCap)
    const applicableNodeTypes = normalizeVocabList(input.applicableNodeTypes, 8, nodeDrops, nodeOverCap)
    droppedTags.push(...tagDrops.map((line) => `tags: ${line}`))
    droppedTags.push(...nodeDrops.map((line) => `applicable_node_types: ${line}`))
    /**
     * The cap-overflow line names every tag that was valid and did not fit. `8` is quoted from the
     * call above rather than recomputed, so the message can only say what this call actually did.
     */
    if (tagOverCap.length > 0) {
      truncatedTags.push(`tags: kept 8, did NOT keep ${tagOverCap.length}: ${tagOverCap.join(', ')}`)
    }
    if (nodeOverCap.length > 0) {
      truncatedTags.push(
        `applicable_node_types: kept 8, did NOT keep ${nodeOverCap.length}: ${nodeOverCap.join(', ')}`,
      )
    }
    accepted.push({
      id,
      kind: input.kind === 'negative' ? 'negative' : 'skill',
      title,
      when,
      body,
      tags,
      applicableNodeTypes,
      workspace,
      provenance:
        input.provenance === 'human' || input.provenance === 'tool' || input.provenance === 'inferred'
          ? input.provenance
          : 'inferred',
      confidence: 1,
      evidence,
      sources: 1,
      createdAt: at,
      updatedAt: at,
    })
  }
  if (accepted.length === 0) return { written: 0, merged: 0, refused, droppedTags, truncatedTags, entries: [] }

  mkdirSync(dir, { recursive: true })
  const stored = withFileLock(`${knowledgePath(dir)}.lock`, () => {
    const existing = new Map<string, KnowledgeEntry>()
    for (const entry of readKnowledge(dir)) existing.set(entry.id, entry)
    let written = 0
    let merged = 0
    for (const entry of accepted) {
      const previous = existing.get(entry.id)
      if (previous === undefined) {
        existing.set(entry.id, entry)
        written += 1
        continue
      }
      /**
       * ── W5-6: THE MERGE HAD A SECOND, SILENT CAP ───────────────────────────────────────────
       *
       * The union was truncated with `.slice(0, 12)` — no count, no names. So two entries whose
       * vocabulary together exceeded 12 produced a stored row that looked exactly like an entry that
       * legitimately had 12, and the tags that fell off were gone from both the store AND the report.
       *
       * The cap stays 12 (a merge must not grow without bound); what changes is that the names of the
       * tags that did not fit are now reported, per id, in `truncatedTags`.
       */
      const mergedTags = [...new Set([...previous.tags, ...entry.tags])]
      const mergedNodeTypes = [...new Set([...previous.applicableNodeTypes, ...entry.applicableNodeTypes])]
      if (mergedTags.length > 12) {
        truncatedTags.push(
          `tags (merge into ${entry.id}): kept 12, did NOT keep ${mergedTags.length - 12}: ${mergedTags.slice(12).join(', ')}`,
        )
      }
      if (mergedNodeTypes.length > 12) {
        truncatedTags.push(
          `applicable_node_types (merge into ${entry.id}): kept 12, did NOT keep ` +
            `${mergedNodeTypes.length - 12}: ${mergedNodeTypes.slice(12).join(', ')}`,
        )
      }
      // Union the vocabularies; keep the newest text; count the confirmation.
      existing.set(entry.id, {
        ...previous,
        kind: entry.kind,
        title: entry.title.length > 0 ? entry.title : previous.title,
        when: entry.when.length > 0 ? entry.when : previous.when,
        body: entry.body.length > 0 ? entry.body : previous.body,
        tags: mergedTags.slice(0, 12),
        applicableNodeTypes: mergedNodeTypes.slice(0, 12),
        workspace: previous.workspace.length > 0 ? previous.workspace : entry.workspace,
        evidence: [...new Set([...previous.evidence, ...entry.evidence])],
        sources: previous.sources + 1,
        updatedAt: at,
      })
      merged += 1
    }
    const rows = [...existing.values()].sort((left, right) => left.id.localeCompare(right.id))
    // `.jsonl` is outside the JSON gate (that gate covers single-document `.json`), so the
    // write validates itself: one complete JSON object per line, always.
    atomicWrite(knowledgePath(dir), rows.map((row) => JSON.stringify(toRow(row))).join('\n') + '\n')
    return { written, merged, rows }
  })

  return {
    written: stored.written,
    merged: stored.merged,
    refused,
    droppedTags,
    truncatedTags,
    entries: accepted.map((entry) => stored.rows.find((row) => row.id === entry.id) ?? entry),
  }
}

/**
 * Record the reverse anchor for one (knowledge, graph, node) triple.
 *
 * APPEND-ONLY AND IDEMPOTENT ON READ: an anchor written twice is not an error (a node edited to
 * the same pointer must not fail), and `readKnowledgeRefs` deduplicates. Returns how many rows
 * were actually appended, so a caller can tell "recorded" from "already known".
 *
 * ── P0 (audit 2026-11-08): THE APPEND WAS IMPLEMENTED AS A FULL REWRITE ────────────────────────
 *
 * WHAT WAS WRONG, STATED PRECISELY. The lock was already correct — `withFileLock` is a real
 * cross-process lease (dsh-paradise, with a per-acquisition holder identity), and both the read and
 * the write sat INSIDE it. The defect was the WRITE ITSELF:
 *
 *     previous = readFileSync(refsPath)          // whole file
 *     atomicWrite(refsPath, previous + fresh)    // whole file, again
 *
 * An append-only ledger was being maintained by rewriting it. Two consequences, both measured by
 * the shape of the code rather than guessed:
 *
 *   1. A crash between the tmp-file write and the rename loses THE WHOLE BATCH, not the tail of it
 *      — the file simply stays at its previous version. An append that loses the rows it just
 *      accepted is not an append.
 *   2. Cost was O(N) per anchor. `store.ts` and `edges.ts` each had this same shape and each was
 *      fixed for the same reason; this was the remaining instance. With one anchor per graph edit
 *      the file grows monotonically, so a long task pays a growing price on every node it adds.
 *
 * THE FIX IS THE OPERATION, NOT THE LOCK. `appendFileSync` gives O(1) and a one-line torn-read
 * window that `readKnowledgeRefs` already tolerates (it skips a line that does not parse). The
 * dedupe still happens inside the lock, against a fresh read, so the two writers that matter —
 * two sessions harvesting at once — still cannot double-record.
 *
 * `mkdirSync` stays BEFORE the append: `appendFileSync` does not create a missing parent directory,
 * and the first anchor in a fresh workspace is exactly the case that used to throw ENOENT here.
 */
export function recordKnowledgeRefs(dir: string, refs: readonly Omit<KnowledgeRef, 'at'>[], at = new Date().toISOString()): number {
  if (refs.length === 0) return 0
  mkdirSync(dir, { recursive: true })
  return withFileLock(`${refsPath(dir)}.lock`, () => {
    const known = new Set(readKnowledgeRefs(dir).map((ref) => `${ref.graphId}\u0000${ref.nodeId}\u0000${ref.knowledgeId}`))
    const fresh: KnowledgeRef[] = []
    for (const ref of refs) {
      const key = `${ref.graphId}\u0000${ref.nodeId}\u0000${ref.knowledgeId}`
      if (known.has(key)) continue
      known.add(key)
      fresh.push({ ...ref, at })
    }
    if (fresh.length === 0) return 0
    // The parent may not exist yet on the very first anchor; `appendFileSync` will not create it.
    mkdirSync(dirname(refsPath(dir)), { recursive: true })
    /**
     * ── A TORN TAIL MUST BE CLOSED OFF BEFORE APPENDING, OR IT EATS THE NEXT LINE ─────────────
     *
     * Found by this change's own test, and it is the one hazard the append operation introduces
     * that the rewrite did not have: if a previous process was killed mid-write, the file ends in a
     * PARTIAL JSON object with no newline. Appending straight onto it produces
     *
     *     {"knowledgeId":"half{"knowledgeId":"k-3",...}\n
     *
     * — one unparseable line, so the row just accepted is silently lost, and every subsequent
     * append is fine but this one never existed. `readKnowledgeRefs` skips the broken line, which
     * means nothing reports the loss.
     *
     * The repair is one byte: if the file does not end in a newline, write one first. The partial
     * line stays as a broken row (skipped on read, exactly as before) and the new rows start on a
     * clean line. Reading the last byte is O(1) — `statSync` gives the size, and one 1-byte read
     * confirms the terminator without loading the file.
     */
    const path = refsPath(dir)
    if (existsSync(path) && !endsWithNewline(path)) {
      appendFileSync(path, '\n', 'utf8')
    }
    appendFileSync(path, `${fresh.map((ref) => JSON.stringify(ref)).join('\n')}\n`, 'utf8')
    return fresh.length
  })
}

/**
 * Does this file end with a line terminator?
 *
 * One 1-byte read at `size - 1`, never a whole-file load: this runs on the append path, whose whole
 * point is that it does not scale with the file. A missing or empty file counts as "terminated"
 * (there is no torn tail to close).
 */
function endsWithNewline(path: string): boolean {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return true
  }
  if (size === 0) return true
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(1)
    readSync(fd, buffer, 0, 1, size - 1)
    return buffer[0] === 0x0a
  } catch {
    // A file we cannot inspect is treated as terminated: appending is still the safe direction.
    return true
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // A leaked descriptor here would be a bug, but not one worth failing the caller over.
      }
    }
  }
}

export interface KnowledgeQueryInput {
  tags?: unknown
  nodeType?: string
  kinds?: unknown
  limit?: number
  /** When true, an entry with neither tags nor node types is still returned. Default false. */
  includeUntagged?: boolean
}

export interface KnowledgeQueryHit {
  entry: KnowledgeEntry
  /** How many of the queried tags matched, plus a bonus for an explicit node-type match. */
  score: number
  matchedTags: string[]
  /** Which DAG nodes have anchored this entry. Empty = learned but never used. */
  referencedBy: Array<{ graphId: string; nodeId: string; at: string }>
}

export interface KnowledgeQueryResult {
  query: { tags: string[]; nodeType: string }
  /** Total entries in the store, whether or not they matched — so "0 of 0" and "0 of 40" differ. */
  total: number
  matched: number
  hits: KnowledgeQueryHit[]
  notes: string[]
}

/**
 * Cross-workspace retrieval by vocabulary.
 *
 * WHY IT IS NOT `retrieve()`: `retrieve` answers "what resembles this prompt, here". This answers
 * "what do I know about this PHASE and these TOPICS, anywhere". Mixing them would either weaken
 * the workspace gate or make the phase query depend on prompt wording, and both are wrong.
 *
 * SCORING IS DELIBERATELY DUMB (no model call): |matched tags| * 2 + 3 for an explicit node-type
 * match, ties broken by confidence then recency. A phase lookup must be fast enough to run at the
 * start of every node, and a model call there would be a tax on every turn.
 */
export function queryKnowledge(dir: string, input: KnowledgeQueryInput = {}): KnowledgeQueryResult {
  const tags = normalizeVocabList(input.tags)
  const nodeType = typeof input.nodeType === 'string' ? normalizeVocabList([input.nodeType], 1)[0] ?? '' : ''
  const kinds = (Array.isArray(input.kinds) ? input.kinds : [])
    .map((item) => String(item))
    .filter((item) => item === 'skill' || item === 'negative')
  const limit = Number.isFinite(Number(input.limit)) ? Math.max(1, Math.min(50, Math.trunc(Number(input.limit)))) : 10
  const notes: string[] = []

  const all = readKnowledge(dir)
  const refs = readKnowledgeRefs(dir)
  const refsByKnowledge = new Map<string, Array<{ graphId: string; nodeId: string; at: string }>>()
  for (const ref of refs) {
    const list = refsByKnowledge.get(ref.knowledgeId) ?? []
    // One node anchoring twice is one reference, not two.
    if (!list.some((item) => item.graphId === ref.graphId && item.nodeId === ref.nodeId)) {
      list.push({ graphId: ref.graphId, nodeId: ref.nodeId, at: ref.at })
    }
    refsByKnowledge.set(ref.knowledgeId, list)
  }

  const hits: KnowledgeQueryHit[] = []
  let blockedByThreat = 0
  for (const entry of all) {
    if (kinds.length > 0 && !kinds.includes(entry.kind)) continue
    /**
     * RE-SCAN ON READ. The write gate already refused a poisoned entry, but the file is on disk
     * and hand-editable, and this store is shared across workspaces — the one place a stale
     * poisoned row would travel everywhere. Cheap: it is a handful of regexes on short text.
     */
    if (scanThreat(`${entry.title} ${entry.when} ${entry.body}`) !== undefined) {
      blockedByThreat += 1
      continue
    }
    const tagged = entry.tags.length > 0 || entry.applicableNodeTypes.length > 0
    /**
     * AN UNTAGGED ENTRY IS LOCAL, AND LOCAL MEANS "NOT MATCHED BY A VOCABULARY QUERY".
     *
     * `includeUntagged` is the explicit opt-out for the CONSOLE, whose job includes reporting
     * "learned but not shareable". It has to bypass BOTH checks, not just the first one: an entry
     * with no axes cannot match a tag or a phase, so a query that only relaxed the first gate would
     * still return it from the second — which is what the first version did, and the test caught.
     */
    if (!tagged) {
      if (input.includeUntagged !== true) continue
      hits.push({ entry, score: 0, matchedTags: [], referencedBy: refsByKnowledge.get(entry.id) ?? [] })
      continue
    }
    const matchedTags = tags.filter((tag) => entry.tags.includes(tag))
    const nodeMatch = nodeType.length > 0 && entry.applicableNodeTypes.includes(nodeType)
    // A tag query requires at least one tag; a node-only query requires the node type.
    if (tags.length > 0 && matchedTags.length === 0 && !nodeMatch) continue
    if (tags.length === 0 && nodeType.length > 0 && !nodeMatch) continue
    hits.push({
      entry,
      score: matchedTags.length * 2 + (nodeMatch ? 3 : 0),
      matchedTags,
      referencedBy: refsByKnowledge.get(entry.id) ?? [],
    })
  }

  hits.sort(
    (left, right) =>
      right.score - left.score ||
      right.entry.confidence - left.entry.confidence ||
      right.entry.updatedAt.localeCompare(left.entry.updatedAt),
  )

  if (all.length === 0) notes.push(`知识库为空：${dir} 里没有 knowledge.jsonl`)
  if (blockedByThreat > 0) notes.push(`${blockedByThreat} 条知识被注入扫描拒绝，未返回`)
  if (hits.length === 0 && all.length > 0) {
    notes.push(`知识库有 ${all.length} 条，但没有一条匹配 tags=[${tags.join(',')}] / nodeType=${nodeType || '(未指定)'}`)
  }

  return {
    query: { tags, nodeType },
    total: all.length,
    matched: hits.length,
    hits: hits.slice(0, limit),
    notes,
  }
}

/**
 * Render the one-line phase banner a caller may inject when a node becomes active.
 *
 * It is a HINT, not a gate: it names the phase, the count, and the tool to call. It never pastes
 * a procedure into the prompt — that is `skill_read`'s job, spent only once the model decides it
 * applies (the same progressive-disclosure rule the rest of this plugin follows).
 */
export function renderPhaseHint(nodeType: string, result: KnowledgeQueryResult): string | undefined {
  if (result.matched === 0) return undefined
  const names = result.hits.slice(0, 3).map((hit) => hit.entry.title || hit.entry.id)
  const label = nodeType.length > 0 ? nodeType : '当前'
  const negatives = result.hits.filter((hit) => hit.entry.kind === 'negative').length
  return `[系统提示] 你正在进入 [${label}] 阶段，全局知识库中有 ${result.matched} 条相关知识${negatives > 0 ? `（其中 ${negatives} 条是翻车教训）` : ''}，如「${names.join('」「')}」。请先用 knowledge_query 查阅再动手。`
}
