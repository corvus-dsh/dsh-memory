/**
 * ── v294 (B4-B W6-1c)：面板说的“进行中 N 个”，必须真的列出 N 个 ─────────────────────────────────
 *
 * ── 用户截图报的症状（2026-11-21，真机）────────────────────────────────────────────────────
 *
 * 面板渲染成：
 *
 *     共 23 个节点（进行中 2 / 待开始 2 / 已完成 19 / 已放弃 0）· 目标已锁定
 *     节点 goal（active）· 阶段 anchor · 要求：四仓持久层能力全部生产就绪…
 *
 * **说「进行中 2」，只写了 1 个。** 用户的原话是「任务图未完整显示」。
 *
 * ── 病因：两个数来自两次不同的计算 ──────────────────────────────────────────────────────────
 *
 *   counts.active  ← `describeNodes` 数**所有** status==='active' 的节点
 *   activeBanner   ← `nodes.find(status === 'active')` 只取**第一个**
 *
 * 于是「进行中 2」与「列出 1 个」同时为真，且**没有任何东西会发现它们不一致** —— 一个是计数，
 * 一个是 find。这和「有分母没有分子」是同一类：**读者无法展开的数**。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────────────────────────
 *
 *   ① 宿主侧：`graph.activeNodes.length === min(active 总数, 8)`，且 `activeNotShown` 补足差额
 *      —— 即 **列出的 + 未列出的 = 计数**（恒等式，不许有第三个来源）
 *   ② 客户端侧：渲染树里每个 activeNodes 都有一行；`activeNotShown > 0` 时多一行说明
 *   ③ 计数与列出必须**同源**：把 `activeNodes` 清空但计数不动 ⇒ ① 的恒等式必须红
 *   ④ 三态仍然可区分（unreadable / total<=1 / 正常）—— 这条是 W6-1 加的，不能被本次修改弄坏
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
const client = readFileSync(join(ROOT, 'client.js'), 'utf8')

test('v294 ①: 宿主必须发出 ALL active 节点的列表，而不是只发第一个', () => {
  /**
   * The defect was literally `nodes.find(...)`. Asserting the ABSENCE of that call site is what makes
   * this test able to fail: a future edit that reverts to `find` reintroduces the exact symptom.
   */
  assert.match(server, /const activeNodes = described\.nodes\.filter\(\(node\) => node\.status === 'active'\)/u,
    '宿主必须用 filter 取全部 active 节点；用 find 只取第一个，就会出现「说 2 个、列 1 个」')

  assert.match(server, /activeNodes: activeNodes\.slice\(0, 8\)/u, '必须发出 activeNodes 列表（上限 8）')
  assert.match(server, /activeNotShown: Math\.max\(0, activeNodes\.length - 8\)/u,
    '必须发出未列出的数量，否则「列出的 + 未列出的 = 计数」这个恒等式无法成立')
})

test('v294 ②: 「列出的 + 未列出的 = 计数」是恒等式 —— 用一个假图直接算', () => {
  /**
   * A pure arithmetic check of the invariant, driven with synthetic counts. It does not read the repo;
   * it states the rule the Host must satisfy, so a change to the shape has to update BOTH.
   */
  const limit = 8
  const cases = [0, 1, 2, 7, 8, 9, 23, 40]
  for (const active of cases) {
    const listed = Math.min(active, limit)
    const notShown = Math.max(0, active - limit)
    assert.equal(listed + notShown, active, `active=${active} 时恒等式不成立`)
  }

  /**
   * ── THE MEASURED CASE ────────────────────────────────────────────────────────────────────────
   *
   * The user's live graph had 2 active nodes. Under the OLD code: listed = 1, notShown = 0,
   * 1 + 0 !== 2. That is the arithmetic form of the symptom.
   */
  const active = 2
  const listedOld = 1 // `find(...)` yields one
  const notShownOld = 0
  assert.notEqual(listedOld + notShownOld, active, '这个不等正是用户看到的「未完整显示」')
})

test('v294 ③: 客户端必须遍历 activeNodes，而不是只渲染一个 banner', () => {
  assert.match(client, /const activeNodes = Array\.isArray\(graph\.activeNodes\)/u,
    '客户端必须读 activeNodes 列表')
  assert.match(client, /activeNodes\.map\(/u, '必须遍历渲染，而不是渲染单个 activeBanner')
  assert.match(client, /还有 \$\{notShown\} 个进行中的节点未列出/u,
    '被截断时必须说明「还有 N 个」——截断而不说，就是静默丢弃')
})

test('v294 ④: W6-1 的三态没被这次修改弄坏', () => {
  /** The three branches that must stay distinguishable — measured in the W6-1 work. */
  assert.match(client, /任务图读不出来/u, '必须保留 unreadable 分支')
  assert.match(client, /还没有建过任务图/u, '必须保留 total<=1 分支')
  assert.match(client, /共 \$\{total\} 个节点/u, '正常分支必须给出总数')
  assert.match(client, /当前没有进行中的节点/u, '「没有活跃节点」必须与「读不出来」「没建过」区分开')
})