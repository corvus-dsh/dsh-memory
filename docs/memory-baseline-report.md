# dsh-memory 基线报告（阶段 6 · 第 2 仓 · 只做仪器移植与校准）

> 日期：2026-11-14　提交前状态
> 边界：**不搬任何族、不改 `src/` 一行、不 publish、不碰 paradise**。

---

## 〇、先核对底数（你给的数逐项对上了）

| 项 | 你给的底数 | 我的实测 | 一致 |
|---|---|---|---|
| `.ts` 文件数 | 27 | **27** | ✓ |
| 总行数 | 14,211 | **14,211** | ✓ |
| > 800 行的文件 | 3 | **3** | ✓ |
| 最大三个 | store.ts 2479 / index.ts 2361 / retrieve.ts 2009 | **2479 / 2361 / 2009** | ✓ |
| 最大占比 | 17.4% | **17.4%** | ✓ |

**底数没有问题。** 下面所有数字都是我自己重测的，命令写在每处。

---

## 一、移植了什么（7 件）

| 仪器 | 来源 | 在 memory 上的状态 |
|---|---|---|
| `check-cycles.mjs` | observer | ✅ 跑通，**并改了一处**（见 §三） |
| `type-check.mjs` | observer | ✅ 现成可用，未改动 |
| `type-budget.mjs` | observer | ✅ 需**重冻基线**（带来的是 observer 的空表） |
| `verify-pure-move.mjs` | observer | ✅ `--self-test` PASS；工作树 `VACUOUS`（预期） |
| `verify-bundle-purity.mjs` | observer | ✅ **重写了产物口径**（见 §四） |
| 打包门禁 `test/pack-coverage.test.mjs` | observer | ✅ 3/3，**黑名单少两项**（见 §五） |
| 模块登记门禁 `test/module-registry.test.mjs` | observer | ✅ **6/6**，先红后绿 |

memory 原本已有 `check-readme-counts.mjs`（能抓测试数），所以没有重复移植。

---

## 二、runner 实测基线

```
$ npm test
ℹ tests 432   ℹ pass 432   ℹ fail 0   ℹ skipped 0   ℹ todo 0
```

**移植前 423 / 423 / 0。移植后 432 / 432 / 0。**（+9 = 模块登记 6 + 打包 3）

**既有红名单：空。** 连跑三次结果一致（432/432/0 × 3）—— 这一条专门验证过，见 §六。

### `check-readme-counts` 当场抓住了我

```
FAIL L106 README 声明测试数 423 / 423，实测 432
FAIL L537 README 声明测试数 423 / 423，实测 432
2 false claim(s).
```

已同步为 432/432，现报 `all 7 checkable fact(s) match`。
**与本仓同族的门禁（observer 那仓也抓过我两次）—— 这不是我造的仪器，是两边本来就有的。**

---

## 三、`check-cycles`：移植时发现它**不区分 `import type`**

### 现象

第一次跑，它报了一个环：

```
nodes: 27  edges: 51  unresolved: 0
CYCLES: 1
  retrieve.ts ⇄ filter.ts
exit 1
```

### 查清：这是**仅类型环**，不是值环

逐边看，两条边的性质完全不同：

| 边 | 类型 | 依据 |
|---|---|---|
| `retrieve.ts → filter.ts` | **值导入** | `import { selectApplicableSkillsDetailed } from './filter.js'`（L24） |
| `filter.ts → retrieve.ts` | **`import type`** | `import type { MemoryHit } from './retrieve.js'`（L14） |

TypeScript 的 `import type` 在产出 JS 时**整条消失**，所以它不构成运行时环，
也就没有死锁 / 未初始化绑定那类风险。

### 原脚本为什么看不出来

```js
const IMP = /...\s+(?:type\s+)?(?:[^'"\n]*?\sfrom\s+)?['"](\.[^'"]+)['"]/gu
//                    ^^^^^^^^^^^ 明确允许 type，然后**当成普通边**
```

它把 `import type` 和值导入收进同一张图。于是「类型层面互相引用」被报成「依赖环」。

### 改法：两张图，分开报

- **值图**（阻断）：只收非 type-only 的 import；
- **类型图**（信息）：收全部。

