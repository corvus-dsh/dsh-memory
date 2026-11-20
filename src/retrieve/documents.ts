/**
 * ── 取数层：把各种持久化形态转成检索用的 Document ──────────────────────────────────────────────
 *
 * 从 `retrieve.ts` 搬出的 8 个声明（L4 层，236 行）。它们做同一件事：
 * **读某种存储形态，产出 `Document`**。
 *
 *   skillDocuments         SKILL.md 目录 → Document[]（含冲突邻接与缓存）
 *   negativeDocuments      negatives.jsonl → Document[]
 *   layerDocuments         facts/experiences.jsonl → Document[]
 *   tierDocumentOf         sqlite 索引行 → Document
 *   contentOf              从 Document 取正文（供 isPoisoned 用）
 *   looksLikeIncidentLog   判断一条记录像不像事故日志
 *   ERROR_IDENTIFIER / STOPWORDS   上面几个用到的词法常量
 *
 * ── 段外引用：8/8 全部有 ───────────────────────────────────────────────────────────────────────
 *
 * 这 8 个声明**没有一个是纯内部**，每一个都被 L4 之外的代码调用（memoryDocumentsFor、
 * collectAllDocuments、scoreDocuments、allowsTask、extractTaskTerms、isPoisoned）。
 * 所以 `retrieve.ts` 必须把 8 个全部 import 回来。
 *
 * 其中只有 `looksLikeIncidentLog` 原本带 `export` 且在 `lib/retrieve.js` 的运行时导出面上，
 * 因此它是唯一需要 re-export 的那个；其余 7 个原本就是模块私有。
 *
 * ── 依赖方向 ────────────────────────────────────────────────────────────────────────────────────
 *
 * 对 `retrieve.ts` 零值依赖（只 import 类型与更底层的原语）；因此不参与任何运行期循环。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getNeighbors } from '../edges.js'
import { ledgerPatchCount, ledgerVersion, readRecords } from '../ledger-cache.js'
import { getCachedSkillDocs, setCachedSkillDocs } from '../skill-cache.js'
import type { IndexDocument } from '../sqlite-index.js'
import { readFrontmatterList, readSkillValidity } from '../store/skill.js'
import { normalizeWorkspace } from '../workspace.js'
/** b3-f8: "被引用过吗" 的判据（纯函数，与 memory_stats 同一口径）。 */
import { isReferenced } from '../generation.js'
import type { Document, DocumentKind } from '../retrieve.js'
import { INCIDENT_MARKERS, ageDaysOf, clipTitle, documentCache, layerDocumentOf, negativeDocumentOf, provenanceOf, skillDirKey, tokenize, triggerOf } from './interning.js'

/** Turn an index row into the retrieval `Document` shape, scoring fields included. */
export function tierDocumentOf(row: IndexDocument, now: number): Document {
  const sceneText = row.scene.toLowerCase()
  return {
    kind: row.kind as DocumentKind,
    id: row.id,
    title: clipTitle(row.title, 60),
    detail: row.detail.slice(0, 120),
    scope: row.scope,
    workspace: row.workspace,
    domain: row.domain,
    scanText: row.scanText,
    validAt: row.validAt === '' ? undefined : row.validAt,
    invalidAt: row.invalidAt === '' ? undefined : row.invalidAt,
    provenance: provenanceOf(row.provenance),
    scene: /^[a-z][a-z0-9-]{1,23}$/u.test(sceneText) ? sceneText : 'general',
    tokens: new Set(tokenize(row.scanText)),
    ageDays: ageDaysOf(row.at, now),
    ...(Number.isFinite(row.hits) ? { hits: row.hits } : {}),
    importance: 1,
  }
}

/** High-frequency words that carry no task signal; down-weighted, not removed. */
export const STOPWORDS = new Set([
  '的', '了', '在', '是', '和', '与', '也', '就', '都', '而', '及', '或', '把', '被', '对', '从', '为', '以', '这', '那', '有', '个',
  '我们', '你们', '他们', '这个', '那个', '一个', '可以', '需要', '应该', '如果', '然后', '就是', '还是', '已经', '进行', '没有',
  '逻辑', '修复', '改动', '修改', '问题', '测试', '方法', '做法', '时候', '其中', '以及', '并且', '所以', '但是', '因为',
])

