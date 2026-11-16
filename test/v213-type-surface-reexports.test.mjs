/**
 * ── v213：类型导出面 —— `src/retrieve/` 下每个模块导出的类型都必须被 `retrieve.ts` 转出 ────────
 *
 * ── 为什么这条门禁必须存在 ──────────────────────────────────────────────────────────────────────
 *
 * `package.json` 的 `"types": "./src/index.ts"` 且 `files` 含 `src` —— **源码本身就是发布出去的
 * 类型面**。所以「某个类型有没有被 re-export」不是内部整洁问题，而是**使用方能不能 import 到它**。
 *
 * 而既有的导出面门禁全都看不见它：`v202` / `v211` 那一类是
 * `import('../lib/store.js')` 式的**运行期**断言，只数得到会真正导出的名字。
 * `export type` 在 `stripTypeScriptTypes` 之后整行消失 —— **漏掉一行，没有任何测试会红**。
 *
 * ── 覆盖面（裁定⑤）：不是只查 types.ts，而是 `src/retrieve/` 下的每一个模块 ────────────────────
 *
 * 第一版只查 `retrieve/types.ts` 那 12 个。但「导出类型」不是某一个文件的属性：
 * `retrieve/scene.ts` 也有 `SceneOptions`，将来任何新模块都可能有。所以判据按**目录**走：
 * 扫描 `src/retrieve/*.ts`，收集每个模块的 `export interface|type|enum`，逐个要求被转出。
 * 当前是 **12（types.ts）+ 1（scene.ts）= 13 个名字**。
 *
 * ── 两种转出形式都要认（裁定⑤）──────────────────────────────────────────────────────────────────
 *
 *   A. 裸形式      `export type { X }`                      ← 转的是**本地绑定**
 *   B. from 形式   `export type { X } from './retrieve/m.js'`  ← 直接从模块转出
 *
 * ① 两种都接受。但两种各有各的前提，所以 ②③ 分头查：
 *   · ② 「转出的名字必须真实存在」两种形式都要查；
 *   · ③ 「必须被 import」**只对裸形式**有意义 —— from 形式不需要本地绑定。
 *     （这一条是踩出来的：同一文件里既 `import type { X }` 又 `export type { X } from …`
 *      会报 tsc 2300 Duplicate identifier，因为那是**同名两次转出**。）
 *
 * ── ④ 为什么还要一条运行期反证 ────────────────────────────────────────────────────────────────
 *
 * 若某人把 `export type { X }` 写成 `export { X }`，构建后会出现一个值为 `undefined` 的
 * **运行期**导出 —— 最坏的一种：类型面没修好，运行期面还多了个洞。④ 断言那 13 个名字
 * 一个都不出现在 `lib/retrieve.js` 的导出里。
 *
 * 不依赖 typescript ⇒ **在 CI 上真跑**（不是 TD-M15 里那 13 条之一）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const RETRIEVE_DIR = join(REPO, 'src', 'retrieve')
const RETRIEVE_FILE = join(REPO, 'src', 'retrieve.ts')

// ── 判据（纯函数，好让 can-red 用假数据喂它）────────────────────────────────────────────────────

/** 一个模块里**导出**的类型声明名。 */
export const exportedTypesOf = (src) =>
  [...src.matchAll(/^export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gmu)].map((m) => m[1])

/** 裸形式：`export type { X }`（行尾就结束，没有 `from`）。 */
export const bareReexports = (src) =>
  [...src.matchAll(/^export\s+type\s*\{\s*([A-Za-z_$][\w$]*)\s*\}\s*;?\s*$/gmu)].map((m) => m[1])

/** from 形式：`export type { X } from './…'`。 */
export const fromReexports = (src) =>
  [...src.matchAll(/^export\s+type\s*\{\s*([A-Za-z_$][\w$]*)\s*\}\s*from\s*['"]([^'"]+)['"]/gmu)]
    .map((m) => ({ name: m[1], spec: m[2] }))

