/**
 * ── v210：`--classify` 必须两侧分桶，且逻辑非零即红（含两条 can-red）────────────────────────────
 *
 * 用户裁定的两条：
 *   ② `--classify` 两侧分桶 + 逻辑非零即红；can-red 两条（删一行真代码、删整个函数），
 *      先让它红。
 *   ③ `isCommentLine` 收紧；can-red 用 `INCIDENT_MARKERS` 的真实 6 行；
 *      确认收紧后本步仍 32/0/0。
 *
 * ── 为什么这两条是同一个漏洞的两半 ──────────────────────────────────────────────────────────────
 *
 * 门禁要防的是「搬运时把代码丢了」。「丢」有两种形状，旧实现两种都看不见：
 *
 *   A. **只对 appeared 一侧分桶**。删掉一行真代码 = DISAPPEARED，不进任何桶 ⇒ 三个桶全 0
 *      ⇒ 打印「逻辑 0」⇒ exit 0。整段被删的函数也一样：消失侧只打印、不计数。
 *   B. **`isCommentLine` 用 `startsWith('/')`**。正则字面量 `/…/u` 是**真代码**，但每个都以 `/`
 *      开头。`INCIDENT_MARKERS`（`retrieve.ts` 里 6 行正则数组）全部会被判成 `comment` ⇒
 *      删掉它们同样报「逻辑 0」。
 *
 * 两个缺陷叠加，恰好让「删除代码」这条最主要的失败模式在所有形状下都隐身。
 *
 * ── 本测试的结构 ────────────────────────────────────────────────────────────────────────────────
 *
 *   ① 纯函数层：`isCommentLine` 对 INCIDENT_MARKERS 的 6 行必须全为 false（裁定③）
 *   ② 纯函数层：`classifyDifference` 对 gone 侧也必须分桶（裁定②）
 *   ③ 端到端：删一行真代码 → exit 1，logic ≥ 1
 *   ④ 端到端：删整个函数 → exit 1，logic 等于函数体行数量级
 *   ⑤ 端到端：只删注释 → exit 0（证明它没有「见红就报」）
 *
 * ①② 不碰磁盘（纯函数）；③④⑤ 在**仓内临时副本**里改文件，不动真仓。
 *
 * 为什么不依赖 typescript：`verify-pure-move.mjs` 是纯文本多重集比较，只用 git + node。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  isCommentLine,
  classifyLine,
  classifyDifference,
  contentLines,
} from '../scripts/verify-pure-move.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

/** `INCIDENT_MARKERS` 的 6 行正则 —— 从源码里**原样**取，不手抄。 */
const incidentMarkerLines = () => {
  const text = readFileSync(join(REPO, 'src', 'retrieve', 'interning.ts'), 'utf8')
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^export const INCIDENT_MARKERS/u.test(l))
  assert.ok(start >= 0, 'INCIDENT_MARKERS 应在 src/retrieve/interning.ts（第一步搬过去）')
  const out = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\]/u.test(lines[i])) break
    if (lines[i].trim() !== '') out.push(lines[i])
  }
  return out
}

test('v210 ①: INCIDENT_MARKERS 的 6 行正则**不是**注释（isCommentLine 已收紧）', () => {
  const six = incidentMarkerLines()
  assert.equal(six.length, 6, `应取到 6 行正则，实测 ${six.length}：\n${six.join('\n')}`)

  for (const line of six) {
    assert.equal(isCommentLine(line), false,
      `这一行是真代码（正则字面量），不许判成注释：\n  ${JSON.stringify(line)}\n`
      + '旧判据 startsWith("/") 会把每个正则字面量都当成注释 —— 那让「删掉这六行」报「逻辑 0」。')
    assert.equal(classifyLine(line), 'logic',
      `它不是注释也不是管线，应归入 logic：${JSON.stringify(line)}`)
  }
})

