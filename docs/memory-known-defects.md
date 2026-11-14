# memory 已知缺陷清单（D-1 … D-7）

> 生成日期：2026-11-14　对象：`dsh-memory` @ `36bf8e8`
> **本清单只登记与定性，不修任何一条。** `src/` 保持零改动。
>
> 每条四问：**是什么 / 性质 / 为什么现在不动 / 修它要动什么**。
> 所有数字都来自实测（`type-check --json`、副本实验），不是估计。

---

## 〇、先读完这段，否则下面五条会被误读

### ① 不是「5 条 unref」

`type-check` 的 `by code` 摘要里有一行 `2339  5  Property 'unref' …` —— 那个 **5 是 code 2339 的总数**，
摘要只打印了第一条 message。逐条拉出来是 1 条 unref + 4 条别的。
（把"某个 code 的计数"读成"某个 message 的计数"，与本项目记过的「字段存在 ≠ 内容正确」同族。）

### ② 12 条 CODE HEALTH 里，只有 **D-1 一条**改真行为

其余 11 条是类型欠账 / 合并遗留 / 环境产物。**这条决定修复顺序。**

### ③ v0.21 测试有一个盲区，会让 D-1 看起来"已经测过"

见 §八。**这是本清单最重要的一节** —— 修 D-1 时测试必须改成端到端，否则改完还是绿的，证明不了任何事。

---

## 一、D-1　`ageDays` 没被复制进 `MemoryHit`

### 是什么

`hitOf()`（`retrieve.ts:1348-1376`）从内部 `Document` 复制 18 个字段到对外的 `MemoryHit`，
**唯独漏了 `ageDays`**。而 `renderHint()` 在 `:1927` 读 `negative.ageDays`。

### 性质：**未完成功能**（不是类型欠账）

**准确定性（这一条必须写准）**：

> **不是**「`renderHint` 读不到 `ageDays`」——降权是生效的。
> 而是：**降权生效、文案不生效。**

依据（`retrieve.ts:1087-1097`，`negativeDocuments()` 构造 `Document` 时）：

```ts
ageDays: ageDaysOf(typeof record.at === 'string' ? record.at : undefined, now),   // :1087 算出来了
…
importance:
  (1 + Math.min(0.5, 0.15 * Math.log(1 + Math.max(1, hits)))) *
  confidence *
  (isStaleNegative({ ageDays: ageDaysOf(…), hits })                                // :1095 直接算过
    ? NEGATIVE_STALE_WEIGHT
    : 1),
```

- `isStaleNegative` 在 **:1095 被直接调用、并且真的生效** —— 老的一次性负面记录**确实被降权到 0.5**；
- `Document.ageDays` 也算出来了（`:1087`）；
- 缺的只是：**这个值没被搬到 `hit` 上**，于是 `renderHint` 那个**读者**拿到 `undefined`。

所以：
- **排序 / 降权 / 检索权重**：完全正常（那是 `Document` 层的事）；
- **提示文案里的 `[历史偶发错误，仅供参考]` 前缀**：永远不出现（那是 `MemoryHit` 层的事）。

一句话：**功能做了一半** —— 权重算了、文案忘了接。这是"未完成功能"，**不是类型欠账**（
类型欠账指"运行时对、声明缺"；这里运行时就是错的）。

### 实测（端到端，不是读代码推的）

同一条 100 天前、`hits: 1` 的 negative，走 `retrieveCandidates → renderHint`：

```
修复前: {"ageDays":"undefined", "hasStalePrefix":false}
        hint = "…（记忆提示：另有一次「连接超时」翻车，先核对再重跑。）"
修复后: {"ageDays":100.00000001157407, "hasStalePrefix":true}
        hint = "…（记忆提示：[历史偶发错误，仅供参考] 另有一次「连接超时」翻车，先核对再重跑。）"
```

### 为什么现在不动

1. **改的是行为**，不是类型 —— 它会让一批老负向提示的措辞发生变化，需要单独裁定（谁都得同意"老的一次性负面记录该被打上历史标签"）；
2. **必须先修测试**（§八）：现在改代码，v021 仍然全绿，等于改了个没人验证的东西；
3. 它不影响正确性（降权已生效），只影响**呈现**，优先级低于"会不会写坏数据"的问题。

### 修它要动什么

| 位置 | 改动 | 行数 |
|---|---|---|
| `retrieve.ts` `hitOf()` | 加一行 `...(document.ageDays === undefined ? {} : { ageDays: document.ageDays }),` | 1 |
| `retrieve.ts` `interface MemoryHit` | 加 `ageDays?: number` | 1 |
| `test/v021-governance.test.mjs` | **改成端到端**：写一条老 negative 到磁盘 → `retrieve`/`retrieveCandidates` → `renderHint` → 断言前缀 | ~15（重写两个用例） |

**总计：代码 2 行 + 测试约 15 行。** 测试那部分是**必须**的，不是可选的补充。

**顺带建议（同一处，别分开做）**：紧邻的 `validAt` 也是"`hitOf` 复制了、`MemoryHit` 没声明"，
只是眼下没读者所以不报错。一次把 `updatedAt` / `ageDays` / `validAt` 三个都补齐，
否则下一个读者出现时又是一条新 2339。

---

## 二、D-2　`ExtractedExperience` 缺 `domain`

### 是什么

`extract.ts:474` 往 `experiences.push({ …, domain: asDomain(item.domain) })` 传了 `domain`，
但 `ExtractedExperience`（`:87-119`）没有这个字段 ⇒ `[2353]`。

### 性质：**类型欠账**

- `appendLayer()` 的入参类型（`store.ts:2093-2102`）**声明了 `domain?: string`**；
- 且 `:2141` 真的把它写盘（`domain: /^[a-z]…/ ? … : 'general'`）；
- **它有消费方**：`retrieve.ts:1157` 的 `layerDocumentOf`（经验/事实层读取器）写
  `domain: String(record.domain ?? 'general')…`，进而进入候选的冲突轴与过滤器输入
  （`filter.ts:126` 的 `domain=${candidate.domain ?? 'general'}`）。

