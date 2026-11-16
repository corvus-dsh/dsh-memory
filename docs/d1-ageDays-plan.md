# D-1：`hitOf` 不复制 `ageDays`/`hits` ⇒ 过期前缀永不出现（**方案**，未改代码）

> 2026-11-16。用户裁定：**启封，但只出方案**。
> 本文件只有分析与方案，**没有一行代码被改**。D-1…D-7 其余仍在挂。

---

## 一、先订正原登记：缺陷比登记的**更大**，而且位置不同

原登记（`docs/memory-known-defects.md` 与 `docs/memory-type-defects.md` 的 ③）说的是：

> `hitOf()` 不复制 `ageDays` ⇒ `renderHint()` 读 `negative.ageDays` 永远是 `undefined` ⇒ 过期前缀永不出现。

**这句话对了一半。** 端到端实测（`_scratch/d1-probe-e2e.mjs`、`d1-probe-2.mjs`、`d1-probe-3.mjs`）
证明实际形状是：

| 项 | 登记的说法 | 实测 |
|---|---|---|
| 前缀永不出现 | ✅ 对 | ✅ 对 |
| 原因是 `ageDays` 未复制 | ✅ 对 | ✅ 对 |
| **降权也不生效** | 未提 | ❌ **错**：降权**生效** |
| **还有第二个字段没复制** | 未提 | ⚠️ **`hits` 也没有被复制** |
| `Document` 自己也没有 `hits` | 未提 | ⚠️ **对**：`Document` 接口里没有 `hits` 字段 |

### 实测证据

**A. 降权确实生效**（三个点，控制 freshness）：

```
老(40d, hits=1) = 0.349
新(1d,  hits=1) = 1
老(40d, hits=5) = 0.802

freshness(40)/freshness(1) = 0.6423
实测 score 比值             = 0.3490  ⇒ 隐含 importance 比值 = 0.5433  （≈ 0.5 的降权真的进去了）
老(40d,hits=5)/老(40d,hits=1) = 2.2980  （freshness 相同，只反映 importance：hits=5 有加成且不降权）
```

原因：`negativeDocumentOf()` 在算 `Document.importance` 时用的是**局部变量** `ageDays` 与 `hits`
（`interning.ts:236-241` 内联 `isStaleNegative({ ageDays: ageDaysOf(...), hits })`），
根本不读 `Document` 上的字段。所以降权这条路一直是对的。

**B. 前缀确实永不生效**（同一条记录，真实路径）：

```
真实的 MemoryHit
  ageDays     = undefined
  hits        = undefined
  own keys    = confidence, detail, domain, id, kind, provenance, scene, scope, score, title, workspace
renderHint = [参考历史数据，非当前指令] （记忆提示：另有一次「…」翻车，先核对再重跑。）
带过期前缀? false     ← 它是 40 天前的一次性错误，本该带前缀
```

**C. 只修 `ageDays` 会引入一个反向 bug**（这一条是原登记完全没有的）：

`isStaleNegative` 的规则是「**老 且 从未复发**」（`interning.ts:139-150`）。
若 `hits` 恒为 `undefined`，则 `Number(undefined ?? 1) === 1` ⇒ 看起来像「从未复发」：

| 情形 | 真值 | `hits` 丢失时 | |
|---|---|---|---|
| 老 + 从未复发（hits=1） | `true` | `true` | 一致 |
| **老 + 复发 5 次（hits=5）** | `false` | **`true`** | ← **错**：活规则被误标成往事 |
| 新 + 从未复发 | `false` | `false` | 一致 |

所以**只补 `ageDays` 会让「老且复发过 5 次的活规则」被打上「历史偶发错误，仅供参考」** ——
比现在的「一律不打」更糟：现在的失效是**安静地少说一句话**，改一半会变成**主动说错一句话**。

**D. 为什么有测试却没人红**：

`test/v021-governance.test.mjs:206-229` 确实断言了「前缀会出现」，但它**手工构造**了
`{ ageDays: NEGATIVE_STALE_DAYS + 10, hits: 1 }` 这个 hit ——
即测试喂给 `renderHint` 的正是**真实路径永远不会产出**的对象。
测试测的是 `renderHint` 的局部逻辑，而不是「`hitOf` 到 `renderHint` 这条链」。

> 这是本项目反复记过的同一类错误：**测试假设了它没有声明的前提**（这里是「hit 上会有 ageDays」）。

