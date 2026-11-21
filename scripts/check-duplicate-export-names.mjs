#!/usr/bin/env node
/**
 * ── ONE NAME, ONE QUESTION: NO EXPORTED FUNCTION NAME MAY EXIST TWICE ──────────────────────────
 *
 * 五形态之一「判据分裂」的最小机械检查。派工单的判据：
 *
 *   同一语义的两份实现必须**唯一出处**或**名字说出差异**；静态检查：检出「同名同义两份函数」
 *   白名单外 ⇒ 红
 *
 * ── 实测的那一处（2026-11-21，本批 W6-1c）────────────────────────────────────────────────────
 *
 *   src/archive.ts: `whenSimilarity`   src/dedupe.ts: `whenSimilarity`
 *
 * 同名、同签名、同声称用途（「这两个触发器说的是不是同一件事」），而答案差得很远：
 *
 *     处理编号 0 的独立任务时  vs  处理编号 1 的独立任务时
 *         archive: 0.000   ← 数字不同 ⇒ 不同任务（archive.ts 的注释里明写这条）
 *         dedupe : 0.909   ← `normalizeForMatch` 删掉所有数字，两句塌成同一个串
 *
 * 两个答案在各自语境里都对，所以**合并是错的**；错的是那一个名字。改名之后
 * `archive.ts` 导出 `whenSimilarityDigitsMatter`，名字自己说出了差异。
 *
 * ── 为什么只查「导出」而不查所有函数 ──────────────────────────────────────────────────────────
 *
 * 一个模块内部的 `helper` 叫什么叫什么，是那个文件自己的事。跨模块才是判据分裂发生的地方：
 * 两个模块各有一个 `whenSimilarity`，读者会以为它们回答同一个问题，而没有人能在不打开两个文件
 * 的情况下发现它们不是。导出名是**跨模块的公开承诺**，所以检查落在那里。
 *
 * ── 白名单 ────────────────────────────────────────────────────────────────────────────────────
 *
 * 允许登记，但每条必须写明「这两个同名不是同一个问题」的理由（≥ 40 字符，与 `v129` 同门槛）。
 * 空白名单是目标，不是要求：一次性重命名全部同名导出会是一次跨模块重构。
 *
 * 用法：node scripts/check-duplicate-export-names.mjs [--json]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

/** The root is the CALLER'S directory (W5-1's lesson: `import.meta.url` answers about the wrong tree). */
const REPO = process.cwd()
const SRC = join(REPO, 'src')

/**
 * Names allowed to be exported from more than one module, each entry stating why the two are NOT the
 * same question. Empty is the goal; a non-empty entry is a standing exception someone must defend.
 */
const ALLOWED_DUPLICATES = new Map([
  /**
   * `renderNodeBanner` is re-exported from `graph.ts` (`export { … } from './graph-view.js'`) and
   * DEFINED in `graph-view.ts`. That is one implementation with a convenience re-export, not two —
   * the check counts definitions, so a pure re-export must not be counted twice.
   */
])

/** `export function name(` / `export async function name(` — the DEFINITION form, not a re-export. */
const DEFINITION = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gmu

/** `export { a, b } from './x.js'` and `export { a, b }` — a re-export, which is not a second body. */
const REEXPORT = /^export\s*\{[^}]*\}\s*(?:from\s*['"][^'"]+['"])?\s*;?/gmu

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(path, out)
      continue
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(path)
  }
  return out
}

/**
 * Definitions per name, across files.
 *
 * A file that both defines and re-exports a name (the `graph.ts` shape) contributes ONE definition.
 * That is why re-exports are stripped from the text before the definition scan: the check must count
 * BODIES, not mention sites.
 */
export function definitionsByName(sources) {
  const byName = new Map()
  for (const [file, text] of sources) {
    const withoutReexports = text.replace(REEXPORT, '')
    for (const match of withoutReexports.matchAll(DEFINITION)) {
      const name = match[1]
      if (!byName.has(name)) byName.set(name, [])
      const at = (withoutReexports.slice(0, match.index).match(/\n/gu) ?? []).length + 1
      byName.get(name).push({ file, line: at })
    }
  }
  return byName
}

/** Names defined in MORE THAN ONE file, minus the allowed ones. */
export function findDuplicateExports(byName, allowed = ALLOWED_DUPLICATES) {
  const out = []
  for (const [name, sites] of byName) {
    const files = [...new Set(sites.map((site) => site.file))]
    if (files.length < 2) continue
    if (allowed.has(name)) continue
    out.push({ name, files, sites })
  }
  return out.sort((left, right) => left.name.localeCompare(right.name))
}

function main() {
  let files
  try {
    files = walk(SRC)
  } catch {
    console.log(`check-duplicate-export-names: FAILED TO START — ${SRC} does not exist`)
    return 1
  }
  if (files.length === 0) {
    console.log(`check-duplicate-export-names: FAILED TO START — no .ts file under ${SRC}`)
    return 1
  }

  const sources = files.map((file) => [relative(REPO, file).split('\\').join('/'), readFileSync(file, 'utf8')])
  const byName = definitionsByName(sources)
  const duplicates = findDuplicateExports(byName)

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ files: files.length, exportedNames: byName.size, duplicates }, null, 2))
    return duplicates.length === 0 ? 0 : 1
  }

  if (duplicates.length === 0) {
    console.log(
      `duplicate-export-names: OK — ${byName.size} exported name(s) across ${files.length} file(s), each defined once ` +
        `(${ALLOWED_DUPLICATES.size} allowed duplicate(s))`,
    )
    return 0
  }

  console.log(`duplicate-export-names: ${duplicates.length} name(s) exported from more than one module`)
  for (const duplicate of duplicates) {
    console.log(`  ${duplicate.name}:`)
    for (const site of duplicate.sites) console.log(`    ${site.file}:${site.line}`)
  }
  console.log('')
  console.log('Two modules exporting one name is a claim that they answer ONE question. Measured on this')
  console.log('repository: whenSimilarity answered 0.000 and 0.909 for the same pair. Either give the')
  console.log('behaviour one home, or let the NAME say which question it answers (…DigitsMatter).')
  return 1
}

process.exitCode = main()