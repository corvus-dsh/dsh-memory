# dsh-memory v0.15.0 — 双时态记忆、取代裁决、来源分级（跨仓库统一版本号）

**发布日期**：2026-11-03　**状态**：预发布（v0.8.x → v0.15.0）　**测试**：138/138（+11）

> 版本号说明：本次把 `dsh-graft-slice` 与 `dsh-memory` 统一到 **v0.15.0**（`package.json` / `manifest.json` /
> README 三处对齐），与「七道防线」同批发布。graft 侧记 `v0.14.0/v0.15.0`，memory 侧记 `v0.15.0`。

---

## 为什么做

v0.8.x 解决了「哪条记忆能进这个会话」（工作区隔离 + 注入前防污染），但答不出三个更基本的问题：

1. **它什么时候不再为真？** 旧做法只有「删除」和「保留」两种。删掉就毁掉审计线索，保留就会拿一条
   已经过期的规则去指导今天的动作（真机样本：一条“立刻删除某脚本”的指令沿 5 代迁移全部留存）。
2. **新规则是替代还是备选？** `conflicts_with` 只说“两者互斥，请问用户”；当用户其实已经拍板时，
   并列提示变成每次都要重新问一遍。
3. **这话是谁说的？** 用户原话、跑通过的工具结论、模型自己的归纳，此前在提示里长得一模一样。

## 1. 双时态有效性

- `SKILL.md` frontmatter 与 `negatives.jsonl` 记录新增 `valid_at` / `invalid_at` / `superseded_by`。
- 检索新增**激活门**：`invalid_at` 为空或晚于当前时间才激活；被挡下的条数由 `debug.blockedByInvalid` 报告。
- 旧记忆**不删除**。取代时 `invalid_at` = 继任者的 `valid_at`，互链，一对记录即一条时间线。
- 合并（同名技能再写入）不会覆盖原有的 `valid_at` / `invalid_at`：改措辞不等于复活。

## 2. 取代裁决（supersede）

- `filter.ts` 的一次模型调用同时返回 `apply` 与 `supersede`；取代 id 与 apply 一样要过「候选列表白名单」，
  幻觉 id 直接丢弃；两条候选的 `provenance` 由**候选表**带入判定，不信模型自述。
- `store.applySupersede()` 执行落盘：旧记录 `invalid_at` + `superseded_by` + 正文「## ⚠️ 已被取代」，
  新记录 `supersedes` + 正文「## 取代」。
- 判定结果（含被拒绝的）追加到 `<memoryDir>/.memory-audit.jsonl`，带 query、双方 id、理由与来源标签。
- **人工否决权**：`human` 来源的记忆不会被 `tool` / `inferred` 的推断失效 → `refused:human-loser-protected`。
- 检索保持只读：判定在 `retrieve.ts` 产生，写入通过 `onSupersede` 回调交给调用方（pre-step 注入路径）；
  手动 `memory_search` 预览**不落盘**，只报告“它会怎么做”。

## 3. 来源可信度分级（provenance）

- `deriveProvenance(evidence, events)`：引用里有真人 `user/message` → `human`；否则有成功 `tool/result` → `tool`；
  否则 `inferred`。**不由抽取模型自报**。
- 提示渲染：非 `human` 的技能追加 `[来源：工具推断，请核实]`，且该标记不会被长度上限裁掉。
- 冲突消解：`preferHumanInConflict()` 让 `human` 一方占据主位；**没有冲突声明时不重排**（相关性的归相关性）。

## 验证

138/138（新增 11 条，`test/v015-bitemporal.test.mjs`）：窗口激活/失效、`invalid_at` 在未来仍有效、
负知识同窗口、取代互链与审计、重复取代幂等、人工否决权（含反向允许）、裁决解析与幻觉 id 丢弃、
pre-step 落盘 vs 预览只读、provenance 推导（含“用户优先于成功运行”）、提示标记与长度上限、
冲突中 human 占主位而普通检索不重排。

---

# 以下为 v0.7.1 内容

# dsh-memory v0.7.1 — 深水区：场景分类、使用效果闭环、版本冲突、证据迁移

**发布日期**：2026-11-03　**状态**：预发布（v0.6.0 → v0.7.1）　**测试**：107/107（+11）

---

## 为什么做

