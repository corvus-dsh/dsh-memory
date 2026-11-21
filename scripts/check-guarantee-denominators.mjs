#!/usr/bin/env node
/**
 * ── GUARANTEE SENTENCES MUST CARRY THEIR DENOMINATOR ────────────────────────────────────────────
 *
 * 五形态之三「保证语不实」。派工单的判据是「每条门禁打印的保证语必须在它为真的所有状态有测试」——
 * 那句话在静态上判不了（「所有状态」需要人列举）。本文件实现的是它**可判的那一半**，而那一半正好
 * 是本批反复出现的缺陷：
 *
 *   「全绿」这句话可以在三种完全不同的情况下打印出来：
 *
 *     ① 扫了 272 个名字，没有重名          ← 它想说的那种
 *     ② 扫了 0 个名字，没有重名            ← 什么都没扫
 *     ③ 扫错了地方，没有重名               ← §〇 17
 *
 *   **三次输出完全一样。** 唯一能把它们分开的是分母。
 *
 * ── 所以判据是 ────────────────────────────────────────────────────────────────────────────────
 *
 *   一条门禁打印 `OK` / `PASS` 时，同一行（或紧邻的续行）必须含一个数；并且这个数必须来自扫描，
 *   不能是 `0`。
 *
 * ── 为什么只查 OK 行，不查全部输出 ────────────────────────────────────────────────────────────
 *
 * 失败路径的报文由各自的测试钉住（它们会点名文件与行号）。成功路径是唯一**没有测试会去看**的地方：
 * 一条恒真的 `OK` 让所有测试都绿。所以检查落在那里。
 *
 * ── 白名单 ────────────────────────────────────────────────────────────────────────────────────
 *
 * 有些 OK 行的分母在**上一行**已经打印过（例如先 print 计数再 print 结论）。这类必须登记并写明
 * 为什么，否则就是「我找不到就不查」。
 *
 * 用法：node scripts/check-guarantee-denominators.mjs [--json]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO = process.cwd()
const SCRIPTS = join(REPO, 'scripts')

/**
 * Scripts whose OK line legitimately has no number ON or ADJACENT to it, with the reason.
 *
 * Two shapes are acceptable; both must name where the denominator IS:
 *   · it was printed on the line before (a two-line verdict);
 *   · it lives in a JSON payload this script emits, so the human line is a pointer.
 */
const NO_DENOMINATOR_ON_LINE = new Map([
  [
    'run-gate.mjs',
    'a WRAPPER: it prints the wrapped gate\'s own line verbatim (denominator included) and its own ' +
      'RESOURCE branch names the condition it could not check — 「NOT CHECKED」 is the honest sentence',
  ],
  [
    'build.mjs',
    'prints `built N module(s) into lib/` — the count IS the denominator, it is just phrased as a ' +
      'verb phrase rather than a verdict line',
  ],
])

/** A line that CLAIMS success ABOUT A SCAN. Deliberately narrow: `OK`/`PASS` as a word. */
const GUARANTEE = /\b(?:OK|PASS)\b/u

/**
 * ── WHICH GUARANTEES NEED A DENOMINATOR, AND WHICH DO NOT ────────────────────────────────────
 *
 * Measured on the first run: 12 candidates, and they are NOT the same kind of sentence.
 *
 *   ① `check-parity: OK — all 8 gate step(s) … wired`      ← SCAN VERDICT: needs its count
 *   ② `self-test: PASS (numberOf + evaluate)`               ← NAMED CASES: the cases ARE the
 *                                                              denominator and they are in the
 *                                                              sentence (`numberOf + evaluate`)
 *   ③ `SELF-TEST PASS` / `PASS <name>`                      ← PER-CASE line: one case, one verdict;
 *                                                              the loop prints the name, and the
 *                                                              total is someone else's line
 *   ④ `built 46 module(s) into lib/`                        ← ACTION DONE: 「做成了」, not 「扫过了」
 *
 * Requiring a number on ② ③ ④ would be noise, and a noisy gate gets switched off — which is exactly
 * how a real guarantee sentence stops being checked. So the rule is about **scan verdicts**:
 *
 *   a sentence whose subject is a SCAN (a set of files / names / steps / blocks that were examined)
 *   must say how large that set was.
 *
 * A per-case line (`PASS <name>`) and a self-test line (`PASS (caseA + caseB)`) name their subject
 * instead of counting it, which is the same information in a different grammar.
 */
const SCAN_SHAPED =
  /\b(?:all|every|each|no new|none new|across|of\s+\d+|name\(s\)|file\(s\)|step\(s\)|block\(s\)|script\(s\)|entry|entries|sentence\(s\))\b/iu

/**
 * A sentence whose subject is one NAMED case rather than a set: `PASS foo`, `PASS (a + b)`.
 *
 * `PASS` followed by a name and nothing else is a per-case verdict. It is excluded because the loop
 * that prints it is the denominator, and printing the total on every line would make the output
 * unreadable without adding one bit of information.
 */
