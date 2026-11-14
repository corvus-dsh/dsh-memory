# memory 类型缺陷追查 + 家族四档预判（2026-11-14）

> 边界：**不搬任何族、不改 `src/` 一行、不 publish、不碰 paradise。**
> 本文只做追查与评估；所有结论都附命令或实验，不给"看起来像"的判断。

---

## 〇、先订正一个前提：不是「5 条 unref」

你要求「2339 unref 那 5 条优先追」。实测**只有 1 条 unref**。

`type-check` 的 `by code` 摘要把 5 个 2339 归成一行、只打印了**第一条的 message**：

```
2339        5  Property 'unref' does not exist on type 'number'.
     ^^^^^^^ 这个 5 是「code 2339 的总数」
```

5 条 2339 的真实分布：

| # | 位置 | message |
|---|---|---|
| 1 | `ledger-cache.ts:472` | `Property 'unref' does not exist on type 'number'` |
| 2 | `retrieve.ts:1420` | `Property 'currentCommit' does not exist on type 'CandidateOptions'` |
| 3 | `retrieve.ts:1614` | `Property 'currentCommit' does not exist on type '{ threshold?…}'` |
| 4 | `retrieve.ts:1903` | `Property 'updatedAt' does not exist on type 'MemoryHit'` |
| 5 | `retrieve.ts:1927` | `Property 'ageDays' does not exist on type 'MemoryHit'` |

**把"某个 code 的计数"读成"某个 message 的计数"**，与本项目反复记过的「字段存在 ≠ 内容正确」同族。
下面按这 5 条逐条追。

---

## 一、`2339 unref`：**环境产物**，代码没问题，而且运行时不崩

### 代码位置（唯一一处）

`src/ledger-cache.ts:456`、`:465`、`:472`：

```ts
let flushTimer: ReturnType<typeof setInterval> | undefined
…
flushTimer = setInterval(() => { … }, intervalMs)
flushTimer.unref?.()          // ← 2339 在这里
```

全仓 `setInterval|setTimeout` 只有这 1 处（`grep` 实测）；`.unref` 也只有这 1 处。

### 三个实验（都在本机，未改源码）

| 实验 | 做法 | 结果 |
|---|---|---|
| **A** | 默认编译选项（无 `types` 包 ⇒ 默认 lib 含 DOM） | `[2339] ledger-cache.ts:472 Property 'unref' does not exist on type 'number'` |
| **B** | 只把 lib 改成排除 DOM（`lib.esnext.d.ts`） | 2339 消失，变成 `[2304] Cannot find name 'setInterval'`（`:456`/`:465`/`:477`） |
| **C** | 注入一个最小的 Node 风格 timer 声明（`unref(): this` 等） | **0 条相关诊断** |
| **D** | 真实 Node 运行时 | `setInterval 返回: Timeout | typeof unref = function`；`unref()` 调用成功 |
| **E** | 若某环境真没有 unref | `fake.unref?.()` **静默通过，不抛** |

**结论链**：
1. B 证明 `setInterval` 这个名字是 **DOM lib** 提供的（排掉 DOM 就"找不到名字"）；
2. DOM 的 `setInterval` 返回 `number` ⇒ `.unref` 自然不存在 ⇒ A 的 2339；
3. C 证明**只缺环境类型**：补上 Node 形状，2339 归零，代码一行不用改；
4. D 证明运行时真的**有** `unref()` 且调用成功；
5. E 证明即使没有，`?.()` 也不会崩 —— 那是**真 fallback**，不是 `as any`。

### 定性

**环境产物（缺 `@types/node`），不是代码缺陷。** 与本仓已有的 2307×40 / 2580×21 同族；
`type-check` 的分类器只把 2307/2580 划成 ENVIRONMENT，所以这条被算进 CODE HEALTH —— **分类口径的缺口，不是代码的债**。

> 顺带一个可查的旁证：`ReturnType<typeof setInterval>` 在本环境下也等于 `number`。
> 也就是说，`flushTimer` 的**声明类型**和**真实类型**（`Timeout`）不一致 —— 但那是同一条根因的下游表现。

---

## 二、另外 4 条 2339：2 条类型欠账 + **1 条真行为缺陷**

### ① `retrieve.ts:1420` + `:1614` — 「`currentCommit` 两边都没声明」（类型欠账，2 行）

