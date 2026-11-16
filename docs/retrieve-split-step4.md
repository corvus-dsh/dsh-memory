# retrieve.ts 拆分 · 第四步：L4 整层（`retrieve/documents.ts`）

> 前一份：`docs/retrieve-split-step3.md`（第三步：commitCache 族）。
> 方案：`docs/retrieve-split-next-l4.md`（含用户裁定①②的两处订正）。

---

## 一、结果

| 文件 | 行数 | 顶层声明 |
|---|---|---|
| `src/retrieve.ts` | **1673 → 1419** | **64 → 56** |
| `src/retrieve/documents.ts` | **296**（新增，≤ 800 ✅）| 8 |
| `src/retrieve/interning.ts` | 285（不变）| 14 |
| `src/retrieve/storage-tier.ts` | 81（不变）| 6 |
| `src/retrieve/commit-cache.ts` | 80（不变）| 5 |

搬走 **L4 整层 / 8 声明 / 236 行**代码。

| 声明 | 区间（搬前） | 行数 | 搬后 |
|---|---|---|---|
| `tierDocumentOf` | L65–L85 | 21 | export |
| `STOPWORDS` | L358–L362 | 5 | export |
| `looksLikeIncidentLog` | L442–L447 | 6 | export（**唯一 re-export**）|
| `ERROR_IDENTIFIER` | L508 | 1 | export |
| `contentOf` | L566–L570 | 5 | export |
| `skillDocuments` | L605–L725 | 121 | export |
| `negativeDocuments` | L757–L801 | 45 | export |
| `layerDocuments` | L804–L835 | 32 | export |

---

## 二、先让它红（惯例）

按裁定要求，搬完**先不修**，直接跑门禁——四红，全部符合预期：

```
✖ cap: 显式扫描名单 == 磁盘上真实存在的 .ts 文件（漏登记即红）
✖ cap: EXEMPT 的 ceiling 必须等于实测（棘轮强制收紧）
✖ v207 ①: 当前六数与内置基线逐项相等
✖ v208 can-red（v207 连带）
```

**ceiling 棘轮报的是「1673 ≠ 新实测 1419」** —— 裁定③新增的那条断言在这里第一次
以「搬运导致文件缩小」的形式咬合（上一次是第三步的 45 行差额）。

---

## 三、三项前置分析（数据来自 `docs/retrieve-split-next-l4.md`）

- 簇内闭包：8 声明，物理分散在 L65–L835 的 8 个段，**无相交、无混入**
- 对簇外依赖：搬到最后仍需 **10 条 import**（node:fs / node:path / edges / ledger-cache /
  skill-cache / sqlite-index / store-skill / workspace / retrieve 类型 / interning）
- **段外引用 8/8 全部有** —— 这 8 个声明没有一个是纯内部

---

## 四、门禁

| 门禁 | 结果 |
|---|---|
| `npm test` | **490 / 490 / 0 / skipped 0** |
| `verify-pure-move --against 7b9d3f6 --classify`（见下「复现」）| 消失 **0** 行；新增 27 行 = 注释 **27** + 管线 0 + **逻辑 0** |

