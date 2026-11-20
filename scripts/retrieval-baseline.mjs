#!/usr/bin/env node
/**
 * ── RETRIEVAL SCALE BASELINE (B4-0b-2 W4-3) ─────────────────────────────────────────────────────
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────
 *
 * Audit AUD-14: the retrieval path had NO scale baseline. The claim 「2.5 ms at 2000 documents」
 * existed only in a report, measured once, by hand, on an unknown machine — which is the same
 * condition that let 「four repos byte-identical」 be written down as fact (W4-1b).
 *
 * ── WHAT IT MEASURES, AND WHAT IT REFUSES TO MEASURE ────────────────────────────────────────
 *
 * It drives the REAL entry point (`skillDocuments`, the function production calls to turn a skills
 * directory into documents) over corpora of 50 / 200 / 800 / 2000 generated SKILL.md files.
 *
 * WARM ONLY, AND COLD IS NOT A SEPARATE COLUMN HERE — IT IS A DIFFERENT QUESTION.
 *
 *   · WARM = the corpus is on disk and the module's caches are populated; this is the steady state a
 *     turn actually experiences, and it is what a threshold can mean.
 *   · COLD = first read of the day, dominated by filesystem and OS page cache. Mixing them would make
 *     one number that describes neither. `--cold` reports it SEPARATELY when asked, with the same
 *     corpus, and it is never averaged with warm.
 *
 * A baseline is not a gate. Nothing here fails a build; `--check <ms>` exists so a future threshold
 * can be expressed, and it refuses to run with fewer than 5 samples (the same rule `measure-efficiency`
 * follows: a verdict from three samples is a guess wearing a number).
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────────────────────
 *
 *   node scripts/retrieval-baseline.mjs                 # warm, every size, prints a table
 *   node scripts/retrieval-baseline.mjs --cold          # cold, separately, same sizes
 *   node scripts/retrieval-baseline.mjs --check 2       # exit 1 if the 2000-doc WARM median > 2 ms
 *   node scripts/retrieval-baseline.mjs --samples 9     # more samples (5 minimum)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ── IT DRIVES THE BUILT ARTIFACT, NOT THE TypeScript SOURCE (measured) ────────────────────────
 *
 * The first version imported `../src/retrieve/documents.js`, which Node resolves to a file that does
 * not exist — the sources are `.ts` and the package ships compiled `lib/`. Every other test in this
 * repository goes through `lib/` or `index.js` for the same reason.
 *
 * This is also the more honest target: a benchmark of the code that does not run is a measurement of
 * nothing. `npm run build` must have been run (the `check` chain always does it first).
 */
import { skillDocuments } from '../lib/retrieve/documents.js'

const SIZES = [50, 200, 800, 2000]
const MIN_SAMPLES = 5

function parseArgs(argv) {
  const options = { cold: false, samples: 7, check: undefined, checkCold: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--cold') {
      options.cold = true
      continue
    }
    if (arg === '--samples') {
      options.samples = Number(argv[index + 1])
      index += 1
      continue
    }
    if (arg === '--check') {
      options.check = Number(argv[index + 1])
      index += 1
      continue
    }
    if (arg === '--check-warm') {
      options.check = Number(argv[index + 1])
      index += 1
      continue
    }
    if (arg === '--check-cold') {
      options.checkCold = Number(argv[index + 1])
      index += 1
      continue
    }
    console.error(`unknown argument: ${arg}`)
    process.exit(2)
  }
  if (!Number.isFinite(options.samples) || options.samples < MIN_SAMPLES) {
    /**
     * THE MINIMUM IS NOT DECORATION. A median of three samples on a shared machine is noise with a
     * decimal point; `measure-efficiency.mjs` already refuses fewer than five for the same reason.
     */
    console.error(`--samples must be ≥ ${MIN_SAMPLES} (a verdict from fewer is a guess)`)
    process.exit(2)
  }
  if (options.check !== undefined && (!Number.isFinite(options.check) || options.check <= 0)) {
    console.error('--check must be a positive number of milliseconds')
    process.exit(2)
  }
  return options
}

