/**
 * ── WORKSPACE SCOPING FOR THE CONSOLE (user-reported P0) ────────────────────────────────────────────
 *
 * THE REPORT: 「记忆插件四层认知、任务图、飞轮均未实现按不同工作区隔离实现与显示」.
 *
 * WHAT WAS TRUE. All four views read `resolved.*Dir`, which `resolveConfig` derives ONCE at `apply()`
 * time from `paths.data` — a PROCESS-level directory, not the calling session's workspace. A window
 * showing project A therefore listed the skills, negatives, flywheel and task graph of whatever
 * directory the plugin started in. The numbers were real; the SCOPING was missing, and nothing on the
 * panel said which directory they described.
 *
 * WHY THIS IS ITS OWN MODULE. The fix is not one line, and `index.ts` is under a ratchet ceiling whose
 * rule is 「今天多大就是多大，不许因为加功能就放宽」 (2819 lines). A fix that needs a bigger ceiling is a fix
 * in the wrong file. It is also a coherent rule — 「what does this panel's four layers describe」 — which
 * is the other reason to name it.
 *
 * THE FOUR LAYERS ARE NOT THE SAME PROBLEM, and collapsing them into one answer is how the panel would
 * start lying in a new way:
 *
 *   · SKILLS / NEGATIVES  — ONE global store (`~/.agents/skills`), records separated by a `workspace`
 *     FIELD. Isolation is a FILTER, and it must be the SAME predicate retrieval uses; a second predicate
 *     here would make the panel and a real turn disagree about what exists.
 *   · MEMORY (episodes)   — a per-directory store. Isolation is the DIRECTORY.
 *   · KNOWLEDGE (flywheel) — a per-directory store, separate from memory.
 *   · TASK GRAPH          — a file inside the memory directory.
 *
 * The last three cannot be re-scoped by filtering, because their records carry no workspace field. What
 * they CAN do — and previously did not — is say which directory they came from, so a reader who sees a
 * graph that does not match their project has the evidence instead of a suspicion.
 */

import { memoryAllowsWorkspace } from './workspace.js'

/** The fields this rule reads from a skill record. Narrow on purpose: the caller owns the record shape. */
export interface ScopableSkillRecord {
  scope: string
  workspace: string
}

export interface ConsoleScoping<T extends ScopableSkillRecord> {
  /** Skills a turn in THIS workspace would be offered. */
  skills: T[]
  /** One line per layer, saying what its scope actually is. */
  skillsScope: string
  memoryScope: string
  knowledgeScope: string
  graphScope: string
}

/**
 * Scope the panel's four layers.
 *
 * `workspace` may be empty (a root-scoped panel with no session bound). That is NOT treated as
 * 「everything」: `memoryAllowsWorkspace` answers `false` for an empty current workspace, which is the same
 * fail-closed behaviour a turn gets. A panel that showed all skills when it did not know the workspace
 * would be more permissive than the thing it is reporting on.
 */
export function scopeConsoleLayers<T extends ScopableSkillRecord>(input: {
  skills: readonly T[]
  workspace: string
  memoryDir: string
  knowledgeDir: string
}): ConsoleScoping<T> {
  const scoped = input.skills.filter((record) =>
    memoryAllowsWorkspace({ scope: record.scope, workspace: record.workspace, current: input.workspace }),
  )
  return {
    skills: scoped,
    skillsScope: 'filtered by workspace (same predicate retrieval uses)',
    memoryScope: `directory: ${input.memoryDir}`,
    knowledgeScope: `directory: ${input.knowledgeDir}`,
    graphScope: `directory: ${input.memoryDir}/task-graph.json`,
  }
}