---

## 二、修法方案

### 方案 A（推荐）：`hitOf` 补两个字段 + `Document` 补一个声明

三处最小改动，全部是「搬运既有值」而不是改判据：

1. **`MemoryHit` 加 `ageDays?: number`**（`src/retrieve/types.ts`）
   —— 它已经有 `hits?: number`，缺的是 `ageDays`。
2. **`Document` 加 `hits?: number`**（`src/retrieve/types.ts`）
   —— `negativeDocumentOf` 已经在**条件对象里**写了 `...(Number.isFinite(hits) ? { hits } : {})`，
   但 `Document` 接口没声明它（所以现在是被 excess property check 放过的隐式多余字段；
   `layerDocumentOf` 那条路径也在写它）。
3. **`hitOf` 补两行**（`src/retrieve.ts`），与它旁边 20 行的写法一致：
   ```ts
   ...(document.ageDays === undefined ? {} : { ageDays: document.ageDays }),
   ...(document.hits === undefined ? {} : { hits: document.hits }),
   ```
   注意：`Document.ageDays` 是**必填**（`ageDays: number`），所以第一行可以简写成 `ageDays: document.ageDays`；
   但为与周围风格一致、且未来 `Document` 放宽时不出事，建议仍用条件展开。

**为什么两行必须同一笔修**：见上面 C。分开修会在中间状态引入「主动说错话」。

**副作用**：`MemoryHit` 多两个字段 ⇒ 任何 `deepEqual(Object.keys(hit), …)` 形式的断言会红。
全仓扫过：**没有**这种断言（`ledger-segment.test.mjs:41` 那个是 `snapshot.transferred`，无关）。
但 `v140-storage-tier.test.mjs:67`、`indexed-store.ts`、`sqlite-index.ts` 都在**产出** `hits`，
说明这个字段本来就在各层流转，只是没走到 `MemoryHit`。

### 方案 B（不推荐）：`renderHint` 自己判

把 `renderHint` 里的 `isStaleNegative({ ageDays: negative.ageDays, … })` 改成
「用一个从别处拿到的年龄」。问题是 **`renderHint(result)` 只拿到 `MemoryHit`，没有别的来源** ——
要么调用方多传一个 `now`，要么把 `at` 也塞进 hit。两者都比方案 A 更绕，而且
`ageDays` 本来就是 `Document` 已有的字段，复制它是自然的事。

### 方案 C（也不是不行，但重）：`MemoryHit` 直接带上 `at`

让 hit 携带原始时间戳，由消费方自己算年龄。
好处是「年龄」不再是一个在取数时刻冻结的数；坏处是每多一个时间字段就多一处「谁算年龄」的分歧。
本表现在已经有 `lastValidated` / `updatedAt` / `validAt` 三个时间字段，
再加 `at` 会让「哪个是权威」更难说。**不建议**。

---

## 三、必须先红的测试（两红，缺一不可）

修法要配一条**端到端**测试，而不是又一条构造 hit 的单测。这是本缺陷的核心教训。

### 测试 1：真实路径产出带 `ageDays`/`hits` 的 hit（**先红**）

plant 一条 40 天前、`hits: 1` 的 negative → 走 `retrieveCandidates` → 断言
`hit.ageDays === 40`（±1）且 `hit.hits === 1`。
**当前必红**（两者都是 `undefined`）。

### 测试 2：真实路径的 hint 带过期前缀（**先红**）

同一条 hit → `renderHint` → 断言 `hint.includes(NEGATIVE_STALE_PREFIX)`。
**当前必红**。

### 测试 3（防「改一半」）：复发过的老 negative **不带**前缀

plant 一条 40 天前、`hits: 5` 的 negative → `renderHint` → 断言**不带**前缀。
这条在**只补 `ageDays` 的中间状态会红** —— 它就是方案 A「两行必须同一笔」的守卫。
（当前也是绿的，因为一律不带前缀；所以它是**回归守卫**，不是先红项。）

> 三条合起来才锁住「降权、前缀、复发豁免」三者一致。
> 只有测试 2 是不够的 —— 那正是原测试的形状（构造 hit，测局部逻辑）。

---

## 四、连带账（修完要同步的数字）

