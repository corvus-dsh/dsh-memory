/**
 * v0.9.6 — the two `sleepSync` implementations must not drift apart.
 *
 * ── THE PROBLEM THIS EXISTS FOR ─────────────────────────────────────────────────────────────────
 *
 * This ecosystem has TWO independent file locks with no shared dependency:
 *
 *     dsh-memory/src/lock.ts        a paradise LEASE, on `<file>.lock`
 *     dsh-graft-slice/src/core/txn.ts   its own mkdir lock + owner token
 *
 * They are separate on purpose (each package must work standalone), so nothing in the code links
 * them. Which means nothing notices when they disagree.
 *
 * They DID disagree, and it cost real numbers: graft's `sleepSync` used `Atomics.wait` (a real sleep)
 * while memory's spun on `Date.now()`. Waiting 50 ms cost 0.0 ms of CPU in one and 62.0 ms in the
 * other — 97.1% of a core — and the second one was manufactured CPU starvation that a benchmark then
 * mis-read as lock contention.
 *
 * Memory has now been aligned to graft. This test is the ONLY thing that keeps them aligned: it reads
 * both SOURCE FILES and asserts the waiting strategy is the same. A future edit in either repository
 * turns this red instead of silently reintroducing a spin.
 *
 * ── WHY IT READS THE SOURCE AND NOT THE BUILT BUNDLE ───────────────────────────────────────────
 *
 * `sleepSync` is module-private in both packages (not exported — exporting it would widen a public
 * surface for a test's benefit). Source text is therefore the only observable. That is a weaker check
 * than calling the function, and it is paired with a BEHAVIOURAL test in the same package
 * (`v096-lock-sleep-cpu.test.mjs`, which measures `process.cpuUsage()`): one proves the shape, the
 * other proves the effect.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const MEMORY_LOCK = join(REPO, 'src', 'lock.ts')
/** The sibling repository, when checked out beside this one (the layout CI and the workspace use). */
const GRAFT_TXN = resolve(REPO, '..', 'dsh-graft-slice', 'src', 'core', 'txn.ts')

/** Extract a function body by brace matching from its `function name(` line. */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) return undefined
  const open = source.indexOf('{', start)
  if (open < 0) return undefined
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  return undefined
}

/**
 * A busy-wait is detectable by its SHAPE: a `while` loop whose condition compares `Date.now()`.
 * The fallback branch also contains one, but it sits inside a `catch` and only runs when
 * `Atomics.wait` is unavailable — so the assertion is "an `Atomics.wait` call exists AND the
 * function does not START with a bare spin loop".
 */
function isRealSleep(body) {
  const hasAtomics = /Atomics\.wait\s*\(/u.test(body)
  // The pre-change memory body was: function sleepSync(ms){ const until=...; while(Date.now()<until){} }
  // i.e. no try/catch at all. Detect that directly rather than counting loops.
  const isBareSpin = !/try\s*\{/u.test(body) && /while\s*\(\s*Date\.now\(\)/u.test(body)
  return { hasAtomics, isBareSpin }
}

test('v0.9.6: memory sleepSync is a real sleep, not a busy-wait', () => {
  const body = functionBody(readFileSync(MEMORY_LOCK, 'utf8'), 'sleepSync')
  assert.ok(body !== undefined, 'sleepSync must exist in dsh-memory/src/lock.ts')
  const { hasAtomics, isBareSpin } = isRealSleep(body)
  assert.equal(isBareSpin, false, 'memory sleepSync is a bare busy-wait again — this is the 97%-of-a-core shape')
  assert.equal(hasAtomics, true, 'memory sleepSync must call Atomics.wait')
})

test('v0.9.6: graft and memory wait the SAME way (cross-repo parity)', () => {
  if (!existsSync(GRAFT_TXN)) {
    // A published tarball or a single-repo checkout legitimately has no sibling. Say so loudly rather
    // than passing silently: the parity claim is unverified in this environment.
    console.log(`skip: ${GRAFT_TXN} not present — parity cannot be checked in this checkout`)
    return
  }
  const graftBody = functionBody(readFileSync(GRAFT_TXN, 'utf8'), 'sleepSync')
  const memoryBody = functionBody(readFileSync(MEMORY_LOCK, 'utf8'), 'sleepSync')
  assert.ok(graftBody !== undefined, 'graft must still have sleepSync')
  assert.ok(memoryBody !== undefined, 'memory must still have sleepSync')

  const graft = isRealSleep(graftBody)
  const memory = isRealSleep(memoryBody)

  assert.equal(
    graft.hasAtomics,
    memory.hasAtomics,
    `the two locks must agree on waiting: graft(${graft.hasAtomics}) vs memory(${memory.hasAtomics})`,
  )
  assert.equal(graft.isBareSpin, memory.isBareSpin, 'one file spins and the other sleeps — they have drifted')
  assert.equal(graft.isBareSpin, false, 'neither lock may spin')
})

test('v0.9.6: neither source file reintroduces a top-level Date.now() spin', () => {
  // A blunt second net: the shape the old implementation was built from must not reappear as the
  // ONLY thing in a wait helper. Catches a newly-named helper doing the old thing.
  //
  // ── COMMENTS MUST BE STRIPPED FIRST ──────────────────────────────────────────────────────────
  //
  // The doc comment above `sleepSync` quotes the old body — `while (Date.now() < until) {}` — to
  // explain what was removed. A naive scan finds that quote and reports "a spin outside sleepSync",
  // which is a false failure on a file that is entirely correct. Measured: that is exactly what the
  // first version of this test did.
  const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

  const memorySource = readFileSync(MEMORY_LOCK, 'utf8')
  const code = stripComments(memorySource)
  const spinPattern = /while\s*\(\s*Date\.now\(\)\s*<\s*(?:until|end)\s*\)/gu
  const occurrences = [...code.matchAll(spinPattern)]

  for (const match of occurrences) {
    const bodyStart = code.lastIndexOf('function sleepSync', match.index)
    assert.ok(bodyStart >= 0, 'a Date.now() spin exists in executable code outside sleepSync — a new wait helper is spinning')
    const body = functionBody(code.slice(bodyStart), 'sleepSync')
    assert.ok(body !== undefined, 'could not read the enclosing sleepSync body')
    assert.match(
      body,
      /Atomics\.wait\s*\(/u,
      'a Date.now() spin exists in a wait helper that never calls Atomics.wait — that is the removed implementation',
    )
    // The spin must be in the fallback branch, not the primary path.
    const tryBlock = body.slice(body.indexOf('try'), body.indexOf('} catch'))
    assert.equal(
      /while\s*\(\s*Date\.now\(\)/u.test(tryBlock),
      false,
      'the PRIMARY path spins — Atomics.wait belongs there, the loop belongs in the fallback',
    )
  }

  // The comments must still say what was removed — otherwise the next reader has no idea why the
  // fallback loop is there and may "simplify" it back into the primary path.
  assert.match(
    memorySource,
    /Atomics\.wait is a real sleep/u,
    'the comment explaining why this is not a busy-wait has been lost',
  )
})