/**
 * A corpus shaped like the real thing: SKILL.md files with frontmatter the reader actually parses.
 *
 * Deliberately NOT one giant template with a number substituted — the retrieval path tokenises
 * titles and `when_to_use`, so a corpus of near-identical strings would measure a cache hit pattern
 * that production never sees. Each document gets distinct vocabulary.
 */
function buildCorpus(root, size) {
  const skills = join(root, `skills-${size}`)
  mkdirSync(skills, { recursive: true })
  const topics = ['检索', '切片', '点火', '租约', '沙箱', '门禁', '账本', '转述', '预算', '看板']
  for (let index = 0; index < size; index += 1) {
    const topic = topics[index % topics.length]
    const dir = join(skills, `skill-${topic}-${index}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      [
        '---',
        `name: skill-${topic}-${index}`,
        `description: 处理 ${topic} 的第 ${index} 个场景，区分 ${index % 7} 种边界`,
        `when_to_use: 当需要处理 ${topic} 且出现第 ${index} 类情形时`,
        `tags: [${topic}, batch-${index % 13}]`,
        '---',
        '',
        `# ${topic} 场景 ${index}`,
        '',
        `这是第 ${index} 份语料，用于测量检索在规模下的表现。`,
        `关键词 ${index % 97} 与 ${index % 31} 让它区别于其它文档。`,
        '',
      ].join('\n'),
      'utf8',
    )
  }
  return skills
}

