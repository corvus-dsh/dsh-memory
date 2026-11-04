# ARCHITECTURE — v0.22 技术债登记（dsh-memory）

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

### TD-M5 降级路径的常量曾跨模块未定义（P0 已修，登记以防复发）

| 项 | 内容 |
|---|---|
| 现状 | **v0.22.0 首发版真实缺陷**：`retrieve.ts` 的 `degradeOnTimeout` 回退分支引用了 `DEFAULT_RETRIEVAL_THRESHOLD`，但该常量定义在 `index.ts`，而 `index.ts` 已 `import` 自 `retrieve.js`——反向导入即成环。于是回退分支在**自己的 catch 块里**抛 `ReferenceError`，把「judge 超时」换成了「崩溃」。那道用来保住这一轮的水位线，自己把这一轮弄丢了 |
| 影响 | pre-step 的语义过滤一旦超时（慢网络下的常态），本该退化为严格词法召回，实际是中断本轮 hint 并冒泡异常；`memory_search` 路径不受影响（不设 `degradeOnTimeout`），所以现场看起来"有时正常" |
| 为什么现在才暴露 | 旧测试只覆盖了「judge 失败 ⇒ fail closed」，从未覆盖「judge 失败 + `degradeOnTimeout` ⇒ 严格词法」。缺的不是断言，是那条分支的存在性测试 |
| 修法 | 常量下沉到叶子模块 `retrieve.ts`（它才是使用者），`index.ts` 改为 `export { ... } from './retrieve.js'` 并显式再导入供自用；`test/v022-progressive-disclosure.test.mjs` 用「不包 assert.throws 直接 await」的方式钉住该分支，`ReferenceError` 会让它失败 |
| 退出条件（已达成） | ①`DEFAULT_RETRIEVAL_THRESHOLD` 与使用点同模块；②降级分支有独立测试且不抛；③降级只降到 0.55（严格），绝不降到 0.20（网底） |

### TD-M6 阈值常量的「单一出处」比 v0.21 更迫切（P2，升级自 TD-3）

| 项 | 内容 |
|---|---|
| 现状 | TD-M5 的根因不是笔误，而是同一批阈值常量分散在 `index.ts` / `retrieve.ts` / `archive.ts`，谁引用谁都要想「导入方向会不会成环」 |
| 影响 | 每次新增引用点都是一次「会不会成环 / 会不会未定义」的判断；ESM 的循环导入在纯类型上不报错，只有在**运行到那一行**时才炸——正是 TD-M5 的形态 |
| 退出条件 | 新建 `thresholds.ts`（零依赖叶子模块）承载 `FLOOR` / `THRESHOLD` / `MERGE_SIMILARITY` / `TASK_TERM_LIMIT` / `NEGATIVE_STALE_DAYS` / `FILTER_MAX_CANDIDATES`；所有模块只从它导入；加一条「`src/` 内无跨层反向常量导入」的静态检查测试 |

### TD-M7 负知识时效只看 `hits` 与年龄（P2）

| 项 | 内容 |
|---|---|
| 现状 | `isStaleNegative` 判据：`ageDays > 30` 且 `hits <= 1` ⇒ 降权 0.5 并加 `[历史偶发错误，仅供参考]` 前缀 |
| 影响 | 「当时报错上下文与当前不符」这一条目前用**年龄 + 未复发**代理，没有真正比对上下文 |
| 为什么现在不动 | 真正比对上下文需要把当前任务词与负知识的 `symptom/cause` 做语义比较，属于 TD-M2 的同一类成本 || 退出条件 | 复用 task-alignment 的 `taskTerms`：当负知识的领域词与当前任务零交集时，额外降权并在前缀里写明「领域不符」；需一条「同领域旧负知识不降权」的对照测试 |

### TD-M4 控制台与工具两条路径共享实现，但状态读取有重复（P3）

| 项 | 内容 |
|---|---|
| 现状 | `memoryConsoleState` 与 `memory_stats` 各自组装统计；`listSkillSummaries`（archive.ts）与 `listSkillRecords`（store.ts）都在读 SKILL.md frontmatter |
| 影响 | 两处解析规则若漂移，控制台与工具会给出不同数字 |
| 退出条件 | 统一到 `listSkillRecords`，`archive.ts` 只消费它的输出；加一条「控制台与 memory_stats 的技能计数一致」的测试 |

---

## 本次发版（v0.22）**不做**的事

- 不实现技能合并的落盘（TD-M1）。
- 不给激活路径加任何 LLM 调用（TD-M2）。
- 不改负知识时效的判据（TD-M7）。
- 不搬迁 `index.ts` / `retrieve.ts` 的大段代码，也不新建 `thresholds.ts`（TD-M6 只登记）。

TD-M5 是**已修复的 P0**，登记在此是为了留住根因：一个常量放错层，被 ESM 循环导入掩盖成运行时未定义，而唯一的守卫在 catch 块内部。修复已由 `test/v022-progressive-disclosure.test.mjs` 的「超时后必须降级」一条锁定。
