/**
 * ── v247 (B3 收口 / TD-M7): 负知识的「领域不符」——降权，并且说出来 ─────────────────────────────
 *
 * TD-M7 的退出条件（照抄，一字不改）：
 *   · 复用 task-alignment 的 `taskTerms`：当负知识的领域词与当前任务零交集时，额外降权并在前缀里
 *     写明「领域不符」；
 *   · 需一条「同领域旧负知识不降权」的对照测试。
 *
 * ── 这一笔最危险的耦合：反向导入 ────────────────────────────────────────────────────────────
 *
 * `interning.ts` 是检索层的叶，`retrieve.ts` 在它上面。若判据函数去 import `extractTaskTerms`
 * （在 `retrieve.ts`），**就造出反向依赖**，M6 刚立的规矩当场破掉。所以判据只接受调用方传下来的
 * `taskTerms`：**叶层永远不向上取词**。`v247 ⑤` 把这条钉死。
 *
 * ── 一个必须先说清的既有事实：零交集往往「已经被更严格地处理过」 ─────────────────────────────
 *
 * 在**非修错意图**下，task-alignment 门（v0.20）对「零交集 + incident 形状」的文档是**直接拦掉**
 * （`blockedByTask`），不是降权。所以「领域不符降权」真正可见的形态是：
 *
 *   · 修错意图（`askIsFixIntent`）—— 用户就是在问「这个错怎么修」，事故日志因此放行，此时
 *     跨领域的那条才需要**降权并说明**；
 *   · 或把门显式放宽（`taskAlignment: false`，差分开关）——用来看权重差本身。
 *
 * 两条路径在下面的测试里各用一次。**这不是 TD-M7 没生效，而是它的判据作用在门之后**：
 * 门负责「要不要出现」，TD-M7 负责「出现了该说得多重」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  NEGATIVE_DOMAIN_PREFIX,
  NEGATIVE_STALE_PREFIX,
  NEGATIVE_DOMAIN_MISMATCH_WEIGHT,
  domainVerdictFor,
  extractTaskTerms,
  renderHint,
  retrieve,
  retrieveCandidates,
} from '../lib/retrieve.js'
import { NEGATIVE_STALE_DAYS } from '../lib/thresholds.js'

const WORKSPACE = 'D:/持久层能力架构'
const here = dirname(fileURLToPath(import.meta.url))

/** A negative about a SPECIFIC subject, old enough to be an anecdote either way. */
function plantNegative(memoryDir, { symptom, cause, avoid, staleDays = NEGATIVE_STALE_DAYS + 10 }) {
  mkdirSync(memoryDir, { recursive: true })
  const at = new Date(Date.now() - staleDays * 86_400_000).toISOString()
  writeFileSync(
    join(memoryDir, 'negatives.jsonl'),
    `${JSON.stringify({
      symptom,
      cause,
      avoid,
      scope: 'project',
      workspace: WORKSPACE,
      at,
      hits: 1,
      provenance: 'tool',
    })}\n`,
    'utf8',
  )
}

const PYTEST_NEGATIVE = {
  symptom: 'pytest fixture 在 Windows 下路径报错',
  cause: '用了 POSIX 路径拼接',
  avoid: '改用 path.join',
}

/** The task that IS about the same subject, and one that is about something else entirely. */
const SAME_TASK = 'pytest fixture 路径 报错 怎么修'
const OTHER_TASK = 'graft slice 台账 幂等 迁移'

// ── ① 同领域：不额外降权 ─────────────────────────────────────────────────────────────────────

test('v247 ①: 同领域的旧负知识**不额外**降权（基础时效降权仍在，那是另一条规则）', () => {
  const memoryDir = join(mkdtempSync(join(tmpdir(), 'dsh-v247-same-')), 'memory')
  plantNegative(memoryDir, PYTEST_NEGATIVE)

  const result = retrieve(memoryDir, join(memoryDir, 'skills'), 'pytest fixture 路径 报错', {
    threshold: 0.01,
    workspace: WORKSPACE,
    taskTerms: extractTaskTerms(SAME_TASK),
    /** Fix intent admits the incident log through the v0.20 gate — see the header note. */
    taskFixIntent: true,
  })
  assert.ok(result.negative !== undefined, '同领域必须召回到这条 negative')

  assert.notEqual(result.negative.domainMismatch, true, '同领域不许被标成领域不符')
  const hint = renderHint(result)
  assert.ok(hint !== undefined)
  assert.equal(hint.includes(NEGATIVE_DOMAIN_PREFIX), false, `同领域的文案里不许出现「领域不符」：${hint}`)
  /** The BASE rule still applies: this negative is old and never re-hit. */
  assert.ok(hint.includes(NEGATIVE_STALE_PREFIX), '时效前缀是另一条规则，同领域也照旧')
})

// ── ② 不同领域：额外降权，并且说出来 ────────────────────────────────────────────────────────

