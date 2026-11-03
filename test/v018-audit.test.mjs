/**
 * v0.17: the memory-noise audit script.
 *
 * A detector that has only ever returned "clean" is indistinguishable from a
 * detector that does not work, so this drives it against a store that is KNOWN to
 * be dirty and asserts it finds exactly the dirty entries. It also asserts the
 * property the operator depends on: the script writes nothing to the store.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/audit-memory-noise.mjs', import.meta.url))

function noisyStore() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-audit-'))
  const memoryDir = join(root, 'memory')
  const skillsDir = join(root, 'skills')
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(
    join(memoryDir, 'facts.jsonl'),
    [
      JSON.stringify({ text: '构建日志写在 C:\\Users\\me\\AppData\\Roaming\\dsh-desktop\\logs 下', workspace: 'D:/项目A', domain: 'project-local' }),
      JSON.stringify({ text: '缓存命中率恢复到基线', workspace: 'D:/项目A', domain: 'project-local' }),
    ].join('\n') + '\n',
    'utf8',
  )
  writeFileSync(
    join(memoryDir, 'negatives.jsonl'),
    [
      JSON.stringify({ symptom: '在 /tmp/dsh-1234 下跑测试导致权限报错', cause: '临时目录被清理', avoid: '改到项目内 run/', workspace: 'D:/项目A', domain: 'project-local' }),
      JSON.stringify({ symptom: '部署脚本必报 SOURCE_DRIFT', cause: '边界判定用错', avoid: '改用 boundarySeq', workspace: 'D:/项目A', domain: 'project-local' }),
    ].join('\n') + '\n',
    'utf8',
  )
  mkdirSync(join(skillsDir, 'clean-skill'), { recursive: true })
  writeFileSync(join(skillsDir, 'clean-skill', 'SKILL.md'), '# clean\n\n没有宿主路径。\n', 'utf8')
  mkdirSync(join(skillsDir, 'noisy-skill'), { recursive: true })
  writeFileSync(
    join(skillsDir, 'noisy-skill', 'SKILL.md'),
    ['---', 'name: noisy-skill', 'domain: dsh-host', 'workspace: D:/项目A', '---', '', '# noisy', '', '证据来自 /home/me/.cache/pip 的日志。'].join('\n'),
    'utf8',
  )
  return { root, memoryDir, skillsDir }
}

test('v0.17 audit: every finding is listed, with its kind and id, and nothing is modified', () => {
  const { memoryDir, skillsDir } = noisyStore()
  const before = {
    facts: readFileSync(join(memoryDir, 'facts.jsonl'), 'utf8'),
    negatives: readFileSync(join(memoryDir, 'negatives.jsonl'), 'utf8'),
  }
  const output = execFileSync(
    process.execPath,
    [SCRIPT, '--memory', memoryDir, '--skills', skillsDir, '--include-skills', '--json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const report = JSON.parse(output)
  assert.equal(report.scanned.facts, 2)
  assert.equal(report.scanned.negatives, 2)
  assert.equal(report.scanned.skills, 2, 'the skill bodies are scanned when asked')
  assert.equal(report.total, 3, 'two JSONL rows and one skill carry host noise')
  const ids = report.findings.map((finding) => `${finding.kind}:${finding.id}`).sort()
  assert.deepEqual(ids, ['facts:facts-0', 'negatives:negatives-0', 'skill:noisy-skill'])
  const labels = report.findings.flatMap((finding) => finding.labels)
  assert.ok(labels.includes('windows-user-profile'))
  assert.ok(labels.includes('appdata'))
  assert.ok(labels.includes('posix-tmp'))
  assert.ok(labels.includes('posix-home'))
  assert.match(report.findings.find((finding) => finding.kind === 'skill').removeWith, /memory_forget/u)

  // The property an operator relies on: an audit does not touch the store.
  assert.equal(readFileSync(join(memoryDir, 'facts.jsonl'), 'utf8'), before.facts)
  assert.equal(readFileSync(join(memoryDir, 'negatives.jsonl'), 'utf8'), before.negatives)
})

test('v0.17 audit: a clean store reports zero, and the markdown report says so', () => {
  const { root } = noisyStore()
  const cleanMemory = join(root, 'clean-memory')
  mkdirSync(cleanMemory, { recursive: true })
  writeFileSync(join(cleanMemory, 'facts.jsonl'), `${JSON.stringify({ text: '缓存命中率恢复到基线', workspace: 'D:/项目A' })}\n`, 'utf8')
  const out = join(root, 'report.md')
  const output = execFileSync(process.execPath, [SCRIPT, '--memory', cleanMemory, '--out', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.match(output, /findings   : 0/u)
  const markdown = readFileSync(out, 'utf8')
  assert.match(markdown, /命中：0 条/u)
  assert.match(markdown, /只读/u, 'the report states its own read-only contract')
})

test('v0.17 audit: bare mentions of the word are not findings (only PATHS are)', () => {
  const { root } = noisyStore()
  const memoryDir = join(root, 'word-memory')
  mkdirSync(memoryDir, { recursive: true })
  // The workspace red line itself legitimately contains the word "AppData".
  writeFileSync(
    join(memoryDir, 'facts.jsonl'),
    `${JSON.stringify({ text: '红线要求：禁止针对 C 盘、AppData 或全局根目录的搜索', workspace: 'D:/项目A' })}\n`,
    'utf8',
  )
  const output = execFileSync(process.execPath, [SCRIPT, '--memory', memoryDir, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(JSON.parse(output).total, 0, 'the guard text is not host noise, and flagging it would train the operator to ignore the report')
})
