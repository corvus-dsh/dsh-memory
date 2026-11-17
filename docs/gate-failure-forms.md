# D9 的形态 ⑧–⑮：门禁失效的七种形状（附 ⑭ 取证方法论）

> **D9** 是「门禁不是装饰」这条纪律的反例册：凡是**该红没红、该拦没拦、红了却读不出原因**的，
> 都登记在这里。①–⑦ 在项目报告里；本文件收 2026-11-17 这一天真实发生的五种，
> 每条带实测证据、判据，以及本仓的处置。
>
> 统一格式：**形态 → 实测 → 为什么它会安静地通过 → 判据 → 本仓处置**。

---

## ⑧ 把「离线/构造环境的实测」当成「生产环境的实测」

**实测**：`compaction-guard` 的公式用构造的 preset 验出 `0.6934 → 0.6734`，写进交接方案时成了
「**本 profile 实测生效值**」；而 live 的 `graft_debug_status` 是 `source:"conservative"`、
`effectiveHardAt 0.55`、`reason` 写明 `O=unreadable`（4 个 preset 都读不到 `maxTokens`）。

**区别**：前者证明「**公式对**」，后者才是「**这台机器上算得出**」。

**判据**：任何标「实测」的数字，必须写明「**会话名称、会话代数、在哪个环境测的**」。
三者缺一，那个数字就不是实测，是推断。

---

## ⑨ 门禁的安装动作本身破坏了门禁

**实测**（2026-11-17，`dsh-memory`）：B0 新增的 CI step 的 `name:` 值里含 `: `
（`- name: Incremental type budget (RESOURCE-aware: no compiler on the runner)`）。
YAML 规定 plain scalar 不得含 `: `，它被当作 mapping 指示符 ⇒ **整个 workflow 解析失败**：

```
run 44002473416   conclusion=failure   jobs=0   check_runs=0
GitHub 上该 workflow 的 name 回落成文件路径 .github/workflows/ci.yml（正常是 CI）
```

⇒ 所有门禁**一条都没跑**，而本地 `npm run check` 全绿（本地从不解析 `.github/workflows/`），
报告里写着「已接线」。

**为什么安静地通过**：CI 确实红了，但**没有 job 日志可读**——没有失败步骤名、没有 error 行，
只有 0 个 job。本地与 CI 双双答不出「门禁到底装上了没有」。

**判据**：任何修改 CI 配置的提交，**必须有一条「配置本身可解析」的判据，且该判据在同一次提交里**。

**本仓处置**：`test/v220-workflow-yaml-safe.test.mjs`（四仓逐字节相同、零依赖、CI 上真跑）。
它扫 `.github/workflows/` 下**全部** `.yml`，三条零误报判据（`: ` / ` #` / tab 缩进），
先**剥引号**再**跳过块标量正文**（否则会放过修复前那一行，或把一大片 shell 全报红），
并带反向用例（引号内与 `run: |` 正文里的同类字符**不许**报）。

---

## ⑩ 判断「有没有接线」时查了名字，没查实际命令

**实测**：`dsh-observer` 的 `check-readme-counts` 被接在名为 **`Gates (previously unwired)`** 的
step 里（`run: |` 三条命令的第二条）。按 step 名搜索 `check-readme-counts` 得 0 处 ⇒ 判「没接」，
**实际在跑**。同一天还误判了一处：`dsh-graft-slice` 的 `check-docs.mjs` 读的是 `tests`
（环境无关，本来就是对的），被当成「读本地口径」一起报了出去。

**为什么安静地通过**：`name:` 是人起的、可任意命名；`run:` 才是事实。名字与命令之间没有约束。

**判据**：要判断「某条判据是否真的在跑」，**搜索 `run:` 之后的命令，不要搜 step 名称**。
（推论：step 名里别写命令名——那会诱导下一个人用名字去搜索。）

---

## ⑪ 同一语义的判据有两份实现，口径不同，而没有门禁守护这个一致性

**实测**（同一天，同一语义「文档里的测试数」）：

| 实现 | 读数 | 环境相关性 |
|---|---|---|
| `dsh-graft-slice/scripts/check-docs.mjs` | `/tests (\d+)/` | **环境无关**（`t.skip` 仍计入 `tests`） |
| `dsh-memory/scripts/check-readme-counts.mjs` | `/pass (\d+)/` | **环境相关**（CI 上 13 条 `RESOURCE` skip 不计） |

后者意味着：README 声明「546 / 546」在本地成立、在 CI 上必然红（`pass 533`）——
**同一条断言在两个环境里不可能同时为真**。而 `check-readme-counts` 四仓逐字节相同、
有 FACT 5（同工作区副本哈希）守着，所以**它内部口径错了就是四仓一起错**；
`check-docs` 只有 graft 有，没有任何东西跟它对齐。

