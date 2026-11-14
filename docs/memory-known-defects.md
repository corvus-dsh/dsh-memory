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

### 方案（按"先小后大"排，都不实施）

| 方案 | 做法 | 切出来多大 | 好处 | 代价 |
|---|---|---|---|---|
| **B（先做）** | 抽 IO 原语到 `store/io.ts` | **63 行 / 5 声明**（另加 `updateJsonlFile` 归到 JSONL 层） | 最小、纯搬运、`OUTSIDE` 最少；**族边界会因此变清楚** | 收益小（`store.ts` 仍 2,400+ 行） |
| **A1** | 抽 SKILL 读写到 `store/skill.ts` | **435 行 / 12 声明** | 概念上最独立（它读写的是 `SKILL.md` 文本，不是 JSONL） | 要处理 `atomicWrite` 依赖（B 做完就没问题） |
| **A2** | 抽生命周期到 `store/lifecycle.ts` | **466 行 / 9 声明** | 最大的一块，语义完整（validity / supersede / quarantine / feedback） | 依赖 SKILL 读写的几个 helper，应排在 A1 之后 |
| **A3** | 抽 JSONL 层写入到 `store/layer.ts` | **332 行 / 8 声明** | `appendNegatives` / `appendLayer` 是同构的，本来就该在一起 | 依赖 IO 原语（B 之后） |
| **C（不建议）** | 按"写 / 读 / 校验"三分 | — | 职责听起来最清晰 | **读写共用大量私有 helper，强行三分会造出跨文件环** —— 本仓已有一个仅类型环，不该再加 |

### 建议顺序与理由

**B → A1 → A3 → A2**，理由是**依赖方向**而不是"哪个大先做"：

```
IO 原语(63)  ←  JSONL 层写入(332)  ←  生命周期(466)
     ↑                                      ↑
     └────────  SKILL 读写(435)  ───────────┘
```

- `atomicWrite` 被 SKILL 读写和 JSONL 写入**同时**依赖，它必须**先**独立（B）；
- 然后 A1 与 A3 互不依赖，可以任选（A1 更大，先做能更早看到收益）；
- A2 依赖 A1 的 helper，排最后；
- **每一步都是纯搬运**，每步都用 `verify-pure-move --against <上一步>` 验，红就停。

### 关键风险（必须先说）

1. **`store.ts` 的对外面很宽**：它是本仓的"仓储层"，`index.ts`、`retrieve.ts`、`archive.ts` 都从它 import。
   任何拆分都必须**只加 re-export、不改调用点**，否则 diff 会大到自己都看不懂；
2. **`104 个声明 / 1,899 行`意味着大量私有 helper**：它们会被多组共用。
   分组时**先量闭包再动手**（`closure --cluster`），不要按名字猜测归属；
3. **B 的 63 行是否值得**：单看收益很小。但它的价值是**为后三步清掉共享依赖** ——
   这是"先做小步"的唯一正当理由，不是"小步安全所以做小步"。

### 不做什么

- **不搬族**（本清单不含任何搬运）；
- **不动 paradise**；
- **不在修 D-1..D-7 的同时动 `store.ts` 的结构** —— 两种改动混在一起，`verify-pure-move` 就没法当参照。

---

## 十一、附：`store.ts` 的分量表（families 实测）

> **测量入口先修了一次仪器**：`families.mjs` 原先把文件名 `index\.ts` **写死在成员正则与 `spanOf` 里**，
> 于是 `families.mjs appendLayer`（在 `store.ts` 里）返回 **0 个声明**、所有跨度都算成 1 行，自校验红成 `0 != 225`。
> 那不是"store.ts 没有族"，是**仪器只看得见 index.ts**。已加 `--src <file>` 参数（默认仍是 `index.ts`）。

### 以 `appendLayer` 为根（`store.ts` 内最大的一条写入链）

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

### 读法

**两个根各牵出约 220 行、7–8 个分量，其中绝大多数是 1 声明的孤点。**
这说明 `store.ts` 里**不存在 `applyInner` 那种"一个根吸走一切"的结构** ——
这点很重要：它意味着按职责拆文件**不会**像拆 `applyInner` 那样撞上一个 1,362 行的巨物。

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
| **D-1** | `retrieve.ts` `hitOf` / `MemoryHit` | **未完成功能**（降权生效、文案不生效） | **有**（过期前缀永不出现） | 2 + 测试~15 | **先修测试，再修代码** |
| D-2 | `extract.ts` `ExtractedExperience` | 类型欠账 | 无 | 1 | 与 D-1 同批 |
| D-3 | `extract.ts` `LlmLike.stream` | 类型欠账 | 无 | 1 | 与 D-1 同批（先确认取值集合） |
| D-4 | `store.ts` `LayerRecord` | 类型欠账 | 无 | 1 | 与 D-5/D-6 同批 |
| D-5 | `dedupe.ts` `NegativeRecord` | 类型欠账 | 无 | 2 | 与 D-4/D-6 同批 |
| D-6 | `store.ts:2215` | 纯结构可赋值性 | 无 | 1 | 与 D-4/D-5 同批 |
| D-7 | `index.ts:21,65` | 合并遗留 | 无 | 2 | 与上面任一批 |
| （附） | 类型环 → `types.ts` | 结构优化 | 无 | 3 文件 / 4 处 | 排在 D-1 之后 |
| （附） | `2339 ledger-cache.ts:472` | **环境产物** | 无（`?.()` 有 fallback） | 0（装 `@types/node` 自消） | 不修 |

**合计：代码 10 行可清掉 D-1..D-7 这 7 条，其中只有 D-1 改行为。**

---

## 十三、未验证

| 项 | 状态 |
|---|---|
| D-3 的 `reasoningEffort` 合法取值集合 | **没读宿主 adapter 源码**；只知 `'off'` 会被某些 provider 拒绝 |
| D-1 修复后是否影响既有测试 | 未实施，因此未测；但已证明 **v021 对它不敏感**，所以"测试通过"不能当验证 |
| `store.ts` 的 A/B/C 方案哪个更好 | 只给了依据与建议，**没做四档实测**（B 的搬运闭包未量） |
| `validAt` 会不会将来被读 | 只核了当前代码；只要有读者，就是第 8 条同型缺陷 |
| 类型环拆分后的对外 import | 验了 `lib/retrieve.js` 导出数 34→34，但**没验 `lib/index.js` 的导出面** |
