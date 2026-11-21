/**
 * ── v286 (B4-0b-2 W5-6): A CAP THAT DROPS THINGS MUST SAY SO ────────────────────────────────────
 *
 * Two caps in the knowledge writer used to truncate in silence:
 *
 *   `normalizeVocabList(..., max = 8)`   `if (out.length >= max) break`   → stopped counting
 *   merge of two entries' vocabularies   `.slice(0, 12)`                 → stopped counting
 *
 * A silently short list has a property that makes it worse than a wrong one: **it is
 * indistinguishable from a complete list.** The stored row for an entry that wanted 12 tags and kept
 * 8 is byte-identical to the row of an entry that only ever had 8. And because the loop `break`ed,
 * the number that would have told them apart was never computed.
 *
 * 判据：
 *   ① 12 个合法标签 ⇒ 存 8 个、`truncatedTags` 里有一行点名那 4 个；
 *   ② 10 个合法 node type ⇒ 同上，且行首写的是 `applicable_node_types:`（不是 `tags:`）；
 *   ③ 合并（8 + 8 = 16 > 12）⇒ 存 12 个、`truncatedTags` 点名被丢的 4 个，并写明合并进了哪个 id；
 *   ④ 对照：3 个标签 ⇒ `truncatedTags` 为空数组（这个字段不是「永远有话说」）；
 *   ⑤ **可区分**：一个畸形标签 + 一个超配额标签 ⇒ 畸形进 `droppedTags`、超配额进 `truncatedTags`，
 *      两个数组各自只说自己的事实。
 *
 * can-red：把 `overCap?.push(tag)` 那一行删掉（回到「到上限就静默」）⇒ ①②③ 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeVocabList, readKnowledge, writeKnowledge } from '../lib/knowledge.js'

const WORKSPACE = 'D:/持久层能力架构'
const TAGS_12 = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu']

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-mem-v286-'))
}

function baseEntry(overrides = {}) {
  return {
    id: 'cap-probe',
    kind: 'skill',
    title: 'cap probe',
    when: 'when testing a cap',
    body: 'body',
    ...overrides,
  }
}

test('v286 ①: twelve valid tags ⇒ eight stored, and the four that did not fit are NAMED', () => {
  const dir = freshDir()
  try {
    const result = writeKnowledge(dir, [baseEntry({ tags: TAGS_12 })], { workspace: WORKSPACE })

    assert.equal(result.entries[0].tags.length, 8, 'the cap itself must not change: 8 tags are kept')
    assert.deepEqual(result.droppedTags, [], 'valid tags are not "dropped" — they were over quota')
    assert.equal(result.truncatedTags.length, 1, 'exactly one truncation line is expected')
    const line = result.truncatedTags[0]
    assert.match(line, /^tags: /u, 'the line must say WHICH field was capped')
    assert.match(line, /did NOT keep 4/u, `the line must carry the count, got: ${line}`)
    for (const lost of ['iota', 'kappa', 'lambda', 'mu']) {
      assert.ok(line.includes(lost), `the line must name ${lost}, got: ${line}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v286 ②: the node-type cap reports under its own field name, not under `tags:`', () => {
  const dir = freshDir()
  try {
    const result = writeKnowledge(dir, [baseEntry({ applicableNodeTypes: TAGS_12 })], { workspace: WORKSPACE })

    assert.equal(result.entries[0].applicableNodeTypes.length, 8)
    assert.equal(result.truncatedTags.length, 1)
    assert.match(result.truncatedTags[0], /^applicable_node_types: /u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v286 ③: a MERGE that exceeds 12 reports the excess and names the id it merged into', () => {
  const dir = freshDir()
  try {
    const first = TAGS_12.slice(0, 8)
    const second = TAGS_12.slice(8, 12).concat(['nu', 'xi', 'omicron', 'pi'])
    // Two writes of the same id: the second unions into the first.
    writeKnowledge(dir, [baseEntry({ tags: first })], { workspace: WORKSPACE })
    const result = writeKnowledge(dir, [baseEntry({ tags: second })], { workspace: WORKSPACE })

    assert.equal(result.merged, 1, 'the second write must MERGE, not duplicate')
    assert.equal(result.entries[0].tags.length, 12, 'the merge cap (12) must not change')
    const mergeLine = result.truncatedTags.find((line) => line.includes('(merge into cap-probe)'))
    assert.ok(mergeLine !== undefined, `no merge truncation was reported: ${JSON.stringify(result.truncatedTags)}`)
    assert.match(mergeLine, /kept 12, did NOT keep 4/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v286 ④: three tags ⇒ NOTHING reported (the field is not "always says something")', () => {
  const dir = freshDir()
  try {
    const result = writeKnowledge(dir, [baseEntry({ tags: ['alpha', 'beta', 'gamma'] })], { workspace: WORKSPACE })
    assert.deepEqual(result.truncatedTags, [], 'an under-cap write must report no truncation at all')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v286 ⑤: malformed and over-quota are DIFFERENT lists (one is a refusal, one is a quota)', () => {
  const dir = freshDir()
  try {
    // `BAD TAG` normalises to `bad-tag` (valid!) so use a genuinely invalid one: leading dash.
    const malformed = '-leading-dash'
    const result = writeKnowledge(dir, [baseEntry({ tags: [malformed, ...TAGS_12] })], { workspace: WORKSPACE })

    assert.equal(result.droppedTags.length, 1, 'the malformed tag must be refused and reported')
    assert.match(result.droppedTags[0], /^tags: /u)
    assert.equal(result.truncatedTags.length, 1, 'the over-quota tags must be reported in the OTHER list')
    assert.match(result.truncatedTags[0], /did NOT keep 4/u)
    /**
     * The malformed tag must not appear in the truncation line and vice versa — otherwise the two
     * arrays are two spellings of one fact, which is the defect this batch keeps finding.
     */
    assert.ok(!result.truncatedTags[0].includes('leading-dash'), 'a malformed tag is not a quota case')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v286 ⑥: `normalizeVocabList` itself keeps exactly `max` and reports the rest', () => {
  const overCap = []
  const kept = normalizeVocabList(TAGS_12, 3, undefined, overCap)
  assert.deepEqual(kept, ['alpha', 'beta', 'gamma'])
  assert.deepEqual(overCap, TAGS_12.slice(3), 'the over-cap list must be the real remainder, in order')
})

test('v286 ⑦: the READ path re-reads all 12 stored tags — a write-time cap is not a read-time cap', () => {
  const dir = freshDir()
  try {
    const first = TAGS_12.slice(0, 8)
    const second = TAGS_12.slice(8, 12).concat(['nu', 'xi', 'omicron', 'pi'])
    writeKnowledge(dir, [baseEntry({ tags: first })], { workspace: WORKSPACE })
    writeKnowledge(dir, [baseEntry({ tags: second })], { workspace: WORKSPACE })

    /**
     * `writeKnowledge` returns the in-memory row, so it cannot see this defect. Only a fresh read of
     * the FILE can — and that is the path `queryKnowledge` actually uses.
     */
    const reread = readKnowledge(dir).find((entry) => entry.id === 'cap-probe')
    assert.ok(reread !== undefined, 'the entry must be on disk')
    assert.equal(
      reread.tags.length,
      12,
      'reading re-applied the write-time cap of 8: the 12 tags this writer STORED came back as 8, silently',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})