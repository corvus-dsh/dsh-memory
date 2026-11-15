/**
 * ── v209：`import type` 必须在产物里留下**一行纯空白**，且逐行位置对应 ────────────────────────────
 *
 * `scripts/build.mjs` 用 `stripTypeScriptTypes(source, { mode: 'strip' })`。strip **删掉**类型语法，
 * 但**保留行**：被剥掉的那一行变成一行纯空格（保留原列宽）。于是有一条机械判据：
 *
 *     源码里每一条 `import type ...`  ⇒  产物同一行号上是纯空白行
 *
 * 这条判据不是推演出来的，是**一次真实事故**换来的。
 *
 * ── 事故（2026-11-15，`ba9fd15`）────────────────────────────────────────────────────────────────
 *
 * 把 14 个声明搬进 `src/retrieve/interning.ts` 之后，我给新模块补了两个类型导入：
 *
 *     L29  import type { Document, DocumentCacheEntry } from '../retrieve.js'
 *     L30  import type { MemoryProvenance } from '../extract.js'
 *
 * 其中 L30 是**后补的**（`type-budget` 报 `Cannot find name 'MemoryProvenance'` 时才加）。
 * 加完我**没有再跑 build**，于是提交进仓的 `lib/retrieve/interning.js` 里只有**一行**纯空格，
 * 而源码有**两行** `import type`。
 *
 * 当时的门禁全绿：476 条测试通过、`verify-pure-move` 干净、`type-budget` OK、`check-cycles` ACYCLIC。
 * **一条都没抓到。** 因为运行时不需要 `MemoryProvenance`（它只是类型），产物少一行空白
 * 对执行毫无影响 —— 它只说明**产物与源码不同步**。
 *
 * 真正抓到它的是用户的一句话：`git status` 显示 `lib/retrieve/interning.js` 与重新 build 的结果不一致。
 *
 * ── 所以这条门禁要问的不是「产物能不能跑」，而是「产物是不是这份源码的产物」───────────────
 *
 * 前者是测试和运行期的事；后者是这个文件的事。`import type` 恰好是一根**免费的探针**：
 * 它在源码里存在、在产物里被擦成空白、且不影响任何行为。少一行 = 产物落后于源码。
 *
 * ── 边界（写清，否则这条门禁看起来覆盖得比实际多）──────────────────────────────────────────────
 *
 * - 它只探 `import type` **语句级**的形态（行首 `import type`）。内联 `import { type X }` 不是整行
 *   被剥，产物里会留 `import { }`，不在本判据内 —— 那种情况由构建产物自身的语法保证。
 * - 它不比较其它内容：源码里改了一个字符串、产物没重建，这条**抓不到**。
 *   「产物 == rebuild(src)」这条更强的判据需要跑完整 build，见 `npm run build` 的 CI 步骤。
 *   本判据是**便宜的常驻探针**，不是那条的替代。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SRC = join(REPO, 'src')
const LIB = join(REPO, 'lib')

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.ts')) out.push(relative(SRC, full).split('\\').join('/'))
  }
  return out
}

const MODULES = walk(SRC).sort()

/** 产物首行是 `// GENERATED from src/… by scripts/build.mjs`，故产物行号 = 源码行号 + 1。 */
const LIB_LINE_OFFSET = 1

const readBoth = (rel) => ({
  srcLines: readFileSync(join(SRC, rel), 'utf8').split('\n'),
  libLines: readFileSync(join(LIB, rel.replace(/\.ts$/u, '.js')), 'utf8').split('\n'),
})

/** 源码里 `import type` 的 0-based 行号。 */
const typeImportLines = (srcLines) => {
  const out = []
  for (let i = 0; i < srcLines.length; i += 1) {
    if (/^import\s+type\b/u.test(srcLines[i])) out.push(i)
  }
  return out
}

test('v209 ①: 每条 import type 在产物同一位置是一行纯空白', () => {
  const failures = []
  let checked = 0
  for (const rel of MODULES) {
    const { srcLines, libLines } = readBoth(rel)
    for (const i of typeImportLines(srcLines)) {
      checked += 1
      const at = i + LIB_LINE_OFFSET
      const libLine = libLines[at]
      if (libLine === undefined) {
        failures.push(`${rel}: 源码 L${i + 1} 是 import type，但产物只有 ${libLines.length} 行（短了）`)
        continue
      }
      if (!/^[ \t]*$/u.test(libLine)) {
        failures.push(`${rel}: L${i + 1}「${srcLines[i].slice(0, 50)}」→ 产物同行「${libLine.slice(0, 50)}」不是空白`)
      }
    }
  }
  assert.ok(checked > 0, '一条 import type 都没扫到 —— 扫描器坏了')
  assert.deepEqual(failures, [],
    '产物与源码不同步：源码里的 import type 被 strip 成空白行，产物该位置必须是空白。'
    + '不是空白 ⇒ lib/ 是旧产物，先 `npm run build` 再提交：\n  ' + failures.join('\n  '))
})

