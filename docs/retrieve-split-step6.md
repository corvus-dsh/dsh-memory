# retrieve.ts 拆分 · 第六步：契约类型族（`retrieve/types.ts`）

> 本步父提交：**`1ee862a`**（记账修复那一笔）。
> 用户裁定⑧：契约类型族 → `src/retrieve/types.ts`；**不搬 L0**。

---

## 一、结果

| 文件 | 行数 | 声明 |
|---|---|---|
| `src/retrieve.ts` | 1294 → **1074**（净 −220）| 46 → **32** |
| `src/retrieve/types.ts` | — → **291** | **12** |

搬走 12 个**纯类型**声明（声明 span 合计 **242 行**）：

```
DocumentKind  MemoryHit  Document  Scored  WorkspaceGate  TaskAlignmentGate
DocumentCacheEntry  CandidateOptions  HybridRecallOptions  RetrieveResult
FilterTrace  FilterOptions
```

行数怎么算的（三个数别混）：

| 项 | 行数 | 说明 |
|---|---|---|
| 声明 span 之和 | **242** | 用户给的那个数，指 12 个声明的行区间 |
| 从 `retrieve.ts` 实际移出 | **247** | 244（242 + 2 行单行 JSDoc）+ 2（死常量）+ 1（一行旧的重复导出，见第五节）|
| 移入 `retrieve.ts` | **27** | 14（`import type { … }`）+ 1（空行）+ 12（`export type` 各一行）|

`1294 − 247 + 27 = 1074`。**和第五步同一条教训：span 之和不等于净减。**

### 顺带删掉两个零引用常量（**这是删除，不是位移**）

```ts
const CJK = /[\u4e00-\u9fff]/u
const LATIN = /[a-z0-9]/u
```

两个都**没有任何引用者**（全 `src/` 扫过：只有 `archive.ts` 里有同名的**局部变量** `latin` / `cjk`，
与它们无关 —— 分词的实现早在第一步搬进了 `retrieve/interning.ts`）。

- 单看这一步：声明数 **46 → 44**。
- 与 12 个搬走的声明合并：`retrieve.ts` 的声明数 **46 → 32**。

这条**必须单独说**，因为它是本步唯一「不是位移」的部分 —— 而减行（`verify-pure-move`）会替我们抓住它：
逻辑行不为 0，正好 2 行（见第四节）。

---

## 二、四项前置分析（搬之前算的）

用户要求三项 + 闭包自洽检查。实测（脚本：`_scratch/contracts-prereq.mjs`）：

| 项 | 结果 |
|---|---|
| **① 区域** | 12 个块**互不相交**，但**不连续**：分成 9 段（`DocumentKind…Scored` 连着，其余各自独立）。块间最多隔着 197 行**别的代码**（`DocumentCacheEntry` 与 `CandidateOptions` 之间）。⇒ 这是**多块搬移**，不是一段连续区域的位移。 |
| **② 段外类型引用** | 族外、同文件的类型引用 = **0**。族外只有三个来自**别的模块**的类型：`LlmLike` / `MemoryProvenance`（`../extract.js`）、`FilterSupersedeDecision`（`../filter.js`），全是 `import type`。 |
| **③ 闭包自洽** | 族内 12 个彼此的类型引用构成闭环（`Document → DocumentKind`、`Scored → Document`、`MemoryHit → DocumentKind`、`HybridRecallOptions → CandidateOptions` …）。**族内没有一处值引用**（`typeof X`、`X.something` 之类）—— 所以整族可以**只带类型边**搬走。⇒ **闭合，可以搬。** |
| **④ 段外使用者** | `filter.ts`（MemoryHit / FilterOptions）、`ledger-cache.ts`（Document）、`retrieve/documents.ts`（DocumentKind / Document）、`retrieve/interning.ts`（Document / DocumentCacheEntry）、`sqlite-index.ts`（Document）。它们**继续从 `retrieve.js` 拿**（那 12 行 `export type` 就是为此存在的），本步不改它们的 import。 |

**③ 是「不闭合就别搬」的判据**：若族内出现值引用（哪怕是 `typeof`），搬走就会把一条**运行期边**从
`retrieve.ts` 拉进新模块 —— 那就不再是纯类型搬移，`check-cycles` 会看到新节点，而「值依赖图上一片空白」
这个本步唯一的卖点也就没了。

---

## 三、回程：`import type` + 12 行 `export type`

`retrieve.ts` 末尾现在是 12 行手写的类型转出（每行一个名字，方便逐个审计）：