所以：**数据一直写得进、也一直被读**，只是接口没声明。运行时零影响。

### 为什么现在不动

纯类型欠账、零行为风险，但它与 D-1 在**同一个 `hitOf`/`MemoryHit` 附近**（都属"声明没跟上"），
建议与 D-1 那批一起处理，避免两次改同一个文件、两次跑全套门禁。

### 修它要动什么

`extract.ts` `interface ExtractedExperience` 加一行 `domain?: MemoryDomain`。**1 行。**

---

## 三、D-3　`LlmLike.stream` 缺 `reasoningEffort`

### 是什么

`retrieve.ts:190` 直写 `reasoningEffort: 'off'`，但 `LlmLike.stream` 的选项类型（`extract.ts:609-618`）没有该字段 ⇒ `[2353]`。

### 性质：**类型欠账**

**宿主确实认这个字段**，证据在 `filter.ts:174-186` 的实测记录：

> 实测 `qiniu` / `deepseek/deepseek-v4.1-flash`：`does not support reasoning effort "off"`；
> 每次裁决都抛，pre-step 读成"裁决没意见"，提示永久退化成纯词法召回。

能收到"不支持 reasoning effort"这种报错，说明**字段真的传到了宿主**。

**为什么只报 `retrieve.ts` 不报 `filter.ts`**：`filter.ts:192` 用对象展开写
`...(x === undefined ? {} : { reasoningEffort })`，**绕过了 excess property check**。

> **这一条我验了两次，第一次是错的**：
>
> | 复现形状 | 直写 | 展开 |
> |---|---|---|
> | 只传 `reasoningEffort` 一个字段 | 报 2353 | 报 **2559**（no properties in common） |
> | **已知字段齐全 + 多一个 `reasoningEffort`**（真实形状） | 报 2353 | **不报** |
>
> 第一次翻车：对象里**没有任何已知字段**时 TS 先报 2559，走不到 excess property check。
> **最小复现必须保留真实形状**，否则会把"被哪种检查抓到"换成另一种检查的答案。

### 为什么现在不动

同上：零行为风险的类型欠账。另外我**没读宿主 adapter 源码**，`reasoningEffort` 的合法取值集合
（`'off'` 之外还有什么）未知 —— 在不确定的前提下改公共类型，可能写下一个错的范围。

### 修它要动什么

`extract.ts` `LlmLike.stream` 的选项类型加一行 `reasoningEffort?: string`。**1 行。**

> 若日后确认取值集合是有限的（如 `'off' | 'low' | 'high'`），应写成字面量联合而不是 `string`。
> 那需要读宿主类型定义，本清单不假装知道。

---

## 四、D-4　`LayerRecord` 缺 `timestamp`

### 是什么

`appendLayer()` 在 `store.ts:2148` **每次都**构造 `timestamp`（显式值或 `monotonicTimestamp()`），
但 `interface LayerRecord`（`:1719-1732`）没有这个字段 ⇒ `[2353]`。

### 性质：**类型欠账**

读取处用 `readJsonl(path) as unknown as LayerRecord[]` 强转，所以别处不报错 ——
**强转掩盖了缺声明**。运行时：字段一直写、一直存。

### 为什么现在不动

零行为风险；且 `LayerRecord` 的补齐会和 D-5、D-6 撞在同一段代码（`appendLayer` / `commitLedger`），
应合并成一次改动。

### 修它要动什么

`store.ts` `interface LayerRecord` 加 `timestamp?: string`。**1 行。**

---

## 五、D-5　`dedupe.NegativeRecord.evidence` 停在 v0.7 之前

### 是什么

```
ExtractedNegative.evidence: EvidenceRef[]      （v0.7.1 起是复合指针）
NegativeRecord.evidence:    number[]           （dedupe.ts:412）
```

于 `store.ts:1615` 的 `planNegative(existing, negative)` 报 `[2345]`：
`'EvidenceRef[]' is not assignable to 'number[]'`。

### 性质：**类型欠账**（接口滞后于迁移）

同文件 `:2122` 的注释明说：「v0.7.1: evidence is composite **everywhere**, not just in SKILL.md」。
`LayerRecord.evidence` 已经写成 `Array<number | EvidenceRef>`（`:1727`）—— 只有 `dedupe.ts` 没跟上。

**运行时零影响**：`planNegative()`（`dedupe.ts:424-436`）只读 `symptom` / `cause`，**从不碰 `evidence`**。

### 为什么现在不动

同样是"零风险但非零收益"的类型欠账；且它需要给 `dedupe.ts` 加一条跨模块 import，
值得与其它类型改动一起做、一起验循环依赖。

### 修它要动什么

| 位置 | 改动 | 行数 |
|---|---|---|
| `dedupe.ts` 顶部 | `import type { EvidenceRef } from './extract.js'` | 1 |
| `dedupe.ts` `NegativeRecord` | `evidence: number[]` → `Array<number \| EvidenceRef>` | 1 |

**没有循环依赖风险**：`extract.ts` 只 import `./segment.js`（实测）。

---

## 六、D-6　`LayerRecord[]` 不可赋给 `Record<string, unknown>[]`

### 是什么

`commitLedger()`（`ledger-cache.ts:319-323`）的形参是 `ReadonlyArray<Record<string, unknown>>`，
而 `LayerRecord` 是 interface、**没有 index signature**，因此不可赋值 ⇒
`store.ts:2215` 的 `[2345]`。

### 性质：**纯结构可赋值性**（既不是功能缺失，也不是数据问题）

运行时无事 —— 只是把对象序列化后写盘。

### 为什么现在不动

零风险；与 D-4 在同一函数体内，一次做完更省。