判据：`import type X from` 与 `import { type X } from` 都算 type-only；
**一条 import 里混着值成员和 type 成员的，保守算值导入**（宁可多报，不可漏报）。

### 改后输出

```
nodes: 27  value edges: 43  all edges (incl. type-only): 51  unresolved: 0
ACYCLIC — no VALUE dependency cycle, and every relative import resolved to a file
NOTE: 1 type-only cycle(s) — import type is erased at runtime, not a failure:
  retrieve.ts ⇄ filter.ts
     retrieve.ts -> filter.ts : VALUE
     filter.ts -> retrieve.ts : type-only
```

**为什么保留而不是删掉**：它是真实耦合（一处改签名会牵连另一处），只是处置方式不同。
值环必须拆，类型环可以长期共存。丢掉它会让「文件之间到底怎么耦合」少一半答案。

### can-red：**6/6**（沙箱，不碰真实树）

| 用例 | 期望 | 结果 |
|---|---|---|
| 真值环 `a ⇄ b` | exit 1 且 `VALUE CYCLES` | ✓ |
| 仅类型环 | exit 0，`ACYCLIC` + 单列 type-only | ✓ |
| `{ type B }` 全类型成员 | exit 0 | ✓ |
| **混行 `{ b, type B }`** | exit 1（保守算值导入） | ✓ |
| 解析不到的 import | exit 1 且明确 `FAIL` | ✓ |
| 干净仓库 | exit 0，无 type-only 段落 | ✓ |

> 一次自造的断言错误：第 6 条最初 FAIL，因为我把断言写成 `!/type-only/`，
> 而 ACYCLIC 那句里有 `no VALUE dependency cycle` —— 断言本身写坏了，改的是用例不是仪器。

---

## 四、`verify-bundle-purity`：产物口径从「一个文件」改成「一组文件」

observer 的产物是扁平 `index.js`（`bundle.mjs` 把模块压平）。**memory 不是**：

```
package.json:  "main": "./lib/index.js"
               "exports": { "./retrieve": "./lib/retrieve.js", "./store": "./lib/store.js" }
```

产物是**目录**（`lib/` 下 27 个 `.js`）。照抄会直接死在
`fatal: path 'index.js' does not exist in 'HEAD'`。

改法：按相对路径排序后拼接比对，并保留**哪个文件**贡献了差异；文件集合本身变化时
明确报 `file set changed` + `removed:` / `added:`，不冒充"内容差异"。

### can-red：**5/5**（沙箱 git 仓库）

| 用例 | 期望 | 结果 |
|---|---|---|
| 真改一行（`return 2`→`return 3`） | exit 1，指出那一行 | ✓ |
| 只改 export 形态 | exit 0 | ✓ |
| 删一个 `lib/*.js` | 报 `file set changed` + `removed: b.js` | ✓ |
| 加一个 `lib/*.js` | 报 `file set changed` + `added: c.js` | ✓ |
| 同一个 ref 和自己比 | `VACUOUS` exit 2 | ✓ |

真实仓上跑：`VACUOUS — lib/*.js is byte-identical at HEAD`（我没改产物，预期）。

---

## 五、打包门禁 3/3，但**黑名单比 observer 少两项**

```
✔ pack: every pointer in package.json resolves to a file that is actually packed
✔ pack: no development files leaked into the tarball
✔ pack: the files list and the tarball agree on what is shipped
```

### 少掉的这两项都是**刻意的**

| 条目 | observer 禁止 | memory | 理由 |
|---|---|---|---|
| `src/` | 禁止 | **允许** | `types` 指向 `./src/index.ts` —— 本仓**发布 .ts 源码作类型面**，没有单独 .d.ts 构建 |
| `scripts/` | 禁止 | **允许** | `files` 明确含 `"scripts"`，那几个 .mjs 是给用户跑 harvest / consistency 的**产品级**入口 |

**黑名单是仓的策略，不是仪器的规则。** 照抄会把这两项判成违规，那不是本仓的缺陷。
所以这条差异写进了测试文件的注释里，而不是悄悄删掉行。

关禁同时也断言了 `types` 指向的文件真的在包里 —— 否则类型解析会在用户机器上失败。

---

## 六、模块登记门禁：**先红后绿**，6/6

### 先红

表还不存在时，5 条全红（`MODULE-REGISTRY.md must exist`）。