test('v247 ②: 不同领域的旧负知识额外降权，且文案写明「领域不符」', () => {
  const memoryDir = join(mkdtempSync(join(tmpdir(), 'dsh-v247-diff-')), 'memory')
  plantNegative(memoryDir, PYTEST_NEGATIVE)

  const result = retrieve(memoryDir, join(memoryDir, 'skills'), 'pytest fixture 路径 报错', {
    threshold: 0.01,
    workspace: WORKSPACE,
    taskTerms: extractTaskTerms(OTHER_TASK),
    taskFixIntent: true,
  })
  assert.ok(result.negative !== undefined, '仍然要召回 —— 降权不是删除')
  assert.equal(result.negative.domainMismatch, true, '零交集必须被标出来')

  const hint = renderHint(result)
  assert.ok(hint !== undefined)
  assert.ok(hint.includes(NEGATIVE_DOMAIN_PREFIX), `文案必须写明「领域不符」：${hint}`)
  assert.ok(hint.includes('领域不符'), '这四个字就是退出条件点名的')
  /** Both brackets, in that order: time first, then subject. */
  assert.ok(
    hint.indexOf(NEGATIVE_STALE_PREFIX) < hint.indexOf(NEGATIVE_DOMAIN_PREFIX),
    '两条理由各说各的，顺序也固定（先时间、后领域）',
  )
})

// ── ③ 判据本身：三条边界 ────────────────────────────────────────────────────────────────────

test('v247 ③: 判据是「双方都有词且零交集」—— 未知不许变成「领域不符」', () => {
  const tokens = new Set(['pytest', 'fixture', '路径'])

  /** No task terms (an offline caller) ⇒ unknown, not off-topic. */
  assert.deepEqual(domainVerdictFor({ tokens }, undefined), { mismatch: false, weight: 1 })
  assert.deepEqual(domainVerdictFor({ tokens }, new Set()), { mismatch: false, weight: 1 })

  /** A negative with no words at all ⇒ unknown. */
  assert.deepEqual(domainVerdictFor({}, new Set(['anything'])), { mismatch: false, weight: 1 })

  /** One shared word is enough to be "same domain" — the rule is zero intersection, not low overlap. */
  assert.equal(domainVerdictFor({ tokens }, new Set(['fixture', '别的词'])).mismatch, false)

  /** Zero intersection ⇒ mismatch, and the weight is the published constant. */
  const verdict = domainVerdictFor({ tokens }, new Set(['graft', 'slice']))
  assert.equal(verdict.mismatch, true)
  assert.equal(verdict.weight, NEGATIVE_DOMAIN_MISMATCH_WEIGHT)
  assert.ok(verdict.weight < 1)
})

// ── ④ 降权真的发生在排序上（不是只写了个字段） ────────────────────────────────────────────────

test('v247 ④: 额外降权真的落在分数上 —— 同一条负知识，领域不符那一侧分数更低', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v247-score-'))
  const memoryDir = join(root, 'memory')
  plantNegative(memoryDir, PYTEST_NEGATIVE)
  const skillsDir = join(root, 'skills')

  /**
   * The gate is relaxed EXPLICITLY here (`taskAlignment: false`, the documented differential
   * switch): the point of this test is the weight, and a gate that refuses the document would make
   * the comparison vacuous rather than failing loudly.
   */
  const scoreFor = (taskTerms) => {
    const hits = retrieveCandidates(memoryDir, skillsDir, 'pytest fixture 路径 报错', {
      threshold: 0.001,
      workspace: WORKSPACE,
      taskTerms,
      taskAlignment: false,
    })
    const negative = hits.find((hit) => hit.kind === 'negative')
    assert.ok(negative !== undefined, `必须召回到 negative 才能比分数；got ${JSON.stringify(hits.map((h) => h.kind))}`)
    return negative
  }

  const same = scoreFor(extractTaskTerms(SAME_TASK))
  const off = scoreFor(extractTaskTerms(OTHER_TASK))
  assert.ok(off.score < same.score, `领域不符必须分数更低：off=${off.score} same=${same.score}`)
  assert.equal(off.domainMismatch, true)
  assert.notEqual(same.domainMismatch, true)
})

// ── ⑤ 反向依赖：叶层不许向上取词 ────────────────────────────────────────────────────────────

test('v247 ⑤: `interning.ts` 没有对 `retrieve.ts` 的**值**依赖（叶层永远不向上取词）', () => {
  const leaf = readFileSync(join(here, '..', 'src', 'retrieve', 'interning.ts'), 'utf8')
  /** `import type { Document } from '../retrieve.js'` is erased at build time and is fine. */
  const upward = [...leaf.matchAll(/^\s*import\s+(?!type\b)([^;\n]*?)\bfrom\s+['"]([^'"]+)['"]/gmu)]
    .map((match) => match[2])
    .filter((source) => /(?:^|\/)\.\.\/retrieve(?:\.js)?$/u.test(source))
  assert.deepEqual(upward, [], `叶层出现向上**值**依赖：${upward.join(', ')}`)

  /** And the task terms arrive as a PARAMETER — the shape that makes the rule enforceable. */
  assert.match(
    leaf,
    /export function domainVerdictFor\([\s\S]{0,220}?taskTerms\?:/u,
    '判据必须把 taskTerms 当参数收下，而不是自己去找',
  )
})

// ── ⑥ 端到端：预步骤那条路也带着「领域不符」 ────────────────────────────────────────────────

test('v247 ⑥: 端到端两步（retrieve → renderHint）都给前缀，不是只在判据函数里 ────────────────', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v247-e2e-'))
  const memoryDir = join(root, 'memory')
  plantNegative(memoryDir, PYTEST_NEGATIVE)
  const result = retrieve(memoryDir, join(root, 'skills'), 'pytest fixture 路径 报错', {
    threshold: 0.01,
    workspace: WORKSPACE,
    taskTerms: extractTaskTerms(OTHER_TASK),
    taskFixIntent: true,
  })
  assert.ok(result.negative !== undefined)
  const hint = renderHint(result)
  assert.ok(hint !== undefined)
  assert.ok(hint.includes('领域不符'), `端到端路径也必须说出来：${hint}`)
})