```ts
export type { DocumentKind }
export type { MemoryHit }
…
export type { FilterOptions }
```

### 两个只有踩过才知道的形状

**① 撞名的原因是「同一个名字被转出两次」，不是「import 和 export 同时存在」。**

第一版我把因果写反了（原文写「`from` 形式会与 `import type` 撞名」）。实测报错是
`2300 Duplicate identifier 'Document'`，出现在**两行 export 上**（当时 L1051 与 L1061 各报一次）。
真正的形状是：仓里原本已有一行裸形式 `export type { Document, DocumentCacheEntry }`，
我又加了一行 from 形式 `export type { Document } from './retrieve/types.js'` —— **同名两次转出**。

最小复现（两行各报一次 2300）：

```ts
// a.ts
export type { X }                  // 裸形式：转的是本地绑定
export type { X } from './m.js'    // from 形式：又从 m.js 转出一次
```

处置：12 个名字统一用**裸形式** `export type { X }`（转 `import type` 进来的本地绑定），
并删掉那行旧的 `export type { Document, DocumentCacheEntry }`。

`src/retrieve.ts` 里至今仍有一行 from 形式 —— **L1061 `export type { SceneOptions } from './retrieve/scene.js'`**
（`scene.ts` 的导出面只有这一个类型，用 from 形式一步到位，不需要 local 绑定）。
它没有撞名，因为它转出的 `SceneOptions` **没有**被裸形式再转一次。两种形式可以共存，
判据是 v213：① 两种形式都算「转出」，③ 只对裸形式要求「必须被 import」，
另外还断言 **from ∩ imported = ∅**（即不允许同名两次转出）。

**② 仓里原本已经有一行 `export type { Document, DocumentCacheEntry }`。**
它是当年为了让 `retrieve/interning.ts` 拿到这两个类型而加的（第二步/第三步时期）。
12 行写全之后它成了重复导出 ⇒ 删掉。

> ② 顺带说明一件事：**「类型面靠手写、没人检查」这个洞不是这一步造成的，它早就存在。**
> 上一行就是一次手写，而且当时没有任何东西会因为它漏掉而变红。现在有了（见第五节）。

---

## 四、`verify-pure-move`：逻辑 **2**，正好是那两行删除

```bash
# 工作树必须是本步提交后的状态（本步父提交：1ee862a）
#   git worktree add --detach /tmp/s6 HEAD
#   把**当前** scripts/verify-pure-move.mjs 复制进 /tmp/s6/scripts/（判据要今天的）
cd /tmp/s6 && node scripts/verify-pure-move.mjs --against 1ee862a --classify
```

逐字输出（2026-11-16 本机实测）：

```
ref  1ee862a: 13822 内容行
tree      : 13866 内容行  （差 44）

DISAPPEARED 2 条 / 2 行
APPEARED   39 条 / 46 行

                   注释   管线   逻辑
  APPEARED          33     13      0
  DISAPPEARED        0      0      2
  ── 合计 ──        33     13      2   ← 逻辑必须为 0

  三类合计 48 行（应等于 新增 46 + 消失 2 = 48）

非注释、非管线的行（要逐条解释，或把它的形状教给工具）：
  - ! "const CJK = /[\\u4e00-\\u9fff]/u"
  - ! "const LATIN = /[a-z0-9]/u"
```

**这条不为 0 是对的，而且它替我们做了本步最重要的一次记账**：这一步确实不是纯位移 ——
它含一次删除。工具把删除的两行**逐字点名**，于是「不是位移」不需要靠自觉声明，它是被算出来的。

- `APPEARED 33 注释`：新模块的文件头 + 两节说明注释。
- `APPEARED 13 管线`：1 行 `import type` 起头 + 12 行 `export type`（裸形式剥掉 `export type ` 之后是 `{ X }`，属于管线）。
- `DISAPPEARED 0 注释 / 0 管线`：搬走的 244 行在新文件里逐字重现，全树多重集抵消。

---

## 五、新增门禁 v213：类型导出面（补上「漏了没人会红」那一处）

`package.json` 的 `"types": "./src/index.ts"` 且 `files` 含 `src` —— **源码就是发布出去的类型面**。
而所有既有导出面门禁都是 `import('../lib/store.js')` 式的**运行期**断言，`export type` 它们看不见。
第六步手写了 12 行；如果不加门禁，下一次搬运会再手写一次，而漏掉的代价要等使用方升级才发现。

`test/v213-type-surface-reexports.test.mjs`，8 条，只用 `fs` + 正则（**在 CI 上真跑**）：