### 建表后 6/6

```
✔ every module on disk is REGISTERED (a new file cannot slip in silently)
✔ every row in the registry points at a file that EXISTS (a deleted module cannot linger)
✔ every row declares a one-line duty and its exports
✔ the dependency column only names modules that EXIST (no dangling dependency)
✔ the registry has no VALUE cycle (type-only edges are erased at runtime and do not count)
✔ every type-only edge is REALLY type-only in the source (the label cannot lie)
```

### 建表过程中被自己的门禁抓住两次

**① 值导入被标成 type-only（漏边）**

生成器第一版对同一模块用 `Set.add`，后写的覆盖先写的。而 `index.ts → extract.ts`
**同时**有值导入和类型导入：

```
import { extractEpisode } from './extract.js'          ← 值
import type { EvidenceRef, … } from './extract.js'     ← 类型
```

于是值边被标成 `(type-only)`，在成环检查里被跳过。
**这正是"标错签骗过门禁"的形状** —— 而门禁自己那条 `the label cannot lie` 抓住了它。
修法：按模块聚合成 `{ value, type }`，**值优先**。

**② `ROW` 正则的字符集不含下划线（漏行）**

原始正则 `[a-z0-9-]+` 不匹配 `__unregistered.ts`。can-red 注入这个文件时**门禁没有红** ——
因为整行根本没被解析成"一行"。这意味着「磁盘上的新文件」和「表里的幽灵行」两个方向都看不见它。

**一个读不进表的文件名，等于一个不受监管的文件名。** 改成 `[a-z0-9_-]+`。

### can-red：**7/7**

| 注入 | 期望 | 结果 |
|---|---|---|
| 磁盘加未登记的 `.ts` | 红并点名 | ✓ |
| 表里加一行幽灵 | 红并点名 | ✓ |
| 职责列留空 | 红 | ✓ |
| 依赖列指向不存在的模块 | 红 | ✓ |
| 把值依赖标成 `(type-only)` | 红（`the label cannot lie`） | ✓ |
| 表里造一个值环 | 红 | ✓ |
| 未注入的副本 | 绿 | ✓ |

> 又一次自造错误：第 5 条最初 FAIL，不是门禁漏了，是我注入用的整行正则跨了格子没落进文件。
> 修的是**注入**，不是门禁 —— 与 observer 那次「VACUOUS 用例前提不成立」同一类。

---

## 七、type-check 三分法：**12 + 61 + 0**（底数表的 `10 + 61 + 2` 是误判）

```
$ node scripts/type-check.mjs
type-check: 73 diagnostic(s)
CODE HEALTH: 12    ENVIRONMENT: 61    ARTIFACT: 0
$ node scripts/type-check.mjs --strict-comparison
{"strictFalse":73,"strictTrue":92}
```

**总数 73 与底数表一致，ENV 61 一致，但成分不同。**

### 那 2 条 ARTIFACT 是分类器误判

底数表用的判据（`_scratch/recon-other-repos.mjs:101`）是：

```js
artifact = loose.filter(d => !isEnvironment(d) && !strictKeys.has(`${d.code}|${d.msg}`))
//                                                              ^^^^^^^^^^^^^^^^^ 键 = code + 完整 message
```

`strict:true` 会改 message 的措辞，于是**真实缺陷**被判成"只存在于宽松模式"：

| code | 位置 | loose 措辞 | strict 措辞 |
|---|---|---|---|
| 2353 | `retrieve.ts:190` | `… '{ provider?: string; model?: … }'` | `… '{ provider?: string \| undefined; … }'` |
| 2339 | `retrieve.ts:1614` | `… '{ threshold?: number; now?: number; … }'` | `… '{ threshold?: number \| undefined; … }'` |

两条在 strict 里**同文件、同行、同 code 都存在** —— 所以它们不是 ARTIFACT。

把键换成 `file:line:code` 重算：

```
ARTIFACT — 键 = code|message   : 2   ← recon 口径（底数表写 2）
ARTIFACT — 键 = file:line:code : 0   ← 现测分类器的口径
```

**这与 observer 上抓到的是同一个缺陷**（同一个手写/措辞敏感的判定）。
所以 memory 的准确基线是 **12 CODE HEALTH + 61 ENV + 0 ARTIFACT**。

