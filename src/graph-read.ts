/**
 * ── READING THE GRAPH FILE, AND SAYING HOW THE READ ENDED (G-8, P0) ─────────────────────────────
 *
 * THE DEFECT THIS CLOSES. `readGraph` was:
 *
 *     try { text = readFileSync(path, 'utf8') } catch { return emptyGraph(id) }
 *     try { parsed = JSON.parse(text) }        catch { return emptyGraph(id) }
 *
 * Three different facts arrived as ONE value:
 *
 *   absent      the file is not there  — a project that never made a plan. Normal, actionable.
 *   unreadable  the file IS there and cannot be trusted — a parse error, a permissions error, a
 *               half-written file. Every number from it is a guess.
 *   ok          read and parsed.
 *
 * Collapsing them is right for a renderer that must draw something and wrong for every caller that makes
 * a DECISION. Measured (v3.2 §5.4, re-verified by the lead on the current HEAD): with a corrupt graph,
 * `harvestWarningFor` reported 「nothing to harvest」, `activeNodeIdsForHarvest` handed an empty list to
 * the WRITER, and the panel said nothing — 「一切正常」 while the graph was unreadable. Only the panel's
 * own `graphIsUnreadable` probe knew, because it went back to the file instead of trusting `readGraph`.
 *
 * WHY A MODULE. `graph.ts` is at its 800-line cap (it is IN the cap, not exempt). This is a real seam:
 * everything here touches a filesystem and nothing here decides what a graph MEANS. `graph.ts` keeps the
 * parse-and-normalise half and delegates the IO, so the file is read in exactly one place.
 */

import { readFileSync } from 'node:fs'

/** How a read ended. `absent` and `unreadable` are never the same fact. */
export type GraphReadStatus = 'absent' | 'unreadable' | 'ok'

export interface GraphTextRead {
  readonly status: GraphReadStatus
  /** The file's text, for `ok` only. */
  readonly text?: string
  /** Why the read failed, for `unreadable` only. */
  readonly detail?: string
}

/**
 * Read the graph file's TEXT and classify the outcome.
 *
 * FAIL-CLOSED ON AN UNCLASSIFIABLE ERROR: an error whose code is not `ENOENT` is `unreadable`, not
 * `absent`. A read we cannot explain is not evidence that no plan exists — and treating it as 「no plan」
 * is precisely the fail-open this batch removes.
 */
export function readGraphText(memoryDir: string, graphPathOf: (dir: string) => string): GraphTextRead {
  const path = graphPathOf(memoryDir)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = String((error as { code?: unknown })?.code ?? '')
    if (code === 'ENOENT') return { status: 'absent' }
    return {
      status: 'unreadable',
      detail:
        `读 ${path} 失败（${code || '未知错误码'}）：${String((error as { message?: unknown })?.message ?? error)}`,
    }
  }
  if (text.trim().length === 0) {
    /**
     * An EMPTY file is not an absent one: something created it. It is also not a readable graph — parsing
     * `''` throws, and calling `JSON.parse` to discover that would produce a less useful sentence than
     * this one.
     */
    return { status: 'unreadable', detail: `${path} 是空文件（存在但没有任何内容）` }
  }
  return { status: 'ok', text }
}

/** Parse the text into a record, or say why it cannot be trusted. */
export function parseGraphText(text: string, describePath: string): { record?: Record<string, unknown>; detail?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      detail:
        `${describePath} 存在但不是合法 JSON（${String((error as { message?: unknown })?.message ?? error)}）：` +
        '这通常意味着另一个进程正在写入，或文件被手工改坏。',
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { detail: `${describePath} 的内容不是一个 JSON 对象` }
  }
  return { record: parsed as Record<string, unknown> }
}

/**
 * ── THE DECISION-ORIENTED READ (G-8) ────────────────────────────────────────────────────────────
 *
 * `absent` and `unreadable` are DIFFERENT FACTS, and a caller that acts on the graph must be able to tell
 * them apart:
 *
 *   absent      the file is not there. A project that never made a plan — normal, actionable
 *               (「call bootstrap」), never a failure.
 *   unreadable  the file IS there and cannot be trusted: a parse error, a permissions error, an empty or
 *               half-written file. Every number read from it is a guess.
 *   ok          read and parsed.
 *
 * The wrapper `readGraph` collapses all three into an empty graph. That is right for a renderer and wrong
 * for a decider — measured: a corrupt graph made the harvest reminder report 「nothing to harvest」 and
 * handed an EMPTY LIST TO THE WRITER. So the decision call this function, and `graph.ts` keeps only the
 * normalise half.
 */
export interface GraphReadState<TGraph> {
  readonly status: GraphReadStatus
  /** Present for every status: a caller that must render something still gets a graph shape. */
  readonly graph: TGraph
  /** Why the read failed, for `unreadable`. Absent otherwise. */
  readonly detail?: string
}

export function readGraphStateOf<TGraph>(
  memoryDir: string,
  id: string,
  graphPathOf: (dir: string) => string,
  emptyOf: (id: string) => TGraph,
  normalise: (record: Record<string, unknown>, id: string) => TGraph,
): GraphReadState<TGraph> {
  const text = readGraphText(memoryDir, graphPathOf)
  if (text.status !== 'ok') {
    return {
      status: text.status,
      graph: emptyOf(id),
      ...(text.detail === undefined ? {} : { detail: text.detail }),
    }
  }
  const parsed = parseGraphText(text.text ?? '', graphPathOf(memoryDir))
  if (parsed.record === undefined) {
    return { status: 'unreadable', graph: emptyOf(id), detail: parsed.detail ?? '无法解析' }
  }
  return { status: 'ok', graph: normalise(parsed.record, id) }
}