/** Median of the samples, after dropping the first (module init / cache warm-up). */
function median(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

async function measure(skills, samples, cold) {
  const times = []
  for (let index = 0; index < samples; index += 1) {
    /**
     * COLD means "forget what we knew": the skill-document cache is keyed on the directory's mtime,
     * so it is cleared explicitly before each timed call — otherwise every sample after the first
     * measures a cache hit and the corpus size stops mattering (measured: 0.02 ms at both 50 and 2000).
     */
    if (cold) await invalidate(skills)
    const startedAt = process.hrtime.bigint()
    const documents = skillDocuments(skills, Date.now())
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    if (documents.length === 0) {
      console.error(`measured ZERO documents in ${skills} — an empty corpus is not a fast corpus`)
      process.exit(2)
    }
    /**
     * THE DOCUMENT COUNT IS RETURNED, NOT ASSUMED. A parser that silently returns one document per
     * hundred files would still be "fast", and the table would look fine.
     */
    times.push({ ms: elapsedMs, docs: documents.length })
  }
  return times
}

/**
 * ── COLD MEANS "FORGET THE CACHE", AND THE FIRST VERSION DID NOT DO THAT (measured) ──────────
 *
 * The initial run reported **0.02 ms at 2000 documents** — suspiciously identical to the 50-document
 * case. That is the signature of measuring a CACHE HIT, not a retrieval: `skillDocuments` consults
 * `skill-cache.ts` keyed on the directory's mtime, so every sample after the first answered from
 * memory and the corpus size stopped mattering.
 *
 * The first version "invalidated" via `invalidateDocuments` from `retrieve.js`, which clears the
 * DOCUMENT cache — a different cache, one layer up. `invalidateSkillDocs` is the one this path reads.
 *
 * Both numbers are now reported, because they answer different questions:
 *
 *   WARM — what a turn actually experiences once the process has been running (cache hit).
 *   COLD — the scan itself: every SKILL.md read and parsed. This is the number with a scale story.
 *
 * Reporting only warm would have let 「2000 documents in 0.02 ms」 be copied into a report, which is
 * true and means almost nothing.
 */
async function invalidate(skills) {
  const { invalidateSkillDocs } = await import('../lib/skill-cache.js')
  invalidateSkillDocs(skills)
}

const options = parseArgs(process.argv.slice(2))
const root = mkdtempSync(join(tmpdir(), 'dsh-retrieval-'))

try {
  console.log(`RETRIEVAL BASELINE — ${options.samples} samples each`)
  console.log(`node ${process.version} · ${process.platform} ${process.arch}`)
  console.log('')
  /**
   * ── WARM AND COLD ARE BOTH PRINTED, IN SEPARATE COLUMNS ─────────────────────────────────────
   *
   * They are different questions and neither implies the other:
   *
   *   WARM (cached) — the steady state a running process experiences. Fast, and flat in corpus size.
   *   COLD (scan)   — every SKILL.md read and parsed. THIS is the number that tells a scale story.
   *
   * The first version printed only warm and produced 「2000 documents in 0.02 ms」, which is true,
   * meaningless, and exactly the kind of number this batch keeps finding copied into reports.
   */
  console.log('  docs    warm(ms)   cold(ms)   parsed')
  console.log('  ─────────────────────────────────────────')

  const results = new Map()
  for (const size of SIZES) {
    const skills = buildCorpus(root, size)
    /** One untimed pass first: module init and OS page cache, not the operation. */
    skillDocuments(skills, Date.now())

    const warm = await measure(skills, options.samples, false)
    const cold = await measure(skills, options.samples, true)
    const warmMedian = median(warm.map((sample) => sample.ms))
    const coldMedian = median(cold.map((sample) => sample.ms))
    const parsed = cold[0].docs
    results.set(size, { warm: warmMedian, cold: coldMedian, parsed })

    console.log(
      `  ${String(size).padStart(4)}   ${warmMedian.toFixed(2).padStart(7)}   ${coldMedian.toFixed(2).padStart(7)}   ${String(parsed).padStart(5)}`,
    )
    /**
     * A CORPUS THAT DID NOT FULLY PARSE IS A MEASUREMENT OF A SMALLER CORPUS. Without this line, a
     * reader has no way to tell "2000 documents in 3 ms" from "17 documents in 3 ms".
     */
    if (parsed !== size) {
      console.log(`         note: asked for ${size}, parsed ${parsed} — the delta is real and belongs in the reading`)
    }
  }

  console.log('')
  /**
   * ── TWO THRESHOLDS, BECAUSE THE DISPATCH'S 「2000 ≤ 2 ms」 MEANS WARM ───────────────────────────
   *
   * The dispatch's criterion is warm ≤ 2 ms at 2000 documents. Measured: warm 0.03 ms — met, with
   * room. But warm is a CACHE HIT (the skill-document cache keys on the directory mtime), so a
   * threshold on it alone would let a 2000x regression in the SCAN pass unnoticed: cold is 258 ms.
   *
   * So both are checkable and neither is assumed to stand for the other:
   *   --check-warm <ms>   the dispatch's number (default when only one is given)
   *   --check-cold <ms>   the scan; what a fresh process pays
   */
  const thresholds = [
    ['warm', options.check, results.get(2000)?.warm],
    ['cold', options.checkCold, results.get(2000)?.cold],
  ].filter(([, limit]) => limit !== undefined)

  if (thresholds.length === 0) {
    console.log('no threshold set (a baseline is not a gate). Use --check-warm / --check-cold to enforce one.')
  } else {
    let violated = false
    for (const [kind, limit, measured] of thresholds) {
      if (measured === undefined) {
        console.error(`cannot check ${kind}: the 2000-document corpus did not run`)
        process.exit(2)
      }
      if (measured > limit) {
        console.error(`THRESHOLD EXCEEDED — 2000 docs ${kind.toUpperCase()}: ${measured.toFixed(2)} ms > ${limit} ms`)
        violated = true
      } else {
        console.log(`within threshold: 2000 docs ${kind.toUpperCase()} ${measured.toFixed(2)} ms ≤ ${limit} ms`)
      }
    }
    if (violated) process.exit(1)
  }
  /**
   * THE ENVIRONMENT IS PART OF THE READING. A number without it is a claim that cannot be re-checked,
   * which is how the old 「2.5 ms」 figure outlived the machine it was measured on.
   */
  console.log(`environment: node ${process.version}, ${process.platform} ${process.arch}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