| # | 断言 |
|---|---|
| ① | `types.ts` 里每个模块级类型声明，`retrieve.ts` 都有一行 `export type { 它 }` |
| ② | 反向：每一行 `export type` 都指向真实存在的声明（防幽灵） |
| ③ | 被转出的名字必须同时被 `import type`（裸形式转的是本地绑定） |
| ④ | 这些**类型名一个都不能出现在 `lib/retrieve.js` 的运行期导出里** —— 若把 `export type {X}` 写成 `export {X}`，会漏出一个值为 `undefined` 的导出 |
| ⑤⑥⑦ | can-red：漏一个 / 幽灵 / 未 import，三条都喂假数据给同一条判据 |
| ⑧ | 防「空数组恒绿」：解析结果不能是空集 |

**先让它红**（实测）：删掉 `export type { FilterTrace }` 一行 →
`v213 ①` 立刻红，报 `actual: ['FilterTrace']`。恢复后 8/8。

---

## 六、六个数字（搬前 + 六步搬运，共七行）

| 时点 | 分量 | 主干 | SCC | 层 | 四档 (D·C·B·A) | 声明·span 和 |
|---|---|---|---|---|---|---|
| 搬前（第一步前） | 19 | 68·1251 | 89 | 8 | 486·413·373·263 | 89·1535 |
| 第一步后 | 21 | 51·955 | 75 | 6 | 486·362·295·219 | 75·1362 |
| 第二步后 | 21 | 45·927 | 69 | 5 | 486·362·282·204 | 69·1334 |
| 第三步后 | 21 | 40·894 | 64 | 5 | 486·362·261·192 | 64·1301 |
| 第四步后 | 22 | 30·647 | 56 | 4 | 365·317·208·175 | 56·1065 |
| 第五步后 | 20 | 22·557 | 46 | 4 | 365·254·208·137 | 46·964 |
| **第六步后** | **6** | **22·557** | **32** | **4** | **365·106·163·86** | **32·720** |

**分量 20 → 6 是这一步最有信息量的数字。** 那 12 个类型声明在**值引用图**上不产生任何边
（只被类型引用，构建时擦除），所以它们原本是 12 个互不相连的孤立节点。之前那个「20 个分量」
里有 14 个是「看起来耦合、实际从不执行」的碎片 —— 搬走之后，剩下的 6 个分量**全部是会被执行的代码**。

主干不变（22 声明 / 557 行）：主干里没有类型声明，只有使用它们的地方。
层数不变（仍 4）：类型节点本来散布在各层，但不承载值边，搬走不抽空任何一层。

---

## 七、层账（由脚本算，不手抄）

```bash
node scripts/retrieve-report.mjs | tail -12
```

```
── 层账（整层搬完之后，这个文件还剩多少行）──
  当前文件                                   1074 行
  搬完 L1+L2+L3（385 行）           689 行   ← 已 ≤ 800
  再搬完 L0（335 行）                354 行   ← 模块壳

  ⇒ 结论（由数字决定，不是写死的判断）：
    搬完 L1+L2+L3 是 689 行，已经 ≤ 800 —— 「按层搬」到这里就够了。
    但继续搬 L0（335 行）会把本文件压到 354 行，那是「要不要把它变成纯壳」的决定，
    不是搬运顺序问题：那一步需要另立一次「入口点归位」，并接受本文件变成 store.ts 那种壳。
    剩下的 354 行是 import / re-export / 文件头注释 / 空行 —— 它们不是声明，
    没有任何一步「按层搬」能带走。
```

**这一步没有跨过 800 —— 1074 仍 > 800。**

第一版这里写的是「这一步跨过了 800」，那是把**下一步的算术**记到了本步头上。事实：

- 本步之后 `retrieve.ts` = **1074**，离 800 还差 274；
- 800 的**可达性**来自「再搬 L1+L2+L3」这一步算术：`1074 − 385 = 689`（L1 123 + L2 158 + L3 104）；
- 再往下搬 L0（335）会到 **354** 的模块壳。

也就是说：**本步做的是「把不执行的 242 行移走」，不是「把文件压到 800 以内」。**
把两件事分开记，是因为它们的含金量完全不同 —— 前者只是让文件诚实地反映「哪些行会执行」。

### 为什么不搬 L0（裁定⑧的三条理由）

