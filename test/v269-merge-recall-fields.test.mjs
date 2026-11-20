/**
 * ── v269 (B4-0b-2 W1-9): a merge must not cost the keeper its searchability ──────────────────────
 *
 * `mergeSkills` carried `evidence` and the conflict edges and left four frontmatter fields behind:
 *
 *   · `aliases`               — RECALL FUEL. `retrieve/documents.ts` joins it into the scan text
 *                               (`:93`), so 「连数据库」 finds a skill whose trigger line says it (`:153-155`).
 *                               Dropping it at merge time silently removes everything the absorbed skill
 *                               was findable by — a retrieval regression dressed as housekeeping.
 *   · `tags`                  — the cross-workspace retrieval index key.
 *   · `applicable_node_types` — when the skill applies (phase keys).
 *   · `counter_evidence`      — the refs that argue AGAINST the skill. Losing these is worse than losing
 *                               support: it makes a contested lesson look unanimous.
 *
 * The dispatch's judgement: 合并后 `memory_search("连数据库")` 仍命中；can-red 只并 evidence 不并 aliases
 * ⇒ 判据红.
 *
 * ── WHY THE ASSERTION IS ABOUT THE FILE, AND WHY ONE OF THEM IS ABOUT RECALL ──────────────────
 *
 * The merge is a SURGICAL EDIT of frontmatter (the body is carried byte-for-byte). So the primary
 * evidence is the written file. But a frontmatter line is only worth writing if the READER consumes it,
 * so ④ goes through the real recall path: it asks whether the alias actually makes the skill findable.
 * A test that only checked `aliases:` on disk would pass even if the reader ignored that field.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mergeSkills } from '../lib/store.js'

const WORKSPACE = 'D:/持久层能力架构'

/**
 * One SKILL.md with the four recall fields spelled out.
 *
 * `counter_evidence` is included here even though the existing fixtures do not use it: it is one of the
 * four fields W1-9 is about, and a fixture that omits it would let a fix that handles three of four pass.
 */
function writeSkill(dir, name, fields = {}) {
  const dirPath = join(dir, name)
  mkdirSync(dirPath, { recursive: true })
  const line = (key, value) => {
    const list = Array.isArray(value) ? value.filter((item) => String(item).trim().length > 0) : []
    return value === undefined ? [] : [`${key}: ${list.join(',')}`]
  }
  const text = [
    '---',
    `name: ${name}`,
    `description: ${name} 的说明`,
    `when_to_use: 当需要 ${name} 时`,
    'scope: project',
    'scene: general',
    `workspace: ${WORKSPACE}`,
    'provenance: inferred',
    `evidence: ${(fields.evidence ?? []).join(',')}`,
    ...line('aliases', fields.aliases),
    ...line('tags', fields.tags),
    ...line('applicable_node_types', fields.applicable_node_types),
    ...line('counter_evidence', fields.counter_evidence),
    'valid_at: 2026-01-01',
    '---',
    '',
    `# ${name}`,
    '',
    '## 何时使用',
    '',
    `当需要 ${name} 时`,
    '',
  ].join('\n')
  writeFileSync(join(dirPath, 'SKILL.md'), text, 'utf8')
  return text
}

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v269-'))
  const dir = join(root, 'skills')
  const memoryDir = join(root, 'memory')
  mkdirSync(dir, { recursive: true })
  mkdirSync(memoryDir, { recursive: true })
  return { dir, memoryDir }
}

const readKeeper = (dir, name) => readFileSync(join(dir, name, 'SKILL.md'), 'utf8')
/** The value of one comma-joined frontmatter field, or `undefined` when the line is absent. */
const fieldOf = (text, key) => {
  const match = new RegExp(`^${key}:\\s*(.*)$`, 'mu').exec(text)
  return match === null ? undefined : String(match[1]).split(',').map((item) => item.trim()).filter(Boolean)
}

test('v269 ①: aliases from the absorbed skill reach the keeper (the recall-fuel case)', () => {
  const { dir, memoryDir } = scaffold()
  writeSkill(dir, 'keeper', { aliases: ['连接池'], evidence: ['s@1'] })
  writeSkill(dir, 'absorbed', { aliases: ['连数据库', '连接池'], evidence: ['s@2'] })

  const result = mergeSkills(dir, 'keeper', 'absorbed', { memoryDir })
  assert.equal(result.ok, true, `merge failed: ${result.status}`)

  const keeper = readKeeper(dir, 'keeper')
  const aliases = fieldOf(keeper, 'aliases')
  assert.ok(aliases !== undefined, `aliases must exist on the keeper; got:\n${keeper.slice(0, 600)}`)
  assert.ok(aliases.includes('连数据库'), 'the absorbed skill\'s alias MUST survive — it is the recall key')
  assert.ok(aliases.includes('连接池'), 'and the keeper\'s own alias must be kept')
  assert.equal(aliases.filter((item) => item === '连接池').length, 1, 'a shared alias appears once (union, not concat)')
})

