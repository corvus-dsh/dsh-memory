/**
 * ── memory 的打包门禁（从 dsh-observer 的 `test/pack-coverage.test.mjs` 移植）──────────────
 *
 * 守什么：`package.json` 的每个指针（`main` / `types` / `dsh.bundle.patch` / `exports` 的每个目标）
 * 都必须真的在 tarball 里；没有开发物泄漏。
 *
 * 为什么单列：`build`/`preflight` 查的是**产物内容**，没有任何东西查
 * 「包里的到底有没有那个文件」。一个指向未打包文件的字段，在仓库里看不出异常 ——
 * 只有装上去了的人才会撞到。
 *
 * `npm pack --dry-run --json` 不需要网络。npm 不可用时按 RESOURCE 规则跳过（不是通过）。
 *
 * ── 与 observer 的差别：本仓把 `scripts/` 也打进包里 ────────────────────────────────────────
 *
 * observer 的 files 只有产物；本仓 package.json 的 files 含 `"scripts"`（那几个 .mjs 是给用户
 * 跑 harvest/consistency 用的），所以「开发物泄漏」的黑名单里**不能**有 `scripts/`。
 * 这条差异必须显式写出来：照抄黑名单会把本仓一个刻意的发包内容判成违规。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'


const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const globToRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]*')}$`, 'u')

/**
 * npm 入口解析。两次实测的坑：`execFileSync('npm')` 在 Windows 上 ENOENT（npm 是 `npm.cmd`，
 * PATHEXT 不解析）；改 `npm.cmd` 后 EINVAL（Node 20+ 禁无 shell spawn `.cmd`）。
 * 优先 `npm_execpath`；否则 Windows 上开 `shell`。
 */
const npmInvocation = () => {
  const execpath = process.env.npm_execpath
  if (typeof execpath === 'string' && execpath.endsWith('.js') && existsSync(execpath)) {
    return { cmd: process.execPath, args: [execpath], shell: false }
  }
  return process.platform === 'win32'
    ? { cmd: 'npm', args: [], shell: true }
    : { cmd: 'npm', args: [], shell: false }
}

const packedFiles = (t) => {
  const { cmd, args, shell } = npmInvocation()
  /**
   * ── 为什么在**临时副本**里跑 npm pack，而不是在本仓里 ────────────────────────────────────────
   *
   * 本仓 `package.json` 有 `"prepare": "node scripts/build.mjs"`，而 `npm pack` 会触发生命周期脚本。
   *
   * 实测（npm 10.9.7 / Node 22，即 CI 上 22.x 那一档）：
   *
   *     $ npm pack --dry-run --json --ignore-scripts
   *     > @corvus-dsh/dsh-memory@0.9.2-beta.1 prepare
   *     > node scripts/build.mjs
   *     built 27 modul…
   *
   * **`--ignore-scripts` 在 npm 10 上拦不住 `prepare`**（`npm_config_ignore_scripts=true` 同样拦不住）；
   * npm 11（Node 24 那一档）能拦住。于是同一份代码：24.x 绿、22.x 红。
   *
   * 红的方式还极具误导性：`prepare` 重建 `lib/`，正在读 `lib/` 的**其它**测试看到半更新产物，
   * 于是 v031 / v032 / v220 偶发失败，`ℹ tests` 总数在 404 / 414 / 419 之间跳 ——
   * 看起来像"并发不稳"，实际是一个只读门禁带了写副作用。
   *
   * 修法不是加参数（加了没用），而是**让副作用无处可落**：
   * 把参与打包判定的文件复制到临时目录，并从副本的 `package.json` 里剥掉 `prepare`，
   * 然后在副本里跑 npm。这样：
   *   · 没有生命周期脚本可跑（副本里根本没有 prepare）；
   *   · 即使 npm 想跑，改的也是临时目录；
   *   · 本仓的 `lib/` 在整个测试过程中只读。
   *
   * 忠实度说明：副本按 `files` 声明 + npm 总会包含的那几个文件复制，
   * 相对路径与真实树一一对应，所以"包里有没有这个指针"的结论等价。
   */
  let temp
  try {
    temp = makePackSandbox()
    const out = execFileSync(cmd, [...args, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: temp, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell,
    })
    return extractJsonArray(out)[0].files.map((f) => f.path)
  } catch (error) {
    t.skip(`npm pack --dry-run unavailable (${String(error.message).slice(0, 80)}) — RESOURCE condition, not a pass`)
    return undefined
  } finally {
    if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
  }
}

/**
 * 造一个"可以安全跑 npm pack"的副本。
 *
 * 复制范围：`package.json`（剥掉 prepare）+ `files` 列出的每个条目 + npm 总会包含的 README/LICENSE。
 * `files` 里若有 glob，则跳过（本仓没有；有的话应当改成显式目录）。
 */
