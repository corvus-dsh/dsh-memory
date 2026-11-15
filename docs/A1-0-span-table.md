# A1-0　39 成员权威 span 表（机器生成）

> 生成：2026-11-15　基线：`dsh-memory @ 485a014`（clean，439/439 绿）
> 来源：`closure.mjs --declarations` 的编译器 span（不自己解析正则）
> 本文件**只生成表，不搬代码**。`src/` 零改动。

---

## 〇、一句话结论

**39 个 A1 成员 + 2 个必须随走的接缝 = 41 个声明，落在 7 个连续段里，
每段区间内除了要搬的声明之外没有任何「要留下的」声明 → 全部可整段切。**

---

## 一、39 成员逐名 span（按 store.ts 文件顺序）

「含注释起」是向上吸收紧邻 JSDoc/行注释后的起始行 —— 搬运时注释必须一起走。

| # | 成员 | 种类 | 含注释起 | 声明区间 | 行数 | mutable |
|---|---|---|---|---|---|---|
| 1 | `skillPath` | Function | L119 | L119..L121 | 3 | 否 |
| 2 | `readSkillWorkspace` | Function | L123 | L129..L131 | 3 | 否 |
| 3 | `SkillValidity` | Interface | L133 | L141..L147 | 7 | 否 |
| 4 | `PROVENANCE_TIERS` | const | L149 | L149..L149 | 1 | 否 |
| 5 | `readSkillValidity` | Function | L151 | L151..L163 | 13 | 否 |
| 6 | `frontmatter` | Function | L181 | L181..L186 | 6 | 否 |
| 7 | `SkillInput` | Interface | L189 | L190..L203 | 14 | 否 |
| 8 | `normalizeSkill` | Function | L205 | L205..L257 | 53 | 否 |
| 9 | `clampConfidence` | Function | L260 | L261..L265 | 5 | 否 |
| 10 | `PURPOSE_NOISE` | const | L267 | L272..L281 | 10 | 否 |
| 11 | `purposeTokens` | Function | L283 | L283..L293 | 11 | 否 |
| 12 | `methodSimilarity` | Function | L303 | L339..L350 | 12 | 否 |
| 13 | `SkillConflict` | Interface | L352 | L364..L367 | 4 | 否 |
| 14 | `conflictStrength` | Function | L409 | L409..L419 | 11 | 否 |
| 15 | `isConflictingSkill` | Function | L421 | L421..L461 | 41 | 否 |
| 16 | `parseSkillFile` | Function | L463 | L464..L503 | 40 | 否 |
| 17 | `listSkillFiles` | Function | L505 | L505..L513 | 9 | 否 |
| 18 | `CachedShape` | Interface | L515 | L536..L540 | 5 | 否 |
| 19 | **`shapeCache`** | const | L542 | L542..L542 | 1 | **是（const-mutated）** |
| 20 | `invalidateSkillShape` | Function | L544 | L545..L547 | 3 | 否 |
| 21 | `shapeOf` | Function | L567 | L567..L589 | 23 | 否 |
| 22 | `findConflicts` | Function | L591 | L591..L600 | 10 | 否 |
| 23 | `parseEvidenceField` | Function | L614 | L614..L625 | 12 | 否 |
| 24 | `evidenceBodyLines` | Function | L627 | L627..L636 | 10 | 否 |
| 25 | `renderSkill` | Function | L638 | L638..L791 | 154 | 否 |
| 26 | `VERSION_TOKEN` | const | L793 | L802..L802 | 1 | 否 |
| 27 | `ENVIRONMENT_TOKEN` | const | L803 | L803..L803 | 1 | 否 |
| 28 | `environmentTokensOf` | Function | L805 | L805..L813 | 9 | 否 |
| 29 | `triggerTokens` | Function | L815 | L815..L824 | 10 | 否 |
| 30 | `triggerSimilarity` | Function | L826 | L826..L833 | 8 | 否 |
| 31 | `EnvironmentDivergence` | Interface | L835 | L835..L838 | 4 | 否 |
| 32 | `environmentDivergence` | Function | L840 | L844..L852 | 9 | 否 |
| 33 | `uniqueSkillName` | Function | L854 | L855..L862 | 8 | 否 |
| 34 | `writeSkill` | Function | L864 | L865..L945 | 81 | 否 |
| 35 | `commitEdges` | Function | L947 | L956..L962 | 7 | 否 |
| 36 | `linkConflictBack` | Function | L964 | L972..L975 | 4 | 否 |
| 37 | `SkillBody` | Interface | L1794 | L1814..L1835 | 22 | 否 |
| 38 | `parseEvidenceList` | Function | L1837 | L1845..L1866 | 22 | 否 |
| 39 | `readSkillBody` | Function | L1868 | L1868..L1899 | 32 | 否 |

