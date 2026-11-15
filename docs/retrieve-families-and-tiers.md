# retrieve.ts 分量表 + 四档（只出表，不搬）

> 目标文件：`src/retrieve.ts`，**2009 行 / 89 个顶层声明**。
> 这一步**不搬任何代码**。理由：D-1 落在 `hitOf`，按裁定要等重构完成后才修，
> 而 `hitOf` 就在这个文件里 —— 先看清它的结构，拆才有依据。
>
> 本文件的每个数字都可以用 `_scratch/retrieve-report.mjs` 重跑（编译器口径，见第二节）。

---

## 〇、先说仪器：`families.mjs` 在这个文件上是坏的

出这张表的过程中，`scripts/families.mjs` 给出了一份**看起来合理但完全错误**的分量表：

```
retrieveWithFilter: 70 declaration(s), 1298 lines
62 connected component(s), 2647 lines in the table
#1  1 decl / 1427 lines   INCIDENT_MARKERS
...
WARNING: declaration spans total 2717 != closure total 1298 (difference 1419)
```

`INCIDENT_MARKERS` 是 **8 行**的正则数组：

```ts
const INCIDENT_MARKERS: readonly RegExp[] = [
  /(报错|抛错|崩溃|异常栈|堆栈|复现|临时修复|热修|踩坑|翻车|故障)/u,
  /(traceback|stack trace|exception|assertionerror|typeerror|referenceerror|segmentation fault)/iu,
  ...
]
```

`spanOf` 是手写括号配平器，它把正则里的 `\(` 与 `(…)` 当成语法括号记账，
于是从第 1 行开始配平，一路读到后面某个把深度归零的 `}` 才收尾 ⇒ **8 行被算成 1427 行**。

**`1419` = `1427 − 8`** —— 自校验报的全部差额，就是这一处。

一个假分量吞掉 68 个声明，整张表的排序因此全部失效。

### 我试过修仪器，失败了，已回滚

写了一个遮蔽器（配平前把字符串 / 模板串 / 正则 / 注释置空）。它修好了 `retrieve.ts`，
**但把 `index.ts` 的 `applyInner` 从 1362 行算成 704 行** —— 基线破裂。按红线回滚。

回滚后核对基线复原：

```
$ node scripts/families.mjs --src index.ts applyInner
6 connected component(s), 2061 lines in the table (+ 1 for the removed ambiguous member = 2062)
跨度之和 == 闭包总行数（2062 == 2062），逐成员与编译器 0 差。
```

**所以本表改用 TypeScript 编译器取行区间** —— 同一个编译器 `closure.mjs` 也在用
（`typescript 5.9.3`，从工作区上层 `node_modules` 解析，不是本包的依赖）。

> 这是本轮第三次「仪器的一个缺陷伪装成一个结论」（前两次见 `docs/A2-final-report.md`
> 的 fs 计数与 `puremove-classify.mjs` 的 import 续行）。
> `families.mjs` 自己的注释里记过五次同类教训 —— 这一次是第六次，且它的自校验只把它变成一行 WARNING。

---

## 一、口径

| 项 | 取值 |
|---|---|
| 行区间 | TypeScript 编译器 `getStart()/getEnd()` |
| 边 | **只算值引用**（运行期耦合）。类型引用构建时被 `stripTypeScriptTypes` 擦除，不计入 —— 与 `check-cycles.mjs` 的 ACYCLIC 判据同口径 |
| 分量 | 无向连通（`families.mjs` 的语义），但用上表的行区间与边 |

---

## 二、值引用无向连通分量：19 个

| # | 声明数 | 行数 | 构成 |
|---|---|---|---|
| **1** | **68** | **1251** | 全部 `const` / `function` / `let` —— 检索管线的整条主干 |
| 2 | 1 | 58 | `Document` |
| 3 | 1 | 49 | `FilterOptions` |
| 4 | 1 | 41 | `MemoryHit` |
| 5 | 1 | 31 | `RetrieveResult` |
| 6 | 3 | 21 | `MEMORY_ISOLATION_OPEN` / `_CLOSE` / `isolateHint` |
| 7 | 1 | 14 | `CandidateOptions` |
| 8 | 1 | 10 | `TaskAlignmentGate` |
| 9 | 1 | 10 | `FilterTrace` |
| 10 | 1 | 8 | `Scored` |
| 11 | 2 | 8 | `FIX_INTENT` / `askAsksForFix` |
| 12–16 | 各 1 | 4–8 | `DocumentCacheEntry` / `HybridRecallOptions` / `SceneOptions` / `SceneCacheEntry` / `WorkspaceGate` |
| 17–19 | 各 1 | 1 | `DocumentKind` / `CJK` / `LATIN` |

**读法**：`retrieve.ts` 不是「几个大块」，而是**一个 1251 行的主干 + 18 个可独立拿走的碎片**。
那 18 个碎片里 14 个是纯类型（interface / type），**零值引用** —— 搬它们只需要 `export type`。

---

## 三、有向 SCC：89 个，**零循环**

这是本文件最重要的一条结论，也是拆分可行性的依据：

```
── 二、有向 SCC：89 个，非平凡（真循环）0 个 ──
  零循环 ⇒ 可以按下方的层逐层切，不会切出循环依赖。
```

