# commitCache 归属分析（数据，供裁定）

> 目的：决定 `commitCache` 及其使用者是否该一起搬出 `retrieve.ts`，以及搬到哪一步。
> 全部数据由 `closure.mjs --declarations`（编译器行区间）与 `closure.mjs <symbol>`（闭包）程序算出。
>
> **本文件只给数据，不裁定。** 裁定由用户做。
>
> **裁定结果（2026-11-15，用户）**：方案 **A**（全搬 5 声明），落点 `src/retrieve/commit-cache.ts`。
> 已执行，见 `docs/retrieve-split-step3.md`。

---

## 〇之一、必须先订正的一条错误结论：`memoryDocumentsFor` **不是**死代码

> 本节记录的是**我犯过的错**，不是本仓的现状。留在文件里是因为下一个读这份分析的人
> 很可能看见「死代码」这个词就照做删除 —— 而这个判断当时是错的。

### 错误结论

2026-11-15，我给出过这样的判断：

> 「它的唯一调用者 `memoryDocumentsFor`（L93–106）**是死代码**：全仓 `src/` 与 `lib/` 里
> 除定义处外**零引用**（已实测）。」

### 实测：它有调用者

删除 L83–107 后，**76 条测试红**：

```
ReferenceError: memoryDocumentsFor is not defined
```

调用点在 `retrieveWithFilter` 体内（当时的 L991）：

```ts
const inSceneDocuments = [
  ...skillDocuments(skillsDir, now),
  ...memoryDocumentsFor(query, memoryDir, now),   // ← 展开运算符
].filter(inScene)
```

### 判据的缺陷

我用的正则：

```js
/(?<![\w.])memoryDocumentsFor\s*\(/u
```

对 `...memoryDocumentsFor(query, ...)` 做 lookbehind 时，**前一个字符是 `.`**（展开运算符的第三个点），
被 `[\w.]` 排除 ⇒ **漏判**。

`...` 是展开运算符，**不是属性访问**。这个 lookbehind 把两者混为一谈。

### 正确的判据

必须容许 `...` 前缀；或者更准确地说，只排除「名字是某个**属性访问的尾**」这一种情况：

```js
// 正确：容许 0–3 个点前缀
/(?:^|[^\w$])\.{0,3}\s*NAME\s*\(/u

// 错误：把展开运算符的末尾点号当成属性访问
/(?<![\w.])NAME\s*\(/u
```

复核后：**声明 2 处 / 调用 2 处**（`src/retrieve.ts` 与 `lib/retrieve.js` 各一）。

### 这一类错误的形状

它与本仓早前 `families.mjs` 把**属性名**（`record.workspace`、`x.length`）当成自由标识符
是**同一类错误的镜像**：

| 缺陷 | 方向 | 后果 |
|---|---|---|
| `families.mjs` 把属性名算成自由标识符 | **多算** | 14 个声明里 10 个被误判成「有外部依赖」 |
| `(?<![\w.])NAME\(` 漏掉 `...NAME(` | **少算** | 一个被真实调用的函数被判成死代码 |

两者都是「用词法近似代替语法」的代价。教训：**一个「零引用」的结论，删除前必须被测试否决一次**
—— 这次正是「删前跑全量测试」这一条要求拦住了它。

---

## 〇、先订正一个前提：`sameCommit` 不是 `commitCache` 的写者

用户的表述是「`currentCommitOf` / `clearCommitCache` / `sameCommit` 三个写者」。
实测：**`sameCommit` 完全不碰 `commitCache`**。

```ts
// L411-418  sameCommit —— 纯字符串比较，无缓存
function sameCommit(left: string, right: string): boolean {
  const a = left.toLowerCase()
  const b = right.toLowerCase()
  const width = Math.min(a.length, b.length)
  if (width < 7) return false
  return a.slice(0, width) === b.slice(0, width)
}
```

它的闭包是 **1 声明 / 7 行 / `mutable: none`**（只有它自己）。

真正的 `commitCache` 站点只有 4 处，分布在 **2 个**声明里：

