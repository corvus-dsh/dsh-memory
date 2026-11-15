# retrieve.ts 拆分 · 第二、三步方案

> 前一份：`docs/retrieve-split-step1.md`（第一步已完成：14 个声明 → `retrieve/interning.ts`）。
>
> 这份文件**只出方案**，不搬代码。区间与声明数全部由
> `scripts/closure.mjs --declarations` 的编译器行区间程序算出（`_scratch/step23-plan.mjs`），不是估的。

现状：`src/retrieve.ts` **1763 行 / 75 声明**。

---

## 第二步：存储层选路族（3 个 let 必须随读写者一起走）

### 为什么这 3 个 let 单独不能搬

第一步的结论在这里是同一个约束：ESM 的 import 绑定对导入方**只读**。
`activeStorageTier` / `tierIndexPath` / `tierIndex` 被 `setStorageTier` / `currentIndex` 赋值，
所以**三者必须与读写它们的函数同处一个模块**。

### 成员（6 个声明 / 28 行，程序算出）

| 声明 | 区间 | 行数 | 说明 |
|---|---|---|---|
| `activeStorageTier` | L50 | 1 | `let`，模块级状态 |
| `tierIndexPath` | L51 | 1 | `let` |
| `tierIndex` | L52 | 1 | `let`，SQLite 句柄 |
| `setStorageTier` | L54–L62 | 9 | **写这 3 个 let**（唯一写者） |
| `getStorageTier` | L64–L66 | 3 | 读 `activeStorageTier` |
| `currentIndex` | L69–L81 | 13 | 读+写 `tierIndex` / `tierIndexPath` / `activeStorageTier` |

**物理区间：L50–L81**（含它们之间 2 处空行与 L44–49 的族说明注释）—— 连续的，共 32 行。

### 一个必须先裁定的重叠：`currentIndex` 也属于 L4

`currentIndex` 在拓扑上属于 **L4**（`retrieve-report` 的层分类），因为它被 `memoryDocumentsFor` 调用。
但它是**这三个 `let` 的读写者**，不跟走则 let 无法搬。

**裁定（本方案采用）：`currentIndex` 归第二步**，理由是：

1. 它是存储层选路的**唯一入口**（`if (activeStorageTier !== 'sqlite') return undefined`，然后建/复用句柄）；
2. 它读写全部 3 个 `let` —— 留在原地则第二步不成立；
3. 它的唯一调用者 `memoryDocumentsFor`（L93–106）**是死代码**：全仓 `src/` 与 `lib/` 里
   除定义处外**零引用**（已实测）。所以把它带走不会有调用方需要 `import`。

> `memoryDocumentsFor` 本身不搬（它属于第三步的 L4 域），第二步之后它会 `import` `currentIndex`。

### 依赖方向（程序算出：第二步成员引用「非本步」名字 = 0）

第二步成员对簇外**零值依赖**。需要的只有 import 进来的符号，**三个来源都已核实**：

| 名字 | 来源 | 已核实导出？ |
|---|---|---|
| `SqliteIndex` | `./sqlite-index.js` | ✅ `export class SqliteIndex` |
| `sqliteAvailable` | `./sqlite-index.js` | ✅ `export function sqliteAvailable` |
| `join` | `node:path` | ✅ 已在 `retrieve.ts` L 的 import 里 |

### 段外对这 6 个的引用

| 名字 | 段外引用 | 处理 |
|---|---|---|
| `setStorageTier` / `getStorageTier` | 带 `export`，在 `retrieve.js` 运行时导出面上 | 必须 re-export 回去 |
| `currentIndex` | 1 处（`memoryDocumentsFor` L94） | `retrieve.ts` 里 `import` |
| 3 个 `let` | 只在族内 | 不 import |

### 第二步的建议落点

`src/retrieve/storage-tier.ts`，**约 60 行**（32 行代码 + 头注释 + import），远低于 800。

---

## 第三步：L4 层剩余部分（10 声明 / 250 行）

`retrieve-report` 给出的 L4 现有成员（搬运第一步之后）：