v0.7.0 让只读（read/grep）证据通过了强反查，但审计又指出三个会在真实使用中扩散的问题：
场景路由靠词表，「搞个本地存储」命中不了 database；技能写下来后没有任何使用效果反馈，
错了也一直是满分；触发条件相同但 Python 3.8 / 3.12 步骤不同的两条技能会被合并成一条，
结果哪一版都跑不了。

## 1. 场景分类改为一次极小 LLM 调用
- `classifyScene()`：候选词表来自 `collectScenes()`（提取器自己产出的 scene，不写死）；
  输出只接受词表内标签或 `general`，失败/超时/乱造词一律降级 `general`。
- 查询 + 词表结果缓存 10 分钟；`general` 表示「没有明确领域」，**不设门**（召回失败不能
  变成记忆消失）。
- 旧 `inferScene()` 词表只保留给同步离线的 `retrieve()` 作确定性兜底，实时链路不再使用。

## 2. 使用效果闭环（turn-stopping）
- 本轮注入过哪些技能，pre-step 记下；turn-stopping 看本轮是否出现失败的 tool/result：
  干净收尾 → `confidence +0.05` 且 `last_validated = now`；有报错重试 → `confidence -0.1`。
- `confidence` 落进 SKILL.md frontmatter（缺失按 1.00），参与检索排序；下限 0.2，
  失败不会让技能消失，只会让它排后面。

## 3. 版本/环境差异禁止合并
- `environmentDivergence()` 从 when + steps 抽 `python3.8 / node20 / windows / docker …`；
  触发条件高度相似但环境 token 无交集 → **不合并**，写 `name-2` 并双向 `conflicts_with`。
- 环境相同仍然正常合并，避免把防漂移写成「永不合并」。

## 4. 裸 seq 存量迁移
- 新工具 `memory_migrate_evidence`：把 SKILL.md / negatives / facts / experiences 里的
  裸 seq 改写成 `{sourceSessionId, seq}`（或 `sid@seq`）；未给 sessionId 时取台账中
  最新一次转移；幂等，二次运行为空操作。
- Fact/Experience 落盘也改为复合证据，检索端两种形状都能读。

## 5. Windows 并发读写的真实修复
- 极限一致性测试（5 进程读 + 1 进程写）暴露：目标文件被读进程打开时，
  `renameSync` 抛 `EPERM`，一次并发**读**会把写入打失败。
- `atomicWrite()` 对 `EPERM/EACCES/EBUSY` 做有界重试（最多 40 次、退避 ≤55ms），
  保持 tmp→rename 的原子性。

## 验证
- 107/107：新增 11 条（只读证据、日常措辞场景分类、分类失败降级、场景隔离、
  3.8 vs 3.12 不合并、相同环境仍合并、正负反馈与下限、低置信降权、裸 seq 迁移幂等、
  5 读 1 写无撕裂行）。
- `node scripts/extreme-consistency.mjs`：11/11（进程级 5 读 1 写、只读工具提取、
  3.8/3.12 冲突数据）。

---

# 以下为 v0.6.0 内容

**发布日期**：2026-11-03　**状态**：预发布（v0.5.0 → v0.6.0）　**测试**：96/96

---

## 改了什么

1. **scene 场景路由**：Fact / Experience / Negative / Skill 全部带 `scene`（开放词表，非法值→general）。
   检索先推断 query 的 scene，只激活同 scene 或 general 的条目——UI 提问不会再激活数据库技能。
2. **复合证据**：evidence 统一存 `{sourceSessionId, seq}`，SKILL.md 写作 `sid@seq`；
   「事实回查」提示直接给 `sessionId + seq`，可 `graft_search_history` 反查。旧裸 seq 仍可读。
3. **强反查**：技能必须通过真实日志校验——引用的工具调用必须有成功结果、工具结果不能是错误；
   **只有助手叙述、没有工具结果 → 拒绝写入**（harvest 的 `dropped` 会写明原因）。
4. **四层检索**：Fact / Experience 也进入检索与提示（「事实回查：上次在 sid seq=X 发生过 …」
   「经验回查：…」）。

## 验证

- 96/96；新增 6 条：scene 校验与开放词表、`sid@seq` 往返、场景隔离（UI 查询不激活 database 技能）、
  事实/经验召回与回查提示、强反查四种证据形态、harvest 拒绝纯叙述技能。
- 三项目 E2E 中每个项目的技能只引用**自己的** session id，无串号。

---

# 以下为 v0.5.0 内容

# dsh-memory v0.5.0 — 自我证伪与遗忘：错误经验不能带执行权威

