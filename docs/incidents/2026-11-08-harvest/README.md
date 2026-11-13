# 2026-11-08 `memory_harvest` 首跑事故证据

**证据文件，beta.1 后作为修复输入，不随 profile 备份，不进知识库。**

## 这里面是什么

| 文件 | 字节 | 内容 | 说明 |
|---|---|---|---|
| `last-extraction-raw-2026-11-08T13-51-23-397Z.txt` | 862 | 英文散文 + **泄漏的工具调用标记** | 会话 `auto-graft-mw3jlyw8-mnypmg` 的抽取回复 |
| `last-extraction-raw-2026-11-08T13-51-37-256Z.txt` | 734 | 中文散文 + **泄漏的工具调用标记** | 会话 `auto-graft-mw3ob7d3-rzsy6u` 的抽取回复 |
| `last-extraction-raw-2026-11-08T13-52-37-698Z.txt` | 13 | `(empty reply)` | 会话 `auto-graft-mw630kov-3fv4mo`；**13 字节 ⇒ 插件在 `rawText` 为 null/undefined 时写的占位符**，不是空字符串 |

**为什么在这里而不是在 store 里**：它们是**事故证据**，不是知识记录。留在活动 store 目录会污染
"活动区"的语义（那里应当只有知识/状态文件），所以 2026-11-08 从
`<memoryDir>`（`C:\Users\89283\.dsh\profiles\desktop\.dsh-memory`）**移动**到这里，**原文件名保留**——
文件名里的时间戳是"每次抽取尝试发生在何时"的唯一记录（也正是这三个时间戳给出了 74 秒的总跨度）。

## 边界（必须遵守）

- **不随 profile 备份**：它们不属于 profile 的运行时状态，备份 profile 时不要带上本目录。
- **不进知识库**：不要被 `memory_harvest`/`knowledge_*` 吸进去；它们是输入给"修复"的原始素材。
- **不进版本控制**：本目录位于工作区根（不属于四个插件仓中的任何一个），因此不受任何仓库
  `.gitignore` 管辖；它们**只作为本地证据**存在，不提交、不随包发布。

## 读取须知

这两份回复包含**会话正文片段**（工作区路径、命令意图）。作为修复输入可以，**不要**把它们贴进
公开 issue、文档或任何会被发布的地方；需要引用时只引用结构性事实（"回复里出现了工具调用标记"、
"空回复"），不要复制正文。

## 关联

- backlog：`docs/backlog/harvest-hardening.md`（A2/A3 直接由这几份文件驱动）
- 台账基线：`_scratch/harvest-baseline.json`（跑前快照）与
  `<memoryDir>.bak-harvest-1794145865705`（整目录备份）
