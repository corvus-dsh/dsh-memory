/**
 * LIFECYCLE: the listeners this plugin registers must be reclaimable by the loader.
 *
 * WHY A SOURCE CHECK AND NOT A PARAGRAPH
 *
 * `apply()` here builds detached copies of the context for late-bound services. A detached copy is a
 * plain object spread from `ctx`, so it HAS an `.on` (the framework's own) — and a listener registered
 * through it would sit on a context the loader never disposes. Nothing fails at load, nothing fails at
 * runtime, and the handler outlives the unload still holding its captured state.
 *
 * The rule is therefore mechanical: every `.on(` call site must be on the PLUGIN context.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The same rule the graft plugin pins, applied to this plugin's source. */
function assertListenersAreOnThePluginContext(file, label) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const offenders = []
  lines.forEach((line, index) => {
    if (!/\.on\??\(/u.test(line)) return
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return
    // `ctx.on(` / `ctx.on?.(` — the plugin's own context, disposed with the plugin.
    if (/\bctx\.on\??\(/u.test(line) || /\bthis\.ctx\.on\??\(/u.test(line)) return
    offenders.push(`${label}:${index + 1}: ${trimmed}`)
  })
  assert.deepEqual(
    offenders,
    [],
    `a listener registered on anything other than the plugin context is never disposed:\n${offenders.join('\n')}`,
  )
}

test('lifecycle: every `.on(` call site registers on the plugin context', () => {
  assertListenersAreOnThePluginContext(join(here, '..', 'src', 'index.ts'), 'index.ts')
})

test('lifecycle: no module-level collection keeps handlers alive past an unload', () => {
  /**
   * A SECOND SHAPE OF THE SAME LEAK: registering on `ctx` but also pushing the handler into a
   * module-level array "so we can remove it later". That array survives the unload, so the handler is
   * retained (and would be re-registered on the next load, running twice).
   *
   * The plugin registers through the context and lets the loader own the lifetime, so there must be no
   * such collection. Checked by name, because the intent is what matters here.
   */
  const source = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')
  for (const pattern of [/const\s+handlers\s*=\s*\[\]/u, /const\s+listeners\s*=\s*\[\]/u, /const\s+unsubscribes\s*=\s*\[\]/u]) {
    assert.equal(pattern.test(source), false, `module-level handler collection found: ${pattern}`)
  }
})
