/**
 * ── v212：`retrieve.ts` 的模块级可变绑定必须为 0（裁定②的机械断言）────────────────────────────────
 *
 * 用户裁定：「文档里写清这一步的理由是『状态与写者同走，retrieve.ts 模块级可变状态归零』（裁定②），
 * 并在搬完后机械断言这一条（模块级可变绑定 = 0），不要只靠人看。」
 *
 * ── 为什么「归零」值得一条门禁 ──────────────────────────────────────────────────────────────────
 *
 * 模块级可变状态让「同一份代码在两次调用之间行为可能不同」这件事**无处可查**：它不是参数、
 * 不是返回值，而是藏在模块顶层。`retrieve.ts` 曾经持有三处：
 *
 *   `let activeStorageTier` / `let tierIndex` / `let tierIndexPath`  → 第二步搬进 storage-tier.ts
 *   `const commitCache = new Map()`（const-mutated）                → 第三步搬进 commit-cache.ts
 *   `const sceneCache  = new Map()`（const-mutated）                → 第五步搬进 scene.ts
 *
 * 这条断言把「搬干净了」从一句话变成一次检查。它不看注释、不看文档，只看编译器的声明表。
 *
 * ── 判据从哪来 ──────────────────────────────────────────────────────────────────────────────────
 *
 * `closure.mjs --declarations` 每行带 `mutable` 字段。**实测它是布尔，不是字符串枚举**：
 *
 *     mutable: false   527 行   （本仓全量实测，2026-11-16）
 *     mutable: true     20 行
 *
 * 第一版这里假设成 `'let/var'` / `'const-mutated'` 之类的字符串集，于是 v212 ② 直接红在
 * 「全仓没有 const-mutated」—— 那个取值根本不存在，是我编的。
 *
 * ⚠ 但 `closure.mjs <symbol>` 的**摘要路径**确实会打印 `["sceneCache (const-mutated)"]`
 * 这种带标签的形态。**两条路径的表示不同**：声明表给布尔，摘要给标签。
 * 用错一条就会得出「没有可变状态」的结论 —— 而 `sceneCache` / `commitCache` 都是
 * `const Map`，正是「字面看不出会变」的那一类。
 *
 * ── 边界 ────────────────────────────────────────────────────────────────────────────────────────
 *
 * · 只查 `src/retrieve.ts`。其它模块（`scene.ts` 持 `sceneCache`、`commit-cache.ts` 持
 *   `commitCache`）**应该**有它们的状态 —— 那正是「状态与写者同走」的结果。
 * · 依赖 typescript（走 closure），所以 CI 上会 skip —— 见 TD-M15：本文件的 2 条属于
 *   「CI 不覆盖的 13 条」里的 2 条（其中 12 条因缺 typescript，1 条因缺 git 历史）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

const RESOURCE_REASON =
  'v212 needs the TypeScript compiler API (via closure.mjs --declarations); this environment does '
  + 'not provide it (CI installs no typescript and this package declares no dependencies). '
  + 'RESOURCE condition — NOT a pass and NOT a failure.'

const TARGET = 'retrieve.ts'

const declarationsOf = () => {
  const out = execFileSync(process.execPath, [join(REPO, 'scripts', 'closure.mjs'), '--declarations'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const rows = JSON.parse(out.trim().split('\n').pop())
  return rows.filter((row) => row.file === TARGET)
}

test('v212 ①: retrieve.ts 的模块级可变绑定 = 0', (t) => {
  let rows
  try {
    rows = declarationsOf()
  } catch {
    t.skip(RESOURCE_REASON)
    return
  }
  assert.ok(rows.length > 20,
    `retrieve.ts 的声明表只有 ${rows.length} 行 —— 扫描器可能指错了文件`)

  /**
   * ⚠ 不能只筛 `mutable !== false`。
   *
   * `closure --declarations` 的 `mutable` 字段对不可变声明给的是 `false`，
   * 对 `let` 给的是 `let/var`，对「const 但被 .set() 改」给的是 `const-mutated`。
   * 三种都要覆盖，尤其最后一种 —— 它就是 `sceneCache` 与 `commitCache` 的形状。
   */
  const mutable = rows.filter((row) => {
    const k = row.mutable
    if (k === false || k === undefined || k === null) return false
    if (typeof k === 'string' && k.length === 0) return false
    return true
  })
  const detail = mutable.map((row) => `${row.name} [${row.kind}] mutable=${JSON.stringify(row.mutable)} L${row.start}`)
  assert.deepEqual(detail, [],
    '`retrieve.ts` 里还有模块级可变绑定。模块级可变状态让「两次调用之间行为可能不同」无处可查；'
    + '按「状态与写者同走」把它们和写者一起搬进独立模块：\n  ' + detail.join('\n  '))
})

test('v212 ②: 判据能分辨 —— 布尔 true 确实抓得住 `const Map` 那一类', (t) => {
  let all
  try {
    all = JSON.parse(execFileSync(process.execPath,
      [join(REPO, 'scripts', 'closure.mjs'), '--declarations'],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim().split('\n').pop())
  } catch {
    t.skip(RESOURCE_REASON)
    return
  }

  /**
   * 反向断言：判据不能只看 `let/var`。若只看那个，`sceneCache`/`commitCache`
   * （都是 `const Map`，被 `.set/.clear` 变异）就会被漏掉 —— 而它们正是这条断言要抓的形状。
   *
   * 证据：全仓至少有一个 `mutable: true`、`kind: 'const'` 的声明。
   */
  const constMutated = all.filter((row) => row.mutable === true && row.kind === 'const')
  assert.ok(constMutated.length > 0,
    '全仓没有 mutable=true 的 const 声明 —— 那 `mutable` 字段就抓不住 `const Map` 这一类，'
    + '本判据在当前工具版本上无效，需要重新校准（不要改断言去迁就工具）')

  // 它们确实搬到了各自的新模块，而不是被删掉
  const byName = new Map(all.map((row) => [row.name, row]))
  for (const [name, expectedFile] of [['sceneCache', 'retrieve/scene.ts'], ['commitCache', 'retrieve/commit-cache.ts']]) {
    const row = byName.get(name)
    assert.ok(row !== undefined, `${name} 应该还在仓里（搬进了 ${expectedFile}），实际找不到 —— 它被删了吗？`)
    assert.equal(row.file, expectedFile, `${name} 应在 ${expectedFile}，实际在 ${row.file}`)
    assert.equal(row.mutable, true, `${name} 是 const Map，应报 mutable=true`)
  }

  // retrieve.ts 里一个都没有
  const inRetrieve = all.filter((row) => row.file === TARGET && row.mutable === true)
  assert.deepEqual(inRetrieve.map((r) => r.name), [],
    `retrieve.ts 里仍有可变绑定：${inRetrieve.map((r) => r.name).join(', ')}`)
})
