# A2 终值表 —— 生命周期簇搬出 `store.ts`

> 提交：`1278993`（A2）。前一档：`docs/A1-final-report.md`（A1，`7410896`）。
>
> 这份文件的用途与 A1 那份相同：**把终值写进仓库**，而不是只留在一次会话的报告里。
> 报告会丢，仓库里的表不会。每个数字都可以用下面「复现」一节的两条命令重测。

---

## 一、终值

| 文件 | 行数 | 顶层声明 | 变化 |
|---|---|---|---|
| `src/store.ts` | **374** | **15** | 2479 → **374**（−2105）|
| `src/store/lifecycle.ts` | **743** | **22** | 新增，**≤ 800** ✅ |
| `src/store/skill.ts` | 985 | 41 | 不变（A1 产物）|
| `src/store/layer.ts` | 532 | 16 | 不变（A3 产物）|
| `src/store/io.ts` | 165 | 8 | 不变（B 产物）|
| `src/store/clock.ts` | 39 | 3 | 不变（第 0 步产物）|

`store.ts` 从 **2479** 行降到 **374** 行（−2105，−85%）。

**2479 的出处**：`e3bed57`（`feat(0.9.1)`），即**整轮重构开始之前的最后一个提交**。
之后第 0 步（`14c1d59`，时钟）才动它。所以「2479 → 374」跨越的是全部六步：

| 步 | 提交 | `store.ts` 行数 |
|---|---|---|
| （起点） | `e3bed57` | 2479 |
| 第 0 步 时钟三件套 | `14c1d59` | 2464 |
| B IO 原语 | `b269fbd` | 2330 |
| A3 JSONL 层写入 | `1065ca1` | 1887 |
| A1-1 段1+2+3 | `7ba4dd1` | 1692 |
| A1-2 shapeCache 簇 | `6c1ce9d` | 1489 |
| A1-3 段5 前半 | `bf35562` | 1277 |
| A1-4 段5 后半 | `721a9b3` | 1141 |
| A1-5+A1-6 段6 | `7410896` | 1056 |
| **A2 生命周期簇** | `1278993` | **374** |

顶层声明的同一路径：**78 → 15**（起点实测 77 个顶层声明 + 1 个在上游被合并的，
A1 文档记作 78；A1 完成后 37，A2 完成后 15）。

---

## 二、导出面

| 时点 | 总数 | 业务面 | 接缝 |
|---|---|---|---|
| 重构开始前 | 52 | 50 | 2 |
| A1 完成（`7410896`） | 51 | **50** | 1 |
| A2 完成（`1278993`） | 51 | **50** | 1 |

**业务面 51 → 50 是刻意的**：`resetShapeCacheForTest` 是测试接缝，A1-6 把它移出 `store.js`
的公开面（它随 shapeCache 进 `store/skill.ts`，只从 `skill.js` 出）。接缝从 2 降到 1。
此后 A2 搬走 13 个导出，**业务面仍是 50** —— 搬移不改公开面，只改它住在哪个文件里。

---

## 三、A2 的门禁

| 门禁 | 结果 |
|---|---|
| `npm test` | **456 / 456 / 0 / skipped 0** |
| `verify-pure-move` | 消失 **0** 行；新增 48 = 注释 45 + 管线 3 + **逻辑 0** |
| `store.js` 导出面 | 总数 51 / **业务面 50** / 接缝 1 |
| `check-cycles` | nodes 32 / value edges 69 / **ACYCLIC** / unresolved 0 |
| `v205` 尺寸门禁 | 9/9（每步都必须重跑：新文件要登记，降回 800 的条目要删）|
| `type-budget` | OK |
| `readme-counts` | 7/7 |

---

## 四、A2 的规模预测 vs 实际