| 声明 | 区间 | 行数 | 备注 |
|---|---|---|---|
| `ERROR_IDENTIFIER` | L599 | 1 | const |
| `STOPWORDS` | L449–L453 | 5 | const |
| `commitCache` | L381 | 1 | `const Map`，**被同模块代码变异** |
| `contentOf` | L657–L661 | 5 | |
| `currentIndex` | L69–L81 | 13 | **归第二步**（见上） |
| `layerDocuments` | L895–L926 | 32 | |
| `looksLikeIncidentLog` | L533–L538 | 6 | |
| `negativeDocuments` | L848–L892 | 45 | |
| `skillDocuments` | L696–L816 | **121** | 全文件最大的单个函数 |
| `tierDocumentOf` | L109–L129 | 21 | |

**扣掉 `currentIndex`（归第二步）后，第三步 = 9 声明 / 237 行。**

### 第三步的一个结构问题：`commitCache` 是 `const-mutated`

`commitCache` 是 `const Map`，被 `currentCommitOf` / `clearCommitCache` / `sameCommit`（都在 L3 层）
变异。它与 `commitCache` 的**读者**不同层 —— 单独搬它会切断变异方。

> 这与第二步的 `let` 是**同一类问题**：判据不是「是不是 mutable」，而是「**谁**在写它」。
> `const Map` 由同模块代码变异时整体搬走自洽（A1-2 的 `shapeCache`）；但若变异者留在原地，
> 就必须把变异者一起带走。

**所以第三步需要再确认一次**：`commitCache` 的变异者（`currentCommitOf` 等）是否应当随它走。
这一点我**没有在本方案里裁定** —— 它属于 L3，需要第三次分析。本方案只标记它为风险点。

### 第三步的建议落点

`src/retrieve/documents.ts`，**约 250 行**（237 行代码 + 头注释 + import），≤ 800。

---

## 两步之后的预期

| 文件 | 行数 | 声明 |
|---|---|---|
| `src/retrieve.ts` | 1763 → 约 **1470** | 75 → 约 **60** |
| `src/retrieve/interning.ts` | 285 | 14 |
| `src/retrieve/storage-tier.ts` | 约 60（新） | 6 |
| `src/retrieve/documents.ts` | 约 250（新） | 9 |

（行数是「扣掉被搬走的 28 + 237 行，加上 retrieve.ts 侧新增的 import/re-export 约 10 行」的估计，
实际以搬运后的实测为准。）

---

## 每一步都要过的门禁（与第一步相同）

| 门禁 | 要求 |
|---|---|
| 三项前置分析 | 簇内闭包 ⊆ N、对簇外依赖（**含 import 进来的符号**）、段外引用 |
| `npm test` | 全绿 / skipped 0 |
| `verify-pure-move --against HEAD` | 消失 0 行；新增 = 注释 + 管线，**逻辑必须 0** |
| `check-cycles` | ACYCLIC |
| `type-budget` | OK（这条抓类型层断链，测试看不见） |
| `v205` 尺寸门禁 | 新文件必须登记，且 ≤ 800 |
| `v207` 六个数字 | 搬完要**重测并更新期望值**（数字必须变） |
| `v209` 产物同步 | 搬运后必须 `npm run build`，`import type` 条数与产物空白行数逐行相等 |

---

## 第二步开工前必须确认的三件事

1. ~~`sqliteAvailable` 是否从 `./sqlite-index.js` 导出~~ → **已核实：导出**（连同 `SqliteIndex`、`IndexDocument`）。
2. `IndexDocument` 类型的来源：`./sqlite-index.js`，`retrieve.ts` L34 已经是 `import type`。
   第二步**不需要**它（`tierDocumentOf` 归第三步）。
3. `memoryDocumentsFor` 作为死代码，是**保留并 import**，还是**在第三步一并删除** ——
   这个要用户裁定，我不自行删除任何代码。

---

## 不做的部分

- **D-1…D-7 挂着**：`hitOf`（L2 层）仍在 `retrieve.ts`，按裁定等重构完成后再修。
- **`index.ts`（2361 行）不动**，仍在 `test/v205` 的 `EXEMPT` 天花板里。
- 第二步与第三步都**只出方案**，本文件不搬代码。
- 不 publish、不碰 paradise、desktop profile 不动。
