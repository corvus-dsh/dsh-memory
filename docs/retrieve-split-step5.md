# retrieve.ts 拆分 · 第五步：场景族（`retrieve/scene.ts`）

> 本步提交：见 `git log --grep="第五步"`；**父提交 `abf9657`**。
> 用户裁定：① `SceneOptions` 也搬走并做类型 re-export；② 理由是「状态与写者同走」且必须机械断言。

---

## 一、结果

| 文件 | 行数 | 声明 |
|---|---|---|
| `src/retrieve.ts` | 1419 → **1294**（净 −125）| 56 → **46** |
| `src/retrieve/scene.ts` | — → **164**（≤ 800）| **10** |

搬走的 10 个声明（声明 span 合计 **101 行**）：

```
SCENE_PROMPT  SceneOptions  SceneCacheEntry  sceneCache  clearSceneCache
sceneCacheStats  SCENE_TAG  classifyScene  LEGACY_SCENE_HINTS  inferScene
```

**注意：文件净减 125，不是 101。** 101 是 10 个声明各自的 span 之和；实际搬的是**连续区域**，
区域里还带着这一族自己的 23 行注释与 7 行空行（`git diff` 实测：出 128 行 = 98 代码 + 23 注释 + 7 空行），
再减去进 3 行（1 行 `import` + 2 行 `re-export`）。`1419 − 128 + 3 = 1294`。

`retrieve.ts` 现在只需要从新模块 import 回来 **2 个**：

| 名字 | 用处 |
|---|---|
| `classifyScene` | `retrieveHybrid` 里的场景路由 |
| `inferScene` | 词法回退路径 |

`retrieve.ts` 的**导出面**（`lib/retrieve.js` 的 34 条运行期导出）**一条不少**。
新模块导出 5 个运行期名 + 1 个类型名：

```ts
// src/retrieve.ts 末尾
export { SCENE_PROMPT, clearSceneCache, sceneCacheStats, classifyScene, inferScene } from './retrieve/scene.js'
export type { SceneOptions } from './retrieve/scene.js'
```

### 为什么 `SceneOptions` 是搬走 + `export type`，而不是留在原地（裁定①）

`package.json` 的 `"types": "./src/index.ts"`、`files` 含 `src` —— **源码本身就是发布出去的类型面**。
所以 `SceneOptions` 一旦留在 `retrieve.ts`，新模块就得反过来 `import type` 它，
而它描述的正是 `sceneCache` 的键值形状：**状态搬走了、形状没搬，是最坏的一种半搬**。

这里有一个**没有门禁的地方**，必须点名：导出面门禁（`v202` / `v211` 那类）是
`import('../lib/store.js')` 式的**运行期**断言，它只数得到运行期名字。
`export type` 在 `stripTypeScriptTypes` 之后整行消失，**没有任何测试会因为漏了它而红**。
所以 `export type { SceneOptions }` 这一行是**手写的**，不是被门禁逼出来的 —— 漏了没人会红。

### 为什么 `collectScenes` 不在族里

它是**域列表的生产者**，由调用方以 `options.scenes` 传进 `classifyScene` ——
二者的耦合是**通过参数**发生的，不是通过闭包。把它拉进来会制造一条假依赖：
新模块会需要 store 侧的域枚举，而 `classifyScene` 其实对「域从哪来」一无所知。

---

## 二、先让它红（惯例）：这一轮是**五红**

搬完**不动任何门禁**，红的是五条（2026-11-16 机械复现：`git worktree add abf9657` 取旧门禁，
把**当前** `src/` 覆盖进去，跑旧判据）：