### 修它要动什么

**1 行**：与紧邻的 `:2207` 同样写法
`existing.slice(beforeLength) as unknown as Array<Record<string, unknown>>`。

> **不推荐**的另一条路：给 `LayerRecord` 加 index signature。那等于放弃字段校验，
> 以后写错字段名也不会报 —— 用一次 `as unknown as` 换长期类型安全，划算。

---

## 七、D-7　`EvidenceRef` 在同一文件导入两次

### 是什么

`src/index.ts` 有两条都从 `./extract.js` 导入 `EvidenceRef` 的 type import：

```
L21  import type { EvidenceRef, ExtractionResult } from './extract.js'
L65  import type { EvidenceRef, MemoryProvenance } from './extract.js'
```

⇒ `[2300] Duplicate identifier 'EvidenceRef'` **2 条**（每个声明点一条）。

### 性质：**合并遗留**

两段 import 列表各自生长（一段为 `ExtractionResult` 服务，一段为 `MemoryProvenance` 服务），
`EvidenceRef` 在两边都出现了。不是设计问题，是合并时的疏忽。

### 为什么现在不动

零风险、零行为影响，但它**不值得单独一个提交** —— 与 D-1..D-6 一起做，
省一轮门禁与 CI。

### 修它要动什么

把 `MemoryProvenance` 并进第一行，删掉第二行。**2 行**（1 改 + 1 删）。

**副本里实测过**：

```
修复前: {"code2300":2,"total":73}
改动量: 1 行合并 + 1 行删除 = 2 行
修复后: {"code2300":0,"total":71}
```

（`extract.ts` 确实导出这三样：`EvidenceRef:36`、`MemoryProvenance:136`、`ExtractionResult:260`。）

---

## 八、v021 测试的盲区（**修 D-1 前必读**）

### 事实

`test/v021-governance.test.mjs` 里那两个与 stale 有关的用例，是这样构造输入的：

```js
// :206-229
const negative = {
  id: 'neg-0',
  title: 'pytest fixture 报错',
  ageDays: NEGATIVE_STALE_DAYS + 10,   // ← 手工塞进去的
  hits: 1,
  …
}
const hint = renderHint({ negative, debug: { … } })   // ← 直接喂给渲染器
```

**它手工构造了一个带 `ageDays` 的对象，直接喂给 `renderHint` —— 完全绕过了 `hitOf`。**

于是它测的是「`renderHint` 在拿到 `ageDays` 时会不会打前缀」（**答案：会**），
而**没有**测「`retrieve` 走到 `renderHint` 的那条路上，`ageDays` 到底还在不在」（**答案：不在**）。

### 实测证明

把 `hitOf` 里 `ageDays` 的复制**加上** vs **不加**，各跑一次 v021：

```
原始（hitOf 不复制 ageDays，即当前生产状态）: exit=0 tests=11 pass=11 fail=0
对照（hitOf 补上 ageDays）                  : exit=0 tests=11 pass=11 fail=0
```

**同样全绿。** 也就是说：

> **v021 对 D-1 这个缺陷完全不敏感。** 它绿，不能证明生产路径是对的。

### 这意味着什么

1. **D-1 不是"没测" ，而是"测了但测错了层"** —— 更危险：报告上看有测试覆盖，实际没有；
2. 修 D-1 时**必须**把这两个用例改成端到端：
   `写一条老 negative 到临时 memoryDir → retrieveCandidates/retrieve → renderHint → 断言前缀`；
3. 顺手值得加一条**反向**断言：手工构造 `negative` 不带 `ageDays` 时**不应**出现前缀 ——
   把"渲染器契约"与"生产路径契约"分开写，两者都要有。

> 这个盲区与我在 observer 上记的那条同族：**用合成输入测下游函数，会漏掉上游没接上的线**。
> `ageDays` 就是那根没接上的线。

---

## 九、类型环：只评估，不实施

### 现状（`check-cycles` 实测）

**0 个值依赖环**、**1 个仅类型环**：

```
retrieve.ts -> filter.ts : VALUE       （selectApplicableSkillsDetailed，真的会执行）
filter.ts   -> retrieve.ts : type-only （import type { MemoryHit }，运行时被擦除）
```

### 改动面（在副本里真做过一遍，也真构建过）

把 `MemoryHit` + `DocumentKind` 搬进新的 `src/types.ts`，让 `filter.ts` 从 `types.ts` 取类型：

| 文件 | 改动 |
|---|---|
| **新增** `src/types.ts` | **49 行**（`DocumentKind` 1 行 + `MemoryHit` 41 行 + 文件头与 `import type { MemoryProvenance }`） |
| `src/retrieve.ts` | **删 42 行**、**加 2 行**（`import type` + `export type { … } from './types.js'` 保住公开面） |
| `src/filter.ts` | **改 1 行**（`'./retrieve.js'` → `'./types.js'`） |
| **合计** | **3 个文件（含 1 个新文件）、4 处编辑** |

### 实测效果

```
改动前:  nodes 27 / value edges 43 / all edges 51 / ACYCLIC + 1 个 type-only 环 / 诊断 73 (code 12)
改动后:  nodes 28 / value edges 43 / all edges 53 / ACYCLIC（环消失）      / 诊断 73 (code 12)
```

**构建验证**（副本里真跑 `scripts/build.mjs`）：构建 OK；
`lib/retrieve.js` 运行时导出数 **34 → 34**，名字集合逐个比对一致。

### 为什么不实施

- **运行时零收益**（`import type` 本来就被擦除）；
- 唯一真实风险是 `MemoryHit` 搬走后**必须保留 re-export**，否则公开面变动 ——
  虽然验证过，但那是一个"必须记得做"的手工细节；
- 它与 D-1..D-7 不是同一优先级：本清单的七条里有六条是"零风险、改成更严格"，
  而这一条是"动公开面的结构"。

