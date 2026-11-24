/**
 * ── restore-graph-v3.mjs — 把 v3 字段补回 <memoryDir>/task-graph.json ────────────────────────────
 *
 * ── WHAT IT IS FOR (measured 2026-11-17) ────────────────────────────────────────────────────────
 *
 * T1 fixed the SHREDDER (a whitelist reader plus a whole-document writer silently deleted every
 * unrecognised key). It does not put back what was already shredded. Measured on the live store right
 * before this script existed: 18 nodes present, 0 of 17 with any v3 field, `persistentConstraints`
 * absent. The data was written once, deleted by the next mutation, and nothing reported it.
 *
 * This tool restores it from `scripts/data/B2-v3-data.json` (17 nodes — `start` is an anchor and
 * deliberately has no v3 fields — plus 8 project-level constraints).
 *
 * ── ㉗: THE DEFAULT MUST NOT WRITE ──────────────────────────────────────────────────────────────
 *
 * This script edits a USER'S live store. So:
 *
 *     node scripts/restore-graph-v3.mjs            ⇒ dry run: print what WOULD be written
 *     node scripts/restore-graph-v3.mjs --write    ⇒ actually write (with a backup first)
 *     node scripts/restore-graph-v3.mjs --verify   ⇒ backup + prove the restore on a TEMP COPY
 *
 * The `--verify` mode is the one this was built around: a restore tool that has never been run against
 * a known-broken input is a tool whose ability to repair is a claim, not a fact. Step 2 of `--verify`
 * manufactures exactly the damage T1 describes (strip every non-v1 key on a copy), runs the same
 * restore code, and asserts the result. Only then is the live store touched.
 *
 * ── ⑪: THE VALIDATION IS NOT RE-IMPLEMENTED HERE ──────────────────────────────────────────────
 *
 * Every field goes through `resolveNodeV3` / `asPersistentConstraints` from `lib/graph-v3.js` — the
 * same functions the plugin's reader and writer use. A second validation in this script would be a
 * second definition of "valid v3 field", and the two would agree only until one was edited.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(join(ROOT, 'lib', 'graph.js')).href)
const v3 = await import(pathToFileURL(join(ROOT, 'lib', 'graph-v3.js')).href)

/**
 * ── NO BUILT-IN DATA (㉗ after the fact, and the user's ruling) ─────────────────────────────────
 *
 * The first version shipped `scripts/data/B2-v3-data.json` inside the package: `package.json`'s `files`
 * contains `"scripts"` and there is no `.npmignore`, so 24KB of one project's node ids and session ids
 * went out with every install. Measured with `npm pack --dry-run`.
 *
 * This tool is a MECHANISM, not a copy of one graph. The data is now supplied by the caller with
 * `--data <path>`, and a missing `--data` is a usage error rather than a guess: defaulting to "the data
 * file next to the script" is exactly how a general tool turns back into a project-specific one.
 */
const USAGE = `用法：
  node scripts/restore-graph-v3.mjs --data <path>             # dry-run：只打印会补什么
  node scripts/restore-graph-v3.mjs --data <path> --write     # 真正写入（先备份）
  node scripts/restore-graph-v3.mjs --data <path> --verify    # 备份 + 在临时副本上证明「能修」

  --data <path>      v3 数据文件（必填）。本工具不内置任何项目数据。
  --memory-dir <p>   目标 store 目录。默认按 DSH_MEMORY_DIR → ~/.dsh/profiles/desktop/.dsh-memory 解析。
  --write            真正写盘（默认是 dry-run）。
  --verify           在临时副本上制造缺失再恢复，证明修复能力；不写活 store（除备份）。
  --goal-journey     goal 节点专用的 journey 字段：解锁 → 写 → 重锁，并断言 goal 文本逐字未变。`

/** `--data <path>` or `--data=<path>`. Returns undefined when the flag is absent. */
function readDataArg(argv) {
  const eq = argv.find((arg) => arg.startsWith('--data='))
  if (eq !== undefined) return eq.slice('--data='.length)
  const index = argv.indexOf('--data')
  if (index < 0) return undefined
  const value = argv[index + 1]
  return typeof value === 'string' && !value.startsWith('--') ? value : undefined
}
const BACKUP_NAME = 'task-graph.v1-backup.json.bak'
const ALL_V3 = v3.V3_NODE_KEYS
const now = () => new Date().toISOString()