**为什么安静地通过**：两份实现各自绿着。一处只在本地绿，另一处真绿——**没有任何东西去问它们是否在说同一件事**。

**判据**：同一语义的判据**只能有一份实现**；多份时必须有**跨仓一致性断言**
（`run-gate.mjs --check-copies` / FACT 5 那一类），且一致性要断言到**读数口径**，不只是字节。

**本仓处置**：`countOf(out)` 成为唯一读数点，`pass + skipped` 为读数：
`t.skip` 计入 `tests`（实测：一个通过 + 一个 `t.skip` ⇒ `tests 2 / pass 1 / skipped 1`），
所以 `pass + skipped` 在本地与 CI 都等于「本仓有多少条测试」。「全绿」由 `fail > 0 ⇒ RED`
独立断言，因此这次改动**没有削弱**判据，只是删掉了「只可能在其中一个环境为真」的比较。

---

## ⑫ 验收「门禁接线」时，只在本地跑了它，没问「它在 CI 上会不会给出不同结论」

**实测**：B0.1 验收时，在本地跑 `check-readme-counts` 看到
`all 7 checkable fact(s) match. exit 0` 就判「接线成功」。
实际上它比的是**环境相关**的 `pass` 数，在 CI 上必然红 —— 第一次 push 就红了
（run 44006262441，两个 job 都红在 `Documentation counts match the code`）。

**为什么安静地通过**：本地绿是**必要**条件，被当成了**充分**条件。而这条判据的两侧
（README 声明 / 实测数字）恰好只在本地相等。

**判据**：验收一条「接进 CI 的门禁」时，必须回答：**它的断言里有哪些量是环境相关的？**
凡属于下面三类的量，都**不能**作为跨环境断言的输入：

1. 依赖编译器 / 工具链（`typescript`、`sqlite`、外部二进制）；
2. 依赖 git 历史（浅克隆里没有的提交）；
3. 依赖文件系统时序（pid、临时目录名、并发默认值、目录遍历顺序）。

**本仓处置**：README 的计数声明加上**口径限定**（「本地口径；CI 上 13 条 `RESOURCE` skip
也计入此总数，见 `ARCHITECTURE.md` TD-M15」），并保留 `N / N` 自等格式 ——
去掉自等格式等于把断言删掉（判据会「无断言可做」）。

---

## ⑬ 跨仓一致性判据使单仓 CI 不可独立验证

**形状**：`check-readme-counts` 的 FACT 5 逐个哈希「同工作区」的兄弟副本，**分叉即 FAIL**。
各仓 CI 用 `mv .siblings/<repo> ../<repo>`（`ci.yml:70`）把兄弟 checkout 到 FACT 5 的 `workspaceRoot`
（`check-readme-counts.mjs` 里 `workspaceRoot = new URL('../', repoRoot)` —— **同一个 `../`**），
且不带 `ref:` ⇒ 取兄弟仓**默认分支的已推送版本**。

**实测**（2026-11-17，memory CI run 44010364457）：run 红在 `Documentation counts match the code`，
日志 **403 读不到**。受控实验复现 —— 把兄弟仓的副本换回已推送的旧 blob
（`git cat-file blob 395fe3b78518`，sha256 `939b8bc46634`）：

```
ok   L106 测试数 546 / 546 与实测一致
ok   L537 测试数 546 / 546 与实测一致
ok   README 未声明当前版本 …  ok  ARCHITECTURE.md 的每个数字都有现状/时点限定
FAIL check-readme-counts.mjs 四份副本已分叉：dsh-paradise (939b8bc46634 ≠ ab0a7dcb5456)
```

换回新版 ⇒ 全绿。**失败原因不是计数，是兄弟仓落后。**

**代价（必须接受，不是要修掉）**：

- 改四份副本之一必须**四仓一起推**，不能逐仓验证；
- 推序由依赖方向决定：`paradise`（不 checkout 任何兄弟，唯一可单独验证）
  → `memory` / `observer`（依赖 paradise）→ `graft`（依赖 paradise + memory，最受限）；
- **「先在一仓验到绿再推广」这个策略，对这个判据不成立。**

**判据**：任何跨仓一致性判据，必须写清
（a）它在 CI 上读的是**哪个版本**（默认分支已推送？当前 commit？）
（b）因此它给单仓 CI 引入了什么**前置条件**
（c）满足前置条件的**推序**。

不写这三条的跨仓判据，会在第一次 push 时把「兄弟仓没推」误报成「本仓有问题」。

