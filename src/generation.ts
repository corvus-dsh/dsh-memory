/**
 * ── GENERATION DOWNGRADE: "THIS CAME FROM A CODEBASE THAT HAS MOVED ON" ────────────────────────
 *
 * B3 的第 5 条（`b3-f8`「N 代未引用降级」）挂了很久，一直**没有任何判据**。按收口派工单的要求，
 * 先写判据再写码 —— 两个定义必须在代码之前定死，否则「N 代」会变成一个谁都能解释的数字。
 *
 * ── 定义 1：何谓「一代」 ──────────────────────────────────────────────────────────────────────
 *
 * 以 **memory 自己记录的 `generation`** 为准：`SKILL.md` / JSONL 行上的 `generation` 字段，
 * harvest 时从 `.graft-targets.json` 读出并写进记录（`index.ts` 的 meta 组装处）。
 *
 * 不用 graph history 的 `author.generation`，也不用 session 的 `auto-graft-*` 段：
 * 那两处是**别的系统的账**，读它们等于给「第几代」造第二个真相源 —— observer 已经证明过
 * 「跨代事实不能有第二个真相源」。这里只读 memory 自己写入的那个数。
 *
 * 「当前是第几代」也不是这里重新发明的：`readCurrentGeneration` 读的是**同一个**
 * `.graft-targets.json`，取最大值。读不到就是 0 = 未知，**未知不降级**。
 *
 * ── 定义 2：何谓「被引用」 ────────────────────────────────────────────────────────────────────
 *
 * 与 `memory_stats` 的四个来源**同一口径**（`src/store.ts: stats()`）：技能目录、`negatives.jsonl`、
 * `facts.jsonl`、`experiences.jsonl`。一条记录算「被引用过」，当且仅当它自己身上有痕迹：
 *
 *   · 技能：`last_used` 非空（被注入过一次），或 `sources > 1`（被两次独立确认）；
 *   · 负知识：`hits > 1`（这个坑又发生过一次）；
 *   · facts / experiences：**没有引用计数**，所以它们的 `referenced` 是 `undefined` = 未知，
 *     而未知永远不降级。
 *
 * 「被引用」不是「被读」，也不是「被 grep 到」—— 是这套系统自己记下的使用痕迹。用别的东西代理
 * 它（比如文件 mtime）会让「谁用过」变成猜测。
 *
 * ── 形态：降级不是删除 ──────────────────────────────────────────────────────────────────────
 *
 * 降级 = 乘一个权重（`GENERATION_DOWNGRADE_WEIGHT`），并在提示前缀里**写明原因**
 * （`[N 代未被引用]`）。文件不动、记录不删、可逆：任何一个后续引用都会让 `referenced` 变真，
 * 下一轮它就不再被降级。这与 TD-M7 的「写明领域不符」是同一条原则。
 *
 * ── 为什么默认 `never` ──────────────────────────────────────────────────────────────────────
 *
 * 真实 store 的样本量不足以定 N（见 `docs/gen-downgrade.md` 的实测），而「拍一个 N」正是派工单
 * 明令禁止的。所以机制实现、默认关闭（`DEFAULT_GENERATION_MODE = 'never'`），与既有行为逐字相同；
 * 打开需要**同时**给出 mode='always' 与一个 N（`generationMin`）。少给一个就什么都不发生 ——
 * 这不是保守，是不许一个没定的阈值悄悄生效。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** How the downgrade may act. `never` is the default and keeps current behaviour exactly. */
export type GenerationMode = 'never' | 'always' | 'manual-only'

export const DEFAULT_GENERATION_MODE: GenerationMode = 'never'

/** What a memory from N generations ago keeps of its weight. Not lower: it is still evidence. */
export const GENERATION_DOWNGRADE_WEIGHT = 0.5

export interface GenerationDowngrade {
  /** True only when every condition held — see `generationDowngradeFor`. */
  downgrade: boolean
  weight: number
  /** How many generations behind the current one this record is (0 when it cannot be compared). */
  behind: number
  /** The hint prefix when downgraded; '' otherwise. */
  reason: string
}

const NONE: GenerationDowngrade = { downgrade: false, weight: 1, behind: 0, reason: '' }

/**
 * Is this record "referenced"? The four shapes are the ones the store actually records — see the
 * definition above. `undefined` means "this kind of record has no usage counter", which is NOT the
 * same as "never used".
 */
export function isReferenced(item: { lastUsed?: string; hits?: number; sources?: number }): boolean | undefined {
  /**
   * FIRST QUESTION: does this shape carry a counter AT ALL?
   *
   * `last_used` / `sources` are written on every SKILL.md (`renderSkill` always emits both), so a
   * skill's answer is always a boolean. `hits` exists only on negatives, and facts/experiences
   * carry neither — for those the answer is `undefined` = UNKNOWN, which is a different statement
   * from "never used".
   */
  const hasLastUsed = typeof item.lastUsed === 'string'
  const hasHits = Number.isFinite(item.hits)
  const hasSources = Number.isFinite(item.sources)
  if (!hasLastUsed && !hasHits && !hasSources) return undefined
  if (hasLastUsed && item.lastUsed !== undefined && item.lastUsed.trim().length > 0) return true
  if (hasHits && Number(item.hits) > 1) return true
  if (hasSources && Number(item.sources) > 1) return true
  return false
}

/**
 * The whole rule, in one place.
 *
 * `mode` is checked FIRST because it is the switch that keeps this feature from changing any
 * behaviour until someone turns it on and names N. `minGenerations` must be a positive integer:
 * `0` or `undefined` means "N has not been decided", which can never demote anything.
 */
export function generationDowngradeFor(
  item: { generation?: number; referenced?: boolean },
  options: { currentGeneration?: number; minGenerations?: number; mode?: GenerationMode } = {},
): GenerationDowngrade {
  const mode = options.mode ?? DEFAULT_GENERATION_MODE
  if (mode !== 'always') return NONE
  const min = Number(options.minGenerations)
  if (!Number.isFinite(min) || min <= 0) return NONE
  const current = Number(options.currentGeneration)
  const recorded = Number(item.generation)
  if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(recorded) || recorded <= 0) return NONE
  const behind = Math.trunc(current) - Math.trunc(recorded)
  if (behind < min) return NONE
  /**
   * `referenced === false` — NOT `!referenced`. A record whose usage counter does not exist
   * (facts / experiences) is UNKNOWN, and demoting on an unknown would be an accusation nobody
   * could check.
   */
  if (item.referenced !== false) return NONE
  return { downgrade: true, weight: GENERATION_DOWNGRADE_WEIGHT, behind, reason: `[${behind} 代未被引用]` }
}

/**
 * The latest generation the store wrote for any session, or 0 when it cannot be read.
 *
 * It reads `.graft-targets.json` — the SAME file the harvest path writes `generation` from, so
 * "current" and "recorded" are measured on one scale. A missing or torn file is 0 = unknown, and
 * unknown never demotes.
 */
export function readCurrentGeneration(graftDataDir: string): number {
  try {
    const parsed = JSON.parse(readFileSync(join(graftDataDir, '.graft-targets.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return 0
    let max = 0
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      const generation = Number((value as { generation?: unknown })?.generation)
      if (Number.isFinite(generation) && generation > max) max = Math.trunc(generation)
    }
    return max
  } catch {
    return 0
  }
}