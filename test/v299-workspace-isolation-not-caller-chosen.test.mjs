/**
 * ── v299 (B4-B B7)：工作区隔离不能由调用方自己回答「这是不是我的」 ────────────────────────────────
 *
 * ── 缺陷（实测复现，不是推断）────────────────────────────────────────────────────────────────
 *
 * 门禁 `memoryAllowsWorkspace` 本身是对的。问题在于它**拿什么去比**：
 *
 *   ① `memory_search`：`index.ts:1453-1460` 让 `args.workspace` **优先于**调用方会话自己的目录
 *   ② `skill_read`   ：**完全没有**工作区门禁 —— 按名字就能读到任何技能正文
 *
 * 实测（探针 `_scratch/b7-probe.mjs`，会话在 A）：
 *
 *   不传 workspace          ⇒ skill=null            ← 门禁正常
 *   传 workspace=B          ⇒ skill=b7-secret 泄漏  ← 调用方一句话就穿透
 *   skill_read {name}       ⇒ 正文完整返回          ← 连参数都不需要
 *
 * ② 更彻底：`skill_read` 连「指定别人的工作区」这一步都省了，只要知道技能名。
 *
 * ── 为什么不允许「显式参数覆盖」──────────────────────────────────────────────────────────────
 *
 * 记忆的 `workspace` 是**写它那一刻的会话目录**，是出处，不是偏好。让请求参数覆盖比较对象，
 * 等于让被保护方之外的人来回答「这是不是我的」—— 门禁于是从判据退化为建议。
 * 参数保留的原意是「没有会话的调用方也能检索」，所以它只在**会话定位不到**时才生效。
 *
 * ── 判据（六条，含两条负向）──────────────────────────────────────────────────────────────────
 *
 *   ① 会话在 A、不传 workspace ⇒ B 的技能不可见（基线，旧代码本来就对）
 *   ② 会话在 A、传 workspace=B ⇒ **被拒绝**，且回执点名两边的工作区（不许静默回落成 A）
 *   ③ `skill_read` 按名字读 B 的技能 ⇒ **被拒绝**，且回执点名它属于哪个工作区
 *   ④ 负向：同一工作区的技能照常可读（不许「一律拒绝」也能过 ②③）
 *   ⑤ 负向：`scope: global` 的技能跨工作区**仍然可读**（这是唯一的合法逃逸，不能连它一起堵）
 *   ⑥ 负向：没有会话可定位时，`workspace` 参数仍然生效（参数的原意不能被顺手删掉）
 *
 * ④⑤⑥ 是这次修改最容易做错的三半：一个收紧范围的修复，很容易收得比漏洞更大 ——
 * 那会让所有跨工作区读取（包括名正言顺的 global 与无会话调用方）一起失效。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
/**
 * `readSkillBody` is imported from its OWN module, not the business barrel: `v202` holds the business
 * surface at exactly 54 names, and this test needs the FUNCTION (to prove it carries provenance), not
 * another public name for it.
 */
import { readSkillBody } from '../lib/store/skill.js'

/**
 * Boot the plugin the way the probe did: services on the context, `ctx.get(name)` as the accessor
 * (that is what `sessionWorkspaceOf` uses), and a caller whose session lives in workspace A.
 */
