/**
 * 临时诊断：把 CI 失败点打到 stdout，便于在 job 摘要里读到（不写文件、不改产物）。
 *
 * 用 `--test-name-pattern` 单独跑会失去并发上下文，所以这里改成：
 * 把 pack 测试的每一步都 console.log 出来，fail 时 CI 会打印 stderr/stdout 尾部。
 *
 * 这个文件**不长期保留**：定位后即删，或降级为普通断言说明。
 */
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

test('DIAGNOSTIC: what does npm pack report in this environment', (t) => {
  console.log(`node ${process.version}`)
  console.log(`platform ${process.platform}`)
  console.log(`npm_execpath ${process.env.npm_execpath ?? '(unset)'}`)

  const execpath = process.env.npm_execpath
  const useNode = typeof execpath === 'string' && execpath.endsWith('.js')
  const cmd = useNode ? process.execPath : 'npm'
  const args = useNode ? [execpath, 'pack', '--dry-run', '--json', '--ignore-scripts'] : ['pack', '--dry-run', '--json', '--ignore-scripts']
  const shell = useNode ? false : process.platform === 'win32'
  console.log(`invocation: ${cmd} ${args.join(' ')} (shell=${shell})`)

  try {
    const out = execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell })
    console.log(`exit 0, stdout length ${out.length}`)
    console.log(`stdout head: ${JSON.stringify(out.slice(0, 200))}`)
    const start = out.indexOf('[')
    const end = out.lastIndexOf(']')
    console.log(`json slice ${start}..${end}`)
    const parsed = JSON.parse(out.slice(start, end + 1))
    console.log(`parsed entries ${parsed.length}, files ${parsed[0]?.files?.length}`)
    t.diagnostic('npm pack OK')
  } catch (error) {
    console.log(`THREW: ${error.code ?? ''} ${String(error.message).slice(0, 300)}`)
    console.log(`stdout: ${JSON.stringify(String(error.stdout ?? '').slice(0, 500))}`)
    console.log(`stderr: ${JSON.stringify(String(error.stderr ?? '').slice(0, 500))}`)
    throw error
  }
})
