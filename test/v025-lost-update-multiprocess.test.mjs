/**
 * v0.25 P1 — THE LOST UPDATE ACROSS PROCESSES, not just across ticks.
 *
 * WHY THIS FILE EXISTS AND THE IN-PROCESS ONE WAS NOT ENOUGH.
 *
 * The first version of this test ran six `appendNegatives` calls from one Node process
 * on six `setImmediate` ticks and asserted all six rows survived. It passed — and it
 * ALSO passed with the lock removed, which means it was measuring nothing.
 *
 * The reason is that `acquireFileLock` is a SYNCHRONOUS busy-wait. On Node's single
 * thread, the whole read→mutate→write runs without yielding, so no interleaving is
 * possible in the first place. The in-process test proved that JavaScript is
 * single-threaded, not that the lock works.
 *
 * The failure this store actually faces is TWO HARVESTS IN TWO PROCESSES (two windows,
 * or a harvest overlapping a `memory_migrate_evidence`). That is a genuine race, and it
 * is the one worth a test. Each writer below is a separate `node` process appending its
 * own record; the assertion is that every process's record survives.
 *
 * With the lock: every record lands, because each process re-reads inside the critical
 * section. Without it: the last writer's file wins and the others vanish.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/**
 * A tiny worker: WAIT at a barrier, then append ONE distinct negative.
 *
 * The barrier matters. Without it, eight processes each start, do a few
 * microseconds of work and exit, and by the time the eighth has spawned the first is
 * already done — so no two critical sections overlap and the test passes whether or
 * not the lock exists. (That is exactly what the first version did: it stayed green
 * with the lock removed, which made it worthless.)
 *
 * Each worker creates its own ready-file and then polls until the START file appears.
 * The parent waits for every ready-file, then creates the start file. All eight then
 * enter the read→mutate→write within the same few milliseconds.
 */
const WORKER = `
import { appendNegatives } from ${JSON.stringify('file:///' + join(ROOT, 'lib', 'store.js').replace(/\\/gu, '/'))}
import { existsSync, writeFileSync } from 'node:fs'

const [dir, indexText, readyFile, startFile] = process.argv.slice(2)
const index = Number(indexText)
const shapes = [
  { symptom: 'TypeError cannot read properties of undefined', cause: 'optional chaining missing', avoid: '不判空直接访问嵌套属性' },
  { symptom: 'git push rejected non-fast-forward', cause: 'remote moved ahead', avoid: '推送前先 fetch 并 rebase' },
  { symptom: 'ENOENT no such file or directory package.json', cause: 'wrong working directory', avoid: '在仓库根目录执行命令' },
  { symptom: 'EADDRINUSE port 3000 already in use', cause: 'stale dev server process', avoid: '启动前先确认端口释放' },
  { symptom: 'SyntaxError unexpected token in JSON at position 0', cause: 'response body is HTML error page', avoid: '解析前先检查 content-type' },
  { symptom: 'heap out of memory during build', cause: 'single pass over a huge log', avoid: '分批读取而不是一次性载入' },
  { symptom: 'Access denied writing to C drive root', cause: 'elevation required', avoid: '永远不要写盘符根目录' },
  { symptom: 'lock never released after crash', cause: 'owner pid still alive', avoid: '用租约过期回收锁' },
]
const shape = shapes[index % shapes.length]

// 1. announce readiness
writeFileSync(readyFile, 'ready')
// 2. spin until the parent releases everyone
const deadline = Date.now() + 20000
while (!existsSync(startFile)) {
  if (Date.now() > deadline) process.exit(2)
}
// 3. the critical section, now genuinely concurrent
appendNegatives(dir, [{
  symptom: shape.symptom,
  cause: shape.cause,
  avoid: shape.avoid,
  evidence: [{ sourceSessionId: 'worker-' + index, seq: index }],
  provenance: 'tool',
}], { sessionId: 'worker-' + index, boundarySeq: index, workspace: 'D:\\\\持久层能力架构', provenance: 'tool' })
`

