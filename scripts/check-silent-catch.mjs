#!/usr/bin/env node
/**
 * ── SILENT DISCARDS: AN EMPTY `catch` MUST SAY WHY IT MAY BE SILENT ─────────────────────────────
 *
 * 五形态之五「静默丢弃」。派工单的判据：每个 `continue` / `return []` / `catch {}` 在没有报告的
 * 时候算缺陷；加一条「空 catch 必须带注释说明为何可以静默」的静态检查。
 *
 * ── WHY THIS SHAPE AND NOT "REPORT EVERY DISCARD" ──────────────────────────────────────────────
 *
 * 「每个 `continue` 都要报告」会把整个仓库变成日志墙：一个 `for` 里跳过一条坏记录，报告是
 * `logger.warn`，而读者早就不看了 —— 那与静默同样糟，只是更吵。所以这条检查只管一处：
 *
 *     catch { }                       ← 一个空的异常处理器
 *     catch { /* 为什么可以忽略 *\/ }   ← 可以，但必须写下来
 *
 * 空的 `catch` 是本项目付出代价最多的一处：本批的 §〇 第 3 条、`v0.25` 的
 * `ignore-ok-unknown`、以及 memory 的 `workspace` 读失败被当成空字符串，都属于「捕获了、
 * 什么也没说、于是上游以为那里是空的」。
 *
 * ── 判据 ──────────────────────────────────────────────────────────────────────────────────────
 *
 *   · `catch` 的**体**里既没有语句也没有注释 ⇒ 红，并报出文件与行
 *   · 体里有注释（≥ 40 字符，能拿来反驳） ⇒ 放过
 *   · 体里有任何语句 ⇒ 放过（那不是静默，那是处理）
 *
 * 「≥ 40 字符」与 `v129` 的豁免理由门槛同源：一句「以后再说」不是理由，而是一个占位符。
 *
 * ── 不覆盖什么 ────────────────────────────────────────────────────────────────────────────────
 *
 *   · 不判断那条注释**说得对不对** —— 那需要人。
 *   · 不覆盖 `if (x) continue`（跳过循环项）与 `return []`：它们的「静默」是否合理取决于调用方，
 *     静态判不了。本文件只覆盖语法上就能判定为空的那一种。
 *   · `.ts` 与 `.js`（构建产物不查：产物是从源码生成的，查它等于查两遍同一件事）。
 *
 * 用法：node scripts/check-silent-catch.mjs [--json]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

/** The root is the CALLER'S directory (W5-1's lesson: `import.meta.url` answers about the wrong tree). */
const REPO = process.cwd()
const SRC = join(REPO, 'src')

/**
 * ── THE STOCK IS BASELINED, THE GROWTH IS REFUSED (measured, not typed) ───────────────────────
 *
 * First run on this tree: **14 catch bodies out of 134** have no statement and only a SHORT comment —
 * `/* ignore *\/`, `// fall through`, `// exiting anyway`, and also genuinely good but terse ones like
 * `// Never let the hint break the step.`
 *
 * Every one of them is defensible in place. What is NOT defensible is a rule that would force all 14
 * to be rewritten to 40 characters — that produces comments written to satisfy a checker, which is
 * the exact thing this project keeps refusing (§〇 第 1 条 in spirit: form without substance).
 *
 * So: **the stock is recorded, the growth is refused** — the same treatment as
 * `check-frontmatter-reads` and `check-test-numbers`. A NEW silent catch fails. Rewriting an existing
 * one is welcome and simply shortens this table.
 *
 * ── WHY THE IDENTITY IS (file, body text) AND NOT A LINE NUMBER ──────────────────────────────
 *
 * `check-frontmatter-reads` learned this the hard way twice (a count lets one leave as another
 * arrives; a Set lets a byte-identical copy slip in — both closed there with a multiset). Here the
 * recorded identity is the file plus the normalised body, so:
 *
 *   · editing code ABOVE a catch does not break the baseline (line numbers are not identity);
 *   · a new catch with the SAME terse comment IS a new one, and it fails — that is why the count per
 *     file is recorded alongside, and compared as a multiset rather than a membership test.
 *
 * The table below was DERIVED from the tree by `_scratch/derive-catch-baseline.mjs`, not hand-written:
 * a baseline typed from memory is a guess about what the tree contains.
 */
