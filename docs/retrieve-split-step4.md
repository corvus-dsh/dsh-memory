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
| `verify-pure-move --against HEAD --classify` | 消失 **0** 行；新增 27 行 = 注释 **27** + 管线 0 + **逻辑 0** |
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

分量 21 → 22：8 个声明原来连在主干上，搬走后主干从 40 缩到 30 声明；
`contentOf` 那个只与 `Document` 有类型边的碎片成为独立分量。

---

## 六、红过两次（都是「测试不自足」，不是搬运错）

| # | 红 | 根因 | 修法 |
|---|---|---|---|
| 1 | `v205` 新文件未登记 + ceiling 虚高 + `v207` 六数变化 | **门禁按设计工作** | 登记 + 收紧 ceiling + 重测六数 |
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

## 九、没做的事

- 不 publish、不碰 paradise
- D-1…D-7 挂着（`hitOf` 仍在 `retrieve.ts`）
- `index.ts` 2361 行仍在 `EXEMPT`
- desktop profile 不动
