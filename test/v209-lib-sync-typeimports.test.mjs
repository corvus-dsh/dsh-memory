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
 * 它覆盖**两种**形态，各自用不同的判据（**实测** `strip` 的产物得出，不是推演）：
 *
 *   形态 A  语句级 `import type { A } from '…'`
 *           产物：整行被擦成**纯空白**（保留列宽）。
 *           判据：产物同一行号是纯空白。
 *
 *   形态 B  内联 `import { type A } from '…'` / `import { type A, b }` / `import { b, type A }`
 *           产物：**保留 import 骨架**，只把 `type A` 擦成空格：
 *               `import {        } from "./x.js"`      ← 全是类型
 *               `import {         b } from "./x.js"`    ← 混合
 *               `import { b,        } from "./x.js"`    ← 混合
 *           判据：产物同一行号仍是 `import { … } from '…'`，且**不含** `type` 关键字，
 *                 且成员列表里与「源码去掉所有 `type X` 后的值成员」一致。
 *
 * **不覆盖**：
 *   - 源码改了非类型内容、产物没重建（那需要 `git diff --exit-code -- lib`，是 CI 的步骤）；
 *   - 产物被手工编辑成「仍然合法但语义不同」（本判据只看 import 行）。
 *
 * 这两条边界是刻意的：一条看起来覆盖一切的门禁比一条说清自己范围的门禁更危险。
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

/**
 * 源码里的**内联** `import { type X }` 的 0-based 行号。
 * 与 `import type` 的区别：`type` 在花括号**里面**，语句仍是值 import 的骨架。
 */
const inlineTypeImportLines = (srcLines) => {
  const out = []
  for (let i = 0; i < srcLines.length; i += 1) {
    if (/^import\s*\{[^}]*\btype\s+\w/u.test(srcLines[i])) out.push(i)
  }
  return out
}

/**
 * 源码一行的值成员（去掉 `type X` 与 `X as Y` 重命名）。
 * `import { type A, b }` → `['b']`；`import { b, type A }` → `['b']`。
 */
const valueMembersOf = (line) => {
  const m = line.match(/^import\s*\{([^}]*)\}/u)
  if (m === null) return []
  return m[1].split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => !/^type\s+/u.test(s))
    .map((s) => s.split(/\s+as\s+/u)[0].trim())
    .sort()
}

/** 产物一行的值成员（产物里 `type X` 已被擦掉，所以剩下什么就是什么）。 */
const libValueMembersOf = (line) => {
  const m = line.match(/^import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/u)
  if (m === null) return undefined
  return m[1].split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.split(/\s+as\s+/u)[0].trim())
    .sort()
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

test('v209 ③: 内联 `import { type X }` 在产物里保留骨架、只擦成员（与语句级判据不同）', () => {
  /**
   * 实测 `strip` 的产物（见测试末尾的 can-red）：
   *
   *     src  import { type A, b } from "./x.js"
   *     lib  import {         b } from "./x.js"      ← 骨架还在，type A 被擦成空格
   *
   * 所以这条不能用「产物是纯空白」判，它要问三个问题：
   *   1. 产物同一行仍是 `import { … } from '…'`；
   *   2. 产物行里不含 `type` 关键字（说明类型成员真的被擦掉了）；
   *   3. 产物的值成员 == 源码去掉所有 `type X` 后的值成员。
   */
  const failures = []
  let checked = 0
  for (const rel of MODULES) {
    const { srcLines, libLines } = readBoth(rel)
    for (const i of inlineTypeImportLines(srcLines)) {
      checked += 1
      const at = i + LIB_LINE_OFFSET
      const srcLine = srcLines[i]
      const libLine = libLines[at]
      if (libLine === undefined) {
        failures.push(`${rel}:L${i + 1} 源码是内联 import type，但产物没有这一行`)
        continue
      }
      if (!/^import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]/u.test(libLine)) {
        failures.push(`${rel}:L${i + 1} 产物里这一行不是 import 骨架：「${libLine.slice(0, 60)}」`)
        continue
      }
      if (/\btype\b/u.test(libLine)) {
        failures.push(`${rel}:L${i + 1} 产物里仍含 type 关键字：「${libLine.slice(0, 60)}」`)
        continue
      }
      const want = valueMembersOf(srcLine)
      const got = libValueMembersOf(libLine)
      if (got === undefined) {
        failures.push(`${rel}:L${i + 1} 产物行的成员列表解析失败：「${libLine.slice(0, 60)}」`)
        continue
      }
      if (JSON.stringify(want) !== JSON.stringify(got)) {
        failures.push(`${rel}:L${i + 1} 值成员不符：源码去 type 后 [${want.join(',')}]，产物 [${got.join(',')}]`)
      }
    }
  }
  // 现状：本仓 0 条内联形态。这条断言是**为将来准备的**，但它必须能工作 ——
  // 下面 can-red 用假数据证明它确实能红。所以不 skip、不 early-return。
  assert.deepEqual(failures, [],
    `内联 import type 的产物不符（本次检查 ${checked} 条）：\n  ` + failures.join('\n  '))
})