- `retrieveCandidates(…, options.currentCommit)` 传给 `scoreDocuments` 的 `currentCommitOverride`（`retrieve.ts:1214`）；
- 但 `CandidateOptions`（`retrieve.ts:1378-1391`）没有该字段；
- `retrieve()` 的**内联 options 类型**（`:1584-1595`）也没有。

同一个缺字段出现在**两个声明处**，所以要改 2 行（各加 `currentCommit?: string`）。
**是类型欠账**：调用方一直在用，`scoreDocuments` 一直收 —— 只有"声明"缺。
（这与 observer 的 2353 `inheritFrom` 完全同型。）

### ② `retrieve.ts:1903` — `updatedAt`（类型欠账，1 行）

`MemoryHit`（`retrieve.ts:262-302`）没有 `updatedAt`，但 `hitOf()` 在**同文件** `:1361` 明确复制了它：

```ts
...(document.updatedAt === undefined ? {} : { updatedAt: document.updatedAt }),
```

所以运行时**有**值，只是接口没声明。改 1 行。

> 附注：`conflictsWith` 的"按新旧排序"依赖 `updatedAt ?? lastValidated`。
> 若两者都缺，`Date.parse('')` → `NaN` → `|| 0`，排序退化为"保持原顺序"。
> 那是**数据缺失**时的既定行为（`Document.updatedAt` 有的记录才有），不是 bug。

### ③ `retrieve.ts:1927` — `ageDays`：**代码欠账（真行为缺陷，不是类型欠账）**

这是本次追查里唯一一条**运行时行为错了**的。

- `Document`（内部记录）有 `ageDays`，由 `:944 ageDays: usedDays` 计算并写入；
- `hitOf()` **没有**把它复制进 `MemoryHit`（`:1348-1376` 里没有 ageDays 那一行）；
- `renderHint()` 在 `:1927` 读 `negative.ageDays` → 永远是 `undefined`；
- `isStaleNegative()` 里 `Number(undefined ?? 0)` = 0 ⇒ `0 <= 30` ⇒ **永不 stale**；
- 于是 v0.21 的 `[历史偶发错误，仅供参考]` 前缀**在生产里永远不会出现**。

**实测（端到端，不是读代码推的）**：

```
$ node _scratch/memory-ageDays-probe.mjs
retrieveCandidates 返回条数: 1
hit.kind = negative
hit.ageDays  = undefined
hit 上所有 own keys: kind, id, title, score, detail, scope, confidence, scene, domain, provenance, seq
                                                ↑ 没有 ageDays，也没有 updatedAt

isStaleNegative({ageDays:100,hits:1})  = true
isStaleNegative({hits:1})（无 ageDays）= false

renderHint(真实 hit，无 ageDays)        → "[参考历史数据，非当前指令] （记忆提示：另有一次「连接超时」翻车，先核对再重跑。）"
  → 带过期前缀? false
renderHint(同一 hit + ageDays:100)      → "[参考历史数据，非当前指令] （记忆提示：[历史偶发错误，仅供参考] 另有一次「连接超时」翻车，先核对再重跑。）"
  → 带过期前缀? true
```

**同一条 100 天前、hits=1 的 negative：运行时产出的对象不出现过期提示；给它补上 `ageDays` 就出现。**

**修法（1 行代码 + 1 行接口）**：

```ts
// hitOf() 里补一行
...(document.ageDays === undefined ? {} : { ageDays: document.ageDays }),
// MemoryHit 里补一行
ageDays?: number
```

**为什么不能只加接口声明**：只加声明会让 2339 消失、行为仍然错 —— 那正是"把类型错误修成静默行为错误"。
**为什么不能直接删字段**：`isStaleNegative` 的调用点、`NEGATIVE_STALE_DAYS` 的语义、以及 `v0.21` 的测试都依赖它。

---

## 三、`2300 Duplicate identifier 'EvidenceRef'`：合并遗留，**2 行修完**

同一个文件 `src/index.ts` 有两条都从 `./extract.js` 导入 `EvidenceRef` 的 type import：

```
L21  import type { EvidenceRef, ExtractionResult } from './extract.js'
L65  import type { EvidenceRef, MemoryProvenance } from './extract.js'
```

**是合并遗留**：两段 import 列表各自生长（一段为 `ExtractionResult` 服务，一段为 `MemoryProvenance` 服务），
`EvidenceRef` 在两边都出现了。TS 因此报 2 条（每个声明点一条）。

