# retrieve.ts 拆分 · 下一个目标：L4 与 `skillDocuments`（121 行）

> 前一份：`docs/retrieve-split-step3.md`（第三步：commitCache 族）。
>
> **本文件只出方案与数据，不搬代码。** 数据由 `closure.mjs --declarations` /
> `retrieve-report.mjs --json` 程序算出。

现状：`src/retrieve.ts` **1673 行 / 64 声明**，四步搬运后剩余 5 个拓扑层。

---

## 一、五层现状

| 层 | 行数 | 声明数 | 该层最大单函数 | 占比 |
|---|---|---|---|---|
| L0 | 596 | 25 | `retrieveWithFilter`(139) | 23.3% |
| L1 | 186 | 11 | `classifyScene`(63) | 33.9% |
| L2 | 172 | 9 | **`scoreDocuments`(108)** | **62.8%** ← 单函数过半 |
| L3 | 111 | 11 | `allowsTask`(32) | 28.8% |
| **L4** | **236** | **8** | **`skillDocuments`(121)** | **51.3%** ← 单函数过半 |

**按行数（小→大）**：L3(111) < L2(172) < L1(186) < **L4(236)** < L0(596)
**按声明数（小→大）**：**L4(8)** < L2(9) < L1(11) = L3(11) < L0(25)

> **订正（2026-11-15，用户裁定①②）**：本节原先写「L4 是当前**最小的一层**（236 行 / 8 声明），
> 也是**唯一**一个『单个函数占掉一半』的层」。两处都错，实测否证：
>
> **① 「最小」只在声明数上成立，行数上是第二大。** 行数最小的是 **L3（111 行）**，
> L4 的 236 行排在 L0(596) 之后、L1(186) 之前。「最小」这个词不加限定就写出来，
> 会让下一步的选型理由（「因为它小所以先动它」）建立在错的数字上。
>
> **② 「唯一」不成立：L2 也过半，而且更极端。** `scoreDocuments` 是 **108/172 = 62.8%**，
> 比 `skillDocuments` 的 121/236 = 51.3% 更集中。所以「单函数占掉一半」不是 L4 的特征，
> 是**这一层的通病**（L2 和 L4 都有）。
>
> 选 L4 仍然合理，但理由要换成**可验证的那条**：L4 是**声明数最少**的一层（8 个），
> 且 8 个里有 7 个是纯取数/构造函数（`skillDocuments` / `negativeDocuments` / `layerDocuments` /
> `tierDocumentOf` / `contentOf` / `looksLikeIncidentLog` + 2 个常量），职责同族、适合整块搬。
> 不是「因为它最小」。

---

## 二、L4 的 8 个声明

| 声明 | 区间 | 行数 | 性质 |
|---|---|---|---|
| `ERROR_IDENTIFIER` | L508 | 1 | const（正则） |
| `STOPWORDS` | L358–L362 | 5 | const（集合） |
| `contentOf` | L566–L570 | 5 | 取正文的纯函数 |
| `looksLikeIncidentLog` | L442–L447 | 6 | 用 `INCIDENT_MARKERS` 判定 |
| `tierDocumentOf` | L65–L85 | 21 | 索引行 → Document |
| `layerDocuments` | L804–L835 | 32 | JSONL 层 → Document[] |
| `negativeDocuments` | L757–L801 | 45 | negatives.jsonl → Document[] |
| **`skillDocuments`** | **L605–L725** | **121** | SKILL.md → Document[] |

合计 **236 行**。

### 段外引用：**8/8 全部有**（不是 0）

整块搬走之前必须知道：这 8 个声明里**没有任何一个是纯内部**。每一个都被 L4 之外的代码调用，
所以搬走后 `retrieve.ts` 必须逐个 import 回来。

| 声明 | L4 之外的使用者 |
|---|---|
| `ERROR_IDENTIFIER` | `allowsTask` |
| `STOPWORDS` | `extractTaskTerms`、`allowsTask`、`scoreDocuments` |
| `contentOf` | `isPoisoned`、`Document`（类型层）|
| `layerDocuments` | `memoryDocumentsFor`、`collectAllDocuments` |
| `looksLikeIncidentLog` | `allowsTask` |
| `negativeDocuments` | `memoryDocumentsFor`、`collectAllDocuments` |
| `skillDocuments` | `collectAllDocuments`、`scoreDocuments` |
| `tierDocumentOf` | `memoryDocumentsFor` |

### re-export 只需 **1 个**

运行时导出面对这 8 个的态度不一样，实测：

| 名字 | 源码里带 `export`？ | 需要 re-export？ |
|---|---|---|
| `looksLikeIncidentLog` | **是** | **是**（唯一一个）|
| 其余 7 个 | 否（模块私有）| 否，只需 import |

`looksLikeIncidentLog` 在 `lib/retrieve.js` 的运行时导出面上（34 条之一），搬走后必须
re-export 回去，否则公开面缩小。其余 7 个原本就是私有的，搬走只需要 `retrieve.ts` 侧 import。

