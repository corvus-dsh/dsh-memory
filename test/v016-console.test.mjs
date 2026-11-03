/**
 * v0.15 UI host API: the catalogue the console lists, and the "clear this
 * workspace" action behind its button.
 *
 * The action must be a MOVE, never a delete: a debugging button that erases data
 * is clicked once, loses weeks of learned rules, and the console is never trusted
 * again. The tests below therefore assert both what moved and what stayed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listSkillRecords, quarantineWorkspaceMemory, skillPath } from '../lib/store.js'
import { retrieve } from '../lib/retrieve.js'

const A = 'D:/项目A'
const B = 'D:/项目B'

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-console-'))
  return { root, skills: join(root, 'skills'), memory: join(root, 'memory') }
}

function plant(skillsDir, name, fields, body = '') {
  mkdirSync(join(skillsDir, name), { recursive: true })
  writeFileSync(
    skillPath(skillsDir, name),
    ['---', `name: ${name}`, ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', '', `# ${name}`, body].join('\n'),
    'utf8',
  )
}

test('v0.15 console: the catalogue carries what a human needs to judge a row', () => {
  const { skills } = dirs()
  plant(skills, 'alpha', {
    description: 'd', when_to_use: 'w', scope: 'project', scene: 'testing',
    workspace: A, provenance: 'tool', valid_at: '2026-11-01T00:00:00.000Z',
    invalid_at: '2026-11-02T00:00:00.000Z', superseded_by: 'beta', evidence: 's@1,s@2',
  })
  plant(skills, 'beta', { description: 'd', when_to_use: 'w', scope: 'global', scene: 'database', workspace: B, provenance: 'human', valid_at: '2026-11-03T00:00:00.000Z' })
  mkdirSync(join(skills, 'not-a-skill'), { recursive: true })

  const rows = listSkillRecords(skills)
  assert.deepEqual(rows.map((row) => row.name), ['alpha', 'beta'], 'sorted, and a directory without SKILL.md is not a skill')
  const alpha = rows[0]
  assert.equal(alpha.scene, 'testing')
  assert.equal(alpha.provenance, 'tool')
  assert.equal(alpha.workspace, A)
  assert.equal(alpha.invalidAt, '2026-11-02T00:00:00.000Z')
  assert.equal(alpha.supersededBy, 'beta')
  assert.equal(alpha.evidence, 2)
  assert.equal(rows[1].provenance, 'human')
  assert.equal(rows[1].invalidAt, '')
})

test('v0.15 console: clearing a workspace MOVES its skills aside and keeps everything else', () => {
  const { skills, memory } = dirs()
  plant(skills, 'mine', { when_to_use: '连接数据库查询', scope: 'project', workspace: A, provenance: 'tool' })
  plant(skills, 'theirs', { when_to_use: '连接数据库查询', scope: 'project', workspace: B, provenance: 'tool' })
  plant(skills, 'shared', { when_to_use: '连接数据库查询', scope: 'global', workspace: A, provenance: 'human' })
  plant(skills, 'legacy', { when_to_use: '连接数据库查询', scope: 'project', provenance: 'inferred' })
  mkdirSync(memory, { recursive: true })
  writeFileSync(
    join(memory, 'negatives.jsonl'),
    [
      JSON.stringify({ symptom: 'mine', workspace: A, scope: 'project' }),
      JSON.stringify({ symptom: 'theirs', workspace: B, scope: 'project' }),
      JSON.stringify({ symptom: 'shared', workspace: A, scope: 'global' }),
    ].join('\n') + '\n',
    'utf8',
  )

  const result = quarantineWorkspaceMemory(memory, skills, A)
  assert.deepEqual(result.skills, ['mine'], 'only the record from THIS workspace moves')
  assert.equal(result.negatives, 1)
  assert.equal(result.kept, 3)
  assert.equal(existsSync(skillPath(skills, 'mine')), false)
  assert.equal(existsSync(join(result.quarantineDir, 'skills', 'mine', 'SKILL.md')), true, 'the file still exists, in quarantine')
  assert.equal(existsSync(skillPath(skills, 'theirs')), true)
  assert.equal(existsSync(skillPath(skills, 'shared')), true, 'a global record is never touched')
  assert.equal(existsSync(skillPath(skills, 'legacy')), true, 'an unscoped record is not "from this workspace" unless asked')

  const manifest = JSON.parse(readFileSync(join(result.quarantineDir, 'MANIFEST.json'), 'utf8'))
  assert.deepEqual(manifest.skills, ['mine'])
  assert.equal(manifest.negatives, 1)
  const remaining = readFileSync(join(memory, 'negatives.jsonl'), 'utf8')
  assert.doesNotMatch(remaining, /"symptom":"mine"/u)
  assert.match(remaining, /"symptom":"shared"/u)

  // End to end: the cleared skill is gone from retrieval, the foreign one still answers.
  const after = retrieve(memory, skills, '连接数据库查询', { threshold: 0, workspace: A })
  assert.equal(after.skill?.id, 'shared', 'only the global record is left for this workspace')
})

test('v0.15 console: unscoped records are cleared only when explicitly asked', () => {
  const { skills, memory } = dirs()
  plant(skills, 'legacy', { when_to_use: 'w', scope: 'project', provenance: 'inferred' })
  const kept = quarantineWorkspaceMemory(memory, skills, A)
  assert.deepEqual(kept.skills, [])
  assert.equal(existsSync(skillPath(skills, 'legacy')), true)

  const swept = quarantineWorkspaceMemory(memory, skills, A, { includeUnscoped: true })
  assert.deepEqual(swept.skills, ['legacy'], 'the debug sweep can take legacy rows too')
  assert.equal(existsSync(skillPath(skills, 'legacy')), false)
})

test('v0.15 console: clearing an empty workspace is a no-op, not an empty quarantine', () => {
  const { skills, memory } = dirs()
  plant(skills, 'other', { when_to_use: 'w', scope: 'project', workspace: B })
  const result = quarantineWorkspaceMemory(memory, skills, A)
  assert.deepEqual(result.skills, [])
  assert.equal(result.negatives, 0)
  assert.equal(existsSync(result.quarantineDir), false, 'nothing moved = no directory left behind')
})