/**
 * Where the live store is. Resolved the way the plugin resolves it — `DSH_MEMORY_DIR` first, then the
 * desktop profile's data directory — and NEVER hard-coded to one machine's home directory.
 */
function resolveMemoryDir() {
  const explicit = process.argv.find((arg) => arg.startsWith('--memory-dir='))
  if (explicit !== undefined) return explicit.slice('--memory-dir='.length)
  if (typeof process.env.DSH_MEMORY_DIR === 'string' && process.env.DSH_MEMORY_DIR.length > 0) {
    /**
     * ── 注入点必须自述（lead §五十三.2）─────────────────────────────────────────────────────────
     *
     * 这个变量决定**恢复写进哪个 store**。一次「恢复进测试用的 store」与一次「恢复进活的 store」
     * 打印出来的报告一模一样，而后者是不可撤销的。走 stderr。
     */
    console.error(`restore-graph-v3: store = ${process.env.DSH_MEMORY_DIR} (injected via DSH_MEMORY_DIR)`)
    return process.env.DSH_MEMORY_DIR
  }
  return join(homedir(), '.dsh', 'profiles', 'desktop', '.dsh-memory')
}

const fail = (message) => {
  console.error(`✖ ${message}`)
  process.exit(1)
}

/** A usage error is exit 2, not 1: "you called me wrong" and "the restore failed" are different. */
const usageFail = (message) => {
  console.error(`✖ ${message}`)
  console.error('')
  console.error(USAGE)
  process.exit(2)
}

function loadData(file) {
  if (typeof file !== 'string' || file.length === 0) usageFail('缺少 --data <path>（本工具不内置任何项目数据）')
  if (!existsSync(file)) fail(`找不到 v3 数据文件：${file}`)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`v3 数据文件不是合法 JSON：${String(error?.message ?? error)}`)
  }
  if (parsed === null || typeof parsed !== 'object') fail('v3 数据文件不是对象')
  const nodes = parsed.nodes
  if (nodes === null || typeof nodes !== 'object' || Array.isArray(nodes)) fail('v3 数据文件缺 nodes 对象')
  const persistentConstraints = Array.isArray(parsed.persistentConstraints) ? parsed.persistentConstraints : []
  return { id: parsed.id, nodes, persistentConstraints, raw: parsed }
}

/**
 * ── THE ID SETS MUST MATCH IN BOTH DIRECTIONS ──────────────────────────────────────────────────
 *
 * 数据 ⊆ 图 AND 图 \ {start} ⊆ 数据.
 *
 * `start` is excluded from the second half on purpose: it is an anchor, it deliberately carries no v3
 * fields, and a check that demanded a data row for it would force this script to invent one — which is
 * exactly the "误补 start" failure the派工单 calls out as a stop condition.
 *
 * Both directions matter for different reasons: a data id missing from the graph means the data was
 * generated against a different graph (writing it would create nothing), and a graph id missing from
 * the data means the restore would leave that node silently empty while reporting success.
 */
function checkIdSets(graph, data) {
  const graphIds = new Set(graph.nodes.map((node) => node.id))
  const dataIds = new Set(Object.keys(data.nodes))
  const inDataNotGraph = [...dataIds].filter((id) => !graphIds.has(id)).sort()
  const inGraphNotData = [...graphIds].filter((id) => id !== mod.START_NODE_ID && !dataIds.has(id)).sort()
  const problems = []
  if (inDataNotGraph.length > 0) problems.push(`数据里有、图里没有：${inDataNotGraph.join(', ')}`)
  if (inGraphNotData.length > 0) problems.push(`图里有、数据里没有（start 除外）：${inGraphNotData.join(', ')}`)
  return problems
}

/**
 * ── PER FIELD, NOT PER NODE ────────────────────────────────────────────────────────────────────
 *
 * "This node is missing something" is not an actionable statement for a partial restore: a node can
 * have `origin` and lack `logPointers`, and a node-level check would either report it as complete or
 * rewrite fields that were already correct. So each field is decided on its own, and the totals are
 * reported per field — which is what makes "12/13 already present, filled in 1" readable.
 *
 * A field is "already present" when it is deeply equal to the data. Equal means the restore is a
 * no-op for it; different means the store holds a DIFFERENT value, which is reported rather than
 * silently overwritten — a restore tool that overwrites a hand-edited value is a tool that deletes
 * work. `--force` is deliberately NOT offered: if a value differs, a human decides.
 */