**结论：可做，但排在 D-1 之后。**

---

## 十、下一步：`store.ts` 2,479 行的重构目标（先给方案，不搬）

### 先纠正一个隐含假设：它不是「一个巨型函数」

`index.ts` 的问题是**一个 1,362 行的 `applyInner`**（占该文件 58%）。
`store.ts` 不是这样。实测（`closure --declarations src/store.ts`）：

| 项 | 值 |
|---|---|
| `store.ts` 顶层声明数 | **104** |
| 最大单函数 | **154 行**（`renderSkill`） |
| ≥80 行的声明 | **8 个，合计 841 行**（占文件 34%） |
| 总声明跨度 | 1,899 行（文件 2,479 行，其余是注释与空行） |

也就是说：**`store.ts` 是"很多中等函数堆在一起"，不是"一个巨物"**。
**这直接决定了方案：不该去找"那一刀切在哪里"，而该按职责分组。**

### 按职责粗分（实测跨度之和，6 组）

| 组 | 声明数 | 跨度 | 主要成员 |
|---|---|---|---|
| **生命周期** | 9 | **466** | `quarantineWorkspaceMemory`(100)、`recordCounterEvidence`(85)、`applySupersede`(84)、`migrateBareEvidence`(82)、`applySkillFeedback`(45)、`markSkillValidated`、`touchSkillUsage`、`rebuildConflictLinks`、`conflictFooter` |
| **SKILL 读写** | 12 | **435** | `renderSkill`(154)、`writeSkill`(81)、`parseSkillFile`、`readSkillBody`、`readSkillValidity`、`parseEvidenceField`、`evidenceBodyLines`、`parseEvidenceList`、`normalizeSkill`、`frontmatter`、`listSkillFiles`、`skillPath` |
| **JSONL 层写入** | 8 | **332** | `appendLayer`(131)、`appendNegatives`(124)、`planNegativeArchive`、`planLayerArchive`、`normalizeEvidenceRefs`、`appendFacts`、`appendExperiences`、`updateJsonlFile` |
| **缓存/索引** | 7 | **92** | `shapeOf`、`invalidateSkillShape`、`clearSkillShapeCache`、`commitEdges`、`linkConflictBack`、`findConflicts`、`isConflictingSkill` |
| **IO 原语** | 5 | **63** | `atomicWrite`、`assertCompleteJson`、`readJsonl`、`readJsonlFresh`、`sleepSync` |
| **审计** | 3 | **59** | `appendMemoryAudit`、`rotateAuditIfNeeded`、`memoryAuditPath` |
| 合计 | 44 | **1,447** | （其余 60 个声明是零散 helper 与类型，合计 452 行） |

### 方案：**四档按「闭包」填，不按「组跨度」填**

> ⚠️ **上一版这张表用"组跨度"当大小，那是错的。** 组跨度只数这些函数自己占的行；
> 真正决定"能不能搬"的是 `move-gate --cluster` 的**闭包**（这些函数 + 它们必须一起带走的东西）。
> 下面每个数都是实测，不是估：`move-gate --cluster … --src store.ts`。

| 步骤 | 做法 | **B 闭包（实测）** | `mutable` | A | C2 生产调用者 | C3 outside | C4 | 结论 |
|---|---|---|---|---|---|---|---|---|
| **0（前置）** | 抽时钟三件套到 `store/clock.ts` | **9 行 / 3 声明** | `[lastIssuedMs]` ← **刻意的** | YES | YES（无） | **YES（无）** | YES | **可做，且必须最先做** |
| **B** | 抽 IO 原语到 `store/io.ts` | **91 行 / 9 声明** | `none` | YES | **REVIEW：`graph.ts`、`knowledge.ts`、`suggest.ts`** | REVIEW（`JSON_GATE_EXT`、`StoreWriteRejected`、`TRANSIENT_RENAME`） | YES | 可做；**但闭包跨 3 个文件，见下** |
| **A1** | 抽 SKILL 读写到 `store/skill.ts` | **795 行 / 48 声明** | `none` | YES | REVIEW（`causal.ts`、`retrieve.ts`、`suggest.ts`） | REVIEW（`SkillMeta`、`VOCAB_TAG`、`asVocab`、`clampConfidence`、`SkillConflict`） | YES | **闭包 795 行接近 800 上限**，要先决定这些类型归属 |
| **A2** | 抽生命周期到 `store/lifecycle.ts` | **848 行 / 47 声明** | `none` | **YES 但超 800** | YES | REVIEW（13 个 outside 引用，含 IO 五个） | YES | **闭包 848 > 800，当前不可搬** |
| **A3** | 抽 JSONL 层写入到 `store/layer.ts` | **478 行 / 25 声明** | **`[lastIssuedMs]`** | YES | REVIEW | REVIEW（6 个，含 `lastIssuedMs`） | YES | **第 0 步做完才可搬** |

**这一版又推翻了上一版的两处数字**（上一版用 move-gate 的旧口径，按**名字**求并集，会重复计数）：

| 项 | 上一版 | **这一版（按「文件:名字」）** | 原因 |
|---|---|---|---|
| B | 97 行 / 8 声明 | **91 行 / 9 声明** | 旧口径把 `store.ts:readJsonl`(3 行) 解析成了 `causal.ts:readJsonl`(20 行)；修完既纠了行数，也补回了先前被同名合并吞掉的 1 个声明 |
| A3 | 495 行 / 25 声明 | **478 行 / 25 声明** | 同一条根因，17 行的差全部来自同名误解析 |
| A2 | 865 行 / 47 声明 | **848 行 / 47 声明** | 同上 |

