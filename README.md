> 兄弟项目：[dsh-graft-slice](https://github.com/corvus-dsh/dsh-graft-slice) —— 物理交接（零继承、可回查、崩溃可恢复）。本插件只读它的 `.retired.json` / `.transferred.json`。

# dsh-memory

**能力记忆**：把做过的会话沉淀成可复用的技能与负知识。DSH 开源生态插件（topic `dsh-plugin`）。

> 当前版本 **0.4.0（预发布）**。发布说明：[RELEASE_NOTES.md](./RELEASE_NOTES.md)。

> 事实记忆只需可查，能力记忆才需要持久化。
>
> 本插件只处理后者：会话日志里的事实保持可回查（按 seq），插件只把「怎么做才对、踩过什么坑」抽出来，
> 落成 DSH 原生可用的 `SKILL.md` 与 `negatives.jsonl`。

## 与 dsh-graft-slice 的关系（数据层耦合，程序上解耦）

```
dsh-graft-slice ──写──▶ .retired.json / .transferred.json
                              │（只读文件契约）
dsh-memory      ──读──▶ ───────┘
                ──读──▶ ctx.sessionQuery.readSession(id)
                ──写──▶ <skillsDir>/<name>/SKILL.md
                        <memoryDir>/negatives.jsonl, processed.json, index.json
```

**本包不 import dsh-graft-slice 的任何代码**，也不依赖它的运行时；卸载任一方都不会坏掉另一方。
共享的只有两个文件格式与一个宿主服务。

## 两条 Cordis 硬契约（真机踩过）

| 契约 | 不满足的后果 | 本包的写法 |
|---|---|---|
| 导出 `inject = ['tools','sessionQuery']` | 服务不注入，`ctx.tools?.register(...)` 全是可选链空操作——插件「装上了但没有工具」 | `src/index.ts` 顶部导出 `name` + `inject` |
| 每个工具声明 `output: { schema, render }` | ToolService 直接抛 `TypeError: tool "x" must declare output`，fiber 变 `failed` | `textOutput()` 统一提供 schema + JSON render |

`llm` 故意不放进 `inject`：它通过 `ctx.get('llm')` 解析，缺了也能挂载（只是不抽取）。

## 安装

```bash
dsh plugin --profile <name> add <path-or-git-url>
dsh --profile <name> --dump-config      # 应出现 dsh-memory 行
```

配置（`cordis.patch.yml` 的 `config`）：

| 键 | 含义 |
|---|---|
| `graftDataDir` | graft 插件的数据目录（读 `.retired.json`）；默认取同级 `dsh-graft-slice` |
| `skillsDir` | 技能落盘目录；默认 `~/.agents/skills`（DSH 自己的 skill 加载器就在扫这里） |
| `memoryDir` | 负知识 / 进度账本；默认 `<paths.data>/.dsh-memory` |
| `harvestLimit` | 单次最多处理几个已退休会话（默认 3） |
| `extractor` | `llm`（用宿主模型抽取）或 `off`（只扫账本，不花 token） |
| `retrieval` | pre-step 是否检索（默认 `true`） |
| `retrievalFloor` | **词法召回下限，默认 `0.20`**：只负责“捞候选”，不负责“判定” |
| `retrievalThreshold` | 严格阈值，**仅离线模式**（`semanticFilter:false`）使用，默认 `0.55` |
| `semanticFilter` | 是否启用 LLM 精准裁决（默认 `true`；关掉则退化为严格词法检索） |
| `filterProvider` / `filterModel` | 过滤调用使用的模型路由；默认取宿主当前默认选择（`agentDefaultModel.currentSelection()`） |

## 四层认知模型（v0.2.0）

一次抽取不再直接产出“一句技能”，而是强制分成四层，并各自落盘：

| 层 | 是什么 | 落点 |
|---|---|---|
| Fact | 客观发生的现象，**必须带 seq 指针** | `<memoryDir>/facts.jsonl` |
| Experience | 单次试错得出的结论（可以还不成熟） | `<memoryDir>/experiences.jsonl` |
| Negative Path | 绝不能再踩的坑（现象/原因/替代做法） | `<memoryDir>/negatives.jsonl` |
| Skill | 经过验证、可复用的程序性资产 | `<skillsDir>/<name>/SKILL.md` |

事实与经验是**证据指针，不是指令**，因此直接落盘（带 `sourceSessionId` / `boundarySeq` / `evidence`）；
技能与负知识仍受审核队列（`autoApprove`）约束。

### SKILL.md 的强制形状

```markdown
---
name: threshold-fixture-sizing
description: 处理阈值型逻辑测试时的样本量设计规范。
when_to_use: 当你在编写涉及 `>`, `<`, `>=`, `<=` 判断的测试用例时。
evidence: 14337
sources: 1
created: 2026-11-03
---

# 阈值型逻辑的测试样本必须超过阈值

## 何时使用
…

## 执行步骤
1. 查看源码中的阈值变量（如 `MAX_RETRIES = 3`）。
2. 测试用例的输入数据必须设为 `阈值 + 1`。
3. 必须写两个测试：一个传 `阈值` 断言不触发，一个传 `阈值 + 1` 断言触发。

## 验证标准
- 运行测试，确保覆盖了跨越边界的正反两种情况。

## 证据
- 源会话：…（seq …）
```

写入闸（`writeSkill`）：没有执行步骤、没有验证标准的技能**直接拒绝落盘**并返回 `skipped:<原因>`。
v0.1 的 `when`/`how` 旧队列项仍能读入，但会被升级成上面的形状。

## 两阶段检索（v0.4.0：低阈值召回 + LLM 精准裁决）

1. **词法召回（网）**：`IDF × 鲜活度 × 重要度`，**默认下限 0.20**。它只回答“可能相关”，
   刻意放宽——短而泛的提问（“帮我写个脚本连数据库”）与技能触发条件的字面重合很少，
   高阈值会把这类真正需要记忆的场景静默漏掉。
2. **LLM 精准裁决（判）**：把用户输入与候选（技能 + 负知识）一起交给模型，由它判断
   “哪些会改变这次任务的做法”，并返回保留的 id；**只能删、不能加**（id 必须与候选完全一致）。

**安全兜底（fail-closed）**：低阈值 + 无裁决 = 污染，所以只要 LLM 不可用、超时或返回空，
就**放弃注入**——词法候选只留在 `memory_search` 的 `candidates` 里供诊断，不会进入提示。
`semanticFilter:false`（纯离线）则退回严格阈值 `0.55` 的 top-1，行为与旧版一致。

裁决 Prompt 的关键一条：*“会改变这次任务的做法”即适用*；字面触发词不要求逐字命中；
但**不同主题**（比如会话交接 vs 数据库）必须拒绝；提问未指定技术栈时，保留能代表具体
替代方案的候选，让模型去问用户，而不是自己猜。

三条实测硬约束仍然有效：

- **必须显式给 provider/model**：`llm.stream()` 无 provider 会报
  `no adapter registered for provider "undefined"`。默认路由取宿主当前默认选择，
  可用 `filterProvider` / `filterModel` 覆盖。
- **必须关掉推理**：实测推理模型在小判定上先烧 3627 字符推理，然后撞 max-tokens 一个字不输出。
- **失败必须可见且关闭**：`memory_search` 返回 `filter: { attempted, applied, kept?, reason? }`
  与 `candidates`；`applied:false` + `reason` 表示“没有注入”，而不是“判定为无关”。

延迟预算：pre-step 给 4 秒（裁决来不及就这一轮不提示）；显式 `memory_search` 给 60 秒。

## 冲突互链（v0.3.0）

两段技能回答同一个用途、但方法互斥时（例如「用 pymysql 连接 MySQL」与「用 sqlite3 操作本地库」），
它们既不是重复（名字/步骤都不同），也不是无关。静默并存会让检索同时说两次"上次有效"，
而它们是两个不同答案。

写入时检测：用途重叠（共享 ≥3 个非泛化词元）+ 双方各有对方没有的区分词元 + 方法不近似
（trigram Jaccard <0.85）。命中后：

- 新技能 frontmatter 写 `conflicts_with: <name>`，正文底部追加 `## ⚠️ 冲突提示`；
- **回写对方**，补上反向 `conflicts_with` 与同样的警告（单向链接会让先被检索到的那个看起来"正统"）；
- 检索命中时，hint 直接说「两套互斥做法（A / B），先确认用哪一套」，而不是「两个都有效」；
- LLM 第二阶段过滤被明确告知：候选带 `conflicts_with` 时**两边都保留**，由用户裁决。

写入是幂等的：重复写同一个技能不会重复追加警告或重复链接。

## 工具

| 工具 | 作用 |
|---|---|
| `memory_harvest {limit?}` | 采矿：读账本 → 读日志 → 四层抽取 → 写技能/负知识/事实/经验 → 记幂等键 |
| `memory_stats {}` | 技能数、负知识数、事实数、经验数、已处理会话数、两个目录路径 |
| `memory_search {query, semantic?}` | 本地词法检索；`semantic:true` 再加一次 LLM 过滤（返回分数与 `when` 行） |
| `memory_forget {name}` | 删除一条技能（显式、可审计；永不自动） |

## 离线 CLI（M1）

```bash
# 只看摘要与提示词，不写盘、不花 token
node scripts/harvest.mjs --dry-run \
  --data-dir  <profile>/data/dsh-graft-slice \
  --sessions-root <home>/sessions

# 真跑（OpenAI 兼容端点）
node scripts/harvest.mjs \
  --data-dir ... --sessions-root ... \
  --llm-url https://api.example.com/v1/chat/completions \
  --llm-key $KEY --llm-model deepseek-chat
```

CLI 直接用**本仓库自带的 zstd 读取器**读会话文件（DSH 的 v4 日志是多帧 zstd 拼接），
不借助 graft 的脚本——这正是解耦纪律的一部分。

## 抽取契约（严格 JSON）

```json
{"facts":[{"text":"客观现象","seq":12}],
 "experiences":[{"text":"单次试错的结论","seq":12}],
 "negatives":[{"symptom":"现象","cause":"原因","avoid":"替代做法","evidence":[56]}],
 "skills":[{"name":"kebab-name","title":"中文标题","description":"是什么",
            "when_to_use":"何时用","steps":["步骤 1","步骤 2"],
            "verify":["验证标准"],"evidence":[12,34]}]}
```

本地校验（不过就丢，且把原因写进 `dropped`）：

1. `name` 必须 ASCII kebab-case（SKILL.md 的命名规则，同时阻断路径穿越）；
2. 事实/经验必须带 **真实存在** 的 seq 指针（防幻觉，保证可回查）；
3. 技能至少 2 个执行步骤 + 1 条验证标准——单句口号不是技能；
4. 每条技能/负知识必须有 `evidence`，且 seq 必须真实存在于该会话；
5. 泛化句（“要小心/多测试”之类）直接拒绝；
6. 每会话 ≤3 事实 / ≤3 经验 / ≤2 技能 / ≤3 负知识。

## 写入前的安全闸

记忆是**数据**，不是指令。含“忽略之前的指令”一类表述的内容**拒绝写入**——否则下一代会话会把它当规则引用。

## 进度

- ✅ M1：读账本、读日志、抽取、落盘 `SKILL.md` + `negatives.jsonl`、幂等键、离线 CLI（dry-run / OpenAI 兼容）
- ✅ M2：`suggest` 审核队列（`autoApprove` 开关）+ 四道闸（名字 / 归一化精确 / Jaccard ≥0.85 / 同因不同解互链）
- ✅ M3：`IDF × 鲜活度 × 重要度` 本地检索 + pre-step 一句话提示（每轮一次、30 分钟不重复）
- ✅ v0.2.0：四层认知模型（fact / experience / negative / skill）+ 结构化 SKILL.md（`when_to_use` / 执行步骤 / 验证标准）+ 两阶段检索（LLM 相关性过滤）
- ⏳ M4：飞轮计分（提示后成功加权、误命中降权）

## 测试

```bash
npm run build && npm test
```