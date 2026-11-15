/**
 * ── 值 / 类型 import 分离：一条只有构建器会踩的坑，用门禁钉住 ────────────────────────────────────
 *
 * `scripts/build.mjs` 用 `stripTypeScriptTypes` 剥类型。所以一个 `interface` / `type` 在
 * **产物里不存在** —— 把它写进值 import，`tsc` 不报（它按类型上下文解释得通），
 * 构建也不报（那一步只是剥类型），只有**运行期**炸：
 *
 *     SyntaxError: The requested module './store/skill.js' does not provide an export named 'SkillConflict'
 *
 * 这个坑在本轮重构里**踩过三次**，每次都是同一个形状：
 *
 *     A3   SkillMeta            （store.ts 里写进值 re-export 列表）
 *     A1-3 EnvironmentDivergence（skill.ts 里写进值 import）
 *     A2   SkillConflict         （lifecycle.ts 里写进值 import）
 *
 * 三次的表现完全一样：`npm test` 全红、错误信息指向「模块没有这个导出」，
 * 而源码里那个 interface 明明就在隔壁文件里导出了。修法每次都是同一个：
 * 拆成 `import { … }` + `import type { … }`（或用内联 `import { type X }`）。
 *
 * 一份能被踩三次的坑不该靠记忆避免。这条门禁把它变成机械判据。
 *
 * ── 判据 ───────────────────────────────────────────────────────────────────────────────────────
 *
 * 对 `src/` 下每个 `.ts` 文件、每条 `import` 语句：
 *
 *   1. 若语句整体是 `import type { … }` → 合规（不需要看名字）；
 *   2. 否则，逐个 specifier 检查：若该 specifier 带 `type` 前缀（`import { type X }`）→ 合规；
 *   3. 否则，若该名字在 `src/` 里**只**被声明为 `interface` 或 `type`（从未被声明为
 *      function / const / let / class）→ **违规**。
 *
 * 第 3 步的「只」是关键：一个名字可能既是 interface 又被 const 声明（本仓确实存在这种
 * 历史情况），那种情况**不判违规** —— 运行时它存在，值 import 是合法的。
 * 判据问的是「这个名字在运行期存在吗」，不是「它像不像类型」。
 *
 * ── 这条门禁不能假装覆盖的东西 ────────────────────────────────────────────────────────────────
 *
 * 它只检查 `src/` 内部模块之间的 import。**不检查**：
 *   - 从 `node:*` 或外部包导入的类型（那些没有本地声明可对照）；
 *   - 重新导出的类型（`export type { … } from`）—— 那由 `verify-pure-move` 的
 *     normaliseContentLine 与构建产物检查各自覆盖一部分，不是这条的事。
 *
 * 写清边界，是因为一条看起来覆盖一切的门禁比一条说清自己范围的门禁更危险。
 *
 * ── can-red（为什么最后两条测试存在）───────────────────────────────────────────────────────────
 *
 * 「0 违规」只有在判据**能**报违规时才有意义。一个永远返回空数组的扫描器同样会给出 0 违规。
 * 只跑真树拿到 0，分不清「真干净」和「瞎」。所以判据被抽成 `scanSrc(dir)`：真树之外，
 * 再造一个临时的假 src/ 喂给它 —— 那是确定性、无副作用、不需要 typescript 的 can-red。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'src')

/** 收集目录下所有 .ts（递归）。判据按目录工作，真树与假树走同一条路径。 */
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { walk(full, out); continue }
    if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** 一个名字在运行期是否存在：只要被 function / const / let / class 声明过，就存在。 */
const collectDeclarations = (files) => {
  const typeOnly = new Set()
  const runtimeValue = new Set()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/^(?:export\s+)?(?:declare\s+)?interface\s+(\w+)/gmu)) typeOnly.add(m[1])
    for (const m of text.matchAll(/^(?:export\s+)?(?:declare\s+)?type\s+(\w+)\s*=/gmu)) typeOnly.add(m[1])
    for (const m of text.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gmu)) runtimeValue.add(m[1])
    for (const m of text.matchAll(/^(?:export\s+)?(?:const|let|var)\s+(\w+)/gmu)) runtimeValue.add(m[1])
    for (const m of text.matchAll(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gmu)) runtimeValue.add(m[1])
    for (const m of text.matchAll(/^(?:export\s+)?enum\s+(\w+)/gmu)) runtimeValue.add(m[1])
  }
  return { typeOnly, runtimeValue }
}