export function looksLikeIncidentLog(document: { title?: string; when?: string; detail?: string; id?: string }): boolean {
  const text = [document.title, document.when, document.detail, document.id]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n')
  return INCIDENT_MARKERS.some((pattern) => pattern.test(text))
}

/** Something that names ONE failure: an error type, a code, a snake_case symbol. */
export const ERROR_IDENTIFIER = /^(?:[a-z]+(?:error|exception)$|[a-z]+_[a-z_]+|e[a-z]{3,5}$)/iu

/**
 * v0.8.1 D4: the INJECTION-side injection scan.
 *
 * The write gate (`store.ts`) refuses a poisoned extraction before it becomes a
 * file. It cannot help with what is already on disk: a SKILL.md written by an
 * older version, edited by hand, or produced by another tool. Retrieval is the
 * last point before the text enters a prompt, so the same rule is applied to the
 * whole stored content of every document — not just the fields that happen to be
 * rendered today.
 */
export function contentOf(document: Document): string {
  return [document.id, document.title, document.when ?? '', document.detail ?? '', (document.aliases ?? []).join(' '), document.scanText ?? ''].join(
    '\n',
  )
}

export function skillDocuments(skillsDir: string, now: number): Document[] {
  const cacheKey = skillDirKey(skillsDir, now)
  const cached = getCachedSkillDocs<Document>(skillsDir, cacheKey)
  if (cached !== undefined) return cached
  let names: string[] = []
  try {
    names = readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
  /**
   * v1.0.0 P0: the edge index is loaded ONCE per retrieval, not once per skill.
   * `getNeighbors` on an already-warm cache is a map scan; calling it inside the loop
   * without this dictionary would still be O(N·E).
   */
  const neighbors = new Map<string, string[]>()
  for (const name of names) neighbors.set(name, getNeighbors(skillsDir, name))
  const edgesOf = (name: string): string[] => neighbors.get(name) ?? []
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
    /**
     * v1.0.0 P0 — CONFLICTS COME FROM THE EDGE INDEX, NOT FROM THE FILE.
     *
     * This used to regex a `conflicts_with:` line out of the SKILL.md it had already read.
     * That line no longer exists in v1.0.0 writes: edges live in `skills-edges.jsonl`.
     * A LEGACY file may still carry the field, so both sources are merged — the file is
     * read anyway for the body, and dropping its legacy edges would silently forget every
     * conflict recorded before the upgrade.
     */
    const inlineConflicts = (text.match(/^conflicts_with:\s*(.+)$/mu)?.[1] ?? '')
      .split(/[,\s]+/u)
      .filter((value) => value.length > 0)
    const indexedConflicts = edgesOf(name)
    const conflictsWith = [...new Set([...inlineConflicts, ...indexedConflicts])]
    const scopeText = (text.match(/^scope:\s*(.+)$/mu)?.[1] ?? '').trim().toLowerCase()
    const scope = scopeText === 'workspace' || scopeText === 'global' ? scopeText : 'project'
    // v0.8: provenance for the isolation gate.
    const workspace = normalizeWorkspace(text.match(/^workspace:\s*(.+)$/mu)?.[1] ?? '')
    // v0.15: the validity window and trust tier live in the same frontmatter.
    const validity = readSkillValidity(text)
    // v0.17: the semantic domain, the axis that decides what may be a conflict.
    const domainText = (text.match(/^domain:\s*(.+)$/mu)?.[1] ?? '').trim().toLowerCase()
    const domain = /^[a-z][a-z0-9-]{1,31}$/u.test(domainText) ? domainText : 'general'
    // v0.5: aliases are recall fuel: "连数据库" must find a skill whose trigger
    // says "pymysql 连接" even though neither word matches.
    //
    // W1-9b: through the SHARED reader, not a fourth copy of the regex. An empty `aliases:` used to
    // capture the next line as an alias, and this is the reader that decides what is searchable — the
    // same field W1-9 made the merge preserve.
    const aliases = readFrontmatterList(text, 'aliases')
    /**
     * ── v0.44 (B4-0b-1 A10): TWO FIXES IN ONE LINE, BOTH MEASURED ────────────────────────────────
     *
     * 1. `\s*` → `[ \t]*`. `\s` matches NEWLINES, so an EMPTY `last_used:` field made `(.+)` capture
     *    the NEXT line (`created: …`) — the same defect AUD-4 fixed in `store/skill.ts` and
     *    `archive.ts`. This is the THIRD copy of that regex, and A10 is what made the empty field
     *    actually occur, so it had to be fixed here too rather than left as a latent one.
     *
     * 2. `(.*)` instead of `(.+)`, plus `hasLastUsedField`. "The field is present but empty" and "the
     *    field is absent" are DIFFERENT facts, and A10's whole ruling depends on keeping them apart:
     *
     *      · present + empty  ⇒ a skill created by this build that was never recalled ⇒ `referenced`
     *        is a real FALSE, and the N-generation downgrade may act on it (judgments ①②③);
     *      · absent           ⇒ an old file from before this build, so nobody knows ⇒ `undefined`
     *        = UNKNOWN, which `generationDowngradeFor` never demotes (judgment ④).
     *
     * Collapsing the two would either make every legacy skill instantly downgrade-eligible or keep
     * new skills immune forever — the second of which is the defect this item exists to fix.
     */
    const hasLastUsedField = /^last_used:/mu.test(text)
    const lastUsed = text.match(/^last_used:[ \t]*(.*)$/mu)?.[1] ?? ''
    const lastValidated = text.match(/^last_validated:\s*(.+)$/mu)?.[1]
    const usedDays = ageDaysOf(lastUsed ?? updated, now)
    const validatedDays = ageDaysOf(lastValidated ?? updated, now)
    // v0.5 decay: an unused, unvalidated skill ranks half as high, and says so.
    const decayed = usedDays > 14 && validatedDays > 14
    const stale = validatedDays > 14
    const sceneText = (text.match(/^scene:\s*(.+)$/mu)?.[1] ?? '').trim().toLowerCase()
    const scene = /^[a-z][a-z0-9-]{1,23}$/u.test(sceneText) ? sceneText : 'general'
    // v0.7.1: use-effect loop weight. A skill that failed in real use ranks down.
    const confidenceValue = Number(text.match(/^confidence:\s*(.+)$/mu)?.[1] ?? '1')
    const confidence = Number.isFinite(confidenceValue) ? Math.min(1, Math.max(0.2, confidenceValue)) : 1
    // v0.32 P1: the generation and the code commit this experience was extracted against.
    // Both are provenance written by the store, never by the model.
    const generationValue = Number(text.match(/^generation:\s*(\d+)$/mu)?.[1] ?? '')
    const generation = Number.isFinite(generationValue) && generationValue > 0 ? generationValue : undefined
    const commitText = (text.match(/^commitHash:\s*([0-9a-f]{7,40})$/mu)?.[1] ?? '').trim()
    const commitHash = commitText.length > 0 ? commitText : undefined
    const evidenceRaw = text.match(/^evidence:\s*(.+)$/mu)?.[1] ?? ''
    const firstRef = evidenceRaw.split(/[,\s]+/u).filter(Boolean)[0] ?? ''
    const at = firstRef.lastIndexOf('@')
    const evidenceSession = at > 0 ? firstRef.slice(0, at) : ''
    const evidenceSeq = Number(at > 0 ? firstRef.slice(at + 1) : firstRef)
    out.push({
      kind: 'skill',
      id: name,
      title: clipTitle(heading.trim(), 60),
      when,
      detail: when,
      scope,
      workspace,
      domain,
      scanText: text,
      validAt: validity.validAt,
      invalidAt: validity.invalidAt,
      // v0.21: an archived skill stays on disk but never activates.
      ...(/^archived:\s*true\s*$/mu.test(text) ? { archived: true } : {}),
      supersededBy: validity.supersededBy,
      provenance: validity.provenance,
      scene,
      aliases,
      ...(evidenceSession.length === 0 ? {} : { sessionId: evidenceSession }),
      ...(Number.isFinite(evidenceSeq) ? { seq: evidenceSeq } : {}),
      ...(conflictsWith.length === 0 ? {} : { conflictsWith }),
      confidence,
      ...(stale ? { stale: true } : {}),
      ...(generation === undefined ? {} : { generation }),
      ...((() => {
        /**
         * b3-f8: decided HERE from the record's own counters.
         *
         * v0.44 (A10): a file with NO `last_used` field at all is UNKNOWN, not "never used". The
         * distinction is the one `generationDowngradeFor` relies on (`referenced !== false`), so it is
         * made from the FILE TEXT here rather than reconstructed from an empty string — an empty field
         * is a new-build skill that was never recalled (a real FALSE), a missing field is an old file
         * (UNKNOWN).
         */
        const referenced = hasLastUsedField ? isReferenced({ lastUsed, sources }) : undefined
        return referenced === undefined ? {} : { referenced }
      })()),
      ...(commitHash === undefined ? {} : { commitHash }),
      ...(lastValidated === undefined ? {} : { lastValidated }),
      ...(updated === undefined ? {} : { updatedAt: updated }),
      tokens: new Set(
        tokenize(`${name} ${heading} ${when} ${aliases.join(' ')} ${scope} ${text.replace(/^---[\s\S]*?---/u, '')}`),
      ),
      ageDays: usedDays,
      importance:
        (1 + Math.min(0.5, 0.15 * Math.log(1 + Math.max(1, sources) - 1) + (sources > 1 ? 0.1 : 0))) *
        (decayed ? 0.5 : 1) *
        confidence,
    })
  }
  setCachedSkillDocs(skillsDir, cacheKey, out)
  return out
}

