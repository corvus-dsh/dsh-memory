/**
 * v245 — TD-M18: 「拒收语必须说真规则」+「越界 tag 不许静默消失」。
 *
 * WHY THIS SUITE EXISTS
 *
 * 2026-11-18 实测两次：`declaration-binds-to-measured-artifact`（38 字符）与
 * `state-file-backup-copy-test-apply`（33 字符）被 `knowledge_harvest` 拒绝，报错语是
 *
 *     id must be lowercase latin kebab-case
 *
 * 而真实判据是 `^[a-z0-9][a-z0-9+#._-]{0,31}$`：**总长上限 32**，且允许 `+ # . _`
 * 四个 kebab-case 之外的字符。两个被拒的 id 都满足报错语说的规则 —— 报错语在说它
 * 没执行的规则（与 ㉝「门禁的保证语」同族，这次出自工具）。
 *
 * 更贵的一半：`asVocab` 校验失败直接 `continue` —— 越界 tag **无声消失**。
 * id 的失败是「被拒绝」，tag 的失败是「被否认」。
 *
 * 因此本套测试钉的是「说真话」三件事：
 *   ① 被拒的 id 必须听到**真实规则**（含长度上限与和实测长度）；
 *   ② 越界/非法 tag 必须**出现在结果的 droppedTags 里**，而不是凭空消失；
 *   ③ `asVocab` 变成可收集（第三参数），调用方拿得到被丢弃的项。
 *
 * CAN-RED（每条都做过）：把报错语改回 `lowercase latin kebab-case` ⇒ ①② 红；
 * 删掉 `droppedTags` 收集 ⇒ ③④⑤⑥ 红。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeKnowledge } from '../lib/knowledge.js'
import { asVocab } from '../lib/store/layer.js'
import { apply } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))

function kbDir() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-v245-')), 'kb')
}

/** 38 字符 —— 实测被拒过的那个 id。 */
const LONG_ID = 'declaration-binds-to-measured-artifact'
/** 33 字符 —— 实测被拒过的那个 id 摇身变成 tag。 */
const LONG_TAG = 'state-file-backup-copy-test-apply'

test('v245 ①: 被拒的 id 必须听到真实规则（长度上限 + 本次长度），不是另一条规则', () => {
  const result = writeKnowledge(kbDir(), [{ id: LONG_ID, title: 'x', body: 'b' }])
  assert.equal(result.written, 0, 'a 38-char id must be refused')
  const message = result.refused.join(' | ')
  assert.ok(
    message.includes(String(LONG_ID.length)),
    `拒收语必须回显本次长度（${LONG_ID.length}），否则被拒的人无法知道该怎么办：${message}`,
  )
  assert.ok(message.includes('32'), `拒收语必须点名真实上限（32 字符）：${message}`)
})

test('v245 ②: 非法字符导致被拒时，拒收语点名字符集本身', () => {
  const result = writeKnowledge(kbDir(), [{ id: 'has space!', title: 'x', body: 'b' }])
  assert.equal(result.written, 0)
  const message = result.refused.join(' | ')
  assert.ok(
    message.includes('a-z0-9'),
    `拒收语必须写出允许的字符集（a-z0-9 …），而不是只发一个 kebab-case 的判词：${message}`,
  )
})

test('v245 ③: 超限 tag 不许静默消失 —— 结果里如实列出被丢弃的项', () => {
  const result = writeKnowledge(kbDir(), [
    { id: 'short-id', title: 'x', body: 'b', tags: [LONG_TAG, 'ok-tag'] },
  ])
  assert.equal(result.written, 1, '条目本身仍然要落盘：被丢弃的是 tag，不是这个技能')
  assert.deepEqual(result.entries[0].tags, ['ok-tag'], '超限的 tag 不进词表')
  const dropped = result.droppedTags.join(' | ')
  assert.ok(dropped.includes(LONG_TAG), `被丢弃的 tag 必须出现在 droppedTags 里：${dropped}`)
  assert.ok(dropped.includes(String(LONG_TAG.length)), `并且要说出它多长：${dropped}`)
})

test('v245 ④: applicable_node_types 用同一份规则，也同一份报告', () => {
  const result = writeKnowledge(kbDir(), [
    { id: 'short-id', title: 'x', body: 'b', applicableNodeTypes: [LONG_TAG, 'testing'] },
  ])
  assert.deepEqual(result.entries[0].applicableNodeTypes, ['testing'])
  const dropped = result.droppedTags.join(' | ')
  assert.ok(dropped.includes(LONG_TAG), `node type 被丢弃也必须报告：${dropped}`)
})

test('v245 ⑤: asVocab 的第三参数收得到被丢弃的项（调用方能看见）', () => {
  const dropped = []
  const kept = asVocab([LONG_TAG, 'ok-tag', '中文'], 8, dropped)
  assert.deepEqual(kept, ['ok-tag'])
  assert.equal(dropped.length, 2, `两个非法的项都该被收集，实际：${JSON.stringify(dropped)}`)
  assert.ok(dropped.join(' | ').includes(LONG_TAG))
})