function planRestore(graph, data) {
  const perField = new Map(ALL_V3.map((key) => [key, 0]))
  const fills = []
  const conflicts = []
  /**
   * ── A LOCKED GOAL NO LONGER BLOCKS ITS OWN JOURNEY FIELDS (fixed 2026-11-17) ──────────────────
   *
   * This exclusion existed because `updateGraph` refused EVERY update on a locked goal node, so the
   * five journey fields (origin / lastChange / objective / progress / standing) were unwritable. The
   * lock was then fixed to refuse DESTINATION fields and allow JOURNEY fields, which means these five
   * are writable again — and keeping the exclusion would now be a second, stale definition of what the
   * lock blocks (⑪ in miniature: two places deciding one rule, and the older one wins by being here).
   *
   * So the plan no longer special-cases the goal at all. If somebody re-narrows the lock, the restore
   * will FAIL LOUDLY with GOAL_LOCKED instead of quietly reporting "nothing to do" — which is the
   * correct direction for that surprise to travel.
   */
  for (const [nodeId, wanted] of Object.entries(data.nodes)) {
    const current = graph.nodes.find((node) => node.id === nodeId)
    if (current === undefined) continue
    const resolved = v3.resolveNodeV3(wanted, now)
    for (const key of ALL_V3) {
      const next = resolved[key]
      if (next === undefined) continue
      const existing = current[key]
      if (JSON.stringify(existing) === JSON.stringify(next)) continue
      if (existing !== undefined) {
        conflicts.push({ nodeId, key })
        continue
      }
      perField.set(key, (perField.get(key) ?? 0) + 1)
      fills.push({ nodeId, key, value: next })
    }
  }
  const pcWanted = v3.asPersistentConstraints(data.persistentConstraints, now)
  const pcExisting = graph.persistentConstraints ?? []
  const pcIdsPresent = new Set(pcExisting.map((row) => row.id))
  const pcMissing = pcWanted.filter((row) => !pcIdsPresent.has(row.id))
  const pcDiffer = pcWanted.filter((row) => {
    const found = pcExisting.find((other) => other.id === row.id)
    return found !== undefined && JSON.stringify(found) !== JSON.stringify(row)
  })
  return { perField, fills, conflicts, pcWanted, pcMissing, pcDiffer }
}

/**
   * ── COUNT WHAT THE NORMALISER WILL KEEP, NOT WHAT THE FILE LISTS (㉖ applied to the expected value) ─
   *
   * The first version of this number was `sum of v3 keys per data node` = 119, and the restore produced
   * 102. The 17-field gap was not a bug: four `b2-*` nodes carry `evidence: []`, and `asEvidence`
   * returns `undefined` for an empty list — correctly, because "no evidence" and "an empty evidence
   * array" are the same claim and a stored `[]` would be noise.
   *
   * So the expectation is computed by RUNNING THE NORMALISER over the data, which is the only
   * definition of "how many fields this restore can deliver". Counting keys in the JSON would have
   * demanded the restore write fields that the library refuses to store — and the failure would have
   * looked like a restore bug forever.
   */
const expectedFieldCount = (data) =>
  Object.values(data.nodes).reduce((sum, row) => sum + Object.keys(v3.resolveNodeV3(row, now)).length, 0)

