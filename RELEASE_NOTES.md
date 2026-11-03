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