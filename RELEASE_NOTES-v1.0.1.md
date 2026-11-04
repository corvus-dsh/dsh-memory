# dsh-memory v1.0.1

**发布日期**：2026-11-04
**测试**：242 / 242 通过

## 修的两件事

### 1. 面板把命令信封当成了状态（与 graft 同源）

面板显示「记忆库 0 条 / 工作区（未知）/ 台账 正在读取…」，四个开关全 OFF 且点了不变色——而写按钮确实弹出了「已保存到全局配置」。

`commands.execute` 返回 CommandExecution `{ kind, text }`，桥接只认 `{ result: CommandExecution }`，落到 `JSON.stringify(settled)` 兜底并报 `ok: true`。面板状态于是是信封本身：没有 `skills`、没有 `ledger`、没有 `workspace`。

修复：`unwrapExecution()` 解包（容忍 3 层包裹与字符串化信封），认不出的形状**报错而非猜状态**。

### 2. 裁决模型的 JSON 方言

去掉 `reasoningEffort` 并给足 4096 预算后，裁决有输出了，但报：

```
Expected property name or '}' in JSON at position 4 (line 2 column 3)
```

模型在 JSON 里带了注释或尾逗号，整条裁决被丢弃 → 每轮退化为严格词法召回。

修复 `salvageApply()`：
- 只在**严格解析失败**时启用；
- 只从 `"apply": [...]` 取引号内的 id，且**每个 id 仍须与第 1 阶段真实产出的候选精确匹配**（幻觉 id 一律丢弃）；
- `supersede`（写决策）**只接受严格 JSON** —— 草率的信封可以让提示少一条，但永远不能退休一条记忆。

## 升级

- `client.js`（面板）：**刷新页面**即可。
- `lib/`（过滤器）：需要重启宿主。
