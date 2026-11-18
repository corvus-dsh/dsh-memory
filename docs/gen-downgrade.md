# N 代未引用降级（`b3-f8`）

> 2026-11-19 登记。这是 B3 第 5 条的判据文档 —— **先写判据，再写码**，顺序不许反。
> 代码：`src/generation.ts`（规则 + IO 各一处）、应用点 `src/retrieve.ts` 的 `scoreDocuments`。
> 测试：`test/v248-generation-downgrade.test.mjs`。

## 1. 何谓「一代」

以 **memory 自己记录的 `generation`** 为准：记录上那个 `generation` 字段，由 harvest 在写入时
从 `.graft-targets.json` 读出并写进记录（`src/index.ts` 的 meta 组装处）。

**「当前是第几代」也从同一个文件读**（取最大值，`readCurrentGeneration`），不重新发明。

为什么不用另外两个候选：

| 候选 | 为什么不用 |
|---|---|
| graph history 的 `author.generation` | 那是**图**的账。读它等于给「第几代」造第二个真相源 —— observer 已经证明过「跨代事实不能有第二个真相源」 |
| session 的 `auto-graft-*` 段 | 那是**切片插件**的账：会话被切过几次 ≠ 代码库走了几代。同一个数字的两个含义是这类系统最常见的事故 |

读不到（文件缺失、损坏、值为 0）⇒ **未知**，未知不降级。

## 2. 何谓「被引用」

与 `memory_stats` 的四个来源**同一口径**（`src/store.ts: stats()`：技能目录 / `negatives.jsonl` /
`facts.jsonl` / `experiences.jsonl`）。一条记录算「被引用过」，当且仅当**它自己身上有痕迹**：

| 形状 | 被引用的判据 | 说明 |
|---|---|---|
| 技能 | `last_used` 非空，或 `sources > 1` | 被注入过一次，或被两次独立确认 |
| 负知识 | `hits > 1` | 这个坑又发生过一次 |
| facts / experiences | **无计数** ⇒ `undefined` = 未知 | 未知永不降级 |

「被引用」不是「被读」、不是「文件 mtime 新」、不是「被 grep 到」。用别的东西代理它，会让
「谁用过」变成猜测；而据此降权的猜错，读者无从核对。

## 3. 规则与形态

```
downgrade ⇔ mode === 'always'
          ∧ N 已给出（正整数）
          ∧ 记录有 generation > 0
          ∧ currentGeneration > 0 ∧ currentGeneration − generation ≥ N
          ∧ referenced === false            ← 注意：false，不是「假值」
```

- 权重：`GENERATION_DOWNGRADE_WEIGHT = 0.5`（乘在分数上）；
- 文案：前缀 `[N 代未被引用]`，N 是真实差值；
- **降级不是删除**：文件不动、记录不删、仍会被召回（只是权重低）；任何一个后续引用都会让
  `referenced` 变真，下一轮就不再降级 —— 可逆，且理由是写出来的。
- **`referenced === undefined` 时不动**：`!referenced` 会把「这类记录没有计数」误读成「从未用过」。

## 4. 实测（2026-11-19，profile `desktop`）

路径：`C:\Users\89283\.dsh\profiles\desktop\data\dsh-memory`、
`...\data\dsh-graft-slice\.graft-targets.json`、技能目录 `C:\Users\89283\.agents\skills`。

| 量 | 实测 |
|---|---|
| 技能 | **6** 条 |
| 负知识 | **5** 条 |
| facts | **6** 条 |
| experiences | **6** 条 |
| **带 `generation` 的记录** | **0** 条（6 条技能全无该字段；5 条负知识的键里也没有 `generation`） |
| 技能里被引用过的 | **4 / 6**（`last_used` 非空）；`sources > 1` 的 **0** 条 |
| `.graft-targets.json` | 4 个 target，`generation` ∈ {1, 2} ⇒ 当前代 = **2** |

**结论：N 不定。** 两重原因：

1. **样本不足**：技能只有 6 条、跨代样本 0 条。任何 N 都是拍的 —— 而派工单明令「不许拍 N」；
2. **覆盖率 0**：`generation` 在这份 store 里一条都没有。即使今天给一个 N，也**不会有任何记录
   被降级** —— 机制是空的。

所以这一条的交付形态是：**机制实现 + 默认关闭 + N 未定**。这与「只写个死函数」不同：规则被接进
`scoreDocuments` 的真路径，打开一次就能生效，且有测试证明它在夹具上确实会降级。

## 5. 怎么打开（以及为什么默认不开）

```json
{ "generationDowngrade": "always", "generationMin": 2 }
```

- `generationDowngrade`：`'never'`（默认）| `'always'` | `'manual-only'`；
- `generationMin`：N。**没给 N 时 `always` 也不动**（未定的阈值不许生效）。

`'manual-only'` 目前与 `'never'` 对自动路径等价：**还没有手工入口**（没有对应的工具）。
这一条是明确写出的缺口，不是遗漏 —— 加一个手工入口要先决定「手工降级写到哪里、谁能撤回」。

默认 `'never'` 与既有行为逐字相同：`v248 ①` 钉住这一点。

## 6. 明确不做 / 已知局限

- **不自动回填 `generation`**：给旧记录补一个「大概是第几代」的数是发明证据。要补只能由写入路径
  在下次重写时带上（`renderSkill` 已经会带 `meta.generation`，所以下一次 merge 会自动补上）。
- **facts / experiences 永远不参与降级**：它们没有引用计数，未知不降级。
- **只按代际与引用两个轴**，不掺时间：时间轴已经由 `isStaleNegative` 与技能 decay 管着，
  两个轴混成一个阈值，会变成「哪个原因都说不清」。