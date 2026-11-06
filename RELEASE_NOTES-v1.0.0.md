# dsh-memory v1.0.0

**发布日期**：2026-11-04
**兼容基线**：DeepSeek Harness 0.2.2-rc.1
**测试**：238 / 238 通过 · `node --check` 通过

---

## 这个版本解决什么

记忆系统此前在生产路径上**静默失效**：没有任何报错，症状只是「从来没有提示」。三个原因叠在一起，前两个是真缺陷。

### P0-1 隔离门把「工作区」解析成了宿主进程目录

**实测契约**：

```ts
'agent/pre-step'(payload: { agent: Agent; messages; turn; step; signal; modelSelection })
export interface Agent { readonly id: SessionId; }   // ← 没有 cwd
```

`currentWorkspaceOf(payload)` 读不到 `agent.cwd`，一路回落到 `process.cwd()`（Electron 应用目录），于是拿 `D:/workspace` 去和它比较——**永不相等**。结果：所有 project 级记忆被拒。这道门不是关着的，是焊死的，而且不报错，与「库是空的」完全不可区分。

`memory_search` 同病：不传 `workspace` 时实测 `blockedByWorkspace: 18`（＝全部文档）。

**修复**：新增 `sessionWorkspaceOf(agentId)` —— `sessions.get(id)` → `workingDirectory.get(session)` → `session.header.cwd`，解析不到返回 `''`（未知工作区 ≠ 任意工作区，仍然 fail-closed）。

- pre-step：`sessionWorkspaceOf(agentId) || currentWorkspaceOf(payload)`
- `memory_search`：新增 `exec.agent.id`，默认工作区取**调用会话**；显式 `workspace` 仍优先。

**修复后实测**（同一句提问，不传 workspace）：`blockedByWorkspace` 消失，`matched: 10`，Top-1 命中 `cold-tape-materialize-slice`（score 0.876）。

### P0-2 过滤器被 provider 拒绝：`does not support reasoning effort "off"`

实测报错：`provider "qiniu" model "deepseek/deepseek-v4.1-flash" does not support reasoning effort "off"`。

每次裁决都抛 → pre-step 路径把它读成「裁判没有意见」→ 每轮退化为严格词法召回；`memory_search` 则 `applied: false`。

**修复**：
1. 命中 `reasoning|effort|unsupported` 类错误时，**去掉 `reasoningEffort` 重试一次**（调用方显式指定 effort 时不重试，无关错误不重试）；
2. 该重试的预算提高到 **4096 token**——实测省掉 effort 字段后适配器默认推理花掉 3593 token，900 预算会以 `max-tokens` 结束且没有 JSON，等于又变成「没有意见」。

### P0-3 控制台开关全部写不进去：`withTimeout is not defined`

与 graft 控制台同源：helper 声明在 fetch effect 内，`write` 是组件作用域闭包 → 每次点击 ReferenceError。**修复**：提升到 factory 作用域 + 静态回归测试。

### P2 记忆提取从未运行

`memory_harvest` 的历史状态是 `processed: 0`——提取器一次都没跑过，技能库里只有 `acceptance-*` 测试夹具。本版本发布时已完成一次完整提取：

- 技能 3 条：`cold-tape-materialize-slice`、`graft-slice-inject-verify`、`plugin-build-regression-baseline`
- facts 6 / experiences 6 / negatives 5

---

## 设计边界（不是缺陷）

`scope: project` 的记忆**只在录制它的工作区可见**，只有显式写了 `scope: global` 才会跨仓库。这是隔离与防污染的地基，不提供「默认放宽」开关。跨项目的规则要跨项目生效，必须由人写进 frontmatter。

---

## 升级注意

- **版本号**：`package.json` / `manifest.json` 统一到 `1.0.0`（与 `dsh-graft-slice` 对齐）。
- **重启生效**：Host 侧模块，重启 DSH 后重新导入 `lib/`；`client.js` 由页面刷新加载。
- **验证口令**（重启后，在 `D:\workspace` 的会话里）：问一句「切片写入失败 cannot append outside a SessionStore 怎么修」，应出现 `cold-tape-materialize-slice` 的提示；`memory_search` 不传 workspace 时 `blockedByWorkspace` 应为 0。
