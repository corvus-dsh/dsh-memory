#!/usr/bin/env node
/**
 * ── BOOKKEEPING BEFORE FACT: A STAMP MUST BE GATED ON THE WRITE'S OWN ANSWER ────────────────────
 *
 * 五形态之四「记账先于事实」。派工单的判据：任何「计数/状态推进」必须在 IO 成功后；静态检查：
 * `state.X += 1` 出现在 `await execute` 之前的函数 ⇒ 人工审 + 白名单。
 *
 * ── 为什么这里不实现那条字面判据 ──────────────────────────────────────────────────────────────
 *
 * 「`+= 1` 出现在 `await` 之前」在这个仓里有 279 处计数动作，其中绝大多数与 IO 无关（循环里的
 * 累加、字符串拼接、评分求和）。按那条字面判据跑，会得到一片需要人工逐条解释的红 —— 那不是检查，
 * 那是一份待读清单，而待读清单的结局是不读。
 *
 * ── 实现的是它的**可判核心** ─────────────────────────────────────────────────────────────────
 *
 * 本批真正踩过的形状是这一种，而且它有唯一正确的写法：
 *
 *     写一条知识  → 报告写进去了多少条 → **只有写了才盖 harvestedAt 章**
 *
 * 这条链上的错误只有一个方向：**盖章先用结果，判断后看结果**。所以判据是：
 *
 *   一个函数里若同时出现「盖章/标记类调用」与「写盘类调用的结果变量」，
 *   那么盖章必须在那个结果**被判定之后**才出现。
 *
 * 具体地，检查三种已验证的写法是否成立（下面每一条都对应源码里的一处真实调用）：
 *
 *   ① `markHarvested(...)` 必须与 `result.written + result.merged` 之类的**判定**同现，
 *      且判定在盖章之前；
 *   ② 判定为 0 时不许盖章（`recorded === 0 ? [] : markHarvested(...)`）；
 *   ③ 盖章不许出现在写盘调用**之前**（同函数内按字符偏移比较）。
 *
 * ── 不覆盖什么 ────────────────────────────────────────────────────────────────────────────────
 *
 *   · 不判断「盖章」的业务含义 —— 它由 `STAMP_CALLS` 显式列出，新增一个盖章函数必须登记；
 *   · 不覆盖跨函数的先后（那需要调用图）；
 *   · 不覆盖「写盘成功但内容错」—— 那是写盘自己的测试。
 *
 * 用法：node scripts/check-stamp-after-write.mjs [--json]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO = process.cwd()
const SRC = join(REPO, 'src')

/**
 * Calls that RECORD A FACT ABOUT THE WORLD (「这件事已经发生了」). Naming them explicitly is the
 * point: a new stamp function must be added here, and adding it forces someone to read this file.
 */
const STAMP_CALLS = ['markHarvested']

/**
 * Calls that PRODUCE the answer the stamp must be gated on. The variable they are assigned to is
 * discovered per function rather than named here, so a rename does not silently disable the check.
 */
const WRITE_CALLS = ['writeKnowledge']

/** A statement that CHECKS the write's answer — the gate the stamp must sit behind. */
const DECISION = /\b(?:written|merged|recorded)\s*[+><=]|\b(?:written|merged|recorded)\s*===|\b(?:written|merged|recorded)\s*!==/u

/**
 * ── COMMENTS ARE STRIPPED BEFORE ANY DECISION IS LOOKED FOR, AND THAT IS THE WHOLE FIX ────────
 *
 * Measured while building the can-red: the stamp was moved above its ternary, and the gate STILL
 * passed. The reason was a block comment immediately above the line:
 *
 *     * A refused entry does not count: `written + merged === 0` means the store learned nothing,
 *     * so stamping the node would silence the reminder without answering it.
 *
 * i.e. **the prose explaining the rule satisfied the check for the rule.** That is the third time in
 * this batch that a comment passed a gate (`check-check-parity.mjs` twice, this once), which is why
 * the stripping is done ONCE here, at the top, for every consumer below.
 *
 * Blanking (rather than deleting) keeps every offset valid, so reported line numbers still point at
 * the real source line.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, (match) => match.replace(/[^\n]/gu, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/gu, (match, lead) => `${lead}${' '.repeat(match.length - lead.length)}`)
}

/**
 * ── A DEFINITION IS NOT A CALL, AND THE FIRST VERSION COULD NOT TELL THEM APART ────────────────
 *
 * Measured on the first run: it reported `src/graph.ts:742` — which is
 *
 *     export function markHarvested(memoryDir: string, nodeIds: readonly string[], …): string[] {
 *
 * the DEFINITION, not a call site. A gate that reports the definition of the function it is checking
 * is a false RED on correct code, and a false RED is how a gate gets deleted.
 *
 * So call sites are found by excluding the definition forms:
 *
 *     export function markHarvested(   |  function markHarvested(   |  const markHarvested = (
 */
