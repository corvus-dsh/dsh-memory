/**
 * ── v213：类型导出面 —— `retrieve/types.ts` 的每个类型都必须被 `retrieve.ts` 转出 ──────────────
 *
 * ── 为什么这条门禁必须存在 ──────────────────────────────────────────────────────────────────────
 *
 * `package.json` 的 `"types": "./src/index.ts"` 且 `files` 含 `src` —— **源码本身就是发布出去的
 * 类型面**。所以「某个类型有没有被 re-export」不是内部整洁问题，而是**使用方能不能 import 到它**。
 *
 * 而现有的导出面门禁全都看不见它：`v202` / `v211` 那一类是
 * `import('../lib/store.js')` 式的**运行期**断言，只数得到会真正导出的名字。
 * `export type` 在 `stripTypeScriptTypes` 之后整行消失 —— **漏掉一行，没有任何测试会红**。
 *
 * 第六步把 12 个契约类型搬进 `retrieve/types.ts` 时，这 12 行是手写的。手写过一次而不加门禁，
 * 下一次搬运就会再手写一次，而「漏一个」的代价是使用方在升级后才发现某个类型不存在。
 *
 * ── 判据从哪来：纯文本 + 一条运行期反证 ────────────────────────────────────────────────────────
 *
 * ① 正向：`types.ts` 里每个模块级类型声明，`retrieve.ts` 里都有一行 `export type { 它 }`。
 * ② 反向：`retrieve.ts` 的每一行 `export type { X }` 都指向 `types.ts` 里真实存在的声明
 *    （防「转出一个不存在的名字」——那会让 tsc 报 2304，但 tsc 不在 CI 上跑）。
 * ③ 可解析：每个被转出的名字也必须在 `retrieve.ts` 的 `import type { … } from './retrieve/types.js'`
 *    里 —— 裸 `export type { X }` 转的是**本地绑定**，没 import 就没有绑定。
 * ④ 反证（运行期）：这些**类型名一个都不能出现在 `lib/retrieve.js` 的导出里**。
 *    若某人把 `export type { X }` 写成 `export { X }`，构建后会出现一个值为 `undefined` 的运行期导出 ——
 *    那是最坏的一种：类型面没修好，运行期面还多了个洞。
 *
 * 不依赖 typescript ⇒ **在 CI 上真跑**（不是 TD-M15 里那 13 条之一）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const TYPES_FILE = join(REPO, 'src', 'retrieve', 'types.ts')
const RETRIEVE_FILE = join(REPO, 'src', 'retrieve.ts')
const MODULE_SPEC = './retrieve/types.js'

// ── 判据（纯函数，好让 can-red 用假数据喂它）────────────────────────────────────────────────────

/** `types.ts` 里的模块级类型声明名。 */
export const declaredTypes = (src) =>
  [...src.matchAll(/^export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gmu)].map((m) => m[1])

/** `retrieve.ts` 里的 `export type { X }` 名字（裸形式，转本地绑定）。 */
export const reexported = (src) =>
  [...src.matchAll(/^export\s+type\s*\{\s*([A-Za-z_$][\w$]*)\s*\}\s*;?\s*$/gmu)].map((m) => m[1])

/**
 * `retrieve.ts` 里从 `./retrieve/types.js` 的那条 `import type { … }` 导入的名字。
 * 只认**这一条**：别的模块也可能 import 同名类型，混在一起会把「没 import」放过。
 */
export const importedFromTypes = (src) => {
  const block = new RegExp(
    `import\\s+type\\s*\\{([^}]*)\\}\\s*from\\s*['"]${MODULE_SPEC.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}['"]`,
    'u',
  ).exec(src)
  if (block === null) return []
  return block[1].split(',')
    .map((s) => s.trim().replace(/^type\s+/u, ''))
    .filter((s) => s.length > 0)
}

/** 正向缺失：声明了、没转出。 */
export const missingReexports = (declared, reexportedNames) =>
  declared.filter((n) => !reexportedNames.includes(n))

/** 反向幽灵：转出了、但 `types.ts` 里没有这个声明。 */
export const phantomReexports = (declared, reexportedNames) =>
  reexportedNames.filter((n) => !declared.includes(n))

/** 转出了、但没 import ⇒ 裸 `export type { X }` 没有绑定。 */
export const unboundReexports = (reexportedNames, importedNames) =>
  reexportedNames.filter((n) => !importedNames.includes(n))

// ── 测试 ──────────────────────────────────────────────────────────────────────────────────────

