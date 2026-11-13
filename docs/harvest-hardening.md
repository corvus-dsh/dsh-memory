# memory_harvest 加固 backlog（冻结期后评估）

> 本文档**只是 backlog**：冻结期内不据此修改任何代码。每一项都标了"为什么值得做"和"不做会怎样"，
> 以便解冻后按优先级排期。全部数字来自 2026-11-08 的首跑实测，不是估计。

> ## 迁入本仓的理由（2026-11-14）
>
> 本文原先躺在工作区根的 `D:\持久层能力架构\docs\backlog\harvest-hardening.md` —— **不在任何 git 仓里**。
> 于是它虽然写下了硬约束（见 §C2 的「约束迁移条件」），却**不受版本控制**：
> 改错了没有 diff，删掉了没有记录，别人 clone 这个仓也看不到它。
>
> **约束记录不受版本控制，等于没写。** 它讲的是 `dsh-memory` 的 `harvest` 行为，
> 所以归位到 `dsh-memory/docs/`；同时把文中引用的 3 份事故证据
> （`docs/incidents/2026-11-08-harvest/`）一并迁入，否则文档里的路径是断的。

## 触发事件

2026-11-08 首跑，3/3 抽取失败，零写入，诊断文件 3 份。

实测细节（供解冻后复现）：

| 项 | 实测值 |
|---|---|
| 命令 | `memory_harvest`（无参数，`harvestLimit: 3`） |
| 报告 | `ok:false`，`scanned:3`，`harvested:[]`，`skipped:[]`，`suggestionsQueued:0` |
| 台账 | `epoch {retired:2,transferred:2}`，`deferred:false`，`skipped:[]`（布局清单 + epoch 两道闸门都过） |
| 被尝试的会话 | `auto-graft-mw3jlyw8-mnypmg`、`auto-graft-mw3ob7d3-rzsy6u`、`auto-graft-mw630kov-3fv4mo`（台账数组顺序前三） |
| 记录写入 | **零**：`negatives/facts/experiences/suggestions/processed/negatives-archive` 全部 `absent -> absent` |
| 诊断落盘 | 3 份 `last-extraction-raw-*.txt`（862B / 734B / 13B），已移入 `docs/incidents/2026-11-08-harvest/` |
| 耗时 | 诊断文件名时间戳 `13:51:23Z → 13:52:37Z`，首末跨度 **74 秒**（含收尾报告约 80–90 秒） |
| token | **harvest 报告不含 token 字段**；会话级读数 `399,109 → 556,017`（+156,908）覆盖了同期面板排查与第 1 组四批工作，**不可归因于本次 harvest** |
| 退避 | `processed.json` 未被写入 ⇒ 这 3 个会话保留在下一轮队列里 |

失败原文（两份带工具标记、一份为空）见 `docs/incidents/2026-11-08-harvest/`。

## A. 抽取鲁棒性（extract.ts）— 优先级中

- A1 抽取调用禁止工具（tools:[] / tool_choice:none）
- A2 工具标记识别 → 报特定错误码（禁止"剥离后强行解析"，会掩盖真实失败）
- A3 空回复 vs 超时的错误码区分

  **A3 要区分的三种成因（行级定位）**：`raw` 只由 `type === 'text-delta'` 的块拼装
  （`extract.ts:685-690`），因此 **null content / 无 choices / 流被中止** 三者当前**全部塌缩成 `''`**，
  在插件侧不可区分；`rawText` 又只在 `lastRaw.length > 0` 时返回（`:705-714`），所以"空"只剩一个
  `undefined` 信号。A3 的工作就是在这三处**分别**给错误码（例如 `extract/no-content` /
  `extract/no-choices` / `extract/aborted`），而不是继续共用一个 `(empty reply)`。

补充实测（帮助定位，不改变结论）：

- 两份带标记的回复：正文是**会话内容的口吻**（"我来接着处理交接单的第一项…"），
  后面跟着**泄漏的工具调用标记**。抽取的输入恰好是"内容本身读起来像指令"的交接会话。
- 第三份是 **13 字节的 `(empty reply)`** —— 这是插件在 `rawText` 为 **null/undefined** 时写的占位符。
  换句话说：**不是 `content: ""`，而是根本没有 content**（无 choices 或 null 内容）。
  A3 要区分的正是这两种；当前实现用 `?? '(empty reply)'` 把它们合并成同一份诊断文件。

## B. 无限重试成本 — 优先级高

- B1 `processed.json` 不更新导致失败会话每次重跑，无退避
- B2 建议：`failure_count` + 指数退避，或 harvest 级 `max_retry`
- B3 注意：B 不修，A 每拖一天成本线性增长