**本仓处置**：不改判据（它抓到的是真事实），而是把推序写进流程，并保留受控实验作为取证手段。

---

## ⑭ 取证方法论：审计通道不可用时，构造那个环境（不是跳过验证）

**实测**：memory CI 的失败原因**读不到**（job 日志 403 `Must have admin rights`，HTML 页面 30s 超时），
匿名 API 额度也曾耗尽。但把兄弟仓的副本换回旧 blob 再本地跑一次判据，**一行输出就给出了确定答案**
（见 ⑬ 的对话块）。

**判据**：任何「我拿不到 X，所以无法验证」的结论，先问一句 —— **X 能不能在本地构造出来？**

三种取证通道，按可及性排序（本轮三次 CI 失败各用了一种）：

| 通道 | 本轮实例 | 何时可用 |
|---|---|---|
| **API 可观测** | workflow 的 `name` 回落成文件路径 ⇒ 解析失败（run 44002473416 有 0 个 job） | 有读权限的公开端点即可 |
| **代码可读** | `actualTests = /pass (\d+)/` + `ci.yml` 自述「13 条在 CI 上跑不了」⇒ 断言两环境不可同时为真 | 有仓库读权限即永远可用 |
| **环境可构造** | 替换兄弟仓 blob ⇒ 复现 CI 的 FACT 5 红 | **不需要任何 CI 权限** |

**构造环境的三条纪律**（本轮实践）：先备份 → 做替换 → 跑判据 → **还原并校验 SHA-256 逐字节一致** →
把「还原一致 = True」写进报告。构造是为了**取证**，不是为了**改变状态**。

**附：构造出来的环境 ≠ CI 环境。** 本次实测：模拟浅克隆时漏了兄弟仓（`dsh-paradise`），
多出 1 条与 CI 无关的失败（`bridge: the layer decoding really happens`）；补上兄弟仓后它消失了。
判据：受控实验的结论必须能区分「**被检对象的缺陷**」与「**模拟环境的缺陷**」，
否则实验本身会成为新的假证据。

---

## ⑮ 「同源文件」靠约定，不靠判据 —— 于是它必然分化

**形状**：`test/run-gate-resource.test.mjs` 的头部写着
「THE SAME FILE IN FOUR REPOSITORIES, ON PURPOSE」，实测却是 **2 种版本**：
`dsh-memory` 239 行（有确定性回退）/ 其余三仓 177 行。**没有任何判据比较过它。**

**后果**（2026-11-17，observer CI run 44014143688）：observer 的 `Test` 步 **2 秒红**，
唯一失败 = `run-gate: a REAL failure still exits 1 (the wrapper is not a blanket pass)`。
根因：177 行版在**浅克隆**（CI 的 checkout 是 `depth=1`）里取 `<sha>~1` 作为 before ref，
而 `~1` 在 `depth=1` 里不存在 ⇒ instrument `exit 2` ⇒ `run-gate` 翻成 `0` ⇒
`assert.equal(code, 1)` 失败。memory 的 239 行走同一条路径，但有「不可测 ⇒ 回退到确定性
cycle fixture」，所以绿 —— **同一个判据，两个仓给出相反结论。**

**对照**：同一批文件里 `run-gate.mjs` 有 `--check-copies` 自校验，`check-readme-counts.mjs`
有 FACT 5，唯独这个测试文件没有。它不是「忘了写判据」，而是「没人意识到它需要判据」。

**判据**：任何自称「四仓相同」的文件，必须在**同一提交**里带一条比较它四份哈希的判据；
否则「相同」只是一句注释。已落地：FACT 5 扩为 `IDENTICAL_ACROSS_REPOS` 清单
（`scripts/check-readme-counts.mjs`、`test/run-gate-resource.test.mjs`），输出点名义上是
**哪个文件**分叉、哪个仓、两个哈希前缀。

**附：CLONE DEPTH 是隐藏的判据输入。** 依赖 `git log -N` / `~1` / `HEAD~1` 的判据，在
`depth=1` 下行为不同。凡使用 git 历史的判据，必须（a）检测 `~1` 是否存在
（b）不存在时回退，或**明确说「没测」** —— 不许把「测不了」写成「测了，结果是相同」
（本轮实测：旧版 `why` 的分类把 instrument 的 `cannot measure … not PURE` 归进了 `was PURE`）。

---

## 一句话

**B0 的目的是「让门禁真的会咬人」。它咬的第一个，是它自己的安装者。**
这不是失败，这是 B0 生效了；⑨⑩⑪⑫⑬⑮ 是它生效时留下的牙印
（⑭ 是取证时学到的手法，⑮ 是「自称相同」这句话本身的代价）。