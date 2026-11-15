/**
 * `verify-pure-move` 的格式修正豁免：四个场景，全部在**临时 git 仓库**里跑真实子进程。
 *
 * 为什么必须 in-repo 且不 skip：
 *   豁免机制是「防止门禁腐烂」的那一半。它的失败模式很安静 —— 注册表被放宽一点、
 *   匹配逻辑漏掉一侧、STALE 判定退化成永远通过 —— 任何一种都不会让现有测试变红，
 *   只会让这条门禁从此不再拦住任何东西。所以它需要自己的测试。
 *
 * 为什么**不依赖 typescript**：
 *   `verify-pure-move.mjs` 是纯文本多重集比较（contentLines 里没有编译器）。
 *   上一轮 V201 因为依赖 typescript 在 CI 上红过一次；这里刻意不重犯。
 *   四个场景只用 `git` + `node`，CI 一定有。
 *
 * 四个场景：
 *   ① 只有登记的那一对差异                 → exit 0，输出含 KNOWN FORMAT CORRECTION
 *   ② 登记对 + 一处未解释差异               → exit 1
 *   ③ 登记项描述的修正行不在树里             → exit 1，输出含 STALE REGISTRY ENTRY
 *   ④ 注册表被放宽（吞掉一处真实编辑）        → exit 1   ← 这条是防「豁免变成万能钥匙」
 *
 * 场景④通过 `PPM_CORRECTIONS_JSON` 注入一个更宽松的注册表来构造：它没有改任何文件，
 * 也没有走和真实运行不同的代码路径（匹配规则、STALE 逻辑、退出码都是同一段代码）。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { equal, match } from 'node:assert'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRIPT = join(REPO, 'scripts', 'verify-pure-move.mjs')

/** A throwaway git repo containing a copy of the checker and one source file. */
const makeRepo = (initialSource) => {
  const root = mkdtempSync(join(tmpdir(), 'ppm-v203-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(SCRIPT, join(root, 'scripts', 'verify-pure-move.mjs'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'v203@test.local')
  git('config', 'user.name', 'v203')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'src', 'a.ts'), initialSource, 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'base')
  return root
}