test('v209 ④: 两条判据都能红 —— 语句级缺行 / 内联骨架错 / 内联 type 未擦（假数据 can-red）', () => {
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

  // ── 内联形态的判据（与上面不同：看骨架 + 值成员，不看纯空白）──
  const checkInline = (srcLines, libLines) => {
    const failures = []
    for (const i of inlineTypeImportLines(srcLines)) {
      const at = i + LIB_LINE_OFFSET
      const srcLine = srcLines[i]
      const libLine = libLines[at]
      if (libLine === undefined) { failures.push(`missing@L${i + 1}`); continue }
      if (!/^import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]/u.test(libLine)) { failures.push(`no-skeleton@L${i + 1}`); continue }
      if (/\btype\b/u.test(libLine)) { failures.push(`type-left@L${i + 1}`); continue }
      const want = valueMembersOf(srcLine)
      const got = libValueMembersOf(libLine)
      if (got === undefined) { failures.push(`unparsable@L${i + 1}`); continue }
      if (JSON.stringify(want) !== JSON.stringify(got)) failures.push(`members@L${i + 1}`)
    }
    return failures
  }

  // ⑦ 内联全类型：`import { type A }` → `import {        }`
  {
    const src = ['// banner', 'import { type A } from "./x.js"', 'export const c = 1']
    const okLib = ['// GENERATED', '// banner', 'import {        } from "./x.js"', 'export const c = 1']
    assert.deepEqual(checkInline(src, okLib), [], '全类型内联：骨架保留、成员为空 ⇒ 合规')
  }

  // ⑧ 内联混合（type 在前）：`import { type A, b }` → `import {         b }`
  {
    const src = ['// banner', 'import { type A, b } from "./x.js"', 'export const c = 1']
    const okLib = ['// GENERATED', '// banner', 'import {         b } from "./x.js"', 'export const c = 1']
    assert.deepEqual(checkInline(src, okLib), [], '混合内联：值成员只剩 b ⇒ 合规')
  }

  // ⑨ 内联混合（type 在后）：`import { b, type A }` → `import { b,        }`
  {
    const src = ['// banner', 'import { b, type A } from "./x.js"', 'export const c = 1']
    const okLib = ['// GENERATED', '// banner', 'import { b,        } from "./x.js"', 'export const c = 1']
    assert.deepEqual(checkInline(src, okLib), [], '混合内联（type 在后）：值成员只剩 b ⇒ 合规')
  }

  // ⑩ 关键 can-red：产物里 `type` 没被擦（说明是旧产物或 build 用的是不 strip 的路径）
  {
    const src = ['// banner', 'import { type A, b } from "./x.js"', 'export const c = 1']
    const badLib = ['// GENERATED', '// banner', 'import { type A, b } from "./x.js"', 'export const c = 1']
    assert.deepEqual(checkInline(src, badLib), ['type-left@L2'],
      '产物里 type 还在 ⇒ 必须红（这是「产物没重建」的另一种形状）')
  }

  // ⑪ can-red：产物把整行擦成空白（把内联错当成语句级）
  {
    const src = ['// banner', 'import { type A, b } from "./x.js"', 'export const c = 1']
    const badLib = ['// GENERATED', '// banner', '                        ', 'export const c = 1']
    assert.deepEqual(checkInline(src, badLib), ['no-skeleton@L2'],
      '内联形态的骨架被擦掉 ⇒ 必须红（说明用了错误的判据）')
  }

  // ⑫ can-red：值成员被错擦（type 擦对了但多擦了一个值）
  {
    const src = ['// banner', 'import { type A, b } from "./x.js"', 'export const c = 1']
    const badLib = ['// GENERATED', '// banner', 'import {               } from "./x.js"', 'export const c = 1']
    assert.deepEqual(checkInline(src, badLib), ['members@L2'],
      '值成员 b 被一起擦掉 ⇒ 必须红（这会变成运行期 ReferenceError）')
  }
})