> **这条修正本身值得记**：`move-gate` 的 B 档原先把成员身份降级成**裸名字**
> （`unionNames.add(member.name)`），而 `closure.mjs` 明明已经给了 `file`。
> 于是遇到跨文件同名（`readJsonl` 三处、`sleepSync` 两处），`resolveDeclaration(name)` 取的是表里第一个，
> **同一个名单能算出 495 也能算出 478**。
> 这与该文件上方那段注释（"read the fields, not the string"）是同一个错误的两半：
> 那次把对象当字符串读，这次把带文件的身份降级成裸名。
> 修法：身份用 `file:name`，并让 `resolveDeclaration` 接受可选的 file 参数。

### 各组**逐名成员名单**（复算用）

> 名字全部照抄 `move-gate --cluster` 的输入；任何一条改动都会改变上面的闭包行数。

#### ⚠️ 两组数字的对账口径（**不存在两套真值**）

之前出现过「同一组算出两个数」，原因不是有第二套真值，而是**量的名字个数不同**：

| 组 | 用户按自己挑的名字量（少） | **文档名单量（全）** |
|---|---|---|
| A1 | **779 行**（5 个名字） | **795 行**（12 个名字） |
| A3 | **390 行**（2 个名字） | **478 行**（8 个名字） |
| B | **76 行**（3 个名字） | **91 行**（5 个名字） |

**所以差值是"少量了 7 / 6 / 2 个名字"，不是"谁算错了"。**

> 正确表述是：**用户用自己挑的 5 / 2 / 3 个名字量，得出 779 / 390 / 76；文档名单是 12 / 8 / 5 个名字，得出 795 / 478 / 91。**
> 下一个人看到这张表就知道差在哪，**不会以为项目里有两套并存的真值**。

**复算的唯一权威名单就是下面这四组。** 若数字对不上，先确认你量的名字个数，再怀疑口径。

**第 0 步 · clock（3 个）**

```
lastIssuedMs  monotonicTimestamp  resetMonotonicClockForTest
```

**B · IO 原语（5 个）**

```
atomicWrite  assertCompleteJson  readJsonl  readJsonlFresh  sleepSync
```

**A1 · SKILL 读写（12 个）**

```
renderSkill  writeSkill  parseSkillFile  readSkillBody  readSkillValidity
parseEvidenceField  evidenceBodyLines  parseEvidenceList  normalizeSkill
frontmatter  listSkillFiles  skillPath
```

**A2 · 生命周期（9 个）**

```
quarantineWorkspaceMemory  recordCounterEvidence  applySupersede  migrateBareEvidence
applySkillFeedback  markSkillValidated  touchSkillUsage  rebuildConflictLinks  conflictFooter
```

**A3 · JSONL 层写入（8 个）**

```
appendLayer  appendNegatives  planNegativeArchive  planLayerArchive
normalizeEvidenceRefs  appendFacts  appendExperiences  updateJsonlFile
```

> 这四份名单就是上表数字的**唯一输入**。复算命令：
> `node scripts/move-gate.mjs --cluster <名单> --src store.ts`。
> 若数字对不上，先查名单有没有变（不是先怀疑口径）。

### B 组的一条硬事实：闭包**跨 3 个文件**

`move-gate` 的 A 档只列输入成员，容易让人以为 B 只涉及 `store.ts`。**不是**：

| 成员 | 所在文件 | 行数 | 说明 |
|---|---|---|---|
| `atomicWrite` | `store.ts:134` | 25 | |
| `assertCompleteJson` | `store.ts:104` | 20 | |
| `StoreWriteRejected` | `store.ts:81` | 15 | |
| `sleepSync` | **`store.ts:41` 与 `lock.ts:106`** | 11 / 11 | **同名两处** |
| `readJsonl` | **`store.ts:1293`、`causal.ts:86`、`knowledge.ts:114`** | 3 / 20 / 20 | **同名三处** |
| `readJsonlFresh` | `store.ts:1305` | 4 | |
| `JSON_GATE_EXT` | `store.ts:79` | 1 | |
| `TRANSIENT_RENAME` | `store.ts:53` | 1 | |

**C2 生产调用者也不是 0**：实测 `graph.ts` 3 处、`knowledge.ts` 6 处、`suggest.ts` 2 处、`causal.ts` 2 处。

**所以"把 B 搬到 `store/io.ts`"必须回答一个问题：`causal.ts` 的那个 `readJsonl` 怎么办？**

三种选择，各有代价：

| 选择 | 做法 | 好处 | 代价 |
|---|---|---|---|
| **B-1（推荐）** | `causal.ts` / `knowledge.ts` 的**私有同名函数改名为 `readJsonlLocal`**，保留各自实现 | 零行为变化；只是改名，`verify-pure-move` 之外的一次纯重命名 | 两个文件各改 1 处定义 + 若干调用点（要数清） |
| **B-2** | `causal.ts` / `knowledge.ts` 改为 import `store/io.ts` 的那个 | 去重，真的只有一份实现 | **要确认三份实现的语义是否一致**（行解析/容错不同就会改行为）——未验证 |
| **B-3** | 只搬 `store.ts` 的版本，另外两处原地不动 | 改动最小 | **"同名不同实现"继续存在**，`move-gate` 的闭包数字永远有歧义 |

**这条必须先决定再动手**，否则搬完之后闭包数字还是算不准 —— 因为 `resolveDeclaration` 仍会在同名里挑一个。

**当前状态：未决定。** 本轮只立项，不实施。

### 第 0 步（前置条件）：`store/clock.ts`

**为什么必须最先做**：`appendLayer` 与 `appendNegatives` 的闭包都含 `lastIssuedMs`，
于是 A3 的 `mutable` 不是 `none`。把时钟独立出去，A3 才从"不可搬"变成"可搬"。

**搬什么**（`store.ts:2062-2088`，**27 行含注释**）：

```
lastIssuedMs                    （模块级 let）
monotonicTimestamp              （export function）
resetMonotonicClockForTest      （export function，测试接缝）
```

**注释必须一起搬。** 特别是这一段（`:2074-2076`）：

