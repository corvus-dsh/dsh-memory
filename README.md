> 兄弟项目：[dsh-graft-slice](https://github.com/corvus-dsh/dsh-graft-slice) —— 物理交接（零继承、可回查、崩溃可恢复）。本插件只读它的 `.retired.json` / `.transferred.json`。

# dsh-memory

**能力记忆**：把做过的会话沉淀成可复用的技能与负知识。DSH 开源生态插件（topic `dsh-plugin`）。

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

## 工具

| 工具 | 作用 |
|---|---|
| `memory_harvest {limit?}` | 采矿：读账本 → 读日志 → 抽取 → 写技能/负知识 → 记幂等键 |
| `memory_stats {}` | 技能数、负知识数、已处理会话数、两个目录路径 |
| `memory_search {query}` | 本地词法检索（可解释：返回命中分数与 `when` 行） |
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
{"skills":[{"name":"kebab-name","title":"中文标题","when":"何时用","how":["步骤"],"evidence":[12,34]}],
 "negatives":[{"symptom":"现象","cause":"原因","avoid":"替代做法","evidence":[56]}]}
```

本地校验（不过就丢，且把原因写进 `dropped`）：

1. `name` 必须 ASCII kebab-case（SKILL.md 的命名规则，同时阻断路径穿越）；
2. 每条必须有 `evidence`，且 **seq 必须真实存在于该会话**（防幻觉）；
3. 泛化句（“要小心/多测试”之类）直接拒绝；
4. 每会话 ≤3 技能 / ≤3 负知识。

## 写入前的安全闸

记忆是**数据**，不是指令。含“忽略之前的指令”一类表述的内容**拒绝写入**——否则下一代会话会把它当规则引用。

## 进度

- ✅ M1：读账本、读日志、抽取、落盘 `SKILL.md` + `negatives.jsonl`、幂等键、离线 CLI（dry-run / OpenAI 兼容）
- ✅ M2：`suggest` 审核队列（`autoApprove` 开关）+ 四道闸（名字 / 归一化精确 / Jaccard ≥0.85 / 同因不同解互链）
- ✅ M3：`IDF × 鲜活度 × 重要度` 本地检索 + pre-step 一句话提示（每轮一次、30 分钟不重复）
- ⏳ M4：飞轮计分（提示后成功加权、误命中降权）

## 测试

```bash
npm run build && npm test
```