**修法 2 行**：把 `MemoryProvenance` 并进第一行，删掉第二行。

**在副本里实测过（不动真实树）**：

```
$ node _scratch/memory-dup2300-probe.mjs
修复前: {"code2300":2,"total":73}
改动量: 1 行合并 + 1 行删除 = 2 行
修复后: {"code2300":0,"total":71}
```

（`extract.ts` 确实导出这三样：`EvidenceRef:36`、`MemoryProvenance:136`、`ExtractionResult:260`。）

---

## 四、`2353` ×3 与 `2345` ×2：逐条定性（**没有一条该靠删字段解决**）

先订正第二处前提：**2353 的 3 条不是同一个字段**。只有一条是 `'domain'`：

| code | 位置 | 具体字段 | 定性 | 修法 |
|---|---|---|---|---|
| 2353 | `extract.ts:474` | `domain` → `ExtractedExperience` | **类型欠账** | 1 行 |
| 2353 | `retrieve.ts:190` | `reasoningEffort` → `LlmLike.stream` 选项 | **类型欠账** | 1 行 |
| 2353 | `store.ts:2148` | `timestamp` → `LayerRecord` | **类型欠账** | 1 行 |
| 2345 | `store.ts:1615` | `ExtractedNegative.evidence` → `NegativeRecord.evidence` | **类型欠账** | 2 行 |
| 2345 | `store.ts:2215` | `LayerRecord[]` → `Record<string,unknown>[]` | **纯结构可赋值性** | 1 行 |

逐条依据：

### ① `extract.ts:474` `domain` — 写入路径**已经支持并持久化**

- `ExtractedExperience`（`:87-119`）有 `scene`、没有 `domain`；
- 但 `appendLayer()` 的参数类型（`store.ts:2093-2102`）**声明了 `domain?: string`**，
  且 `:2141` 真的把它写盘；
- 事实层（`:456`）与负向层都传 `domain` 且不报错 —— 只有 experience 这一层缺声明。

**运行时无数据丢失**（对象字面量照样带着 `domain` 进 `appendLayer`），只是类型上不合法。
→ 类型欠账，**加 `domain?: MemoryDomain` 一行**。删字段才是真丢数据。

### ② `retrieve.ts:190` `reasoningEffort` — 宿主**确实认这个字段**

- `LlmLike.stream` 的选项类型（`extract.ts:609-618`）没有该字段；
- `filter.ts` 却明确用它，并**记了实测**（`:174-186`）：

  > 实测 `qiniu` / `deepseek/deepseek-v4.1-flash`：`does not support reasoning effort "off"`；
  > 每次裁决都抛，pre-step 读成"裁决没意见"，提示永久退化成纯词法召回。

  能收到"不支持 reasoning effort"这种报错，说明**字段真的传到了宿主**。

- **为什么只报 retrieve 不报 filter**：`filter.ts:192` 用展开写 `...(x === undefined ? {} : { reasoningEffort })`，
  对象展开**绕过 excess property check**；`retrieve.ts:190` 是字面量直写，于是被查出来。

  > 这一条本身值得记：**展开语法是一个类型检查的盲点**，同一个非法字段用展开写就"合法"了。

→ 类型欠账，`LlmLike.stream` 选项加 `reasoningEffort?: string` 一行。

### ③ `store.ts:2148` `timestamp` — 写入**总会**写，读的类型没声明

- `appendLayer` 在 `:2148` 每次都构造 `timestamp`（显式值或 `monotonicTimestamp()`）；
- `LayerRecord`（`:1719-1732`）没有 `timestamp`；
- 读取处用 `readJsonl(path) as unknown as LayerRecord[]` 强转，所以别处不报错。

→ 类型欠账，`LayerRecord` 加 `timestamp?: string` 一行。

### ④ `store.ts:1615` `ExtractedNegative` 不可赋给 `NegativeRecord` — `evidence` 的形状

```
ExtractedNegative.evidence: EvidenceRef[]      （v0.7.1 起是复合指针）
NegativeRecord.evidence:    number[]           （dedupe.ts:412，停在 v0.7 之前）
```

- 同文件 `:2122` 的注释明说：「v0.7.1: evidence is composite **everywhere**, not just in SKILL.md」；
- `LayerRecord.evidence` 已经写成 `Array<number | EvidenceRef>`（`:1727`）——
  只有 `dedupe.ts` 的 `NegativeRecord` 没跟上；