> 这一栏之前漏了。第一步（14 声明）是「1 个 re-export + 11 个 import」，第二步是
> 「2 个 re-export + 1 个 import」，第三步是「3 个 re-export + 3 个 import」——
> 每一步的组合都不同，不预先算清就会在搬完那一刻才发现公开面缩小。

---

## 三、`skillDocuments` 的实测形状

### 闭包

```
3 声明 / 180 行 / mutable: none
成员: Document, DocumentKind, skillDocuments
```

**闭包只有 3 个声明，其中 2 个是类型。** 也就是说：它没有和别的函数纠缠——
它自己是 121 行的一整块。

### 内部阶段（程序扫出的骨架）

```
L606  const cacheKey = skillDirKey(skillsDir, now)        ← 缓存键
L607  const cached = getCachedSkillDocs<Document>(…)      ← 读缓存
L608  if (cached !== undefined) return cached
L609  let names: string[] = []
L610  try {                                                ← 列目录
L620  const neighbors = new Map<string, string[]>()        ← 冲突邻接
L621  for (const name of names) neighbors.set(…)
L622  const edgesOf = (name: string): string[] => …
L623  const out: Document[] = []
L624  for (const name of names) {                          ← 主循环（100 行）
L724  return out
```

**主循环 L624–L723 是 100 行**，其余 21 行是缓存与目录枚举。

---

## 四、这是「函数太长」，不是「声明纠缠」

这一点决定了拆法：

| 症状 | 本层的实际情况 |
|---|---|
| 声明互相引用，搬不动 | **不是** —— 闭包只有 3 个声明，2 个是类型 |
| 一个函数里塞了多个阶段 | **是** —— 缓存 / 目录枚举 / 邻接构建 / 渲染循环 |
| 有模块级可变状态 | **不是** —— `mutable: none` |

所以 L4 不能靠「搬声明」变小。要么：

- **A. 整块搬**（8 声明 / 236 行 → `retrieve/documents.ts`），函数保持 121 行不变；
- **B. 先拆函数**（把 L624–L723 的循环体提出为独立函数），再搬。

---

## 五、两个方案

### 方案 A：整块搬 8 声明（推荐先做）

- 新模块 `src/retrieve/documents.ts`，约 **280 行**（236 行 + 头注释 + import）
- `retrieve.ts` 降到约 **1440 行**
- **不改任何函数体** ⇒ `verify-pure-move --classify` 的判据直接适用（逻辑 0）
- 风险点：`skillDocuments` 用 `skillDirKey` / `getCachedSkillDocs`，`layerDocuments` /
  `negativeDocuments` 用 `documentCache`（已搬进 `interning.ts`）——
  这些都要 import，且 `documentCache` 是 `const-mutated`，**必须确认它的变异者跟它在一起**

### 方案 B：先拆 `skillDocuments` 的函数体

把 L624–L723 的循环体提成 `renderSkillDocument(name, …)`，主函数变薄。
- `verify-pure-move` **不适用**（这是编辑，不是位移）⇒ 只能靠测试与 `--classify` 逐行解释
- 风险：121 行里有多处闭包捕获 `neighbors` / `edgesOf` / `out`，提取要传参
- 收益：`skillDocuments` 从 121 行降到约 40 行，是真正的可读性改善

**建议顺序：先 A 后 B。** A 是纯位移、有机械判据；B 是编辑、需要人工复核。
先 A 让文件降到 1440 行（离 800 更近），再在独立模块里做 B（影响面更小）。

---

## 六、方案 A 开工前必须核实的三件事

1. **`documentCache` 的变异者**：它在 `interning.ts`（第一步搬走，`const-mutated`）。
   `layerDocuments` / `negativeDocuments` 会 `.set()` 它 —— 若搬走后两侧都要写同一个 Map，
   必须确认它是**同一个绑定**（`import` 单个导出），而不是各建一份。
2. **`skillDirKey` / `getCachedSkillDocs` 的来源**：前者在 `interning.ts`，后者在 `skill-cache.ts`。
   两者都是值 import，不构成环（`skill-cache.ts` 不 import retrieve）。
3. **`Document` / `DocumentKind` 的类型来源**：`retrieve.ts` 已 `export type` 它们
   （第一步加的），新模块 `import type` 即可。

---

## 七、与既有约定的一致性

- 每一步都先做三项前置分析（簇内闭包 ⊆ N / 对簇外依赖含 import 符号 / 段外引用）
- 新模块必须 ≤ 800 行，并在 `test/v205` 的 `SCANNED` 里登记
- 搬完 `retrieve.ts` 的 ceiling 必须**收紧到新实测值**（`test/v205` 的棘轮断言会强制）
- `verify-pure-move --against <父提交> --classify` 必须逻辑 0

---

## 八、没做的事

- 没搬任何代码（本文件是方案）
- `hitOf`（D-1 落点）仍在 `retrieve.ts` L2 层，按裁定等重构完成后再修
- `index.ts` 2361 行仍在 `EXEMPT`
- 不 publish、不碰 paradise、desktop profile 不动