function makeEnv(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mem-b7-'))
  const workspaceA = join(root, 'ws-A')
  const workspaceB = join(root, 'ws-B')
  const skillsDir = join(root, 'skills')
  const memoryDir = join(root, 'memory')
  mkdirSync(workspaceA, { recursive: true })
  mkdirSync(workspaceB, { recursive: true })
  mkdirSync(skillsDir, { recursive: true })
  mkdirSync(memoryDir, { recursive: true })

  const writeSkill = (name, fields) => {
    const dir = join(skillsDir, name)
    mkdirSync(dir, { recursive: true })
    /**
     * EACH SKILL CARRIES ITS OWN TRIGGER. With a shared `when_to_use`, lexical retrieval returned the
     * `global` skill for every query — it is eligible everywhere — and the cases that must tell
     * workspaces apart measured nothing but the tie-break. The queries below name the skill they mean.
     */
    writeFileSync(
      join(dir, 'SKILL.md'),
      [
        '---',
        `name: ${name}`,
        `when_to_use: ${name} trigger`,
        ...fields,
        '---',
        '',
        `# ${name}`,
        '',
        `${name.toUpperCase()}-BODY`,
        '',
      ].join('\n'),
      'utf8',
    )
  }
  /**
   * NAMES MUST NOT SHARE TOKENS. The first attempt used `skill-in-a` / `skill-in-b` / `skill-global`
   * with queries like 「skill in b trigger」: every name contributed the token `skill`, so `global` —
   * eligible in every workspace — won the lexical match for all three queries and the cases measured
   * the tie-break instead of the boundary. Each skill now carries a unique token that appears nowhere
   * in the others.
   */
  writeSkill('alpha-b', [`workspace: ${workspaceB}`, 'scope: project'])
  writeSkill('bravo-a', [`workspace: ${workspaceA}`, 'scope: project'])
  writeSkill('delta-anywhere', ['scope: global'])

  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    sessions: { get: (id) => (id === 'session-in-a' ? { id, header: { cwd: workspaceA } } : undefined) },
    workingDirectory: { get: () => workspaceA },
    on: () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  ctx.get = (name) => (name === 'llm' ? undefined : ctx[name])

  apply(ctx, {
    dataDir: root,
    memoryDir,
    skillsDir,
    ...(options.workspaceIsolation === false ? { workspaceIsolation: false } : {}),
  })

  return {
    root,
    workspaceA,
    workspaceB,
    skillsDir,
    tools,
    readSkillBody,
    exec: { agent: { id: 'session-in-a' } },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('v299 ①: 会话在 A、不传 workspace ⇒ A 自己的技能可见，B 的不可见（基线）', async () => {
  const env = makeEnv()
  try {
    const result = await env.tools
      .get('memory_search')
      .execute({ query: 'alpha b trigger', semantic: false, threshold: 0 }, env.exec)
    /**
     * THE BASELINE IS 「B IS NOT REACHABLE」, not 「the result is empty」: retrieval legitimately answers
     * with the caller's own skill (the two triggers share the token `trigger`). Asserting null here was
     * my error — it would have been green only if the gate also refused the caller's own corpus.
     */
    assert.notEqual(result.skill?.id, 'alpha-b', `基线：B 的技能不该出现在 A 的检索里，实测 ${JSON.stringify(result.skill?.id)}`)
    assert.notEqual(result.skill?.workspace, env.workspaceB.replace(/\\/gu, '/'), '返回的工作区不能是 B')
  } finally {
    env.cleanup()
  }
})

test('v299 ②: 会话在 A、传 workspace=B ⇒ 被拒绝，且回执点名两边的工作区', async () => {
  const env = makeEnv()
  try {
    const result = await env.tools
      .get('memory_search')
      .execute({ query: 'alpha b trigger', semantic: false, threshold: 0, workspace: env.workspaceB }, env.exec)

    assert.equal(result.skill ?? null, null, '不许因为参数就返回别人的技能')
    const hint = String(result.hint ?? '')
    assert.match(hint, /拒绝/u, `必须是被拒绝，不是静默回落到 A，实测：${hint}`)
    assert.ok(hint.includes(env.workspaceA.replace(/\\/gu, '/')) || hint.includes(env.workspaceA), '回执要点名本会话的工作区')
    assert.ok(hint.includes(env.workspaceB.replace(/\\/gu, '/')) || hint.includes(env.workspaceB), '回执要点名被请求的工作区')
  } finally {
    env.cleanup()
  }
})

test('v299 ③: skill_read 按名字读 B 的技能 ⇒ 被拒绝，且点名它属于哪个工作区', async () => {
  const env = makeEnv()
  try {
    const reply = await env.tools.get('skill_read').execute({ name: 'alpha-b' }, env.exec)

    assert.equal(reply.body, undefined, '别人的技能正文一个字符都不该返回')
    const error = String(reply.error ?? '')
    assert.match(error, /工作区隔离/u, `必须说明是隔离拒绝，实测：${error}`)
    assert.ok(error.includes(env.workspaceB), '必须点名它属于哪个工作区，否则读者只会去改名字')
    assert.doesNotMatch(error, /no skill named/u, '它存在，只是不属于你 —— 两种失败不能混成一句')
  } finally {
    env.cleanup()
  }
})

test('v299 ④: 负向 —— 同一工作区的技能照常可读（不许「一律拒绝」也能过 ②③）', async () => {
  const env = makeEnv()
  try {
    const reply = await env.tools.get('skill_read').execute({ name: 'bravo-a' }, env.exec)
    assert.equal(reply.error, undefined, `本工作区的技能必须能读，实测 ${String(reply.error ?? '')}`)
    assert.match(String(reply.body ?? ''), /BRAVO-A-BODY/u)

    const search = await env.tools
      .get('memory_search')
      .execute({ query: 'bravo a trigger', semantic: false, threshold: 0 }, env.exec)
    assert.equal(search.skill?.id, 'bravo-a', '检索也必须照常返回本工作区的技能')
  } finally {
    env.cleanup()
  }
})

test('v299 ⑤: 负向 —— scope: global 的技能跨工作区仍然可读', async () => {
  /**
   * `global` is the ONE deliberate way a memory escapes its workspace (`workspace.ts:84`). A fix that
   * also closed this would break every global skill, which is a much larger blast radius than the
   * leak it started from.
   */
  const env = makeEnv()
  try {
    const reply = await env.tools.get('skill_read').execute({ name: 'delta-anywhere' }, env.exec)
    assert.equal(reply.error, undefined, `global 技能必须能跨工作区读，实测 ${String(reply.error ?? '')}`)
    assert.match(String(reply.body ?? ''), /DELTA-ANYWHERE-BODY/u)
  } finally {
    env.cleanup()
  }
})

test('v299 ⑦: TD-M21 的探测器 —— 工具层已隔离，函数层仍无门禁（分层记录，不是一句「已隔离」）', async () => {
  /**
   * WHY THIS CASE EXISTS AND WHAT IT IS NOT.
   *
   * It is not a defence of the tool — ③ already proves the refusal. It is the RECORD of a layered
   * truth: `readSkillBody(skillsDir, name)` has no workspace in its signature, so each call site
   * decides whether to check. `skill_read` checks (this file's ③/⑤). `fileCausalSource().skillBody`
   * (`causal.ts:139`) does not — and that is acceptable TODAY only because `causalChain` and friends
   * are exported LIBRARY functions, not registered tools.
   *
   * The day one of them becomes a tool, this case goes red and the TD-M21 exit condition is due. A
   * test that records a gap is worth more than a test that routes around it.
   */
  const env = makeEnv()
  try {
    // ① B7's contribution: the loader now carries the provenance the gate needs.
    const body = env.readSkillBody(env.skillsDir, 'alpha-b')
    assert.ok(body !== undefined, '技能必须能读出来（否则下面的断言测的是别的失败）')
    assert.equal(body.workspace, env.workspaceB, 'SkillBody 必须带回写入时的 workspace —— 否则读取方无从判断')
    assert.equal(body.scope, 'project', 'SkillBody 必须带回 scope —— 没写时按 project，与门禁同一默认')

    /**
     * ② TODAY `skill_read` IS THE ONLY MODEL-FACING READER. If the tool list ever gains a second one
     * (or a `causal*` tool appears), this assertion fails and names the reason.
     */
    const toolNames = [...env.tools.keys()]
    const readers = toolNames.filter((name) => /skill|body|skill_read/u.test(name))
    assert.deepEqual(readers, ['skill_read'], `模型可见的技能正文读取工具应只有 skill_read，实测：${readers.join(', ')}`)
  } finally {
    env.cleanup()
  }
})

test('v299 ⑥: 负向 —— 没有会话可定位时，workspace 参数仍然生效', async () => {
  /**
   * The documented reason the parameter exists: a caller with no session. Removing the parameter
   * outright would have been the easy fix and would have broken that caller, so the gate keeps it
   * for exactly the case where there is nothing better to use.
   */
  const env = makeEnv()
  try {
    const result = await env.tools
      .get('memory_search')
      .execute({ query: 'alpha b trigger', semantic: false, threshold: 0, workspace: env.workspaceB }, {})

    assert.equal(result.skill?.id, 'alpha-b', '无会话时参数就是唯一的工作区来源，它必须生效')
  } finally {
    env.cleanup()
  }
})
