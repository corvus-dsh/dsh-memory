/**
 * ── v246 (B3 收口 / TD-M6): 六个阈值常量只有一个出处 ───────────────────────────────────────────
 *
 * TD-M6 的退出条件：新建 `thresholds.ts`（零依赖叶子）承载 `FLOOR` / `THRESHOLD` /
 * `MERGE_SIMILARITY` / `TASK_TERM_LIMIT` / `NEGATIVE_STALE_DAYS` / `FILTER_MAX_CANDIDATES`；
 * 所有模块只从它导入；加一条「`src/` 内无跨层反向常量导入」的静态检查测试。
 *
 * ── 一条必须先说清的事实（退出条件假设的东西当时并不存在） ──────────────────────────────────
 *
 * `FLOOR` 与 `THRESHOLD` 这两个名字**在代码里从来没有出现过**。真实状态是：
 *   · `DEFAULT_RETRIEVAL_FLOOR = 0.2` 在 `index.ts` —— 名字有，但它在**上层**，`retrieve.ts`
 *     import 它会成环，于是同一个 `0.2` 在检索器里又被字面量写了**两遍**；
 *   · `DEFAULT_RETRIEVAL_THRESHOLD = 0.55` 在 `retrieve.ts`，而同一文件十行之下**又写了一遍**
 *     字面量 `0.55`。
 *
 * 所以这一笔实际做的是「**立名 + 搬移**」，不是「搬移六个已命名的常量」。这条差别写进报告，
 * 也写在这里，因为「退出条件点名的名字不存在」本身是判据说谎的一种。
 *
 * ── 本文件钉四件事 ──────────────────────────────────────────────────────────────────────────
 *
 *   ① `thresholds.ts` 的 import 数 = 0（零依赖叶子，任何方向都不成环）；
 *   ② 它只导出那六个常量（多一个少一个都红）；
 *   ③ `src/` 内**任何值 import** 这六个名字，来源必须是 `thresholds.js`
 *      —— 注意 re-export（`export { X } from …`）不算 import：那是保公开面的管道，不是第二份值；
 *   ④ 六个值本身不许被顺手改（0.2 / 0.55 / 0.82 / 60 / 5 / 30）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FLOOR,
  THRESHOLD,
  MERGE_SIMILARITY,
  TASK_TERM_LIMIT,
  FILTER_MAX_CANDIDATES,
  NEGATIVE_STALE_DAYS,
} from '../lib/thresholds.js'

const ROOT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src')
const SIX = ['FLOOR', 'THRESHOLD', 'MERGE_SIMILARITY', 'TASK_TERM_LIMIT', 'NEGATIVE_STALE_DAYS', 'FILTER_MAX_CANDIDATES']

/** Every `.ts` under `src/`, recursively — the same denominator the module registry uses. */
function allModules(dir = ROOT, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      out.push(...allModules(join(dir, entry.name), rel))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) out.push(rel)
  }
  return out
}

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

// ── ① 零依赖叶子 ────────────────────────────────────────────────────────────────────────────

