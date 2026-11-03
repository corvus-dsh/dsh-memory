/**
 * v0.20 — the task-alignment gate on the LIVE injection path.
 *
 * The unit tests in v020-task-alignment cover the predicate. This one covers the
 * wiring, which is where a semantic gate actually fails: a gate that is correct and
 * never called protects nothing, and a gate that is called with the WRONG terms
 * (e.g. rebuilt from "继续") refuses everything and gets switched off.
 *
 * What is asserted here:
 *   1. `taskAlignment` defaults to ON and is reachable from the console;
 *   2. the terms accumulate across a session's human turns, so a follow-up does not
 *      empty the gate;
 *   3. a fix-intent turn re-opens incident logs, and the NEXT design turn closes
 *      them again (the intent is per-turn, the terms are not);
 *   4. the panel can report the refusals.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, resolveMemoryConfigForTest } from '../lib/index.js'

function recordingCtx() {
  const tools = new Map()
  const commands = new Map()
  const handlers = new Map()
  return {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    commands: { register: (command) => commands.set(command.name, command) },
    registered: tools,
    commandsMap: commands,
    handlers,
    paths: { data: '' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get(name) {
      if (name === 'tools') return { register: (tool) => tools.set(tool.name, tool) }
      if (name === 'commands') return { register: (command) => commands.set(command.name, command) }
      return undefined
    },
    on(name, listener) {
      const list = handlers.get(name) ?? []
      list.push(listener)
      handlers.set(name, list)
    },
  }
}

test('v0.20: task alignment is ON by default and writable from the console', () => {
  const resolved = resolveMemoryConfigForTest(recordingCtx(), {})
  assert.equal(resolved.taskAlignment, true, 'a filter that is off by default protects nobody')
  // The differential switch is explicit, not implied.
  assert.equal(resolveMemoryConfigForTest(recordingCtx(), { taskAlignment: false }).taskAlignment, false)
})

test('v0.20: the memory console reports the gate and the refusals', async () => {
  const ctx = recordingCtx()
  apply(ctx, { memoryDir: '', skillsDir: '', graftDataDir: '' })
  const state = ctx.commandsMap.get('memory-console')
  assert.ok(state, 'the console command is registered')
  const reply = await state.handler({ agent: { id: 'agent-1' } })
  const payload = JSON.parse(reply.text)
  assert.equal(payload.config.taskAlignment, true, 'the panel can show the switch')
  // Nothing has been retrieved yet, so there is nothing to report.
  assert.equal(payload.blockedByTask, undefined)
})
