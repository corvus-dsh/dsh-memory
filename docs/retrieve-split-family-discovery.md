# 族发现：L1/L2/L3 的 25 个声明里有没有可搬的族？

> 2026-11-16。分析脚本：`_scratch/family-discovery.mjs`（口径与 `scripts/retrieve-report.mjs` 一致：
> 只认**值**引用，类型引用在构建时擦除）。
> 结论先行：**没有可搬的族。epic 收尾，`retrieve.ts` = 1074 行是接受形态。**

---

## 一、候选集

第六步之后 `retrieve.ts` 剩 32 个声明。按拓扑层取 L1/L2/L3，得 **25 个声明 / 385 行**：

| 层 | 行数 | 声明 |
|---|---|---|
| L1 | 123 | `DEFAULT_RETRIEVAL_THRESHOLD` `FIX_INTENT` `MEMORY_ISOLATION_CLOSE` `MEMORY_ISOLATION_OPEN` `NEGATIVE_STALE_PREFIX` `TASK_TERM_LIMIT` `collectScenes` `retrieve` `retrieveCandidates` `truncateCandidates` |
| L2 | 158 | `FILTER_MAX_CANDIDATES` `collectDocuments` `hitOf` `preferHumanInConflict` `scoreDocuments` |
| L3 | 104 | `STOPWORD_WEIGHT` `allowsTask` `allowsWorkspace` `collectAllDocuments` `distinctiveTermsOf` `freshness` `isActive` `isPoisoned` `memoryDocumentsFor` `sameConflictDomain` |

剩下的 7 个在 L0（335 行）—— 按裁定⑧不搬，不在本次候选内。

---

## 二、三项前置分析

### ① 区域：25 段，不是一段

25 个声明分成 **25 段**（每个候选自成一簇）。但其中 19 个相邻对之间**只隔着注释或空行**
（0 行非注释代码），真正夹着其它代码的只有 5 处：

| 相邻段之间 | 夹着 | 夹的是什么 |
|---|---|---|
| `TASK_TERM_LIMIT` → `STOPWORD_WEIGHT` | 10 行 | `extractTaskTerms()` |
| `FIX_INTENT` → `distinctiveTermsOf` | 4 行 | `askAsksForFix()` |
| `NEGATIVE_STALE_PREFIX` → `isActive` | 4 行 | `invalidateDocuments()` |
| `retrieveCandidates` → `FILTER_MAX_CANDIDATES` | 29 行 | `retrieveHybrid()` |
| `retrieve` → `MEMORY_ISOLATION_OPEN` | 115 行 | `retrieveWithFilter()` |

⇒ **主要部分在文本上是连续的**（只被注释分隔），但有 5 处被别的代码切开。
这不是「一段连续区域」，可它是**多块搬移**可行的形状（第六步就是多块）。

**所以 ① 不构成否决理由。**

### ② 段外值依赖：9/25 有，最大簇 18 处

| 声明 | 指向谁（全部在**已经拆出去**的模块里） |
|---|---|
| `retrieve` / `retrieveCandidates` | `inferScene`（`scene.js`）|
| `scoreDocuments` | `tokenize`（`interning.js`）、`skillDocuments` / `STOPWORDS`（`documents.js`）、`currentCommitOf` / `sameCommit` / `COMMIT_DRIFT_WEIGHT`（`commit-cache.js`）|
| `allowsTask` | `looksLikeIncidentLog` / `ERROR_IDENTIFIER` / `STOPWORDS`（`documents.js`）|
| `allowsWorkspace` | `normalizeWorkspace` / `memoryAllowsWorkspace`（`workspace.js`）|
| `collectAllDocuments` | `skillDocuments` / `negativeDocuments` / `layerDocuments`（`documents.js`）|
| `isActive` | `isValidAt`（`store.js`）|
| `isPoisoned` | `scanThreat`（`threat.js`）、`contentOf`（`documents.js`）|
| `memoryDocumentsFor` | `currentIndex`（`storage-tier.js`）、`tokenize`（`interning.js`）、`negativeDocuments` / `layerDocuments` / `tierDocumentOf`（`documents.js`）|

16/25 的段外值依赖为 0。

### ③ 闭包自洽：8 个簇，但只**一个**大簇

| 簇 | 声明 | 行数 | 段外值依赖 |
|---|---|---|---|
| **1** | 17 个 | **369** | **18 处** |
| 2 | 2 | 5 | 0 |
| 3–8 | 各 1 | 1–4 | 0 |

- **最大的簇 = 主干**：`retrieve` / `retrieveCandidates` / `scoreDocuments` / `hitOf` / `collectDocuments` /
  `collectAllDocuments` / `collectScenes` / `allowsTask` / `allowsWorkspace` / `isActive` / `isPoisoned` /
  `memoryDocumentsFor` / `preferHumanInConflict` / `sameConflictDomain` / `freshness` /
  `distinctiveTermsOf` / `STOPWORD_WEIGHT`。它 **369 行、18 处段外依赖**。
  搬它 = 把检索流水线整个搬走 = `retrieve.ts` 变纯壳。**那正是裁定⑧不做的「入口点归位」。**
- 另外 7 个簇加起来 **13 行**（最大的是 `FILTER_MAX_CANDIDATES` + `truncateCandidates` 的 5 行）。
  为 5 行新建一个模块，代价是把 import 反向拉回来，收益是行数 −5。

---

## 三、结论：没有可搬的族

三项分析的形状是一致的：**这里的「簇」不是族，是主干本身。**
前五步能搬，是因为那些声明**聚成一团且闭包自足**（场景族 10 个/101 行自成闭环、类型族只互相引用）；
L1/L2/L3 的这 25 个不是那种东西 —— 它们是检索流水线的**所有环节**，
彼此通过「调用顺序」而不是「类型形状」耦合，而调用顺序不能靠搬文件表达。

于是 epic 收尾：**`retrieve.ts` = 1074 行是接受形态。**

### 为什么不搬那 7 个小簇（13 行）

不是为了「省事」，是因为**它们不是同一类东西**：

- 5 个单行常量（`DEFAULT_RETRIEVAL_THRESHOLD` / `NEGATIVE_STALE_PREFIX` / `TASK_TERM_LIMIT` /
  `MEMORY_ISOLATION_CLOSE` / `MEMORY_ISOLATION_OPEN`）—— 搬走之后 `retrieve.ts` 还是要 import 它们回来，
  行数只降 5，而模块数 +1，依赖图上多一条边。
- `FIX_INTENT` + `askAsksForFix`（不搬 `askAsksForFix` 就是半搬）—— 同上。
- `FILTER_MAX_CANDIDATES` + `truncateCandidates`（5 行）—— 这是唯一有内聚语义的一对，
  但 5 行的模块不值得存在。

**「行数达标」不是目的**：一个 1074 行、每个声明都有理由待在这里的文件，
比一个 1069 行、多出一个 5 行模块、多一条反向 import 的文件更健康。

---

## 四、如果将来真要压到 800 以内

只有一条路，而且它不是搬运：

1. **入口点归位**（owner 决定）：把 L0 也搬走，`retrieve.ts` 变成 `store.ts` 那种壳（≈354 行），
   `index.ts` 的公开面与 `package.json` 的 `types` 指向跟着调整。
2. 或者**改判据**：如果 800 这个数字本身不再重要，就把它从门禁里去掉 ——
   但那要明确写「为什么 800 对检索层不适用」，而不是悄悄放宽。

两条都不是「下一步搬哪层」。