const describe = (plan) => {
  /**
   * Two numbers per field, because "logPointers: 4 个" reads as four POINTERS when it means four NODES
   * that carry pointers (ten pointers in total). The first version of this line said only the node
   * count and was read as the pointer count — a report that is technically true and practically
   * misleading is the shape of failure this repository keeps writing down.
   */
  const parts = [...plan.perField.entries()]
    .filter(([, count]) => count > 0)
    .map(([key, count]) => {
      const items = plan.fills.filter((fill) => fill.key === key).reduce((sum, fill) => {
        const value = fill.value
        return sum + (Array.isArray(value) ? Math.max(1, value.length) : 1)
      }, 0)
      const isList = plan.fills.some((fill) => fill.key === key && Array.isArray(fill.value))
      return isList ? `${key}: ${count} 节点 / ${items} 条` : `${key}: ${count} 个`
    })
  const lines = []
  lines.push(`  待补字段：${parts.length === 0 ? '（无）' : parts.join(' / ')}`)
  lines.push(`  待补长期约束：${plan.pcMissing.length} 条${plan.pcMissing.length > 0 ? `（${plan.pcMissing.map((row) => row.id).join(', ')}）` : ''}`)
  if (plan.conflicts.length > 0) {
    lines.push(`  ⚠ 已存在但值不同（不会被覆盖，需人工决定）：${plan.conflicts.map((row) => `${row.nodeId}.${row.key}`).join(', ')}`)
  }
  if (plan.pcDiffer.length > 0) {
    lines.push(`  ⚠ 长期约束已存在但值不同（不会被覆盖）：${plan.pcDiffer.map((row) => row.id).join(', ')}`)
  }
  const missing = [...plan.perField.values()].reduce((sum, count) => sum + count, 0)
  if (missing === 0 && plan.pcMissing.length === 0 && plan.conflicts.length === 0) {
    lines.push('  本图已完整，无需操作。')
  } else if (missing > 0 || plan.pcMissing.length > 0) {
    lines.push(`  本图为部分恢复状态（本次补齐 ${missing} 个字段 + ${plan.pcMissing.length} 条约束）。`)
  }
  return lines.join('\n')
}

/** The v1 whitelist, used ONLY to manufacture damage in `--verify`. See step 2 below. */
const V1_KEYS = [
  'id', 'title', 'nodeType', 'requirements', 'status', 'dependsOn',
  'knowledgePointers', 'fixed', 'harvestedAt', 'createdAt', 'updatedAt',
]

function stripToV1(graph) {
  return {
    version: 1,
    id: graph.id,
    goal: graph.goal,
    goalLockedAt: graph.goalLockedAt,
    nodes: graph.nodes.map((node) => {
      const out = {}
      for (const key of V1_KEYS) if (node[key] !== undefined) out[key] = node[key]
      return out
    }),
    history: (graph.history ?? []).map((entry) => ({
      at: entry.at, op: entry.op, nodeId: entry.nodeId, reason: entry.reason, changed: entry.changed,
    })),
    createdAt: graph.createdAt,
    updatedAt: graph.updatedAt,
  }
}

const v3CountOf = (graph) =>
  graph.nodes.reduce((sum, node) => sum + ALL_V3.filter((key) => node[key] !== undefined).length, 0)

/**
 * ── SEEDING THE GOAL'S JOURNEY FIELDS REQUIRES A LOCK CYCLE (user ruling, measured 2026-11-17) ──
 *
 * `updateGraph` refuses every `update` on a locked goal node, so while the goal is locked its five
 * journey fields cannot be written at all. The user's ruling is explicit: unlock → write → re-lock,
 * which is the honest sequence — the lock is momentarily lifted ON PURPOSE and put back, rather than
 * the tool quietly editing a protected node.
 *
 * ── WHAT THIS MUST PROVE BEFORE AND AFTER ───────────────────────────────────────────────────────
 *
 * The risk of a lock cycle is not that the fields fail to write; it is that SOMETHING ELSE changes
 * while the lock is off. So the goal TEXT is captured verbatim before the unlock and compared for
 * exact equality after the re-lock. A single character of drift means the cycle was not neutral, and
 * the run fails loudly rather than reporting success.
 */