**发布日期**：2026-11-03　**状态**：预发布（v0.4.0 → v0.5.0）　**测试**：90/90

---

## 为什么做

记忆系统最危险的状态不是“想不起来”，而是**把一次错误经验固化成永久技能**：
一条负知识说“用 A 必报错”，一年后 A 早已修好，模型却仍被它挡住；一条技能没人再用，
却和新技能同权竞争。v0.5 给每条记忆加了三道“可被现实推翻”的接口。

## 1. 作用域与别名（scope / aliases）

- 抽取时强制声明 `scope: workspace | project | global`；缺失/非法一律降级 `project`，**不猜**。
- 每个技能 2-3 个 `aliases`（“别人会怎么问”），参与词法召回：
  “连数据库”能命中 pymysql 技能，从而**降低对 0.20 低阈值的依赖**。
- SKILL.md frontmatter 新增 `scope` / `aliases` / `last_used` / `last_validated`；旧文件缺字段按默认值处理。

## 2. 反向证据（counter_evidence）

`agent/turn-stopping` 与 harvest 各扫一遍工具结果：

- 负知识里提到的工具，本次**成功**执行，且结果里不再出现原症状 → 追加该 seq 到 `counterEvidence`；
- `confidence` 每次 -0.2（下限 0.2），检索 `importance × confidence`，规则**保留但降权**；
- 提示改说“曾翻车，但已有 N 条反向证据，可信度 80%”，而不是继续当铁律；
- 成功结果仍带原症状 → 不算推翻（避免“修复没生效”被当成证伪）。

## 3. 冲突按新旧排序

`conflicts_with` 不再平铺：按 `updated / last_validated` 取最新，提示写成
“两套互斥做法，**最新的是 X**，另一套是 Y，先确认用哪一套”。

## 4. 惰性衰减（14 天）

`last_used` 在提示真正注入时刷新；`last_validated` 在写入/新证据时刷新。
两者都超过 14 天 → 召回权重 ×0.5，并在提示末尾追加
“注意：此技能较久未被验证，请结合当前环境谨慎使用。”（提示上限从 120 放宽到 220，
警告不能被截断）。

## 5. 并发与延迟（乐观写入 + 裁决缓存）

- **乐观写入**：harvest 在 LLM 调用前后比对 `snapshotStoreVersion`；期间发生并发写入 →
  **合并重写**并记 `mergedConcurrentWrites`，**绝不第二次调用 LLM**；写入异常重试 3 次
  （`writeRetries`），重试期间也不重新抽取。
- **锁粒度**：SKILL.md/JSONL 仍是 tmp+rename 原子落盘；harvest 不持全局锁，
  graft 的悲观锁只保护交接写盘，两者互不阻塞。
- **裁决缓存**：相同 `(query, 候选 id+分数)` 10 分钟内复用上一次裁决；
  `filterCacheStats()` / `clearFilterCache()` 可观测与清理。

## 真机与测试

- **90/90**：新增 10 条深水区用例（scope/aliases 校验与向后兼容、别名召回、反向证据降权与
  负例、陈旧衰减与再验证、缓存命中、并发 harvest 只调一次 LLM、版本戳变化）。
- 线上 11 个旧技能无需迁移：缺 `scope/aliases` 时按 `project`/空别名处理。

---

# 以下为 v0.4.0 内容

# dsh-memory v0.4.0 — 低阈值召回 + LLM 精准裁决

**发布日期**：2026-11-03　**状态**：预发布（v0.3.0 → v0.4.0）　**测试**：80/80

---

## v0.4.0：把“检索”拆成网与判

v0.3 的实测缺口：一句短而泛的提问（“帮我写一个 Python 脚本，连接数据库并做一个简单的查询”）
在 0.55 的阈值下**一个技能都召不回**——字面重合太少，词法阶段直接把正确的记忆静默丢掉了。
词法检索的死穴不是“排不准”，而是“根本没进候选集”。

改法只有两条，但必须成对出现：

1. **网放宽**：词法召回下限从 `0.55` 降到 **`0.20`**。它只回答“可能相关”，不承担判定责任。
2. **判收紧**：每一次注入都必须经过一次 LLM 裁决，判断标准从“触发条件逐字成立”改为
   **“这条记忆会不会改变这次任务的做法”**（技术选型 / 连接与事务形态 / 它警告的坑）；
   不同主题必须拒绝；提问未指定技术栈时，保留能代表具体替代方案的候选，交给用户裁决。

