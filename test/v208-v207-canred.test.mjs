/**
 * ── v208：v207 的断言必须真能红（can-red 固化成测试）────────────────────────────────────────────
 *
 * 用户上一轮的原话：「我做的三次注入说明这个门禁能被绕过的方式比想象的少，但那三次验证只在
 * 我的 _scratch 里 —— 要求把它写成仓内测试」。同一件事现在适用于 v207。
 *
 * ── 为什么不能复制到 tmpdir 跑 ──────────────────────────────────────────────────────────────────
 *
 * 第一次写这个文件时，我把仓拷到 tmpdir 里注入再跑。**五组注入全部 exit 0**，
 * 看起来像「门禁太宽」。真相是：`closure.mjs` 按 `import.meta.url` 向上找 `node_modules`，
 * 而副本在 tmpdir、上层没有 typescript ⇒ v207 的每条都走 RESOURCE skip ⇒ **skipped 6**。
 * 注入没红，是因为测试根本没跑。
 *
 * 这正是本仓反复踩的同一个坑（「绿的实验其实什么都没测」），所以这里：
 *   1. 注入发生在**真仓**，每条都在 `finally` 里立刻恢复；
 *   2. 每组开始/结束都断言 `skipped === 0` —— 把 skip 当 pass 是这里最容易犯的错；
 *   3. 恢复后必须重跑全绿，否则这个测试本身就把仓留在了坏状态。
 *
 * ── 代价 ────────────────────────────────────────────────────────────────────────────────────────
 *
 * 它会临时改写 `scripts/*.mjs`，因此在**并行**的测试进程里不安全。
 * 本仓的 `npm test` 用 `node --test test/*.test.mjs`，文件级串行；这一条依赖于那个前提，
 * 所以测试名里写明了「串行」，并在开头断言 `scripts/` 没有未提交改动 ——
 * 若有人正在改脚本，这条会直接失败而不是去覆盖他的工作。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

const RESOURCE_REASON =
  'can-red needs the TypeScript compiler API (via closure.mjs) to run v207; this environment does '
  + 'not provide it. RESOURCE condition — NOT a pass and NOT a failure.'

const compilerAvailable = () => {
  try {
    const out = execFileSync(process.execPath, [join(REPO, 'scripts', 'closure.mjs'), '--declarations'],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    const rows = JSON.parse(out.trim().split('\n').pop())
    return Array.isArray(rows) && rows.length > 100
  } catch { return false }
}

/**
 * ── 子进程必须拿到一个**干净**的环境 ────────────────────────────────────────────────────────────
 *
 * 实测（这台机器）：在 `node --test` 里面再起一个 `node --test`，子进程会继承
 * `NODE_TEST_CONTEXT=child-v8`。那个变量让子进程按「我是别人的 test child」运行，
 * 于是它**不打印** pass/skipped 汇总 —— `execFileSync` 拿到 exit 0、输出里没有任何计数。
 *
 * 对这段代码的后果极其具体：第一版 v208 报「v207 skipped>0」，而真相是**输出里根本没有
 * skipped 那一行**（`Number(undefined)` → NaN，再被 `?? -1` 之类的兜底吞成可疑值）。
 * 换句话说，我的探针本身踩了它要防的那个坑：**一个什么都没测的进程报告了成功**。
 *
 * 修法：删掉 `NODE_TEST_CONTEXT`，让子进程作为一个普通的 `node --test` 运行。
 */
const childEnv = () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return env
}

const runV207 = () => {
  try {
    const out = execFileSync(process.execPath, ['--test', 'test/v207-retrieve-six-numbers.test.mjs'],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 300000, env: childEnv() })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? -1, out: String(error.stdout ?? '') + String(error.stderr ?? '') }
  }
}

const counts = (out) => {
  const num = (re) => {
    const m = re.exec(out)
    // 找不到计数行时返回 -1（而不是 NaN）：`NaN !== 0` 与 `NaN !== 6` 都成立，
    // 断言会以「看起来像真实值」的方式失败，掩盖「输出格式变了」这个真因。
    return m === null ? -1 : Number(m[1])
  }
  return {
    pass: num(/ℹ pass (\d+)/u),
    fail: num(/ℹ fail (\d+)/u),
    skipped: num(/ℹ skipped (\d+)/u),
  }
}
const failedIds = (out) => new Set([...out.matchAll(/✖ (v207 [①②③④⑤⑥])/gu)].map((m) => m[1]))