| # | 门禁 | 报的是什么 |
|---|---|---|
| 1 | `v205` 扫描名单 == 磁盘 | `retrieve/scene.ts`（新文件没进 `SCANNED`）|
| 2 | `v205` ceiling 棘轮 | `retrieve.ts（ceiling 1419，实测 1294，差 125）` ← **棘轮第三次咬合** |
| 3 | `v207` ① 六数 | `actual: 20, expected: 22`（分量）|
| 4 | `module-registry` | `src/retrieve/scene.ts`（磁盘上有、表里没有）|
| 5 | `v212` ①② | `sceneCache [const] mutable=true L102`（对**搬前**的树）|

第 5 条是新门禁的「先让它红」：v212 在搬前的 `retrieve.ts` 上必须报红，否则它就是个摆设。
实测它报的正是 `sceneCache [const] mutable=true L102` —— 字段名、种类、行号全对。

> 上一版预算里写的是「1419 ≠ **1318**」。**实测是 1294**。
> 差异来源见第一节：1318 假设只搬 101 行，而连续区域多带了 30 行注释/空行。
> 记录这个差异不是抠字眼 —— 它说明「声明 span 之和」与「文件净减」是两个数，后续每一步都会差。

---

## 三、三项前置分析（搬之前算的，不是搬之后补的）

| 项 | 实测结果 |
|---|---|
| **区域连续性** | 10 个声明在 `retrieve.ts` 里是一段**连续区域**，中间没有混入非族声明 |
| **段外值依赖** | **0**（新模块对 `retrieve.ts` 零值依赖；只有一个 `import type { LlmLike }`，构建时擦除）|
| **`sceneCache` 的写者** | **全在族内**（`clearSceneCache` 清、`classifyScene` 读写、`sceneCacheStats` 读）⇒ 可以「状态与写者同走」|

这三项决定了这一步能做成**纯位移**：零段外值依赖 ⇒ 不会反向拉出一条新边；
写者全在族内 ⇒ 搬完 `retrieve.ts` 不再持有任何模块级可变状态。

---

## 四、门禁

| 门禁 | 结果 |
|---|---|
| `npm test` | **497 / 497 / 0 / skipped 0** |
| `verify-pure-move --against abf9657 --classify` | 消失 **0/0**、出现 **24 条 / 34 行**（全注释）、**逻辑 0** |
| `v203 / v205 / v207 / v208` | 4/4 · **16/16** · **7/7** · 1/1 |
| `v209 / v210 / v211 / v212` | 4/4 · **7/7** · **5/5** · **2/2** |
| `module-registry` | **6/6** |
| `type-budget` | OK（2459 导入未导出：**0**；`retrieve.ts` 5 → **4**）|
| `check-cycles` | nodes 37 / value edges 83 / **ACYCLIC**（0 条值环）|
| `build` | 37 modules，重复 build 后 `lib/` 零差异 |
| **导出面** | `lib/retrieve.js` **34 条**（与搬前逐条相同）|
| **模块级可变绑定** | `retrieve.ts` = **0**（`v212 ①`）|
| **CI（双 Node）** | 见提交后的 Actions（本轮由我在推送后自行轮询）|

> **「全注释」是什么意思**：那 34 行是**整棵树相对父提交的净增非空行**，不是「搬过去的 128 行全是注释」——
> 判据是**全树多重集**比较，搬走的代码行在新模块里逐字重现，两侧互相抵消，所以既不在 APPEARED 也不在
> DISAPPEARED 里出现。净增的 34 行全部是**新写的说明文字**（主要是新模块的文件头注释），
> 因此结论是：**这一步没有新增任何逻辑行，只新增了文档。**
>
> 半句补充：那 3 行 `import { classifyScene, inferScene }` / 两行 `export …` **也在这一步新增了**，
> 只是它们以 `import ` / `export ` 开头，被判据当成**搬移的管线**在分桶之前就剔除了 ——
> 所以「34 行全是注释」不等于「这一步只改了注释」。**管线是必须的产物**（纯位移必然要加 import 与 re-export），
> 但它是**新增行**，别把它读成「什么也没加」。

---

## 五、可执行复现块（照 step4 的模板）