> It is a MODULE-LEVEL clock on purpose: this is a **per-process ordering guarantee**.
> Across processes the ordering authority is `at` written under the file lock, and cross-machine
> ordering is explicitly NOT promised — claiming otherwise would be the kind of overreach that
> makes an audit trail untrustworthy.

**这句丢了，下一个人就会以为模块级 `let` 是"还没清理干净的历史包袱"，然后把它改成参数传进去** ——
那会把 per-process 单调性拆掉，因果图重新可能倒序。

**预演实测**（副本里做，不碰真实树）：

```
=== 搬之前 ===
  appendLayer: mutable = ["lastIssuedMs (let/var)"]
  appendNegatives: mutable = ["lastIssuedMs (let/var)"]

搬走的行区间: store.ts L2062..L2088（27 行，含注释）
注释里包含 "per-process ordering guarantee"? true

=== 搬之后 ===
  appendLayer: mutable = none
  appendNegatives: mutable = none
  clock.ts（文件级）: mutable = ["lastIssuedMs (let/var)"]
```

> **`clock.ts` 自己的 `mutable` 仍是 `["lastIssuedMs"]` —— 这是对的，不是没修干净。**
> 判据是「**被搬的东西**的闭包里还有没有可变状态」，不是「仓库里还有没有 `let`」。
> 上一轮在 observer 上写的 `mutable: none = 作用域变化不是状态消失`，这里是它的镜像：
> **`mutable: [lastIssuedMs] = 有意的 per-process 状态，不该消掉`。**

**第 0 步要动什么**：

| 位置 | 改动 |
|---|---|
| 新增 `src/store/clock.ts` | 27 行（原样搬，注释完整） |
| `src/store.ts` | 删 27 行；加 `import { monotonicTimestamp } from './store/clock.js'` + `export { … } from './store/clock.js'`（保住公开面） |
| `index.ts` / 其它调用方 | **零改动**（它们从 `store.js` import，re-export 接住了） |
| **`test/clock-seam.test.mjs`** | **开工前先加**（本轮已加，见下） |

### 开工前的前置条件：时钟接缝测试（**已加，且已验证它抓得住**）

`test/clock-seam.test.mjs` 断言的是**跨两个入口的同一性**：

```
resetMonotonicClockForTest(0);  monotonicTimestamp(1000)  ===  1970-01-01T00:00:01.000Z
```

若 reset 与 stamp 不是同一个 `lastIssuedMs`，clock 会保留它之前的值（远大于 1000），
`max(1000, last+1)` 返回 `last+1` 而非 1000 —— 断言立刻失败。

**关键设计**：测试**先把钟推到很远**再 reset。没有这一步，全新进程里 `lastIssuedMs` 本来就是 0，
接缝坏了也照样通过 —— 那正是这类缺陷最容易漏掉的地方。

**反向验证（不是只看它绿）**：在副本里做两种破坏，看测试是否变红：

| 场景 | 结果 |
|---|---|
| 基线（未破坏） | exit=0 pass=2 fail=0 → **绿**（符合预期） |
| 破坏① `reset` 变成 no-op | exit=1 pass=0 fail=2 → **红**（抓得住） |
| 破坏② stamp 读自己的 `shadowClock`（两个实例） | exit=1 pass=0 fail=2 → **红**（抓得住） |

**一条"搬前搬后都绿"的测试，若在接缝坏掉时也绿，就证明不了任何事。** 所以这两种破坏是必须做的。

**必须同时验的**：
1. `appendLayer` / `appendNegatives` 的 `mutable: none`（上表已预演）；
2. `verify-pure-move --against <上一步>` 给出 `IDENTICAL`（纯搬运）；
3. **`clock-seam.test.mjs` 搬前搬后各跑一次都绿** —— 这是接缝真的穿上了的唯一判据；
4. 全套测试数不变 —— 加了两条接缝用例后是 **434 / 434 / 0**（原 432）。

### 建议顺序与理由

**0 → B → A1 → A3 → A2**，理由是**依赖方向 + 规模门槛**，不是"哪个大先做"：

```
0. clock.ts（9 行闭包，无 outside）   ← 先做，让 A3 的 mutable 归零
        ↓
B. io.ts（91 行闭包，跨 store/causal/lock 三文件）← atomicWrite 被 A1/A3/A2 同时依赖
        ↓
A1. skill.ts（795 行闭包）           ← 接近上限，要先定类型归属
        ↓
A3. layer.ts（478 行闭包，0 之后 mutable none）
        ↓
A2. lifecycle.ts（848 行闭包）       ← 当前超 800，必须先让 A1/A3 把它瘦下来
```

- **0 是 A3 的前置条件**，也是唯一"搬它能让别的步骤从不可搬变可搬"的一步；
- **B** 清掉 `atomicWrite` 这个三处共享依赖；**动手前必须先回答 `causal.ts` / `knowledge.ts` 的同名 `readJsonl` 怎么办**（见上）；
- **A1** 闭包 795 行已接近 800 上限，**动手前必须先决定 `SkillMeta` / `SkillConflict` / `VOCAB_TAG` 的归属**
  （它们是"类型和常量"，进 `types.ts` 还是随 A1 走）；
- **A3** 在第 0 步之后才可搬；
- **A2 不动。** 闭包 848 > 800，**当前就是不能搬**；等 A1 + A3 分完再重新量一次，那时才知道它到底剩多少；
- 每步都是纯搬运，每步用 `verify-pure-move --against <上一步>` 验，红就停。

> **本轮裁定（按用户 2026-11-14）**：
> - **只立项，不动手** —— 本节与 §十一全是测量结果，没有一行实际搬运；
> - **A2 不动**（848 > 800，等 A1/A3 分完再评估）；
> - **D-1…D-7 继续挂着**，等重构完成；
> - `validAt` / `reasoningEffort` 两个未验证项**保持标注，不补测**。

### 关键风险（必须先说）