test('v245 ⑥: 没给收集数组时行为不变（旧契约不被这一笔改掉）', () => {
  assert.deepEqual(asVocab(['Python', 'api']), ['python', 'api'])
  const result = writeKnowledge(kbDir(), [{ id: 'short-id', title: 'x', body: 'b', tags: ['ok'] }])
  assert.deepEqual(result.droppedTags, [], '没有丢弃项时是空数组，不是 undefined')
})

// ── ⑦ 工具层端到端：报告必须真的走到模型手里，不是只在函数层 ────────────────────────────────

test('v245 ⑦: `knowledge_harvest` 的工具返回里必须有 droppedTags（一扇门的证据）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v245-tool-'))
  const tools = new Map()
  const ctx = {
    paths: { data: join(root, 'data', 'dsh-memory') },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    get: () => undefined,
  }
  apply(ctx, {
    graftDataDir: join(root, 'graft'),
    memoryDir: join(root, 'memory'),
    skillsDir: join(root, 'skills'),
    /** ⚠ THIS LINE IS LOAD-BEARING: without it the write lands in the REAL global store. */
    knowledgeDir: join(root, 'knowledge'),
    extractor: 'off',
  })
  /**
   * ⚠ THIS ASSERTION EXISTS BECAUSE OF A MISTAKE I MADE IN THIS VERY TEST.
   *
   * The first version omitted `knowledgeDir`. `apply()` defaults it to `~/.dsh/global-knowledge`,
   * so the suite wrote two skill entries into the REAL global store — and then went red on the
   * second run for a reason that had nothing to do with the code under test (`merged: 1`, because
   * the id already existed from the previous run). A test that writes outside its temp root is not
   * a test; it is a side effect with an opinion.
   */

  const returned = await tools.get('knowledge_harvest').execute({
    entries: [
      {
        id: 'tool-level-honesty',
        title: 'x',
        body: 'b',
        tags: [LONG_TAG, 'ok-tag'],
        applicable_node_types: [LONG_TAG],
      },
    ],
  })

  /**
   * WHY THIS TEST EXISTS SEPARATELY FROM ③④: those call `writeKnowledge` directly. The dispatch's
   * own review point was "does `droppedTags` reach the TOOL RETURN, not just the function layer".
   * It does only because both tools spread `...result` — a future refactor that rebuilds the return
   * object field-by-field would silently drop the report, and ③④ would stay green.
   */
  assert.ok(
    String(returned.knowledgeDir).startsWith(root),
    `工具的 knowledgeDir 必须落在这条测试的临时目录里，实际：${returned.knowledgeDir}`,
  )
  assert.equal(returned.written, 1)
  assert.ok(Array.isArray(returned.droppedTags), `工具返回里必须有 droppedTags：${JSON.stringify(returned)}`)
  const dropped = returned.droppedTags.join(' | ')
  assert.ok(dropped.includes(LONG_TAG), `tags 的丢弃必须出现在工具返回里：${dropped}`)
  assert.ok(dropped.includes('applicable_node_types'), '两个字段都要分得出来，不能合成一句')

  /** And a write with nothing to drop says so explicitly rather than omitting the field. */
  const clean = await tools.get('knowledge_harvest').execute({
    entries: [{ id: 'clean-entry', title: 'x', body: 'b', tags: ['ok-tag'] }],
  })
  assert.deepEqual(clean.droppedTags, [])
})

// ── ⑧ 边界：两处 decoder 不传第三参数，行为与上限一个都没变 ─────────────────────────────────

test('v245 ⑧: graph.ts 的两处 decoder 仍然两参调用，且上限语义未变', () => {
  const graphSource = readFileSync(join(here, '..', 'src', 'graph.ts'), 'utf8')
  /**
   * The dispatch named these two: `nodeType` (max = 1) and `knowledgePointers` (max = 24).
   * They are DECODERS — there is no caller to report to — so they must keep the two-argument call.
   * If one of them starts passing a collector, this assertion is the place that says so.
   */
  const twoArgCalls = [...graphSource.matchAll(/normalize(?:VocabList|NodeTypes)\(([^\n]*)\)/gu)]
    .map((match) => match[0])
    .filter((line) => /,\s*(1|24)\)/u.test(line))
  assert.ok(twoArgCalls.length >= 2, `应当能看见 max=1 与 max=24 两处调用，实际：${twoArgCalls.join(' / ')}`)
  for (const call of twoArgCalls) {
    assert.equal(call.split(',').length, 2, `decoder 不许传第三参数：${call}`)
  }

  /** Caps are untouched: max=1 keeps one, max=24 keeps 24, and the default is still 8. */
  assert.deepEqual(asVocab(['a', 'b', 'c'], 1), ['a'])
  assert.equal(asVocab(Array.from({ length: 30 }, (_, index) => `t${index}`), 24).length, 24)
  assert.equal(asVocab(Array.from({ length: 30 }, (_, index) => `t${index}`)).length, 8)
})