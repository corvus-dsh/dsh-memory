# retrieve.ts 拆分 · 第二步：存储层选路族

> 前一份：`docs/retrieve-split-step1.md`（第一步：14 声明 → `retrieve/interning.ts`）。
> 方案来源：`docs/retrieve-split-step2-3-plan.md` 的「第二步」一节。

---

## 一、结果

| 文件 | 行数 | 顶层声明 |
|---|---|---|
| `src/retrieve.ts` | **1763 → 1718** | **75 → 69** |
| `src/retrieve/storage-tier.ts` | **81**（新增，≤ 800 ✅）| 6 |
| `src/retrieve/interning.ts` | 285（不变）| 14 |

搬走 **6 个声明 / 28 行**代码 + 族说明注释 13 行 + import。

---

## 二、三项前置分析（先贴后搬）

### ① 簇内闭包 ⊆ 6

| 声明 | 区间 | 行数 |
|---|---|---|
| `activeStorageTier` | L50 | 1 |
| `tierIndexPath` | L51 | 1 |
| `tierIndex` | L52 | 1 |
| `setStorageTier` | L54–L62 | 9 |
| `getStorageTier` | L64–L66 | 3 |
| `currentIndex` | L69–L81 | 13 |

物理区间 **L37–L81**（含族说明注释 L37–49），**区间内非簇声明 0 个** → 可整段切。

### ② 对簇外的依赖：3 个，全部来自 import

| 名字 | 来源 | 被谁用 |
|---|---|---|
| `SqliteIndex` | `./sqlite-index.js` | `currentIndex`（值 + 类型）|
| `sqliteAvailable` | `./sqlite-index.js` | `currentIndex` |
| `join` | `node:path` | `currentIndex` |

**对 `retrieve.ts` 零值依赖** —— 这是它能干净搬走的原因。

### ③ 段外对这 6 个的引用

| 名字 | 段外引用 | 处理 |
|---|---|---|
| `activeStorageTier` / `tierIndexPath` / `tierIndex` | **零** | 随状态走 |
| `setStorageTier` | **零**（但带 `export`，在运行时导出面上）| **re-export** 回 `retrieve.ts` |
| `getStorageTier` | **零**（同上）| **re-export** 回 `retrieve.ts` |
| `currentIndex` | 1 处（`memoryDocumentsFor`）| `retrieve.ts` import |

### ④ 外部消费者（实测）

| 符号 | 运行时导出面 | src / test 消费者 |
|---|---|---|
| `setStorageTier` | **是** | `test/v140-storage-tier.test.mjs`（经 `retrieve.setStorageTier`）|
| `getStorageTier` | **是** | 同上 |
| `currentIndex` | 否 | 无（只有 `memoryDocumentsFor`）|
| 3 个 `let` | 否 | 无 |

> ⚠ 分析脚本一度把 `src/retrieve/interning.ts` 报成消费者 —— 核实后是**头注释里提到**这些名字，
> 不是代码引用。这类噪声必须逐条看，不能只信脚本的命中数。

---

## 三、为什么 3 个 `let` 必须与写者同走（这一步的核心约束）

三个 `let` 的**唯一赋值点**在 `setStorageTier` 与 `currentIndex` 里：

```
L55  activeStorageTier = tier
L56  tierIndexPath = options.indexDbPath
L60  tierIndex = undefined
L75  tierIndex = new SqliteIndex({ file })
```

ESM 的 import 绑定对**导入方**是只读的。若只搬 `let` 而不搬写者，
`retrieve.ts` 里剩下的 `setStorageTier` 会在编译期报 `Cannot assign to import`。
所以**状态与它的写者必须同处一个模块**。

### 与另两个案例的对照（判据是「谁在写它」）

| 案例 | 状态形态 | 谁在写 | 处置 |
|---|---|---|---|
| A1-2 `shapeCache` | `const Map` | **同模块**代码变异 | 整体搬走，自洽 |
| 第一步排除的 3 个 `let` | `let` | **留在原地**的代码赋值 | 不能搬 |
| 第二步这 3 个 `let` | `let` | **与它一起搬**的写者 | 整体搬走，自洽 |

---

## 四、门禁

| 门禁 | 结果 |
|---|---|
| `npm test` | **480 / 480 / 0 / skipped 0** |
| `verify-pure-move --against HEAD --classify` | **逻辑 0**：消失 **1** 行（已解释）；新增 33 行 = 注释 **33** + 管线 0 + **逻辑 0** |