export function negativeDocuments(memoryDir: string, now: number): Document[] {
  const path = join(memoryDir, 'negatives.jsonl')
  /**
   * ORDER MATTERS: read FIRST, then key.
   *
   * `readRecords` validates the ledger's stats and, on a miss, reloads and bumps the version.
   * Keying before that read would use a stale version and serve documents built from content
   * that is no longer on disk — measured as a bitemporal test still seeing an invalidated
   * negative.
   */
  const records = readRecords(path)
  const version = ledgerVersion(path)
  const patchCount = ledgerPatchCount(path)
  const hour = Math.floor(now / 3_600_000)
  const cached = documentCache.get(path)
  if (
    cached !== undefined &&
    cached.version === version &&
    cached.hour === hour
  ) {
    return cached.docs
  }
  /** Incremental path: nothing was patched, and rows were only added. */
  if (
    cached !== undefined &&
    cached.patchCount === patchCount &&
    cached.hour === hour &&
    records.length >= cached.built
  ) {
    for (let index = cached.built; index < records.length; index += 1) {
      const doc = negativeDocumentOf(records[index], index, now)
      if (doc !== undefined) cached.docs.push(doc)
    }
    cached.built = records.length
    cached.version = version
    return cached.docs
  }
  const out: Document[] = []
  for (let index = 0; index < records.length; index += 1) {
    const doc = negativeDocumentOf(records[index], index, now)
    if (doc !== undefined) out.push(doc)
  }
  documentCache.set(path, { version, patchCount, built: records.length, hour, docs: out })
  return out
}