| 声明 | 区间 | 行数 | 站点 |
|---|---|---|---|
| `commitCache` | L381 | 1 | 声明 |
| `currentCommitOf` | L384–L404 | 21 | `L386 .get()`（读）、`L402 .set()`（写）|
| `clearCommitCache` | L407–L409 | 3 | `L408 .clear()`（写）|
| `sameCommit` | L412–L418 | 7 | —— 零站点 |

---

## 一、`commitCache` 本身

```
L381  const commitCache = new Map<string, { at: number; hash: string }>()
```

`const` + `const-mutated`（被 `.get/.set/.clear` 变异）。1 行。

---

## 二、三个候选写者各自的闭包

| 符号 | 声明数 | 行数 | mutable | 成员 |
|---|---|---|---|---|
| `currentCommitOf` | **2** | **22** | `["commitCache (const-mutated)"]` | `commitCache`, `currentCommitOf` |
| `clearCommitCache` | **2** | **4** | `["commitCache (const-mutated)"]` | `clearCommitCache`, `commitCache` |
| `sameCommit` | **1** | **7** | `none` | `sameCommit` 自己 |
| `commitCache` | 1 | 1 | `["commitCache (const-mutated)"]` | `commitCache` |

**读法**：`currentCommitOf` 与 `clearCommitCache` 的闭包**都包含 `commitCache`** ——
它们共享同一个模块级状态。这与第一步的 3 个 `let`、A1-2 的 `shapeCache` 是同一形状：
**状态与它的变异者必须同处一个模块**。

`sameCommit` 的闭包不含 `commitCache`，它随时可以单独走。

---

## 三、若「`commitCache` + 两个真写者 + `sameCommit`」一起搬：并集

| 声明 | 区间 | 行数 |
|---|---|---|
| `commitCache` | L381 | 1 |
| `currentCommitOf` | L384–L404 | 21 |
| `clearCommitCache` | L407–L409 | 3 |
| `sameCommit` | L412–L418 | 7 |
| **并集** | **L381–L418**（中间夹 `COMMIT_DRIFT_WEIGHT` L382）| **4 声明 / 32 行** |

物理连续（L381–L418，38 行），中间只夹一个 `COMMIT_DRIFT_WEIGHT`（L382，1 行）。

### 并集涉及的 mutable

```
["commitCache (const-mutated)"]
```

**只有这一个**。它是刻意保留的模块级状态（per-process 缓存，60 秒 TTL），
与 `store/clock.ts` 的 `lastIssuedMs`、A1-2 的 `shapeCache` 同类。

---

## 四、OUTSIDE：并集成员引用的、不在并集里的名字

| 名字 | 来源 | 被谁用 |
|---|---|---|
| `execFileSync` | `node:child_process`（`retrieve.ts` L20 已 import）| `currentCommitOf` |

**只有 1 个**，且是 node 内置模块。搬走后新模块加一行
`import { execFileSync } from 'node:child_process'` 即可。

> 若把 `sameCommit` 也带走，它零外部依赖（纯字符串函数）。

---

## 五、段外对并集成员的引用

| 成员 | 段外引用 |
|---|---|
| `commitCache` | **零** |
| `clearCommitCache` | **零** |
| `currentCommitOf` | `scoreDocuments`（L1052）|
| `sameCommit` | `scoreDocuments`（L1053）|

`scoreDocuments` 在 **L2 层**，不属于当前任何一步。

---

## 六、`COMMIT_DRIFT_WEIGHT` —— 一个必须一起裁定的邻居

```ts
L382  export const COMMIT_DRIFT_WEIGHT = 0.45
```

它**夹在 `commitCache`(L381) 与 `currentCommitOf`(L384) 之间**，物理上在并集区间内，
但按依赖它属于 `scoreDocuments`：

| 事实 | 值 |
|---|---|
| 使用点 | `L1055`（`scoreDocuments` 体内：`... * COMMIT_DRIFT_WEIGHT`）|
| 是否在运行时导出面上 | **是** |
| 外部消费者（src / test） | **零** |