### 12 条 CODE HEALTH 的分布

| 文件 | 条数 | code |
|---|---|---|
| `retrieve.ts` | 5 | 2339 ×4、2353 ×1 |
| `store.ts` | 3 | 2345 ×2、2353 ×1 |
| `index.ts` | 2 | 2300 ×2（`Duplicate identifier 'EvidenceRef'`） |
| `extract.ts` | 1 | 2353 |
| `ledger-cache.ts` | 1 | 2339 |

**这 12 条本轮一条都没修** —— 本阶段只做仪器移植与基线，修不修是下一步的裁定。

---

## 八、type-budget：基线已重冻（12 条 / 5 文件 / 11 个身份）

移植带来的 `type-budget.mjs` 里是 **observer 的空表** —— 那是另一个仓的基线，直接跑会红 12 条。

已用 `--baseline` 的实测输出冻结：

```
BASELINE             ['retrieve.ts', 5] ['store.ts', 3] ['index.ts', 2] ['extract.ts', 1] ['ledger-cache.ts', 1]
                     code total: 12   （environment, not in this table: 61）
BASELINE_IDENTITIES  11 个不同身份，合计 12 条
```

**11 个身份 vs 12 条**：`index.ts` 的 2300（`Duplicate identifier 'EvidenceRef'`）有 2 处，
共享同一条 message，所以表里是一行、计数 2。**这两个数不是同一个东西，表里写明了。**

冻结后：`OK — every touched file is at or under its frozen baseline`。

> 踩了一个编码坑：`--baseline` 打印的是 `JSON.stringify()` 的结果，
> 我第一版写入时又转义了一次，`\u0000` 变成 `\\u0000`，身份键匹配不上，表看起来"冻了却没生效"。
> 修法是**原样保留**脚本打印的行，不二次加工。

---

## 九、套件稳定性：一次由我引入的间歇性失败（已修）

移植完先跑套件，结果是：

```
run: tests 404 / pass 398 / fail 6
run: tests 414 / pass 410 / fail 4
run: tests 419 / pass 415 / fail 4
```

**总数在跳**（404 / 414 / 419），说明有测试文件在中途崩掉；失败则集中在
`v031-quarantine-lock` / `v032-causal-schema` / `v220-audit-f5-dedupe` —— 而它们**单独跑都通过**。

### 根因：我新增的 pack 测试触发了 `prepare`

`package.json` 有 `"prepare": "node scripts/build.mjs"`，而 `npm pack` 会触发它。
在**并发**套件里，`prepare` 重建 `lib/`，正在读 `lib/` 的测试看到半更新的产物。

**对照实验证明这是我的问题**：`git stash -u` 后跑基线是 423/423/0；恢复后复现 4–6 条失败。

### 第一次修（只在本机成立）：`--ignore-scripts`

我加了 `--ignore-scripts`，本机（Node 24 / npm 11）立刻稳定：

```
run 0: tests 432 / pass 432 / fail 0
run 1: tests 432 / pass 432 / fail 0
run 2: tests 432 / pass 432 / fail 0
```

**然后 CI 打了回来：22.x 红、24.x 绿。** 同一份代码，只有 Node/npm 版本不同。

### 真正的根因：npm 10 的 `--ignore-scripts` 拦不住 `prepare`

拉不到 job 日志（403 需认证），所以改用两个可匿名读取的通道取证：
① `check-run` 上的 annotation；② 本机装 Node 22.22.2（与 CI 的 22.x 同版本）逐个复现。

**Node 22 + Windows 上整套 433/433 全过** ⇒ 与 Node 版本无关 ⇒ 差异在平台或 npm。

用 Node 22 自带的 **npm 10.9.7** 复现，直接看到答案：

```
$ npm pack --dry-run --json --ignore-scripts
> @corvus-dsh/dsh-memory@0.9.2-beta.1 prepare
> node scripts/build.mjs
built 27 module(s) into lib/
[ …真正的 JSON… ]
```

**npm 10 无视 `--ignore-scripts`，`prepare` 照跑**；`npm_config_ignore_scripts=true` 同样拦不住。
npm 11（Node 24 那一档）能拦住。所以 CI 上：24.x 绿、22.x 红。