function readRows(path) {
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

test('v0.25 P1: eight PROCESSES entering at once all keep their record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-proc-'))
  mkdirSync(dir, { recursive: true })
  const workerPath = join(dir, 'worker.mjs')
  writeFileSync(workerPath, WORKER, 'utf8')
  const startFile = join(dir, 'GO')

  const WRITERS = 8
  const { spawn } = await import('node:child_process')
  const readyFiles = []
  const children = []
  for (let index = 0; index < WRITERS; index += 1) {
    const readyFile = join(dir, `ready-${index}`)
    readyFiles.push(readyFile)
    children.push(
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [workerPath, dir, String(index), readyFile, startFile], {
          cwd: ROOT,
          stdio: 'ignore',
        })
        child.on('error', reject)
        child.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`worker ${index} exited ${code}`))))
      }),
    )
  }

  // Wait for ALL workers to be waiting at the barrier, then release them together.
  const waitDeadline = Date.now() + 20_000
  while (readyFiles.some((file) => !existsSync(file))) {
    if (Date.now() > waitDeadline) throw new Error('workers did not reach the barrier in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  writeFileSync(startFile, 'go')

  await Promise.all(children)

  const rows = readRows(join(dir, 'negatives.jsonl'))
  assert.equal(
    rows.length,
    WRITERS,
    `a losing writer was overwritten: ${rows.length}/${WRITERS} survived. ` +
      'This is the lost update — atomicWrite does not prevent it, only the lock does.',
  )
  const sessions = new Set(rows.map((row) => String(row.sourceSessionId)))
  for (let index = 0; index < WRITERS; index += 1) {
    assert.equal(sessions.has(`worker-${index}`), true, `worker-${index} lost its record`)
  }
})

test('v0.25 P1: the file stays one valid document per line under process contention', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-proc-torn-'))
  const workerPath = join(dir, 'worker.mjs')
  writeFileSync(workerPath, WORKER, 'utf8')
  const startFile = join(dir, 'GO')
  const WRITERS = 6
  const { spawn } = await import('node:child_process')
  const readyFiles = []
  const children = []
  for (let index = 0; index < WRITERS; index += 1) {
    const readyFile = join(dir, `ready-${index}`)
    readyFiles.push(readyFile)
    children.push(
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [workerPath, dir, String(index), readyFile, startFile], { cwd: ROOT, stdio: 'ignore' })
        child.on('error', reject)
        child.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`worker ${index} exited ${code}`))))
      }),
    )
  }
  const waitDeadline = Date.now() + 20_000
  while (readyFiles.some((file) => !existsSync(file))) {
    if (Date.now() > waitDeadline) throw new Error('workers did not reach the barrier in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  writeFileSync(startFile, 'go')
  await Promise.all(children)

  const path = join(dir, 'negatives.jsonl')
  assert.equal(existsSync(path), true)
  const text = readFileSync(path, 'utf8')
  let lines = 0
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue
    lines += 1
    assert.doesNotThrow(() => JSON.parse(line), `a torn line was written: ${line.slice(0, 80)}`)
  }
  assert.equal(lines, WRITERS, 'every process wrote exactly one row')
})

test('v0.25 P1: no lock directory is left behind after the writers finish', async () => {
  // A leaked lock would silently stop the store from accepting writes until the stale
  // sweep ran, which is a worse failure than the one being fixed.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-proc-leak-'))
  const workerPath = join(dir, 'worker.mjs')
  writeFileSync(workerPath, WORKER, 'utf8')
  const startFile = join(dir, 'GO')
  writeFileSync(startFile, 'go')
  execFileSync(process.execPath, [workerPath, dir, '0', join(dir, 'ready-0'), startFile], { cwd: ROOT, stdio: 'ignore' })
  assert.equal(existsSync(join(dir, 'negatives.jsonl.lock')), false, 'the lock must be released on the normal path')
})
