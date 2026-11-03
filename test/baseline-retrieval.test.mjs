import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendNegatives, writeSkill } from '../lib/store.js'
import { renderHint, retrieve } from '../lib/retrieve.js'

/**
 * 检索回归基线（2026-11-03，真实任务样本）
 *
 * prompt 来自一个真实子会话的提问。当时（停用词降权 + top-8 分母之前）命中：
 *   skill    threshold-fixture-sizing   0.581
 *   negative SOURCE_DRIFT（neg-0）       0.885
 *
 * 之后公式改过两次，分数会变；**基线约束的是命中对象，不是浮点值**。
 * M4 调阈值 / 加 LLM 重排时，这条必须仍然通过。
 */
const PROMPT =
  '我在给一个 DSH 插件做两阶段提交（prepare → commit）的漂移校验；历史上 commit 曾反复报 SOURCE_DRIFT' +
  '（last seq N -> N+1，即使没有任何外部改动）。同时怀疑「对象保存后重新加载会丢字段」（chunks 变空）。' +
  '另外要为新逻辑写测试，测试样本数量该怎么定。'

test('baseline: the real prompt still recalls the SOURCE_DRIFT negative', () => {
  const skills = mkdtempSync(join(tmpdir(), 'dsh-base-s-'))
  const memory = mkdtempSync(join(tmpdir(), 'dsh-base-m-'))
  writeSkill(
    skills,
    {
      name: 'threshold-fixture-sizing',
      title: '阈值型逻辑的测试样本必须超过阈值',
      when: '为按事件数/条目数阈值触发的逻辑写测试',
      how: ['fixture 至少 = 阈值 + 1', '先断言触发条件成立再断言效果'],
      evidence: [14337],
    },
    { sessionId: 's', boundarySeq: 1 },
  )
  writeSkill(
    skills,
    {
      name: 'persist-load-whitelist-fix',
      title: '持久化往返丢字段：先查 load 白名单',
      when: '对象保存后重新加载时部分字段为空（chunks 为空、标记 reviewed 却无内容）',
      how: ['带哨兵值 round-trip', '对比落盘键集合与白名单'],
      evidence: [14634],
    },
    { sessionId: 's', boundarySeq: 1 },
  )
  appendNegatives(
    memory,
    [
      {
        symptom: 'graft_commit 反复返回 SOURCE_DRIFT：last seq N -> N+1，即使没有任何外部改动',
        cause: '边界判定用可变 lastSeq 且写入早于校验',
        avoid: '改用 boundarySeq 并在任何写入前校验',
        evidence: [14926],
      },
    ],
    { sessionId: 's', boundarySeq: 1 },
  )

  const result = retrieve(memory, skills, PROMPT, { threshold: 0.55 })
  assert.ok(result.negative !== undefined, 'the SOURCE_DRIFT negative must be recalled')
  assert.match(result.negative.title, /SOURCE_DRIFT/u)
  if (result.skill !== undefined) {
    // 该 prompt 同时提到「重载丢字段」与「阈值样本」，两者都是合法命中；
    // 2026-11-03 实测先命中 persist-load-whitelist-fix。
    assert.ok(
      ['threshold-fixture-sizing', 'persist-load-whitelist-fix'].includes(result.skill.id),
      `unexpected skill: ${result.skill.id}`,
    )
  }
  assert.match(renderHint(result) ?? '', /记忆提示/u)
})