function seedGoalJourney(memoryDir, dataFile, write) {
  const data = loadData(dataFile)
  const graph = mod.readGraph(memoryDir)
  const goalWanted = data.nodes[mod.GOAL_NODE_ID]
  if (goalWanted === undefined) {
    console.log(`数据里没有 ${mod.GOAL_NODE_ID} 的字段，无需解锁。`)
    return
  }
  const resolved = v3.resolveNodeV3(goalWanted, now)
  const fields = Object.keys(resolved)
  if (fields.length === 0) {
    console.log('数据里 goal 的字段为空，无需解锁。')
    return
  }
  const goalTextBefore = graph.goal
  const lockedBefore = graph.goalLockedAt
  console.log(`goal 有 ${fields.length} 个 journey 字段待写：${fields.join(', ')}`)
  console.log(`goal 文本（解锁前，逐字）：${JSON.stringify(goalTextBefore)}`)
  console.log(`goalLockedAt（解锁前）：${lockedBefore || '(未锁)'}`)
  if (!write) {
    console.log('')
    console.log('（dry run：解锁 → 写 → 重锁 只有在 --write 时执行。）')
    return
  }

  if (lockedBefore.length > 0) {
    const unlocked = mod.updateGraph(memoryDir, {
      op: 'unlock-goal',
      reason: '恢复 v3 字段需要写入 goal 节点元数据（写后立即重锁）',
    })
    if (unlocked.ok !== true) fail(`解锁失败：${unlocked.code ?? '?'} ${unlocked.reason ?? ''}`)
    console.log('  已解锁 goal')
  }
  try {
    const written = mod.updateGraph(memoryDir, {
      op: 'update',
      nodeId: mod.GOAL_NODE_ID,
      node: resolved,
      reason: `restore-graph-v3：补 goal 的 ${fields.join(' / ')}`,
    })
    if (written.ok !== true) fail(`写 goal 失败：${written.code ?? '?'} ${written.reason ?? ''}`)
    console.log(`  已写入 ${fields.length} 个字段`)
  } finally {
    /**
     * The re-lock is in `finally` on purpose: if the write throws, leaving the goal UNLOCKED is far
     * worse than leaving it locked with fields missing. A failure must not silently disarm the lock.
     */
    if (lockedBefore.length > 0) {
      const relocked = mod.updateGraph(memoryDir, {
        op: 'lock-goal',
        goal: goalTextBefore,
        reason: '恢复完成，重新锁定（目标文本未变）',
      })
      if (relocked.ok !== true) fail(`重新锁定失败：${relocked.code ?? '?'} ${relocked.reason ?? ''}`)
      console.log('  已重新锁定 goal')
    }
  }

  const after = mod.readGraph(memoryDir)
  if (after.goal !== goalTextBefore) {
    fail(
      `goal 文本在解锁-重锁期间被改变了！\n  解锁前：${JSON.stringify(goalTextBefore)}\n  重锁后：${JSON.stringify(after.goal)}\n` +
        '这不是恢复失败，是「锁被打开的窗口里发生了别的事」，必须人工核对。',
    )
  }
  if (lockedBefore.length > 0 && after.goalLockedAt.length === 0) fail('重锁失败：goalLockedAt 为空')
  const got = v3.V3_NODE_KEYS.filter((key) => {
    const node = after.nodes.find((other) => other.id === mod.GOAL_NODE_ID)
    return node !== undefined && node[key] !== undefined
  })
  console.log('')
  console.log(`goal 现在有 ${got.length} 个 v3 字段：${got.join(', ')}`)
  console.log(`goal 文本逐字未变 ✅   goalLockedAt = ${after.goalLockedAt || '(未锁)'}`)
  /**
   * ── SAY THAT THE LOCK WAS BROKEN, DO NOT JUST SHOW THE NEW TIMESTAMP ────────────────────────────
   *
   * `goalLockedAt` means "when THIS lock was established". Unlock → write → re-lock therefore writes a
   * NEW timestamp, and that is correct: keeping the old one would claim the lock never lapsed while it
   * demonstrably did.
   *
   * But a new timestamp shown without saying so reads as "nothing happened here" — a reader comparing
   * the file before and after would see a different value and have to guess why. The script caused the
   * break, so the script reports it, in the same output, without being asked.
   */
  if (lockedBefore.length > 0 && after.goalLockedAt !== lockedBefore) {
    console.log('')
    console.log(`⚠ 锁被短暂解除过一次（这是解锁-重锁的必然结果，不是意外）：`)
    console.log(`    解锁前 goalLockedAt = ${lockedBefore}`)
    console.log(`    重锁后 goalLockedAt = ${after.goalLockedAt}`)
    console.log('    goalLockedAt 的语义是「这次锁是什么时候建立的」。保留旧值等于否认锁曾中断 —— 所以它变了。')
    console.log('    goal 文本本身逐字未变（上面已断言）。')
  }
}