/**
 * 解析一个源文件里的全部 import，返回 `{ line, name, isTypeOnly }[]`。
 * 单行与多行两种形态都要处理 —— 本仓两种都有，只处理单行会漏掉一半。
 */
const importsOf = (text) => {
  const lines = text.split('\n')
  const out = []

  const pushSpecifiers = (raw, baseLine, isTypeStatement) => {
    for (const part of raw.split(',')) {
      const spec = part.trim()
      if (spec.length === 0) continue
      const inlineType = /^type\s+/u.test(spec)
      const name = spec.replace(/^type\s+/u, '').split(/\s+as\s+/u)[0].trim()
      if (name.length === 0) continue
      out.push({ name, line: baseLine, isTypeOnly: isTypeStatement || inlineType })
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    // 形态 A：单行 `import [type] { … } from '…'`
    const single = line.match(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"][^'"]+['"]/u)
    if (single !== null) {
      pushSpecifiers(single[2], i + 1, single[1] === 'type ')
      continue
    }

    // 形态 B：多行 `import [type] {` … `} from '…'`
    const open = line.match(/^import\s+(type\s+)?\{\s*$/u)
    if (open === null) continue
    const isTypeStatement = open[1] === 'type '
    let j = i + 1
    for (; j < Math.min(lines.length, i + 60); j += 1) {
      if (/^\}\s*from\s*['"][^'"]+['"]/u.test(lines[j])) break
      pushSpecifiers(lines[j].trim().replace(/,$/u, ''), j + 1, isTypeStatement)
    }
    if (j >= lines.length || !/^\}\s*from\s*['"][^'"]+['"]/u.test(lines[j])) continue
    i = j
  }

  return out
}

/**
 * 判据本体：扫一个 src 目录，返回违规清单。**真树与假树走同一条路径** ——
 * 这正是 can-red 能成立的原因（不是另写一份「用于测试」的实现）。
 */
const scanSrc = (dir) => {
  const files = walk(dir).sort()
  const { typeOnly, runtimeValue } = collectDeclarations(files)
  const violations = []
  for (const file of files) {
    const rel = file.replace(/\\/g, '/').replace(`${dir.replace(/\\/g, '/')}/`, '')
    for (const imp of importsOf(readFileSync(file, 'utf8'))) {
      if (imp.isTypeOnly) continue
      if (!typeOnly.has(imp.name)) continue
      if (runtimeValue.has(imp.name)) continue // 运行期存在 → 值 import 合法
      violations.push(`${rel}:${imp.line}  ${imp.name}`)
    }
  }
  return { files, typeOnly, runtimeValue, violations: violations.sort() }
}

const REAL = scanSrc(SRC)

test('value/type: 每个 import 的名字若在 src/ 里是纯类型，必须是 import type', () => {
  assert.deepEqual(REAL.violations, [],
    'these names are declared ONLY as interface/type in src/, so the build strips them and the '
    + 'runtime import fails with "does not provide an export named …". Use `import type { … }` '
    + 'or the inline `import { type X }` form:\n  ' + REAL.violations.join('\n  '))
})

test('value/type: 扫描器看得见文件（分母不是 0）', () => {
  // 一条分母断言：一个看不见任何文件的扫描器也会报「无违规」。
  // 本仓 src/ 有 31+ 个 .ts 文件；这里要求至少 25，防止 future 的路径改动让扫描静默变空。
  assert.ok(REAL.files.length >= 25,
    `the scanner found only ${REAL.files.length} .ts files under src/, which cannot be the whole tree`)
  assert.ok(REAL.typeOnly.size >= 50,
    `only ${REAL.typeOnly.size} interface/type names were collected — the declaration scan looks broken`)
  assert.ok(REAL.runtimeValue.size >= 100,
    `only ${REAL.runtimeValue.size} runtime value names were collected — the declaration scan looks broken`)
})

test('value/type: 判据本身能分辨 —— 纯类型违规 / 同名混用不违规 / 内联 type 合规', () => {
  /**
   * 三条微型用例，直接喂给解析器，不碰磁盘。
   *
   * 这条测试存在的理由：上面那条「0 违规」只有在解析器**能**报违规时才有意义。
   * 一个永远返回空数组的解析器同样会给出 0 违规 —— 那是本条要排除的情况。
   */
  const parse = (text) => importsOf(text)

  // ① 纯类型写进值 import → 必须被识别为「非 typeOnly」，交给上面的判据去红
  const bad = parse("import { Foo } from './x.js'\n")
  assert.equal(bad.length, 1)
  assert.equal(bad[0].name, 'Foo')
  assert.equal(bad[0].isTypeOnly, false, 'a plain value import of Foo must NOT be marked type-only')

  // ② `import type { Foo }` → typeOnly
  const good = parse("import type { Foo } from './x.js'\n")
  assert.equal(good[0].isTypeOnly, true)

  // ③ 内联 `import { type Foo, bar }` → Foo 是 typeOnly，bar 不是
  const inline = parse("import { type Foo, bar } from './x.js'\n")
  const foo = inline.find((i) => i.name === 'Foo')
  const bar = inline.find((i) => i.name === 'bar')
  assert.equal(foo?.isTypeOnly, true, 'the inline `type Foo` modifier must be honoured')
  assert.equal(bar?.isTypeOnly, false)

  // ④ 多行形态同样解析
  const multiline = parse("import {\n  Foo,\n  bar,\n} from './x.js'\n")
  assert.equal(multiline.find((i) => i.name === 'Foo')?.isTypeOnly, false)
  assert.equal(multiline.find((i) => i.name === 'bar')?.isTypeOnly, false)

  // ⑤ 多行 import type
  const multilineType = parse("import type {\n  Foo,\n  bar,\n} from './x.js'\n")
  assert.equal(multilineType.every((i) => i.isTypeOnly), true)
})

/**
 * ── can-red：喂一棵假 src/，确认判据真的会红 ──────────────────────────────────────────────────
 *
 * 这是 v203/v205 那两次「can-red 只在 _scratch 里做」的补救：验证代码进仓，
 * 下一个人跑 `npm test` 就顺手重验了门禁，不必相信一句「我验过了」。
 *
 * 用 tmpdir 而不是改真树：真树不能被测试写入（并行跑的其他测试会读它），
 * 而假树走的是**同一个** `scanSrc`，所以「假树上能红」等价于「真树上有违规也会红」。
 */
const withFakeSrc = (files, fn) => {
  const root = mkdtempSync(join(tmpdir(), 'vt-canred-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    for (const [rel, text] of Object.entries(files)) {
      const full = join(root, 'src', rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, text, 'utf8')
    }
    return fn(join(root, 'src'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('can-red: 假 src/ 里把 interface 写进值 import → 判据必须点名（否则门禁是瞎的）', () => {
  const result = withFakeSrc({
    'types.ts': 'export interface Foo { a: string }\nexport type Bar = string\nexport const baz = 1\n',
    'consumer.ts': "import { Foo, Bar, baz } from './types.js'\nconsole.log(Foo, Bar, baz)\n",
  }, scanSrc)

  const names = result.violations.map((v) => v.split(/\s+/u).pop()).sort()
  assert.deepEqual(names, ['Bar', 'Foo'],
    '把 interface Foo 与 type alias Bar 写进值 import，两个都必须被点名')
  assert.ok(!result.violations.some((v) => /baz/u.test(v)),
    'baz 是真值（const），不许误报 —— 误报会让人把门禁关掉')
})

test('can-red: 同一个假 src/ 改用 import type 后必须转绿（判据不是「总有违规」）', () => {
  const result = withFakeSrc({
    'types.ts': 'export interface Foo { a: string }\nexport type Bar = string\nexport const baz = 1\n',
    'consumer.ts': "import type { Foo, Bar } from './types.js'\nimport { baz } from './types.js'\nconsole.log(baz)\n",
  }, scanSrc)
  assert.deepEqual(result.violations, [], '改成 import type 之后必须 0 违规')
})

test('can-red: 同名既 interface 又 const → 值 import 合法（判据问的是运行期存在性）', () => {
  const result = withFakeSrc({
    'types.ts': 'export interface Dual { a: string }\nexport const Dual = 1\n',
    'consumer.ts': "import { Dual } from './types.js'\nconsole.log(Dual)\n",
  }, scanSrc)
  assert.deepEqual(result.violations, [],
    'Dual 运行期存在（const 声明过），值 import 合法；按「像不像类型」判会误报')
})
