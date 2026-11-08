/**
 * THE PUBLIC SURFACE, LOCKED — and the seam inventory pinned with it.
 *
 * ── WHY (批次 3 第 1 组, 2026-11-08) ────────────────────────────────────────────────────────────
 *
 * Moving test-only exports into a `test-internals.ts` is NOT available in this freeze: the bundle
 * walker inlines only what is reachable from the entry, so a module referenced solely by tests is
 * never inlined and the tests would receive `undefined` at RUNTIME — with no build error to warn
 * anyone. (`dsh-memory` builds per file into `lib/`, so its own tests import modules directly; the
 * risk is the same in kind: a seam that moves must move in a way the build can see.)
 *
 * So the convergence is the enforceable half:
 *   1. the boundary is stated in the SOURCE (the `THE TEST-SEAM SURFACE` block in `src/index.ts`);
 *   2. the ENTRY surface and every module-level seam are pinned HERE, as literals.
 *
 * THE MEASUREMENT THIS FILE ENCODES, stated because a number must be checkable: the entry exports 31
 * names and TWO are seam-shaped; the module-level seams are four more, in `lib/filter.js` and
 * `lib/retrieve.js`. A rename or a deletion fails here before it can fail in CI's silence.
 *
 * NOTE FOR 批次 3 第 2 组: `MEMORY_PROTOCOL` and `searchSkills` are on the entry surface below and are
 * on the dead-code list. Removing them is a deliberate edit to THIS list — which is the point of
 * pinning it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')

/** The entry's export surface. Pinned so growth is a decision, not an accident. */
const ENTRY_SURFACE = [
  'DEFAULT_RETRIEVAL_FLOOR',
  'DEFAULT_RETRIEVAL_THRESHOLD',
  'MEMORY_PROTOCOL',
  'STORE_VERSION_MEMORY_FILES',
  'STORE_VERSION_SKILL_FILES',
  'activate',
  'appendExperiences',
  'appendFacts',
  'appendMemoryAudit',
  'appendNegatives',
  'apply',
  'buildEvidenceVerifier',
  'causalChain',
  'deriveProvenance',
  'describeCausalChain',
  'describeCausalGraph',
  'fileCausalSource',
  'forgetSkill',
  'harvest',
  'inject',
  'listSkillRecords',
  'monotonicTimestamp',
  'name',
  'readSkillBody',
  'recursiveCausalChain',
  'resetMonotonicClockForTest',
  'resolveMemoryConfigForTest',
  'searchSkills',
  'snapshotStoreVersion',
  'writeMemoryConsoleSetting',
  'writeSkill',
]

/** Seam-shaped names that are allowed to be on the entry. */
const ENTRY_SEAMS = ['resetMonotonicClockForTest', 'resolveMemoryConfigForTest']

/** Module-level seams, with the built module a test imports them from. */
const MODULE_SEAMS = [
  ['../lib/filter.js', ['clearFilterCache', 'filterCacheStats']],
  ['../lib/retrieve.js', ['clearSceneCache', 'sceneCacheStats', 'clearCommitCache']],
]

const seamShaped = (name) =>
  /ForTest$/u.test(name) || /Internals$/u.test(name) || /^debug/u.test(name) || /CacheStats$/u.test(name) || /^clear[A-Z]/u.test(name) || /^reset[A-Z]/u.test(name) || /^invalidate[A-Z]/u.test(name)

test('the entry’s export surface is EXACTLY the pinned inventory', async () => {
  const entry = await import('../lib/index.js')
  assert.deepEqual(
    Object.keys(entry).sort(),
    [...ENTRY_SURFACE].sort(),
    'the entry surface changed. A new FEATURE goes into ENTRY_SURFACE with its reason; a new TEST ' +
      'seam should stay module-level (see the rule in the source block) and be registered in ' +
      'MODULE_SEAMS instead.',
  )
})

test('every seam-SHAPED entry export is registered', async () => {
  const entry = await import('../lib/index.js')
  const unregistered = Object.keys(entry).filter((name) => seamShaped(name) && !ENTRY_SEAMS.includes(name))
  assert.deepEqual(unregistered, [], `unregistered seam-shaped entry export(s): ${unregistered.join(', ')}`)
})

test('every module-level seam is still exported by the module the tests import', async () => {
  for (const [file, names] of MODULE_SEAMS) {
    const mod = await import(file)
    for (const name of names) {
      assert.equal(typeof mod[name], 'function', `${file} must still export ${name}() as a function`)
    }
  }
})

test('the boundary is DOCUMENTED in the source, and the document names every seam', () => {
  assert.match(source, /THE TEST-SEAM SURFACE/u, 'the boundary block must stay in src/index.ts')
  assert.match(source, /THEY ARE NOT PUBLIC API/u, 'and it must keep saying what these are')
  assert.match(source, /test\/v102-seam-inventory\.test\.mjs/u, 'and point at this file')
  for (const name of [...ENTRY_SEAMS, ...MODULE_SEAMS.flatMap(([, names]) => names)]) {
    assert.ok(source.includes(name), `the boundary block must name ${name}`)
  }
  assert.match(source, /MEASURED, NOT ASSUMED/u, 'the number must stay attributed to a measurement')
})