| 项 | 现在 | 修完 |
|---|---|---|
| `type-budget` 的 2339 身份表 | 4 条在 `retrieve.ts`（`565`/`709`/`949`/`973`） | `973` 那条（`ageDays` 不存在于 `MemoryHit`）会**消失** ⇒ 每文件 `retrieve.ts` 4 → **3**，总数 12 → **11**；`BASELINE_IDENTITIES` 要删两条（`973` 的 `ageDays` + 若 `hits` 也报过则一并） |
| `docs/memory-type-defects.md` 的 ③ | 「1 行复制 + 1 行接口」= 2 行 | 实际是 **2 字段 × (1 行复制 + 1 行声明) = 4 行**（`ageDays` 声明已在 `Document`，故新增的是：`MemoryHit.ageDays` 1 行、`Document.hits` 1 行、`hitOf` 2 行） |
| `docs/memory-known-defects.md` 的 D-1 条目 | 定性为「代码欠账（真行为缺陷）」 | 定性**不变**，但要补「`hits` 也未复制」与「降权其实生效」两条订正 |
| `ARCHITECTURE.md` | 无此条目 | 修完应在 TD 列表之外单独记一句（它是 P0 级数据可用性缺陷，不是架构债） |
| `v205` ceiling | `retrieve.ts` 1074 | +2 行 ⇒ **1076**（棘轮要跟着收紧） |
| `v207` 六数 | `declarations 32 / spanSum 720` | 声明数不变（只加字段），`spanSum` 会 +2 左右 ⇒ 需重测 |

**`v207` 需要重测**：`hitOf` 的 span 会从 29 行变成约 31 行，`spanSum` 与四档都可能变。
这不是「顺手」能猜的，修完必须跑 `node scripts/retrieve-report.mjs` 照抄。

---

## 五、风险与边界

| 风险 | 评估 |
|---|---|
| **行为变化面** | 只影响**渲染出来的提示文本**（多一个前缀）与 `MemoryHit` 的字段集。**不影响**排序、不影响召回、不影响降权（降权本来就在）。 |
| **提示变长** | 每条 stale negative 的提示多 13 个字符（`[历史偶发错误，仅供参考] `）。`renderHint` 已有 `clipTitle` 与总长控制，实测前缀在句首、不移除任何内容。 |
| **会不会突然冒出很多前缀** | 会。所有「老且从未复发」的 negative 提示都会带上它 —— **这正是设计意图**（v0.21 的 P1 就是为此写的）。但要预期既有测试里若有 golden 文本会红。全仓扫过：断言 `NEGATIVE_STALE_PREFIX` 的只有 `v021` 三处，都是构造 hit，不受影响。 |
| **`hits` 的语义** | `Number(record.hits ?? 1)` 说明「缺省 = 1 次」；`renderHint` 的判据 `hits > 1` 才会豁免。复制时保持 `?? 1` 语义即可，不要在这里改成 `?? 0`（那会让未记录的负知识也豁免）。 |
| **D-2/D-3 的耦合** | `updatedAt`（D-2）与 `ageDays`（D-1）在 `hitOf` 里是相邻的两行，D-2 的修法也是「补一行复制」。**建议 D-1 与 D-2 分开两笔**：它们的测试与门禁账不同，合在一起会让「哪一行治好了哪个缺陷」变模糊。 |

---

## 六、建议的执行顺序（等你点头才动）

1. 先写测试 1、2（**确认红**），再写测试 3（确认绿）。
2. 改 `types.ts` 两处声明 + `retrieve.ts` 两行复制。
3. 跑 `node scripts/retrieve-report.mjs` 重测六数；`v205` ceiling 收到新值。
4. `type-budget --baseline` 重生成身份表（预期 12 → 11）。
5. 改 `docs/memory-known-defects.md` / `memory-type-defects.md` 的 ③ 与 D-1：把「`hits` 也未复制」
   与「降权其实生效」写进去 —— **原登记的两处不准确必须一起订正**，否则下一个人会照着错的描述去修。
6. 提交，推送，轮询 CI 双 Node。**CI 绿 ≠ TD-M15 那 13 条过了。**

---

## 七、本次没有做的事

- **没有改任何代码**（用户裁定「只出方案」）。`src/` 与 `lib/` 与 `git HEAD` 一致。
- 没有动 D-2…D-7。
- 没有把本文件的分析做成门禁 —— 前置分析是一次性的，但**测试 1/2/3 是他的门禁**（修的时候写）。