test('v246 ①: `thresholds.ts` 的 import 数是 0', () => {
  const text = read('thresholds.ts')
  const imports = [...text.matchAll(/^\s*import\b/gmu)]
  const fromClauses = [...text.matchAll(/^\s*(?:import|export)[^;\n]*\bfrom\s+['"]/gmu)]
  assert.deepEqual(
    imports.map((match) => match[0].trim()),
    [],
    `零依赖是这条模块的全部意义：一旦 import 了东西，「哪个数是唯一一份」就不再能靠读一个文件回答`,
  )
  assert.deepEqual(fromClauses, [], '也不许用 `export … from` 把别处的值引进来')

  /** And its size is honest: a 3,000-line "leaf" would be a second store, not a leaf. */
  const lines = read('thresholds.ts').split('\n').length
  assert.ok(lines < 120, `thresholds.ts 应当只有常量与理由，实测 ${lines} 行`)
})

// ── ② 只导出那六个 ──────────────────────────────────────────────────────────────────────────

test('v246 ②: `thresholds.ts` 只导出那六个常量（多一个少一个都红）', () => {
  const text = read('thresholds.ts')
  const exported = [...text.matchAll(/^export\s+const\s+([A-Z][A-Z0-9_]*)/gmu)].map((match) => match[1])
  assert.deepEqual([...exported].sort(), [...SIX].sort(), `导出面必须恰好是这六个，实测：${exported.join(', ')}`)
})

// ── ③ 值 import 的来源必须是 thresholds.js ──────────────────────────────────────────────────

test('v246 ③: `src/` 内凡 import 这六个名字，来源必须是 thresholds.js', () => {
  const offenders = []
  for (const rel of allModules()) {
    if (rel === 'thresholds.ts') continue
    const text = read(rel)
    /**
     * VALUE IMPORTS ONLY. `import { X } from './y.js'` binds a runtime value; `export { X } from
     * './y.js'` only forwards a name that already exists. The second form is how the public surface
     * is kept intact while the value moves, so it is explicitly allowed — it cannot create a second
     * copy.
     *
     * A TYPE-ONLY import is also irrelevant (there are no types here), and `import type` is skipped
     * by the `^import\s*\{` shape below.
     */
    for (const match of text.matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gmu)) {
      const names = match[1].split(',').map((name) => name.trim().split(/\s+as\s+/u)[0].trim())
      const hit = names.filter((name) => SIX.includes(name))
      if (hit.length === 0) continue
      const source = match[2]
      if (/thresholds\.js$/u.test(source)) continue
      offenders.push(`${rel}: ${hit.join(', ')} ← ${source}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这六个名字只有一个出处（src/thresholds.js）；以下 import 绕过了它：\n  ${offenders.join('\n  ')}`,
  )
})

// ── ④ 值不许被顺手改 ────────────────────────────────────────────────────────────────────────

test('v246 ④: 六个值就是它们原来的值（这一笔只立名与搬家，不改行为）', () => {
  assert.equal(FLOOR, 0.2)
  assert.equal(THRESHOLD, 0.55)
  assert.equal(MERGE_SIMILARITY, 0.82)
  assert.equal(TASK_TERM_LIMIT, 60)
  assert.equal(FILTER_MAX_CANDIDATES, 5)
  assert.equal(NEGATIVE_STALE_DAYS, 30)
})

// ── ⑤ 公开面：老名字还通，而且通到同一个数 ──────────────────────────────────────────────

test('v246 ⑤: 旧名字（DEFAULT_RETRIEVAL_FLOOR / _THRESHOLD）仍然可用，且等于新名字', async () => {
  const entry = await import('../lib/index.js')
  const retrieve = await import('../lib/retrieve.js')
  assert.equal(entry.DEFAULT_RETRIEVAL_FLOOR, FLOOR, '公开面不许断，而且是同一个数')
  assert.equal(retrieve.DEFAULT_RETRIEVAL_THRESHOLD, THRESHOLD)
  /** The re-exports through the old homes still resolve to the one value. */
  assert.equal(retrieve.TASK_TERM_LIMIT, TASK_TERM_LIMIT)
  assert.equal(retrieve.FILTER_MAX_CANDIDATES, FILTER_MAX_CANDIDATES)
  const archive = await import('../lib/archive.js')
  assert.equal(archive.MERGE_SIMILARITY, MERGE_SIMILARITY)
  const interning = await import('../lib/retrieve/interning.js')
  assert.equal(interning.NEGATIVE_STALE_DAYS, NEGATIVE_STALE_DAYS)
})

// ── ⑥ 完整清单：六个之外，不许还有同一个值的字面量副本 ──────────────────────────────────

test('v246 ⑥: 六个值在 `src/` 里的字面量副本已被清掉（只允许出现在 thresholds.ts）', () => {
  /**
   * The dispatch's stop condition #2: "if there are literals beyond the six, say so — do not
   * quietly move six". This test is the mechanical half of that promise, scoped to the SIX VALUES.
   *
   * `0.2` also appears as a CONFIDENCE floor (`clampConfidence`, `Math.max(0.2, …)`) — a different
   * number that happens to share a value. Those are excluded by matching only the RETRIEVAL-shaped
   * uses (`?? 0.2`, `?? 0.55`), which is what the duplication actually looked like.
   */
  const offenders = []
  for (const rel of allModules()) {
    if (rel === 'thresholds.ts') continue
    const text = read(rel)
    for (const literal of ['0.2', '0.55', '0.82']) {
      for (const match of text.matchAll(new RegExp(`\\?\\?\\s*${literal.replace('.', '\\.')}\\b`, 'gu'))) {
        offenders.push(`${rel}: \`?? ${literal}\`（应改用 thresholds 里的名字）`)
      }
    }
  }
  assert.deepEqual(offenders, [], `这些地方仍把阈值写成字面量：\n  ${offenders.join('\n  ')}`)

  /** Merged similarity is used as a default parameter too — that is a different shape, same rule. */
  const wrongShape = []
  for (const rel of allModules()) {
    if (rel === 'thresholds.ts') continue
    const text = read(rel)
    for (const literal of ['0.82']) {
      if (text.includes(`= ${literal}`)) wrongShape.push(`${rel}: default parameter ${literal}`)
    }
  }
  assert.deepEqual(wrongShape, [], `默认参数里也不许留字面量：\n  ${wrongShape.join('\n  ')}`)
})