89 个声明、没有一对互相引用。所以下面的拓扑层是**单向**的，切任何一层都不会造出环。

---

## 四、拓扑层（层内无值依赖，层间单向）

| 层 | 行数 | 声明数 | 内容 |
|---|---|---|---|
| **L0** | 611 | 28 | `retrieveWithFilter(139)`、`renderHint(118)`、`Document(58)`、`FilterOptions(49)`、`retrieveHybrid(43)`、`MemoryHit(41)`、`RetrieveResult(31)` … |
| L1 | 186 | 11 | `classifyScene(63)`、`retrieve(63)`、`retrieveCandidates(37)`、`collectScenes(8)` … |
| L2 | 172 | 9 | `scoreDocuments(108)`、`hitOf(29)`、`preferHumanInConflict(17)` … |
| L3 | 140 | 14 | `allowsTask(32)`、`currentCommitOf(21)`、`distinctiveTermsOf(17)`、`memoryDocumentsFor(14)` … |
| L4 | 250 | 10 | `skillDocuments(121)`、`negativeDocuments(45)`、`layerDocuments(32)`、`tierDocumentOf(21)` … |
| L5 | 111 | 9 | `negativeDocumentOf(51)`、`layerDocumentOf(36)`、`skillDirKey(9)`、`INCIDENT_MARKERS(8)` … |
| L6 | 64 | 7 | `firstEvidence(17)`、`isStaleNegative(13)`、`clipTitle(12)`、`tokenize(11)` … |
| L7 | 1 | 1 | `NEGATIVE_STALE_DAYS(1)` |

**L0 是出口层**（`retrieveWithFilter` / `renderHint` 对外），**L7 是叶子层**。
按依赖方向切，最先可以整块拿走的是 **L5 + L6 + L7**（176 行 / 17 声明）——
它们不被上层反向依赖，且互相之间只有单向边。

---

## 五、四档（声明粒度）

| 档 | 个数 | 行数 | 成员 |
|---|---|---|---|
| **D 大块 ≥100** | **4** | **486** | `renderHint`、`retrieveWithFilter`、`scoreDocuments`、`skillDocuments` |
| C 中块 40–99 | 8 | 413 | `Document`、`FilterOptions`、`MemoryHit`、`classifyScene`、`negativeDocumentOf`、`negativeDocuments`、`retrieve`、`retrieveHybrid` |
| B 小块 12–39 | 17 | 373 | `CandidateOptions`、`RetrieveResult`、`allowsTask`、`clipTitle`、`currentCommitOf`、`currentIndex`、`distinctiveTermsOf`、`firstEvidence`、`hitOf`、`isStaleNegative`、`isolateHint`、`layerDocumentOf`、`layerDocuments`、`memoryDocumentsFor`、`preferHumanInConflict`、`retrieveCandidates`、`tierDocumentOf` |
| A 碎片 <12 | 60 | 263 | 59 个 + 全部小常量 |

**四个 D 块合计 486 行 = 文件的 24%。** 它们各自是单一职责的大函数，
不是「一堆东西挤在一起」——拆它们要做的是**把函数体内的阶段提出来**，不是搬声明。

---

## 六、零值引用的声明（14 个，可独立搬走）

`DocumentKind`(type, 1) / `SceneOptions`(7) / `SceneCacheEntry`(4) / `MemoryHit`(41) /
`Document`(58) / `Scored`(8) / `WorkspaceGate`(4) / `TaskAlignmentGate`(10) /
`DocumentCacheEntry`(8) / `CandidateOptions`(14) / `HybridRecallOptions`(8) /
`RetrieveResult`(31) / `FilterTrace`(10) / `FilterOptions`(49)

合计 **253 行**。它们只被 `import type` 引用，搬到 `retrieve/types.ts` 只需在
`retrieve.ts` 里加 `export type { … }`，不动任何运行期代码。

> 但注意：**这一步不做。** 这里只记录它是可行的，以及它为什么可行 ——
> 253 行全是类型，构建时本来就不存在，搬它不改变任何运行期行为。

---

## 七、下一步的判断（不执行，只写下来）

D-1 落在 `hitOf`（L2，29 行）。按用户的裁定，D-1 要等重构完成后再修。
所以 `retrieve.ts` 的拆分顺序应当是：

1. **先搬 14 个纯类型**（253 行，零运行期风险，`export type` 即可）→ `retrieve.ts` 降到约 1756 行；
2. 再按 L5+L6+L7 切叶子层（176 行 / 17 声明）；
3. `hitOf` 留在 `retrieve.ts` 里直到 D-1 修完 —— 它只有 29 行，是 L2 的一块，不构成阻塞。

第 1 步就能让 `retrieve.ts` 从 `EXEMPT` 的 2009 天花板上降下来，
而 **`EXEMPT` 是天花板、只能降不能升** —— 降下来之后要同步改那条登记。

---

## 八、这一步没有做的事

- **没有搬任何代码。** `git diff` 对 `src/` 为空。
- 没有改 `families.mjs`（试过、失败了、已回滚，见第〇节）。
- 不 publish、不碰 paradise、D-1…D-7 挂着、desktop profile 不动。