test('v209 ②: 行数守恒 —— strip 只擦内容，不删行', () => {
  /**
   * `mode: 'strip'` 的语义是「擦掉类型语法、保留位置」。所以产物行数应等于源码行数
   * （产物多出的那 1 行是 banner）。
   *
   * 这条能抓住另一类失步：产物被手工编辑过、或 build 用了一个不同版本。
   */
  const failures = []
  for (const rel of MODULES) {
    const { srcLines, libLines } = readBoth(rel)
    const expected = srcLines.length + 1
    if (libLines.length !== expected) {
      failures.push(`${rel}: 源码 ${srcLines.length} 行 + banner = 期望 ${expected}，产物实际 ${libLines.length}`)
    }
  }
  assert.deepEqual(failures, [],
    '产物行数与源码不守恒 —— strip 是保位擦除，不该增删行：\n  ' + failures.join('\n  '))
})

test('v209 ③: 判据本身能分辨 —— 缺一行 / 位置错开 都必须被抓到（假数据 can-red）', () => {
  /**
   * 判据被抽成一个纯函数来喂假数据。理由同 v205/v206/v207 的 can-red：
   * 「0 违规」只有在判据**能**报违规时才有意义。
   *
   * 这里精确复现 `ba9fd15` 那个事故的形状：源码 2 条 `import type`，
   * 产物里只有 1 行空白（第二条是后补的、没 rebuild）。
   */
  const check = (srcLines, libLines) => {
    const failures = []
    for (const i of typeImportLines(srcLines)) {
      const at = i + LIB_LINE_OFFSET
      const libLine = libLines[at]
      if (libLine === undefined) { failures.push(`short@L${i + 1}`); continue }
      if (!/^[ \t]*$/u.test(libLine)) failures.push(`not-blank@L${i + 1}`)
    }
    return failures
  }

  /**
   * 假数据的构造规则：产物 = banner + 源码逐行（`import type` 行换成纯空白）。
   * strip 保位擦除，所以两边除 banner 外逐行对应 —— 这点必须先构造对，
   * 否则测的是我的假数据而不是判据。
   */
  const src = [
    '// banner',                          // L1
    'import type { A } from "./a.js"',   // L2
    'import type { B } from "./b.js"',   // L3
    'export const x = 1',                // L4
  ]

  // ① 正常产物：banner + 原文（两条 import type 各留一行空白）
  assert.deepEqual(
    check(src, ['// GENERATED', '// banner', '   ', '   ', 'export const x = 1']),
    [],
    '两条 import type 各对应一行空白 ⇒ 无违规',
  )

  // ② 事故形状（ba9fd15）：第二条的位置上仍是源码行 —— 后补的 import type 没 rebuild
  assert.deepEqual(
    check(src, ['// GENERATED', '// banner', '   ', 'import type { B } from "./b.js"', 'export const x = 1']),
    ['not-blank@L3'],
    '第二条 import type 的位置不是空白 ⇒ 必须报（这就是 ba9fd15 的形状）',
  )

  // ③ 产物短到没有该行
  assert.deepEqual(
    check(src, ['// GENERATED', '// banner', '   ']),
    ['short@L3'],
    '产物没有 L3 ⇒ 必须报「短了」，而不是静默通过',
  )

  // ④ 位置整体错开（产物缺 banner）
  assert.deepEqual(
    check(src, ['// banner', '   ', '   ', 'export const x = 1']),
    ['not-blank@L3'],
    '产物缺 banner ⇒ 位置整体错开 ⇒ 必须报',
  )

  // ⑤ 单条 import type 的两种形态
  const oneImport = ['// banner', 'import type { A } from "./a.js"', 'export const x = 1']
  assert.deepEqual(
    check(oneImport, ['// GENERATED', '// banner', '  ', 'export const x = 1']),
    [],
    '单条、位置正确 ⇒ 无违规',
  )
  assert.deepEqual(
    check(oneImport, ['// GENERATED', '// banner', 'import type { A } from "./a.js"', 'export const x = 1']),
    ['not-blank@L2'],
  )

  // ⑥ 没有 import type 的文件 ⇒ 恒空（判据不误报普通文件）
  assert.deepEqual(check(['// banner', 'export const y = 2'], ['// GENERATED', '// banner', 'export const y = 2']), [])
})