所以它有三个处置选项，**这是本文件唯一没给结论的地方**：
① 随 commit 族走（物理连续，但要 re-export 回 `retrieve.ts` 给 `scoreDocuments` 用）；
② 留在原地（则并集区间被它切成两段：L381 + L384–L418）；
③ 归 `scoreDocuments`（要等 L2 层那一步）。

---

## 七、导出面影响

| 名字 | 在 `lib/retrieve.js` 运行时导出面上 | 外部消费者 |
|---|---|---|
| `COMMIT_DRIFT_WEIGHT` | **是** | 无（src / test 都不取）|
| `currentCommitOf` | **是** | `src/index.ts:L23` import + L690 调用 |
| `clearCommitCache` | **是** | `test/v102-commit-drift.test.mjs`、`test/v102-seam-inventory.test.mjs` |
| `sameCommit` | 否 | 无 |
| `commitCache` | 否 | 无 |

**三个带 `export` 的必须 re-export 回去**，否则 `lib/retrieve.js` 的公开面缩小
（`index.ts` 会编译失败、`v102` 会红）。

---

## 八、三个可选方案（数据并列，不推荐）

### 方案 A：`commitCache` + 两个真写者 + `sameCommit` + `COMMIT_DRIFT_WEIGHT` 全搬

- 带走 **5 声明 / 33 行**，物理连续 L381–L418（38 行含空行）
- 新模块：`retrieve/commit-cache.ts`，约 55 行
- `retrieve.ts` 需 import：`currentCommitOf`、`sameCommit`、`COMMIT_DRIFT_WEIGHT`
- 需 re-export：`COMMIT_DRIFT_WEIGHT`、`currentCommitOf`、`clearCommitCache`
- **mutable 随状态走**（`commitCache (const-mutated)` 整体迁移，自洽）

### 方案 B：只搬 `commitCache` + 两个真写者（`sameCommit` 留原地）

- 带走 **3 声明 / 25 行**
- 物理区间被 `COMMIT_DRIFT_WEIGHT`(L382) 切成两段：L381 + L384–L409
- `sameCommit` 仍留在 `retrieve.ts`（它零依赖，随时可走）
- 需 import：`currentCommitOf`；需 re-export：`currentCommitOf`、`clearCommitCache`

### 方案 C：都不搬，`commitCache` 留在 `retrieve.ts` 直到 L2 层那一步

- 理由：`currentCommitOf` 与 `sameCommit` 的唯一段外消费者是 `scoreDocuments`（L2）
- 等到拆 L2 时，commit 族与 `scoreDocuments` 一起处理，`COMMIT_DRIFT_WEIGHT` 也不用纠结
- 代价：`retrieve.ts` 继续持有 4 声明 / 32 行

---

## 九、与第二步的关系

**这一步与第二步（存储层选路族）互相独立**：

|  | 第二步 | commit 族 |
|---|---|---|
| 状态 | `activeStorageTier` / `tierIndexPath` / `tierIndex`（`let`）| `commitCache`（`const Map`）|
| 写者 | `setStorageTier`、`currentIndex` | `currentCommitOf`、`clearCommitCache` |
| 段外消费者 | `memoryDocumentsFor` | `scoreDocuments` |
| 层 | L4（`currentIndex`）| L2/L3/L4 混合 |
| 重叠 | **无** | **无** |

所以**第二步可以在裁定之前开工**，不受 `commitCache` 归属影响。

---

## 十、复现

```bash
node scripts/closure.mjs currentCommitOf     # 2 声明 / 22 行 / mutable: ["commitCache (const-mutated)"]
node scripts/closure.mjs clearCommitCache    # 2 声明 / 4 行  / mutable: ["commitCache (const-mutated)"]
node scripts/closure.mjs sameCommit          # 1 声明 / 7 行  / mutable: none
node scripts/closure.mjs --declarations      # 全部行区间
```

`_scratch/commitcache-analysis.mjs` 一次性复算本文件的全部表格。