## 安全兜底：低阈值 + 无裁决 = 污染

因此 v0.4 **反转了 v0.2 的 fail-open**：

| 情况 | 行为 |
|---|---|
| 词法召回为空 | 不注入 |
| **LLM 不可用 / 超时 / 无 JSON** | **不注入**（候选只留在 `memory_search.candidates` 供诊断） |
| **LLM 判定为空** | **不注入**（技能与负知识一视同仁） |
| LLM 保留候选 | 只注入被保留的，且可用 `conflicts_with` 提示互斥方案 |
| `semanticFilter:false`（纯离线） | 退回严格阈值 `0.55` 的 top-1，与旧行为一致 |

`memory_search` 现在默认走两段式；`filter.applied:false` + `reason` 明确表示“这一轮没有注入”，
而不是“判定为无关”。

## 真机验证

同一个短泛提问，改造前后：

- 旧（0.55）：`debug.matched=7`，但 **0 个候选**，无提示；
- 新（0.20 + 裁决）：召回 **7 个候选**（含 `sqlite-wrapper-txn-shape`、`lazy-driver-injection-orm-testing`、
  两条负知识…），裁决保留 2 个，提示为：

  > （记忆提示：这类任务上次有两套互斥做法（savepoint-transact… / sqlite3 封装层的连接/事务/…），先确认用哪一套。）

这正是 C 会话“先问清楚用 MySQL 还是 SQLite”所需要的信息。

**测试**：80/80（新增/改写 6 条：低阈值召回、单候选也必须裁决、无 LLM 不注入、
空裁决连负知识一起放弃、保留负知识、默认 floor = 0.20）。

---

# 以下为 v0.3.0 内容

# dsh-memory v0.3.0 — 冲突互链：同一用途、两套方法，必须让用户裁决

**发布日期**：2026-11-03　**状态**：预发布（v0.2.0 → v0.3.0）　**测试**：77/77

---

## v0.3.0：互斥技能不再静默并存

一次实战里，会话 A 学会「用 pymysql 连接 MySQL」，会话 B 学会「用 sqlite3 操作本地库」。
两条都是正确程序、用途几乎一样、方法互斥。v0.2 会把它们并排放着——于是检索对同一句
"连接数据库并查询"说两次"上次有效"，而那是两个不同答案。

写入时检测：用途重叠（共享 ≥3 个非泛化词元）+ 双方各有对方没有的区分词元 + 方法不近似
（trigram Jaccard <0.85，排除"同一套步骤换个名字"）。命中后：

- `conflicts_with: <name>` 写进 frontmatter，正文底部追加 `## ⚠️ 冲突提示`；
- **回写对方**，补反向链接与警告（单向会让先检索到的那个显得"正统"）；
- 检索 hint 改成「两套互斥做法（A / B），先确认用哪一套」；
- LLM 第二阶段过滤明确收到 `conflicts_with=`，并被要求两边都保留、交给用户裁决；
- 写入幂等：重复写不重复警告、不重复链接。

**测试**：77/77（新增 9 条：冲突判定、误报守卫、互链重建、双向互链、幂等、无冲突不误报、召回出现分叉、过滤器保留两边）。

---

# 以下为 v0.2.0 内容

# dsh-memory v0.2.0 发布说明

**发布日期**：2026-11-03　**状态**：预发布（v0.1.0 → v0.2.0）　**测试**：68/68

---

## 一句话

v0.1 把会话压成"一句技能"；v0.2 把它拆成**四层认知**，并把技能强制写成**能照着做的兵书**——
能力飞轮第一次真正转了起来：采到的技能可以指导下一次执行，而不是只留一句结论。

---

## 为什么要做这次重写

v0.1 在真实任务上跑通过完整链路（检索 → 注入 → 读取 → 加载 SKILL.md），但暴露了两个硬伤：

1. **技能太薄**。真机采出来的 `threshold-fixture-sizing` 正文只有一句：

   > 测试样本必须超过阈值

   它陈述了一个结论，却没有触发条件、没有步骤、没有验证标准。一个从未见过源会话的模型
   拿到它，仍然不知道"阈值在哪、样本怎么造、怎么算验证通过"。**能读，不能用。**

