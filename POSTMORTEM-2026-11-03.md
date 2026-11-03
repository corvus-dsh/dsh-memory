# 事后复盘：上一版本（v0.7.1 / v0.8.x 运行时）暴露的致命问题

> 取证与验收日期：2026-11-03。本文件只记录**现场证据**与**已验证的修复**；路径脱敏为
> `<skills dir>` / `<memoryDir>`。
> 姊妹文档：`dsh-graft-slice` 仓库的 `POSTMORTEM-2026-11-03.md`（切片侧）。

复现脚本：`_scratch/acceptance-v015.mjs`（读真实记忆库、调真实 `lib/` 函数、打印前后对比与审计尾行）。

---

## 1. 致命问题：记忆只有「全局一个目录」，没有来源边界

**结构**：技能写在 `<skills dir>`（DSH 自带的技能目录，**全 profile 共用**），而检索发生在**任意一个**
打开的会话里。词法相似度看不见“工作区边界”这种东西。

**现场证据**：同一条从别处抽取的约束（“立刻删除 D:\…\repair-log.cjs”）在新工作区里被当作既有规则
一路带着走；跨 4 个仓库的技能为同一批触发词互相竞争。检索端没有任何字段能回答“这条记忆是谁的”。

**修复（v0.8）**：写入端记录产出会话的 `workspace`（`SKILL.md` frontmatter + JSONL 字段，
来源是**会话日志头**而非抽取模型）；读取端在**算 IDF 之前**做池级门禁：只有 workspace 一致、
或显式 `scope: global` 的记忆能进候选。
**fail closed**：没有 provenance 的旧记录也拒绝——「无法证明是我的」不等于「大概是我的」。
**回归**：`test/v08-workspace.test.mjs`（13 条，含反向断言：local 的那条仍然照常到达）。

---

## 2. 致命问题：防注入只写在「写入闸门」，磁盘上已有的内容无人再扫

**现场形状**：`scanThreat()` 只在写盘前执行。可是磁盘上本来就可能存在**不是本版本写的**内容——
旧版本写的、手改的、别的工具生成的。对它们，写入闸门永远看不见。

**更隐蔽的一层**：即使补上注入前扫描，也**会被渲染器自己的截断击败**——hint 把标题截到 30 字符，
`Ignore all previous instructions` 变成 `Ignore all previous instructio…`，模式不再匹配。

**修复（v0.8.1）**：模式移到 `threat.ts`，**两个边界共用**；注入前对每条文档的**完整存储内容**
（含 hint 从不渲染的正文）扫描；`renderHint` 作为最后一道门，同时扫**未截断的源字段**。
**回归**：`test/v081-threat.test.mjs`（7 条，全部用 `writeFileSync` 直接落盘，刻意绕开写入闸门）。

---

## 3. 致命问题：没有「失效」这个概念——只有删除或永久保留

**现场证据**：一次迁移事故里的 5 代链条，每一代的 8 条约束里都还留着同一条只对一次有效的指令。
系统能表达的只有两种状态：**在** 与 **被删**。删掉会同时毁掉审计线索，保留就会拿过期规则指导今天的动作。

**修复（v0.15）**：双时态窗口 `valid_at` / `invalid_at` / `superseded_by`，检索只激活窗口内的记忆
（`blockedByInvalid` 报告挡了几条）。**旧记忆不删除**：取代时 `invalid_at` 写成继任者的 `valid_at`，
双边互链，一对记录本身即时间线。合并不会覆盖已有的 `invalid_at`——改措辞不等于复活。

---

## 4. 致命问题：冲突只有「并列提示」，且推断与用户原话等权

**现场形状**：`conflicts_with` 只会说“两者互斥，请问用户”。当用户其实**已经拍板**时，每次检索都要
重新问一遍；而无论这条规则是用户说的、跑通过的、还是模型自己归纳的，在提示里长得一模一样。

**修复（v0.15）**：

- **取代裁决**：LLM 阶段在 `apply` 之外回答一个更窄的问题——是否有一条因另一条而**过时**。只有
  「同一件事 + 同一技术 + 照旧做就错了」才取代；仍是备选就保留并列。落盘 `applySupersede()`：
  旧记录 `invalid_at` + `superseded_by` + 正文「已被取代」，新记录 `supersedes` + 正文「取代」，
  每次判定（**含被拒绝的**）写 `<memoryDir>/.memory-audit.jsonl`。
- **人工否决权**（代码里，不只在提示词里）：`tool` / `inferred` 的推断**不得**让 `human` 记忆失效
  → `refused:human-loser-protected`。
- **来源分级**：`human` / `tool` / `inferred` 由**证据**推导（真人 `user/message` → human；成功
  `tool/result` → tool；否则 inferred），**不信模型自述**。非 human 的提示带
  `[来源：工具推断，请核实]`，且该标记不会被长度上限裁掉。
- 冲突消解时 `human` 占主位；**没有声明冲突时不重排**（相关性的归相关性，否则无关的人类记忆会压过
  相关的推断记忆）。

---

## 5. 实战验收（真实记忆库，插件同一份 `lib/` 代码）

```
before : recalled=[acceptance-pytest-v, acceptance-pytest-x]  blockedInvalid=1
         hint: …「acceptance-pytest-v」「acceptance-pytest-x」有效；[来源：工具推断，请核实]…
human  : applied=false  refused:human-loser-protected        ← tool 来源不得作废 human 规则
supersede: applied=true  loser.invalid_at=…  superseded_by=acceptance-pytest-x
          winner.supersedes=acceptance-pytest-v              ← 互链成立
after  : recalled=[acceptance-pytest-x]  blockedInvalid=2     ← 被取代者不再激活
audit  : {"kind":"supersede",…} / {"kind":"supersede-refused","detail":"…human-sourced…"}
```

时间失效验证：一条 `invalid_at = 2026-10-02`（已过期）的 `human` 规则在**每一次检索里都没有出现**。

## 6. 验证

| 项 | 结果 |
|---|---|
| 测试 | **138/138**（新增 11 条：`test/v015-bitemporal.test.mjs`） |
| 并发极端一致性 | 11/11（16450 次读取 0 撕裂） |
| 真实库验收 | 上表（种子 / 冲突 / 取代 / 时间失效 / 来源标记 / 人工否决权 全部实测） |