1. **L0 是 335 行的真代码**（不是类型、不是常量），搬它就不再是「按层位移」，而是重新设计入口。
2. 搬完 L0 之后剩 **354 行**的模块壳（import / re-export / 注释 / 空行）—— 那正是 `store.ts` 现在走完的形态（374 行）。
3. 那是一个**「要不要把 `retrieve.ts` 变成纯壳」的决定**，需要 owner 明确接受「入口点归位」这件事
   （`index.ts` 的公开面怎么转出、`package.json` 的 `types` 指向谁、使用方的 import 路径变不变），
   不是一次搬运步骤能单方面决定的。

**如果 owner 之后要那个壳**：另立一次「入口点归位」的决定，并明确接受 `retrieve.ts` 变成
`store.ts` 那种 374 行的壳。不要把它当「下一步搬哪层」。

---

## 八、门禁

| 门禁 | 结果 |
|---|---|
| `npm test` | **506 / 506 / 0 / skipped 0** |
| `verify-pure-move --against 1ee862a --classify` | 逻辑 **2**（= 那两行删除，已逐字点名）；注释 33 / 管线 13 / 消失 0 |
| `v205` | **16/16**（ceiling 1294 → **1074**；`retrieve/types.ts` 已进扫描名单）|
| `v207` | **7/7**（六数重测；⑥ 的第二个文件从 `retrieve.ts` 改为 `retrieve/types.ts` —— 被测性质不变）|
| `v212` | **2/2**（`retrieve.ts` 模块级可变绑定仍 = 0）|
| `v213`（新） | **8/8**（先红过：删一行导出 → ① 红并点名 `FilterTrace`）|
| `module-registry` | **7/7**（38 模块：扁平 27 + `retrieve/` 6 + `store/` 5）|
| `type-budget` | OK（2459: 0；缺陷计数仍 12 —— 无新增，只有行号漂移）|
| `check-cycles` | nodes 38 / value edges **83（不变）** / **ACYCLIC**（1 个仅类型环，非失败）|
| `build` | 38 modules，重复 build 后零差异 |
| **导出面** | `lib/retrieve.js` **34 条运行期导出，一条不少**；12 个类型名**一个都没漏进运行期**（v213 ④）|
| **CI 双 Node** | 见提交后的 Actions（本轮由我推送后自行轮询）|

---

## 九、本步踩到并修好的两个事故（都值得记）

### ① 我用 PowerShell 文本往返，把中文写坏了

为验证 v213 会红，我用了 `Get-Content -Raw` / `Set-Content` 做「删一行→还原」。
PowerShell 5.1 在没有 BOM 时按本地代码页读 UTF-8 文件，再按本地代码页写回 ——
**`retrieve.ts` 里 75 处中文变成 U+FFFD**，随后 build 报 `ERR_INVALID_TYPESCRIPT_SYNTAX`。

- 影响面：`src/retrieve.ts`（75 处）、`lib/retrieve.js`（由它构建）。
  `src/retrieve/types.ts` 未被波及（它由脚本以 UTF-8 写入）。
- **没有任何提交包含这个损坏** —— 它在提交前被发现。
- 修法：`git checkout -- src/retrieve.ts lib` 回到 HEAD，再用**确定性脚本**重跑整步搬运
  （脚本本身也修了两处：改用「行号集合过滤」而不是从后往前 splice；`export type` 直接生成裸形式）。

**教训**：改源码只用工具（edit / write）或脚本的 UTF-8 读写；**不要用 shell 的文本往返改文件**。

### ② `scripts/build.mjs` 不是原子的：它先删 `lib/`，再逐个写

`rmSync(outDir, { recursive: true, force: true })` 在最前面。于是上面那次构建失败时，
`lib/` 被删到一半 —— 17 个文件没了，`lib/retrieve/` 整个空了。

这不是新缺陷（脚本一直如此），但**它是这个仓里唯一一个「失败会破坏工作树」的步骤**。
现在的处置是「修好源码再重建」，没有改脚本；如果要改，正确方向是**先写到临时目录，成功后整体替换**。
登记在此，未做。

---

## 十、没做的事

| 项 | 为什么 |
|---|---|
| 不搬 L0 | 见第七节三条 |
| 不改那 5 个仍在 `import type … from './retrieve.js'` 的使用方 | 12 行 `export type` 已经保住了导出面；改它们会扩大本步的 diff，而收益只是「路径更短」 |
| 不修 `reasoningEffort` / `currentCommit` / `updatedAt` / `ageDays` 四条类型缺陷 | 仍是 D-1…D-7；本步只让它们换了文件（`type-budget` 的身份表已按「文件路径是位置，不是身份」处理） |
| 不改 `index.ts` / `hitOf`(D-1) | 同上 |
| 不 publish、不碰 paradise、不动 desktop profile | 站定约束 |
