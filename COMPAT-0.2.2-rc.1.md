# 0.2.2-rc.1 兼容性修复报告

**运行时**：0.2.2-rc.1（`plugin_manager list_version_exemptions` 实测确认）
**审计方式**：以 `cordis_inspect_query` 读取**实时契约**为准，不以升级说明为准——说明写「改了什么」，检查写「现在是什么」。
**自报无豁免**：`exemptions: {}`，两个插件均满足运行时版本要求。

---

## 结论摘要

| 指令项 | 核查结论 | 处理 |
|---|---|---|
| 1.1 `session.events` 替换 | **无此问题** | 无需改动 |
| 1.2 `SessionProjectionRegistry.register()` await | **不适用** | 无需改动 |
| 1.3 点火 `sessionController.prompt` | **已合规** | 无需改动 |
| 1.4 `tokenMeter` 变更 | **未使用** | 无需改动 |
| 2.1 沙箱 Hook 可用性 | **已合规** | 无需改动 |
| 2.2 全局 RPC 不依赖 agent | **已合规**（v0.30） | 无需改动 |
| 2.3 开关 disabled 绑定 | **已合规**（v0.30） | 无需改动 |
| 3.1 锁兼容性 | **无第三方锁** | 无需改动 |
| 3.2 **锁覆盖所有 RMW** | **发现 1 处漏洞** | **已修复** |
| 3.3 epoch 防撕裂 | **完好** | 无需改动 |

**唯一真实缺陷**：`dsh-memory` 的 `quarantineWorkspaceMemory` 存在无锁的读-改-写。

---

## 一、核心 API 兼容性

### 1.1 `session.events` → `snapshotEvents()` / `eventAt()` / `seq`

**0.2.2 实测契约**（`Service.listService` → `sessionProjections` 的 `referencedTypes.Session`）：

```
class Session {
  eventAt(seq): SessionEvent | undefined
  snapshotEvents(fromSeq?, toSeqExclusive?): readonly SessionEvent[]
  ownEvents(): readonly SessionEvent[]
  get seq(): SessionLogOffset
  ...
}
```

**没有 `events` 属性。**

**本项目实况**：`grep` 到 40+ 处 `log.events` / `raw.events`，但它们全部指向我们自己声明的接口：

```ts
// src/index.ts:14047
interface SessionLogSnapshotLike {
  session: SessionHeaderLike
  inheritedEventCount?: number
  events: SessionEventLike[]      // ← 我们自己构造的普通对象
}
```

即 `{ session, events }` 是**我们组装的日志快照**，不是 `Session` 实例。所有对**活会话**的读取已统一走 `snapshotEvents()`（40+ 处：`services/index.ts` 行 7660、7746、8223、10102、10873、12370、13257 等）。

**结论**：指令要求的替换**没有对象**。不改代码——改了反而会把内部数据结构与宿主 API 混为一谈。

### 1.2 `SessionProjectionRegistry.register()` 改为 await

**0.2.2 实测**：`register()` 返回 `Promise<ProjectionHandle<S>>`，文档明确「callers must await registration before publishing consumers」。

**本项目实况**：`grep` 两个仓库，**没有任何 projection 注册**（无 `sessionProjections`、无投影单元）。两个插件都是「从已有事件派生」，不参与投影表。

**结论**：不适用。

### 1.3 点火链路 `sessionController.prompt`

**0.2.2 实测签名**：

```ts
prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>

interface SessionPromptRequest {
  requestId: SessionRequestId
  sessionId: SessionId            // ← 会话身份在这里，不在 agent 参数
  mode: 'queue' | 'steer'
  content: readonly PromptContentPart[]
}
```

**注意**：`prompt` **没有 agent 参数**。会话由 `request.sessionId` 命名，Host 内部 `resolveAgent(sessionId)` 解析。

**本项目实况**（`src/index.ts:4019`）：

```ts
const request = () => ({
  requestId: `graft-ignite-${targetId}-${Date.now().toString(36)}`,
  sessionId: targetId,
  mode: settings.ignitionMode,
  content: [{ type: 'text', text: prompt }],
})
```

**结论**：形状与 0.2.2 完全一致，无需改动。指令中「确保提供合法的 `{ id: string }` agent」对 `sessionController.prompt` **不适用**——它不要 agent。该要求只对 `commands.execute` 有效，而后者在 v0.30 已用常量占位 agent 满足。

### 1.4 `tokenMeter` 与水位计算

**本项目实况**：两个插件都**不调用 `tokenMeter`**。`graft` 的水位来自：

- `provider usage`（`readTokenWatermark`）
- 会话自身 `requestHeader()` 的 `contextWindow`

动态水位算法（`effectiveWatermarks` / `estimateGraftCost`）是**本插件自有的纯计算**，输入是窗口大小与增长估计，不依赖宿主 API 形状。

**结论**：无变更影响。`Session.requestContext()` 的 `contextWindow` 字段在 0.2.2 仍存在（实测 `RequestContext` 定义）。

---

## 二、UI 面板框架适配

### 2.1 Hook 可用性

**0.2.2 实测内置面**（`Builtin.listBuiltins`）：

```
React.createElement / React.useState / React.useEffect
```

**本项目实况**：剥离注释后逐行扫描，两个 bundle 的**活代码只调用这三个**。

`grep` 曾命中 `React.useCallback`，逐行过滤后确认**全部位于注释**——那是 v0.23 白屏事故的记录文字（`useCallback` 不在沙箱面内，调用即在渲染期抛 `TypeError`）。**不是调用**。

**结论**：合规。已有 `test/v023-panel-render.test.mjs` 在「只提供三个符号」的 React 下渲染两个面板取证。

### 2.2 全局模式 RPC 不依赖 agent

**本项目实况**（v0.30 已实现）：