纯位移的判据要**对着父提交**量，且必须带 `--classify` —— 否则「搬走 128 行」会被当成
「删掉 128 行真代码」。而且**树要用提交的、脚本要用当前的**：树里那份 `verify-pure-move.mjs`
是那一步的旧版本，跑它量出来的是旧格式，不是复现。

```bash
# 工作树必须是本步提交后的状态（本步父提交：abf9657）
#   git worktree add --detach /tmp/s5 HEAD
#   把**当前** scripts/verify-pure-move.mjs 复制进 /tmp/s5/scripts/（判据要今天的）
cd /tmp/s5 && node scripts/verify-pure-move.mjs --against abf9657 --classify
```

2026-11-16 逐字输出（本机实测）：

```
ref  abf9657: 13788 内容行
tree      : 13822 内容行  （差 34）

DISAPPEARED 0 条 / 0 行
APPEARED   24 条 / 34 行

                   注释   管线   逻辑
  APPEARED          34      0      0
  DISAPPEARED        0      0      0
  ── 合计 ──        34      0      0   ← 逻辑必须为 0

  三类合计 34 行（应等于 新增 34 + 消失 0 = 34）
```

⚠ **不要写 `--against HEAD`。** 那量的是「工作树相对 HEAD」，在任何有未提交改动的时候都会红，
而在全部提交之后恒为 0 —— 它永远绿，因此什么也不证明。同一条错已经犯过四次，
`v211` 现在会扫描 `docs/**.md` 里的 `--against HEAD` 字样并报红。

---

## 六、六个数字（六步）

| 时点 | 分量 | 主干 | SCC | 层 | 四档 (D·C·B·A) | 声明·span 和 |
|---|---|---|---|---|---|---|
| 搬前（第一步前） | 19 | 68·1251 | 89 | 8 | 486·413·373·263 | 89·1535 |
| 第一步后 | 21 | 51·955 | 75 | 6 | 486·362·295·219 | 75·1362 |
| 第二步后 | 21 | 45·927 | 69 | 5 | 486·362·282·204 | 69·1334 |
| 第三步后 | 21 | 40·894 | 64 | 5 | 486·362·261·192 | 64·1301 |
| 第四步后 | 22 | 30·647 | 56 | 4 | 365·317·208·175 | 56·1065 |
| **第五步后** | **20** | **22·557** | **46** | **4** | **365·254·208·137** | **46·964** |

分量 22 → 20：场景族整族离开主干（主干 30 → 22 声明）。族里 `SceneOptions` /
`SceneCacheEntry` 两个纯类型声明在旧图里只与 `classifyScene` / `sceneCache` 相连，
随族一起走，所以图里少了两个独立分量。

**层数不变（仍 4）**：场景族原本跨 L0/L1/L2/L3 四层，整族搬走不会把某一层抽空 ——
这与第四步（搬走整个 L4，层数 5 → 4）不同。

---

## 七、这一步真正的理由：状态与写者同走，模块级可变状态归零（裁定②）

`retrieve.ts` 曾经持有三处模块级可变状态，每一处都在它自己的那一步搬走：

| 状态 | 形状 | 搬去了 |
|---|---|---|
| `activeStorageTier` / `tierIndex` / `tierIndexPath` | `let` | 第二步 → `retrieve/storage-tier.ts` |
| `commitCache` | `const Map`（被 `.set` 变异）| 第三步 → `retrieve/commit-cache.ts` |
| `sceneCache` | `const Map`（被 `.set` / `.clear` 变异）| **本步 → `retrieve/scene.ts`** |

搬完这一处，`retrieve.ts` 的**模块级可变绑定 = 0**。

为什么值得一条门禁：模块级可变状态让「同一份代码在两次调用之间行为可能不同」这件事
**无处可查** —— 它不是参数、不是返回值，而是藏在模块顶层。全部搬走之后，
`retrieve.ts` 剩下的每个函数都只依赖输入与纯常量。

