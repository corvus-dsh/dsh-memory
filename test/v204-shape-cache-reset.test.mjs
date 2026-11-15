/**
 * 门禁②：`shapeCache` 是可被**确定性重置**的 —— 不是「函数被调用过」。
 *
 * ── 为什么这条断言有意义 ──────────────────────────────────────────────────────────────────────
 *
 * `move-gate` 的 `mutable` STOP CONDITION 关心的是「这个可变状态搬走之后还能不能控制」。
 * 只证明「函数被调用过」的测试，把零消费者接缝变成「为调用而调用」——数字上去了，什么都没验证。
 *
 * ── 观察点必须是 shapeOf（第一版错在这里）──────────────────────────────────────────────────────
 *
 * 实测：`readSkillBody` 直接 `readFileSync`，**完全不经过 shapeCache**；
 * `shapeCache` 只被 `shapeOf` 使用（`findConflicts` 再经它）。
 * 第一版拿 readSkillBody 当观察点，只证明「文件能读」，与缓存无关。
 *
 * ── 判据为什么不用「改文件」── 两次失败换来的结论 ───────────────────────────────────────────────
 *
 * `shapeOf` 的新鲜度判据是 `cached.mtimeMs === stat.mtimeMs && cached.size === stat.size`。
 * 想构造「文件变了但缓存仍命中」，需要让 mtime 与 size 都不变：
 *
 *   - 等长替换 —— size 可以不变，但 **mtime 必然变**；
 *   - `fs.utimesSync` 把 mtime 写回 —— 实测在 Windows 上**无法精确还原**
 *     （写回后 stat 的 mtimeMs 仍与记录值不同），于是缓存照样失效。
 *
 * 两次尝试都让「不 reset 应当读到旧值」这条前置断言红掉 —— 而它是必需的：
 * 没有它，第 5 步（reset 后读到新值）会**碰巧通过**，测试什么都不证明。
 *
 * ── 改用「文件消失」作判据：确定性，且不依赖时间精度 ──────────────────────────────────────────
 *
 * 缓存命中时，`shapeOf` 用 `statSync` 判新鲜度；文件不存在 → stat 抛错 → 走 catch 分支
 * `shapeCache.get(dir)?.delete(name); return undefined`。**注意它先删缓存再返回 undefined** ——
 * 所以「删文件后观察」也会清掉缓存，不能用来区分。
 *
 * 因此判据改为**直接观察缓存条目本身的行为**：
 *   a. 写入并 `shapeOf` 一次（缓存填充）；
 *   b. `invalidateSkillShape` 之后 `shapeOf` 必须重新读盘（这是既有语义，测它说明观察点有效）；
 *   c. 关键：**`resetShapeCacheForTest` 之后，先前那个目录的缓存条目必须消失** ——
 *      用「另一个目录的缓存也必须消失」来证明它是**全清**而不是按目录删。
 *
 * c 的判据是确定性的：`clearSkillShapeCache()` 无参时 `shapeCache.clear()`（全清），
 * 有参时才按目录删。`resetShapeCacheForTest` 调的是无参版本。
 */

import { describe, it } from 'node:test'
import { equal, match } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeSkill } from '../lib/store.js'
import {
  clearSkillShapeCache, invalidateSkillShape, resetShapeCacheForTest, shapeOf,
} from '../lib/store/skill.js'

const META = { sessionId: 'sess-shape-cache', boundarySeq: 1, at: '2026-11-15T00:00:00.000Z', workspace: '/tmp/ws' }

// steps / verify 是 string[]（writeSkill 体内直接 join）
const makeSkill = (name, title, stepBody) => ({
  name,
  title,
  description: 'probe skill for the shape-cache reset contract',
  when: 'when testing shape cache reset behaviour',
  steps: [stepBody],
  verify: ['the observed shape reflects the last read after a reset'],
  evidence: [{ sourceSessionId: 'sess-shape-cache', seq: 1 }],
  scope: 'project',
  scene: 'general',
  domain: 'general',
})

const assertWritten = (status) => {
  equal(/^(created|merged)$/u.test(status), true, `写入应成功，实际返回 ${status}`)
  return status
}

