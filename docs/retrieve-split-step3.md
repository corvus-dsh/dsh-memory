# retrieve.ts 拆分 · 第三步：commitCache 族

> 前一份：`docs/retrieve-split-step2.md`（第二步：6 声明 → `retrieve/storage-tier.ts`）。
> 数据来源：`docs/commit-cache-ownership.md`（裁定 A：全搬 5 声明）。

---

## 一、结果

| 文件 | 行数 | 顶层声明 |
|---|---|---|
| `src/retrieve.ts` | **1718 → 1673** | **69 → 64** |
| `src/retrieve/commit-cache.ts` | **80**（新增，≤ 800 ✅）| 5 |
| `src/retrieve/interning.ts` | 285（不变）| 14 |
| `src/retrieve/storage-tier.ts` | 81（不变）| 6 |

搬走 **5 个声明 / 33 内容行**，物理区间 **L328–L373**（含族说明注释 L328–335）。

| 声明 | 区间 | 行数 | 性质 |
|---|---|---|---|
| `commitCache` | L336 | 1 | `const Map`，`const-mutated` |
| `COMMIT_DRIFT_WEIGHT` | L337 | 1 | `export const`，夹在族里 |
| `currentCommitOf` | L339–L359 | 21 | 写 `commitCache` |
| `clearCommitCache` | L362–L364 | 3 | 写 `commitCache` |
| `sameCommit` | L367–L373 | 7 | 纯字符串比较，零依赖 |

---

## 二、为什么这 5 个一起搬

`commitCache` 是 `const Map`，被 `currentCommitOf`（`.get` / `.set`）与 `clearCommitCache`
（`.clear`）**同模块**变异。判据是「**谁**在写它」：

| 案例 | 状态形态 | 谁在写 | 处置 |
|---|---|---|---|
| A1-2 `shapeCache` | `const Map` | 同模块代码变异 | 整体搬走，自洽 |
| 第一步排除的 3 个 `let` | `let` | 留在原地的代码赋值 | 不能搬 |
| 第二步这 3 个 `let` | `let` | 与它一起搬的写者 | 整体搬走，自洽 |
| **第三步 `commitCache`** | `const Map` | **与它一起搬**的写者 | **整体搬走，自洽** |

`sameCommit` 不碰缓存，但唯一消费者 `scoreDocuments` 同时用 `currentCommitOf` 与 `sameCommit`，
留一个搬一个会把调用点拆到两个模块。

`COMMIT_DRIFT_WEIGHT` 物理上夹在 `commitCache`(L336) 与 `currentCommitOf`(L339) 之间。
按依赖它属 `scoreDocuments`（唯一使用点 L963），但留下会把本族切成两段 —— 一起搬并 re-export。

---

## 三、导出面（34 条不变）

| 名字 | 运行时导出面 | 处置 |
|---|---|---|
| `COMMIT_DRIFT_WEIGHT` | **是** | import + **re-export**（`scoreDocuments` L963 用）|
| `currentCommitOf` | **是** | import + **re-export**（L960 用；`index.ts:L23` 也取）|
| `clearCommitCache` | **是** | 只 **re-export**（段外零引用；`test/v102` 取）|
| `sameCommit` | 否 | 只 **import**（L961 用；原本就是私有）|
| `commitCache` | 否 | 不 import、不 re-export（私有状态）|

`lib/retrieve.js` 实测 **34 条导出面不变**。

---

## 四、门禁

| 门禁 | 结果 |
|---|---|
| `npm test` | **482 / 482 / 0 / skipped 0** |
| `v102` commit drift | **6 / 6** |
| `verify-pure-move`（见下「复现」）| 逻辑 **0**；消失 1 行（已登记）；新增 32 行 = 注释 32 + 管线 0 + 逻辑 0 |
| `check-cycles` | nodes 35 / value edges 75 / **ACYCLIC** / unresolved 0 |
| `type-budget` | OK（2459: 0）|
| `readme-counts` | 7/7 |
| `v205` 尺寸门禁 | **16 / 16**（新文件已登记；ceiling 收紧到 1673）|
| `v207` 六个数字 | 6/6（第三步后重测）|
| `v209` 产物同步 | 4/4 |
| `lib/retrieve.js` 导出面 | **34 条不变** |
| build 后 `git status` | 空（产物与源码同步）|

**复现（可执行，逐字）**：

```bash
# 工作树必须是第三步提交后的状态（该提交：6446dea，父提交：f9d1abf）
#   git worktree add --detach /tmp/s3 6446dea
#   把**当前** scripts/verify-pure-move.mjs 复制进 /tmp/s3/scripts/
node scripts/verify-pure-move.mjs --against f9d1abf --classify
```