> **订正（2026-11-16）**：上表的命令原先写 `--against HEAD` —— 两个问题：
> ① 搬运完成后 HEAD 已含改动 ⇒ **VACUOUS**（exit 2），不是通过；
> ② 不带 `--classify` 时主路径对「新增注释」是红的（它比内容行多重集，而本步新增 27 行头注释）。
>
> 正确形式是**带父提交 + `--classify`**，且**树要退到本步提交**（`b684c91`）。
> 这是同一条错在本仓的**第四次**（step1/step2/step3 各一次）。第四次之后不能再靠人读 ——
> 见 `test/v211-no-against-head-in-docs.test.mjs`（机械判据：docs/*.md 里出现 `--against HEAD` 即红）。

**复现（可执行，逐字）**：

```bash
# 工作树必须是本步提交后的状态（本步提交：b684c91，父提交：7b9d3f6）
#   git worktree add --detach /tmp/s4 b684c91
#   把**当前** scripts/verify-pure-move.mjs 复制进 /tmp/s4/scripts/
node scripts/verify-pure-move.mjs --against 7b9d3f6 --classify
```
| `check-cycles` | nodes 36 / value edges 82 / **ACYCLIC** / unresolved 0 |
| `type-budget` | OK（2459: 0）|
| `readme-counts` | 8/8 |
| `v205` 尺寸门禁 | 16/16（新文件已登记；ceiling 1673 → 1419）|
| `v207` 六个数字 | 7/7（第四步后重测）|
| `v208` can-red | 1/1 |
| `v209` 产物同步 | 4/4 |
| `v210` 分类判据 | 7/7（⑦ 改成取第三步那棵树）|
| `module-registry` | 6/6（`documents.ts` 已登记）|
| `lib/retrieve.js` 导出面 | **34 条不变** |
| build | 36 modules；rebuild 后 `lib/` 只有本次产物差异 |

---

## 五、六个数字（五步）

| 项 | 搬前 | 1 | 2 | 3 | **4** |
|---|---|---|---|---|---|
| 分量 | 19 | 21 | 21 | 21 | **22** |
| 主干 | 68·1251 | 51·955 | 45·927 | 40·894 | **30·647** |
| SCC | 89 | 75 | 69 | 64 | **56** |
| 层 | 8 | 6 | 5 | 5 | **4** |
| 四档 D/C/B/A | 486·413·373·263 | 486·362·295·219 | 486·362·282·204 | 486·362·261·192 | **365·317·208·175** |
| 声明/跨度和 | 89·1535 | 75·1362 | 69·1334 | 64·1301 | **56·1065** |

分量 21 → 22：**不是**「多了一个碎片」，而是**主干被削掉一圈之后，一个原本挂在主干上的小块自己独立了**。

精确对比 `7b9d3f6`（本步前）与 `b684c91`（本步后）的分量集合：

```
7b9d3f6  21 个分量 / 主干 40 声明 894 行
b684c91  22 个分量 / 主干 30 声明 647 行
```

被搬走的 8 个声明从各分量里消失，这本身**不改变分量数**。真正多出来的是这一对：

| 状态 | 分量 |
|---|---|
| 本步前 | `TASK_TERM_LIMIT` + `extractTaskTerms` **在主干里**（它们经由 `STOPWORDS` / `tokenize` 连到主干）|
| 本步后 | `TASK_TERM_LIMIT` + `extractTaskTerms` **成为独立分量**（2 声明 / 11 行）|

因为 `STOPWORDS` 与 `tokenize` 都随 L4/第一步搬走了，`extractTaskTerms` 剩下的边只连到
它自己的常量 `TASK_TERM_LIMIT` —— 于是「主干 − 桥梁」= 一个新碎片。

> **订正（2026-11-16）**：这里原先写「`contentOf` 那个只与 `Document` 有类型边的碎片成为独立分量」。
> **那是错的**，两处都错：
> ① `contentOf` 在本步前**就**是主干的成员（它被 `isPoisoned` 调用，是值边），本步后它随 L4 一起
>    搬进 `documents.ts`，**根本不在 `retrieve.ts` 的分量表里**；
> ② 我把它说成「只与 `Document` 有类型边」—— 那是 `documents.ts` 里的 `contentOf` 与
>    `Document` 的关系，不是 `retrieve.ts` 的分量结构。
>
> 一个「+1 个分量」的解释写错，比不解释更糟：它让读者以为源头已经查清。

---

---

## 六、先红过的五次（按惯例先让它红）

搬完**先不修门禁**，直接跑，五红：

```
✖ cap: 显式扫描名单 == 磁盘上真实存在的 .ts 文件（漏登记即红）
✖ cap: EXEMPT 的 ceiling 必须等于实测（棘轮强制收紧）
✖ module-registry: every module on disk is REGISTERED（新模块未登记）
✖ v207 ①: 当前六数与内置基线逐项相等
✖ v208 can-red（v207 连带）
```

| # | 红 | 性质 |
|---|---|---|
| 1 | `v205` 显式扫描名单 ≠ 磁盘 | **门禁按设计工作**（新文件 `documents.ts` 未登记）|
| 2 | `v205` ceiling 棘轮：`1673 ≠ 1419` | **门禁按设计工作**（裁定③那条断言第二次咬合）|
| 3 | `module-registry` 磁盘有、表里无 | **门禁按设计工作**（递归守护生效——这正是裁定⑦补的能力）|
| 4 | `v207 ①` 六数变化 | **门禁按设计工作**（搬完数字必须变，测试要求重测）|
| 5 | `v208` 连带 | v207 的连带 |

> **订正（2026-11-16）**：这一节原先只列了「四红」，漏了 `module-registry`。
> 漏的原因很具体：我在搬完之后**只看了 v205/v207/v208**（前几步每次都是这三类），
> 没有把 `npm test` 的完整失败清单读完 —— 而 `module-registry` 的红就在同一份清单里。
> **「我以为还是老三样」不是没看见它的理由。** 判据是 `npm test` 的 `✖` 行，不是我的预期。

---

## 七、之后修的两次（都是「测试不自足」，不是搬运错）

| # | 红 | 根因 | 修法 |
|---|---|---|---|
| 1 | `v205` 新文件未登记 + ceiling 虚高 + `v207` 六数变化 + `module-registry` | 见上表，全部是门禁按设计工作 | 登记 + 收紧 ceiling + 重测六数 + 补 MODULE-REGISTRY 行 |
| 2 | `v210 ⑦` 报「出现侧应为 32，实测 …」 | 它把「当前工作树」当成第三步的状态。第四步落地后工作树前进，同一命令量的变成「一到四步」的全部变化 | 改成**显式取 6446dea 的树**（`git show` 逐文件导出 + alternates 借对象库），在那里跑 `--against f9d1abf` |

第 2 条与本轮早前 v207 ①b 的错是同一族：**测试假设了「当前树 == 某个历史状态」这个它没有声明的前提**。
两次的修法也一样——把那个状态显式取出来，而不是依赖工作树恰好停在哪儿。

---

## 七、`retrieve.ts` 的进度

| 时点 | 行数 | 声明 |
|---|---|---|
| **拆分起点** | **2009** | **89** |
| 第一步后 | 1763 | 75 |
| 第二步后 | 1718 | 69 |
| 第三步后 | 1673 | 64 |
| **第四步后** | **1419** | **56** |

从起点算：**2009 → 1419**（**−590，−29%**）。

---

## 八、下一步

剩余四层：L0（596→?）/ L1 / L2 / L3。**下一个候选是一处需要订正的认识**：

`docs/retrieve-split-next-l4.md` 订正时发现——**L2 的 `scoreDocuments` 占比 62.8%，
比 L4 的 `skillDocuments`（51.3%）更集中**。所以「单函数过大的层」不止 L4：
L2 才是更大的那个（108/172）。

若继续按「函数过长」这条线拆，L2 是下一个；若按「层从低到高」拆，则是 L3（111 行 / 11 声明，最小）。

**这个选择没有做**，留给下一轮裁定。

---

## 九、本步提交的作者名是被污染的（读历史时请看这一条）

`b684c91`（本步提交）的 git 作者显示为 **`v210 <v210@test.local>`**，
而仓里所有其它提交都是 `memory-freeze <freeze@memory.local>`。

**实际作者是 `memory-freeze`。** 显示错误的原因：`v210 ⑦` 为了重建历史树写了一个
`git config` helper，`cwd` 误指向真仓，于是把仓库本地的 `user.name` / `user.email`
改成了 `v210`（而且 `git config` 把多余参数当**第二个值**追加，导致多值）。
下一个提交因此被记到 `v210` 名下。

修复在 **`758127d`**：用 `--replace-all` 恢复单值，并把 helper 改成收 `cwd`（初始化与
config 一律在临时目录里做）。

**`b684c91` 没有改写**：它已在 `origin/main` 上，改写需要 force push，
而站定约束明确禁止。代价是历史里留一个错误作者名，收益是不重写已发布的历史 ——
把原因写在这里，读的人不用去猜。

---

## 十、没做的事

- 不 publish、不碰 paradise
- D-1…D-7 挂着（`hitOf` 仍在 `retrieve.ts`）
- `index.ts` 2361 行仍在 `EXEMPT`
- desktop profile 不动
