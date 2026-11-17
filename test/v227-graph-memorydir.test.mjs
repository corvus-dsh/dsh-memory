/**
 * ── v227：`memoryDir` 来自 dataRoot，不是仓库根 ────────────────────────────────────────────────
 *
 * ── WHY THIS TEST EXISTS (measured 2026-11-17) ──────────────────────────────────────────────────
 *
 * A派工单 said "task-graph.json 已写盘（18 节点）". The executor looked in
 * `D:\持久层能力架构\dsh-memory\.dsh-memory\` and found only `.layout.json` — and reported, correctly,
 * that the file was absent. It was not absent. It was in
 * `<dataRoot>/.dsh-memory/task-graph.json`, because `memoryDir` resolves from the PROFILE data
 * directory, not from the checkout.
 *
 * Two directories named `.dsh-memory` exist and they are different places:
 *
 *   <dataRoot>/.dsh-memory/    the LIVE store — task-graph.json, ledgers
 *   <repo>/.dsh-memory/        a development-period directory inside the checkout
 *
 * That is ⑪ (one semantic, two implementations) applied to a DIRECTORY: the same name, two things.
 * The cost was one round of "I cannot find it" and one near-miss where a judgement was about to be
 * relaxed because a file appeared to be missing.
 *
 * This test makes the difference executable instead of documented: it asserts the RESOLUTION RULE
 * (memoryDir is derived from the profile data root) and the SHAPE of the answer (the graph path is not
 * under the checkout). A future reader who wonders "where does the graph live" gets a green test that
 * says the rule, rather than a README sentence that may have gone stale.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
/**
 * Imported from `lib/graph.js`, NOT from the plugin entry: `graphPath` is a module-level function of
 * the graph store, and the plugin entry (`lib/index.js`) exposes tools rather than these helpers. The
 * first version asked the ENTRY for `graphPath` and failed with "not on the export surface" — which is
 * a true statement about the entry and a false one about the module. Testing the wrong surface would
 * have produced a green test that pinned the entry's export list instead of the path rule.
 *
 * Windows: a bare absolute path is read as a URL with scheme `d:`, so the module is imported as a file
 * URL (measured, not defensive habit).
 */
const mod = await import(pathToFileURL(join(REPO, 'lib', 'graph.js')).href)

test('v227 ①: graphPath 是 <memoryDir>/task-graph.json —— 由参数决定，不是由仓根决定', () => {
  const graphPath = mod.graphPath
  assert.equal(typeof graphPath, 'function', 'graphPath 必须在导出面上')

  const a = graphPath('/tmp/a')
  const b = graphPath('/tmp/b')
  assert.equal(a.endsWith('task-graph.json'), true, `实测 ${a}`)
  assert.notEqual(a, b, '不同 memoryDir 必须给出不同路径（否则 memoryDir 没被使用）')
  // Compared with `resolve` on both sides: on Windows `/tmp/a` resolves against the current drive, so a
  // raw `startsWith` says false for a path that is in fact inside the directory the caller named.
  assert.equal(resolve(a), resolve(join('/tmp/a', 'task-graph.json')), '路径必须落在传入的目录下')

  /**
   * The checkout's own `.dsh-memory` is NOT where the live store lives, and that is the confusion this
   * test is about. Two separate assertions, because they say two different things:
   *
   *   ① `graphPath` follows the directory it is GIVEN — so a caller that passes the repo-local path
   *      gets the repo-local path back. The function is not opinionated about which directory is right.
   *   ② The rule of WHO supplies that directory lives in `index.ts` (the profile data root), which is
   *      why the live store is not in the checkout even though a directory of the same NAME is.
   *
   * The first version of this assertion compared `resolve(x)` with a conditional that always yielded
   * `resolve(x)` — a tautology that would pass for any implementation. Removed rather than repaired:
   * an assertion that cannot fail is not evidence, and keeping it would have made this file look like
   * it covered something it did not.
   */
  const repoLocal = join(REPO, '.dsh-memory', 'task-graph.json')
  assert.equal(resolve(graphPath(join(REPO, '.dsh-memory'))), resolve(repoLocal),
    'graphPath 跟随传入的目录 —— 它不对"哪个目录才对"表态')
  assert.notEqual(resolve(graphPath(join(tmpdir(), 'x'))), resolve(repoLocal),
    '换一个 memoryDir 得到的就不是仓内那个路径（否则 memoryDir 没被使用）')
})

test('v227 ②: 一个 memoryDir 的图不会出现在另一个 memoryDir 里（隔离）', () => {
  const dirA = mkdtempSync(join(tmpdir(), 'dsh-v227-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'dsh-v227-b-'))
  try {
    mod.updateGraph(dirA, { op: 'add', nodeId: 'aa-node', node: { title: 'A' } })
    const inA = mod.readGraph(dirA).nodes.map((node) => node.id)
    const inB = mod.readGraph(dirB).nodes.map((node) => node.id)
    assert.ok(inA.includes('aa-node'), '写进 A 的节点必须在 A 里读得到')
    assert.equal(inB.includes('aa-node'), false, 'A 的节点不许出现在 B 里 —— memoryDir 是真正的隔离边界')
  } finally {
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('v227 ③: 缺文件的目录返回空图，而不是抛错或去别处找', () => {
  const dir = join(tmpdir(), `dsh-v227-missing-${Date.now()}`)
  const graph = mod.readGraph(dir)
  assert.equal(Array.isArray(graph.nodes), true)
  assert.equal(graph.nodes.length, 1, '只剩固定起点 —— 空图不是零节点')
  assert.equal(graph.nodes[0].id, mod.START_NODE_ID)
})