**声明跨度合计 679 行。**

---

## 二、必须随 A1 走的段外声明（2 个接缝）

判据（**不动点迭代至收敛**）：段外声明若直接引用 `shapeCache` 簇
（`shapeCache` / `CachedShape` / `invalidateSkillShape` / `clearSkillShapeCache` /
`resetShapeCacheForTest` / `shapeOf`），必须一起走 ——
否则 `store.ts` 要跨模块访问 A1 的 module-level mutable 状态。

| 声明 | 含注释起 | 声明区间 | 为什么必须走 |
|---|---|---|---|
| `clearSkillShapeCache` | L549 | L550..L553 | 直接 `.clear()` / `.delete()` `shapeCache` |
| `resetShapeCacheForTest` | L555 | L563..L565 | 调用 `clearSkillShapeCache()`（间接依赖） |

> ⚠️ **这一条是复核时才补上的**：第一版判据只查 `shapeCache` 字面出现，
> 漏了 `resetShapeCacheForTest`（它正文里没有 `shapeCache`，只有 `clearSkillShapeCache`）。
> 改成不动点迭代后才发现。**如果按第一版切，`resetShapeCacheForTest` 会留在
> store.ts 里调用一个已经搬走的函数 —— 编译期就红。**

---

## 三、连续段划分（按最终 41 个声明重算）

相邻声明之间若没有「要留下的」声明，即同段。

| 段 | 起(含注释) | 止 | 跨度行 | 成员数 | 成员 |
|---|---|---|---|---|---|
| **段1** | L119 | L163 | 45 | 5 | `skillPath` `readSkillWorkspace` `SkillValidity` `PROVENANCE_TIERS` `readSkillValidity` |
| **段2** | L181 | L293 | 113 | 6 | `frontmatter` `SkillInput` `normalizeSkill` `clampConfidence` `PURPOSE_NOISE` `purposeTokens` |
| **段3** | L303 | L367 | 65 | 2 | `methodSimilarity` `SkillConflict` |
| **段4** | L409 | L600 | 192 | 11 | `conflictStrength` `isConflictingSkill` `parseSkillFile` `listSkillFiles` `CachedShape` **`shapeCache`** `invalidateSkillShape` `clearSkillShapeCache` `resetShapeCacheForTest` `shapeOf` `findConflicts` |
| **段5** | L614 | L975 | 362 | 14 | `parseEvidenceField` `evidenceBodyLines` `renderSkill` `VERSION_TOKEN` `ENVIRONMENT_TOKEN` `environmentTokensOf` `triggerTokens` `triggerSimilarity` `EnvironmentDivergence` `environmentDivergence` `uniqueSkillName` `writeSkill` `commitEdges` `linkConflictBack` |
| **段6** | L1794 | L1899 | 106 | 3 | `SkillBody` `parseEvidenceList` `readSkillBody` |

**合计 6 段 / 41 个声明 / 883 行（含注释与段内空行）。**

---

## 四、段内非 A1 声明清单：**全部为空**

| 段 | 区间内顶层声明数 | 其中要搬 | **混入（要留下的）** |
|---|---|---|---|
| 段1 | 5 | 5 | **0** |
| 段2 | 6 | 6 | **0** |
| 段3 | 2 | 2 | **0** |
| 段4 | 11 | 11 | **0** |
| 段5 | 14 | 14 | **0** |
| 段6 | 3 | 3 | **0** |

**没有跨边界声明**（没有任何声明「起点在段内、终点在段外」）。
→ **6 段全部可整段切**，不需要逐成员切。

---

## 五、段间空隙里剩下的是什么（这些留给 store.ts）

| 空隙 | 区间 | 留给 store.ts 的顶层声明 |
|---|---|---|
| 首段之前 | L1..L118 | `defaultSkillsDir`(L103) |
| 段1→段2 | L164..L180 | `isValidAt`(L166)、`parseInstant`(L175) |
| 段2→段3 | L294..L302 | `sharedPurpose`(L295) |
| 段3→段4 | L368..L408 | `rebuildConflictLinks`(L384) |
| 段5→段6 | L976..L1793 | 31 个（A2 生命周期 / 审计 / processed / stats 全部） |