- `GLOBAL_AGENT_ID`：`dsh-graft-console-global` / `dsh-memory-console-global`
- 读：`/memory-console` 无 agent 时改走 `/memory-console-global`（该 Host 命令不读 agent 任何字段）
- 写：同样用常量占位符

网关只校验 agent 的**形状** `{ id: string }`，不校验存在性——此判断已由 v0.30 的端到端验收证实（`sessions.list()` 返回空时读写均成功）。

**结论**：合规。

### 2.3 开关 disabled 绑定

**本项目实况**：

```js
const canWrite = state !== null && state !== undefined
```

表达式中**无任何 session 项**；每个开关的 `disabled` 均为 `!canWrite`（graft 14 处、memory 6 处）。`value` 直接绑定 `config.<field>`，写入走 `configEditor.edit` → `cordis.patch.yml`。

**结论**：合规。

---

## 三、并发与状态一致性

### 3.1 锁的兼容性

**关键事实**：本项目**不依赖 `proper-lockfile`**，依赖树里没有该包。锁是自己实现的 `mkdir` 原子原语（`src/lock.ts`）：

- `mkdirSync(lockPath)` 在 `EEXIST` 时失败——跨平台原子
- 持有者 pid 存活则永不窃取；pid 已死或租约过期则回收
- 释放用 **`rename` 到私有名**（v0.26 修复）：只有一个调用者能赢，避免「检查后删除」窗口里删掉别人的锁

**结论**：无第三方库行为需要重新验证——不存在该库。锁机制是纯 `node:fs`，不随 DSH 版本变化。

### 3.2 锁覆盖所有 RMW —— **发现漏洞**

**扫描结果**：`store.ts` 共 6 处读-改-写。

| 路径 | 状态 |
|---|---|
| `updateJsonArrayFile`（processed.json） | ✅ 有锁 |
| `appendNegatives` | ✅ 有锁 |
| `recordCounterEvidence` | ✅ 有锁 |
| `migrateEvidence` 的 `migrateJsonl` | ✅ 有锁 |
| `appendLayer`（facts / experiences） | ✅ 有锁 |
| **`quarantineWorkspaceMemory` 的 negatives 分支** | ❌ **无锁** |

**缺陷详情**：该函数读全部 `negatives.jsonl` → 按 workspace 分区 → 重写剩余部分。窗口期宽到足以吞掉 harvest 刚追加的记录，且**无错误、无痕迹**。它长期未被发现，因为「维护/诊断操作不会与 harvest 并发」听起来成立——但 harvest 跑在自己的定时器上。

**修复**：读与写收进同一临界区，且**读在锁内**——锁外读到的值按定义已过期。

**覆盖测试**（`test/v031-quarantine-lock.test.mjs`，3 条）：
- 隔离期间追加的记录不被吞掉
- 被隔离的记录确实落到隔离目录（是移动，不是丢弃）
- 第二次空跑不扰动文件（幂等）

### 3.3 Epoch 防撕裂

**机制实况**：
- 写方：`LEDGER_EPOCH = 2`（`graft` 侧 `src/index.ts:7233`）
- 读方：`SUPPORTED_LEDGER_EPOCH = 2`（`memory` 侧 `src/ledger.ts:36`）
- 四分支判定：`epoch === SUPPORTED` 信任；`<` 信任（legacy）；`>` **拒读并报告**；不可解析记为 `torn`

**关键判断**：这是**我们两个插件之间的文件格式契约**，不是 DSH 提供的 API。因此它与 DSH 版本**无关**——0.2.2 不会影响它，0.3.x 也不会。

**结论**：完好。既有 `test/v018-ledger-epoch.test.mjs`（两仓各一份）覆盖。

---

## 四、验证与回归

### 4.1 全量测试（0.2.2-rc.1 环境）

| 仓库 | 结果 |
|---|---|
| `dsh-graft-slice` | **508 / 508 通过** |
| `dsh-memory` | **229 / 229 通过**（+3，本轮新增） |

`dsh-memory` 连续 3 次全量运行零失败（此前多进程锁测试在满载下偶发，已通过放宽 barrier 预算至 60s 修正——锁超时退出码 3、丢记录退出码 0，二者仍可区分）。

### 4.2 真机验证项（需重启后由用户确认）

我**没有浏览器控制权**，以下四项无法在本地代验：

| 验证项 | 我所能提供的证据 |
|---|---|
| UI 面板加载全局配置 | 端到端测试：真 Host 命令 + 真 bridge，`sessions.list()` 返回空时读到 14/8 个配置字段 |
| 开关可点且持久化 | 同上，`disabled=0`，写入触发 Host 侧 `configEditor.edit` 一次 |
| `graft_prepare` / `graft_commit` 链路 | 508 条测试覆盖，含冷校验与回滚；**未在真机跑过完整切片** |
| `dsh-memory` 检索注入生效 | 229 条测试覆盖检索链路；**未在真机观察真实 hint** |

---

## 五、本次**未**改动的内容及理由

1. **不把 `log.events` 改成 `snapshotEvents()`**——那是我们自己的数据结构，改了会让内部模型与宿主 API 混淆，属于破坏性「为改而改」。
2. **不新增 projection 注册**——两个插件的设计是「从已有事件派生」，引入投影表是架构变更，不在兼容性修复范围。
3. **不为 `sessionController.prompt` 补 agent 参数**——它的契约里没有这个参数，补了反而非法。
4. **不引入 `proper-lockfile`**——现有 `mkdir` 原语已覆盖需求且零依赖，替换会新增失效面。

---

## 六、技术债登记

本轮发现的 quarantine 无锁问题已修复并有测试。其余结构调整（`index.ts` 拆分）仍按既定技术债登记，本轮**不执行**。
