/**
 * ── v312 / USER-REPORTED (P0): 面板的四层必须按工作区隔离，而不是按进程目录 ────────────────────────
 *
 * 用户原话：**「记忆插件四层认知、任务图、飞轮均未实现按不同工作区隔离实现与显示」**。
 *
 * 缺陷机制：四层全部读 `resolved.*Dir`，而 `resolveConfig` 在 `apply()` 时按 `paths.data` 算一次 ——
 * **进程级目录，不是调用方会话的工作区**。于是任何窗口看到的都是插件启动时那个目录的数据。
 *
 * ── 四层不是同一个问题，判据也不该一样 ─────────────────────────────────────────────────────────
 *
 *   · 技能/负知识：**一个全局库**（`~/.agents/skills`），靠记录上的 `workspace` 字段区分 ⇒ 隔离是**过滤**，
 *     而且必须与检索用同一个谓词，否则面板与真实回合会各说一套。
 *   · 记忆 / 知识 / 任务图：**按目录存**，记录上没有 workspace 字段 ⇒ 隔离只能靠**报出目录**；
 *     改目录名会让既有记录全部变孤儿。
 *
 * 判据：
 *   ① 技能按工作区过滤，且与 `memoryAllowsWorkspace` 同一个答案（列表长度 == 该谓词的合格数）；
 *   ② 三层目录各自出现在 state 里，读者能看出「这是哪个目录的」；
 *   ③ 负向：**工作区为空时不得放行全部技能**（fail-closed，与真实回合一致）；
 *   ④ 负向：`counts.skills` 仍是**库中总数**，不被过滤改小 —— 否则读者就分不清「库里有 40」与「你能用 3」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

async function loadScope() {
  return import(pathToFileURL(join(ROOT, 'lib', 'console-scope.js')).href)
}

const skill = (name, workspace, scope = 'project') => ({ name, workspace, scope })

test('v312 ①: skills are filtered by the SAME predicate retrieval uses', async () => {
  const { scopeConsoleLayers } = await loadScope()
  const skills = [
    skill('mine-a', 'D:/work/a'),
    skill('mine-a2', 'D:/work/a'),
    skill('other-b', 'D:/work/b'),
    skill('shared', 'D:/work/b', 'global'),
  ]
  const scoped = scopeConsoleLayers({
    skills,
    workspace: 'D:/work/a',
    memoryDir: 'D:/data/a/.dsh-memory',
    knowledgeDir: 'D:/data/a/.dsh-knowledge',
  })
  const names = scoped.skills.map((record) => record.name).sort()
  assert.deepEqual(names, ['mine-a', 'mine-a2', 'shared'],
    `只应留下本工作区与 global；实测 ${JSON.stringify(names)}`)
})

test('v312 ②: all three directory-scoped layers report WHICH directory they came from', async () => {
  /**
   * The other three layers cannot be filtered — their records have no workspace field. What they can do is
   * say where they came from, which is what turns 「这张图不像我的项目」 from a suspicion into evidence.
   */
  const { scopeConsoleLayers } = await loadScope()
  const scoped = scopeConsoleLayers({
    skills: [],
    workspace: 'D:/work/a',
    memoryDir: 'D:/data/a/.dsh-memory',
    knowledgeDir: 'D:/data/a/.dsh-knowledge',
  })
  assert.match(scoped.memoryScope, /D:\/data\/a\/\.dsh-memory/u, '记忆目录必须出现')
  assert.match(scoped.knowledgeScope, /D:\/data\/a\/\.dsh-knowledge/u, '知识目录必须出现')
  assert.match(scoped.graphScope, /task-graph\.json/u, '任务图必须是完整的文件路径')
  assert.match(scoped.skillsScope, /retrieval|检索/u, '技能那条必须说明它用的是与检索相同的谓词')
})

test('v312 ③ (negative half): an EMPTY workspace shows NOTHING, not everything', async () => {
  /**
   * A root-scoped panel with no session bound does not know the workspace. `memoryAllowsWorkspace` answers
   * false for every project-scoped record in that case, and the panel must agree — a panel that showed all
   * skills while it could not tell which project it was in would be MORE permissive than a real turn.
   */
  const { scopeConsoleLayers } = await loadScope()
  const scoped = scopeConsoleLayers({
    skills: [skill('mine-a', 'D:/work/a'), skill('other-b', 'D:/work/b')],
    workspace: '',
    memoryDir: 'D:/data/x/.dsh-memory',
    knowledgeDir: 'D:/data/x/.dsh-knowledge',
  })
  assert.deepEqual(scoped.skills.map((record) => record.name), [],
    '未知工作区时必须 fail-closed，而不是退化成「显示全部」')
})

test('v312 ④ (negative half): the STORE TOTAL is untouched — filtering must not rewrite the count', () => {
  /**
   * If the filter also shrank `counts.skills`, a reader could no longer tell 「the store has 40」 from 「your
   * project can use 3」 — which is the reading `matchedInWorkspace` exists to provide. The scoping function
   * therefore returns a LIST and nothing else; the counts stay the caller's business.
   */
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
  assert.match(source, /库中 \$\{num0\(counts\.skills\)\}/u,
    '面板必须同时显示「库中总数」，不能只显示过滤后的数')
  assert.match(source, /本工作区可用技能/u, '并明确区分这两个数')
})