实测输出（2026-11-15）：

```
DISAPPEARED 1 条 / 1 行
APPEARED   22 条 / 32 行

                   注释   管线   逻辑
  APPEARED          32      0      0
  DISAPPEARED        1      0      0
  ── 合计 ──        33      0      0
[exit 0]
```

> **订正（2026-11-15）**：原先写 `--against HEAD` —— 搬运完成后 HEAD 已含改动 ⇒ VACUOUS（exit 2）。
> 必须用**带父提交 + `--classify`**，且树要退到该步（树用旧的、脚本用新的）。

### 那 1 行 DISAPPEARED

```
消失: "/** Same commit? Compare on the short prefix, because a file may record either form. */"
出现: " * Same commit? Compare on the short prefix, because a file may record either form."
      " * 导出：`retrieve.ts` 的 `scoreDocuments` 是它的唯一调用者（L961），搬走后必须能 import。"
```

`sameCommit` 的单行注释被展开成多行注释块（因为加了 `export` 并写明为什么）。
已登记进 `KNOWN_FORMAT_CORRECTIONS`，commit 字段标注为本次提交。

---

## 五、ceiling 棘轮（裁定③ 的首次实战）

本次搬运把 `retrieve.ts` 从 1718 压到 1673。**裁定③ 新增的断言立刻抓住了它**：

```
✖ cap: EXEMPT 的 ceiling 必须等于实测（棘轮强制收紧，不许留虚高配额）
  retrieve.ts（ceiling 1718，实测 1673，差 45）
```

这条断言在第三步开工前**还不是红的**（当时 1718 == 1718）。是这次搬运让它变红，
于是收紧动作成为**强制的**，而不是靠我记得。ceiling 已改为 1673，reason 也改写成四步路径。

---

## 六、六个数字（四步）

| 项 | 搬前 | 第一步 | 第二步 | **第三步** |
|---|---|---|---|---|
| 无向连通分量 | 19 | 21 | 21 | **21** |
| 主干 | 68·1251 | 51·955 | 45·927 | **40·894** |
| 有向 SCC | 89 | 75 | 69 | **64** |
| 缩点拓扑层 | 8 | 6 | 5 | **5** |
| 四档 D/C/B/A | 486·413·373·263 | 486·362·295·219 | 486·362·282·204 | **486·362·261·192** |
| 声明 / 跨度和 | 89·1535 | 75·1362 | 69·1334 | **64·1301** |

---

## 七、红过三次（前两条是门禁按设计工作）

| # | 红 | 性质 |
|---|---|---|
| 1 | `sameCommit` 在新模块里是私有 → `does not provide an export named 'sameCommit'` | 我的失误：搬走后 `retrieve.ts` 要 import 它，必须加 `export` |
| 2 | `v205` 新文件未登记 + ceiling 虚高 | **门禁按设计工作** |
| 3 | `v207` 六数变化 + `v208` 连带 | **门禁按设计工作** |

---

## 八、`retrieve.ts` 的进度

| 时点 | 行数 | 声明 |
|---|---|---|
| **拆分起点**（第一次搬运前） | **2009** | **89** |
| 第一步后 | 1763 | 75 |
| 第二步后 | 1718 | 69 |
| **第三步后** | **1673** | **64** |

从起点算：**2009 → 1673**（**−336，−17%**）。

> **订正（2026-11-15，用户裁定⑤）**：这张表原先写「重构前（`e3bed57`）2479 → 1673（−806，−33%）」，
> 那是**把两份文件混在一起**了。
>
> `2479` 是 **`store.ts`** 在 `e3bed57` 的行数 —— 它对应的是 store 那条重构线
> （第 0 步时钟 → B 的 IO 原语 → A3 的 JSONL 层 → A1 的六段 → A2 的生命周期簇），
> 记录在 `docs/A2-final-report.md` 与 `docs/A1-final-report.md`。
>
> `retrieve.ts` 的拆分起点是 **2009**，接在 A2 之后，与 store 那条线**没有承接关系**。
> 把 store 的起点借过来算百分比，会让这个文件的进度看起来比实际更显著（−33% 对 −17%）。
> 一份进度表把两个不同文件的起点串成一条线，比没有进度表更糟。

---

## 九、下一步

- 主干仍是单一分量：**40 声明 / 894 行**
- 最大单函数 `skillDocuments` **121 行**（L4 层）
- `hitOf`（D-1 落点）仍在 `retrieve.ts`，按裁定等重构完成后再修
- `index.ts` 2361 行仍在 `EXEMPT` 天花板

---

## 十、没做的事

- 不 publish、不碰 paradise
- D-1…D-7 挂着
- desktop profile 不动
