#!/usr/bin/env node
/**
 * ── TD-B1: IS THE COMMITTED ARTIFACT THE ONE THIS SOURCE BUILDS? (multi-file edition) ───────────────
 *
 * Same question as `dsh-observer/scripts/check-artifact-fresh.mjs`, different output shape: this repo
 * builds MANY files into `lib/` rather than one `index.js`. Measured before this file existed: this
 * repository had ZERO `*artifact*` scripts, so 「the shipped bundle is the source」 was a claim nobody
 * could check without a human rebuild and a visual diff.
 *
 * ── WHY THE FILE LIST COMES FROM THE INDEX, NOT FROM A GLOB ─────────────────────────────────────────
 *
 * The build DELETES `lib/` and rebuilds it, so after the rebuild every file on disk is fresh by
 * construction — a glob would compare the build against itself and always pass. The set to compare is
 * 「what git says we ship」, which is exactly the set a user can end up running.
 *
 * A file that the build no longer produces is reported as ORPHANED rather than ignored: it is committed,
 * so it ships, and it is no longer derived from any source. That is the 「moved it and left a copy」
 * failure one layer up, and it is invisible to any per-file freshness check.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

function git(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

/** Rebuild first: the question is 「what does THIS source produce」, not 「what did the last build leave」. */
execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: REPO, stdio: 'ignore' })

const tracked = git(['ls-files', 'lib'])
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.endsWith('.js'))

if (tracked.length === 0) {
  console.log('artifact-check: no artifact is committed — nothing to compare (not a pass claim about staleness)')
  process.exit(0)
}

const stale = []
const orphaned = []

for (const rel of tracked) {
  const abs = join(REPO, rel)
  if (!existsSync(abs)) {
    // The build removed it: committed output with no source behind it.
    orphaned.push(rel)
    continue
  }
  const working = readFileSync(abs, 'utf8')
  let committed
  try {
    committed = git(['show', `HEAD:${rel}`])
  } catch {
    stale.push({ rel, working, committed: '' })
    continue
  }
  if (working !== committed) stale.push({ rel, working, committed })
}

if (orphaned.length > 0) {
  console.log('artifact-check: COMMITTED OUTPUT THAT THIS SOURCE NO LONGER PRODUCES')
  for (const rel of orphaned) console.log(`  orphaned: ${rel} (its source is gone; delete it or restore the source)`)
  process.exit(1)
}
if (stale.length === 0) {
  console.log(`artifact-check: OK — the committed artifact is what this source builds (${tracked.length} file(s))`)
  process.exit(0)
}

console.log('artifact-check: THE COMMITTED ARTIFACT IS STALE')
for (const entry of stale) {
  console.log(`  ${entry.rel}`)
  console.log(`    working  : ${entry.working.length} chars`)
  console.log(`    committed: ${entry.committed.length} chars`)
}
console.log('  Run: git add lib/  (a benchmark or a restore step may have written old bytes back)')
console.log(`  repo: ${relative(process.cwd(), REPO) || '.'}`)
process.exit(1)