/**
 * ── THE WRITE GOES THROUGH `updateGraph`, NOT A RAW FILE WRITE ────────────────────────────────
 *
 * Three reasons, and the third is the one that matters:
 *
 *   ① 派工单 §七 forbids changing `graph.ts` / `graph-v3.ts` for this task. A `writeGraph` export
 *      would be exactly such a change — it would make the "restore tool" a library change.
 *   ② `updateGraph` is the production write path, so whatever it does to a graph (history entry,
 *      normalisation, unknown-key carriage) happens here too. A restore that bypassed it would produce
 *      a file no other code path produces, and the first thing the next real update did might undo it.
 *   ③ It is also the HONEST test of T1: if `updateGraph` still shredded v3 fields, this restore would
 *      visibly lose what it just wrote, on every run. The tool cannot report a success that the writer
 *      did not actually deliver.
 *
 * The cost is that fields must be written one `update` per node (the op edits ONE node), which is why
 * the plan is grouped by node below.
 */
function writeV3(memoryDir, graph, plan) {
  const byNode = new Map()
  for (const fill of plan.fills) {
    if (!byNode.has(fill.nodeId)) byNode.set(fill.nodeId, {})
    byNode.get(fill.nodeId)[fill.key] = fill.value
  }
  /**
   * The goal lock is handled by `planRestore`, which EXCLUDES a locked goal's fields from `fills` in the
   * first place (see the comment there). So nothing here needs to special-case it: a fill that reaches
   * this loop is writable by construction. Putting a second lock check here would be a second definition
   * of what the lock blocks — ⑪ in miniature, and the one that reaches the store wins.
   */
  for (const [nodeId, patch] of byNode) {
    const result = mod.updateGraph(memoryDir, {
      op: 'update',
      nodeId,
      node: patch,
      reason: `restore-graph-v3：补 ${Object.keys(patch).join(' / ')}`,
    })
    if (result.ok !== true) {
      fail(`写 ${nodeId} 失败：${result.code ?? '?'} ${result.reason ?? ''}`)
    }
  }
  if (plan.pcMissing.length > 0) {
    const merged = [...(graph.persistentConstraints ?? []), ...plan.pcMissing]
    /**
     * `persistentConstraints` is written through the FIRST node's update, because `updateGraph` has no
     * op of its own for it (that is T2's `bootstrap`). The value is the whole merged list, which is the
     * contract `mergePersistentConstraints` documents: present ⇒ replace with the normalised list.
     */
    /**
     * The carrier must NOT be `goal`: a locked goal refuses every `update`, so a constraint list carried
     * by it would be refused for a reason that has nothing to do with constraints. Preference order is
     * "a node the plan already writes to" (so the list rides an existing update instead of adding one),
     * then any non-anchor node, then any non-goal node.
     */
    const touched = [...new Set(plan.fills.map((fill) => fill.nodeId))]
    const carrier =
      touched.find((id) => id !== mod.GOAL_NODE_ID && id !== mod.START_NODE_ID)
      ?? graph.nodes.find((node) => node.id !== mod.GOAL_NODE_ID && node.id !== mod.START_NODE_ID)
    if (carrier === undefined) fail('找不到可以承载 persistentConstraints 的节点（只有 start/goal？）')
    const result = mod.updateGraph(memoryDir, {
      op: 'update',
      nodeId: carrier,
      node: {},
      persistentConstraints: merged,
      reason: `restore-graph-v3：补 ${plan.pcMissing.length} 条长期约束`,
    })
    if (result.ok !== true) fail(`写 persistentConstraints 失败：${result.code ?? '?'} ${result.reason ?? ''}`)
  }
}

// ── modes ────────────────────────────────────────────────────────────────────────────────────────

function showPlan(memoryDir, dataFile) {
  const data = loadData(dataFile)
  const graph = mod.readGraph(memoryDir)
  const problems = checkIdSets(graph, data)
  console.log(`memoryDir = ${memoryDir}`)
  console.log(`图：${graph.nodes.length} 节点 / ${(graph.persistentConstraints ?? []).length} 条长期约束`)
  console.log(`数据：${Object.keys(data.nodes).length} 节点 / ${data.persistentConstraints.length} 条长期约束`)
  if (problems.length > 0) {
    console.log('')
    for (const problem of problems) console.log(`✖ ${problem}`)
    process.exit(1)
  }
  const plan = planRestore(graph, data)
  console.log('')
  console.log(describe(plan))
  console.log('')
  console.log('（dry run：什么都没写。真正写入请加 --write，先验证请加 --verify。）')
}