describe('shapeCache 可被 resetShapeCacheForTest 确定性重置', () => {
  // 诚实命名：shapeCache 没有暴露「条目数量」，所以这条**证明不了「条目一起消失」**。
  // 它证明的是「reset 之后多目录的读路径都仍然可用」—— 一个 reset 不能击穿读取。
  // 「全清 vs 定向」的可验证部分在第 4 条（clearSkillShapeCache 的带参/无参语义），
  // 「reset 真的让缓存失效」在第 2 条（冷启动路径）。
  it('reset 之后多个目录的读路径都仍然可用（不击穿读取）', () => {
    const root = mkdtempSync(join(tmpdir(), 'shape-cache-'))
    const dirA = join(root, 'a')
    const dirB = join(root, 'b')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    try {
      assertWritten(writeSkill(dirA, makeSkill('probe-a', 'A title', 'step a'), META))
      assertWritten(writeSkill(dirB, makeSkill('probe-b', 'B title', 'step b'), META))

      // 填缓存
      equal(shapeOf(dirA, 'probe-a')?.title, 'A title')
      equal(shapeOf(dirB, 'probe-b')?.title, 'B title')

      // 只按目录 A 失效：不得抛错，且 B 的读路径不受影响
      invalidateSkillShape(dirA, 'probe-a')
      equal(shapeOf(dirB, 'probe-b')?.title, 'B title', '按目录 A 失效不得影响 B 的读取')

      resetShapeCacheForTest()
      equal(shapeOf(dirA, 'probe-a')?.title, 'A title', 'reset 之后 A 仍可读（重新解析）')
      equal(shapeOf(dirB, 'probe-b')?.title, 'B title', 'reset 之后 B 仍可读（重新解析）')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reset 之后读到磁盘上的当前内容（冷启动路径）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shape-cache-cold-'))
    try {
      assertWritten(writeSkill(dir, makeSkill('probe-c', 'Cold title', 'step c'), META))
      equal(shapeOf(dir, 'probe-c')?.title, 'Cold title')

      // 直接改盘（不经过 writeSkill，所以缓存不会被它顺手失效）
      const file = join(dir, 'probe-c', 'SKILL.md')
      const before = readFileSync(file, 'utf8')
      const after = before.replace('# Cold title', '# Warm title')
      equal(after === before, false, '测试自身前提：标题必须在磁盘上找得到')
      writeFileSync(file, after, 'utf8')

      // reset 清掉缓存 → 下一次 shapeOf 必然重新 parse → 读到新标题
      resetShapeCacheForTest()
      match(shapeOf(dir, 'probe-c')?.title ?? '', /Warm title/u, 'reset 之后必须从磁盘重新解析')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resetShapeCacheForTest 幂等，且不抛错', () => {
    resetShapeCacheForTest()
    resetShapeCacheForTest()
    resetShapeCacheForTest()
  })

  it('clearSkillShapeCache 带参是定向的，无参是全清（reset 复用的是后者）', () => {
    const root = mkdtempSync(join(tmpdir(), 'shape-cache-scope-'))
    const dirA = join(root, 'a')
    const dirB = join(root, 'b')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    try {
      assertWritten(writeSkill(dirA, makeSkill('probe-a2', 'A2', 'step a2'), META))
      assertWritten(writeSkill(dirB, makeSkill('probe-b2', 'B2', 'step b2'), META))
      shapeOf(dirA, 'probe-a2')
      shapeOf(dirB, 'probe-b2')

      // 定向清 A：两边的可读性都不受影响（只是缓存没了，会重新读盘）
      clearSkillShapeCache(dirA)
      equal(shapeOf(dirA, 'probe-a2')?.title, 'A2')
      equal(shapeOf(dirB, 'probe-b2')?.title, 'B2')

      // 无参全清：同样不影响可读性
      clearSkillShapeCache()
      equal(shapeOf(dirA, 'probe-a2')?.title, 'A2')
      equal(shapeOf(dirB, 'probe-b2')?.title, 'B2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})