/**
 * ── READ-ONLY VIEWS OVER THE TASK GRAPH ─────────────────────────────────────────────────────────
 *
 * This module owns the RENDERED VIEW of a graph. `graph.ts` owns the GRAPH itself — nodes, edges,
 * cycles, the goal lock, `updateGraph` — and `graph-v3.ts` owns how a v3 FIELD is judged. Neither is a
 * synonym for this one: what lives here takes a graph that is already valid and answers "what does it
 * look like", including the resolved knowledge each node points at and the reverse edges no node stores.
 *
 * WHY IT IS A SEPARATE FILE RATHER THAN A SECTION OF `graph.ts`. `graph.ts` is under a hard 800-line cap
 * and a registered ceiling that may only go DOWN. When the leading op for `constrain` / `relax` pushed
 * it to 875, the cap refused it — correctly. The temptation was to shave comments until the number fit,
 * which would have made the file smaller without making it clearer. This is the seam that was actually
 * there: nothing in here mutates, and everything in here reads the same three things (nodes, their
 * pointers, their reverse edges).
 *
 * It takes `TaskGraph` as a PARAMETER rather than a `memoryDir`, so a caller that already has a graph in
 * hand does not pay for a second read — and so this module never has to know where a store lives.
 */

import type { GraphNode, TaskGraph } from './graph.js'
import type { KnowledgeEntry } from './knowledge.js'

export interface GraphNodeView extends GraphNode {
  /** The knowledge entries this node points at, resolved (empty when no knowledge dir was given). */
  knowledge: KnowledgeEntry[]
  /** Nodes that depend on this one. */
  unlocks: string[]
}

/**
 * The console/DAG view: nodes plus their resolved knowledge, with the reverse edges computed.
 *
 * The reverse edges are NOT stored on the node on purpose: `unlocks` is derivable from everyone else's
 * `dependsOn`, and a stored copy would be a second source of truth that goes wrong the moment one side
 * is edited without the other (⑪).
 */
export function describeNodes(graph: TaskGraph, knowledge: KnowledgeEntry[] | undefined): {
  nodes: GraphNodeView[]
  counts: { total: number; pending: number; active: number; done: number; abandoned: number }
} {
  const byId = new Map((knowledge ?? []).map((entry) => [entry.id, entry]))
  const nodes: GraphNodeView[] = graph.nodes.map((node) => ({
    ...node,
    knowledge: node.knowledgePointers
      .map((pointer) => byId.get(pointer))
      .filter((entry): entry is KnowledgeEntry => entry !== undefined),
    unlocks: graph.nodes.filter((other) => other.dependsOn.includes(node.id)).map((other) => other.id),
  }))
  const counts = { total: nodes.length, pending: 0, active: 0, done: 0, abandoned: 0 }
  for (const node of nodes) counts[node.status] += 1
  return { nodes, counts }
}

/** One-line readiness answer, used by the phase hint and the console. */
export function renderNodeBanner(node: GraphNodeView | undefined): string | undefined {
  if (node === undefined) return undefined
  const parts = [`节点 ${node.id}（${node.status}）`]
  if (node.nodeType.length > 0) parts.push(`阶段 ${node.nodeType}`)
  if (node.requirements.length > 0) parts.push(`要求：${node.requirements.slice(0, 3).join('；')}`)
  if (node.knowledge.length > 0) {
    parts.push(`相关技能：${node.knowledge.slice(0, 3).map((entry) => entry.title || entry.id).join('、')}`)
  }
  return parts.join(' · ')
}

/** Convenience: is the graph untouched (only the start node, no goal)? */
export function isBlankGraph(graph: TaskGraph): boolean {
  return graph.goal.length === 0 && graph.nodes.length <= 1 && graph.history.length === 0
}