test('v210 ②: isCommentLine 仍认真正的注释（收紧没有误伤）', () => {
  const comments = ['/**', ' * 一行 JSDoc', ' */', '// 行注释', '  // 缩进行注释', '/* 块注释开始', '*']
  for (const line of comments) {
    assert.equal(isCommentLine(line), true, `这是注释，必须识别：${JSON.stringify(line)}`)
  }
  // 反向：几个**不是**注释但容易混的形状
  const notComments = ['const a = 1', '  /^\\s*at\\s+/mu,', 'return x / 2', '  } from \'./x.js\'']
  for (const line of notComments) {
    assert.equal(isCommentLine(line), false, `这不是注释：${JSON.stringify(line)}`)
  }
})

test('v210 ③: classifyDifference 两侧都分桶 —— 消失侧的逻辑行必须被数出来', () => {
  /**
   * 旧实现的签名只分 `came`：`gone` 只算条数与行数。所以「删一行真代码」得到 logic 0。
   * 这条直接喂假数据，锁定「gone 侧也进桶」。
   */
  const gone = [
    { l: '  if (workspace.length === 0) return \'\'', n: 1 },
    { l: ' * 一行被删掉的注释', n: 1 },
  ]
  const came = [{ l: ' * 一行新增的注释', n: 2 }]

  const r = classifyDifference(gone, came)

  assert.equal(r.disappeared.logic.length, 1, '消失侧那行真代码必须进 logic 桶')
  assert.equal(r.disappeared.comment.length, 1, '消失侧那行注释必须进 comment 桶')
  assert.equal(r.appeared.comment.length, 2, '出现侧两行注释')
  assert.equal(r.appeared.logic.length, 0)

  assert.equal(r.totals.logic, 1, '合计逻辑数必须包含消失侧')
  assert.equal(r.totals.comment, 3)
  assert.equal(r.totals.pipeline, 0)

  // 只有注释变化时逻辑必须为 0（否则门禁会把「正常写注释」也判红）
  const commentsOnly = classifyDifference([{ l: ' * 旧注释', n: 1 }], [{ l: ' * 新注释', n: 1 }])
  assert.equal(commentsOnly.totals.logic, 0, '纯注释变化不该产生逻辑行')
})

/** 在仓内临时副本里造 diff（副本继承上层 node_modules，编译器等依赖可用）。 */
const mirror = () => {
  const root = mkdtempSync(join(REPO, '.v210-'))
  for (const d of ['scripts', 'src']) cpSync(join(REPO, d), join(root, d), { recursive: true })
  cpSync(join(REPO, 'package.json'), join(root, 'package.json'))
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'v210@test.local')
  git('config', 'user.name', 'v210')
  git('config', 'commit.gpgsign', 'false')
  git('add', '-A')
  git('commit', '-qm', 'base')
  return root
}

const runClassify = (root) => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  try {
    const out = execFileSync(process.execPath, ['scripts/verify-pure-move.mjs', '--against', 'HEAD', '--classify'],
      { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 180_000, env })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? -1, out: String(error.stdout ?? '') + String(error.stderr ?? '') }
  }
}

/** Parse the `── 合计 ──` row: comment / pipeline / logic. */
const totalsOf = (out) => {
  const m = out.match(/── 合计 ──\s+(\d+)\s+(\d+)\s+(\d+)/u)
  return m === null ? undefined : { comment: Number(m[1]), pipeline: Number(m[2]), logic: Number(m[3]) }
}