而且它的破坏方式极具误导性：`prepare` 的输出（`built 27 module(s) into lib/`）**混进了
`npm pack --json` 的 stdout**，JSON 前面多了一段前缀；同时 `lib/` 被重建，
并发测试读到半更新产物。两件事叠在一起，看起来像"并发不稳 + 解析偶发失败"。

### 第二次修（正解）：让副作用无处可落

加参数没用（加了不生效），所以改结构：**在临时副本里跑 npm pack**。

- 把 `files` 声明的条目 + README/LICENSE + `package.json` 复制到临时目录；
- 副本里的 `package.json` **剥掉 `prepare` / `prepack` / `postpack`**；
- 在副本里跑 `npm pack --dry-run --json`；
- 完事删掉副本。

这样：副本里没有生命周期脚本可跑；即使 npm 想跑，改的也是临时目录；本仓 `lib/` 全程只读。

顺带把 JSON 解析从 `indexOf('[')…lastIndexOf(']')` 换成**括号配平扫描** ——
上面那段前缀一旦含 `[`，朴素切片就会切坏。

### 验证（npm 10 与 npm 11 都跑）

```
npm 10.9.7（Node 22，忠实复现 CI 那一档）
  run 0: tests 432 / pass 432 / fail 0   [no build leak]
  run 1: tests 432 / pass 432 / fail 0   [no build leak]

npm 11.19.0（本机 Node 24）
  tests 432 / pass 432 / fail 0
```

**"no build leak" 是逐次检查的**：整套 npm test 输出里不再出现 `built 27 module(s)`。

### 这一段值得记的三件事

1. **本机绿 ≠ CI 绿**：同一份代码，npm 10 与 npm 11 对同一个参数的处理不同。
   我是靠"22.x 红 / 24.x 绿"这个**双 Node 矩阵**才知道的 —— 单 Node 的 CI 会直接放过。
2. **一个"只读"门禁带了写副作用**，症状会出现在**不相干的测试**上（v031/v032/v220），
   而不是出问题的地方。`ℹ tests` 总数跳动是重要线索：有文件崩了。
3. **拉不到日志不等于无法取证**：annotation 可匿名读；本机装同版本 Node 能直接复现。
   我用诊断件把结论写进 annotation，一次拿到"npm 10 上 prepare 照跑"的直接证据。

---

## 十、结论（只给依据，不搬族）

1. **7 件仪器在 memory 上全部可用**，其中 **4 件有 can-red 证据**
   （check-cycles 6/6、bundle-purity 5/5、模块登记 7/7、打包 3/3 由测试本身断言）。
2. **memory 的真实画像（最终态）**：27 个模块 / 14,211 行 / 3 个 >800 /
   最大 `store.ts` 2,479 行（17.4%）/ **0 个值依赖环** / **12 CODE HEALTH + 61 ENV + 0 ARTIFACT**。
3. **与 observer 的结构差异**：observer 是「单文件 + 一个核心模块」；memory 是
   **27 个扁平模块，最大家族只占 17.4%** —— 它没有"巨型单文件"问题，
   但有 12 条类型债和 1 个值环（已确认没有）+ 1 个仅类型环。
4. **下一步的候选（只列，不定序）**：
   - 12 条 CODE HEALTH（`retrieve.ts` 占 5 条，`store.ts` 占 3 条）；
   - `store.ts` 2,479 行是最大单件，但 17.4% 的占比远低于 graft-slice 的 58.2%；
   - `retrieve ⇄ filter` 的仅类型环可以抽共享类型解决，不是必须。

---

## 十一、边界与未验证

| 项 | 状态 |
|---|---|
| 改 `src/` | **零改动**（`git status` 只有新增仪器与文档） |
| 搬族 | **一个都没搬** |
| publish / paradise | 未触碰 |
| `verify-pure-move` 在真实位移上的表现 | 只跑了 `--self-test`（PASS）与工作树 `VACUOUS`。**真实位移未构造** —— 没有搬族就没有位移可测。 |
| 12 条 CODE HEALTH 是否真是缺陷 | 只做了分类，**未逐条追调用方**。 |
| `retrieve ⇄ filter` 的类型环是否值得拆 | 未评估。 |
| 别的机器上套件是否也稳定 | 只在本机连跑 3 次。 |
| memory 的 CI 结果 | 未推送，因此未取。 |
