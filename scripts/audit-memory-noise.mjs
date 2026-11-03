#!/usr/bin/env node
/**
 * v0.17 security audit: find HOST NOISE that already reached the memory store.
 *
 * WHAT THIS LOOKS FOR
 *
 * The v0.17 filter (`stripHostNoise`) stops host paths from entering a migrated
 * session from now on. It cannot un-write what is already stored. A memory whose
 * text names the machine it was learned on — `C:\Users\<user>\AppData\...`,
 * `/home/...`, `/tmp/...` — will be injected verbatim into a future prompt, and
 * the reader will treat the profile directory as part of its workspace.
 *
 * READ-ONLY BY CONSTRUCTION
 *
 * The script opens files for reading and writes nothing except the optional
 * report (`--out`). It does not delete, rewrite or quarantine anything: a
 * security audit that "fixes" what it finds is an audit nobody can trust twice.
 * Removing a hit is a separate, explicit decision by the operator.
 *
 * Usage:
 *   node scripts/audit-memory-noise.mjs                       # scan the profile store
 *   node scripts/audit-memory-noise.mjs --memory <dir>
 *   node scripts/audit-memory-noise.mjs --out report.md       # + a markdown report
 *   node scripts/audit-memory-noise.mjs --include-skills      # also SKILL.md bodies
 *   node scripts/audit-memory-noise.mjs --json
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const has = (name) => args.includes(name)
const asJson = has('--json')
const includeSkills = has('--include-skills')

const profileDir = process.env.DSH_PROFILE_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', process.env.DSH_PROFILE ?? 'desktop')
const memoryDir = flag('--memory', join(profileDir, 'data', 'dsh-memory'))
const skillsDir = flag('--skills', join(homedir(), '.agents', 'skills'))
const outFile = flag('--out', '')

/** Host-owned locations, matched as PATHS rather than bare words. */
const NOISE = [
  { label: 'windows-user-profile', pattern: /[A-Za-z]:\\+Users\\+[^\s"',;)]*/iu },
  { label: 'appdata', pattern: /AppData\\+[^\s"',;)]*/iu },
  { label: 'posix-home', pattern: /\/home\/[^\s"',;)]*/iu },
  { label: 'posix-tmp', pattern: /\/tmp\/[^\s"',;)]*/iu },
  { label: 'env-root', pattern: /%(?:APPDATA|LOCALAPPDATA|USERPROFILE)%|\$env:(?:APPDATA|LOCALAPPDATA|USERPROFILE)\b/iu },
  { label: 'windows-dir', pattern: /[A-Za-z]:\\+Windows\\+[^\s"',;)]*/iu },
]

function hitsIn(text) {
  const found = []
  for (const { label, pattern } of NOISE) {
    const match = pattern.exec(text)
    if (match !== null) found.push({ label, sample: match[0].slice(0, 120) })
  }
  return found
}

/** A one-line digest that never repeats the whole host path back. */
function digest(text, limit = 140) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

const report = {
  at: new Date().toISOString(),
  memoryDir,
  skillsDir,
  scanned: { facts: 0, negatives: 0, skills: 0 },
  findings: [],
}

function scanJsonl(file, kind) {
  const path = join(memoryDir, file)
  if (!existsSync(path)) return
  const lines = readFileSync(path, 'utf8').split(/\r?\n/u).filter((line) => line.trim().length > 0)
  lines.forEach((line, index) => {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      return
    }
    report.scanned[kind] += 1
    const text = kind === 'negatives'
      ? `${record.symptom ?? ''} | ${record.cause ?? ''} | ${record.avoid ?? ''}`
      : String(record.text ?? '')
    const hits = hitsIn(`${text} ${record.workspace ?? ''}`)
    if (hits.length === 0) return
    report.findings.push({
      kind,
      id: `${kind}-${index}`,
      line: index + 1,
      domain: String(record.domain ?? 'general'),
      workspace: String(record.workspace ?? ''),
      labels: hits.map((hit) => hit.label),
      sample: hits[0].sample,
      digest: digest(text),
      removeWith: 'manual JSONL edit (memory_forget handles SKILL.md only)',
    })
  })
}

scanJsonl('facts.jsonl', 'facts')
scanJsonl('negatives.jsonl', 'negatives')

if (includeSkills) {
  let names = []
  try {
    names = readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    names = []
  }
  for (const name of names) {
    const path = join(skillsDir, name, 'SKILL.md')
    if (!existsSync(path)) continue
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    report.scanned.skills += 1
    const hits = hitsIn(text)
    if (hits.length === 0) continue
    report.findings.push({
      kind: 'skill',
      id: name,
      domain: (text.match(/^domain:\s*(.+)$/mu)?.[1] ?? 'general').trim(),
      workspace: (text.match(/^workspace:\s*(.+)$/mu)?.[1] ?? '').trim(),
      labels: hits.map((hit) => hit.label),
      sample: hits[0].sample,
      digest: digest(text.replace(/^---[\s\S]*?---/u, '').replace(/^#.*$/mu, '')),
      removeWith: `memory_forget { name: "${name}" }`,
    })
  }
}

report.total = report.findings.length

if (outFile.length > 0) {
  const lines = [
    '# 记忆库宿主噪音审计（只读）',
    '',
    `- 时间：${report.at}`,
    `- 记忆目录：\`${memoryDir}\``,
    `- 扫描：facts ${report.scanned.facts} 条、negatives ${report.scanned.negatives} 条${includeSkills ? `、skills ${report.scanned.skills} 条` : ''}`,
    `- **命中：${report.total} 条**`,
    '',
    '> 本报告由 `scripts/audit-memory-noise.mjs` 生成，**只读**：脚本不删除、不改写、不隔离任何记录。',
    '> 处置需你确认后单独执行。',
    '',
  ]
  if (report.total === 0) {
    lines.push('未发现包含宿主路径（`C:\\Users\\…` / `AppData` / `/home/` / `/tmp/` 等）的记忆。', '')
  } else {
    lines.push('| kind | id | domain | workspace | 命中类型 | 内容摘要 |', '|---|---|---|---|---|---|')
    for (const finding of report.findings) {
      lines.push(
        `| ${finding.kind} | \`${finding.id}\` | ${finding.domain} | ${finding.workspace || '(空)'} | ${finding.labels.join(', ')} | ${finding.digest.replace(/\|/gu, '\\|')} |`,
      )
    }
    lines.push('', '## 处置建议', '')
    lines.push('- 先逐条确认：这些路径是否是“学到的东西”的一部分，还是当时环境留下的噪音。')
    lines.push('- 技能：`memory_forget { name }` 可删除（会在审计里留痕：它是显式操作）。')
    lines.push('- facts / negatives：`memory_forget` 只覆盖 SKILL.md；这两层目前需要手工编辑 JSONL，或者由我加一个专用工具。', '')
  }
  writeFileSync(outFile, lines.join('\n'), 'utf8')
}

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} else {
  process.stdout.write(
    [
      `memory dir : ${memoryDir}`,
      `scanned    : facts ${report.scanned.facts}, negatives ${report.scanned.negatives}${includeSkills ? `, skills ${report.scanned.skills}` : ''}`,
      `findings   : ${report.total}`,
      ...report.findings.map((finding) => `  - [${finding.kind}] ${finding.id} (${finding.labels.join(',')}) :: ${finding.digest.slice(0, 80)}`),
      outFile.length > 0 ? `report     : ${outFile}` : '',
      '',
    ].filter((line) => line.length > 0).join('\n'),
  )
}