- **运行时无影响**：`planNegative()`（`dedupe.ts:424-436`）只读 `symptom` / `cause`，从不碰 `evidence`。

→ **类型欠账**（接口滞后于 v0.7.1 迁移），**2 行**：`dedupe.ts` 加 `import type { EvidenceRef } from './extract.js'`，
并把 `evidence: number[]` 改成 `Array<number | EvidenceRef>`。
**没有循环依赖风险**：`extract.ts` 只 import `./segment.js`。

### ⑤ `store.ts:2215` `LayerRecord[]` → `Record<string,unknown>[]` — 纯结构问题

`commitLedger()`（`ledger-cache.ts:319-323`）的形参是 `ReadonlyArray<Record<string, unknown>>`，
而 `LayerRecord` 是 interface、**没有 index signature**，因此不可赋值。
**运行时无事**（只是序列化后写盘）。

→ **纯类型层**，**1 行**：与紧邻的 `:2207` 同样写 `existing.slice(beforeLength) as unknown as Array<Record<string, unknown>>`。
（另一条路是给 `LayerRecord` 加 index signature，但那等于放弃字段校验，**不推荐**。）

---

## 五、类型环：只评估，不实施

### 现状

`check-cycles` 实测：**0 个值环**、**1 个仅类型环**。

```
retrieve.ts -> filter.ts : VALUE       （selectApplicableSkillsDetailed）
filter.ts   -> retrieve.ts : type-only （import type { MemoryHit }）
```

### 改动面（在副本里真做过一遍，不是估）

把 `MemoryHit` + `DocumentKind` 搬进新的 `src/types.ts`，让 `filter.ts` 从 `types.ts` 取类型：

| 文件 | 改动 |
|---|---|
| **新增** `src/types.ts` | **49 行**（`DocumentKind` 1 行 + `MemoryHit` 41 行 + 文件头与 `import type { MemoryProvenance }`） |
| `src/retrieve.ts` | **删 42 行**（两个声明块）、**加 2 行**（`import type` + `export type { … } from './types.js'` 保住公开面） |
| `src/filter.ts` | **改 1 行**（`'./retrieve.js'` → `'./types.js'`） |
| 合计 | **3 个文件（含 1 个新文件）、4 处编辑** |

### 实测效果

```
=== 改动前 ===
nodes: 27  value edges: 43  all edges (incl. type-only): 51  unresolved: 0
ACYCLIC — no VALUE dependency cycle
NOTE: 1 type-only cycle(s) — retrieve.ts ⇄ filter.ts
诊断: {"total":73,"code":12}

=== 改动后 ===
nodes: 28  value edges: 43  all edges (incl. type-only): 53  unresolved: 0
ACYCLIC — no VALUE dependency cycle          ← NOTE 段落消失
诊断: {"total":73,"code":12}                 ← 诊断数一条不变
```

**结论（只评估，未实施）**：

- 改动面小：3 文件 / 4 处 / 新增 49 行；
- 收益是"环清零"与"`filter.ts` 不再依赖 `retrieve.ts`"，但**运行时零收益**（`import type` 本就被擦除）；
- 唯一真实风险点：`MemoryHit` 从 `retrieve.js` 搬走后必须**保留 re-export**，
  否则 `lib/retrieve.js` 的公开面变动（外部与测试从这里取这个名字）—— 上面那 2 行里的 `export type` 就是为此；
- **建议：可做但不必急**。它与 12 条 CODE HEALTH 不是同一优先级；若要动，应先做 §二③ 那条真行为缺陷。

---

## 六、families 分量表 + 四档预判（**不搬**）

### 工具链

从 observer 移植 `closure / families / who-references / move-gate`，并把两处**本仓专用默认值**改掉：

- `families.mjs` 默认根：`apply` → **`applyInner`**（`index.ts:998-2359`，1,362 行，占 `index.ts` 58%）
- `closure.mjs` 自校准样本：observer 的 `stepMonitor` 等 → 本仓的
  `scanThreat / planNegative / hitOf / renderHint / harvest`（5 个，跨度 14→278 行）

### 移植时又抓到一个仪器缺陷：`spanOf` 不认 `async`

第一次跑 families 就报：

```
WARNING: declaration spans total 1753 != closure total 2062 (difference -309)
```

