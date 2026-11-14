/**
 * 临时诊断（第二轮）：一次把两个可疑点都测掉，结论写进 GitHub annotation。
 *
 * 为什么用 annotation：job 日志要认证才能拉，annotation 可以匿名读。
 *
 * 两个可疑点：
 *
 *   ① `--ignore-scripts` 有没有真的拦住 `prepare`？
 *      拦不住 ⇒ `node scripts/build.mjs` 会重写 `lib/`，并发套件里其它测试读到半更新产物
 *      ⇒ 与"总数在跳 + 无关测试偶发失败"完全吻合。
 *      判据：pack 前后对 `lib/` 做内容哈希。
 *
 *   ② `npm pack --json` 的 stdout 里带警告时，我的切片会不会把 JSON 切坏？
 *      现有实现 `out.slice(out.indexOf('['), out.lastIndexOf(']') + 1)`
 *      —— 只要警告文本里出现一个 `[`，起点就错，JSON.parse 抛错 ⇒ 测试失败。
 *      判据：分别用「朴素切片」与「括号配平扫描」解析，比较结果。
 */
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const libDigest = () => {
  const dir = join(ROOT, 'lib')
  const hash = createHash('sha256')
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    hash.update(name)
    hash.update(readFileSync(join(dir, name)))
  }
  return hash.digest('hex').slice(0, 16)
}

/** 括号配平扫描：从每个 `[` 起尝试匹配，返回第一个能 JSON.parse 的切片。 */
function extractJsonArray (text) {
  for (let start = text.indexOf('['); start >= 0; start = text.indexOf('[', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') { inString = true; continue }
      if (ch === '[') depth += 1
      else if (ch === ']') {
        depth -= 1
        if (depth === 0) {
          try { return { json: JSON.parse(text.slice(start, i + 1)), start, end: i } } catch { break }
        }
      }
    }
  }
  return undefined
}

const note = (level, text) => console.log(`::${level}::${String(text).replace(/\r?\n/gu, ' ⏎ ')}`)

test('DIAGNOSTIC: prepare-hook leak and JSON slicing on this runtime', () => {
  const execpath = process.env.npm_execpath
  const useNode = typeof execpath === 'string' && execpath.endsWith('.js')
  const shell = useNode ? false : process.platform === 'win32'
  const cmd = useNode ? process.execPath : 'npm'
  const baseArgs = useNode ? [execpath] : []

  let npmVersion = 'unknown'
  try {
    npmVersion = String(execFileSync(cmd, [...baseArgs, '--version'], { cwd: ROOT, encoding: 'utf8', shell })).trim()
  } catch { /* unknown */ }

  const before = libDigest()
  let stdout = ''
  let ok = false
  let err = ''
  try {
    stdout = execFileSync(cmd, [...baseArgs, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell,
    })
    ok = true
  } catch (error) {
    err = String(error.message).slice(0, 100)
    stdout = String(error.stdout ?? '')
  }
  const after = libDigest()

  note('notice', `DIAG env node=${process.version} npm=${npmVersion} platform=${process.platform} execpath=${useNode ? 'js' : 'none'}`)
  note('notice', `DIAG pack ok=${ok} stdoutLen=${stdout.length} lib ${before}->${after} mutated=${before !== after}${err ? ` err=${err}` : ''}`)
  note('notice', `DIAG stdout head=${JSON.stringify(stdout.slice(0, 160))}`)

  // ① 朴素切片 vs 配平扫描
  let naive = 'not-run'
  try {
    const slice = stdout.slice(stdout.indexOf('['), stdout.lastIndexOf(']') + 1)
    const parsed = JSON.parse(slice)
    naive = `ok files=${parsed?.[0]?.files?.length}`
  } catch (error) {
    naive = `THROW ${String(error.message).slice(0, 60)}`
  }
  const robust = extractJsonArray(stdout)
  note('notice', `DIAG parse naive=${naive} robust=${robust === undefined ? 'FAILED' : `ok files=${robust.json?.[0]?.files?.length}`} at=${robust?.start ?? '-'}..${robust?.end ?? '-'}`)
  note('notice', `DIAG aroundFirstBracket=${JSON.stringify(stdout.slice(Math.max(0, stdout.indexOf('[') - 40), stdout.indexOf('[') + 60))}`)

  if (before !== after) {
    note('error', `DIAG VERDICT-A: prepare hook RAN despite --ignore-scripts (node ${process.version} / npm ${npmVersion})`)
  } else {
    note('notice', `DIAG VERDICT-A: --ignore-scripts held (node ${process.version} / npm ${npmVersion})`)
  }
  if (naive !== 'ok files=77' && robust !== undefined) {
    note('error', `DIAG VERDICT-B: naive slicing fails but a balanced scan works ⇒ the parser is the bug, not npm`)
  }
})
