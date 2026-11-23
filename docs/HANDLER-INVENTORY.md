# handler-inventory · dsh-memory

> 生成物：`node scripts/handler-inventory.mjs --write`。**不要手改** —— 它每次从头扫源码。
> `facts` / `movable` / `why` 来自 `docs/handler-inventory.json`（判断，不可机械提取）。

## tool · 16

| # | 名称 | 位置 | 行数 | 读/写的事实 | 可搬 | 理由 |
|---|---|---|---:|---|---|---|
| 1 | `memory_harvest` | src/index.ts:1207-1219 | 13 | 读 retired 会话日志 + memory store；写 negatives/facts/experiences/suggestions、盖 harvestedAt（经 graph 写入路径） | 是 | 提取与写入是两个动作，写入半（markHarvested + writeKnowledge）已可独立成 handler；搬走之后 apply 只剩注册。 |
| 2 | `memory_suggestions` | src/index.ts:1221-1229 | 9 | 只读 suggestions 队列 | 是 | 纯读工具，依赖只有 resolveConfig 的目录。 |
| 3 | `memory_approve` | src/index.ts:1231-1237 | 7 | 读 suggestions；写 skills 存储 + processed 标记 | 是 | 与 memory_reject 共用队列语义，可整族搬出（建议三件套一起搬，别单搬一个）。 |
| 4 | `memory_reject` | src/index.ts:1239-1245 | 7 | 读 suggestions；写 processed 标记（不写技能） | 是 | 同 memory_approve；单搬会让「队列两侧」分居两个文件。 |
| 5 | `memory_stats` | src/index.ts:1247-1355 | 109 | 只读：技能数、飞轮、任务图计数、台账状态 | 是 | 面板与工具读同一份数字（一个生产者两个出口），搬出时必须连 flywheelStatsOf 一起。 |
| 6 | `memory_migrate_evidence` | src/index.ts:1357-1388 | 32 | 读 knowledge/负知识文件；就地重写 evidence 指针 | 是 | 一次性修复工具，依赖只有目录与 normalize 助手。 |
| 7 | `memory_search` | src/index.ts:1424-1511 | 88 | 只读：词法召回 + 语义裁决；受 workspace 隔离门禁 | 是 | 检索本体已在 retrieve.ts；这里只是接线，搬走成本低。 |
| 8 | `memory_forget` | src/index.ts:1513-1533 | 21 | 写：删除一个技能记录（受 workspace 归属检查） | 是 | 破坏性工具，判据已钉住路径穿越；搬出时判据随迁。 |
| 9 | `knowledge_query` | src/index.ts:1543-1576 | 34 | 只读：按 nodeType / tags 查询知识库 | 是 | knowledge.ts 已拥有查询；这里只是 expose。 |
| 10 | `knowledge_harvest` | src/index.ts:1578-1655 | 78 | 写：知识条目 + 经 activeNodeIdsForHarvest → markHarvested 盖节点章（写入路径） | 是 | 与 memory_contribute 同一条写入链，建议一起搬，否则「盖谁的章」会有两个所有者。 |
| 11 | `memory_contribute` | src/index.ts:1657-1787 | 131 | 写：单节点知识条目 + 只盖该节点的章 | 是 | 节点级入口；与 knowledge_harvest 的批量入口共用 markHarvested，搬出时必须保持一个所有者。 |
| 12 | `knowledge_read` | src/index.ts:1789-1806 | 18 | 只读：一条知识条目的正文 | 是 | 纯读。 |
| 13 | `knowledge_stats` | src/index.ts:1808-1845 | 38 | 只读：知识库计数（按 kind） | 是 | 纯读。 |
| 14 | `memory_graph_read` | src/index.ts:1855-1884 | 30 | 只读：任务图三态读取（absent/unreadable/ok）+ 节点 + 计数 + 当前阶段 | 是 | 读取规则已在 graph-read.ts；这里只剩装配。搬出后 G-8b 的「不递交数据」规则仍有唯一所有者。 |
| 15 | `<graphUpdateTool>` | src/index.ts:1887-1895 | 9 | 写：任务图变更（add/update/complete/lock-goal/constrain/…），经 graph-tool.ts 的 V3_FORWARD 装配 | 部分 | 注册已委托给 graph-tool.ts（工厂），本体不在 index.ts；不宜再搬，否则多一层转发。 |
| 16 | `skill_read` | src/index.ts:1897-1969 | 73 | 只读：技能正文（受 workspace 域授权门禁） | 是 | 纯读 + 门禁；门禁谓词在 retrieve 侧，搬出安全。 |

## command · 4

| # | 名称 | 位置 | 行数 | 读/写的事实 | 可搬 | 理由 |
|---|---|---|---:|---|---|---|
| 1 | `memory-console` | src/index.ts:2734-2741 | 8 | 只读：单会话控制台状态（含 degraded 三态） | 是 | 与 -global 共用 memoryConsoleState；两个命令应一起搬。 |
| 2 | `memory-console-global` | src/index.ts:2757-2765 | 9 | 只读：会话无关的控制台状态 + 会话列表（面板实际调用这条） | 是 | 同上；面板契约在这里，搬出时 client.js 的字段名不动。 |
| 3 | `memory-console-set` | src/index.ts:2766-2776 | 11 | 写：一个开关落盘（configEditor） | 是 | 写路径短，依赖 configEditor 与可写键表。 |
| 4 | `memory-console-clear` | src/index.ts:2777-2801 | 25 | 写：把当前 workspace 的记忆移入隔离目录（不删除 global 与其它 workspace） | 是 | 破坏性操作，判据已钉住「不删 global / 不删其它 workspace」；搬出时判据随迁。 |

## event · 2

| # | 名称 | 位置 | 行数 | 读/写的事实 | 可搬 | 理由 |
|---|---|---|---:|---|---|---|
| 1 | `agent/turn-stopping` | src/index.ts:1985-2027 | 43 | 读写 monitor 态：判定是否需要注入提醒（相位横幅 / 提炼提醒） | 难 | 闭包持有 resolved 与两个去重 Map（lastPhaseKey / lastHarvestWarn）；搬出需要先抽出「注入状态」这个对象。 |
| 2 | `agent/pre-step` | src/index.ts:2237-2424 | 188 | 写：向本回合注入消息（阶段横幅 / 提炼提醒 / 检索提示），并读 memory store 决定说什么 | 难 | 同上，且它是唯一拥有「一条消息是否已注入过」的地方；搬出前必须先有注入状态的单一所有者。 |

## adapter-entry · 0

**这一类是 0，理由是事实：** memory 是存储层插件：它对外只通过 ctx.tools / ctx.commands / ctx.on 三种面注册，自身不提供任何 adapter 或 dispatcher 注册项。适配层（dispatcher / adapters / launcher / workflow）在 dsh-paradise，注册面也在那边。这一格是 0 是事实，不是漏扫。

