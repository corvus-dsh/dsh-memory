# A1 搬迁方案（`store.ts` → `store/skill.ts`）+ 交接单

> 生成：2026-11-14　基线：`dsh-memory @ 51536d5`（clean，436/436 绿）
> **本文只补方案，不搬代码。** `src/` 在本轮零改动。

---

## 一、A1 的完整名单（39 个，闭包真实成员）

`move-gate --cluster <12 名> --src store.ts` 的闭包是 **679 行 / 39 声明 / mutable: `["shapeCache (const-mutated)"]`**。

> ⚠️ **名单要订正**：文档 §十一 里写的「A1 · SKILL 读写（12 个）」是**输入名单**；
> 真正要搬的是**闭包并集 39 个成员**。两者不是一回事，下文表格逐名列出。

### 1.1 39 个成员与精确行区间（`closure --declarations` 权威 span）

| # | 成员 | 区间 | 行数 | 种类 |
|---|---|---|---|---|
| 1 | `skillPath` | L119..L121 | 3 | Function |
| 2 | `readSkillWorkspace` | L129..L131 | 3 | Function |
| 3 | `SkillValidity` | L141..L147 | 7 | Interface |
| 4 | `PROVENANCE_TIERS` | L149 | 1 | const |
| 5 | `readSkillValidity` | L151..L163 | 13 | Function |
| 6 | `frontmatter` | L181..L186 | 6 | Function |
| 7 | `SkillInput` | L190..L203 | 14 | Interface |
| 8 | `normalizeSkill` | L205..L257 | 53 | Function |
| 9 | `clampConfidence` | L261..L265 | 5 | Function |
| 10 | `PURPOSE_NOISE` | L272..L281 | 10 | const |
| 11 | `purposeTokens` | L283..L293 | 11 | Function |
| 12 | `methodSimilarity` | L339..L350 | 12 | Function |
| 13 | `SkillConflict` | L364..L367 | 4 | Interface |
| 14 | `conflictStrength` | L409..L419 | 11 | Function |
| 15 | `isConflictingSkill` | L421..L461 | 41 | Function |
| 16 | `parseSkillFile` | L464..L503 | 40 | Function |
| 17 | `listSkillFiles` | L505..L513 | 9 | Function |
| 18 | `CachedShape` | L536..L540 | 5 | Interface |
| 19 | **`shapeCache`** | **L542** | **1** | **const ← MUTABLE** |
| 20 | `invalidateSkillShape` | L545..L547 | 3 | Function |
| 21 | `shapeOf` | L567..L589 | 23 | Function |
| 22 | `findConflicts` | L591..L600 | 10 | Function |
| 23 | `parseEvidenceField` | L614..L625 | 12 | Function |
| 24 | `evidenceBodyLines` | L627..L636 | 10 | Function |
| 25 | `renderSkill` | L638..L791 | 154 | Function |
| 26 | `VERSION_TOKEN` | L802 | 1 | const |
| 27 | `ENVIRONMENT_TOKEN` | L803 | 1 | const |
| 28 | `environmentTokensOf` | L805..L813 | 9 | Function |
| 29 | `triggerTokens` | L815..L824 | 10 | Function |
| 30 | `triggerSimilarity` | L826..L833 | 8 | Function |
| 31 | `EnvironmentDivergence` | L835..L838 | 4 | Interface |
| 32 | `environmentDivergence` | L844..L852 | 9 | Function |
| 33 | `uniqueSkillName` | L855..L862 | 8 | Function |
| 34 | `writeSkill` | L865..L945 | 81 | Function |
| 35 | `commitEdges` | L956..L962 | 7 | Function |
| 36 | `linkConflictBack` | L972..L975 | 4 | Function |
| 37 | `SkillBody` | L1814..L1835 | 22 | Interface |
| 38 | `parseEvidenceList` | L1845..L1866 | 22 | Function |
| 39 | `readSkillBody` | L1868..L1899 | 32 | Function |

**声明跨度合计 679 行**（与闭包数字一致，说明闭包全在 store.ts 内、无跨文件成员）