查清：`spanOf` 的正则只认 `^(?:export\s+)?function`，而本仓有 `export async function`：
`harvest`（278 行被算成 **1**）、`writeMemoryConsoleSetting`（33 行被算成 **1**）—— **277 + 32 = 309**，正好是差额。

修法：正则加 `(?:async\s+)?`。修完：

```
applyInner: 22 declaration(s), 2062 lines
6 connected component(s), 2061 lines in the table (+ 1 for the removed ambiguous member = 2062)
跨度之和 == 闭包总行数（2062 == 2062），逐成员与编译器 0 差。
```

> 与上一轮 observer 的 `let/var` 缺口是**同一类**：仪器的"找不到"会被**静默降级成一个看起来合法的数字**（1 行）。
> 那次靠"和偏小"的自校验暴露，这次靠"和偏大/偏小都能报"的严格相等暴露。
> **同一个 `async` 缺口也存在于 observer 的副本里**（该仓 `index.ts` 顶层无 async 函数，所以没暴露）——
> 已同步修掉并复测仍 `1746 == 1746`。

### 分量表（根 = `applyInner`）

```
#1  1 decl / 1362 lines   applyInner                                     ← 根，不参与连通
#2 16 decl /  658 lines   harvest, MemoryConfig, buildEvidenceVerifier, resolveConfig,
                          snapshotStoreVersion, HarvestReport, writeMemoryConsoleSetting,
                          resolveFilterTarget, deriveProvenance, ContextLike,
                          STORE_VERSION_MEMORY_FILES, OBSERVATIONAL_TOOLS,
                          MEMORY_CONSOLE_PATCH_ID, MEMORY_CONSOLE_KEYS,
                          STORE_VERSION_SKILL_FILES, DEFAULT_RETRIEVAL_FLOOR
#3  1 decl /   17 lines   lastUserText
#4  1 decl /   10 lines   activeNodeIdsForHarvest
#5  1 decl /    8 lines   textOutput
#6  1 decl /    6 lines   forgetSkill
```

`name` 被剔出分量表（7 个声明点，`AMBIGUOUS`）。

### 四档（`move-gate --cluster` 实测）

| 族 | A 大小 | B 闭包 | C2 生产调用者 | C3 outside | C4 容器局部 | 预判 |
|---|---|---|---|---|---|---|
| **#2** | YES 658 | 659 行 / 17 声明 / **mutable: none** | YES（0） | **REVIEW**：`name [const]` | YES（无） | **无机器否决；C1 需人工** |
| #3 `lastUserText` | YES 17 | 17 / 1 / none | YES（0） | YES（无） | YES | **可搬候选** |
| #4 `activeNodeIdsForHarvest` | YES 10 | 10 / 1 / none | YES（0） | YES（0） | YES | **可搬候选** |
| #5 `textOutput` | YES 8 | 8 / 1 / none | YES（0） | YES（0） | YES | **可搬候选** |
| #6 `forgetSkill` | YES 6 | 7 / 2 / none | YES（0） | **REVIEW**：`name [const]` | YES | 6 行，收益近零 |

**关键读数**：

1. **#2 是唯一有体量的族**（658 行 / 17 声明），但它的**一句话职责（C1）过不了**：
   `harvest`（抽取编排）+ `MemoryConfig`/`resolveConfig`（配置）+ `buildEvidenceVerifier`（证据校验）
   + `snapshotStoreVersion`（布局版本）+ `writeMemoryConsoleSetting`（控制台设置）+ `HarvestReport`（报告类型）
   —— 这是**"index.ts 里所有还没搬走的东西"**，不是一个职责。
   它的边来自 `applyInner` 这个根把它们连在一起，而不是它们互相依赖。
2. **#3/#4/#5 是真候选但极小**：合计 35 行。搬它们对 `index.ts` 2,361 行几乎无影响，
   而每次搬移要付全套 can-red 代价。
3. **C3 的 `name [const]`** 是同一个 `name` 常量被这些函数引用 —— 不是环，是共享常量；
   要搬就得把这个常量一起带走或从 `index.ts` 导入（后者会让新模块反向依赖 `index.ts`，**不可接受**）。

### 结论（不给搬运顺序）

- **#2 不该按"C1 一句话"硬拆**；真要减 `index.ts`，正确做法是先把 `applyInner`（1,362 行）
  内部按**职责**切开（这是另一类工作，不是搬族）。
- **#3/#4/#5 可搬但收益近零**（35 行）。
- **#6 不建议**（6 行 + 需要处理 `name` 依赖）。
- 我**没有搬任何族**。