> **订正（2026-11-15）**：上表的命令原来写作 `verify-pure-move --against HEAD`（不带 `--classify`），
> 那是不准确的记账。主路径对「新增注释」是红的（它比内容行多重集，而本步新增了族注释与头注释），
> 「逻辑 0」这个结论来自 `--classify`。见 `docs/retrieve-split-step1.md` 同一条订正的详细说明。
| `check-cycles` | nodes 34 / value edges 74 / **ACYCLIC** / unresolved 0 |
| `type-budget` | OK（2459: 0）|
| `readme-counts` | 7/7 |
| `v205` 尺寸门禁 | 14/14（`storage-tier.ts` 81 行已登记）|
| `v207` 六个数字 | 6/6（搬运后重测）|
| `v209` 产物同步 | 4/4 |
| 运行时导出面 | `retrieve.js` **34 条不变**（`setStorageTier` / `getStorageTier` re-export 生效）|

### 那 1 行 DISAPPEARED 是什么

`verify-pure-move` 报 `DISAPPEARED 1 行` / `APPEARED 33 行`（净 +32）。逐行核对：

```
消失: "/** The memoised index handle, or undefined when the tier is json or sqlite is unavailable. */"

出现: " * The memoised index handle, or undefined when the tier is json or sqlite is unavailable."
      " * 导出：`retrieve.ts` 的 `memoryDocumentsFor` 是它的唯一调用者，搬走后必须能 import。"
```

**唯一一处非纯位移**：`currentIndex` 上方的单行注释被展开成 4 行注释块，
因为我给它加了 `export` 并写明了「为什么导出」。文字内容是原注释 + 新增一句，
不是删掉后重写。**逻辑 0 行**。

---

## 五、搬运后的六个数字

| 项 | 第一步后 | 第二步后 |
|---|---|---|
| 无向连通分量 | 21 | **21** |
| 主干 | 51 声明 / 955 行 | **45 声明 / 927 行** |
| 有向 SCC | 75 | **69**（仍零循环）|
| 缩点拓扑层 | 6 | **5** |
| 四档 D/C/B/A | 4/486 · 7/362 · 13/295 · 51/219 | **4/486 · 7/362 · 12/282 · 46/204** |
| 顶层声明 / 跨度和 | 75 / 1362 | **69 / 1334** |

分量数 21 不变：被搬走的 6 个声明原本连在主干上（`currentIndex` 被 `memoryDocumentsFor` 调用），
主干仍是一个分量；另外 20 个碎片分量本来就不含这几个名字。

`v207` 的期望值已同步更新，注释里列出**三步的值**（搬前 / 第一步后 / 第二步后）。

---

## 六、红过两次

| # | 红 | 根因 | 修法 |
|---|---|---|---|
| 1 | `SyntaxError: ... does not provide an export named 'currentIndex'` | 搬走后 `currentIndex` 在新模块里是**私有**声明，`retrieve.ts` import 不到 | 加 `export`（并在注释里写明为什么） |
| 2 | `cap: 显式扫描名单 == 磁盘上真实存在的 .ts 文件` + `v207 ①` + `v208` | **门禁按设计工作**：新文件未登记、六数已变、v208 连带 | 登记 + 重测更新期望值 |

第 2 条与前两步完全同形 —— 每次搬完都会红三条，因为门禁要求「新文件必须登记」「数字必须重算」。

---

## 七、下一步

`retrieve.ts` 从 **2009 → 1718**（−291，−14%）。剩下 69 声明 / 1718 行。

- **第三步候选**：L4 剩余 9 声明 / 237 行（`skillDocuments(121)` 是最大单函数）
- **`commitCache` 族**：`docs/commit-cache-ownership.md` 已给数据，**等你裁定**
- **D-1…D-7 挂着**：`hitOf`（L2 层）仍在 `retrieve.ts`

---

## 八、没做的事

- **没删 `memoryDocumentsFor`** —— 第 1 条要求的删除**没有执行**，因为前提不成立：
  它不是死代码，`retrieveWithFilter` 在 `...memoryDocumentsFor(query, memoryDir, now)` 处调用它。
  我上一轮判「全仓零引用」是**误判**，判据缺陷与订正见
  `docs/commit-cache-ownership.md` 第〇之一节：`/(?<![\w.])NAME\s*\(/` 把展开运算符
  `...` 的末尾点号当成了属性访问，于是漏判。删前跑全量测试时，76 条红拦住了它。
- 没动 `commitCache` 族（当时等裁定；现已按裁定 A 执行，见 `docs/retrieve-split-step3.md`）
- 没动 `index.ts`（2361 行仍在 `EXEMPT`）
- 不 publish、不碰 paradise、desktop profile 不动
