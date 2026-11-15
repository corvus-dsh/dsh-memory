/**
 * ── 工作区的 commit 归属：按分钟缓存，失败时回落到空串 ──────────────────────────────────────────
 *
 * 从 `retrieve.ts` 搬出的 5 个声明（33 行 + 族说明注释）。
 *
 * ── 为什么这 5 个一起搬（判据是「谁在写它」）──────────────────────────────────────────────────
 *
 * `commitCache` 是 `const Map`，被 `currentCommitOf`（.get / .set）与 `clearCommitCache`
 * （.clear）**同模块**变异。所以**状态与它的变异者必须同处一个模块** —— 与
 * `retrieve/storage-tier.ts` 的三个 `let`、A1-2 的 `shapeCache` 是同一条判据。
 *
 * `sameCommit` 不碰缓存（纯字符串比较），但它与 `currentCommitOf` 是同一个概念的读与比，
 * 且唯一消费者 `scoreDocuments` 同时用它们两个 —— 留一个搬一个会把调用点拆到两个模块。
 *
 * ── COMMIT_DRIFT_WEIGHT 为什么也在这 ────────────────────────────────────────────────────────────
 *
 * 它物理上夹在 `commitCache`(L336) 与 `currentCommitOf`(L339) 之间。按依赖它属 `scoreDocuments`
 * （唯一使用点 `L1055`），但把它留下会把本族切成两段，且它只在漂移判定的计算里出现一次。
 * 所以一起搬、并 re-export 回 `retrieve.ts` 供 `scoreDocuments` 使用。
 *
 * ── 依赖方向 ────────────────────────────────────────────────────────────────────────────────────
 *
 * 对 `retrieve.ts` 零值依赖；只需 `execFileSync`（node:child_process）。
 * 因此不参与任何运行期循环。
 */

import { execFileSync } from 'node:child_process'

/**
 * v0.32 P1 — THE COMMIT A WORKSPACE IS AT, cached per minute.
 *
 * Retrieval runs on every pre-step, so this must stay cheap: one `git rev-parse` per
 * workspace per minute, never per turn, and an empty string on any failure. An unknown
 * commit means NO demotion — an unanswerable question must not silently mark every
 * memory as stale.
 */
const commitCache = new Map<string, { at: number; hash: string }>()
export const COMMIT_DRIFT_WEIGHT = 0.45

export function currentCommitOf(workspace: string): string {
  if (workspace.length === 0) return ''
  const cached = commitCache.get(workspace)
  const now = Date.now()
  if (cached !== undefined && now - cached.at < 60_000) return cached.hash
  let hash = ''
  try {
    const output = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 1_500,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const trimmed = String(output).trim().toLowerCase()
    hash = /^[0-9a-f]{7,40}$/u.test(trimmed) ? trimmed : ''
  } catch {
    hash = ''
  }
  commitCache.set(workspace, { at: now, hash })
  return hash
}

/** Test seam: forget cached commits. */
export function clearCommitCache(): void {
  commitCache.clear()
}

/**
 * Same commit? Compare on the short prefix, because a file may record either form.
 *
 * 导出：`retrieve.ts` 的 `scoreDocuments` 是它的唯一调用者（L961），搬走后必须能 import。
 * 它**不在** `lib/retrieve.js` 的运行时导出面上（原来就是模块私有），
 * 所以 `retrieve.ts` 只 import、不 re-export。
 */
export function sameCommit(left: string, right: string): boolean {
  const a = left.toLowerCase()
  const b = right.toLowerCase()
  const width = Math.min(a.length, b.length)
  if (width < 7) return false
  return a.slice(0, width) === b.slice(0, width)
}