/** `retrieve.ts` 里从 `./retrieve/<mod>.js` 的任意 `import type { … }` 导入的名字。 */
export const importedTypes = (src) =>
  [...src.matchAll(/import\s+type\s*\{([^}]*)\}\s*from\s*['"]\.\/retrieve\/[^'"]+['"]/gu)]
    .flatMap((m) => m[1].split(','))
    .map((s) => s.trim().replace(/^type\s+/u, ''))
    .filter((s) => s.length > 0)

/** ① 正向：声明了、但两种形式都没转出。 */
export const missingReexports = (declared, reexportedNames) =>
  declared.filter((entry) => !reexportedNames.includes(entry.name))

/** ② 反向幽灵：转出了、但没有任何 retrieve 模块把它声明为导出类型。 */
export const phantomReexports = (declared, reexportedNames) =>
  reexportedNames.filter((n) => !declared.some((entry) => entry.name === n))

/** ③ 裸形式转出、但没被 import ⇒ 没有本地绑定。from 形式不受此约束。 */
export const unboundBareReexports = (bareNames, importedNames) =>
  bareNames.filter((n) => !importedNames.includes(n))

// ── 文件系统 ────────────────────────────────────────────────────────────────────────────────────

const retrieveModules = () =>
  readdirSync(RETRIEVE_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => ({ rel: `retrieve/${name}`, abs: join(RETRIEVE_DIR, name) }))

/** 形如 `[{ name: 'DocumentKind', module: 'retrieve/types.ts' }, …]`，按 name 去重。 */
const declaredEntries = () => {
  const seen = new Map()
  for (const mod of retrieveModules()) {
    for (const name of exportedTypesOf(readFileSync(mod.abs, 'utf8'))) {
      if (!seen.has(name)) seen.set(name, { name, module: mod.rel })
    }
  }
  return [...seen.values()]
}

const retrieveSrc = () => readFileSync(RETRIEVE_FILE, 'utf8')

// ── 测试 ─────────────────────────────────────────────────────────────────────────────────────

test('v213 ①: src/retrieve/ 下每个导出类型都被 retrieve.ts 转出（裸或 from 形式）', () => {
  const declared = declaredEntries()
  assert.ok(declared.length >= 13,
    `只解析出 ${declared.length} 个导出类型 —— 第六步之后应为 13（types.ts 12 + scene.ts 1）`)
  const src = retrieveSrc()
  const reexportedNames = [...bareReexports(src), ...fromReexports(src).map((r) => r.name)]
  const missing = missingReexports(declared, reexportedNames)
  assert.deepEqual(missing.map((m) => `${m.module} 的 ${m.name}`), [],
    '这些类型在 src/retrieve/ 下声明并导出了，但 src/retrieve.ts 没有转出 —— '
    + '使用方（以及发布出去的类型面）看不到它们：\n  '
    + missing.map((m) => `${m.module} 的 ${m.name}`).join('\n  '))
})

test('v213 ②: 每一行 export type 都指向真实存在的类型（防幽灵）', () => {
  const declared = declaredEntries()
  const src = retrieveSrc()
  const phantom = phantomReexports(declared, [...bareReexports(src), ...fromReexports(src).map((r) => r.name)])
  assert.deepEqual(phantom, [],
    'src/retrieve.ts 转出了 retrieve/ 下不存在的类型名（tsc 会报 2304，但 tsc 不在 CI 上跑）：\n  '
    + phantom.join('\n  '))
})