### 1.2 搬迁区间（连续块，共 9 段）

成员在 store.ts 里分成 9 个连续块（中间夹着**不属于 A1** 的代码，不能整段切）：

```
段1  L119..L121     skillPath
段2  L129..L293     readSkillWorkspace … purposeTokens       （中间无 A1 外声明）
段3  L339..L350     methodSimilarity
段4  L364..L367     SkillConflict
段5  L409..L600     conflictStrength … findConflicts
段6  L614..L975     parseEvidenceField … linkConflictBack
段7  L1814..L1835   SkillBody
段8  L1845..L1866   parseEvidenceList
段9  L1868..L1899   readSkillBody
```

> ⚠️ **段 2 与段 5/6 内部要逐声明核对**：段落里可能夹着非 A1 的声明
> （例如 L295..L301 `sharedPurpose`、L384..L407 `rebuildConflictLinks`、L946..L955 之间、
> L964..L971 之间）。**切片必须按 39 个 span 逐个取，不能按大段切。**
> 建议沿用 A3 的方法：按 span 逐段切、每段加锚点自检（首尾行必须与预期一致才切）。

---

## 二、接缝函数归属（回答你的问题）

### 2.1 事实（实测）

| 名字 | 位置 | 在 store.js 51 条导出面？ | 消费者 |
|---|---|---|---|
| `invalidateSkillShape` | `store.ts:545` | **在** | `writeSkill` 内部 L935 / L942（A1 内） |
| `clearSkillShapeCache` | `store.ts:550` | **在** | 仅 `resetShapeCacheForTest`（L564） |
| `resetShapeCacheForTest` | `store.ts:563` | **不在**（我上一轮新加，使导出面 51 → 52） | **零消费者** |

> ⚠️ **一处必须说明的偏差**：`resetShapeCacheForTest` 是我在 `f975e33` 里加的，它把
> `store.js` 的导出面从 **51 抬到了 52**。我在那一轮的报告里没有点出这个变化，只说
> 「store.js 51 条不变」——**那句话在当时就已经不准确**（当时实际是 52）。
> 本轮已用 `git show` 逐提交核准：`1065ca1` / `2e6f6b4` / `c9b6e0e` 都是 51，
> `f975e33` 起是 52，`51536d5` 仍是 52。

### 2.2 判定：选 **(b) 随 shapeCache 一起进 skill.ts**

**理由不是「习惯上跟着走」，而是三个函数与 `shapeCache` 有物理耦合**：

```ts
// 三个函数都直接操作 shapeCache 这个绑定
invalidateSkillShape  → shapeCache.get(skillsDir)?.delete(name)
clearSkillShapeCache  → shapeCache.clear() / shapeCache.delete(skillsDir)
resetShapeCacheForTest → clearSkillShapeCache()
```

`shapeCache` 随 A1 进 `skill.ts`（它在 A1 闭包里、且 mutable）。若把这三个函数留在
`store.ts`，它们就必须访问 `skill.ts` 里的 `shapeCache` —— 那要么把 `shapeCache` 变成
**跨模块可变绑定**（比现在更糟：两个文件共享同一份可写状态，`move-gate` 的 `mutable`
判据会彻底失效），要么在 `store.ts` 里再存一份（两份缓存 = 灾难）。

**因此 (b) 是唯一不引入新缺陷的选择**：三个函数 + `shapeCache` + `CachedShape` 一起进
`skill.ts`，由 `store.ts` re-export 已公开的两个（`invalidateSkillShape`、`clearSkillShapeCache`）。

### 2.3 导出面结论

| 选项 | store.ts 动作 | store.js 导出数 |
|---|---|---|
| (a) 留 store.ts 操作 skill.ts 缓存 | 需要跨模块共享 `shapeCache` | ❌ 引入新缺陷，不可取 |
| **(b) 全部进 skill.ts** | re-export `invalidateSkillShape` / `clearSkillShapeCache`；**`resetShapeCacheForTest` 不 re-export** | **51**（回到 A3 基线） |