test('v210 ④ can-red: 删掉一行真代码 → exit 1，并且是消失侧的 logic', () => {
  const root = mirror()
  try {
    const p = join(root, 'src', 'retrieve', 'commit-cache.ts')
    const before = readFileSync(p, 'utf8')
    const victim = "  if (workspace.length === 0) return ''\n"
    assert.ok(before.includes(victim), '测试前提：那一行应存在于 commit-cache.ts')
    writeFileSync(p, before.replace(victim, ''), 'utf8')

    const r = runClassify(root)
    const t = totalsOf(r.out)
    assert.ok(t !== undefined, `输出里应有「── 合计 ──」行：\n${r.out.slice(-900)}`)
    assert.equal(r.code, 1, `删一行真代码必须失败\n${r.out.slice(-900)}`)
    assert.ok(t.logic >= 1, `消失侧那一行必须计入 logic，实测 ${JSON.stringify(t)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v210 ⑤ can-red: 删掉整个函数 → exit 1，logic 行数与函数体同量级', () => {
  const root = mirror()
  try {
    const p = join(root, 'src', 'retrieve', 'commit-cache.ts')
    let text = readFileSync(p, 'utf8')
    const start = text.indexOf('export function sameCommit(')
    assert.ok(start >= 0, '测试前提：commit-cache.ts 里应有 sameCommit')
    const end = text.indexOf('\n}\n', start)
    assert.ok(end >= 0, '测试前提：应能定位 sameCommit 的结尾')

    const removed = text.slice(start, end + 3)
    const removedNonEmpty = removed.split('\n').filter((l) => l.trim() !== '').length
    writeFileSync(p, text.slice(0, start) + text.slice(end + 3), 'utf8')

    const r = runClassify(root)
    const t = totalsOf(r.out)
    assert.ok(t !== undefined, `输出里应有合计行：\n${r.out.slice(-900)}`)
    assert.equal(r.code, 1, `删整个函数必须失败\n${r.out.slice(-900)}`)
    /**
     * 函数体 7 行非空，其中 JSDoc 那行是注释 ⇒ 预期 logic ≥ 删除行数 − 2。
     * 用「同量级」而不是精确相等：注释/空行的归属会随函数内容变化，精确相等会让这条
     * 测试在「函数多写一行注释」时误红，而它要证明的是「整段消失能被看见」。
     */
    assert.ok(t.logic >= removedNonEmpty - 2,
      `删掉 ${removedNonEmpty} 行非空内容，logic 只有 ${t.logic} —— 说明消失侧没被完整计数`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v210 ⑥: 只删注释 → exit 0（门禁不误报正常写注释）', () => {
  const root = mirror()
  try {
    const p = join(root, 'src', 'retrieve', 'commit-cache.ts')
    const text = readFileSync(p, 'utf8')
    const victim = ' * 从 `retrieve.ts` 搬出的 5 个声明（33 行 + 族说明注释）。\n'
    assert.ok(text.includes(victim), '测试前提：该注释行应存在')
    writeFileSync(p, text.replace(victim, ''), 'utf8')

    const r = runClassify(root)
    const t = totalsOf(r.out)
    assert.ok(t !== undefined, `输出里应有合计行：\n${r.out.slice(-900)}`)
    assert.equal(r.code, 0, `只删注释不该失败\n${r.out.slice(-900)}`)
    assert.equal(t.logic, 0, `只删注释不该产生逻辑行，实测 ${JSON.stringify(t)}`)
    assert.ok(t.comment >= 1, '但它必须被记成一行注释（看得见，不是静默）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v210 ⑦: 本步（第三步）的实测必须是 32/0/0 与 1/0/0（收紧之后仍如此）', (t) => {
  /**
   * 用户要求「确认收紧后本步仍 32/0/0」。用**真实仓**跑一次 `--against f9d1abf`
   * （第三步的父提交），锁定那个数字，防止收紧判据时悄悄改变了既有结论。
   *
   * 若这条将来红了，先问：是判据变严导致某行从 comment 变成 logic（那是真发现），
   * 还是这一步又发生了新的编辑（那要重测并更新期望值）。不要直接数字。
   *
   * ── 需要历史提交 ⇒ 浅克隆下 skip ────────────────────────────────────────────────────────────
   *
   * `--against f9d1abf` 要读那个父提交。CI 的 `actions/checkout@v4` 默认 `fetch-depth: 1`，
   * 只取当前提交 ⇒ 这条在 CI 上必然红（2026-11-15 实测：本地 490 绿、CI 双 Node 红在 Test）。
   *
   * 处置同 v207 ①b：缺历史时 skip 并写 RESOURCE reason（照 v201/v203 惯例），
   * 不伪装成通过、也不把环境问题报成被测代码的问题。
   */
  const hasRef = (() => {
    try {
      execFileSync('git', ['cat-file', '-e', 'f9d1abf'], { cwd: REPO, stdio: 'ignore' })
      execFileSync('git', ['cat-file', '-e', '6446dea'], { cwd: REPO, stdio: 'ignore' })
      return true
    } catch { return false }
  })()
  if (!hasRef) {
    t.skip('RESOURCE：本地仓库没有 f9d1abf / 6446dea（浅克隆 / shallow clone）。'
      + '这条要重建「第三步那棵树」并与它的父提交比较，需要那两个对象。'
      + '完整克隆上运行即可覆盖；NOT a pass and NOT a failure.')
    return
  }

  /**
   * ⚠ **必须在「第三步那棵树」上跑，不能用当前工作树。**
   *
   * 第一版直接 `cwd: REPO` 跑 `--against f9d1abf` —— 当时工作树恰好就是第三步的状态，
   * 所以数字对。第四步（L4 搬运）一落地，工作树前进了，同一个命令的 diff 就变成
   * 「第一到第四步」的全部变化，32/0/0 立刻不成立。
   *
   * 那红得**没有意义**：被测的判据没变，变的是我拿它去量了另一棵树。
   * 这条测试的命题是「**第三步**的实测是 32/0/0」，所以它必须把第三步的树取出来量。
   *
   * 做法：`git show 6446dea:<file>` 逐文件导出该提交的 `src/` 到临时目录，
   * 复制**当前**的 `verify-pure-move.mjs`（判据要今天的），在那里跑 `--against f9d1abf`。
   * 临时目录需要能解析 f9d1abf 那个对象 ⇒ 用 `objects/info/alternates` 借原仓对象库。
   */
  const tmp = mkdtempSync(join(REPO, '.v210-step3-'))
  let out
  try {
    const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', stdio: 'pipe' })
    git('init', '-q', tmp)
    git('config', 'user.email', 'v210@test.local', tmp)
    git('config', 'user.name', 'v210', tmp)
    mkdirSync(join(tmp, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(join(tmp, '.git', 'objects', 'info', 'alternates'),
      join(REPO, '.git', 'objects') + '\n', 'utf8')

    // 导出第三步的 src/
    const list = git('ls-tree', '-r', '--name-only', '6446dea', '--', 'src')
      .split(/\r?\n/u).filter((p) => p.endsWith('.ts'))
    assert.ok(list.length > 20, `第三步的 src/ 应有 20+ 个 .ts，实测 ${list.length}`)
    for (const rel of list) {
      const target = join(tmp, rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, git('show', `6446dea:${rel}`), 'utf8')
    }
    // 脚本用当前的
    mkdirSync(join(tmp, 'scripts'), { recursive: true })
    copyFileSync(join(REPO, 'scripts', 'verify-pure-move.mjs'), join(tmp, 'scripts', 'verify-pure-move.mjs'))

    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    try {
      out = execFileSync(process.execPath,
        ['scripts/verify-pure-move.mjs', '--against', 'f9d1abf', '--classify'],
        { cwd: tmp, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 180_000, env })
    } catch (error) {
      out = String(error.stdout ?? '') + String(error.stderr ?? '')
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  const totals = totalsOf(out)
  assert.ok(totals !== undefined, `输出里应有合计行：\n${out.slice(-900)}`)

  /**
   * ⚠ 必须锚定行首。`DISAPPEARED 1 条 / 1 行` 里的 "APPEARED" 是 "DISAPPEARED" 的子串，
   * 所以 `/APPEARED\s+(\d+)…/` 会先命中 DISAPPEARED 那一行，读到 1 —— 第一版就是这么红的，
   * 它报「出现侧应为 32，实测 1」，而真实输出是 32。一个不带锚点的正则会把
   * 「消失侧的数字」当成「出现侧的数字」，这正是本文件要防的那类误读。
   */
  const appeared = out.match(/^APPEARED\s+(\d+)\s+条 \/ (\d+)\s+行/mu)
  const disappeared = out.match(/^DISAPPEARED\s+(\d+)\s+条 \/ (\d+)\s+行/mu)
  assert.ok(appeared !== null && disappeared !== null, '输出里应有两侧的条数/行数')

  assert.equal(appeared[2], '32', `出现侧应为 32 行，实测 ${appeared[2]}`)
  assert.equal(disappeared[2], '1', `消失侧应为 1 行，实测 ${disappeared[2]}`)
  assert.equal(totals.comment, 33, `合计注释应为 32+1=33，实测 ${totals.comment}`)
  assert.equal(totals.pipeline, 0)
  assert.equal(totals.logic, 0, '本步的逻辑行必须为 0')
})