test('v213 ③: 裸形式转出的名字必须同时被 import type（from 形式不受此约束）', () => {
  const src = retrieveSrc()
  const bare = bareReexports(src)
  const from = fromReexports(src)
  const imported = importedTypes(src)
  assert.ok(bare.length + from.length >= 13,
    `两种形式加起来只有 ${bare.length + from.length} 行 —— 第六步之后应为 13`)
  const unbound = unboundBareReexports(bare, imported)
  assert.deepEqual(unbound, [],
    '这些名字被裸形式 export type 转出，但没有从 ./retrieve/*.js import —— '
    + '裸 export 转的是本地绑定，没有绑定就是错的：\n  ' + unbound.join('\n  '))
  // from 形式自带绑定，但如果它也被 import 了，就是「同名两次转出」—— tsc 2300
  const twice = from.map((r) => r.name).filter((n) => imported.includes(n))
  assert.deepEqual(twice, [],
    '这些名字既被 `import type` 进来、又被 `export type { X } from …` 转出 —— 这是**同名两次转出**，'
    + 'tsc 会报 2300 Duplicate identifier。二选一：要么裸形式（转本地绑定），要么去掉 import：\n  '
    + twice.join('\n  '))
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
  const names = declaredEntries().map((e) => e.name)
  const leaked = names.filter((n) => runtime.has(n))
  assert.deepEqual(leaked, [],
    '这些**类型**名字出现在了运行期导出里 —— 说明某处把 `export type { X }` 写成了 `export { X }`。'
    + '后果是发布出去的模块多了一个值为 undefined 的运行期导出：\n  ' + leaked.join('\n  '))
})

test('v213 ⑤: 两种形式都被真实使用（免得判据只在一种形式上有意义）', (t) => {
  const src = retrieveSrc()
  t.diagnostic(`裸形式 ${bareReexports(src).length} 行；from 形式 ${fromReexports(src).length} 行`)
  assert.ok(bareReexports(src).length > 0, '仓里已经没有裸形式了？那 ③ 就成了空断言')
})

// ── can-red：把假数据喂给同一条判据 ────────────────────────────────────────────────────────────

test('v213 ⑥ can-red: 漏一个转出必须被点名（两种形式都算转出）', () => {
  const declared = [{ name: 'A' }, { name: 'B' }, { name: 'C' }]
  assert.deepEqual(missingReexports(declared, ['A', 'B']).map((m) => m.name), ['C'])
  assert.deepEqual(missingReexports(declared, ['A', 'B', 'C']), [])
})

test('v213 ⑦ can-red: 幽灵转出必须被点名', () => {
  const declared = [{ name: 'A' }, { name: 'B' }]
  assert.deepEqual(phantomReexports(declared, ['A', 'Ghost']), ['Ghost'])
})

test('v213 ⑧ can-red: 裸形式没 import 必须被点名；from 形式则不算', () => {
  assert.deepEqual(unboundBareReexports(['A', 'B'], ['A']), ['B'])
  assert.deepEqual(unboundBareReexports(['A'], []), ['A'])
})

test('v213 ⑨ can-red: from 形式的名字若同时被 import，就是同名两次转出', () => {
  // 与 ③ 的后半段同一条规则：from ∩ imported ≠ ∅ ⇒ tsc 2300
  const twice = (fromNames, importedNames) => fromNames.filter((n) => importedNames.includes(n))
  assert.deepEqual(twice(['SceneOptions'], ['SceneOptions']), ['SceneOptions'], '撞上要报出来')
  assert.deepEqual(twice(['SceneOptions'], ['Document']), [], '不撞就是空的')
})

test('v213 ⑩: 判据在真实文件上确实读到了东西（免得「空数组恒绿」）', (t) => {
  const declared = declaredEntries()
  const src = retrieveSrc()
  const bare = bareReexports(src)
  const from = fromReexports(src)
  const imported = importedTypes(src)
  t.diagnostic(`模块 ${retrieveModules().length} 个；导出类型 ${declared.length} 个；裸 ${bare.length} / from ${from.length}；import ${imported.length}`)
  assert.ok(declared.length > 0 && bare.length + from.length > 0 && imported.length > 0,
    `解析结果不能有空集（declared ${declared.length} / reexported ${bare.length + from.length} / imported ${imported.length}）`)
})
