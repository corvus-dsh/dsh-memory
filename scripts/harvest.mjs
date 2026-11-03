#!/usr/bin/env node
/**
 * Offline harvest CLI (M1).
 *
 *   node scripts/harvest.mjs --dry-run \
 *     --data-dir  <profile>/data/dsh-graft-slice \
 *     --sessions-root <home>/sessions
 *
 *   node scripts/harvest.mjs \
 *     --data-dir ... --sessions-root ... \
 *     --llm-url https://api.example.com/v1/chat/completions --llm-key sk-... --llm-model deepseek-chat
 *
 * The plugin path uses `ctx.sessionQuery.readSession` (host service). This CLI
 * cannot, so it reads the same artifact directly — with its OWN zstd reader
 * (`src/zstd.ts`), because importing the slicing plugin's reader would break the
 * decoupling rule this package exists to honour.
 *
 * `--dry-run` is the safe first step: it prints the digest and the exact prompt,
 * writes nothing, and spends no tokens.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { readLedgers } from '../lib/ledger.js'
import { segmentSession, renderEpisode } from '../lib/segment.js'
import { EXTRACT_SYSTEM_PROMPT, extractEpisode } from '../lib/extract.js'
import { appendNegatives, defaultSkillsDir, markProcessed, processedKey, readProcessed, stats, writeSkill } from '../lib/store.js'
import { readSessionLogFile } from '../lib/zstd.js'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}

const dryRun = process.argv.includes('--dry-run')
const dataDir = arg('data-dir', process.env.DSH_GRAFT_DATA_DIR ?? '')
const sessionsRoot = arg('sessions-root', join(process.env.DSH_HOME ?? '', 'sessions'))
const memoryDir = arg('memory-dir', dataDir ? join(dataDir, '..', 'dsh-memory', '.dsh-memory') : '')
const skillsDir = arg('skills-dir', defaultSkillsDir())
const limit = Number(arg('limit', 3))
const llmUrl = arg('llm-url', process.env.DSH_MEMORY_LLM_URL ?? '')
const llmKey = arg('llm-key', process.env.DSH_MEMORY_LLM_KEY ?? '')
const llmModel = arg('llm-model', process.env.DSH_MEMORY_LLM_MODEL ?? '')

function fail(message) {
  process.stderr.write(`\n✖ ${message}\n`)
  process.exit(1)
}

if (typeof dataDir !== 'string' || dataDir.length === 0) fail('缺少 --data-dir（graft 插件的 dataDir）')
if (typeof memoryDir !== 'string' || memoryDir.length === 0) fail('缺少 --memory-dir')
if (typeof sessionsRoot !== 'string' || sessionsRoot.length === 0) fail('缺少 --sessions-root')

/** Locate `<root>/<workspace>/<sessionId>/session.v4.jsonl.zstd`. */
function findSessionFile(sessionId) {
  let workspaces = []
  try {
    workspaces = readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return undefined
  }
  for (const workspace of workspaces) {
    const candidate = join(sessionsRoot, workspace.name, sessionId, 'session.v4.jsonl.zstd')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function openAiLlm(url, key, model) {
  return {
    async *stream(options) {
      const user = options.messages?.[0]?.content?.[0]?.text ?? ''
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key === undefined || key === '' ? {} : { authorization: `Bearer ${key}` }),
        },
        body: JSON.stringify({
          model: options.model ?? model,
          messages: [
            { role: 'system', content: options.system ?? '' },
            { role: 'user', content: user },
          ],
          max_tokens: options.maxTokens ?? 1600,
          temperature: 0.2,
        }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      if (!response.ok) throw new Error(`llm HTTP ${response.status}`)
      const payload = await response.json()
      const text = payload?.choices?.[0]?.message?.content ?? ''
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

const ledgers = readLedgers(resolve(dataDir))
const processed = readProcessed(resolve(memoryDir))
const queue = ledgers.retired.filter((id) => !processed.has(processedKey(id, -1))).slice(0, Number.isFinite(limit) ? limit : 3)

process.stdout.write(
  `[dsh-memory] ledger: ${ledgers.retired.length} retired, ${Object.keys(ledgers.transferred).length} transferred; ` +
    `queue ${queue.length} (limit ${limit})${dryRun ? '  [DRY RUN]' : ''}\n`,
)

const llm = dryRun ? undefined : llmUrl ? openAiLlm(llmUrl, llmKey, llmModel) : undefined
if (!dryRun && llm === undefined) fail('真跑需要 --llm-url（OpenAI 兼容 /chat/completions），或先加 --dry-run')

let harvested = 0
for (const sessionId of queue) {
  const file = findSessionFile(sessionId)
  if (file === undefined) {
    process.stdout.write(`  ⚠ ${sessionId}: 找不到 session.v4.jsonl.zstd，跳过\n`)
    continue
  }
  let log
  try {
    log = readSessionLogFile(file)
  } catch (error) {
    process.stdout.write(`  ⚠ ${sessionId}: 读日志失败 ${String(error?.message ?? error)}\n`)
    continue
  }
  const episode = segmentSession(sessionId, log)
  const key = processedKey(sessionId, episode.boundarySeq)

  if (dryRun) {
    process.stdout.write(
      `\n=== ${sessionId} (${episode.turns} turns, boundary seq ${episode.boundarySeq}) ===\n` +
        `${renderEpisode(episode).split('\n').slice(0, 24).join('\n')}\n`,
    )
    process.stdout.write(`--- prompt (${EXTRACT_SYSTEM_PROMPT.length} chars system + ${renderEpisode(episode).length} chars episode) ---\n`)
    continue
  }

  const result = await extractEpisode(llm, episode, { ...(llmModel ? { model: llmModel } : {}) })
  const meta = { sessionId, boundarySeq: episode.boundarySeq }
  const skills = result.skills.map((skill) => `${skill.name}:${writeSkill(resolve(skillsDir), skill, meta)}`)
  const negatives = appendNegatives(resolve(memoryDir), result.negatives, meta)
  markProcessed(resolve(memoryDir), key)
  harvested += 1
  process.stdout.write(
    `\n=== ${sessionId} ===\n  turns=${episode.turns} skills=${skills.join(', ') || '(none)'} ` +
      `negatives=${negatives} dropped=${result.dropped.length}\n` +
      (result.dropped.length > 0 ? `  dropped: ${result.dropped.slice(0, 6).join(' | ')}\n` : ''),
  )
}

process.stdout.write(`\n[dsh-memory] done: harvested ${harvested}; ${JSON.stringify(stats(resolve(memoryDir), resolve(skillsDir)))}\n`)