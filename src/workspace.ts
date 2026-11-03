/**
 * v0.8 WORKSPACE ISOLATION: a memory may only be injected into the workspace that
 * produced it.
 *
 * THE FAILURE THIS EXISTS FOR
 *
 * Capability memory is stored in ONE global directory (`~/.agents/skills`) because
 * DSH's own skill loader scans exactly that path. Retrieval, however, runs inside
 * whatever session happens to be open. Measured live: after a handoff storm, a
 * session working in `D:\持久层能力架构` was fed a constraint extracted in another
 * project — "立刻删除 D:\持久层能力架构\repair-log.cjs" was still sitting in the
 * migrated constraint block long after that file stopped existing, and unrelated
 * skills from three other repositories competed for the same trigger words.
 * Lexical similarity cannot see a workspace boundary, so the boundary has to be
 * carried in the record and checked at retrieval time.
 *
 * THE RULE
 *
 *   1. Every memory written from a session records the session's cwd as
 *      `workspace` (frontmatter for SKILL.md, a field for the JSONL layers).
 *   2. At retrieval, a memory is eligible only when its `scope` is `global`, or
 *      its recorded `workspace` is byte-equal (after normalization) to the
 *      current one.
 *   3. Anything else — a foreign workspace, an unscoped legacy record, or a call
 *      that cannot state its own workspace — is refused. "Cannot prove it is
 *      mine" is not "probably mine": the cost of a wrong recall is a wrong
 *      ACTION, and this module is the last gate before injection.
 *
 * The workspace is provenance, never model output: it comes from the session log
 * header, so an injected prompt cannot forge it.
 */

/**
 * Canonical form for storage and display: forward slashes, no trailing slash, no
 * `\\?\` prefix. Case is PRESERVED here — a path is also read by a human in the
 * SKILL.md frontmatter, and `D:/项目A` is the path the user typed. Comparison
 * folds case separately, and only where the filesystem does (see `workspaceKey`).
 */
export function normalizeWorkspace(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  let value = raw.trim().replace(/^["']|["']$/gu, '')
  if (value.length === 0) return ''
  // `\\?\C:\long\path` is the Win32 long-path form of the same directory.
  value = value.replace(/^\\\\\?\\/u, '')
  value = value.replace(/\\/gu, '/')
  if (value.length > 1) value = value.replace(/\/+$/u, '')
  return value
}

/**
 * The comparison key. Windows paths (drive-letter, UNC, or any path on a Windows
 * host) are case-insensitive; a POSIX path is not, because `/Home/a` and
 * `/home/a` are genuinely different directories there.
 */
function workspaceKey(value: string): string {
  if (value.length === 0) return ''
  const looksWindows = /^[a-z]:\//iu.test(value) || value.startsWith('//')
  return looksWindows || process.platform === 'win32' ? value.toLowerCase() : value
}

/** Two paths denote the same workspace. Empty never equals anything, not even empty. */
export function sameWorkspace(left: unknown, right: unknown): boolean {
  const a = workspaceKey(normalizeWorkspace(left))
  const b = workspaceKey(normalizeWorkspace(right))
  if (a.length === 0 || b.length === 0) return false
  return a === b
}

export interface WorkspaceDecisionInput {
  /** The memory's `scope` frontmatter: workspace / project / global. */
  scope?: string
  /** The workspace recorded when the memory was written. */
  workspace?: string
  /** The workspace of the session asking for the memory. */
  current?: string
}

/**
 * The single decision point used by retrieval. `global` is the ONLY way a memory
 * escapes its workspace, and it has to be written down deliberately.
 */
export function memoryAllowsWorkspace(input: WorkspaceDecisionInput): boolean {
  const scope = String(input.scope ?? 'project').trim().toLowerCase()
  if (scope === 'global') return true
  const current = normalizeWorkspace(input.current)
  if (current.length === 0) return false
  const recorded = normalizeWorkspace(input.workspace)
  if (recorded.length === 0) return false
  return sameWorkspace(recorded, current)
}

/**
 * The workspace a finished session ran in. Read from the log header, so it is
 * provenance: `session.cwd` in the v4 format, with the older flat shapes accepted
 * so a legacy caller is not silently treated as unscoped.
 */
export function workspaceOfSession(log: unknown): string {
  if (log === null || typeof log !== 'object') return ''
  const record = log as Record<string, unknown>
  const session = (record.session !== null && typeof record.session === 'object' ? record.session : record) as Record<string, unknown>
  for (const key of ['cwd', 'workspace', 'workingDirectory']) {
    const value = session[key]
    if (typeof value === 'string' && value.trim().length > 0) return normalizeWorkspace(value)
  }
  for (const key of ['cwd', 'workspace']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return normalizeWorkspace(value)
  }
  return ''
}

/**
 * The workspace of a live turn. `agent/pre-step` payloads carry the agent (and,
 * on the desktop host, its cwd); `process.cwd()` is the last resort so that the
 * gate is never silently switched OFF — an unknown workspace must fail closed,
 * not open.
 */
export function currentWorkspaceOf(payload: unknown, fallback?: string): string {
  const fromAgent = (() => {
    if (payload === null || typeof payload !== 'object') return ''
    const agent = (payload as Record<string, unknown>).agent
    if (agent === null || typeof agent !== 'object') return ''
    for (const key of ['cwd', 'workspace', 'workingDirectory']) {
      const value = (agent as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.trim().length > 0) return value
    }
    return ''
  })()
  if (fromAgent.length > 0) return normalizeWorkspace(fromAgent)
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    for (const key of ['cwd', 'workspace']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim().length > 0) return normalizeWorkspace(value)
    }
  }
  if (typeof fallback === 'string' && fallback.trim().length > 0) return normalizeWorkspace(fallback)
  return normalizeWorkspace(process.cwd())
}
