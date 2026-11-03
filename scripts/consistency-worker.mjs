/**
 * v0.7.1 extreme-consistency worker.
 *
 * Spawned as a SEPARATE PROCESS by scripts/extreme-consistency.mjs, because the
 * claim under test is process-level: five OS processes read the ledger while one
 * OS process rewrites it. In-process async loops cannot prove that.
 *
 *   node scripts/consistency-worker.mjs reader <dir> <id> <durationMs>
 *   node scripts/consistency-worker.mjs writer <dir> <id> <durationMs>
 *
 * A reader fails (exit 2) if any line it observes is not valid JSON — that is a
 * torn write. The writer publishes through the same atomic write path the store
 * uses (tmp file + rename), which is the property that makes the read safe.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { appendNegatives } from '../lib/store.js'

const [, , mode, dir, id, durationMsRaw] = process.argv
const durationMs = Number(durationMsRaw ?? 1200)
const deadline = Date.now() + (Number.isFinite(durationMs) ? durationMs : 1200)
const ledger = join(dir, 'negatives.jsonl')
const meta = { sessionId: 'extreme-consistency', boundarySeq: 1 }

function finish(payload, code = 0) {
  writeFileSync(join(dir, `.worker-${mode}-${id}.json`), JSON.stringify(payload), 'utf8')
  process.exit(code)
}

if (mode === 'reader') {
  let reads = 0
  const errors = []
  while (Date.now() < deadline) {
    if (!existsSync(ledger)) continue
    let text = ''
    try {
      text = readFileSync(ledger, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/u)) {
      if (line.length === 0) continue
      try {
        JSON.parse(line)
      } catch (error) {
        errors.push({ line: line.slice(0, 120), reason: String(error?.message ?? error) })
      }
    }
    reads += 1
  }
  finish({ mode, id, reads, errors }, errors.length === 0 ? 0 : 2)
} else if (mode === 'writer') {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let written = 0
  while (Date.now() < deadline) {
    const tag = `${letters[written % 26]}${letters[Math.floor(written / 26) % 26]}`
    appendNegatives(
      dir,
      [
        {
          symptom: `并发写入记录 ${tag}`,
          cause: `没有原子写 ${tag}`,
          avoid: `先写临时文件再改名 ${tag}`,
          evidence: [{ sourceSessionId: 'extreme-consistency', seq: written + 1 }],
          scope: 'project',
          scene: 'database',
        },
      ],
      meta,
    )
    written += 1
  }
  finish({ mode, id, written })
} else {
  finish({ error: `unknown mode ${mode}` }, 1)
}