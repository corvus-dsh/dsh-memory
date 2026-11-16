# 族发现：L1/L2/L3 的 25 个声明里有没有可搬的族？

> 2026-11-16。**复算命令**（本文件的所有数字都来自它，没有一处手算）：
>
> ```bash
> node scripts/retrieve-report.mjs --clusters
> ```
>
> 口径与 `retrieve-report.mjs` 其余部分一致：只认**值**引用，类型引用在构建时擦除。
> 结论先行：**没有可搬的族。epic 收尾，`retrieve.ts` = 1074 行是接受形态。**

---

## 一、候选集

第六步之后 `retrieve.ts` 剩 32 个声明。按拓扑层取 L1/L2/L3（L0 按裁定⑧不搬），
得 **25 个声明 / 385 行**：

| 层 | 行数 | 声明 |
|---|---|---|
| L1 | 123 | `DEFAULT_RETRIEVAL_THRESHOLD` `FIX_INTENT` `MEMORY_ISOLATION_CLOSE` `MEMORY_ISOLATION_OPEN` `NEGATIVE_STALE_PREFIX` `TASK_TERM_LIMIT` `collectScenes` `retrieve` `retrieveCandidates` `truncateCandidates` |
| L2 | 158 | `FILTER_MAX_CANDIDATES` `collectDocuments` `hitOf` `preferHumanInConflict` `scoreDocuments` |
| L3 | 104 | `STOPWORD_WEIGHT` `allowsTask` `allowsWorkspace` `collectAllDocuments` `distinctiveTermsOf` `freshness` `isActive` `isPoisoned` `memoryDocumentsFor` `sameConflictDomain` |

§ 层的成员表同样由工具给出：`node scripts/retrieve-report.mjs` 的「拓扑层」一节。

---

## 二、逐字输出（复算命令）

```
── 族发现：L1+L2+L3（25 声明 / 385 行）的连通簇 ──
  #  声明  行数  段外  成员
   1    17   369    18  STOPWORD_WEIGHT, allowsTask, allowsWorkspace, collectAllDocuments, collectDocuments, collectScenes, …（共 17）
   2     2     5     0  FILTER_MAX_CANDIDATES, truncateCandidates
   3     1     1     0  DEFAULT_RETRIEVAL_THRESHOLD
   4     1     4     0  FIX_INTENT
   5     1     1     0  MEMORY_ISOLATION_CLOSE
   6     1     3     0  MEMORY_ISOLATION_OPEN
   7     1     1     0  NEGATIVE_STALE_PREFIX
   8     1     1     0  TASK_TERM_LIMIT

  小簇合计（除最大簇）：7 个 / 16 行
  #1 的段外值依赖 18 处：COMMIT_DRIFT_WEIGHT (import ./retrieve/commit-cache.js); ERROR_IDENTIFIER (import ./retrieve/documents.js); STOPWORDS (import ./retrieve/documents.js); contentOf (import ./retrieve/documents.js); currentCommitOf (import ./retrieve/commit-cache.js); currentIndex (import ./retrieve/storage-tier.js); inferScene (import ./retrieve/scene.js); isValidAt (import ./store.js); layerDocuments (import ./retrieve/documents.js); looksLikeIncidentLog (import ./retrieve/documents.js); memoryAllowsWorkspace (import ./workspace.js); negativeDocuments (import ./retrieve/documents.js); normalizeWorkspace (import ./workspace.js); sameCommit (import ./retrieve/commit-cache.js); scanThreat (import ./threat.js); skillDocuments (import ./retrieve/documents.js); tierDocumentOf (import ./retrieve/documents.js); tokenize (import ./retrieve/interning.js)
```

**8 个簇；除最大簇外的 7 个簇合计 16 行**（5+1+4+1+3+1+1 = 16，全部是 1–2 个声明的小簇）。

---

## 三、三项前置分析（按裁定要求的三项逐条读）

工具一次给出三个数，**只看其中一个都会得出相反结论**。

### ① 区域：25 段，不是一段

**这一项工具不打印**（`--clusters` 只给簇、行数、段外依赖），段是照着成员表算的：