2. **检索有词法噪声**。排查 `graft_commit` 漂移时，`divergent-rebuild-probe`
   （讲"prepare 与重建产物字段不一致"）因为共享「prepare / 产物 / 字段」被词法召回，
   与当前任务无关，却和真正适用的技能一起被塞进提示。

v0.2.0 分别从**抽取侧**和**检索侧**修掉这两件事。

---

## 一、四层认知模型

抽取不再直接产出"技能/负知识"，而是强制分层。每一层都有自己的落点与校验：

| 层 | 是什么 | 校验 | 落点 |
|---|---|---|---|
| **Fact** | 客观发生的现象 | **必须带真实存在的 seq 指针** | `<memoryDir>/facts.jsonl` |
| **Experience** | 单次试错得出的结论 | 真实 seq 指针 | `<memoryDir>/experiences.jsonl` |
| **Negative Path** | 绝不能再踩的坑 | 现象 + 原因 + 替代做法 + evidence | `<memoryDir>/negatives.jsonl` |
| **Skill** | 经过验证、可复用的程序性资产 | ≥2 个执行步骤 + ≥1 条验证标准 + evidence | `<skillsDir>/<name>/SKILL.md` |

设计要点：

- **事实与经验是证据指针，不是指令**，所以直接落盘（带 `sourceSessionId` / `boundarySeq` / `evidence`），
  不经过审核队列；技能与负知识仍受 `autoApprove` 约束。
- 事实没有 seq 就是"观点"，会被拒绝：`fact has no valid seq pointer`。这让每一条记忆都能被
  `graft_read_result` 回读核对。
- 同一段事实/经验重复出现时**合并 evidence、累加 hits**，不重复落行。

真实抽取样例（同一段旧会话，v0.2 重新 harvest）：

- Fact：`loadPrepared 按白名单逐字段重建 entry 时漏掉 chunks，导致 graft_commit 时 entry.chunks 为空`
  （seq=14844）
- Experience：`改完插件不重启宿主不生效：磁盘已含修复，但宿主跑的仍是旧构建`
  （seq=5428）

---

## 二、结构化 SKILL.md

技能文件现在强制包含 Frontmatter 与三段正文：

```markdown
---
name: threshold-fixture-sizing
description: 为时效/阈值判定编写真正跨过阈值并能在真实数据上验证的测试。
when_to_use: 当被测逻辑含阈值常量（如 500 事件、N 条记录）用于触发某判定时。
evidence: 14337,14351
sources: 1
created: 2026-11-03
---

# 阈值型判定的样本量设计

## 何时使用
当被测逻辑含阈值常量（如 500 事件、N 条记录）用于触发某判定时。

## 执行步骤
1. 在源码中定位阈值常量及其比较方向（>、>=）。
2. 造数据量大于阈值的 fixture（如 501 条），另留一条等于阈值的用例断言不触发。
3. 在真实长会话或真实数据上再跑一次，确认判定确实触发。

## 验证标准
- 断言超阈值样本触发、等于阈值不触发，且真实数据上出现触发记录。

## 证据
- 源会话：session-…（seq 14337, 14351）
```

**双闸门**：

1. 抽取侧：`steps.length < 2` → 丢弃并报告 `needs at least 2 execution steps`；
   `verify` 为空 → `no verification criterion`。那句"测试样本必须超过阈值"现在会被明确拒绝。
2. 写入侧：`writeSkill` 再拦一次（审核队列里可能还有 v0.1 旧数据），返回 `skipped:<原因>`，
   不写半成品文件。

v0.1 的 `when` / `how` 旧队列项仍可读入，但落盘时会被升级成上面的形状；合并时保留最早证据、
累加 `sources`、刷新措辞。

---

## 三、两阶段检索（LLM 相关性过滤）

1. **词法召回**（离线）：`IDF × 鲜活度 × 重要度`，决定"可能相关"。
2. **LLM 相关性过滤**（可选）：候选 >1 时才调用一次，把用户输入与候选的 `when` 一起给模型，
   只保留真正适用的。它**只能删、不能加**——返回的 id 必须与第一阶段候选完全一致，
   否则丢弃；调用失败回退词法 top-1，过滤器永远不会让提示变差。

三条用真机换来的硬约束（全部写进代码与测试）：