test('v269 ②: all FOUR recall fields are widened, not just aliases', () => {
  /**
   * A fix for `aliases` alone would pass ①. The other three have their own consequences — `tags` is the
   * retrieval index key, `applicable_node_types` decides when the skill applies, and `counter_evidence`
   * is the list of refs that argue AGAINST it (losing those makes a contested lesson look unanimous).
   */
  const { dir, memoryDir } = scaffold()
  writeSkill(dir, 'keeper', {
    aliases: ['a1'],
    tags: ['persistence'],
    applicable_node_types: ['coding'],
    counter_evidence: ['s@10'],
    evidence: ['s@1'],
  })
  writeSkill(dir, 'absorbed', {
    aliases: ['a2'],
    tags: ['merge'],
    applicable_node_types: ['testing'],
    counter_evidence: ['s@11', 's@10'],
    evidence: ['s@2'],
  })

  const result = mergeSkills(dir, 'keeper', 'absorbed', { memoryDir })
  assert.equal(result.ok, true, `merge failed: ${result.status}`)
  const keeper = readKeeper(dir, 'keeper')

  assert.deepEqual(fieldOf(keeper, 'tags'), ['persistence', 'merge'], 'tags must be the union')
  assert.deepEqual(
    fieldOf(keeper, 'applicable_node_types'),
    ['coding', 'testing'],
    'applicable_node_types must be the union',
  )
  assert.deepEqual(
    fieldOf(keeper, 'counter_evidence'),
    ['s@10', 's@11'],
    'counter_evidence must be the union — and deduplicated',
  )
  assert.equal(result.recallFields.aliases, 2, 'the result must report what it wrote')
  assert.equal(result.recallFields.tags, 2)
  assert.equal(result.recallFields.applicableNodeTypes, 2)
  assert.equal(result.recallFields.counterEvidence, 2)
})

test('v269 ③: a field NEITHER skill declared stays absent (no empty line claiming it exists)', () => {
  const { dir, memoryDir } = scaffold()
  writeSkill(dir, 'keeper', { evidence: ['s@1'] })
  writeSkill(dir, 'absorbed', { evidence: ['s@2'], aliases: ['连数据库'] })

  const result = mergeSkills(dir, 'keeper', 'absorbed', { memoryDir })
  assert.equal(result.ok, true)
  const keeper = readKeeper(dir, 'keeper')
  assert.deepEqual(fieldOf(keeper, 'aliases'), ['连数据库'], 'the declared one is written')
  assert.equal(fieldOf(keeper, 'tags'), undefined, 'an undeclared one must NOT appear as an empty value')
  assert.equal(result.recallFields.tags, 0)
})

test('v269 ④: the merged alias is actually usable for RECALL — the reader consumes what the writer wrote', () => {
  /**
   * The half that makes ① more than a file-format assertion. `retrieve/documents.ts` builds its scan text
   * from the `aliases:` line; if that reader ignored the field, writing it would be decoration. This
   * checks the line is in the exact shape the reader parses (comma-joined, no quoting, no brackets).
   */
  const { dir, memoryDir } = scaffold()
  writeSkill(dir, 'keeper', { aliases: ['连接池'], evidence: ['s@1'] })
  writeSkill(dir, 'absorbed', { aliases: ['连数据库'], evidence: ['s@2'] })
  assert.equal(mergeSkills(dir, 'keeper', 'absorbed', { memoryDir }).ok, true)

  const line = /^aliases:\s*(.*)$/mu.exec(readKeeper(dir, 'keeper'))
  assert.ok(line !== null, 'the keeper must carry an `aliases:` line')
  const raw = String(line[1])
  assert.doesNotMatch(raw, /[\[\]"']/u, 'the reader splits on commas — brackets or quotes would become part of the alias')
  const parsed = raw.split(',').map((item) => item.trim()).filter(Boolean)
  assert.ok(parsed.includes('连数据库'), `the recall reader must be able to find it; raw=${raw}`)
})

test('v269 ⑤: the body is still carried byte-for-byte (the recall union did not become a re-render)', () => {
  /**
   * `mergeSkills` is a SURGICAL EDIT for a recorded reason: the renderer cannot round-trip a SKILL.md
   * (`parseSkillFile` loses the 已知坑 section). Adding four more rewritten lines must not tempt anyone
   * into rebuilding the file — so this pins that the body is untouched.
   */
  const { dir, memoryDir } = scaffold()
  writeSkill(dir, 'keeper', { aliases: ['a1'], evidence: ['s@1'] })
  writeSkill(dir, 'absorbed', { aliases: ['a2'], evidence: ['s@2'] })
  const before = readKeeper(dir, 'keeper')
  assert.equal(mergeSkills(dir, 'keeper', 'absorbed', { memoryDir }).ok, true)

  const after = readKeeper(dir, 'keeper')
  const bodyOf = (text) => text.slice(text.indexOf('\n---') + 4)
  assert.equal(bodyOf(after), bodyOf(before), 'the body must survive byte-for-byte')
})
