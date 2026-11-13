# dsh-memory

<!-- INSTALL:BEGIN -->
## 安装

两条路都可用。**按你需要选一条**，不要混装同一插件。

## 路线 A：npm registry（beta 通道）

四个包都发布在 `@corvus-dsh/*` 作用域下，当前通道是 **beta**：

```bash
dsh plugin add @corvus-dsh/dsh-paradise@beta
dsh plugin add @corvus-dsh/dsh-memory@beta
dsh plugin add @corvus-dsh/dsh-graft-slice@beta
dsh plugin add @corvus-dsh/dsh-observer@beta
```

先确认 registry 上是哪一版：

```bash
npm view @corvus-dsh/dsh-paradise@beta version
```

## 路线 B：GitHub 直装

```bash
dsh plugin add github:corvus-dsh/dsh-paradise
dsh plugin add github:corvus-dsh/dsh-memory
dsh plugin add github:corvus-dsh/dsh-graft-slice
dsh plugin add github:corvus-dsh/dsh-observer
```

## 两条路的区别（选之前先读这三行）

| | registry（路线 A） | GitHub 直装（路线 B） |
|---|---|---|
| 拿到的是什么 | **已发布、已固化**的产物 | **仓库当前状态**（可能含未发布提交） |
| 复现某版本 | 可以：`@corvus-dsh/dsh-paradise@0.9.1-beta.1` | 不可以（要 checkout 对应 tag 再装） |
| 适合 | 部署、回归、报 bug 时给出确切版本 | 跟进最新修复、本地开发 |

**顺序有意义**：`dsh-paradise` 是内核，其余三个都依赖它提供的协议。先装内核，后装业务插件。

## 装完确认

```bash
dsh plugin list
```

应该看到四行，`fiberPhase` 都是 `active`：

```
include:dsh-paradise       dsh-paradise        active
include:dsh-graft-slice    dsh-graft-slice     active
include:dsh-memory         dsh-memory          active
include:dsh-observer       dsh-observer        active
```

如果某个是 `null` 或显示「异常」，看宿主日志里该包的启动错误——最常见的原因是 Node 版本低于 22.5。

## 卸载

```bash
dsh plugin remove dsh-observer
dsh plugin remove dsh-graft-slice
dsh plugin remove dsh-memory
dsh plugin remove dsh-paradise
```

## 从源码运行（不装插件）

如果只是想跑独立宿主和 Web UI，不需要 DSH：

```bash
git clone https://github.com/corvus-dsh/dsh-paradise
cd dsh-paradise
node dist/harness-server.js
# 浏览器打开 http://127.0.0.1:38080
```

详见《星火 OS 独立运行指南》。

## 要求

| 项 | 版本 |
|---|---|
| Node | ≥ 22.5.0（`node:sqlite` 需要） |
| DSH | ≥ 0.2.1-rc.5 |
| 外部依赖 | **零**。全部只用 Node 内置模块 |

## 为什么包名带作用域

npm 上的**裸名** `dsh-memory` 和 `dsh-observer` 已被第三方注册，包内容与我们无关。
我们不愿为一个名字支付赎金，也不愿让用户装到别人的包，所以改用作用域命名
（`@corvus-dsh/*`）——**请始终用带作用域的名字**，裸名指向的不是本项目的包。
<!-- INSTALL:END -->


**能力记忆**：把做过的会话沉淀成可复用的技能与负知识。DSH 开源生态插件（topic `dsh-plugin`）。

> **里程碑 `v0.9.0-freeze`（2026-11-05）** —— 当时代码冻结点。
> **现状**：`0.9.1-beta.1`；自 2026-11-09 起进入事实层收敛冻结（只修文档与一致性，不加功能）。
>
> **核心功能**：消费交接台账，从已完成的会话中抽取四层认知（带 seq 指针的事实、经验、负路径、结构化 SKILL.md 技能），用一次廉价的 LLM 相关性裁决过滤检索结果，且永不 import 切片插件。
>
> **状态**：432 / 432 测试全绿；工作区硬隔离（`workspaceIsolation`）与双时态有效性在注入路径上生效；跨进程互斥已由彼岸层租约提供（v0.30）。
>
> **已知结构性限制**：与副脑插件同源 —— 宿主不提供「插件自有 Remote」，客户端无法静默请求本插件做事，因此所有触发点都在模型工具侧（`memory_harvest` / `memory_search` 等）。