1. **`store.ts` 的对外面很宽**：它是本仓的"仓储层"，`index.ts`、`retrieve.ts`、`archive.ts` 都从它 import。
   任何拆分都必须**只加 re-export、不改调用点**，否则 diff 会大到自己都看不懂；
2. **`104 个声明 / 1,899 行`意味着大量私有 helper**：它们会被多组共用。
   分组时**先量闭包再动手**（`move-gate --cluster … --src store.ts`），不要按组跨度或名字猜测；
3. **闭包 > 组跨度是常态**：A2 的组跨度 466，闭包 848（**1.82 倍**）。
   拿组跨度当"这个模块多大"会低估近一倍，直接导致"看起来能搬、实际超限"；
4. **第 0 步的 9 行不值得单看收益**，但它是**唯一**能让 A3 从不可搬变可搬的动作 —— 这才是它排第一的理由。

### 不做什么

- **只立项，不动手**（本节不含任何实际搬运）；
- **不搬族**；
- **不动 paradise**；
- **不在修 D-1..D-7 的同时动 `store.ts` 的结构** —— 两种改动混在一起，`verify-pure-move` 就没法当参照。

> **裁定：D-1..D-7 全部等重构完成后再修。** 理由：重构会大范围移动 `store.ts` / `retrieve.ts` 的代码，
> 而 D-2/D-4/D-5/D-6 的修法都落在这些文件里 —— 先修再搬，搬运就不再是纯搬运（`verify-pure-move` 会红在类型改动上，不是搬运上）；
> 而 D-1 改的是行为，更需要一个稳定的参照。**顺序：重构 → 再修 D-1..D-7。**

---

## 十一、附：`store.ts` 的实测（families 分量表 + move-gate 闭包表）

### 十一·〇　`families --src` 的正确用法（**踩过，必须记**）

```bash
# ✅ 正确：目标在前
node scripts/families.mjs appendLayer --src store.ts

# ❌ 错误：--src 在前
node scripts/families.mjs --src store.ts appendLayer
```

**错误顺序会输出**：

```
--src: 0 declaration(s), undefined lines
0 connected component(s), 0 lines in the table
```

**为什么这个陷阱必须记**：那行 `--src: 0 declaration(s), undefined lines` **长得像在说"这个文件没有族"**。
不注意的话，结论会是「`store.ts` 没有分量，所以没什么可拆的」——
而真相是 `families.mjs` 把 `--src` 当成了**要量的目标名**（旧解析是 `process.argv[2] ?? 'applyInner'`）。

> **已从根上修掉**：现在先剥掉 `--src <file>` 这一对，剩下的第一个位置参数才是目标，**与顺序无关**。
> 三种用法实测都正确：
>
> ```
> node scripts/families.mjs --src store.ts appendLayer   → appendLayer: 9 declaration(s), 225 lines
> node scripts/families.mjs appendLayer --src store.ts   → appendLayer: 9 declaration(s), 225 lines
> node scripts/families.mjs                              → applyInner: 22 declaration(s), 2062 lines
> ```
>
> 但**文档仍保留上面那个错误示例** —— "参数吃错会产出看起来合法的空结果"是这个仓反复出现的形状，留着比删掉有用。

### 十一·一　仪器修了两次，两次都是"只看得见 index.ts"

1. **文件名写死在成员正则与 `spanOf` 里** ⇒ `families.mjs appendLayer`（在 `store.ts` 里）
   返回 **0 个声明**、所有跨度算成 1 行，自校验红成 `0 != 225`；
2. **`--src` 的解析顺序敏感** ⇒ 见 §十一·〇。

两次都指向同一件事：**仪器的"找不到"会被显示成一个看起来合法的数字（0 或 1）**，而不是报错。
这与上一轮 `let/var`、`async` 两个缺口完全同族。

### 十一·二　以 `appendLayer` 为根（`store.ts` 内最大的一条写入链）

```
$ node scripts/families.mjs appendLayer --src store.ts
appendLayer: 9 declaration(s), 225 lines
8 connected component(s), 222 lines in the table (+ 3 for the removed ambiguous member = 225)
跨度之和 == 闭包总行数（225 == 225），逐成员与编译器 0 差

#1  1 decl / 131 lines   appendLayer
#2  1 decl /  30 lines   SkillMeta
#3  1 decl /  20 lines   normalizeEvidenceRefs
#4  1 decl /  20 lines   planLayerArchive
#5  1 decl /  14 lines   LayerRecord
#6  1 decl /   5 lines   monotonicTimestamp
#7  1 decl /   1 lines   MAX_LAYER_RECORDS
#8  1 decl /   1 lines   lastIssuedMs
```

### 以 `renderSkill` 为根（`store.ts` 内最大的声明，154 行）

```
$ node scripts/families.mjs renderSkill --src store.ts
8 connected component(s), 221 lines in the table
跨度之和 == 闭包总行数（222 == 222），逐成员与编译器 0 差

#1  1 decl / 154 lines   renderSkill
#2  1 decl /  30 lines   SkillMeta
#3  1 decl /  12 lines   asVocab
#4  1 decl /  10 lines   evidenceBodyLines
#5  1 decl /   6 lines   frontmatter
#6  1 decl /   5 lines   clampConfidence
#7  1 decl /   4 lines   SkillConflict
```

### 十一·三　实测闭包表（`move-gate --cluster … --src store.ts`）

> **口径**：`families` 报的是**声明跨度和**（这些函数自己占的行）；
> `move-gate` 报的是**搬迁闭包**（这些函数 + 它们必须一起带走的东西）。**判断能不能搬要用后者。**