**判据是「谁在用它们」**：
- `invalidateSkillShape` / `clearSkillShapeCache` **本来就在 51 条导出面里**（A3 完成时已核实），必须 re-export 保住公开面；
- `resetShapeCacheForTest` **零消费者、且不在 A3 基线的 51 条里** → **不进 store.ts 的 re-export**，它只留在 `skill.ts` 内部导出，供测试直接 `import`。

这样 **A1 落地后 `store.js` 导出数 = 51**，回到 A3 基线，门禁①可以照原样写「仍 51」。

---

## 三、门禁（订正后）

### 门禁① `store.js` 导出数 = 51

**判据**：A1 落地后 `lib/store.js` 的导出名数量必须是 **51**（等于 `1065ca1` 的 A3 基线）。
`resetShapeCacheForTest` **不得**出现在 `store.js` 导出面（它只从 `skill.js` 导出）。

> 为什么必须单独数：A3 已经证明 `verify-pure-move` **看不见**导出面被撑大
> （`normaliseContentLine` 把 `export ` 剥掉、导出列表整行判为管线），
> 所以纯位移判据必须配这一条独立断言。

### 门禁②（已按你的意见改写）

**原写法（作废）**：「必须有测试真的调用 `resetShapeCacheForTest()`」
—— 问题：接缝本身就是零消费者，硬凑一个调用点只是把零消费者变成「为调用而调用」，证明不了任何事。

**改写为**：A1 落地时补一条**行为测试**：

```
1. 用 writeSkill 写入一个 skill（这会填充 shapeCache —— shapeOf 之后 cache 非空）
2. 断言：写入后读到的 shape 来自缓存（或至少 cache 非空，可通过 clearSkillShapeCache 前后行为差异观察）
3. 调 resetShapeCacheForTest()
4. 断言：清空后再读同一 skill，行为等于冷启动
   （即：与"新进程首次读"一致 —— 重新从磁盘 parse，而不是复用内存里的旧形状）
```

**这条测试有意义的理由**：它验证的是「`shapeCache` 这个 mutable 状态**可被确定性重置**」，
而不是「函数被调用过」。前者是 `move-gate` 的 STOP CONDITION 真正在意的
（搬走后共享状态还能不能控制），后者只是覆盖率数字。

### 门禁③（沿用 A3 的常规门禁）

```
npm test 全绿（当前 436，A1 落地后应 ≥ 437，新增至少 1 条 shapeCache 行为测试）
verify-pure-move：消失侧必须为 0 行；新增只允许「注释 + 管线」，逻辑 0 行
verify-bundle-purity --before HEAD：产物侧差异只允许管线行
check-cycles：ACYCLIC / unresolved 0
type-budget：strict:false 为 0（如三条 D-4/D-5 随文件改名，按 A3 的先例同步 identity）
clock-seam：2/2 pass
build 两次 SHA256 相同
```

---

## 四、搬迁后 `store.ts` 需要从 `skill.ts` import 的成员（10 个，实测）

> ⚠️ **订正口头说的「18 个」**：那是把注释里提到的名字也算进去了。剥掉注释与字符串后，
> 真实代码引用是 **10 个**。清单如下（新会话照此写 import）：

### 4.1 值（`import { … } from './store/skill.js'`）

| 成员 | store.ts 引用处（行号） | 引用数 |
|---|---|---|
| `skillPath` | 387, 1129, 1130, 1227, 1299, 1485, 1533, 1591, 1670 | 9 |
| `readSkillValidity` | 1137, 1138, 1234, 1306 | 4 |
| `purposeTokens` | 296, 297 | 2 |
| `listSkillFiles` | 386, 1590 | 2 |
| `parseSkillFile` | 390 | 1 |
| `isConflictingSkill` | 398 | 1 |
| `readSkillWorkspace` | 1312 | 1 |
| `clampConfidence` | 1540 | 1 |

> **`shapeCache` 不需要 import**：它在 L551/552 的出现是 `clearSkillShapeCache` 的函数体，
> 而 `clearSkillShapeCache` 本身也进 `skill.ts`，属于文件内引用。

