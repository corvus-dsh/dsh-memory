# FS-SETTLE：为什么「写完立刻 stat」是一个 flake 工厂

> 登记于 2026-11-21（B4-0b-2 §40）。适用：任何在测试或探针里**写文件系统、然后立刻读它的元数据**
> 的地方。

## 一、症状

`v293 ④` 连续跑 20 次，**18 次红**。用户的机器上是 8 次里红 1 次。

红的内容是：

```
新增技能没有被发现 —— 键的第一半（父目录 mtime）失效了
expected 6, actual 5
```

## 二、第一次修法，以及它为什么更糟

第一反应是「等 mtime 可见」：在 `mkdirSync` 之后**轮询**父目录 mtime，上限 400 ms。

结果：**7/20 仍然失败，等了 405 ms，观测序列里每一个样本都相同。**

## 三、机制：不是延迟，是**已提交的同一个值**

20 次试验 × 每行，`mkdir` **之前** sleep 与之后 sleep 的对比：

| mkdir 之前 sleep | 立刻读，值相同 | 等 250 ms 后，值仍然相同 |
|---|---|---|
| **0 ms** | **20 / 20** | **20 / 20** |
| 1 ms | 0 / 20 | 0 / 20 |
| 2 / 5 / 16 ms | 0 / 20 | 0 / 20 |

而「mkdir 之后轮询 400 ms」这一行：**7/20 始终没变**。

⇒ 时间戳在**写入那一刻就已经确定了**。如果 mkdir 与它前面那次 stat 落在**同一个文件系统更新窗口**里，
记录下来的就是**同一个值**，此后无论等多久都不会变。

**所以等待必须在写之前，不是在写之后。** 在写之后等待，永远等不到。

补充测量（`probe6`）：值本身是连续的（最小 delta 0.343 ms，没有量化台阶），所以这不是「时钟太粗」，
而是「同一个更新周期内不刷新」。

## 四、正确的形状

```js
import { mtimeChangeAfter } from './helpers/fs-settle.mjs'

const settled = mtimeChangeAfter(skills, () => {
  mkdirSync(join(skills, 'skill-900'), { recursive: true })
  writeFileSync(join(skills, 'skill-900', 'SKILL.md'), text, 'utf8')
})
assert.ok(settled.ok, `mtime 没动：${JSON.stringify(settled.samples.slice(0, 4))}`)
```

`mtimeChangeAfter` 做四件事，而**第 2 步是承重的那一步**：

1. 取基线 mtime；
2. **`settleBefore()` —— 让下一次变更落在新的更新窗口里**（1 ms 实测足够，默认 4 ms 留余量）；
3. 执行变更；
4. `waitForMtimeChange` —— **验证**它真的可见了，超时则打印观测到的样本。

第 2 步与第 4 步**不是冗余的**：第 2 步让它能工作，第 4 步证明它工作了。
只 sleep 的 helper 会在文件系统改变窗口的那天悄悄退化成 flake；这个会**报出来**。

## 五、为什么不用固定 `sleep(50)`

§33.3 已经为同一个理由删掉过一次固定 250 ms 等待：它要么太短（flake 回来），要么太长（每次运行都付）。

这里的 pause 是**实测足够的最小值**（1 ms）+ 余量，而**结果仍然被验证**——一个太短的 pause 会**响亮地
失败**，而不是悄悄把 flake 放回来。

## 六、can-red（实测）

把 `settleBefore` 的默认 pause 改成 `0` ⇒ **8/10 失败**。改回 ⇒ **0/20 失败**。

## 七、它对 TD-M20 的影响：结论不变，测法要改

TD-M20 的原始观察是「原地改内容不移动父目录 mtime」，而那个观察用的是**同一个**「写完立刻 stat」的假设。
「不看见」在时间戳碰撞时**更容易**通过，所以绿色结果在这里证明不了什么。

用同样的纪律重测（settle **之前**、等 50 ms **之后**再看），20 次：

```
edit in place  ⇒ parent mtime moved  0/20   （TD-M20 说必须是 0）
edit in place  ⇒ skill dir mtime moved 0/20
add a skill    ⇒ parent mtime moved  20/20  （必须 20，否则隐式失效那一半没有用）
```

⇒ **TD-M20 成立**（不是时间戳碰撞的假象），**但它的测法需要这个 helper**。
