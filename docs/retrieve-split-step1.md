# retrieve.ts 拆分 · 第一步：L5+L6+L7 的叶子层

> 前一份：`docs/retrieve-families-and-tiers.md`（**搬前**的分量表快照）。
>
> 这份文档记的是**实际搬了什么、以及为什么没搬完 17 个**。

---

## 一、结果

| 文件 | 行数 | 顶层声明 |
|---|---|---|
| `src/retrieve.ts` | **2009 → 1763** | **89 → 75** |
| `src/retrieve/interning.ts` | **285**（新增，≤ 800 ✅）| 14 |

搬走 **14 个声明 / 173 行代码**（+ 说明注释与 import，模块共 285 行）。

---

## 二、为什么是 14 个，不是 17 个（这一步最重要的一条）

拓扑分析给出 L5+L6+L7 = **17 个声明 / 176 行**，文档里写的是「可先整块搬」。
实际搬之前跑依赖分析，发现其中 **3 个不能搬**：

```ts
let activeStorageTier: 'json' | 'sqlite' = 'json'
let tierIndexPath: string | undefined
let tierIndex: SqliteIndex | undefined
```

它们的**唯一赋值点**在 `setStorageTier`（L53–61）与 `currentIndex`（L68–80）里：

```
L54  activeStorageTier = tier
L55  tierIndexPath = options.indexDbPath
L59  tierIndex = undefined
L74  tierIndex = new SqliteIndex({ file })
```

而这两个函数**不在簇内**（它们是存储层选路的入口，不属于「分词 / 证据」这一族）。

**ESM 的 import 绑定对导入方是只读的。** 把这三个 `let` 搬进 `interning.ts` 之后，
`retrieve.ts` 里的 `setStorageTier` 无法再给它们赋值 —— 编译期 `Cannot assign to import`。

### 与 A1-2 的 shapeCache 的区别

A1-2 时 `shapeCache` 是 `const Map`，被 `.set/.delete/.clear` 变异，**由同模块的代码变异**，
整体搬走自洽。这里三个 `let` **由留在原地的代码赋值**，搬走就断了。

> 判据不是「是不是 mutable」，而是「**谁**在写它」。

所以「L5+L6+L7 可整块搬」这句话在**依赖图的意义上**是对的（它们确实是叶子层），
在**模块边界的意义上**差 3 个。这个区别只有真正要动手时才会暴露。

---

## 三、三项前置分析

### ① 簇内闭包 ⊆ 14

`retrieve.ts` L423–L1175 之间分散的 **15 个物理段**，混入 0。逐段锚点校验：首行必须真的声明该名字，末行必须以 `}` / `]` / `)` 收尾。

簇内值引用 14 条（全部单向，无环）：

```
isStaleNegative     → NEGATIVE_STALE_DAYS
negativeDocumentOf  → firstEvidence, clipTitle, provenanceOf, tokenize,
                      ageDaysOf, isStaleNegative, NEGATIVE_STALE_WEIGHT
layerDocumentOf     → firstEvidence, clipTitle, provenanceOf, tokenize, ageDaysOf
```

与簇内其余成员**零值引用**的 7 个：`INCIDENT_MARKERS`、`documentCache`、`triggerOf`、`skillDirKey`、
`activeStorageTier`、`tierIndex`、`tierIndexPath`（后三个即第二节的 3 个 `let`）。

### ② 对簇外的依赖（搬走要带 import）

这一项**我算错过两次**，值得写下来：

- **第一版**只查 `retrieve.ts` 的顶层声明表，报「外部值依赖：(无)」。
  漏掉了 **import 进来的符号** —— 跑测试立刻炸 `skillDocsKey is not defined`。
- **第二版**把 import 也算进来，但把**属性名**（`record.workspace`、`x.length`）也算成自由标识符，
  于是 14 个里 10 个被误判成「有外部依赖」。
- **第三版**排除「属性访问的 name 位置 / 对象字面量的键 / 类型成员名」，才得到真值。

真正的外部依赖只有 5 个：