### 4.2 类型（`import type { … } from './store/skill.js'`）

| 成员 | store.ts 引用处 | 引用数 |
|---|---|---|
| `SkillConflict` | 602（`conflictFooter` 参数） | 1 |

### 4.3 不需要 import 的（容易误判的）

- `invalidateSkillShape`：两处调用（L935、L942）都在 `writeSkill` 体内 → **A1 内部调用**，随函数进 skill.ts；
- `findConflicts` / `commitEdges` / `linkConflictBack` / `renderSkill` / `writeSkill` 等：都只在 A1 内部互引。

### 4.4 `skill.ts` 自身需要的 import（从既有模块，不会成环）

```ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtractedSkill, MemoryProvenance } from '../extract.js'
// 值依赖（A1 闭包外的既有模块）
import { jaccard, trigrams } from '../dedupe.js'          // methodSimilarity / triggerSimilarity 用
import { writeEdge, writeEdges } from '../edges.js'        // commitEdges 用
import { invalidateSkillDocs } from '../skill-cache.js'    // writeSkill 用
import { scanThreat } from '../threat.js'                  // writeSkill 用
import { normalizeWorkspace } from '../workspace.js'       // writeSkill 用
import { atomicWrite } from './io.js'                      // writeSkill 用
```

> ⚠️ **落地时必须逐个核实上面这份 import 清单**（本表是按引用名推断的，未逐行核对）。
> 判据：`skill.ts` **不得** import `store.ts` —— 否则 `store.ts ⇄ skill.ts` 成环。

---

## 五、`shapeCache` 迁移要点（mutable 状态）

1. `shapeCache` 是 **module-level `const new Map()`**，被 `.set` / `.delete` / `.clear` 变异
   → `move-gate` 报 `const-mutated`（本会话新增的检测项）。
2. 它随 A1 进 `skill.ts` 后，**只有模块级 `let`/`const` 的位置变了，语义不变**
   —— 与第 0 步 `lastIssuedMs` 同一处理原则：**判据是「被搬的东西的闭包里还有没有可变状态」**，
   而不是「仓库里还有没有 mutable」。
3. **不要**把它参数化 / 塞进实例 / 传 context —— 那样会改变「同进程共享缓存」的语义。
4. `CachedShape`（interface）随它一起走。

---

## 六、执行顺序（新会话照此走）

```
① 按 39 个 span 逐段切出 A1 代码 → src/store/skill.ts（每段锚点自检）
② skill.ts 顶部写 import（第四节 4.4，逐个核实）
③ store.ts 里给 10 个跨文件引用补 import（第四节 4.1 / 4.2）
④ store.ts 加 re-export：
     export { invalidateSkillShape, clearSkillShapeCache } from './store/skill.js'
     export type { SkillConflict, SkillValid …, } from './store/skill.js'   ← 只补原本公开的类型
   ⚠️ resetShapeCacheForTest 不 re-export
⑤ 删除 store.ts 里已搬走的 39 个声明（按 span 自下而上删，避免行号漂移）
⑥ npm run build && npm test
⑦ 门禁①：node -e 数 store.js 导出 === 51
⑧ 门禁②：补 shapeCache 行为测试（第三节）
⑨ verify-pure-move：消失侧必须 0 行
⑩ 全套门禁 + 提交
```

---

## 七、交接单

### 7.1 已完成（5 步，全部已推送、CI 双 Node 全绿）