25 个声明在文本上分成 **25 段**。其中 19 个相邻对之间**只隔着注释或空行**，
真正夹着其它代码的只有 **5 处**：

| 相邻声明之间 | 夹着 | 夹的是什么 |
|---|---|---|
| `TASK_TERM_LIMIT` → `STOPWORD_WEIGHT` | 10 行 | `extractTaskTerms()` |
| `FIX_INTENT` → `distinctiveTermsOf` | 4 行 | `askAsksForFix()` |
| `NEGATIVE_STALE_PREFIX` → `isActive` | 4 行 | `invalidateDocuments()` |
| `retrieveCandidates` → `FILTER_MAX_CANDIDATES` | 29 行 | `retrieveHybrid()` |
| `retrieve` → `MEMORY_ISOLATION_OPEN` | 115 行 | `retrieveWithFilter()` |

⇒ **主要部分在文本上连续**（只被注释分隔），但有 5 处被别的代码切开。
第六步就是多块搬移，所以 **① 不构成否决理由**。

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

### ③ 闭包自洽：8 个簇，但只**一个**大簇，且它不闭合

最大簇：**17 声明 / 369 行 / 段外依赖 18 处**。成员是
`retrieve` `retrieveCandidates` `scoreDocuments` `hitOf` `collectDocuments` `collectAllDocuments`
`collectScenes` `allowsTask` `allowsWorkspace` `isActive` `isPoisoned` `memoryDocumentsFor`
`preferHumanInConflict` `sameConflictDomain` `freshness` `distinctiveTermsOf` `STOPWORD_WEIGHT` ——
即**检索流水线的全部环节**。

它占了候选集 **369/385 行**，却又把 18 处依赖伸到簇外。两个事实合起来只有一个读法：
**它不是族，是主干。**

---

## 四、结论：没有可搬的族

三项分析的形状是一致的。前几步能整片搬走，是因为那些声明**聚成一团且闭包自足**
（场景族 10 个/101 行自成闭环；契约类型族只互相引用、零值边）。
L1/L2/L3 这 25 个的耦合靠**调用顺序**，而调用顺序不能靠搬文件表达。

于是 epic 收尾：**`retrieve.ts` = 1074 行是接受形态。**

### 为什么不搬那 7 个小簇（合计 16 行）

不是「省事」，是因为**它们不是同一类东西**：

- 5 个单行常量（`DEFAULT_RETRIEVAL_THRESHOLD` / `NEGATIVE_STALE_PREFIX` / `TASK_TERM_LIMIT` /
  `MEMORY_ISOLATION_CLOSE` / `MEMORY_ISOLATION_OPEN`）—— 搬走后 `retrieve.ts` 仍要 import 它们回来，
  行数 −5，模块 +1、依赖图 +1 边。
- `FIX_INTENT`（4 行）—— 它是**单声明簇**：它唯一的语义伙伴 `askAsksForFix()` 在 **L0（不在候选集）**，
  所以候选集里它就是孤立的 4 行。搬它 = 把「正则表」和它的使用者分开住。
- `FILTER_MAX_CANDIDATES` + `truncateCandidates`（5 行）—— 唯一有内聚语义的一对，
  但 5 行的模块不值得存在。

**「行数达标」不是目的**：一个 1074 行、每个声明都有理由待在这里的文件，
比一个 1069 行、多出一个 5 行模块、多一条反向 import 的文件更健康。

---

## 五、如果将来真要压到 800 以下

只剩一条**搬运式**路径，而且它已经不是搬运：

1. **入口点归位**（owner 决定）：把 L0 也搬走，`retrieve.ts` 变成 `store.ts` 那种壳（≈354 行），
   `index.ts` 的公开面与 `package.json` 的 `types` 指向跟着调整。
2. 或者**改判据**：如果 800 这个数字本身不再重要，就把它从门禁里去掉 ——
   但那要明确写「为什么 800 对检索层不适用」，而不是悄悄放宽。

注意 L1+L2+L3 那条路（689 ≤ 800）在算术上够，但**不成立**：那三层互相调用，
搬完等于换写法。所以它不是「还剩一层」，而是「剩下的是一层写法」。