| 项 | 预测（A1 完成时） | 实际 | 差 |
|---|---|---|---|
| 生命周期闭包 | 573 行 / 22 声明 / `mutable: none` | 搬运区间 **743 行** | +170 |
| 新模块行数 | ≤ 800（门禁硬约束）| **743** ✅ | — |
| `store.ts` 搬后 | 约 307 行 | **374** | +67 |

**差 +170 的来源**：573 是**闭包的行数**（只算 22 个声明的代码），743 是**搬运区间的行数**
（L185–L451 + L524–L949：两段区间里还夹着区间的注释、空行，以及被跳过那两块
`SkillRecord` / `listSkillRecords` 之间的接缝行）。两个口径本来不等，
A1-0 那张表已经写明「闭包行数 ≠ 切除区间」。这里如实并列，不把差额解释成误差。

---

## 五、五次红、五次回滚

A2 是 A1 之后最艰难的一步，它红了五次。**每一次都停在上一绿点（`7410896`），没有任何一次连坐回滚 A1。**

| # | 红 | 根因 | 修法 |
|---|---|---|---|
| 1 | 49 条 `does not provide an export named 'applySkillFeedback'` | 只搬了代码，没补 re-export | 程序算三条并集：公开面 ∩ 被搬走 + `test/` 消费者 + `src` 其他消费者 = 13 个 |
| 2 | 60 条 `does not provide an export named 'SkillConflict'` | `SkillConflict` 是 **interface**，构建时被剥掉，却写进了值 import | 拆 `import { … }` + `import type { SkillConflict }` |
| 3 | 20 条 `ReferenceError: existsSync is not defined` | `lifecycle.ts` 的 `node:fs` import 只写了 3 个，实际用 8 个 | 逐词 `indexOf` 重数（第一次的正则因转义漏检）|
| 4 | 3 条 `cap: 显式扫描名单 == 磁盘上真实存在的 .ts 文件` | **门禁按设计工作**：新增 `lifecycle.ts` 没登记进 `SCANNED` | 登记，并在尺寸表里给出实测行数 |
| 5 | 2 条 `cap: 降回 800 以内的文件必须删除其 EXEMPT 条目` | **门禁按设计工作**：`store.ts` 降到 374 行，它的天花板过期了 | 按设计删掉 `EXEMPT` 条目与 `HISTORICAL` 里的 `store.ts` |

第 2 条是**同一个坑的第三次**：A3 的 `SkillMeta`、A1-3 的 `EnvironmentDivergence`、
A2 的 `SkillConflict`。三次表现完全一样（`npm test` 全红，指向「模块没有这个导出」，
而那个 interface 明明就在隔壁文件里导出了）。这正是 `test/v206-value-type-imports.test.mjs`
存在的理由 —— 一个被踩三次的坑不该靠记忆避免。

第 4、5 条**不是失误，是门禁在起作用**。一条从来不红的门禁，和没有门禁是同一件事。

---

## 六、复现

```bash
# 行数与声明数
node -e "const fs=require('fs');for(const f of ['src/store.ts','src/store/lifecycle.ts']){const t=fs.readFileSync(f,'utf8').split('\n');const d=t.filter(l=>/^(?:export\s+)?(?:async\s+)?(?:function|const|interface|type)\s+\w+/u.test(l)).length;console.log(f,t[t.length-1]===''?t.length-1:t.length,'行',d,'声明')}"

# 导出面（业务面 / 接缝）
node --test test/v202-store-surface-split.test.mjs
```

---

## 七、这一步没有做的事

- **不 publish**、不碰 paradise、`desktop profile` 不动。
- **D-1…D-7 挂着**：它们按裁定要等重构完成后再修。D-1 落在 `retrieve.ts` 的 `hitOf`，
  所以 `retrieve.ts` 的拆分必须在 D-1 之前完成。
- **`A2` 不是重构的终点**：`index.ts`（2361）、`retrieve.ts`（2009）、`store/skill.ts`（985）
  仍超 800 行，都在 `test/v205-module-size-cap.test.mjs` 的 `EXEMPT` 里登记为天花板。