function makePackSandbox () {
  const temp = mkdtempSync(join(tmpdir(), 'pack-eval-'))
  const clone = JSON.parse(JSON.stringify(pkg))
  if (clone.scripts !== undefined) {
    for (const hook of ['prepare', 'prepack', 'postpack', 'prepare']) delete clone.scripts[hook]
  }
  writeFileSync(join(temp, 'package.json'), `${JSON.stringify(clone, null, 2)}\n`, 'utf8')

  const copyInto = (rel) => {
    const from = join(ROOT, rel)
    if (!existsSync(from)) return
    cpSync(from, join(temp, rel), { recursive: true })
  }

  for (const entry of pkg.files ?? []) {
    if (typeof entry !== 'string' || entry.includes('*')) continue
    copyInto(entry.replace(/^\.\//u, '').replace(/\/$/u, ''))
  }
  for (const always of ['README.md', 'LICENSE', 'LICENCE']) copyInto(always)
  return temp
}

/** 括号配平扫描：从每个 `[` 起尝试，返回第一个能解析成数组的切片（防 stdout 前缀污染）。 */
function extractJsonArray (text) {
  for (let start = text.indexOf('['); start >= 0; start = text.indexOf('[', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') { inString = true; continue }
      if (ch === '[') depth += 1
      else if (ch === ']') {
        depth -= 1
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)) } catch { break }
        }
      }
    }
  }
  throw new Error('npm pack --json produced no parseable JSON array')
}

test('pack: every pointer in package.json resolves to a file that is actually packed', (t) => {
  const packed = packedFiles(t)
  if (packed === undefined) return
  const set = new Set(packed)

  const pointers = []
  if (typeof pkg.main === 'string') pointers.push({ field: 'main', target: pkg.main.replace(/^\.\//u, '') })
  if (typeof pkg.types === 'string') pointers.push({ field: 'types', target: pkg.types.replace(/^\.\//u, '') })
  const patch = pkg.dsh?.bundle?.patch
  if (typeof patch === 'string') pointers.push({ field: 'dsh.bundle.patch', target: patch.replace(/^\.\//u, '') })

  const dangling = pointers.filter((p) => !set.has(p.target))
  assert.deepEqual(dangling, [], `package.json points at files that are NOT in the tarball:\n  ${dangling.map((d) => `${d.field} -> ${d.target}`).join('\n  ')}`)

  const badExports = []
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const targets = typeof value === 'string' ? [value] : Object.values(value).filter((v) => typeof v === 'string')
    for (const target of targets) {
      const clean = target.replace(/^\.\//u, '')
      if (clean.includes('*')) {
        const re = globToRegExp(clean)
        if (!packed.some((f) => re.test(f))) badExports.push(`${key} -> ${clean} (glob matches nothing)`)
      } else if (!set.has(clean)) {
        badExports.push(`${key} -> ${clean} (not packed)`)
      }
    }
  }
  assert.deepEqual(badExports, [], `exports contains dangling pointers:\n  ${badExports.join('\n  ')}`)
})

test('pack: no development files leaked into the tarball', (t) => {
  const packed = packedFiles(t)
  if (packed === undefined) return
  /**
   * ── 本仓的黑名单比 observer **少两项**，两项都是刻意的 ─────────────────────────────────────
   *
   * 1. `scripts/` —— `package.json` 的 files 明确包含 "scripts"，那几个 .mjs 是给用户跑
   *    harvest / consistency 的**产品级**入口，不是开发物。
   *
   * 2. `src/` —— 本仓 `types` 字段指向 `./src/index.ts`，即**发布 .ts 源码作为类型定义**
   *    （没有单独的 .d.ts 构建）。所以 src/ 在包里是必须的，不是泄漏。
   *
   * 照抄观察仓的黑名单会把这两项判成违规 —— 那不是本仓的缺陷，是黑名单不通用。
   * **黑名单是仓的策略，不是仪器的规则**，这条差别必须写在这里而不是悄悄删掉。
   *
   * 仍然禁止的：测试、临时目录、CI 配置、文档（这些进了包只会撑大体积）。
   */
  const forbidden = ['test/', '_scratch/', '.github/', 'docs/']
  const leaked = packed.filter((p) => forbidden.some((bad) => p.startsWith(bad)))
  assert.deepEqual(leaked, [], `development files leaked into the tarball:\n  ${leaked.join('\n  ')}`)
  assert.ok(packed.includes('package.json'), 'package.json must be packed')
  assert.ok(packed.includes(pkg.main.replace(/^\.\//u, '')), 'the main entry point must be packed')
  // 既然 types 指向 src，就要断言它真的在包里（否则类型解析会失败在用户机器上）
  if (typeof pkg.types === 'string') {
    assert.ok(packed.includes(pkg.types.replace(/^\.\//u, '')), `types -> ${pkg.types} must be packed (this package ships .ts as its type surface)`)
  }
})

test('pack: the files list and the tarball agree on what is shipped', (t) => {
  /**
   * 第三条：`files` 里写了却没进包（或反之）是一种静默的不一致 ——
   * 作者以为在发，实际没发。只对**非 glob** 的条目前缀做检查。
   */
  const packed = packedFiles(t)
  if (packed === undefined) return
  const set = new Set(packed)
  const declared = (pkg.files ?? []).filter((f) => !f.includes('*'))
  const missing = declared.filter((entry) => {
    const clean = entry.replace(/^\.\//u, '').replace(/\/$/u, '')
    // 目录条目：只要包里存在该前缀下的文件即可
    return !set.has(clean) && !packed.some((p) => p === clean || p.startsWith(`${clean}/`))
  })
  assert.deepEqual(missing, [], `package.json "files" declares entries that produced nothing in the tarball:\n  ${missing.join('\n  ')}`)
})
