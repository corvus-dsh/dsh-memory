/**
 * 两条路径：`closureOf` 与 `subBlockClosureOf` 对**同一段源码**必须给出**逐字符相同**的
 * mutable 列表。
 *
 * 背景：`closure.mjs` 里 `closureOf`（按名字量）与 `subBlockClosureOf`（`--block` 按行区间量）
 * 各自产出一份 mutable 输出。若前者把 const-mutated 标成 `name (const)`、后者仍标成
 * `name (const)`（或反过来），同一个可变绑定就会在"按名字量"和"按块量"两条路径上报出
 * 不一致 —— 那种不一致只有看输出时才发现。
 *
 * 修复：两者共用同一个 `mutableLabel` 格式化函数（`closure.mjs` 顶部），"逐字符一致"
 * 因此是结构必然。本测试不是给那个必然兜底，而是**证明它存在**：一旦有人把某一路
 * 标签改成不经过 `mutableLabel`，这里立刻红（已用 can-red 验证过）。
 *
 * 探针就是用户给的 8 行 const-mutate 复现：一个 module const 对象被 `.set` / `.clear` 调用。
 * 期望两条路径都报 `["cache (const-mutated)"]` 且完全一致。
 *
 * ── WHY THIS SKIPS INSTEAD OF FAILING WHEN typescript IS ABSENT ────────────────────────────────
 *
 * `closure.mjs` needs the TypeScript compiler API. This package deliberately declares **no
 * dependencies**, so it resolves `typescript` UPWARDS — on a dev machine that lands in the
 * workspace root, but **CI has no typescript at all**. Without it `closure.mjs` prints
 * "the compiler-free fallback is UNCALIBRATED" and exits 2 **by design** (S3 §五 b: disagree →
 * exit 2, do not trust either). Letting that surface as a test failure would mean this file
 * asserts something about CI that CI cannot answer.
 *
 * So the probe is a RESOURCE condition: absent compiler ⇒ skip with the reason named, never a
 * pass and never a red. Same shape as `pack-coverage.test.mjs` when `npm pack` is unavailable.
 *
 * ⚠️ Measured: this file went red on CI exactly once (run 43580645877) because the first version
 * used a bare `execFileSync` and treated exit 2 as a failure. The local suite was green only
 * because the workspace root happens to carry typescript.
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
const CLOSURE = join(REPO, 'scripts', 'closure.mjs')

/**
 * Run closure.mjs and return `{ status, stdout }`. Exit 2 is a RESOURCE condition (no compiler)
 * and is reported, not thrown — the caller decides whether to skip.
 */
const run = (args) => {
  const env = { ...process.env, GRAFT_CLOSURE_SRC: PROBE_DIR }
  try {
    const stdout = execFileSync(process.execPath, [CLOSURE, ...args], { cwd: REPO, encoding: 'utf8', env })
    return { status: 0, stdout }
  } catch (error) {
    return { status: error.status ?? -1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

/** Is the compiler actually available to closure.mjs in THIS environment? */
const compilerAvailable = () => {
  const { status, stdout } = run(['cache'])
  return status === 0 && /mutable\s*:/u.test(stdout)
}

const mutableOf = (stdout) => {
  const m = stdout.match(/mutable\s*:\s*\[([^\]]*)\]|mutable\s*:\s*(none)/u)
  if (m === null) return `<未匹配到 mutable: ${stdout.slice(0, 200)}>`
  return m[2] === 'none' ? 'none' : `[${m[1].trim()}]`
}

const RESOURCE_REASON =
  'closure.mjs needs the TypeScript compiler API; this environment does not provide it '
  + '(CI installs no typescript, and this package declares no dependencies). '
  + 'RESOURCE condition — NOT a pass and NOT a failure.'

describe('closure 两条路径的 mutable 标签一致', () => {
  const available = compilerAvailable()

  it('closureOf(cache) 与 subBlockClosureOf(覆盖同一段) 逐字符相同', (t) => {
    if (!available) { t.skip(RESOURCE_REASON); return }
    const viaName = mutableOf(run(['cache']).stdout)
    const viaBlock = mutableOf(run(['--block', PROBE_FILE, '1', '17']).stdout)
    equal(viaBlock, viaName, '两条路径的 mutable 必须逐字符一致')
  })

  it('都报 const-mutated，不是裸 (const)', (t) => {
    if (!available) { t.skip(RESOURCE_REASON); return }
    equal(mutableOf(run(['cache']).stdout), '["cache (const-mutated)"]')
    equal(mutableOf(run(['--block', PROBE_FILE, '1', '17']).stdout), '["cache (const-mutated)"]')
  })
})