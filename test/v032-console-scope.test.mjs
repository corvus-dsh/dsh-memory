/**
 * v0.32 P0 — the SAME defect the graft console had: a helper declared inside the
 * fetch effect, called from a component-scope `write` closure.
 *
 * Live symptom (reported with a screenshot):
 *
 *   错误详情：{"message":"withTimeout is not defined","via":"remote.commands.execute"}
 *   以上开关显示的是插件默认值，不是宿主的真实配置。点击「刷新」重试。
 *
 * No knob in the memory console could ever be written. `node --test` never executes
 * the Client half, so this is a static assertion on the invariant that broke.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, '..', 'client.js'), 'utf8')

test('v0.32 console: withTimeout is factory-scoped, so the toggle handlers resolve it', () => {
  const declarations = [...bundle.matchAll(/^\s*const withTimeout\s*=/gmu)]
  assert.equal(declarations.length, 1, 'exactly one definition, so there is no shadowing copy to drift')

  const declarationAt = bundle.indexOf('const withTimeout')
  const firstEffectAt = bundle.indexOf('React.useEffect(')
  const firstWriteAt = bundle.indexOf('const write = async')
  assert.ok(firstEffectAt > 0, 'the fetch effect is present')
  assert.ok(firstWriteAt > 0, 'the toggle handler is present')
  assert.ok(declarationAt < firstEffectAt, 'declared BEFORE the first effect, or `write` cannot see it')
  assert.ok(declarationAt < firstWriteAt, 'and before the handler that calls it')

  const writeBody = bundle.slice(firstWriteAt, firstWriteAt + 4000)
  assert.match(writeBody, /withTimeout\(bridge\.set/u, 'the write path still goes through the bounded helper')
})