> 段4→段5 的空隙已经消失：`clearSkillShapeCache` 与 `resetShapeCacheForTest`
> 被并入段4，所以段4 从 L409 一直连续到 L600。

---

## 六、规模

| 项 | 值 |
|---|---|
| `store.ts` 现有顶层声明 | 78 个 |
| 搬走 | **41 个**（39 A1 + 2 接缝） |
| 剩余 | 37 个 |
| 按段整切移走 | 约 **883 行**（含注释与段内空行） |
| `store.ts` 行数 | 1899 → 约 **1016** |
| 声明跨度合计 | 686 行 |

---

## 七、搬运后 `store.ts` 需要从 `skill.ts` import 的成员（10 个，实测）

剥掉注释与字符串后重新统计（口头说的「18 个」含注释误报）：

| 成员 | store.ts 引用行 | 次数 | 类型 |
|---|---|---|---|
| `skillPath` | 387, 1129, 1130, 1227, 1299, 1485, 1533, 1591, 1670 | 9 | 值 |
| `readSkillValidity` | 1137, 1138, 1234, 1306 | 4 | 值 |
| `purposeTokens` | 296, 297 | 2 | 值 |
| `listSkillFiles` | 386, 1590 | 2 | 值 |
| `parseSkillFile` | 390 | 1 | 值 |
| `isConflictingSkill` | 398 | 1 | 值 |
| `readSkillWorkspace` | 1312 | 1 | 值 |
| `clampConfidence` | 1540 | 1 | 值 |
| `SkillConflict` | 602 | 1 | **类型**（`import type`） |

> `shapeCache` **不需要 import**：它在 L551/552 的出现是 `clearSkillShapeCache` 的函数体，
> 而该函数本身也进 `skill.ts`，属文件内引用。
> `invalidateSkillShape` 的两处调用（L935、L942）都在 `writeSkill` 体内，同属 A1 内部。

---

## 八、A1-1 → A1-6 分步定义（待确认后执行）

每步都**自带完整接线**（新增 skill.ts 代码 + 删除 store.ts 对应段 + 补 import/re-export），
因此每步结束时都能编译、`npm test` 全绿、可单独提交。

| 步 | 搬什么 | 段 | 声明数 | 关键点 |
|---|---|---|---|---|
| **A1-1** | 基线骨架 + 段1+2+3 | L119-163 / L181-293 / L303-367 | 13 | 建立 `store/skill.ts`；无 mutable、无 shapeCache；验证接线模式 |
| **A1-2** | **shapeCache 簇**（段4） | L409-600 | 11 | **用户指定的 shapeCache 步**；须额外贴 `move-gate --src store/skill.ts` 的 mutable 读数（应为 `["shapeCache (const-mutated)"]`，刻意保留） |
| **A1-3** | 段5 前半 | L614-852 | 9 | renderSkill（154 行）在此 |
| **A1-4** | 段5 后半 | L840-975 | 5 | writeSkill（81 行）+ 冲突边 |
| **A1-5** | 段6 | L1794-1899 | 3 | readSkillBody 链 |
| **A1-6** | 门禁收尾 | — | 0 | shapeCache 行为测试（门禁②）+ `v202` 的 `REGISTERED_SEAMS` 同步（接缝回到 N=1）+ 全套门禁 |

**每步必须贴四项**：`npm test` 数 / `verify-pure-move` 三分类 / `store.js` 业务面 50 + 接缝 N / `check-cycles`。

**红线**：任何一步红，就停在上一绿点，不连坐回滚已绿的步骤。

---

## 九、复核过程中修掉的两处自身错误

1. **判据漏判**：第一版「必须随走」判据只查 `shapeCache` 字面，漏了
   `resetShapeCacheForTest`（正文只有 `clearSkillShapeCache`）→ 改不动点迭代。
2. **结论硬编码**：段数结论里写死了「全部 7 段」，而实际重算后是 6 段
   （段4 与段5 因接缝并入而合并）。已改为 `${segments.length}`，与表格同源。

> 两处都是「表格对、结论不对」的形状 —— 交付前必须让结论从同一份数据算出来，
> 不能手写。