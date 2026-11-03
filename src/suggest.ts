/**
 * The suggest queue: extracted memory waits for a human before it becomes law.
 *
 * Why queue instead of auto-write: a skill is a promise about how to work. One
 * bad extraction ("always restart the host") is quoted verbatim by the next
 * session for weeks. The queue makes the default path reviewable, and
 * `autoApprove` exists for the trial period the user explicitly asked for.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ExtractedNegative, ExtractedSkill } from './extract.js'
import { appendNegatives, atomicWrite, writeSkill } from './store.js'
import type { SkillMeta } from './store.js'

export interface Suggestion {
  id: string
  kind: 'skill' | 'negative'
  payload: ExtractedSkill | ExtractedNegative
  /**
   * v0.8: the FULL write meta, including `workspace`. A suggestion is written
   * later, by hand; if the workspace did not ride along in the queue, approving a
   * reviewed skill would produce an unscoped memory that the isolation gate then
   * refuses forever — reviewed and unusable at the same time.
   */
  meta: SkillMeta
  at: string
}

function queuePath(memoryDir: string): string {
  return join(memoryDir, 'suggestions.jsonl')
}

export function listSuggestions(memoryDir: string): Suggestion[] {
  const path = queuePath(memoryDir)
  if (!existsSync(path)) return []
  const out: Suggestion[] = []
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.id === 'string') out.push(parsed as Suggestion)
    } catch {
      // A torn line must not hide the rest of the queue.
    }
  }
  return out
}

function writeSuggestions(memoryDir: string, items: readonly Suggestion[]): void {
  atomicWrite(queuePath(memoryDir), items.map((item) => JSON.stringify(item)).join('\n') + (items.length > 0 ? '\n' : ''))
}

/** Append one candidate; returns the stored suggestion (with its id). */
export function queueSuggestion(memoryDir: string, kind: Suggestion['kind'], payload: ExtractedSkill | ExtractedNegative, meta: Suggestion['meta']): Suggestion {
  const suggestion: Suggestion = {
    id: `${kind}-${meta.sessionId.slice(0, 12)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind,
    payload,
    meta,
    at: new Date().toISOString(),
  }
  const items = listSuggestions(memoryDir)
  items.push(suggestion)
  writeSuggestions(memoryDir, items)
  return suggestion
}

export interface ApproveResult {
  found: boolean
  status?: string
}

/** Approve one suggestion: write the skill (merging if similar) and drop it. */
export function approveSuggestion(memoryDir: string, skillsDir: string, id: string): ApproveResult {
  const items = listSuggestions(memoryDir)
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return { found: false }
  const [suggestion] = items.splice(index, 1)
  let status: string | undefined
  if (suggestion.kind === 'skill') {
    status = writeSkill(skillsDir, suggestion.payload as ExtractedSkill, suggestion.meta)
    // A refused write (prompt-injection phrasing) keeps the suggestion out of the
    // queue but is reported, never silently swallowed.
    if (status.startsWith('skipped')) {
      writeSuggestions(memoryDir, items)
      return { found: true, status }
    }
  } else {
    appendNegatives(memoryDir, [suggestion.payload as ExtractedNegative], suggestion.meta)
    status = 'appended'
  }
  writeSuggestions(memoryDir, items)
  return { found: true, status }
}

export function rejectSuggestion(memoryDir: string, id: string): boolean {
  const items = listSuggestions(memoryDir)
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return false
  items.splice(index, 1)
  writeSuggestions(memoryDir, items)
  return true
}

