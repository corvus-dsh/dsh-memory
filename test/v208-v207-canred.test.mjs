/**
 * ── v208：v207 的断言必须真能红（can-red 固化成测试）────────────────────────────────────────────
 *
 * 用户要求：「v208 改成不碰真仓（照 v205 的『纯函数 + 假树』或 v144 的临时副本 + 依赖可用）」。
 *
 * ── 为什么必须“临时副本 + 依赖可用” ────────────────────────────────────────────────────────────
 *
 * v207 与 v209 都通过 `scripts/closure.mjs` 取编译器行区间。而 `closure.mjs` 靠
 * `import.meta.url` **向上**找 `node_modules`：
 *
 *     D:/持久层能力架构/node_modules/typescript      ← 工作区根，本包没有依赖
 *
 * 所以副本如果放在 `os.tmpdir()`，上面没有任何 `node_modules`，closure 拿不到编译器，
 * v207 的每条都走 RESOURCE **skip**。第一版 v208 就是这么写的：把仓拷到 tmpdir 里注入，
 * **五组注入全部 exit 0**，看起来像「门禁太宽」，实际上是**测试根本没跑**（skipped=6）。
 *
 * 这正是本仓反复踩的那个形状：一个什么都没测的进程报告了成功。
 *
 * 修法两条同时满足：
 *   1. 副本放在**真实仓内部**的临时目录（`<repo>/.canred-*`），于是向上仍能找到工作区的
 *      `node_modules` —— 依赖可用。
 *   2. 注入只改副本，真仓的 `scripts/` **一个字节都不动** —— 并可并行跑。
 *
 * ── 与 v207 的关系 ──────────────────────────────────────────────────────────────────────────────
 *
 * v207 用 `new URL('../scripts/…')` 定位脚本，而副本是「仓 + test/ + scripts/ + src/」的完整镜像，
 * 所以只要 `cwd` 指到副本，v207 就会读副本里的 `scripts/`。这就是注入生效的机制。
 *
 * ── 第二层坑：NODE_TEST_CONTEXT ─────────────────────────────────────────────────────────────────
 *
 * 在 `node --test` 里再起 `node --test`，子进程会继承 `NODE_TEST_CONTEXT=child-v8`，
 * 于是它**不打印** pass/skipped 汇总（execFileSync 只拿到 exit 0 和空计数）。
 * 第一版因此读到 `skipped=undefined`。所以子进程环境必须删掉这个变量。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

const RESOURCE_REASON =
  'can-red needs the TypeScript compiler API (via closure.mjs) to run v207; this environment does '
  + 'not provide it. RESOURCE condition — NOT a pass and NOT a failure.'

/** 子进程环境：删掉 NODE_TEST_CONTEXT，否则它按 test-child 跑、不打印汇总。 */
const childEnv = () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return env
}

const compilerAvailable = () => {
  try {
    const out = execFileSync(process.execPath, [join(REPO, 'scripts', 'closure.mjs'), '--declarations'],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    const rows = JSON.parse(out.trim().split('\n').pop())
    return Array.isArray(rows) && rows.length > 100
  } catch { return false }
}

/**
 * 建一个「仓的镜像」：`scripts/` + `src/` + `test/` + `package.json`。
 *
 * 放在**真实仓内部**（`<repo>/.canred-XXXX`）而不是 `os.tmpdir()`：
 * 这样 `closure.mjs` 向上找 `node_modules` 时仍能命中工作区根的那份编译器。
 */
const mirror = () => {
  const root = mkdtempSync(join(REPO, '.canred-'))
  for (const dir of ['scripts', 'src', 'test', 'docs']) {
    cpSync(join(REPO, dir), join(root, dir), { recursive: true })
  }
  cpSync(join(REPO, 'package.json'), join(root, 'package.json'))
  /**
   * ── 副本必须能解析 `git show <历史提交>` ──────────────────────────────────────────────────────
   *
   * v207 ①b 会 `git show 0381c6c:src/retrieve.ts` 来重算「搬前」快照。副本若没有可用的
   * 对象库，那条会失败 ⇒ v207 exit 1 ⇒ 这里的「基线必须绿」直接红。
   *
   * 用 `objects/info/alternates` 把副本指向**原仓的对象库**：
   *   · 不复制 .git（几十 MB，且副本会被反复创建）；
   *   · 只读共享对象，副本自己的写操作不碰原仓；
   *   · `git show <sha>` / `git ls-tree` 都能工作。
   *
   * 这是 git 官方的「借对象」机制，不是 hack。
   */
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'v208@test.local')
  git('config', 'user.name', 'v208')
  git('config', 'commit.gpgsign', 'false')
  mkdirSync(join(root, '.git', 'objects', 'info'), { recursive: true })
  writeFileSync(join(root, '.git', 'objects', 'info', 'alternates'),
    join(REPO, '.git', 'objects') + '\n', 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'mirror base')
  return root
}