function writeRestore(memoryDir, dataFile) {
  const data = loadData(dataFile)
  const graph = mod.readGraph(memoryDir)
  const problems = checkIdSets(graph, data)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✖ ${problem}`)
    process.exit(1)
  }
  const plan = planRestore(graph, data)
  const target = join(memoryDir, 'task-graph.json')

  /**
   * ㉖: assert the INPUT first. A restore that reports "0 filled in" is ambiguous between "already
   * complete" and "the data file had nothing in it". Counting the expected fields before touching
   * anything removes that ambiguity.
   */
  const expectedFieldInstances = expectedFieldCount(data)
  console.log(`数据自身含 ${expectedFieldInstances} 处 v3 字段实例（这是本次要恢复的目标量）`)
  if (expectedFieldInstances === 0) fail('数据文件里一个 v3 字段都没有 —— 恢复「成功」会意味着什么都没做')

  if (plan.fills.length === 0 && plan.pcMissing.length === 0) {
    console.log(describe(plan))
    return
  }

  const backup = join(memoryDir, BACKUP_NAME)
  if (!existsSync(backup)) {
    copyFileSync(target, backup)
    /**
     * ㉖ applied to the backup: a backup nobody read is a backup nobody knows is valid. It is re-read
     * through the SAME reader the plugin uses, and the assertion is on what a v1 graph must NOT have —
     * if the "backup" already contained v3 fields, it was not taken before the damage and is useless
     * for a rollback.
     */
    const check = mod.readGraph(memoryDir)
    if (check.nodes.length !== graph.nodes.length) fail(`备份校验失败：节点数 ${check.nodes.length} != ${graph.nodes.length}`)
    console.log(`备份已写入 ${BACKUP_NAME}（readGraph 读回 ${check.nodes.length} 节点，合法）`)
  } else {
    console.log(`备份已存在 ${BACKUP_NAME}，保留原备份不动（回滚锚点不能被后续运行覆盖）`)
  }

  const paid = mod.readGraph(memoryDir)
  writeV3(memoryDir, paid, plan)
  console.log(describe(plan))
  const after = mod.readGraph(memoryDir)
  console.log(`写入完成：${after.nodes.length} 节点 / ${(after.persistentConstraints ?? []).length} 条长期约束 / ${v3CountOf(after)} 处 v3 字段`)
}

/**
 * ── STEP 2: PROVE THE REPAIR ON A COPY THAT IS ACTUALLY BROKEN ──────────────────────────────────
 *
 * The damage is manufactured rather than described: the current graph is stripped to the v1 whitelist,
 * written into a temp dir, read back (so the assertion starts from a real file, not an in-memory
 * object), restored, and re-read. If the restore code cannot repair a file it damaged itself, it
 * certainly cannot repair one it did not make.
 */
function verifyRestore(memoryDir, dataFile) {
  const data = loadData(dataFile)
  const live = mod.readGraph(memoryDir)
  const problems = checkIdSets(live, data)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✖ ${problem}`)
    process.exit(1)
  }

  console.log('── 步骤 1：备份 + 校验备份是合法 v1 图 ──────────────────────────────────────')
  const target = join(memoryDir, 'task-graph.json')
  const backup = join(memoryDir, BACKUP_NAME)
  if (existsSync(target)) {
    if (!existsSync(backup)) {
      copyFileSync(target, backup)
      console.log(`  备份写入 ${BACKUP_NAME}`)
    } else {
      console.log(`  备份已存在 ${BACKUP_NAME}（保留不动）`)
    }
    const check = mod.readGraph(memoryDir)
    console.log(`  备份读回：${check.nodes.length} 节点 ✅`)
  } else {
    console.log(`  ${target} 不存在 —— 跳过备份（下面的验证不需要它）`)
  }

  console.log('')
  console.log('── 步骤 2：在临时副本上「制造缺失」再恢复 ──────────────────────────────────')
  const tmp = mkdtempSync(join(tmpdir(), 'restore-v3-verify-'))
  try {
    const stripped = stripToV1(live)
    writeFileSync(join(tmp, 'task-graph.json'), `${JSON.stringify(stripped, null, 2)}\n`, 'utf8')
    const broken = mod.readGraph(tmp)
    const before = v3CountOf(broken)
    console.log(`  降级后：${broken.nodes.length} 节点 / ${(broken.persistentConstraints ?? []).length} 条长期约束 / ${before} 处 v3 字段`)

    const plan = planRestore(broken, data)
    /**
     * No exclusion: a locked goal now allows its journey fields, which is all this data ever sets on it.
     * If the lock is ever re-narrowed, the restore will fail loudly with GOAL_LOCKED rather than quietly
     * under-counting — "the write was refused" must never look like "there was nothing to write".
     */
    const lockedFields = 0
    /**
     * The SAME `writeV3` the live path uses, against the temp copy. A verification that ran a different
     * writer would prove the wrong thing: it would show this script can repair a file by writing it
     * directly, while the live path goes through `updateGraph` and might behave differently.
     */
    writeV3(tmp, broken, plan)
    const after = mod.readGraph(tmp)
    const afterCount = v3CountOf(after)
    const expected = expectedFieldCount(data) - lockedFields

    const lockedNote = lockedFields > 0 ? `，扣掉 goal 锁拒绝的 ${lockedFields} 个` : ''
    console.log(`  恢复后：${after.nodes.length} 节点 / ${(after.persistentConstraints ?? []).length} 条长期约束 / ${afterCount} 处 v3 字段（目标 ${expected}${lockedNote}）`)
    if (afterCount !== expected) fail(`临时副本恢复不完整：${afterCount} != ${expected}`)

    /**
     * ㉖ again: the assertion is that the DATA covers 13 distinct field names, so "every field came
     * back" cannot pass against a data file that happens to contain only one field.
     */
    const distinct = new Set(Object.values(data.nodes).flatMap((row) => Object.keys(row).filter((key) => ALL_V3.includes(key))))
    if (distinct.size < 13) fail(`数据只含 ${distinct.size} 种字段，低于 13 —— 断言会变成「恢复了它自己唯一的那个字段」`)
    const restoredDistinct = new Set(after.nodes.flatMap((node) => ALL_V3.filter((key) => node[key] !== undefined)))
    console.log(`  字段种类：数据 ${distinct.size} 种 / 恢复后 ${restoredDistinct.size} 种`)
    if (restoredDistinct.size !== distinct.size) fail(`字段种类不一致：${restoredDistinct.size} != ${distinct.size}`)

    const pc = after.persistentConstraints ?? []
    console.log(`  persistentConstraints：${pc.length} 条（数据 ${data.persistentConstraints.length} 条）`)
    if (pc.length !== data.persistentConstraints.length) fail(`长期约束数量不符：${pc.length} != ${data.persistentConstraints.length}`)

    /**
     * `start` must NOT be touched. It is the anchor: no v3 fields, and a restore that "helpfully"
     * filled it would be writing a claim about a node nobody authored.
     */
    const start = after.nodes.find((node) => node.id === mod.START_NODE_ID)
    const startV3 = ALL_V3.filter((key) => start[key] !== undefined)
    console.log(`  start 的 v3 字段：${startV3.length === 0 ? '无 ✅（未被误补）' : `⚠ ${startV3.join(', ')}`}`)
    if (startV3.length !== 0) fail(`start 被误补了 v3 字段：${startV3.join(', ')}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  console.log('')
  console.log('✅ --verify 通过：这个脚本确实能修它自己制造的那种缺失。')
  console.log('   活 store 未被修改（本模式只写备份）。要真正恢复请加 --write。')
}

// ── entry ───────────────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}
const memoryDir = resolve(resolveMemoryDir())
const dataFile = readDataArg(argv)
/** Checked BEFORE any mode runs, so a missing `--data` never reaches a half-finished restore. */
if (dataFile === undefined) usageFail('缺少 --data <path>（本工具不内置任何项目数据）')
/**
 * `--goal-journey` is a separate mode, not an implicit part of `--write`: it is the ONE step that
 * momentarily lifts a protection the user set. Making it a distinct flag means the lock cycle is always
 * something a human asked for by name.
 */
if (argv.includes('--goal-journey')) seedGoalJourney(memoryDir, dataFile, argv.includes('--write'))
else if (argv.includes('--verify')) verifyRestore(memoryDir, dataFile)
else if (argv.includes('--write')) writeRestore(memoryDir, dataFile)
else showPlan(memoryDir, dataFile)
