# ARCHITECTURE — v0.21 技术债登记（dsh-memory）

> 与 `dsh-graft-slice/ARCHITECTURE.md` 同一套规则：登记、写清「为什么现在不动」、给可验收的退出条件。
> **发版前不做大规模代码搬迁。**

## 登记项

### TD-M1 归档 pass 的「合并」只报告不执行（P2，非阻塞）

| 项 | 内容 |
|---|---|
| 现状 | `src/archive.ts` 的 `planSkillArchive` 会在超过 `skillLimit`（默认 100）时给出两类计划：①`merges`（`when_to_use` 语义相似、同 scene 同 workspace 的技能对）②`archive`（最久未用的 10%）。`applySkillArchive` 只执行 ②，①仅作为报告返回 |
| 影响 | 膨胀治理的第二道（归档）已生效，第一道（合并）尚未生效 |
| 为什么现在不动 | 合并要动 `store.ts` 拥有的东西：`evidence` 并集、`conflicts_with` 互链、`supersedes` 链、provenance、`last_used`。任何一处做错都是**证据丢失**，而证据是这套记忆系统唯一的资产。归档是**无损可逆**的（文件仍在、`archived: true` 可改回），所以先做它 |
| 退出条件 | `store.mergeSkills(keeper, absorbed)` 落盘：证据并集（条数 = 两边之和）、冲突链迁移、双方 provenance 保留、写审计行；`applySkillArchive` 改为先合并后归档；新增「合并后证据不丢」与「合并后冲突链完整」两条测试 |

### TD-M2 相似度是词法，不是语义（P2）

| 项 | 内容 |
|---|---|
| 现状 | `whenSimilarity` 用拉丁词 + CJK 二元组的加权 Jaccard，加两道护栏（拉丁词双权、`MIN_COMPARABLE_TOKENS=6`、仅数字不同则判为不同） |
| 影响 | 措辞差异大但语义相同的两条技能不会被合并；这是**漏合并**（安全方向），不是误合并（危险方向） |
| 为什么现在不动 | 语义合并需要一次 LLM 调用，而归档 pass 跑在**激活路径**上；引入一次模型调用会让宿主启动依赖 provider 可用性——这正是 v0.21 加 LLM 警告要暴露的问题 |
| 退出条件 | 提供一个**可选**的 `semanticMerge: true`，只在显式工具调用（`memory_archive --semantic`）里跑模型；激活路径永不变慢 |

### TD-M3 负知识时效只看 `hits` 与年龄（P2）

| 项 | 内容 |
|---|---|
| 现状 | `isStaleNegative` 判据：`ageDays > 30` 且 `hits <= 1` ⇒ 降权 0.5 并加 `[历史偶发错误，仅供参考]` 前缀 |
| 影响 | 「当时报错上下文与当前不符」这一条目前用**年龄 + 未复发**代理，没有真正比对上下文 |
| 为什么现在不动 | 真正比对上下文需要把当前任务词与负知识的 `symptom/cause` 做语义比较，属于 TD-M2 的同一类成本 |
| 退出条件 | 复用 task-alignment 的 `taskTerms`：当负知识的领域词与当前任务零交集时，额外降权并在前缀里写明「领域不符」；需一条「同领域旧负知识不降权」的对照测试 |

### TD-M4 控制台与工具两条路径共享实现，但状态读取有重复（P3）

| 项 | 内容 |
|---|---|
| 现状 | `memoryConsoleState` 与 `memory_stats` 各自组装统计；`listSkillSummaries`（archive.ts）与 `listSkillRecords`（store.ts）都在读 SKILL.md frontmatter |
| 影响 | 两处解析规则若漂移，控制台与工具会给出不同数字 |
| 退出条件 | 统一到 `listSkillRecords`，`archive.ts` 只消费它的输出；加一条「控制台与 memory_stats 的技能计数一致」的测试 |

---

## 本次发版（v0.21）**不做**的事

- 不实现技能合并的落盘（TD-M1）。
- 不给激活路径加任何 LLM 调用（TD-M2）。
- 不改负知识时效的判据（TD-M3）。