const PER_CASE_LINE = /^[^`]*console\.log\(\s*`?\s*\{?[^`]*\b(?:PASS|OK)\b[^`]{0,12}\$\{?(?:ok|pass|name)\b[^`]*\)?\s*`?\s*\)/u

/** Any digit at all — the denominator need not be labelled, but it must be there. */
const HAS_NUMBER = /\d/u

/** A template interpolation that carries a COUNT — `\${items.length}` is a denominator as surely as `7`. */
const HAS_INTERPOLATED_COUNT = /\$\{[^}]*(?:\.length|\.size|Count|count|length|size|total|Total)\b[^}]*\}/u

/**
 * A `length`/`size`/`count` expression, which IS a denominator even when the literal digits are absent
 * from the source. Measured: the first version accepted only literal digits, so all four of this
 * repository's correctly-denominated verdicts (`\${gateSteps.length}`, `\${byName.size}`, …) were
 * reported as bare — a **false RED on four correct gates**, which is the mirror of the defect.
 */
const COUNTS_A_SET = /\b\w+\.(?:length|size)\b|\b\w+Count\b|\bcount\b/u

/** Lines whose number is part of a filename or a version, not a count. */
const NOT_A_DENOMINATOR = /\bv?\d+\.\d+|\.mjs|\.json|\.md\b|\[\d+\]/u

/**
 * Extract the console statements of a script as `{ line, text }`.
 *
 * A guarantee is often spread over two physical lines (`console.log(\`x: OK — \` + \`N thing(s)\`)`).
 * Joining the continuation is what makes 「number on an adjacent line」 decidable without a parser:
 * a statement ends at the first `)` that closes it or at a `;`.
 */
export function consoleStatements(text) {
  const out = []
  const lines = text.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!/console\.(?:log|warn|error)\(/u.test(line)) continue
    let statement = line
    let depth = (line.match(/\(/gu) ?? []).length - (line.match(/\)/gu) ?? []).length
    let cursor = index
    while (depth > 0 && cursor + 1 < lines.length) {
      cursor += 1
      statement += `\n${lines[cursor]}`
      depth += (lines[cursor].match(/\(/gu) ?? []).length - (lines[cursor].match(/\)/gu) ?? []).length
    }
    out.push({ line: index + 1, statement })
  }
  return out
}

/** Judgements for one script. Returns the guarantee statements that lack a denominator. */
export function findBareGuarantees(text, exemptions = NO_DENOMINATOR_ON_LINE) {
  const findings = []
  for (const { line, statement } of consoleStatements(text)) {
    if (!GUARANTEE.test(statement)) continue
    /**
     * Only SCAN VERDICTS are in scope. A per-case `PASS <name>` line names its subject instead of
     * counting it; a `SELF-TEST PASS` line is one case. Demanding a number there is noise, and noise
     * is how the real check gets switched off.
     */
    if (!SCAN_SHAPED.test(statement)) continue
    if (PER_CASE_LINE.test(statement)) continue
    /**
     * The whole STATEMENT is examined, not just the physical line: a verdict built as
     * `` `x: OK — ${n} file(s)` `` has its number in an interpolation on the same statement, and a
     * two-line `+` concatenation has it on the second half. Both are denominators.
     *
     * THREE ACCEPTABLE FORMS, and all three are denominators:
     *   · a literal digit          `... (37 recorded)`
     *   · a `.length`/`.size` read  `${gateSteps.length}`
     *   · an interpolated count     `${guaranteeCount}`
     */
    const hasLiteral = HAS_NUMBER.test(statement) && !isOnlyDecorations(statement)
    const hasComputed = HAS_INTERPOLATED_COUNT.test(statement) || COUNTS_A_SET.test(statement)
    if (hasLiteral || hasComputed) continue
    findings.push({ line, statement: statement.replace(/\s+/gu, ' ').slice(0, 120) })
  }
  return findings
}

/** True when every number in the statement belongs to a filename/version rather than a count. */
function isOnlyDecorations(statement) {
  const counts = [...statement.matchAll(/\$\{[^}]*\}/gu)].map((match) => match[0])
  if (counts.length > 0) return false
  return NOT_A_DENOMINATOR.test(statement) && !/\$\{\s*[\w.]+\s*\}/u.test(statement)
}

function main() {
  let files
  try {
    files = readdirSync(SCRIPTS).filter((name) => name.endsWith('.mjs')).sort()
  } catch {
    console.log(`check-guarantee-denominators: FAILED TO START — ${SCRIPTS} does not exist`)
    return 1
  }
  if (files.length === 0) {
    console.log(`check-guarantee-denominators: FAILED TO START — no .mjs under ${SCRIPTS}`)
    return 1
  }

  const findings = []
  let guaranteeCount = 0
  for (const name of files) {
    const text = readFileSync(join(SCRIPTS, name), 'utf8')
    const bare = findBareGuarantees(text, NO_DENOMINATOR_ON_LINE)
    guaranteeCount += consoleStatements(text).filter((entry) => GUARANTEE.test(entry.statement)).length
    if (NO_DENOMINATOR_ON_LINE.has(name)) continue
    for (const finding of bare) findings.push({ file: `scripts/${name}`, ...finding })
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ scripts: files.length, guaranteeCount, findings }, null, 2))
    return findings.length === 0 ? 0 : 1
  }

  if (findings.length === 0) {
    console.log(
      `guarantee-denominators: OK — ${guaranteeCount} success sentence(s) across ${files.length} script(s), ` +
        `each carries its denominator (${NO_DENOMINATOR_ON_LINE.size} exempt by name)`,
    )
    return 0
  }

  console.log(`guarantee-denominators: ${findings.length} success sentence(s) without a denominator`)
  for (const finding of findings) {
    console.log(`  ${finding.file}:${finding.line}`)
    console.log(`    ${finding.statement}`)
  }
  console.log('')
  console.log('「全绿」在三件事上形状相同：扫了 N 个、扫了 0 个、扫错了地方。分母是唯一能把它们')
  console.log('分开的东西，所以打 OK 的时候必须连分母一起打。')
  return 1
}

process.exitCode = main()