const typesSrc = () => readFileSync(TYPES_FILE, 'utf8')
const retrieveSrc = () => readFileSync(RETRIEVE_FILE, 'utf8')

test('v213 ①: types.ts 的每个类型都被 retrieve.ts 转出（漏一个就红）', () => {
  const declared = declaredTypes(typesSrc())
  assert.ok(declared.length >= 12,
    `types.ts 只解析出 ${declared.length} 个类型声明 —— 解析器或文件出了意外（第六步之后应为 12）`)
  const missing = missingReexports(declared, reexported(retrieveSrc()))
  assert.deepEqual(missing, [],
    `这些类型在 src/retrieve/types.ts 里声明了，但 src/retrieve.ts 没有转出 —— `
    + '使用方（以及发布出去的类型面）看不到它们：\n  ' + missing.join('\n  '))
})

test('v213 ②: 每一行 export type 都指向真实存在的声明（防幽灵）', () => {
  const phantom = phantomReexports(declaredTypes(typesSrc()), reexported(retrieveSrc()))
  assert.deepEqual(phantom, [],
    'src/retrieve.ts 转出了 types.ts 里不存在的名字（tsc 会报 2304，但 tsc 不在 CI 上跑）：\n  '
    + phantom.join('\n  '))
})

test('v213 ③: 被转出的名字必须同时被 import type（裸 export type 转的是本地绑定）', () => {
  const imported = importedFromTypes(retrieveSrc())
  assert.ok(imported.length >= 12,
    `从 ${MODULE_SPEC} 导入的名字只有 ${imported.length} 个 —— 第六步之后应为 12`)
  const unbound = unboundReexports(reexported(retrieveSrc()), imported)
  assert.deepEqual(unbound, [],
    '这些名字被 export type 转出，但没有从 types.js import —— 裸 export 转的是本地绑定，'
    + '没有绑定就是错的：\n  ' + unbound.join('\n  '))
})

test('v213 ④: 类型名不得出现在运行期导出里（写成 export {} 会漏出一个 undefined）', (t) => {
  const lib = join(REPO, 'lib', 'retrieve.js')
  if (!existsSync(lib)) {
    t.skip('RESOURCE：lib/retrieve.js 不存在（尚未构建）。RESOURCE condition — NOT a pass and NOT a failure.')
    return
  }
  const require = createRequire(import.meta.url)
  let mod
  try {
    mod = require(lib)
  } catch (error) {
    t.skip(`RESOURCE：lib/retrieve.js 无法加载（${error.message}）。RESOURCE condition — NOT a pass and NOT a failure.`)
    return
  }
  const runtime = new Set(Object.keys(mod))
  const leaked = declaredTypes(typesSrc()).filter((n) => runtime.has(n))
  assert.deepEqual(leaked, [],
    '这些**类型**名字出现在了运行期导出里 —— 说明某处把 `export type { X }` 写成了 `export { X }`。'
    + '后果是发布出去的模块多了一个值为 undefined 的运行期导出：\n  ' + leaked.join('\n  '))
})

// ── can-red：把假数据喂给同一条判据 ────────────────────────────────────────────────────────────

test('v213 ⑤ can-red: 漏一个转出必须被点名', () => {
  const declared = ['A', 'B', 'C']
  assert.deepEqual(missingReexports(declared, ['A', 'B']), ['C'])
  assert.deepEqual(missingReexports(declared, ['A', 'B', 'C']), [])
})

test('v213 ⑥ can-red: 幽灵转出必须被点名', () => {
  assert.deepEqual(phantomReexports(['A', 'B'], ['A', 'B', 'Ghost']), ['Ghost'])
  assert.deepEqual(phantomReexports(['A', 'B'], ['A', 'B']), [])
})

test('v213 ⑦ can-red: 转出但没 import 必须被点名', () => {
  assert.deepEqual(unboundReexports(['A', 'B'], ['A']), ['B'])
  assert.deepEqual(unboundReexports(['A'], ['A']), [])
})

test('v213 ⑧: 判据在真实文件上确实读到了东西（免得「空数组恒绿」）', () => {
  const declared = declaredTypes(typesSrc())
  const reexportedNames = reexported(retrieveSrc())
  const imported = importedFromTypes(retrieveSrc())
  assert.ok(declared.length > 0 && reexportedNames.length > 0 && imported.length > 0,
    `解析结果不能有空集（declared ${declared.length} / reexported ${reexportedNames.length} / imported ${imported.length}）`)
})