| 名字 | 来源 | 被谁用 |
|---|---|---|
| `normalizeWorkspace` | `./workspace.js` | `negativeDocumentOf`, `layerDocumentOf` |
| `skillDocsKey` | `./skill-cache.js` | `skillDirKey` |
| `statSync` | `node:fs` | `skillDirKey` |
| `Document` / `DocumentCacheEntry` | 类型，`import type` | `documentCache`、两个 Document 构造器 |
| `MemoryProvenance` | 类型，`import type` | `provenanceOf` |

### ③ 段外对这 14 个的引用（`retrieve.ts` 要 import）

| 名字 | 段外引用数 | 使用者 |
|---|---|---|
| `tokenize` | 5 | `memoryDocumentsFor`、`tierDocumentOf`、`extractTaskTerms`、`skillDocuments`、`scoreDocuments` |
| `clipTitle` | 6 | `tierDocumentOf`、`skillDocuments`、`renderHint` ×4 |
| `documentCache` | 6 | `invalidateDocuments` ×2、`negativeDocuments` ×2、`layerDocuments` ×2 |
| `ageDaysOf` | 3 | `tierDocumentOf`、`skillDocuments` ×2 |
| `layerDocumentOf` / `negativeDocumentOf` | 各 2 | `layerDocuments` / `negativeDocuments` |
| `INCIDENT_MARKERS` / `skillDirKey` / `triggerOf` / `isStaleNegative` / `provenanceOf` | 各 1 | — |
| `NEGATIVE_STALE_WEIGHT` / `firstEvidence` | **0** | — |

`firstEvidence` 段外零引用（只被同簇的两个 Document 构造器调用），随簇走。
`NEGATIVE_STALE_WEIGHT` 段外零引用，但**带 `export`** —— 它在 `retrieve.js` 的运行时导出面上，
所以仍要 re-export 回去。

---

## 四、搬运纪律

| 项 | 做法 |
|---|---|
| span 来源 | `closure.mjs --declarations`（编译器 `getStart()/getEnd()`） |
| 注释归属 | span 向上扩到 JSDoc；**但不许扩进任何非簇声明的跨度**（相交就退回） |
| 锚点校验 | 首行必须声明该名字；末行必须以 `}` / `]` / `)` 收尾；不通过就不写盘 |
| 段内混入 | 逐个非簇声明求交，**相交即中止** |
| 私有声明 | 搬到新模块后，`retrieve.ts` 还要用的必须加 `export`（程序化判断，不手写） |

「注释归属」这条不是洁癖：`negativeDocumentOf`、`layerDocumentOf`、`skillDirKey` 等 11 个声明
上方都有 JSDoc。把声明搬走、注释留下，注释就会挂到**下一个声明**头上 ——
而 `NEGATIVE_STALE_DAYS` 顶上那段 27 行注释讲的正是「陈旧负知识」的规则，
挂错了等于把设计说明安给了不相干的函数。

---

## 五、门禁

| 门禁 | 结果 |
|---|---|
| `npm test` | **476 / 476 / 0 / skipped 0** |
| `verify-pure-move`（见下「复现」）| 消失 **0** 行；新增 27 行 = 注释 **27** + 管线 0 + **逻辑 0** |

**复现（可执行，逐字）**：

```bash
# 工作树必须是第一步提交后的状态（该提交：ba9fd15，父提交：0381c6c）
#   git worktree add --detach /tmp/s1 ba9fd15
#   把**当前** scripts/verify-pure-move.mjs 复制进 /tmp/s1/scripts/  ← 关键：树用旧的、脚本用新的
node scripts/verify-pure-move.mjs --against 0381c6c --classify
```

实测输出（2026-11-15）：

```
DISAPPEARED 0 条 / 0 行
APPEARED   20 条 / 27 行

                   注释   管线   逻辑
  APPEARED          27      0      0
  DISAPPEARED        0      0      0
  ── 合计 ──        27      0      0
[exit 0]
```