---

## 七、跨仓遗留项：npm 10 的 `prepare` 问题在 observer / graft-slice 是否也存在

判据（`npm pack` 会触发的生命周期脚本是 `prepack` / `prepare` / `postpack`）：

| 仓 | 有 `prepare`/`prepack`/`postpack` 吗 | 打包门禁在临时副本里跑吗 | 结论 |
|---|---|---|---|
| `dsh-memory` | **有** `prepare` | **是**（改动后，剥掉钩子） | 曾经踩坑，已修 |
| **`dsh-observer`** | **无**（`scripts` 只有 build/test/preflight/check） | **否**（在真实树里跑 `npm pack`） | **不适用** —— 没有钩子可跑 |
| **`dsh-graft-slice`** | **无**（`scripts`：build/check/check:docs/test/demo/publish/verify/check:artifact） | **压根没有打包门禁测试** | **不适用** |

**两条都核过 `package.json` 与 `test/` 目录**，不是看文件名推的。

**但 observer 有一个潜在风险要记下来**：它的打包门禁在真实树里跑 `npm pack`、且**没传 `--ignore-scripts`**。
今天安全，只因没有钩子。**一旦有人给 observer 加一个 `prepare`（哪怕只是 build），
在 npm 10 上就会重现 memory 那个事故**（重建产物 + 并发测试读到半更新）。
不需要现在改，但这句话该留在那里 —— 否则下次加钩子的人不会知道。

---

## 八、本轮 12 条 CODE HEALTH 的最终定性表

| code | 位置 | 定性 | 修法行数 | 运行时有影响吗 |
|---|---|---|---|---|
| 2339 | `ledger-cache.ts:472` | **环境产物**（缺 `@types/node`，DOM 的 `setInterval` 返回 `number`） | 0（装 @types/node 自消） | 无（`unref?.()` 有 fallback，且 Node 真有 unref） |
| 2339 | `retrieve.ts:1420` / `:1614` | 类型欠账（`currentCommit` 两处未声明） | **2** | 无 |
| 2339 | `retrieve.ts:1903` | 类型欠账（`hitOf` 已复制 `updatedAt`，接口没声明） | **1** | 无 |
| 2339 | `retrieve.ts:1927` | **代码欠账（真行为缺陷）**：`hitOf` 不复制 `ageDays` ⇒ 过期前缀永不出现 | **2**（1 行复制 + 1 行接口） | **有，已实测** |
| 2300 | `index.ts:21,65` | 合并遗留（同文件重复 type import） | **2** | 无 |
| 2353 | `extract.ts:474` | 类型欠账（`appendLayer` 已持久化 `domain`） | **1** | 无（数据已写盘） |
| 2353 | `retrieve.ts:190` | 类型欠账（宿主认该字段；filter 用展开绕过了检查） | **1** | 无 |
| 2353 | `store.ts:2148` | 类型欠账（写入总会写 `timestamp`） | **1** | 无 |
| 2345 | `store.ts:1615` | 类型欠账（`dedupe.NegativeRecord` 停在 v0.7 前） | **2** | 无（`planNegative` 不读 evidence） |
| 2345 | `store.ts:2215` | 纯结构可赋值性（无 index signature） | **1** | 无 |

**合计：11 行就能清掉 11 条（除那条环境产物）。其中只有 1 条（`ageDays`）改的是行为。**
**本轮一条都没修** —— 只做追查与定性。

---

## 九、未验证

| 项 | 状态 |
|---|---|
| `ExtractedExperience.domain` 是否**真的**被下游消费 | 只确认"写得进盘"；**没查有没有读它**。若没人读，它就更接近"多余字段"而非"欠账" |
| `reasoningEffort` 在宿主侧的具体语义 | 只有 `filter.ts` 的实测报错作为证据；**没读宿主 adapter 源码** |
| `ageDays` 修复后的行为变化 | 未实施，因此未测（预期：老负向会被打上 `[历史偶发错误]` 前缀） |
| `types.ts` 拆分对 `lib/retrieve.js` 公开面的影响 | 只在副本里验了诊断数不变；**没跑产出构建与对外 import 断言** |
| #2 的 C1 | 我判定"过不了"，但那是**人工判断**，无机器判据 |
| graft-slice 的族划分 | 本轮没跑（它没有打包门禁，但 files/closures 工具是否适用未查） |