> 兄弟项目：[dsh-graft-slice](https://github.com/corvus-dsh/dsh-graft-slice) —— 物理交接（零继承、可回查、崩溃可恢复）。本插件只读它的 `.retired.json` / `.transferred.json`。

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

## v0.22.0：跨仓布局契约 —— 读不懂就拒读，而不是读到空

- **`.layout.json`（P1-2）**：本插件在 `<memoryDir>` 写入 `{layout, producer, files}`，声明这个目录里
  `dsh-graft-slice` 会读的四个文件（`negatives.jsonl` / `facts.jsonl` / `experiences.jsonl` / `suggestions.jsonl`）。
  反向：读取 graft 的 `.retired.json` / `.transferred.json` **之前**先校验它的 `.layout.json`。
- **为什么已经有 epoch 还需要它**：epoch 只管文件**内容**格式。文件被改名时，读取端拿到的是"没有台账"——
  与"还没退休过任何会话"完全同形，于是静默读到一份空历史。布局标记把这种沉默变成具名拒绝。
- **拒读而不是猜**：`layout` 不等于本版本 → `LAYOUT_UNSUPPORTED`。reader 侧把抛出的具名错误转成现有的
  `skipped` / `deferred` 通道（新增 `ledger.layoutRefusal`），所以"对方版本更新"不会让插件无法加载，
  但也绝不会被当成"没有历史"。**缺失标记 = 旧目录，继续读**——否则升级即破坏所有存量安装。
- **它能看出什么、看不出什么**：两个插件若在看**不同目录**，读取端找不到标记、按缺失处理；这属于部署检查，
  不是版本检查，所以这里不猜。

## v0.21.0：LLM 静默降级告警、技能归档、负知识时效

三件事，都关于**长期运行**：记忆库在几周尺度上会遇到的三种失效。

### 1. LLM 不可用必须大声说

缺 Key / 未登录 / 模型不可达都不会自己广播：`harvest` 返回空抽取，记忆库**只是不再增长**。几周后它看起来是
「安静」而不是「坏了」，而之后每次检索都在吃一份冻结的语料。所以激活时打一条可直接 grep 的警告：

```
[dsh-memory] LLM unavailable. Harvesting is disabled.
```

`extractor: 'off'`（scan-only 是你的**选择**）不警告——会对配置状态乱叫的警告，训练人忽略警告。

### 2. 技能自动归档（防膨胀）

活跃技能超过 `skillLimit`（默认 100）⇒ 激活期跑**一次**维护 pass：先合并 `when_to_use` 语义相近的
（同 scene 同 workspace），仍超限则归档**最久未用的 10%**（写 `archived: true`，检索跳过，**文件与证据保留**）。

相似度是词法 Jaccard（拉丁词 ×2 + CJK 二元组），三道护栏都是被测试打出来才补的：
短语词元 < 6 直接判不相似（防偶然命中）、**只有数字不同即判不同**（"处理编号 0/1 的任务"曾被误合并 9 条）、
完全相同直接判 1。取向很明确：**宁可漏合并，不可误合并**。

### 3. 负知识时效（防过度抑制）

负知识是库里最"压人"的形态——它以祈使句出现在提示里。一条 30 天前、**再未复发**（`hits <= 1`）的负知识
通常已不是规则而是一则轶事：权重 ×0.5，并在**断言之前**加 `[历史偶发错误，仅供参考]`。
尾注像补充说明，前缀才改变整句读法。**反复复发**的负知识无论多老都保持满权重。

### 4. 控制台同期修复
`cannot get property "remote.commands" without inject` 已修：bridge 优先走 `host.call`（包私有 RPC，
无需 inject 声明），生成的命名空间降为兜底，且**永不抛异常**——一个通道死掉不会让面板崩成空白。

技术债见 [ARCHITECTURE.md](./ARCHITECTURE.md)（TD-M1..TD-M4）；本次发版**不做**大规模代码搬迁。

## v0.20.0：任务对齐过滤（Task Alignment）——第二道语义门

`workspace` 门回答的是"这条记忆是不是**在这里**产生的"。在一个仓库内部，这个答案远远不够：那里最主要的
记忆形态是**事故流水账**——"当 X 报 SOURCE_DRIFT 时，digest 在 prepare 与 commit 之间变了"。它对**撞上它的
那个任务**极其宝贵，而对无关任务**比没有更糟**：它是一条自信、具体、领域吻合的指令，指向一个用户根本没有的问题，
模型会照做。

本项目实测：只有 workspace 门时，一个"重做任务看板"的需求召回了关于台账 epoch 与 CLI 参数解析的技能，
因为三者都住在那两个仓库里，共享 `session` / `state` / `memory` 这些词。

于是加第二问：**这条记忆与当前任务有没有真正的交集？**

| 规则 | 判据 |
|---|---|
| 任务词来自**用户的原话** | 不是整段对话——整段对话里就包含那些让旧事故看起来相关的报错串 |
| **形状优先**，不是话题优先 | 事故流水账（报错/traceback/临时修复/root cause/栈帧）与控制方法（"必须给出 when_to_use"）是两种形状 |
| 事故流水账**默认排除** | 唯一例外：用户这次**就是要修这个故障**——① ask 本身是修复意图（修/排查/为什么…失败）② ask 点名了该故障自己的标识（`SOURCE_DRIFT`、`TypeError`）③ ask 引用了本池**罕见**且该记忆真实拥有的词 |
| 控制方法**不因形状被排除** | 用户的措辞很少命中技能的触发词；漏掉一个方法只损失一次重新发现，注入一条陈旧事故却会换来一个错误回合 |
| 门在**打分之前** | 与 workspace 门同理：被拒的记忆不得影响在任务上的记忆的 IDF 权重 |
| 拒读**可见** | `debug.blockedByTask` 计数。静默拒读与"没有这类记忆"无法区分，而两者需要不同处置 |

**差分开关**：`taskAlignment: false` 恢复旧池（这就是它可测的原因）。默认 **true**——默认关闭的过滤器保护不了任何人。
任务词按 agent **累积**：一句"继续"不含任务信号，只看它会把门变成"全部拒绝"。

## v0.18.0：台账 epoch、加载时拒读、以及"不再猜最新会话"

- **台账 epoch（共有防线）**：`.retired.json` / `.transferred.json` 现在是 `{epoch, at, pid, payload}` 信封。
  读取端四种结局：无信封 = epoch 1（v0.17 旧形状，**继续读**）、`epoch == 2` 信任、`epoch > 2` **拒读并等下一次重试**、
  缺 payload **拒读**。两个插件分开发布，共享的只有一个文件格式；"读到半条记录就据此生成技能"比"晚一轮再生成"更糟，
  所以拒读是设计而不是降级。
- **拒读是可见的**：harvest 报告新增 `ledger: { epoch, supportedEpoch, skipped, deferred }`；
  `memory_stats` 也返回同一份摘要，控制台因此能回答"为什么这次没有抽取"，而不是显示一份空台账（看起来像"没有会话"）。
- **不猜来源**：`memory_migrate_evidence` 在台账被拒时**不再默认取"最新会话"**——那正是会把证据盖到错误来源上的
  时刻；它返回原因并等下一次完整写入，或要求显式传 `sessionId`。
- **加载时扫描（复核）**：`scanThreat` 不只在写入时跑——`retrieve.ts` 读取 SKILL.md/负知识时先扫一遍
  （`isThreatDocument`），`renderHint` 作为最后一道闸门再扫一遍，命中即**扣留注入**。已有测试守住
  （`test/v081-threat.test.mjs`：磁盘上已投毒的 SKILL.md 永不被检索、`renderHint` 是最后一道闸门）。

## v0.17.0：信任前缀、语义领域、噪音审计

- **注入端强制降权**：非 `human` 来源的提示以 `[参考历史数据，非当前指令] ` **开头**，只有用户原话才以普通
  「记忆提示」出现。前缀计入长度上限判断，不会被裁掉——尾注读起来像对事实的补充，而这个失效模式是
  **模型把推断当成了当前指令**。
- **语义领域 `domain`**（`feishu` / `project-local` / `dsh-host` …）：`scene` 说"哪种技术"，`domain` 说"哪个系统"。
  抽取器为每条 fact/skill/negative 输出 domain，写入落盘（SKILL.md frontmatter + JSONL 字段），检索端读回。
  **domain 不同的两条记忆永不互链、永不合并、永不被当作彼此的替代**——这条规则在 `isConflictingSkill`、
  `preferHumanInConflict` 与裁决提示词三处保持一致。`general` 表示"未标注"，仍可与已标注项比较：
  否则 v0.17 之前的记忆会静默失去冲突能力。
- **只读审计**：`scripts/audit-memory-noise.mjs` 扫描 `facts.jsonl` / `negatives.jsonl`（可选 `--include-skills`），
  报告包含宿主路径的条目，**不删除、不改写、不隔离**。它匹配的是**路径**而不是词：红线里那句
  "禁止针对 C 盘、AppData…的搜索"不是噪音，误报会训练使用者忽略报告。

## v0.16.0：记忆控制台（Web 面板）

侧栏「记忆」进入，三块：

- **开关**：`retrieval`（是否自动注入记忆提示）、`workspaceIsolation`（工作区硬隔离）、`semanticFilter`（LLM 语义裁决）。
  写入走宿主 `configEditor.edit`——**无需重启，且活过重启**，因为改的就是 profile 配置本身。
- **记忆库**：按 scene（database / ui / testing …）过滤的清单，每行给出标题、来源（human 绿色 / tool / inferred）、
  scope、记录时的工作区、失效时间与取代关系、证据条数。**失效的记忆显示为划除**，正是双时态那套字段在 UI 上的样子。
- **数据清理**：一键清空**当前工作区**的记忆 → 移入 `<memoryDir>/_quarantine-<ts>/`（含 `MANIFEST.json`），
  `global` 与其它工作区保留。**移动而非删除**——一个会抹掉三周学习成果的调试按钮没人敢点第二次。

同样的操作注册为命令：`/memory-console`、`/memory-console-set retrieval true`、`/memory-console-clear`。
命令行与面板共用同一份实现（`user-actions.md` 的「一个操作、两个调用者」）。

未验证项与依赖同 `dsh-graft-slice`：客户端→宿主的调用形状是防御式桥接（面板会显示实际生效的通道），
且客户端半边是新增的，需要**一次宿主重启 + 一次页面刷新**进入 boot graph。

## 已验证能力（v0.15.0 实战验收，2026-11-03）

> 上一版本致命问题的取证与修复全过程见 **[POSTMORTEM-2026-11-03.md](POSTMORTEM-2026-11-03.md)**
> （跨工作区注入、只写在写入闸门的防注入、缺少失效机制、推断与用户原话等权，以及实战验收记录）。

在**真实记忆库**（`~/.agents/skills` + profile 的 `data/dsh-memory`）上跑的一次完整剧本，用的是插件加载的同一份
`lib/` 代码：

| 步骤 | 观察到的结果 |
|---|---|
| 埋设种子 | 写入 `acceptance-pytest-x`（`provenance: tool`）与 `acceptance-pytest-v`（同场景、`pytest -v`） |
| 制造冲突 | 两条技能同时被召回，提示里带上 `[来源：工具推断，请核实]`（**来源标记实测生效**） |
| 取代裁决 | `applySupersede` 后：旧技能写入 `invalid_at` + `superseded_by` + 正文「## ⚠️ 已被取代」，新技能写入 `supersedes`，**互链成立**；`.memory-audit.jsonl` 记下 winner/loser/reason/query |
| 取代后检索 | 只召回 `acceptance-pytest-x`；`blockedInvalid` 从 1 → 2（被取代的那条不再激活） |
| 时间失效 | 一条 `invalid_at = 2026-10-02`（已过期）的 `human` 规则在**每一次检索里都没有出现** |
| 人工否决权 | 用 `tool` 来源技能去取代那条 `human` 规则 → `applied=false / refused:human-loser-protected`，旧记录**零改动**，审计写 `supersede-refused` |

复现脚本：`_scratch/acceptance-v015.mjs`（读真实库、调真实函数、打印前后对比与审计尾行）。

## 双时态记忆、取代裁决与来源分级（v0.15.0）

三条机制回答三个此前无法回答的问题：**这条记忆什么时候为真、什么时候不再为真**；**新规则是替代还是备选**；
**这话是谁说的**。

### 1. 双时态有效性（`valid_at` / `invalid_at` / `superseded_by`）

每条记忆（`SKILL.md` frontmatter 与 `negatives.jsonl` 记录）都带一个有效性窗口：

```yaml
valid_at: 2026-11-03T12:00:00.000Z     # 从这一刻起为真（默认=写入时刻）
invalid_at: 2026-11-04T09:30:00.000Z   # 从这一刻起不再为真（被取代时写入）
superseded_by: pytest-fast             # 谁取代了它
```

检索的激活门只有一条：`invalid_at` 为空、或晚于当前时间的记忆才会被激活（`blockedByInvalid` 报告被挡掉几条）。
**旧记忆不删除**——删掉就同时毁掉了审计线索和“当时我们相信什么”这个问题的答案。取代发生时，
`invalid_at` 被写成继任者的 `valid_at`，两边互链，于是一对记录本身就是一条时间线。

### 2. 取代裁决（supersede）

`retrieve.ts` 的 LLM 裁决阶段除了 `apply`，还会回答一个**更窄**的问题：这些候选里，是否有一条因为另一条
而**过时**？只有「同一件事 + 同一技术 + 照旧做就错了」才返回取代判定；仍是备选关系的，保持 `conflicts_with`
并列提示——**错判的取代会销毁知识，错判的冲突只是多问一句**。

- 写入由 `store.applySupersede()` 执行：旧记录打 `invalid_at` + `superseded_by` + 正文「## ⚠️ 已被取代」，
  新记录打 `supersedes` + 正文「## 取代」（互链）。
- 每一次判定（包括**被拒绝**的判定）都追加到 `<memoryDir>/.memory-audit.jsonl`；被拒绝的那半更有信息量：
  它意味着某道护栏响了。
- **人工否决权**：`inferred` / `tool` 来源的推断**不得**让 `human` 来源的记忆失效（`refused:human-loser-protected`）。
  这条规则同时写在提示词和代码里——提示词是请求，代码是拒绝。

### 3. 来源可信度分级（provenance）

`human` / `tool` / `inferred` 由**证据**推导，不由抽取模型自述：

| 级别 | 判据 | 提示中的表现 |
|---|---|---|
| `human` | 引用的 seq 里有真人写的 `user/message` | 不加标记（用户自己说的话不需要免责声明） |
| `tool` | 引用里有成功的 `tool/result`（跑过且成立） | 追加 `[来源：工具推断，请核实]` |
| `inferred` | 两者都没有（模型从叙述里归纳） | 追加 `[来源：工具推断，请核实]` |

优先级：一句“总是用 pytest -x”即便随后被成功执行，也仍是 `human`——规则的权威在人，不在那次成功的运行。
冲突消解时 `human` 一方占据主位（`preferHumanInConflict`）；**没有声明冲突时不做任何重排**，
否则一条无关的人类记忆会压过一条相关的推断记忆，正好适得其反。

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

## 场景隔离与证据溯源（v0.6.0）

1. **scene（场景）**：四层记忆都带 `scene`（database / ui / plugin-dev / session-ops / testing…，
   词表开放，非法值降级 `general`）。检索先由 query 推断 scene，**只激活同 scene 或 general 的条目**——
   UI 提问不会再激活数据库技能，哪怕词面更接近。
2. **复合证据**：所有 evidence 存为 `{sourceSessionId, seq}`，SKILL.md 写作 `session-id@seq`；
   提示里的「事实回查」明确给出 `sessionId / seq`，可直接 `graft_search_history` 反查。
   旧文件里的裸 seq 仍可读（按写入会话补全）。
3. **强反查（反幻觉）**：抽取的每条技能必须能通过 `buildEvidenceVerifier`——回到**真实会话日志**，
   逐条检查被引用的 seq：工具调用必须有成功结果、工具结果必须非错误；**只有助手叙述（narration）
   没有工具结果 → 直接拒绝写入**。240 字摘要不再是“做过”的证据。
4. **四层检索**：Fact / Experience 也进入检索与提示（格式分别为「事实回查：上次在 <sid> seq=<X>
   发生过 …」「经验回查：…」），技能、负知识、事实、经验共用同一套词法 + 裁决 + 场景路由。

## 自我证伪与遗忘（v0.5.0）

记忆最大的风险不是“想不起来”，而是**把错的当成权威**。v0.5 给每条记忆装上可被现实推翻的接口：

| 机制 | 做法 |
|---|---|
| **作用域** `scope` | 抽取时强制声明 `workspace / project / global`（缺失或非法一律降级为 `project`，不猜） |
| **别名** `aliases` | 每个技能 2-3 个“别人会怎么问”的说法，参与词法召回（“连数据库”能命中 pymysql 技能），降低对低阈值的依赖 |
| **反向证据** `counter_evidence` | 负知识说“A 必报错”，但后续会话里 A **成功**了：在 `turn-stopping` 扫描工具结果，命中即追加该 seq 到 `counterEvidence`，并把 `confidence` 降一档（每次 -0.2，下限 0.2）；成功结果里仍出现原症状则不算推翻 |
| **冲突按新旧排序** | 互斥技能不再平铺：按 `updated/last_validated` 排序，提示先说“最新的是 X，另一套是 Y” |
| **惰性衰减** | 技能记录 `last_used` / `last_validated`；>14 天未使用且未验证 → 召回权重 ×0.5，并在提示末尾加“注意：此技能较久未被验证…”；新证据/新使用会重置时钟 |
| **裁决缓存** | 相同 `(query, 候选 id+分数)` 10 分钟内只调用一次 LLM（长任务每步都问同一件事是纯延迟） |
| **乐观写入** | harvest 的 LLM 调用前后比对 `snapshotStoreVersion`；期间别的写入发生就**合并重写**，绝不重新调用 LLM；写入失败重试 3 次 |
| **原子落盘** | 所有 SKILL.md/JSONL 仍是 tmp+rename；harvest 不持有任何全局锁，graft_commit 的悲观锁不受影响 |

**backward compatible**：旧 SKILL.md 没有 `scope/aliases/last_*` 时按 `project`、空别名、无衰减处理；
旧队列 payload 缺少新字段同样可读。

## 写入前的安全闸

记忆是**数据**，不是指令。含“忽略之前的指令”一类表述的内容**拒绝写入**——否则下一代会话会把它当规则引用。

## 进度

- ✅ M1：读账本、读日志、抽取、落盘 `SKILL.md` + `negatives.jsonl`、幂等键、离线 CLI（dry-run / OpenAI 兼容）
- ✅ M2：`suggest` 审核队列（`autoApprove` 开关）+ 四道闸（名字 / 归一化精确 / Jaccard ≥0.85 / 同因不同解互链）
- ✅ M3：`IDF × 鲜活度 × 重要度` 本地检索 + pre-step 一句话提示（每轮一次、30 分钟不重复）
- ✅ v0.2.0：四层认知模型（fact / experience / negative / skill）+ 结构化 SKILL.md（`when_to_use` / 执行步骤 / 验证标准）+ 两阶段检索（LLM 相关性过滤）
- ✅ v0.3.x：冲突互链（`conflicts_with` + 双向警告）、产物优先抽取、互链重建
- ✅ v0.4.0：两阶段检索改为低阈值召回（0.20）+ LLM 精准裁决（fail-closed）
- ✅ v0.5.0：scope / aliases / 反向证据降权 / 冲突按新旧排序 / 14 天衰减 / 裁决缓存 / 乐观写入
- ✅ v0.6.0：scene 场景路由 / 复合证据 sid@seq / 强反查（拒绝纯叙述）/ Fact·Experience 接入检索
- ✅ v0.8.x：工作区物理隔离（写入记 `workspace`，读取端池级门禁，fail closed）+ 注入前 `scanThreat` 防污染
- ✅ v0.15.0：**双时态有效性**（`valid_at` / `invalid_at` / `superseded_by`）+ **取代裁决**（LLM 判定 + 互链 + 审计）+ **来源分级**（human / tool / inferred）
- ⏳ M4：飞轮计分（提示后成功加权、误命中降权）

## 测试

```bash
npm run build && npm test
```

**当前：432 / 432。**

**测试专用出口（批次 3 第 1 组）：** 入口导出 31 个名字，其中 **2 个是 seam**（`resetMonotonicClockForTest`、
`resolveMemoryConfigForTest`）；另有 **5 个模块级 seam** 由测试直接从 `lib/` 引入
（`clearFilterCache` / `filterCacheStats`、`clearSceneCache` / `sceneCacheStats` / `clearCommitCache`）。
它们**不是公开 API**，改它们不算破坏性变更。`test/v102-seam-inventory.test.mjs` 把入口导出面钉成字面量清单，
并逐个断言模块级 seam 仍被导出；新增 seam 的规则写在 `src/index.ts` 的 `THE TEST-SEAM SURFACE` 块里
（给 `…ForTest`/`clear…`/`…Stats` 形状的名字、优先放模块级而不是加宽入口）。

口径说明（实测优先）：审计里本仓的"测试暴露"记的是 22 项；用「四个仓 + 脚本 + 文档全扫、只算测试消费」这把尺
量出来是 **54 个"没有非测试消费者"的导出**，其中按形状算 seam 的只有上面这 7 个。差异在**方法**不在事实——
其余 47 个是被单测覆盖的普通工具函数，不属于 seam，本批次不动它们。