| # | 步骤 | sha | 验收数字 |
|---|---|---|---|
| 0 | 时钟三件套 → `store/clock.ts` | `14c1d59` | 时钟簇 9/3 / `[lastIssuedMs]`；`appendLayer` 225/9/`[lastIssuedMs]` → 219/7/`none`；434/434 |
| B | IO 原语 → `store/io.ts` | `b269fbd` | 80/8/`none`；导出面 51→51；A1/A3/A2 闭包 −73/−76/−80；434/434 |
| B-1 | 两处私有 `readJsonl` → `readJsonlLocal` | `b1e5d83` | 5 行改名；434/434 |
| — | `sleepSync` → `sleepSyncLocal`（store.ts 那份） | `662a9c7` | 2 处；434/434 |
| A3 | JSONL 层写入 → `store/layer.ts` | `1065ca1` | 396/16/`none`；导出面 51→51；消失侧 0 行；pure-move +56 = 46 注释 + 10 管线 + **0 逻辑**；434/434 |
| — | `VOCAB_TAG` 方案甲（layer 内部共享） | `2e6f6b4` | layer.js 8→9、store.js 51→51 |
| — | const-mutate 检测 + `resetShapeCacheForTest` | `f975e33` | can-red `["cache (const-mutated)"]`；**store.js 51→52**（偏差，见 2.1） |
| — | `mutableLabel` 抽取 + 两路径一致性测试 | `51536d5` | 436/436（新增 2）；can-red 已验证 |

> **额外记录**：`GRAFT_MOVE_GATE_SRC` vs `GRAFT_CLOSURE_SRC` 陷阱已写入
> `docs/memory-known-defects.md` §〇·一「常驻警戒」（`c9b6e0e`）。

### 7.2 A2 挂起

```
A2 lifecycle：闭包 755 行 / 37 声明 / mutable: none
（搬 B 前 848，搬 B 后 768，A3 后重测 755）
状态：不动。规模已过 800 门槛，但仍等 A1 分完共用 helper 后重测。
禁令：不许为了「降到 800」而提前拆。
```

### 7.3 D-1…D-7 挂起

```
D-1  retrieve.ts hitOf/MemoryHit —— 未完成功能（降权生效、文案不生效）；修测试再修代码
D-2  extract.ts ExtractedExperience  —— 类型欠账
D-3  extract.ts LlmLike.stream       —— 类型欠账（reasoningEffort 取值集合未验证）
D-4  store.ts LayerRecord            —— 类型欠账（A3 后随文件改名到 store/layer.ts）
D-5  dedupe.ts NegativeRecord        —— 类型欠账
D-6  store.ts:2215                   —— 纯结构可赋值性
D-7  index.ts:21,65                  —— 合并遗留
（附）类型环 → types.ts               —— 只评估，不实施
（附）ledger-cache.ts:472 2339        —— 环境产物，不修
全部等 store.ts 重构完成后再修：先修再搬会让 verify-pure-move 的参照失效。
```

### 7.4 三仓状态（2026-11-14 实测）

| 仓 | sha | dirty | 同步 | 测试 |
|---|---|---|---|---|
| `dsh-memory` | `51536d5` | 0 | 与 origin/main 同步 | **436 / 436 / 0** |
| `dsh-observer` | `2c80e2c` | 0 | 与 origin/main 同步 | — |
| `dsh-graft-slice` | `fae3ee5` | 0 | 与 origin/main 同步 | — |

**未验证项（随交接走）**：
- B-2（三份 `readJsonl` 语义一致性）未做；
- `VOCAB_TAG` 在 `extract.ts:397` 与 `store/layer.ts:83` 仍是两份逐字相同副本，未合并；
- `verify-bundle-purity` 的递归修复只在 memory 做过；**observer 无 `lib/` 子目录（产物是扁平 `index.js`），该修复不适用**；
- A1 的 `skill.ts` import 清单（4.4）尚未逐行核实。

### 7.5 禁令（逐条）

1. **`beta.1` 不 publish** —— 已在 registry 上，硬阻塞；**绝不 force push、绝不试图覆盖 npm 历史版本**。
2. **不碰 `desktop` profile**（本任务全程不涉及，保持不动）。
3. **不碰 `dsh-paradise`**。
4. **A2 不动**（除非用户明确指示）。
5. **D-1…D-7 继续挂起**，重构完成前不修。
6. **禁止用 `user/message` 的壳装 `developer` 指令**（role 与语义必须一致）。
7. `harvest` 若改为走 session event 通道，必须遵守上一条（`role:'user'` + `[系统提示]` 前缀）。
8. `validAt` / `reasoningEffort` 保持标注，不补测。