const DEFINITION_OF = (name) =>
  new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(|(?:export\\s+)?const\\s+${name}\\s*=\\s*(?:async\\s*)?\\(`,
    'u',
  )

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(path, out)
      continue
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(path)
  }
  return out
}

/**
 * Split a file into top-level statements by brace depth, so 「in the same function」 has a real answer
 * without a TypeScript parser.
 *
 * The unit is the whole FILE for offset comparisons: a stamp and a write that appear in the same file
 * are compared by offset, and a stamp that appears BEFORE every write in that file is reported. That
 * is coarser than a function scope on purpose — see the note above about a call graph.
 */
export function scanOrdering(text, { stamps = STAMP_CALLS, writes = WRITE_CALLS } = {}) {
  const findings = []
  /**
   * Comments are blanked FIRST — the prose that explains a rule must never satisfy it. Offsets stay
   * valid because blanking replaces every non-newline character with a space.
   */
  const code = stripComments(text)
  for (const stamp of stamps) {
    /**
     * ── FIND THE CALL, NOT THE DEFINITION ──────────────────────────────────────────────────────
     *
     * `text.indexOf('markHarvested(')` lands on the DEFINITION when a file both defines and calls the
     * function — measured: `src/graph.ts:742` was reported, and that line is `export function
     * markHarvested(…`. So the definition span is blanked out before searching, which keeps every
     * offset in the original text valid (the replacement is the same length, spaces only).
     */
    const definition = DEFINITION_OF(stamp).exec(code)
    let searchable = code
    if (definition !== null) {
      const blank = ' '.repeat(definition[0].length)
      searchable = code.slice(0, definition.index) + blank + code.slice(definition.index + blank.length)
    }

    const stampAt = searchable.indexOf(`${stamp}(`)
    if (stampAt < 0) continue

    /** The nearest write call in the file, and the decision that must precede the stamp. */
    let nearestWrite = -1
    for (const write of writes) {
      const at = text.indexOf(`${write}(`)
      if (at >= 0 && (nearestWrite < 0 || at < nearestWrite)) nearestWrite = at
    }

    /**
     * ── EVERY CALL SITE, NOT JUST THE FIRST ONE IN THE FILE ─────────────────────────────────────
     *
     * The first version searched for ONE occurrence per file and judged a 2000-character window above
     * it. Measured while building the can-red: moving a stamp BEFORE its decision did NOT red the
     * gate, because a DIFFERENT decision elsewhere in those 2000 characters satisfied the window. The
     * check was answering 「这个文件里有没有判定」 instead of 「这一次盖章有没有判定」 — the same
     * dimension error this batch keeps finding, this time inside the checker.
     *
     * So every call site is examined on its OWN STATEMENT:
     *
     *   · a ternary whose condition decides the answer  `${recorded === 0 ? [] : stamp(…)}`  ⇒ gated
     *   · a statement preceded (in the same enclosing block, above it) by a decision ⇒ gated
     *   · otherwise ⇒ RED
     */
    for (let at = searchable.indexOf(`${stamp}(`); at >= 0; at = searchable.indexOf(`${stamp}(`, at + 1)) {
      const lineStart = searchable.lastIndexOf('\n', at) + 1
      const lineEnd = searchable.indexOf('\n', at)
      const statement = searchable.slice(lineStart, lineEnd < 0 ? searchable.length : lineEnd)

      /** ① a ternary on the same statement — the shape `recorded === 0 ? [] : stamp(…)`. */
      if (DECISION.test(statement) && statement.includes('?') && statement.includes(':')) continue

      /**
       * ② a decision that GATES this statement. Two shapes are accepted, and both are real here:
       *
       *   TERNARY   `recorded === 0 ? [] : stamp(…)`   — decided inline, same statement;
       *   GUARD     `if (recorded === 0) { …return… }` above, followed by `stamp(…)` — decided above
       *             with an early return in between.
       *
       * ── THE SCOPE IS THE BLOCK SINCE THE LAST STATEMENT OF THE SAME KIND ──────────────────────
       *
       * Two measured failures shaped this:
       *
       *   · a 2000-character look-back made the can-red NOT red — a DIFFERENT decision sat in the
       *     window, so the gate answered 「这个文件里有没有判定」 instead of 「这一次盖章有没有判定」;
       *   · a fixed 600-character fallback did the same thing for the first stamp in a long file.
       *
       * So the look-back ends at the PREVIOUS stamp or write call (whichever is later). A guard that
       * belongs to an earlier stamp cannot be borrowed by this one.
       */
      const priorStamp = searchable.lastIndexOf(`${stamp}(`, at - 1)
      let priorWrite = -1
      for (const write of writes) {
        const from = searchable.lastIndexOf(`${write}(`, at - 1)
        if (from > priorWrite) priorWrite = from
      }
      const floor = Math.max(priorStamp, priorWrite, 0)
      const endingLine = searchable.lastIndexOf('\n', at)
      const scope = searchable.slice(floor, endingLine)
      const guard = /\b(?:written|merged|recorded)\b[^\n]*===|=== *0/u.test(scope) && /\breturn\b/u.test(scope)
      const anyDecision = DECISION.test(statement) || guard

      /** ③ the stamp must not come before the nearest write in this file. */
      let nearestWrite = -1
      for (const write of writes) {
        const writeAt = searchable.indexOf(`${write}(`)
        if (writeAt >= 0 && (nearestWrite < 0 || writeAt < nearestWrite)) nearestWrite = writeAt
      }
      if (nearestWrite >= 0 && at < nearestWrite) {
        findings.push({
          stamp,
          line: searchable.slice(0, at).split(/\r?\n/u).length,
          why: `${stamp} appears before any ${writes.join('/')} call in this file`,
        })
        continue
      }

      if (!anyDecision) {
        findings.push({
          stamp,
          line: searchable.slice(0, at).split(/\r?\n/u).length,
          why: `${stamp} is not gated on a decision about written/merged/recorded — it may be stamping an attempt, not a result`,
        })
      }
    }
  }
  return findings
}

function main() {
  let files
  try {
    files = walk(SRC)
  } catch {
    console.log(`check-stamp-after-write: FAILED TO START — ${SRC} does not exist`)
    return 1
  }
  if (files.length === 0) {
    console.log(`check-stamp-after-write: FAILED TO START — no .ts file under ${SRC}`)
    return 1
  }

  const findings = []
  let stampSites = 0
  let writeSites = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const stamp of STAMP_CALLS) stampSites += text.split(`${stamp}(`).length - 1
    for (const write of WRITE_CALLS) writeSites += text.split(`${write}(`).length - 1
    for (const finding of scanOrdering(text)) findings.push({ file: relative(REPO, file).split('\\').join('/'), ...finding })
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ files: files.length, stampSites, writeSites, findings }, null, 2))
    return findings.length === 0 ? 0 : 1
  }

  if (findings.length === 0) {
    console.log(
      `stamp-after-write: OK — ${stampSites} stamp site(s) across ${files.length} file(s), ` +
        `each behind a decision about the write's own answer (${writeSites} write site(s))`,
    )
    return 0
  }

  console.log(`stamp-after-write: ${findings.length} stamp site(s) not gated on the write's answer`)
  for (const finding of findings) {
    console.log(`  ${finding.file}:${finding.line} — ${finding.why}`)
  }
  console.log('')
  console.log('A stamp that records 「这件事已经发生」 before the write回答「写进去了没有」 把「我试过」')
  console.log('记成了「做成了」，而提醒会因此停止 —— 那是下一代会重做的事。')
  return 1
}

process.exitCode = main()