**这条是机械断言的，不是靠人看**：

```bash
node --test test/v212-retrieve-no-mutable-state.test.mjs
```

`v212 ①` 从 `scripts/closure.mjs --declarations` 的 `mutable` 字段筛 `retrieve.ts`，要求结果为空。
`v212 ②` 是它的反向断言：判据必须能分辨「`const` 但被变异」这一类 —— 全仓至少有一个
`mutable: true` 的 `const` 声明，且 `sceneCache` / `commitCache` 各自在它该在的新模块里。

> ⚠ 这条断言有个容易踩的坑，写进 `v212` 文件头了：`closure.mjs --declarations` 给的是**布尔**，
> 而 `closure.mjs <symbol>` 的摘要路径打印的是 `"sceneCache (const-mutated)"` 这种**标签**。
> 两条路径表示不同，用错一条就会得出「没有可变状态」的结论。

---

## 八、`retrieve.ts` 的进度与层账（别被上面那 101 行误导）

| 时点 | `retrieve.ts` |
|---|---|
| 起点（`e3bed57`） | 2009 |
| 第一步 | 1763 |
| 第二步 | 1718 |
| 第三步 | 1673 |
| 第四步 | 1419 |
| **第五步** | **1294** |

累计 **−715 行（−35.6%）**，声明 89 → 46。

**层账（这是关键，别把它读成「再搬几层就 800 了」）**。

这三行由脚本算，**不要手抄**——上一版手算过两次、错两次（第一次用 1419 的基数、第二次把「声明 span 之和」
当成「文件净减」）。命令与逐字输出：

```bash
node scripts/retrieve-report.mjs | tail -12
```

```
── 层账（整层搬完之后，这个文件还剩多少行）──
  当前文件                                   1294 行
  搬完 L1+L2+L3（385 行）           909 行   ← 仍 > 800
  再搬完 L0（579 行）                330 行   ← 模块壳

  ⇒ 跨过 800 只能靠「动 L0」。搬完 L0 之后剩下的那一截是 import / re-export /
    文件头注释 / 空行 —— 它们不是声明，没有任何一步「按层搬」能带走。
    「下一步搬哪层」这个问法到不了 800，那是「要不要把本文件变成纯壳」的决定。
```

读法：

- 1294 仍 **> 800**；
- 把 L3 + L2 + L1 全搬完，还剩 **909**（−385：L1 123 + L2 158 + L3 104）；
- 要到 800 以下，**只能动 L0（579 行）**，之后剩 **330 行** —— 那是模块壳（import / re-export /
  文件头注释 / 空行），不是可搬的声明。`store.ts` 走的就是这条路，它现在 374 行。

也就是说：**「下一步搬哪层」这个问法通向不了 800。**
那是一个战略决定 ——「要不要把 `retrieve.ts` 变成纯壳」。它不是下一步的候选，
而是下一轮要回答的问题。

---

## 九、没做的事（如实登记）

| 项 | 为什么 |
|---|---|
| 不改 `reasoningEffort` 的类型缺陷 | 它是**随函数搬过来的既有缺陷**（`reasoningEffort` 被传给一个不声明它的参数类型）。改签名会让这一步不再是纯位移。`type-budget` 里只把它的**身份文件名**从 `retrieve.ts` 改成 `retrieve/scene.ts`（message 逐字未变，总数仍 12）—— 这正是该脚本注释里 A3 搬移已经立过的先例：「文件路径是位置，不是身份」 |
| 不拆 `classifyScene`（63 行）| 本步是整族位移；函数体拆分是编辑，`verify-pure-move` 不适用 |
| 不动 `collectScenes` | 见第一节末尾 |
| 不改 `index.ts` / `hitOf`(D-1) | D-1…D-7 仍挂着 |
| 不 publish、不碰 paradise、不动 desktop profile | 站定约束 |