const runV207In = (root) => {
  try {
    const out = execFileSync(process.execPath, ['--test', 'test/v207-retrieve-six-numbers.test.mjs'],
      { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 300000, env: childEnv() })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? -1, out: String(error.stdout ?? '') + String(error.stderr ?? '') }
  }
}

const counts = (out) => {
  const num = (re) => {
    const m = re.exec(out)
    return m === null ? -1 : Number(m[1])
  }
  return {
    pass: num(/ℹ pass (\d+)/u),
    fail: num(/ℹ fail (\d+)/u),
    skipped: num(/ℹ skipped (\d+)/u),
  }
}
const failedIds = (out) => new Set([...out.matchAll(/✖ (v207 [①②③④⑤⑥])/gu)].map((m) => m[1]))

/** 在**副本**里替换，返回恢复函数（供同一副本内多组注入复用）。 */
const inject = (root, file, pairs) => {
  const path = join(root, file)
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

test('v208 can-red：v207 的四组注入都必须变红（在仓内临时副本里，不动真仓）', (t) => {
  if (!compilerAvailable()) { t.skip(RESOURCE_REASON); return }

  const root = mirror()
  try {
    // 前提一：副本里基线绿且 skipped=0。skipped>0 时注不红是假象（tmpdir 那次就是这么骗过我的）。
    const baseline = runV207In(root)
    const b = counts(baseline.out)
    assert.equal(baseline.code, 0, `副本里基线必须绿，实测 exit ${baseline.code}\n${baseline.out.slice(-800)}`)
    assert.equal(b.skipped, 0,
      'v207 必须真的执行（skipped=0）。skipped>0 时「注入不红」不能说明门禁宽 —— '
      + '只说明测试没跑。副本放在仓内才有编译器可用。')
    /**
     * v207 的条数与 skip 数：完整克隆 7 条全跑；浅克隆（CI 的 fetch-depth: 1）下 ①b 会
     * RESOURCE skip，剩 6 条。
     *
     * 这里读实际条数而**不是只写死 7**：浅克隆下 assert pass===7 会让这条门禁在 CI 上红，
     * 而红的原因是环境而不是被测代码。但也不能直接 `>= 6` 放过一切 —— 所以**同时**断言
     * skip 数恰好等于「①b 一条」，这样「少跑两条」仍然会被看见。
     */
    const totalRun = b.pass + b.skipped
    assert.equal(totalRun, 7, `v207 应有 7 条（含 skip），实测 pass=${b.pass} skipped=${b.skipped}`)
    assert.ok(b.skipped <= 1,
      `v207 最多允许 1 条 skip（①b 缺历史提交时），实测 skipped=${b.skipped} —— `
      + '多于 1 条说明还有别的测试在跳过，那些结论就不可信了')

    for (const c of CASES) {
      const restore = inject(root, c.file, c.pairs)
      try {
        const r = runV207In(root)
        const n = counts(r.out)
        const ids = failedIds(r.out)
        assert.equal(r.code, 1, `「${c.label}」应当让 v207 失败（exit 1），实测 exit ${r.code}`)
        assert.equal(n.skipped, 0, `「${c.label}」跑的时候不应 skip`)
        assert.ok(ids.has(c.expect),
          `「${c.label}」应当让 ${c.expect} 变红，实际红的是：${[...ids].join(', ') || '(无)'}`)
      } finally {
        restore()
      }
    }

    // 恢复后副本必须重新全绿 —— 证明「变红是注入造成的」，不是副本本身坏了。
    const after = runV207In(root)
    const a = counts(after.out)
    assert.equal(after.code, 0, `恢复后副本应全绿，实测 exit ${after.code}`)
    assert.equal(a.skipped, 0, '恢复后不应 skip')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