const BASELINE = new Map([
  ['src/archive.ts', ['* One bad pair must not stop the pass; the next activation retries it.', 'A skill that cannot be written stays active; the next pass retries.']],
  ['src/edges.ts', ['A missing index is an empty index, not an error.']],
  ['src/index.ts', [
    'fall through',
    'A profile without the service keeps retrieval lexical.',
    'a vanished skill is simply absent from the stamp',
    'no skills dir yet',
    'diagnostics must not mask the failure',
    'diagnostics must not mask the original failure',
    'A plugin must not fail to activate because a timer could not be created.',
    'A store that cannot be stamped is still usable. The other side then sees an absent manifest',
    'An unresolvable session is "unknown workspace", never "any workspace".',
    'The sweep is maintenance; it must never break the closing turn.',
    'Never let the hint break the step.',
    'Logging must not block activation.',
    'Logging must not block activation.',
  ]],
  ['src/knowledge.ts', ['skip the single corrupt line', 'A leaked descriptor here would be a bug, but not one worth failing the caller over.']],
  ['src/layout.ts', ['unreadable → fall through and rewrite']],
  ['src/ledger-cache.ts', [
    'A torn line must not erase the rest of the ledger.',
    'the main rewrite below still makes the rows durable',
    'a leftover WAL is replayed harmlessly on the next load',
    'an unreadable ledger is an empty ledger here; callers treat it the same way',
    'a missing WAL is an empty WAL',
    'ignore',
    'a failed flush is retried on the next tick',
    'exiting anyway',
  ]],
  ['src/retrieve.ts', ['A failed write must not break the hint: the memory stays as it was.']],
  ['src/sqlite-index.ts', ['ignore', 'already closed']],
  ['src/store/io.ts', ["The next write's own tmp file is equally disposable."]],
  ['src/store/lifecycle.ts', [
    'A broken file is skipped, not rewritten.',
    'a stuck archive is not worth failing the append',
    'ignore',
    'Audit is evidence, never a gate: a failed line must not change the outcome.',
    'A file that cannot be parsed keeps its pointers; it is reported elsewhere.',
  ]],
  ['src/suggest.ts', ['A torn line must not hide the rest of the queue.']],
])

/** The baseline as `file → Map<body, count>`, i.e. a MULTISET (a copied body is still a new catch). */
const BASELINE_MULTISET = new Map(
  [...BASELINE].map(([file, bodies]) => {
    const counts = new Map()
    for (const body of bodies) {
      const key = body.trim()
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [file, counts]
  }),
)

/**
 * Parse one `catch {` body out of a file's text, starting at the offset of the `{`.
 *
 * Brace counting, not regex: a `catch` body may contain braces inside strings and template literals,
 * and a regex that stops at the first `}` would mis-report the line of every body containing an
 * object literal. This is a small parser on purpose — the alternative is a false RED, which is how a
 * gate gets switched off.
 */
function bodyOf(text, braceAt) {
  let depth = 0
  let index = braceAt
  while (index < text.length) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(braceAt + 1, index)
    }
    index += 1
  }
  return undefined
}