/** v0.6: facts and experiences are retrievable evidence, not just stored text. */
export function layerDocuments(memoryDir: string, file: string, kind: 'fact' | 'experience', now: number): Document[] {
  const path = join(memoryDir, file)
  /** Read BEFORE keying — the read is what refreshes the version (see negativeDocuments). */
  const records = readRecords(path)
  const version = ledgerVersion(path)
  const patchCount = ledgerPatchCount(path)
  const hour = Math.floor(now / 3_600_000)
  const cached = documentCache.get(path)
  if (cached !== undefined && cached.version === version && cached.hour === hour) return cached.docs
  /** Incremental path: no patch, rows only added. */
  if (
    cached !== undefined &&
    cached.patchCount === patchCount &&
    cached.hour === hour &&
    records.length >= cached.built
  ) {
    for (let index = cached.built; index < records.length; index += 1) {
      const doc = layerDocumentOf(records[index], index, kind, now)
      if (doc !== undefined) cached.docs.push(doc)
    }
    cached.built = records.length
    cached.version = version
    return cached.docs
  }
  const out: Document[] = []
  for (let index = 0; index < records.length; index += 1) {
    const doc = layerDocumentOf(records[index], index, kind, now)
    if (doc !== undefined) out.push(doc)
  }
  documentCache.set(path, { version, patchCount, built: records.length, hour, docs: out })
  return out
}