> **订正（2026-11-15）**：这里原先写的是 `--against HEAD`。那有两个问题：
> ① 比较对象是 HEAD，而搬运完成后 HEAD 已含这次改动 ⇒ **VACUOUS**（exit 2），不是通过；
> ② 不带 `--classify` 时主路径对「新增注释」是红的（它比内容行多重集，而本步新增 27 行说明注释），
> 「逻辑 0」这个结论只有 `--classify` 能给出。
> 所以必须写成**带父提交 + `--classify`** 的形式，并且树要退到那一步（树用旧的、脚本用新的）。
| `check-cycles` | nodes 33 / value edges 72 / **ACYCLIC** / unresolved 0 |
| `type-budget` | OK（2459: 0）|
| `readme-counts` | 7/7 |
| `v205` 尺寸门禁 | 14/14（`interning.ts` 285 行已登记）|
| `v207` 六个数字 | 6/6（搬运后重测，见下）|

---

## 六、搬运后的六个数字（与搬前的表并列）

| 项 | 搬前 | 搬后 |
|---|---|---|
| 无向连通分量 | 19 | **21** |
| 主干 | 68 声明 / 1251 行 | **51 声明 / 955 行** |
| 有向 SCC | 89 | **75**（仍零循环）|
| 缩点拓扑层 | 8 | **6** |
| 四档 D/C/B/A | 4/486 · 8/413 · 17/373 · 60/263 | **4/486 · 7/362 · 13/295 · 51/219** |
| 顶层声明 / 跨度和 | 89 / 1535 | **75 / 1362** |

`v207` 的期望值已同步更新，并在测试注释里写明「旧值 → 新值」。
**一份「搬完之后数字不变」的表，只能说明表没被重算** —— 那才是这条测试要防的事。

---

## 七、红过的四次（每次都回到绿点）

| # | 红 | 根因 | 修法 |
|---|---|---|---|
| 1 | `ReferenceError: tokenize is not defined` | 只搬代码，没给 `retrieve.ts` 补 import | 程序算 import 清单 |
| 2 | `SyntaxError: ... does not provide an export named 'INCIDENT_MARKERS'` | 搬走的 10 个声明原本是**模块私有**，新模块里必须加 `export` | 程序化加 export（首行前插） |
| 3 | `ReferenceError: skillDocsKey is not defined` | 依赖分析只看本文件顶层声明，漏了 import 进来的符号 | 三版分析（见第三节②）|
| 4 | `type-budget: Cannot find name 'MemoryProvenance'` + `DocumentCacheEntry not exported` | `Document` / `DocumentCacheEntry` 原本不是 `export`，`interning.ts` 的 `import type` 取不到 | `retrieve.ts` 加 `export type { Document, DocumentCacheEntry }` |

**第 4 条是只有 `tsc` 看得见的那类**：476 条测试全绿、build 成功、`verify-pure-move` 干净，
只有 `type-budget` 报了。它和 A2 的 `SkillConflict`、A1-3 的 `EnvironmentDivergence` 是同一个族
（类型层的断链在运行期不可见）—— `test/v206` 那条门禁管的是另一头（值/类型 import 混用），
这一头由 `type-budget` 管着。

---

## 八、下一步

L5+L6+L7 现在只剩 3 个 `let`（`activeStorageTier` / `tierIndexPath` / `tierIndex`）。
它们**不该**单独搬 —— 要搬得连同 `setStorageTier` / `getStorageTier` / `currentIndex` 一起搬，
那是一个独立的「存储层选路」族（约 40 行 + 3 个 let），归到 `retrieve/storage-tier.ts`。

再往下是 L4（10 声明 / 250 行）与 L3（14 声明 / 140 行）。

---

## 九、这一步没有做的事

- **没搬那 3 个 `let`**（理由见第二节）。
- **没动 `index.ts`**（2361 行仍在 `EXEMPT` 天花板里）。
- **D-1…D-7 挂着**：`hitOf` 仍在 `retrieve.ts`（L2 层），按裁定等重构完成后再修。
- 不 publish、不碰 paradise、desktop profile 不动。