补充实测：失败**不写 `processed.json`** 是**刻意的**设计（"一次失败的**调用**不等于这个会话没有东西可提炼"，
见 `src/index.ts` 失败分支的注释）。所以 B 不是"修 bug"，而是**给一个正确的选择加成本上限**——
这正是它比 A 更优先的原因：A 一天不修，B 的成本每天按 harvest 调用次数累积。

## C. 观测缺口 — 优先级高，不需改代码

- C1 第三个会话 60 秒空回复的 provider 侧归因

  **实测时序（待补测；beta.1 发布前必须完成）**：现有诊断**每个会话只在重试循环结束后写一次**
  （文件名里的时间戳＝**写入时刻**），所以它只能给出"该会话总耗时"，**无法**区分
  `for attempt < 2` 中究竟是**第 1 次**还是**第 2 次**吃掉了那 60 秒。

  已测事实：
  | 会话 | 总耗时 | 返回 |
  |---|---|---|
  | `auto-graft-mw3jlyw8-mnypmg` | 约 14 秒（13:51:23 写入） | 正文 + 泄漏的工具标记（**非**超时） |
  | `auto-graft-mw3ob7d3-rzsy6u` | 约 14 秒（13:51:37 写入） | 正文 + 泄漏的工具标记（**非**超时） |
  | `auto-graft-mw630kov-3fv4mo` | **60 秒整**（13:52:37 写入） | `rawText` 为 undefined（`(empty reply)`） |

  补测方法（**不改 `extract.ts`**）：在 `_scratch` 里复刻同一段 `llm.stream` 调用
  （同 system、同 messages、同 `AbortSignal.timeout(60_000)`）跑两次并**各自计时**，
  并在报告里明确标注这是**复现测量**、不是原始运行的分解；
  若允许再投入一次模型调用，则给该会话单独跑一次带"每尝试时间戳"的诊断。
  provider 侧日志不在本工作区可读范围内，因此 provider 归因只能由复现测量间接支持。

  **已完成的第一步——机制测量（零 token，2026-11-08）**：`_scratch/c1-timeout-measure.mjs` 本地复刻
  该循环的形状（async iterable 只由信号结束；同一 `AbortSignal.timeout(60_000)`），实测：

  | 尝试形态 | 实测耗时 | 返回 |
  |---|---|---|
  | 挂起（永不产出块，60s 信号） | **60,004 ms** | `raw` 长度 0 → `rawText` **undefined**（与第三个会话签名完全一致） |
  | 立即结束、无 JSON | **0 ms** | 同上 |

  **推论（有实测支撑，非假设）**：观察到的会话总计 ~60,000 ms ⇒ 该会话**恰好只有一次挂起尝试**；
  两次挂起会是 **≥120,004 ms**。所以另一次尝试是**快速失败**（解析路径同步、耗时 0 量级）。
  **仍然未测**：究竟是第 1 次还是第 2 次挂起——那需要真实调用里的每尝试时间戳，本项保持"待补测"。
- C2 `extract.ts` 模型调用入口与通道确认

  **已确认（2026-11-08）**：入口是 `extractEpisode`（`extract.ts:653`），调用链
  `memory_harvest → harvest() → ctx.get('llm') → extractEpisode() → llm.stream({system, messages:[{role:'user'}]})`
  ——即**宿主 `llm` 服务直连**，`system` 字段承载抽取指令、user 消息只承载会话正文，
  **不写任何 session event**。

  **约束迁移条件（记录，不是现在做）**：正因为不产生 session event，硬约束里的 role 规则
  （必须 `type:'user/message'` + `role:'user'`、文本前加 `[系统提示]`、**绝不用 user 壳装 developer 指令**）
  **当前不适用**。一旦 harvest 为了审计目的**改走 session event 通道**（把抽取请求写成会话消息），
  上述三条**立即适用且无例外**：抽取指令必须以 `[系统提示]` 前缀出现在 `role:'user'` 消息里；
  不得用 `developer/message` 承载用户可见的交接语义，也不得反向伪装。迁移时必须同步更新本节与相应测试。
- C3 诊断文件内容边界与保留策略

补充实测：

- C1：第三个会话（`auto-graft-mw630kov-3fv4mo`）单独占了 **60 秒整**（`13:51:37 → 13:52:37`），
  前两个各约 14 秒。60 秒这个整数边界像是某一层超时，但**provider 侧日志不在本工作区可读范围内**，
  因此归因待确认（见主报告的"问题 3"）。
- C3：诊断文件是**原始模型回复**，可能包含会话正文（本次两份就含有工作区路径与工具调用意图）。
  当前策略是"写进活动 store 目录"，本次已手工移出为事故证据。建议明确：写到哪、保留多久、是否脱敏。

## 明确不做

- 冻结期内不改 `extract.ts` 任何一行
- 不剥离工具标记后强行解析

---

*创建：2026-11-08，随批次 3 报告一并交付。禁止在冻结期内把本文件当作施工单。*
