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

/**
 * ── W4-2b: EACH INJECTION ONLY NEEDS THE TEST IT SHOULD BREAK (measured) ──────────────────────
 *
 * Measured 2026-11-20: this file took **97–102 s** — the single largest item in the memory suite.
 * The cause is arithmetic, not a clumsy test: `runV207In` spawns the WHOLE v207 file (15.8 s) and it
 * is called SIX times (baseline + four injections + restore) ⇒ ≈95 s.
 *
 * ── WHY THE OBVIOUS FIX (MERGE THE FOUR INJECTIONS INTO ONE RUN) IS NOT AVAILABLE ───────────────
 *
 * Two of the four cases inject into the SAME file (`families.mjs`) and expect the SAME test to go
 * red (`v207 ⑤`, cases ① and ④ in `CASES`). Merging them would still produce one red — and the
 * assertion could no longer say WHICH injection caused it, which is the entire value of a can-red:
 * 「if I break X, test Y notices」. A merged red proves only that something in the pile mattered.
 *
 * ── WHAT IS ACTUALLY REDUNDANT: THE SCOPE OF EACH RUN ─────────────────────────────────────────
 *
 * Every injection only needs the ONE test it is supposed to break. What must not regress — that the
 * rest of v207 still passes — is guaranteed by the BASELINE and the RESTORE, both of which still run
 * the full file. So the middle four narrow to `--test-name-pattern` and the guarantees stay:
 *
 *   baseline (full, green)         proves v207 is healthy before we touch anything
 *   4 × narrowed (one test each)   proves each injection breaks the test it claims to break
 *   restore (full, green)          proves the reds came from the injections, not from a broken mirror
 *
 * Measured: the narrowed runs cost 2–7 s each (module load dominates), so the file goes from ≈95 s
 * of child time to ≈35 s.
 *
 * ── AND THE THING THAT MUST NOT BE DONE FOR SPEED ────────────────────────────────────────────
 *
 * The injections stay REAL edits to a real copy that a real compiler re-reads. Turning them into
 * "assume this would fail" would replace a proof with a 0.00 s reading — the exact defect W4-3 and
 * W4-5 both had to be repaired for.
 */
const runV207In = (root, namePattern) => {
  try {
    /**
     * `--test-name-pattern` narrows the run. It is passed ONLY where a single named test is expected
     * to go red; the baseline and the restore pass nothing, so they still exercise the whole file.
     */
    const args = ['--test', 'test/v207-retrieve-six-numbers.test.mjs']
    if (namePattern !== undefined) args.splice(1, 0, '--test-name-pattern', namePattern)
    const out = execFileSync(process.execPath, args,
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
    /**
     * ── 只保留一条断言：`pass + skipped === 7` ──────────────────────────────────────────────────
     *
     * 用户裁定④：两条断言择一。原先这里同时有
     *   (a) `pass + skipped === 7`
     *   (b) `skipped <= 1`
     * 两条都在试图表达「v207 真的跑了 7 条」，但**职责重复且各漏一半**：
     *   · (a) 单独存在时，`pass=2 / skipped=5` 也满足 —— 测了，但只测了两条；
     *   · (b) 单独存在时，`pass=3 / skipped=1`（共 4 条）也满足 —— 跑的都跑了，但少了三条。
     *
     * 保留 (a) 的理由：**「v207 是否真的执行」这件事，下面的 can-red 循环已经在管了。**
     * 每次注入都要求 v207 的某条**具体**测试变红（④→⑤ 那条 `expect`）；若 v207 大面积 skip，
     * 注入就不会让任何测试变红，那个 `assert.ok(ids.has(c.expect))` 立刻失败。
     * 所以再在基线上加一条 `skipped <= 1` 是冗余的 —— 它想保证的事已被更强的断言覆盖。
     *
     * 而 (a) 保护的是另一件事：**v207 的测试清单本身不能缩水**。少一条（被删、被 merge 掉、
     * 被改成 `test.skip` 以外的形态）时 (a) 会红，上面那套 can-red 不会 —— 因为注入仍然
     * 能让剩下的某条红。两条断言的盲区不重叠，所以留「清单完整性」这条，而不是重复的「执行性」。
     *
     * ⚠ `compilerAvailable() === false` 时的行为**保持不变**：整条测试在函数开头
     *    `if (!compilerAvailable()) { t.skip(RESOURCE_REASON); return }` 就退出了，
     *    根本走不到这里。换句话说：CI 没有 typescript 时，v208 是**一条明确的 skip**，
     *    不是「跑过了」也不是「失败」。这一点与裁定③的处置配套（见 README 与
     *    ARCHITECTURE.md 的「CI 不覆盖」说明）。
     *
     * ── 又删掉了一条（2026-11-16，用户裁定）──────────────────────────────────────────────────────
     *
     * 这里原先还有第三条：`assert.equal(b.skipped, 0, 'v207 必须真的执行…')`。
     * 它与 (a) 的组合是**要求 pass 恰好 7、skip 恰好 0** —— 那在浅克隆下直接红
     * （`①b` 会 RESOURCE skip），于是同一个「CI 不覆盖」的事实被表达了两遍。
     *
     * 现在只留 (a)：它容得下 `pass=6 / skipped=1`（浅克隆）与 `pass=7 / skipped=0`（完整克隆），
     * 而「少了一条测试」仍然会红。跳过的具体原因由 `①b` 自己的 RESOURCE reason 打印，
     * 不需要在这里再断言一次。
     */
    const totalRun = b.pass + b.skipped
    assert.equal(totalRun, 7, `v207 应有 7 条（含 skip），实测 pass=${b.pass} skipped=${b.skipped}`)

    for (const c of CASES) {
      const restore = inject(root, c.file, c.pairs)
      try {
        /**
         * W4-2b: narrow to the test this injection is supposed to break. The `expect` id is exactly
         * the name pattern, so the run and the assertion agree by construction — a mismatch would
         * surface as `r.code === 0` (nothing ran red) rather than as a silent pass.
         */
        const r = runV207In(root, c.expect)
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
