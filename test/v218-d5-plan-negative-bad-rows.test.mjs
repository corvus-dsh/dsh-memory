/**
 * ── v218: D-5 —— planNegative 对「坏行」的行为是「安静地不匹配」，不是「抛错」 ─────────────────
 *
 * D-5 修完，第一个形参从 `NegativeRecord[]` 放宽成「已解析的 JSONL 行」，symptom/cause
 * 用 `String(record.symptom ?? '')` 归一。副作用是：缺失 / 非字符串的 symptom 以前会在
 * `.toLowerCase()` 上抛错，现在归一成 '' 后「不匹配」。
 *
 * 这是一次**从响亮失败变成安静不匹配**的行为变化 —— 本仓最忌讳的方向（no silent dropping）。
 * 这次接受它，因为要删掉 `as never` 就别无他路；但必须把行为钉死：
 *   - 坏行不参与比较，**也不抛错**；
 *   - 合法行仍然正常命中（证明比较本身没有因为放宽而失效）。
 *
 * 如果将来有人把 `String(record.symptom ?? '')` 改回 `normalizeForMatch(record.symptom)`，
 * 这条测试会以 TypeError 变红 —— 那时才需要重新裁定「要不要抛错」，而不是静默改掉。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { planNegative } from '../lib/dedupe.js'

const candidate = {
  symptom: '端口 8080 被占用',
  cause: '旧进程未退出',
  avoid: '直接重启',
  evidence: [],
}

test('D-5 ①: 缺 symptom 的行不抛错，也不匹配', () => {
  assert.deepEqual(
    planNegative([{ cause: '旧进程未退出' }], candidate),
    { conflicts: [], duplicate: false },
  )
})

test('D-5 ②: symptom 不是字符串（数字）的行不抛错，也不匹配', () => {
  assert.deepEqual(
    planNegative([{ symptom: 8080, cause: '旧进程未退出' }], candidate),
    { conflicts: [], duplicate: false },
  )
})

test('D-5 ③: 缺 cause 但 symptom 相同的行 → 记一条冲突，绝不当作重复', () => {
  assert.deepEqual(
    planNegative([{ symptom: '端口 8080 被占用' }], candidate),
    { conflicts: [0], duplicate: false },
  )
})

test('D-5 ④: 合法行仍然照常命中 —— ③ 不是把比较放宽到失效', () => {
  assert.deepEqual(
    planNegative([{ symptom: '端口 8080 被占用', cause: '旧进程未退出' }], candidate),
    { conflicts: [], duplicate: true },
  )
})
