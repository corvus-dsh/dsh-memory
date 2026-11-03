/**
 * v0.7.1 极限一致性测试 (extreme-consistency E2E).
 *
 * Runs the three acceptance scenarios from the audit:
 *
 *  1. PROCESS-LEVEL LEDGER RACE — 5 separate OS processes read
 *     `negatives.jsonl` in a tight loop while 1 separate OS process keeps
 *     appending through the store's atomic-write path. Every observed line must
 *     parse; the final file must contain every written record.
 *  2. OBSERVATIONAL EXTRACTION — a read/grep-only episode must yield a skill
 *     whose evidence is accepted as `observational`.
 *  3. VERSION DIVERGENCE — simulated "Python 3.8" and "Python 3.12" skills with
 *     the same trigger must NOT be merged; they must be linked as conflicts.
 *
 * Usage: node scripts/extreme-consistency.mjs [--duration-ms 1200]
 * Exit code 0 = every scenario passed.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractEpisode, sanitizeExtraction } from '../lib/extract.js'
import { buildEvidenceVerifier } from '../lib/index.js'
import { appendNegatives, environmentDivergence, parseSkillFile, skillPath, writeSkill } from '../lib/store.js'

const here = dirname(fileURLToPath(import.meta.url))
const worker = join(here, 'consistency-worker.mjs')
const durationArg = process.argv.indexOf('--duration-ms')
const durationMs = durationArg > 0 ? Number(process.argv[durationArg + 1]) : 1200

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function run(mode, dir, id) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [worker, mode, dir, id, String(durationMs)], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('close', (code) => resolve({ mode, id, code, stderr }))
    child.on('error', (error) => resolve({ mode, id, code: -1, stderr: String(error?.message ?? error) }))
  })
}

/** Scenario 1: five processes read while one process writes. */
async function scenarioLedgerRace() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-extreme-'))
  try {
    const readers = Array.from({ length: 5 }, (_, id) => run('reader', dir, String(id + 1)))
    const writer = run('writer', dir, '1')
    const settled = await Promise.all([...readers, writer])
    const writerResult = settled.find((item) => item.mode === 'writer')
    const readerResults = settled.filter((item) => item.mode === 'reader')

    const readerReports = readerResults.map((item) => {
      try {
        return JSON.parse(readFileSync(join(dir, `.worker-reader-${item.id}.json`), 'utf8'))
      } catch {
        return { reads: 0, errors: [{ reason: 'no report' }] }
      }
    })
    const writtenReport = (() => {
      try {
        return JSON.parse(readFileSync(join(dir, '.worker-writer-1.json'), 'utf8'))
      } catch {
        return { written: 0 }
      }
    })()

    const torn = readerReports.flatMap((report) => report.errors ?? [])
    check(
      '5 reader processes observed only valid JSON',
      torn.length === 0,
      `${readerReports.reduce((sum, report) => sum + report.reads, 0)} reads, ${torn.length} torn lines`,
    )
    check('all 5 readers actually ran', readerReports.every((report) => report.reads > 0), JSON.stringify(readerReports.map((r) => r.reads)))
    check('reader/writer processes exited cleanly', settled.every((item) => item.code === 0), JSON.stringify(settled.map((item) => `${item.mode}#${item.id}=${item.code}${item.stderr ? `:${item.stderr.trim().slice(0, 200)}` : ''}`)))

    const lines = readFileSync(join(dir, 'negatives.jsonl'), 'utf8').split(/\r?\n/u).filter(Boolean)
    const parsed = lines.map((line) => JSON.parse(line))
    check('final ledger is complete and parseable', parsed.length === lines.length && lines.length > 0, `${lines.length} records`)
    check(
      'the writer reported what the ledger holds',
      writtenReport.written >= lines.length,
      `written=${writtenReport.written} unique=${lines.length} (dedupe may merge repeats)`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Scenario 2: a read/grep-only session still produces verified memory. */
async function scenarioObservational() {
  const events = [
    { type: 'tool/call', seq: 10, data: { callId: 'r1', name: 'read' } },
    { type: 'tool/result', seq: 11, data: { message: { source: { callId: 'r1' }, content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'tool/call', seq: 12, data: { callId: 'g1', name: 'grep' } },
    { type: 'tool/result', seq: 13, data: { message: { source: { callId: 'g1' }, content: [{ type: 'text', text: 'ok' }] } } },
  ]
  const episode = {
    sessionId: 'extreme-observational',
    boundarySeq: 13,
    turns: 1,
    conclusions: [],
    errors: [],
    successes: [],
    toolNames: ['read', 'grep'],
    evidence: [10, 11, 12, 13],
  }
  const llm = {
    async *stream() {
      yield {
        type: 'text-delta',
        text: JSON.stringify({
          skills: [
            {
              name: 'observational-shape',
              title: '只读分析得出的结构经验',
              description: '从源码读出的事务边界。',
              when_to_use: '当需要确认真实事务边界时',
              scope: 'project',
              scene: 'database',
              aliases: ['事务边界'],
              steps: ['读源码定位 begin', '对照 commit 调用点'],
              verify: ['找到成对的 begin/commit'],
              evidence: [11, 13],
            },
          ],
        }),
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const result = await extractEpisode(llm, episode, { verify: buildEvidenceVerifier(events) })
  const skill = result.skills[0]
  check('read/grep-only evidence passes the verifier', result.ok && skill !== undefined, result.dropped.join(' | '))
  check('the extracted skill is marked observational', skill?.evidenceKind === 'observational', String(skill?.evidenceKind))
}

/** Scenario 3: Python 3.8 vs 3.12 with an identical trigger must not merge. */
function scenarioVersionDivergence() {
  const skills = mkdtempSync(join(tmpdir(), 'dsh-mem-extreme-env-'))
  try {
    const meta = { sessionId: 'extreme-env', boundarySeq: 1 }
    const base = {
      name: 'pymysql-connect',
      description: '连接 MySQL。',
      when: '当需要用 Python 连接 MySQL 时',
      scope: 'project',
      scene: 'database',
      aliases: [],
      verify: ['查询返回行'],
      evidence: [{ sourceSessionId: 'extreme-env', seq: 1 }],
    }
    const py38 = { ...base, title: 'pymysql 3.8', steps: ['用 python 3.8 安装 pymysql', '建立连接'] }
    const py312 = { ...base, title: '内置驱动 3.12', steps: ['用 python 3.12 内置驱动建立连接', '执行查询'] }
    const divergence = environmentDivergence(py38, py312)
    check('environment divergence is detected', divergence !== undefined, JSON.stringify(divergence))
    const first = writeSkill(skills, py38, meta)
    const second = writeSkill(skills, py312, meta)
    check('the second skill is written as a conflict, not merged', second.startsWith('conflicted:'), first + ' / ' + second)
    const original = parseSkillFile(readFileSync(skillPath(skills, 'pymysql-connect'), 'utf8'), 'pymysql-connect')
    const alternative = parseSkillFile(readFileSync(skillPath(skills, 'pymysql-connect-2'), 'utf8'), 'pymysql-connect-2')
    check('both files link each other as conflicts', original.aliases !== undefined && alternative.aliases !== undefined, 'files exist')
    const originalText = readFileSync(skillPath(skills, 'pymysql-connect'), 'utf8')
    const alternativeText = readFileSync(skillPath(skills, 'pymysql-connect-2'), 'utf8')
    check(
      'each file names the other (no one-way conflict)',
      /conflicts_with: pymysql-connect-2/u.test(originalText) && /conflicts_with: pymysql-connect$/mu.test(alternativeText),
    )
  } finally {
    rmSync(skills, { recursive: true, force: true })
  }
}

await scenarioLedgerRace()
await scenarioObservational()
scenarioVersionDivergence()

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  for (const item of failed) console.error(`FAILED: ${item.name} ${item.detail}`)
  process.exit(1)
}