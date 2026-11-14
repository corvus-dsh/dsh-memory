#!/usr/bin/env node
/**
 * 临时诊断：跑完整套件，并把失败摘要写成 GitHub annotation。
 *
 * 为什么需要它：`node --test` 在 CI 的 node 22 上似乎把子测试的 stdout 吞掉了
 * （同一份诊断测试在 24.x 上能产出 ::notice::，22.x 上一条都没有），
 * 于是"红了但不知道为什么"。这个脚本是**父进程**，它自己 print，不经过测试运行器的输出缓冲。
 *
 * 定位后删除，并把 package.json 的 "test" 脚本改回 `node --test test/*.test.mjs`。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const files = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => join('test', f))

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
  env: process.env,
})

const stdout = result.stdout ?? ''
const stderr = result.stderr ?? ''
const combined = `${stdout}\n${stderr}`

// 原样转发，保持日志完整
process.stdout.write(stdout)
process.stderr.write(stderr)

console.log(`::notice::DIAG wrapper: node=${process.version} exit=${result.status ?? 'null'} files=${files.length}`)

if ((result.status ?? 1) !== 0) {
  const interesting = combined
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(✖|not ok|AssertionError|Error:|TypeError|ReferenceError|SyntaxError|file:\/\/)/u.test(line) || /failed|Error:/u.test(line))
  // 去重后逐条上报（每条上限 ~850 字符，GitHub 单条注释有上限）
  const seen = new Set()
  let emitted = 0
  for (const line of interesting) {
    if (emitted >= 20) break
    const key = line.slice(0, 120)
    if (seen.has(key)) continue
    seen.add(key)
    console.log(`::error::DIAG ${line.slice(0, 850)}`)
    emitted += 1
  }
  if (emitted === 0) {
    console.log(`::error::DIAG no recognizable failure line; tail=${JSON.stringify(combined.slice(-400))}`)
  }
}

process.exit(result.status ?? 1)