| 组 | 声明跨度（families） | **闭包（move-gate，按「文件:名字」）** | `mutable` | 倍数 |
|---|---|---|---|---|
| 第 0 步 `clock` 三件套 | 9 | **9 行 / 3 声明** | **`[lastIssuedMs]` ← 刻意** | 1.0× |
| B `io` 原语 | 80 | **91 行 / 9 声明** | `none` | 1.1× |
| A1 `skill` 读写 | 435 | **795 行 / 48 声明** | `none` | **1.8×** |
| A3 `layer` 写入 | 332 | **478 行 / 25 声明** | **`[lastIssuedMs]`** | 1.4× |
| A2 `lifecycle` | 466 | **848 行 / 47 声明** | `none` | **1.8×** |

**这张表是本清单最重要的数据**，因为它直接改写了三条判断：

1. **A2 闭包 848 > 800 ⇒ 当前不可搬**（上一版按组跨度 466 写，低估近一倍）；
2. **A3 的 `mutable` 不是 `none`** —— 它拖着 `lastIssuedMs`，**现在不可搬**；
3. **A1 闭包 795，距离 800 上限只剩 5 行** —— 随时会因为一个 helper 被拉进去而超限。

**闭包普遍是组跨度的 1.5–1.9 倍。** 拿组跨度当"这个模块多大"，会系统性低估。

### 读法

**根换成 `appendLayer` 或 `renderSkill` 后，各牵出约 220 行、7–8 个分量，绝大多数是 1 声明的孤点。**
这说明 `store.ts` 里**不存在 `applyInner` 那种"一个根吸走一切"的结构** ——
这点很重要：它意味着按职责拆文件**不会**像拆 `applyInner` 那样撞上一个 1,362 行的巨物。

**但"没有巨物"不等于"好拆"**：闭包普遍是跨度的 1.5–1.9 倍，
说明 `store.ts` 的耦合是**弥散**的（很多小 helper 被多组共用），而不是集中在某一处。
所以拆分的难度不在"切哪一刀"，而在**先把共享 helper 归位**（第 0 步与 B 就是干这个的）。

> 关于"#2 的 C1 判定"的准确表述（上一版报告写成了"混杂"，那是**缩水**了机制结论）：
>
> 原文是：
>
> > 「这是 **index.ts 里所有还没搬走的东西**，不是一个职责。
> > 它的边界来自**根 `applyInner` 把这些函数连起来**，而不是它们互相依赖。」
>
> **"边界来自根的连接" ≠ "它们互相依赖"。**
> 前者是**结构性**观察：去掉根，这些函数之间未必有边，分量的形状由**测量方式**决定；
> 后者是**耦合性**判断：它们彼此调用，属于真正该拆的代码。
>
> 两者的处置完全不同：前者说明"这个分量不该被当成一个模块候选"，
> 后者说明"这堆代码耦合过重"。**把它们压缩成"混杂"，就把一个可复核的机制结论变成了一句主观印象。**

---

## 十二、汇总表

| 编号 | 位置 | 性质 | 运行时影响 | 修它行数 | 建议时机 |
|---|---|---|---|---|---|
| **D-1** | `retrieve.ts` `hitOf` / `MemoryHit` | **未完成功能**（降权生效、文案不生效） | **有**（过期前缀永不出现） | 2 + 测试~15 | **重构完成后**，且先修测试再修代码 |
| D-2 | `extract.ts` `ExtractedExperience` | 类型欠账 | 无 | 1 | 重构完成后，一批 |
| D-3 | `extract.ts` `LlmLike.stream` | 类型欠账 | 无 | 1 | 重构完成后，一批（取值集合仍未验证，见 §十三） |
| D-4 | `store.ts` `LayerRecord` | 类型欠账 | 无 | 1 | 重构完成后，一批 |
| D-5 | `dedupe.ts` `NegativeRecord` | 类型欠账 | 无 | 2 | 重构完成后，一批 |
| D-6 | `store.ts:2215` | 纯结构可赋值性 | 无 | 1 | 重构完成后，一批 |
| D-7 | `index.ts:21,65` | 合并遗留 | 无 | 2 | 重构完成后，一批 |
| （附） | 类型环 → `types.ts` | 结构优化 | 无 | 3 文件 / 4 处 | **只评估，不实施** |
| （附） | `2339 ledger-cache.ts:472` | **环境产物** | 无（`?.()` 有 fallback） | 0（装 `@types/node` 自消） | 不修 |

**合计：代码 10 行可清掉 D-1..D-7 这 7 条，其中只有 D-1 改行为。**

> **裁定（按用户 2026-11-14）：D-1..D-7 全部等 `store.ts` 重构完成后再修。**
> 理由见 §十末尾：先修再搬，`verify-pure-move` 会红在类型改动上而不是搬运上，参照就没了。

---

## 十三、未验证

| 项 | 状态 |
|---|---|
| D-3 的 `reasoningEffort` 合法取值集合 | **保持标注，本轮不补测。** 只知 `'off'` 会被某些 provider 拒绝；宿主 adapter 源码未读。**修 D-3 时必须先补这一项**，否则写下的类型范围可能是错的 |
| `validAt` 会不会将来被读 | **保持标注，本轮不补测。** 只核了当前代码没有读者；只要有读者，就是第 8 条同型缺陷 |
| D-1 修复后是否影响既有测试 | 未实施，因此未测；但已证明 **v021 对它不敏感**，所以"测试通过"不能当验证 |
| 第 0 步搬走后时钟是否仍是同一个实例 | 只预演了 `mutable` 变化（`none` / `[lastIssuedMs]`），**没跑全套测试验证 `resetMonotonicClockForTest` 的穿通** |
| A1 闭包 795 行的类型归属（`SkillMeta` / `VOCAB_TAG` 等） | 未决策；动手前必须先定，否则很容易超 800 |
| A2 闭包 848 行怎么瘦到 800 以下 | 只知道要先做 A1/A3 把 IO 与 skill helper 分出去，**没实测瘦身后是多少** |
| 类型环拆分后的对外 import | 验了 `lib/retrieve.js` 导出数 34→34，但**没验 `lib/index.js` 的导出面** |