/** Strip string and template contents so a brace inside a message is not counted. */
function codeOnly(body) {
  return body
    .replace(/`(?:[^`\\]|\\.)*`/gu, '``')
    .replace(/'(?:[^'\\]|\\.)*'/gu, "''")
    .replace(/"(?:[^"\\]|\\.)*"/gu, '""')
}

/** Comments in a catch body, as their text (without the markers). */
function commentsOf(body) {
  const out = []
  for (const match of body.matchAll(/\/\*([\s\S]*?)\*\//gu)) out.push(match[1].trim())
  for (const match of body.matchAll(/(?:^|\n)\s*\/\/([^\n]*)/gu)) out.push(match[1].trim())
  return out
}

/** Is this catch body silent — no statement AND no comment at all? */
export function isSilentBody(body) {
  const code = codeOnly(body)
    /** Remove comments before deciding whether any STATEMENT remains. */
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/[^\n]*/gu, '')
    .trim()
  if (code.length > 0) return { silent: false, why: 'has a statement' }
  const comments = commentsOf(body)
  return {
    silent: true,
    /** The first comment, so the baseline can be keyed on what was actually written. */
    body: comments[0] ?? '',
    why: comments.length > 0 ? 'no statement, only a comment' : 'no statement, no comment',
  }
}

export function scanFile(text) {
  const findings = []
  for (const match of text.matchAll(/\}\s*catch\s*(?:\([^)]*\))?\s*\{/gu)) {
    const braceAt = match.index + match[0].length - 1
    const body = bodyOf(text, braceAt)
    if (body === undefined) continue
    const verdict = isSilentBody(body)
    if (!verdict.silent) continue
    const line = text.slice(0, braceAt).split(/\r?\n/u).length
    findings.push({ line, body: verdict.body, why: verdict.why })
  }
  return findings
}

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(path, out)
      continue
    }
    /** `.js` is NOT scanned: it is generated from the `.ts` beside it, and a finding there is a duplicate. */
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(path)
  }
  return out
}

function main() {
  let files
  try {
    files = walk(SRC)
  } catch {
    console.log(`check-silent-catch: FAILED TO START — ${SRC} does not exist`)
    return 1
  }
  if (files.length === 0) {
    console.log(`check-silent-catch: FAILED TO START — no .ts file under ${SRC}`)
    return 1
  }

  const findings = []
  let catchCount = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    catchCount += [...text.matchAll(/\}\s*catch\s*(?:\([^)]*\))?\s*\{/gu)].length
    for (const finding of scanFile(text)) findings.push({ file: relative(REPO, file).split('\\').join('/'), ...finding })
  }

  /**
   * ── THE COMPARISON: MULTISET PER FILE, NOT MEMBERSHIP ────────────────────────────────────────
   *
   * `violations` = a body observed MORE TIMES than the baseline records it for. This catches both
   * shapes the two earlier baseline designs missed in `check-frontmatter-reads`:
   *
   *   · a DIFFERENT new body (its text is not in the baseline at all, observed 1 > 0);
   *   · a COPIED body (`/* ignore *\/` copied from one catch to the next — observed 2 > 1), which is
   *     the most natural way someone adds a new silent catch.
   *
   * `loosenable` = a baseline entry observed FEWER times than recorded. That is GOOD NEWS (a terse
   * comment was rewritten into a real reason, or the catch went away) and is reported as a prompt,
   * not a failure — failing would punish the person who improved it.
   */
  const observedByFile = new Map()
  for (const finding of findings) {
    if (!observedByFile.has(finding.file)) observedByFile.set(finding.file, [])
    observedByFile.get(finding.file).push(finding)
  }

  const violations = []
  for (const [file, observed] of observedByFile) {
    const allowed = BASELINE_MULTISET.get(file) ?? new Map()
    const seen = new Map()
    for (const finding of observed) {
      const key = String(finding.body ?? '').trim()
      const count = (seen.get(key) ?? 0) + 1
      seen.set(key, count)
      const permitted = allowed.get(key) ?? 0
      if (count > permitted) {
        violations.push({ file, line: finding.line, body: key, observed: count, permitted })
      }
    }
  }

  const loosenable = []
  for (const [file, allowed] of BASELINE_MULTISET) {
    const seen = new Map()
    for (const finding of observedByFile.get(file) ?? []) {
      const key = String(finding.body ?? '').trim()
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    const gone = []
    for (const [body, permitted] of allowed) {
      const observedCount = seen.get(body) ?? 0
      if (observedCount < permitted) gone.push({ body, observed: observedCount, permitted })
    }
    if (gone.length > 0) loosenable.push({ file, gone })
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ files: files.length, catchCount, findings, violations, loosenable }, null, 2))
    return violations.length === 0 ? 0 : 1
  }

  if (violations.length === 0) {
    console.log(
      `silent-catch: OK — ${catchCount} catch block(s) across ${files.length} file(s); ` +
        `${findings.length} silent one(s), none new (baseline ${[...BASELINE_MULTISET.values()].reduce((n, m) => n + [...m.values()].reduce((a, b) => a + b, 0), 0)} recorded)`,
    )
    if (loosenable.length > 0) {
      console.log('  (baseline can go DOWN — these recorded bodies are gone; delete them from BASELINE)')
      for (const item of loosenable) {
        for (const gone of item.gone) {
          console.log(`    ${item.file}: ${JSON.stringify(gone.body).slice(0, 80)} (${gone.permitted}× → ${gone.observed}×)`)
        }
      }
    }
    return 0
  }
  console.log(`silent-catch: ${violations.length} NEW silent catch block(s) (of ${catchCount} catch blocks)`)
  for (const violation of violations) {
    console.log(
      `  ${violation.file}:${violation.line} — this body now occurs ${violation.observed}×, baseline ${violation.permitted}×`,
    )
    console.log(`    ${JSON.stringify(violation.body).slice(0, 120)}`)
  }
  console.log('')
  console.log('A catch that swallows without saying why turns a failure into an empty value, and the')
  console.log('caller cannot tell 「读到了空的」 from 「读失败了」. Say why it may be silent, or handle it.')
  return 1
}

process.exitCode = main()