| 约束 | 实测症状 |
|---|---|
| 必须显式给 provider/model | `llm.stream()` 无 provider 报 `no adapter registered for provider "undefined"`；静默回退会让人误以为"过滤了但没效果" |
| 必须 `reasoningEffort: off` | 推理模型在"3 个候选取哪个"上先烧掉 3,627 字符推理，然后撞 `max-tokens`，一个字都不输出 |
| 回退必须可见 | `memory_search` 返回 `filter: { attempted, applied, kept?, reason? }`；`applied:false` 说明过滤器没生效，而不是"判定无关" |

延迟预算：pre-step 只给 4 秒（超时就发词法答案）；显式 `memory_search` 给 60 秒。

现场实测（3 个候选）：词法给出「宿主重启核验 / 字段对齐 / fiber 失败定位」三条，
过滤器只保留 `persist-load-field-parity`——提示从三句噪声变成一句有效。

---

## 四、能力飞轮：这次补上的是"环"

飞轮不是"存得多"，而是**用得上 → 再产出**：

```
            ┌──────────────────────────────────────────────┐
            │                                              │
  完成会话 ──▶ harvest（四层抽取）──▶ SKILL.md / negatives / facts
            │                              │               │
            │                              ▼               │
            │                     检索（词法 + LLM 过滤）    │
            │                              │               │
            └──── 下一次执行 ←── 注入一句话提示 ←┘           │
                                                             │
                    新会话产生新的 Fact / Experience ─────────┘
```

v0.1 的环是断的：技能只有一句结论，下一次执行用不上；检索噪声又让它不敢用。
v0.2 让每一环都"有东西可传"：

- 抽取产出**可执行程序**（步骤 + 验证），不是摘要；
- 检索产出**经过判定的候选**，不是词法撞词；
- 执行后产生的新事实/经验带 seq 回到库里，成为下一代技能的证据。

真机验证（v0.2.0 首次重跑）：删除旧技能后对 2 个旧会话重新 harvest，
产出 **4 个技能 / 6 条事实 / 6 条经验 / 8 条负知识**；旧噪声技能
`divergent-rebuild-probe` 没有被重新生成——新版抽取本身就不再把它升格为技能。

---

## 五、配置变化

| 键 | 默认 | 说明 |
|---|---|---|
| `semanticFilter` | `true` | 是否启用第二阶段 LLM 过滤；关掉则检索完全离线 |
| `filterProvider` / `filterModel` | 宿主默认选择 | 过滤器使用的模型路由 |

其余键（`graftDataDir` / `skillsDir` / `memoryDir` / `harvestLimit` / `extractor` / `autoApprove` /
`retrievalThreshold`）语义不变。

---

## 六、升级步骤

1. 更新插件并重启宿主。
2. **删除 v0.1 生成的旧技能**（它们是不合格的一句式）：`memory_forget { name }`，
   或清空 `skillsDir` 后重跑。
3. 清掉对应会话的幂等键（`processed.json`）或直接换 `memoryDir`，然后 `memory_harvest`：
   四层会重新抽取，旧技能若仍值得保留，会以新结构重写。
4. 可选：`memory_search { query, semantic: true }` 观察 `filter` 字段，确认过滤器真的生效。

> 注意：`when` 已更名为 `when_to_use`。旧文件仍可读（解析器兼容 `when`），
> 但新写入一律使用 `when_to_use`。

---

## 七、测试与基线

- **68/68** 通过（`npm run build && npm test`）。
- 新增 `test/v02-cognitive.test.mjs`：四层校验、单句技能拒绝、缺验证标准拒绝、
  过滤器防幻觉、过滤失败可见、噪声剔除、端到端落盘。
- 保留真实 prompt 的**检索回归基线**（`test/baseline-retrieval.test.mjs`）：
  M4 调阈值或加 LLM 重排时，这个基线必须不被破坏。

---

## 八、已知限制与下一步

- LLM 过滤器依赖宿主模型路由；模型过慢时会回退词法（可见于 `filter.reason`）。
- 抽取仍是单次调用 + 本地校验，不做多轮自检；错误以 `dropped` 明示，不静默吞掉。
- M4 尚未实现：提示后成功加权 / 误命中降权。v0.2 先把"可用的技能"与"可信的检索"补齐，
  计分留到有真实使用数据之后。

---

## 九、安全与隐私

- 记忆是**数据**，不是指令：含"忽略之前的指令"一类表述的内容在写入前被拒绝。
- 所有记忆留在本地（`memoryDir` / `skillsDir`）；除宿主模型调用外，不发起任何网络请求。
- 事实/经验带 `sourceSessionId` + `boundarySeq`，可审计、可回读、可删除。