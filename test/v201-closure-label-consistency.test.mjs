/**
 * 两戏制：`closureOf` 与 `subBlockClosureOf` 对**同一段源码**必须给出**逐字符相同**的
 * mutable 列表。
 *
 * 背景：`closure.mjs` 里 `closureOf`（`--cluster <name>`）与 `subBlockClosureOf`
 * （`--block`）各自维护一份 mutable 输出。若前者把 const-mutated 标签成
 * `name (const)`、后者仍成 `name (const)`（或反过来），同一个可变绑定就会在
 * "按名字量"和"按块量"两条路径上报出不一致 —— 那种不一致只有看输出时才发现。
 *
 * 修复：两者共用同一个 `mutableLabel` 格式化函数（`closure.mjs` 顶部），"逐字符一致"
 * 因此是结构必然。本测试不是给那个必然兜底，而是**证明它存在**：一旦有人把某一路
 * 标签改成不经过 `mutableLabel`，这里立刻红。
 *
 * 探针就是用户给的 8 行 const-mutate 复现：一个 module const 对象被 `.set` / `.clear` 调用。
 * 期望两条路径都报 `["cache (const-mutated)"]` 且完全一致。
 */

import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { equal } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const PROBE_DIR = join(HERE, 'fixtures', 'closure-consistency')
const PROBE_FILE = 'probe-const-mutate.ts'

const run = (args) => {
  const env = { ...process.env, GRAFT_CLOSURE_SRC: PROBE_DIR }
  const stdout = execFileSync(process.execPath, [join(REPO, 'scripts', 'closure.mjs'), ...args], {
    cwd: REPO, encoding: 'utf8', env,
  })
  const m = stdout.match(/mutable\s*:\s*\[([^\]]*)\]|mutable\s*:\s*(none)/u)
  if (m === null) return `<未匹配到 mutable: ${stdout.slice(0, 200)}>`
  return m[2] === 'none' ? 'none' : `[${m[1].trim()}]`
}

describe('closure 两条路径的 mutable 标签一致', () => {
  it('closureOf(cache) 与 subBlockClosureOf(覆盖同一段) 逐字符相同', () => {
    const viaName = run(['cache'])
    const viaBlock = run(['--block', PROBE_FILE, '1', '17'])
    equal(viaBlock, viaName, '两条路径的 mutable 必须逐字符一致')
  })

  it('都报 const-mutated，不是裸 (const)', () => {
    const viaName = run(['cache'])
    const viaBlock = run(['--block', PROBE_FILE, '1', '17'])
    equal(viaName, '["cache (const-mutated)"]')
    equal(viaBlock, '["cache (const-mutated)"]')
  })
})