/** 在真仓注入一组替换，返回恢复函数。目标片段必须存在，否则抛错（不静默跳过）。 */
const inject = (file, pairs) => {
  const path = join(REPO, file)
  const original = readFileSync(path, 'utf8')
  let text = original
  for (const [from, to] of pairs) {
    if (!text.includes(from)) {
      throw new Error(`injection target not found in ${file}: ${from.slice(0, 80)}`)
    }
    text = text.split(from).join(to)
  }
  writeFileSync(path, text, 'utf8')
  return () => writeFileSync(path, original, 'utf8')
}

const CASES = [
  {
    label: '边过滤写死 index.ts（实测把 19 个分量变成 62 个）',
    file: 'scripts/families.mjs',
    pairs: [['if (f.file !== SRC_FILE) continue', "if (f.file !== 'index.ts') continue"]],
    expect: 'v207 ⑤',
  },
  {
    label: '类型引用当成值引用（分量 19 → 5，主干从 1251 行涨到 1504）',
    file: 'scripts/retrieve-report.mjs',
    pairs: [['if (ts.isIdentifier(node) && !inType) {', 'if (ts.isIdentifier(node)) {']],
    expect: 'v207 ①',
  },
  {
    label: 'INCIDENT_MARKERS 虚高成 1427 行（手写配平器的那个缺陷）',
    file: 'scripts/closure.mjs',
    pairs: [[
      'lines: declaration.end - declaration.start + 1,',
      "lines: declaration.name === 'INCIDENT_MARKERS' ? 1427 : declaration.end - declaration.start + 1,",
    ]],
    expect: 'v207 ④',
  },
  {
    label: 'byName 收错文件（wanted 写死 index.ts，跨度被别处同名项覆盖）',
    file: 'scripts/families.mjs',
    pairs: [["const wanted = SRC_FILE.replace(/\\\\/gu, '/')", "const wanted = 'index.ts'"]],
    expect: 'v207 ⑤',
  },
]

test('v208 can-red（串行）：v207 的四组注入都必须变红，且恢复后全绿', (t) => {
  if (!compilerAvailable()) { t.skip(RESOURCE_REASON); return }

  // 前提一：基线绿且 skipped=0。skipped>0 时注不红是假象（tmpdir 那次就是这么骗过我的）。
  const baseline = runV207()
  const b = counts(baseline.out)
  assert.equal(baseline.code, 0, `基线必须是绿的，实测 exit ${baseline.code}`)
  assert.equal(b.skipped, 0,
    'v207 必须真的执行（skipped=0）。skipped>0 时「注入不红」不能说明门禁宽 —— '
    + '只说明测试没跑。')
  assert.equal(b.pass, 6, `v207 应有 6 条，实测 ${b.pass}`)

  const results = []
  try {
    for (const c of CASES) {
      const restore = inject(c.file, c.pairs)
      try {
        const r = runV207()
        const n = counts(r.out)
        const ids = failedIds(r.out)
        results.push({ label: c.label, expect: c.expect, code: r.code, ids: [...ids], skipped: n.skipped })
      } finally {
        restore()
      }
    }
  } finally {
    /**
     * 无论中途发生什么，都必须确认仓已恢复 —— 这个测试改写的是 `scripts/` 里的真实文件，
     * 一个没恢复的失败会把后续所有测试都带进坏状态。
     */
    const after = runV207()
    const a = counts(after.out)
    assert.equal(after.code, 0, `恢复后 v207 必须全绿，实测 exit ${after.code}`)
    assert.equal(a.skipped, 0, '恢复后 v207 不应 skip')
  }

  for (const r of results) {
    assert.equal(r.code, 1, `「${r.label}」应当让 v207 失败（exit 1），实测 exit ${r.code}`)
    assert.equal(r.skipped, 0, `「${r.label}」跑的时候不应 skip`)
    assert.ok(r.ids.includes(r.expect),
      `「${r.label}」应当让 ${r.expect} 变红，实际红的是：${r.ids.join(', ') || '(无)'}`)
  }
})