/** Run the checker inside that repo; returns { code, out }. Exit 1 is data, not an exception. */
const runChecker = (root, env = {}) => {
  try {
    const out = execFileSync(process.execPath, [join(root, 'scripts', 'verify-pure-move.mjs')],
      { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? -1, out: String(error.stdout ?? '') + String(error.stderr ?? '') }
  }
}

const write = (root, text) => writeFileSync(join(root, 'src', 'a.ts'), text, 'utf8')

// 登记的修正对：行首两个空格 → 无缩进
const GONE = '  function parseEvidenceField(raw: string, fallbackSession: string): EvidenceRef[] {'
const CAME = 'function parseEvidenceField(raw: string, fallbackSession: string): EvidenceRef[] {'

/**
 * ── 场景①②④b 必须**自己指定**注册表，不能依赖常驻的那一份 ──────────────────────────────────
 *
 * 2026-11-15 踩到的：`KNOWN_FORMAT_CORRECTIONS` 从 1 条涨到 3 条之后，场景①突然红了 ——
 * 因为临时仓库 `src/a.ts` 里只有 `parseEvidenceField` 那一对，另外两条登记项的 `appeared`
 * 行当然不存在，于是被判 **STALE**，而 STALE 是失败。
 *
 * 这不是新条目写错了，是**测试不自足**：它借用了常驻注册表，于是常驻表的每一次增长都会
 * 改变它的结论。情形与场景⑤早就示范过的一样 —— 那里已经用 `PPM_CORRECTIONS_JSON: '[]'`
 * 把注册表清空，只是 ①②④b 没跟上。
 *
 * 所以这几条显式注入「只含本测试需要的那一条」的注册表。这样：
 *   · 常驻表继续增长不会让它们红；
 *   · 它们仍然走**真实代码路径**（匹配、STALE、退出码都是同一段），不是伪造的判定；
 *   · 场景④/⑤ 的「注入更宽松的注册表」语义不受影响。
 */
const REGISTRY_WITH_BF35562 = JSON.stringify([{
  commit: 'bf35562',
  reason: '（测试注入）parseEvidenceField 的 2 空格缩进修正 —— 与常驻表那条同义',
  disappeared: GONE,
  appeared: CAME,
}])

describe('verify-pure-move 的格式修正豁免', () => {
  it('① 只有登记的那一对差异 → exit 0，并报出 KNOWN FORMAT CORRECTION', () => {
    const root = makeRepo(`${GONE}\n`)
    write(root, `${CAME}\n`)
    const { code, out } = runChecker(root, { PPM_CORRECTIONS_JSON: REGISTRY_WITH_BF35562 })
    equal(code, 0, `只含登记对时应当通过，实际 exit ${code}\n${out}`)
    match(out, /KNOWN FORMAT CORRECTION/u, '必须把豁免**报出来**，不能静默放过')
    match(out, /nothing unexplained/u)
    rmSync(root, { recursive: true, force: true })
  })

  it('② 登记对 + 一处未解释差异 → exit 1', () => {
    const root = makeRepo(`${GONE}\n`)
    write(root, `${CAME}\nconst smuggled = 1\n`)
    const { code, out } = runChecker(root, { PPM_CORRECTIONS_JSON: REGISTRY_WITH_BF35562 })
    equal(code, 1, `存在未解释差异时必须失败\n${out}`)
    match(out, /KNOWN FORMAT CORRECTION/u, '登记项本身仍应被报出')
    match(out, /smuggled|unexplained/u, '未解释的那一行必须被点名')
    rmSync(root, { recursive: true, force: true })
  })

  it('③ 登记项描述的修正行不在树里 → STALE，exit 1', () => {
    // 树里既没有 GONE 也没有 CAME：登记项描述的东西已不存在
    const root = makeRepo('const unrelated = 1\n')
    write(root, 'const unrelated = 2\n')
    const { code, out } = runChecker(root, { PPM_CORRECTIONS_JSON: REGISTRY_WITH_BF35562 })
    equal(code, 1, `登记项朽坏必须失败\n${out}`)
    match(out, /STALE REGISTRY ENTRY/u, '必须明确报 STALE，而不是静默忽略')
    rmSync(root, { recursive: true, force: true })
  })

  it('④ 注册表被放宽成空串（企图宽恕任意差异）→ 仍然 exit 1', () => {
    // 「放宽」的真实形态：有人把登记项写成空串，指望它匹配任何消失/出现的行。
    // 当前匹配是**精确行相等**，所以空串匹配不上任何真实代码行 ——
    // 这条测试锁住那个性质：豁免是「点对点登记」，不是「通配开关」。
    const root = makeRepo('const real = 1\n')
    write(root, 'const edited = 2\n')
    const wildcardish = JSON.stringify([{
      commit: 'deadbeef',
      reason: '（测试注入）空串条目，企图宽恕任意差异',
      disappeared: '',
      appeared: '',
    }])
    const { code, out } = runChecker(root, { PPM_CORRECTIONS_JSON: wildcardish })
    equal(code, 1, `空串条目绝不能宽恕真实编辑\n${out}`)
    match(out, /STALE REGISTRY ENTRY/u, '空串条目匹配不上，必须报 STALE')
    match(out, /FIRST DIFFERENCE|First difference/u, '真实编辑仍要被点名')
    rmSync(root, { recursive: true, force: true })
  })

  it('④b 注册表里一对不相关的项 → 真实编辑仍 exit 1', () => {
    // 与 ④ 互补：条目**看起来合法**（具体字符串），但描述的是别的东西。
    // 它既不能宽恕眼前的编辑，也必须自己报 STALE。
    const root = makeRepo('const real = 1\n')
    write(root, 'const edited = 2\n')
    const unrelated = JSON.stringify([{
      commit: 'deadbeef',
      reason: '（测试注入）一条具体但与本 diff 无关的登记项',
      disappeared: 'const somethingElse = 0',
      appeared: 'const somethingElseAgain = 0',
    }])
    const { code, out } = runChecker(root, { PPM_CORRECTIONS_JSON: unrelated })
    equal(code, 1, `无关条目不能改变真实编辑的判定\n${out}`)
    match(out, /STALE REGISTRY ENTRY/u)
    match(out, /FIRST DIFFERENCE|First difference/u)
    rmSync(root, { recursive: true, force: true })
  })

  it('⑤ 注册表为空（--against 有真实差异）→ exit 1，无任何豁免路径', () => {
    // 补一个更直接的反向：没有注册表时，纯格式差异也照样红。
    // 这条防止「豁免机制默认打开」这类回归。
    const root = makeRepo(`${GONE}\n`)
    write(root, `${CAME}\n`)
    const { code, out } = runChecker(root, { PPM_CORRECTIONS_JSON: '[]' })
    equal(code, 1, `空注册表时格式差异必须报红（豁免不是默认行为）\n${out}`)
    match(out, /FIRST DIFFERENCE|First difference/u)
    rmSync(root, { recursive: true, force: true })
  })
})