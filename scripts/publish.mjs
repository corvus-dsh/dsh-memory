#!/usr/bin/env node
/**
 * One-command publish: git init → commit → tag → push → topics → Release.
 *
 *   GITHUB_TOKEN=ghp_xxx node scripts/publish.mjs            # 真发布
 *   GITHUB_TOKEN=ghp_xxx node scripts/publish.mjs --dry-run   # 只打印将执行的步骤
 *
 * 需要 token 具备 `repo` 权限（classic）或 Contents + Administration 写权限（fine-grained）。
 *
 * WHY NOT `gh`  这个脚本不依赖 GitHub CLI：CI 机器上往往只有 node 和 git。
 * WHY extraheader  把 token 塞进 remote URL 会留在 `.git/config` 里；这里走一次性
 *                  `http.extraheader`，不落盘，且日志里不会出现 token。
 * WHY ADOPT REMOTE  远端可能已经有上一个 release 的提交。重复发布会因为“无关历史”
 *                  而需要强推；这里先把远端 main 接成父提交（`reset --mixed`，工作区
 *                  不动），于是每次都是普通的 fast-forward。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const SKIP_PUSH = argv.includes('--skip-push')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const VERSION = String(pkg.version ?? '')
const TAG = `v${VERSION}`

function fail(message) {
  process.stderr.write(`\n✖ ${message}\n`)
  process.exit(1)
}

function log(message) {
  process.stdout.write(`${message}\n`)
}

function git(args, { capture = false, allowFail = false } = {}) {
  // In dry-run nothing is executed, but the READ-ONLY probes still have to answer:
  // otherwise the script decides "no .git" and then asks git for `status`.
  if (DRY) {
    if (args[0] === 'status') return { status: 0, stdout: '(dry-run: pending changes)', stderr: '' }
    if (args[0] === 'rev-parse') return { status: 1, stdout: '', stderr: '' }
    if (args[0] === 'remote') return { status: 0, stdout: '', stderr: '' }
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.status !== 0 && !allowFail) {
    fail(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`)
  }
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
}

// ---------------------------------------------------------------------------
// 1. Preflight
// ---------------------------------------------------------------------------
if (!existsSync(join(ROOT, String(pkg.main ?? 'index.js')))) fail(`${String(pkg.main ?? 'index.js')} 不存在：先在插件目录里跑 node scripts/build.mjs`)
if (!VERSION || VERSION.includes('REPLACE')) fail('package.json 缺少可用 version')
if (!existsSync(join(ROOT, 'LICENSE'))) fail('LICENSE 不存在')

const token = process.env.GITHUB_TOKEN ?? ''
if (!token && !DRY) fail('缺少 GITHUB_TOKEN。设置后重试：$env:GITHUB_TOKEN="<your-token>"（PowerShell）')

const owner = process.env.GITHUB_OWNER ?? ''
const repo = process.env.GITHUB_REPO ?? pkg.name
let ownerGuess = owner
if (!ownerGuess) {
  const url = String(pkg.repository?.url ?? '')
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/u.exec(url)
  if (match) ownerGuess = match[1]
}
if (!ownerGuess) {
  fail('无法推断 GitHub owner：设置 GITHUB_OWNER，或把 package.json 的 repository 改成你的真实地址')
}
if (String(pkg.repository?.url ?? '').toUpperCase().includes('REPLACE')) {
  log(`⚠ package.json 里的 repository 仍是占位符；发布前请改成 https://github.com/${ownerGuess}/${repo}.git`)
}

// ---------------------------------------------------------------------------
// 2. Local git: init, adopt remote history, commit
// ---------------------------------------------------------------------------
if (!existsSync(join(ROOT, '.git'))) {
  if (DRY) {
    log(`[dry] git init`)
  } else {
    log(`→ git init`)
    git(['init', '-q'])
    git(['branch', '-M', 'main'], { allowFail: true })
  }
}

const remoteUrl = `https://github.com/${ownerGuess}/${repo}.git`
const remotes = git(['remote'], { capture: true, allowFail: true }).stdout.split('\n').filter(Boolean)
if (!remotes.includes('origin')) {
  if (DRY) log(`[dry] git remote add origin ${remoteUrl}`)
  else {
    log(`→ git remote add origin ${remoteUrl}`)
    git(['remote', 'add', 'origin', remoteUrl])
  }
} else {
  const current = git(['remote', 'get-url', 'origin'], { capture: true, allowFail: true }).stdout
  if (current !== remoteUrl) {
    if (DRY) log(`[dry] git remote set-url origin ${remoteUrl}`)
    else {
      log(`→ git remote set-url origin ${remoteUrl}`)
      git(['remote', 'set-url', 'origin', remoteUrl])
    }
  }
}

// Adopt the remote branch as the parent commit when this checkout has no history
// of its own. Without this, a second release is "unrelated histories" and needs a
// force push — which is how a release silently deletes someone else's commit.
if (DRY) {
  log(`[dry] git fetch origin main && adopt as parent (if any)`)
} else {
  const fetched = git(['fetch', '-q', 'origin', 'main'], { allowFail: true }).status === 0
  const hasLocalCommit = git(['rev-parse', '--verify', '--quiet', 'HEAD'], { capture: true, allowFail: true }).status === 0
  if (fetched && !hasLocalCommit) {
    git(['update-ref', 'refs/heads/main', 'FETCH_HEAD'])
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
    // Index := remote tree. The working tree is NOT touched, so local edits stay.
    git(['reset', '--mixed', 'FETCH_HEAD'])
    log(`→ 已接管远端历史（父提交 = origin/main），本次为普通 fast-forward`)
  }
}

const status = git(['status', '--porcelain'], { capture: true })
if (status.stdout.length > 0) {
  if (DRY) {
    log(`[dry] git add -A && git commit（${status.stdout.split('\n').length} 个变更）`)
  } else {
    log(`→ 提交 ${status.stdout.split('\n').length} 个变更`)
    git(['add', '-A'])
    git(['-c', 'user.name=dsh-graft-slice', '-c', 'user.email=noreply@localhost', 'commit', '-q', '-m', `release: ${TAG}`])
  }
} else {
  log(`→ 工作区干净，跳过 commit`)
}

const hasTag = git(['rev-parse', '--verify', '--quiet', `refs/tags/${TAG}`], { capture: true, allowFail: true }).status === 0
if (!hasTag) {
  if (DRY) {
    log(`[dry] git tag -a ${TAG}`)
  } else {
    log(`→ 打 tag ${TAG}`)
    git(['-c', 'user.name=dsh-graft-slice', '-c', 'user.email=noreply@localhost', 'tag', '-a', TAG, '-m', `dsh-graft-slice ${VERSION}`])
  }
} else {
  log(`→ tag ${TAG} 已存在，跳过`)
}

// ---------------------------------------------------------------------------
// 3. GitHub API helpers
// ---------------------------------------------------------------------------
const api = async (method, path, body) => {
  if (DRY) {
    log(`[dry] ${method} https://api.github.com${path}`)
    return { ok: true, status: 0, json: async () => ({}) }
  }
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'dsh-graft-slice-publish',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { ok: response.ok, status: response.status, json: () => response.json().catch(() => ({})) }
}

// 4. Ensure the repository exists (public by default).
const existing = await api('GET', `/repos/${ownerGuess}/${repo}`)
if (!existing.ok && existing.status === 404) {
  if (DRY) {
    log(`[dry] POST /user/repos  (create ${ownerGuess}/${repo})`)
  } else {
    log(`→ 远端仓库不存在，创建 ${ownerGuess}/${repo}`)
    const created = await api('POST', '/user/repos', {
      name: repo,
      private: false,
      description: `${pkg.description ?? ''} — DSH open-source ecosystem (topic: dsh-plugin)`,
      has_issues: true,
      has_wiki: false,
    })
    if (!created.ok) {
      const payload = await created.json()
      fail(`创建仓库失败：${payload?.message ?? created.status}（若是组织仓库，请用 GITHUB_OWNER 指向组织，或先手动建仓）`)
    }
  }
} else if (!existing.ok && existing.status !== 404) {
  log(`⚠ 无法查询仓库（HTTP ${existing.status}），将继续尝试推送`)
}

// ---------------------------------------------------------------------------
// 5. Push (token via one-shot http header, never written to .git/config)
// ---------------------------------------------------------------------------
if (!SKIP_PUSH) {
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  if (DRY) {
    log(`[dry] git push（分支 main + tag ${TAG}）`)
  } else {
    log(`→ 推送 main 与 ${TAG}`)
    const pushed = git(['-c', `http.extraheader=${header}`, 'push', 'origin', 'main', `refs/tags/${TAG}`], { allowFail: true })
    if (pushed.status !== 0) fail('推送失败（检查 token 权限与仓库 owner）')
  }
}

// ---------------------------------------------------------------------------
// 6. Topics — this project lives in the DSH open-source ecosystem
// ---------------------------------------------------------------------------
const TOPICS = ['dsh-plugin', 'dsh', 'deepseek-harness', 'context-management', 'agent-memory', 'handoff', 'session-management']
const topics = await api('PUT', `/repos/${ownerGuess}/${repo}/topics`, { names: TOPICS })
if (!topics.ok) log(`⚠ 设置 topics 失败（HTTP ${topics.status}）；可手动在仓库 About 里加上 ${TOPICS.join(', ')}`)
else if (!DRY) log(`✓ topics: ${TOPICS.join(', ')}`)

// ---------------------------------------------------------------------------
// 7. Release (prerelease: 0.7.x 是测试版，先走预发布)
// ---------------------------------------------------------------------------
const notesPath = join(ROOT, 'RELEASE_NOTES.md')
const body = existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : `Release ${TAG}`
const release = await api('POST', `/repos/${ownerGuess}/${repo}/releases`, {
  tag_name: TAG,
  name: `dsh-graft-slice ${VERSION}（预发布）— 让长会话活着交班`,
  body,
  draft: false,
  prerelease: true,
  make_latest: 'false',
})
if (!release.ok) {
  if (release.status === 422) log(`⚠ Release ${TAG} 可能已存在（HTTP 422），跳过创建`)
  else log(`⚠ 创建 Release 失败（HTTP ${release.status}）`)
} else if (!DRY) {
  const payload = await release.json()
  log(`✓ Release: ${payload?.html_url ?? `https://github.com/${ownerGuess}/${repo}/releases/tag/${TAG}`}`)
}

log(`\n${DRY ? '[dry-run 完成]' : '✓ 发布完成'}  →  https://github.com/${ownerGuess}/${repo}/releases/tag/${TAG}`)