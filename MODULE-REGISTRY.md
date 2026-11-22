# 模块登记表（source of truth）

> **这张表是"哪些模块存在、各自干什么、依赖谁"的唯一权威。**
> 由 `test/module-registry.test.mjs` 双向守护：磁盘上多一个文件、或表里多一行幽灵，都会红。

## 分母算法（先说清，否则数字没有意义）

- 覆盖目录：`src`，**递归**（含 `src/store/` 与 `src/retrieve/` 两个子目录）
- 计入条件：文件名 `endsWith('.ts')`
- 实测：跑 `node --test test/module-registry.test.mjs`，它以诊断（`ℹ` 行）打印
  「模块数 / 总行数 / > 800 的文件 / 最大文件」——**这四个数不写在这份文档里**。
  原因不是嫌麻烦：数字写进文档就会过时，而**没有任何门禁会因为文档里的数字过时而红**，
  偏偏「实测」两个字让它看起来最像证据。本节唯一保留的是**判定规则**，不是快照。
- 三个方向都查：① 磁盘 → 表（新文件不能悄悄进）；② 表 → 磁盘（删掉的行不能留着）；
  ③ 依赖列 → 磁盘（不能指向不存在的模块）。第四条额外查：表本身不能有**值**环。
- 第五个方向：`test/module-registry.test.mjs` 的 `ROW` 正则必须能**读进来**每一个真实文件名 ——
  一个读不进表的文件名，等于一个不受监管的文件名（下划线、子目录斜杠各踩过一次）。

### 覆盖边界：本表的守护在 CI 上**完整生效**，但有 13 条门禁不在 CI 覆盖内

本表自身的 6 条断言（双向一致性、职责列非空、依赖列指向真实模块、无值环、type-only 标签为真）
只用 `fs` + 正则，**CI 上真跑**。

但仓里另有**五个**测试文件的部分断言依赖本机条件。**2026-11-16 用真实模拟重测**
（`git init` 单提交使历史不可达 + `node_modules/typescript` 抛错的桩 + 全套测试）：

| 文件 | 条数 | CI | 为什么 |
|---|---|---|---|
| `test/v201-closure-label-consistency.test.mjs` | 2 | **skip** | 依赖 `scripts/closure.mjs` → typescript |
| `test/v207-retrieve-six-numbers.test.mjs` | 7 | **skip** | 依赖 closure；①b 还额外要历史提交 |
| `test/v208-v207-canred.test.mjs` | 1 | **skip** | 依赖 closure |
| `test/v212-retrieve-no-mutable-state.test.mjs` | 2 | **skip** | 依赖 closure（读 `--declarations` 的 `mutable` 字段）|
| `test/v210-classify-buckets.test.mjs` | **1**（共 7 条）| **skip 1 / 跑 6** | 它**不依赖** typescript（`--classify` 是纯文本多重集比较）。①–⑥ 在 CI 真跑，只有 ⑦ 因缺历史提交 `f9d1abf` 跳 |

合计 **13 条**（12 条因缺 typescript，1 条因缺 git 历史）。判据只看这个差；总数与跑了多少条
**不写在这里**（写死就会过时），由 CI 的 `Test` 步骤把它自己打印进 job summary —— 不必下载日志、也不必本地模拟。

> **订正（2026-11-16）**：上一版这里写「11 条」、并把 `v210` 记成「整文件 skip、内部的 3 条纯函数也不跑」。
> 那是**错的**：`v210` 一行都不碰 typescript，它的 ①–⑥（含三条 can-red）在 CI 上全部真跑。
> 错因是把「缺编译器」和「缺历史提交」两种不同原因并成了一条。
> 判据、理由与「为什么不预生成快照」写在 `ARCHITECTURE.md` 的 **TD-M15**。
> 一句话：**看到 CI 绿，不能推断这 13 条过了。**

## 曾经的门禁漏洞（历史，不是现状）

上一版这里有一节「现状分布（实测，非估计）」，写着「36 个模块（扁平 27 + `store/` 5 + `retrieve/` 4）/ 14,722 行 /
3 个超 800 / 最大 `index.ts`」。它过时了四次（最近一次：`retrieve` 第五步加了 `scene.ts`，表里加了行，
这一节的「36」没跟着变）。**已整节删除**，数字改由测试打印（见上）。

那一节还记录过一个**真漏洞**，值得留着：更早的一版写「扁平一层 / 27 个模块 / 14,211 行 / 最大 `store.ts` 2479」，
而当时 `modulesOnDisk()` 只 `readdirSync` 一层、`ROW` 正则也不接受斜杠 ——
于是 `src/store/*`（5 个）与 `src/retrieve/*`（3 个）**两个方向都看不见**，
双向断言全绿而 8 个模块从未被登记。改法与理由写在 `test/module-registry.test.mjs`
的 `ROW` 与 `modulesOnDisk` 注释里。

这个漏洞的形状值得记住：**扫描器和表用同一种错误方式变瞎，双向一致性就永远绿。**

## 依赖列的两种写法

- `x.ts` —— **值导入**：运行时会真的去执行/取用，成环就是真环；
- `x.ts (type-only)` —— **仅类型导入**：`import type`，产出 JS 时整条消失，不成环。

### 已知的一个仅类型环（不是值环）

`check-cycles.mjs` 实测：本仓 **0 个值依赖环**，存在 **1 个仅类型环**：

```
retrieve.ts -> filter.ts : VALUE       （selectApplicableSkillsDetailed，真的会执行）
filter.ts -> retrieve.ts : type-only   （import type { MemoryHit }，运行时被擦除）
```

**为什么不按值环处理**：TypeScript 的 `import type` 在产出 JS 时整条消失，
所以它不构成运行时环，也就没有死锁/未初始化绑定那类风险。它在类型层面确实耦合
（改一处签名会牵连另一处），但处置方式不同：值环必须拆，类型环可以长期共存，
或在合适时把共享类型抽到第三个文件。

**登记表把它标出来而不是删掉**：表要忠实反映真实耦合；门禁则按值环判 ——
将来真有人把这条变成值导入，表里那一格会从 `(type-only)` 变成裸文件名，diff 里看得见。

## 登记表

| 模块 | 职责（一句话） | 导出 | 依赖（本地模块） |
|---|---|---|---|
| `src/store.ts` | Durable store: skills as structured SKILL.md files, negative paths as JSONL, | `AUDIT_KEEP`, `AUDIT_ROTATE_BYTES`, `CounterEvidenceResult`, `EnvironmentDivergence`, `EvidenceMigrationResult`, `FeedbackResult` …（共 68） | dedupe.ts, edges.ts, extract.ts (type-only), ledger-cache.ts, lock.ts, skill-cache.ts, threat.ts, workspace.ts |
| `src/index.ts` | dsh-memory — capability memory for DSH. | `DEFAULT_RETRIEVAL_FLOOR`, `DEFAULT_RETRIEVAL_THRESHOLD`, `HarvestReport`, `MEMORY_PROTOCOL`, `MemoryConfig`, `STORE_VERSION_MEMORY_FILES` …（共 33） | archive.ts, causal.ts, dedupe.ts, extract.ts, graph.ts, knowledge.ts, layout.ts, ledger-cache.ts, ledger.ts, retrieve.ts, segment.ts, store.ts, suggest.ts, workspace.ts |
| `src/retrieve.ts` | dsh-memory retrieval: lexical recall, then an optional LLM relevance filter. | `COMMIT_DRIFT_WEIGHT`, `CandidateOptions`, `DEFAULT_RETRIEVAL_THRESHOLD`, `DocumentKind`, `FILTER_MAX_CANDIDATES`, `FilterOptions` …（共 44） | edges.ts, extract.ts (type-only), filter.ts, ledger-cache.ts, skill-cache.ts, sqlite-index.ts, store.ts, threat.ts, workspace.ts |
| `src/causal.ts` | CAUSAL RETRIEVAL — src/causal.ts. | `CausalChain`, `CausalGraph`, `CausalGraphEdge`, `CausalGraphNode`, `CausalNode`, `CausalRecordSource` …（共 12） | store.ts |
| `src/extract.ts` | Turn an episode into the four cognitive layers. | `EXTRACT_SYSTEM_PROMPT`, `EvidenceRef`, `ExtractOptions`, `ExtractedExperience`, `ExtractedFact`, `ExtractedNegative` …（共 19） | segment.ts |
| `src/graph.ts` | DYNAMIC TASK GRAPH — the durable shape of "what this task is, right now". | `GOAL_NODE_ID`, `GraphHistoryEntry`, `GraphNode`, `GraphNodeView`, `GraphOp`, `GraphUpdateInput` …（共 22） | graph-v3.ts, knowledge.ts, lock.ts, store.ts |
| `src/graph-v3.ts` | The v3 field surface of the task graph (B2-T1): how a provenance / decomposition / deliberation / back-reference field is judged on the way in and on the way out — one implementation, called from both directions so a written field and a re-read field cannot disagree. | `Author`, `LogPointer`, `EphemeralConstraint`, `PersistentConstraint`, `Alternative`, `PrunedDirection`, `asAuthor`, `resolveNodeV3`, `vanishedFields`, `carryUnknownKeys`, `mergePersistentConstraints`, `drainGraphWarnings` … | — |
| `src/graph-goal-lock.ts` | The lifecycle half of the graph's rules: what the goal lock covers (destination vs journey), the top-level `constrain`/`relax` operations, and when a node's short-lived constraints retire. `graph-v3.ts` judges FIELDS; this module decides LIFECYCLE. | `GOAL_DESTINATION_FIELDS`, `GOAL_JOURNEY_FIELDS`, `classifyGoalUpdate`, `goalLockedReason`, `declareConstraint`, `relaxConstraint`, `retireEphemeral` | graph-v3.ts |
| `src/graph-view.ts` | Read-only views over a task graph: resolved knowledge per node, reverse edges, status counts, the one-line banner. Takes a `TaskGraph` as a parameter so it never needs to know where a store lives, and mutates nothing. | `GraphNodeView`, `describeNodes`, `renderNodeBanner`, `isBlankGraph` | graph.ts, knowledge.ts |
| `src/graph-tool.ts` | The `memory_graph_update` TOOL SURFACE: the JSON schema a model sees and the snake_case → camelCase mapping onto `updateGraph`. Validates nothing itself — every rule lives in graph.ts / graph-goal-lock.ts, so "what is valid" has one answer. | `graphUpdateTool`, `GraphToolDeps` | graph.ts, graph-v3.ts |
| `src/graph-bootstrap.ts` | PLANNING FROM ZERO: validate a whole batch of nodes in memory (`planBootstrap`), decide `isBootstrappable`, build the record to write (`buildBootstrapRecord`), plus the pure helpers a graph's life needs (`makeEmptyGraph`, `harvestingPrompt`, `stampHarvested`). No I/O at all — that is what makes bootstrap's atomicity a property of one write. | `planBootstrap`, `isBootstrappable`, `findBatchCycle`, `buildBootstrapRecord`, `makeEmptyGraph`, `stampHarvested`, `harvestingPrompt` | graph-v3.ts |
| `src/knowledge.ts` | GLOBAL KNOWLEDGE BASE — the layer that stops every workspace being an island. | `KnowledgeEntry`, `KnowledgeQueryHit`, `KnowledgeQueryInput`, `KnowledgeQueryResult`, `KnowledgeRef`, `KnowledgeWriteInput` …（共 17） | extract.ts (type-only), lock.ts, store.ts, threat.ts, workspace.ts |
| `src/sqlite-index.ts` | SQLITE INDEX LAYER — the answer to "the heap cannot hold the corpus". | `IndexDocument`, `SqliteIndex`, `SqliteIndexOptions`, `indexFromRows`, `rebuildIndexFromLedger`, `sqliteAvailable` | — |
| `src/ledger-cache.ts` | LEDGER CACHE — the fix for the measured 41%. | `FLUSH_EVERY`, `FLUSH_INTERVAL_MS`, `LedgerSnapshot`, `TEST_MODE`, `appendRecords`, `clearLedgerCache` …（共 19） | — |
| `src/dedupe.ts` | Dedupe gates for capability memory. | `DEFAULT_ENTITY_ALIASES`, `EntityAliases`, `NegativePlan`, `NegativeRecord`, `SHORT_WHEN_MAX_CHARS`, `SHORT_WHEN_THRESHOLD` …（共 17） | extract.ts (type-only) |
| `src/indexed-store.ts` | INDEXED STORE — the bounded-memory storage adapter. | `IndexedKind`, `IndexedRow`, `IndexedStore`, `IndexedStoreOptions`, `UpsertOutcome` | sqlite-index.ts, store.ts |
| `src/filter.ts` | Stage-2 retrieval filter: one cheap model call decides WHICH candidates apply. | `FILTER_SYSTEM_PROMPT`, `FilterOptions`, `FilterSupersedeDecision`, `FilterVerdict`, `clearFilterCache`, `filterCacheKey` …（共 9） | extract.ts (type-only), retrieve.ts (type-only) |
| `src/hybrid-search.ts` | HYBRID SEARCH — lexical recall first, optional semantic rerank second. | `HybridCandidate`, `HybridOptions`, `HybridResult`, `HybridTrace`, `RerankVerdict`, `Reranker` …（共 9） | — |
| `src/storage-tier.ts` | TIERED RETRIEVAL — one interface, two storage engines, chosen by config. | `RetrievalTier`, `StorageTier`, `TierDocument`, `TierOptions`, `TierStatus`, `createRetrievalTier` …（共 7） | sqlite-index.ts |
| `src/lock.ts` | v0.30 — THE LOCK IS NOW A LEASE, AND THE RACE IS GONE BY CONSTRUCTION. | `LockOptions`, `acquireFileLock`, `forceReleaseLockForTest`, `isLockHeld`, `lockTraceReset`, `lockTraceSnapshot` …（共 7） | lease-bridge.ts, lease-types.ts (type-only) |
| `src/ledger.ts` | Read the slicing plugin's ledgers. | `LedgerSkip`, `LedgerSnapshot`, `SUPPORTED_LEDGER_EPOCH`, `TransferredRecord`, `describeLedgerSkips`, `describeMissingLedgerDir` …（共 7） | layout.ts |
| `src/archive.ts` | v0.21 P1 — skill ARCHIVAL, so the store cannot grow without bound. | `ARCHIVE_FRACTION`, `ArchivePlan`, `DEFAULT_SKILL_LIMIT`, `MERGE_SIMILARITY`, `SkillSummary`, `applySkillArchive` …（共 10） | — |
| `src/segment.ts` | Turn a finished session log into an episode: the small, evidence-carrying | `Episode`, `HUMAN_SOURCE_KIND`, `ModelTarget`, `SegmentError`, `isHumanSourceKind`, `renderEpisode` …（共 8） | — |
| `src/edges.ts` | import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } | `edgeCount`, `getNeighbors`, `hasEdge`, `invalidateEdgeCache`, `migrateLegacyEdges`, `readEdges` …（共 10） | — |
| `src/layout.ts` | THE CROSS-PLUGIN LAYOUT CONTRACT — the only thing dsh-memory and dsh-graft-slice share. | `GRAFT_LEDGER_FILES`, `GRAFT_LEDGER_LAYOUT_VERSION`, `LAYOUT_MANIFEST_FILE`, `LayoutManifest`, `LayoutRead`, `LayoutUnsupportedError` …（共 11） | — |
| `src/workspace.ts` | v0.8 WORKSPACE ISOLATION: a memory may only be injected into the workspace that | `WorkspaceDecisionInput`, `currentWorkspaceOf`, `memoryAllowsWorkspace`, `normalizeWorkspace`, `sameWorkspace`, `workspaceOfSession` | — |
| `src/lease-bridge.ts` | THE BRIDGE TO THE LEASE — dsh-memory/src/lease-bridge.ts. | `LeaseAdapterStatus`, `acquireLease`, `leaseAdapterStatus`, `leaseSpecifiers`, `releaseLease`, `resetLeaseBridgeForTest` | lease-types.ts (type-only) |
| `src/suggest.ts` | The suggest queue: extracted memory waits for a human before it becomes law. | `ApproveResult`, `Suggestion`, `approveSuggestion`, `listSuggestions`, `queueSuggestion`, `rejectSuggestion` | extract.ts (type-only), lock.ts, store.ts |
| `src/zstd.ts` | Minimal DSH v4 session-log reader (independent implementation). | `ParsedSession`, `decompressLog`, `parseSessionLog`, `readSessionLogFile` | — |
| `src/skill-cache.ts` | SKILL DOCUMENT CACHE — shared by the writer (store) and the reader (retrieve). | `CachedDocuments`, `getCachedSkillDocs`, `invalidateSkillDocs`, `setCachedSkillDocs`, `skillDocsCacheStats`, `skillDocsKey` | — |
| `src/threat.ts` | v0.8.1: memory content is DATA, never an instruction. | `scanThreat`, `threatPatterns` | — |
| `src/lease-types.ts` | THE LEASE SHAPES, MIRRORED STRUCTURALLY — dsh-memory/src/lease-types.ts. | `LeaseAdapter`, `LeaseRecord` | — |
| `src/store/skill.ts` | SKILL.md 的读与写：frontmatter 解析/渲染、shapeCache、冲突族。A1 的产物。 | `EnvironmentDivergence`, `SkillBody`, `SkillConflict`, `SkillRecord`, `clearSkillShapeCache`, `clampConfidence` …（共 41） | edges.ts, extract.ts (type-only), ledger-cache.ts, skill-cache.ts, store/clock.ts, store/io.ts, store/layer.ts, threat.ts, workspace.ts |
| `src/store/lifecycle.ts` | 记忆的生命周期：审计轮转、supersede、隔离、反证、技能反馈、迁移。A2 的产物。 | `AUDIT_KEEP`, `AUDIT_ROTATE_BYTES`, `applySkillFeedback`, `applySupersede`, `memoryAuditPath`, `quarantineWorkspaceMemory` …（共 22） | dedupe.ts, edges.ts, store/io.ts, store/skill.ts, threat.ts, workspace.ts |
| `src/store/merge.ts` | 技能合并的写半边：证据并集、冲突边迁移、provenance 双留、审计行。TD-M1。 | `MergeResult`, `mergeSkills` | edges.ts, skill-cache.ts, store/io.ts, store/lifecycle.ts, store/skill.ts |
| `src/store/layer.ts` | JSONL 层写入（facts / experiences）：追加、上限、读回。A3 的产物。 | `appendExperiences`, `appendFacts`, `readLayerRecords` …（共 16） | store/io.ts, store/clock.ts |
| `src/store/io.ts` | IO 原语：原子写、JSONL 读写、目录准备。B 的产物。 | `atomicWrite`, `ensureDir`, `readJsonl`, `readJsonlFresh`, `writeEdge`, `writeEdges` …（共 8） | — |
| `src/store/clock.ts` | 单调时钟接缝：`monotonicTimestamp` 与它的测试重置钩子。第 0 步的产物。 | `monotonicTimestamp`, `resetMonotonicClockForTest` …（共 3） | — |
| `src/thresholds.ts` | 六个决定「召回什么」的数的唯一出处：零 import 的叶子（TD-M6）。 | `FLOOR`, `THRESHOLD`, `MERGE_SIMILARITY`, `TASK_TERM_LIMIT`, `FILTER_MAX_CANDIDATES`, `NEGATIVE_STALE_DAYS` | — |
| `src/console-scope.ts` | 用户报的 P0：「四层（技能/负知识/任务图/飞轮）未按工作区隔离」。技能靠 `memoryAllowsWorkspace` 过滤（与检索同一谓词），其余三层报出各自目录 —— 因为它们**没有** workspace 字段，只能靠目录说明 | `ScopableSkillRecord`, `ConsoleScoping`, `scopeConsoleLayers` | `workspace.ts` |
| `src/generation.ts` | b3-f8：跨代降级的判据（「一代」「被引用」两个定义）与当前代读取。 | `DEFAULT_GENERATION_MODE`, `GENERATION_DOWNGRADE_WEIGHT`, `GenerationMode`, `generationDowngradeFor`, `isReferenced`, `readCurrentGeneration` | — |
| `src/retrieve/interning.ts` | 检索层的共享原语：分词、标题裁剪、证据提取、陈旧负判定、Document 构造。 | `INCIDENT_MARKERS`, `NEGATIVE_STALE_DAYS`, `NEGATIVE_STALE_WEIGHT`, `ageDaysOf`, `clipTitle`, `documentCache` …（共 14） | extract.ts (type-only), skill-cache.ts, workspace.ts |
| `src/retrieve/storage-tier.ts` | 存储选路：json 默认、sqlite 可选；三个模块级 let 与它们的唯一写者同处一模块。 | `currentIndex`, `getStorageTier`, `setStorageTier` …（共 3） | sqlite-index.ts |
| `src/retrieve/commit-cache.ts` | 工作区 commit 归属：按分钟缓存，失败回落到空串；commit 漂移判定的权重常量同处一模块。 | `COMMIT_DRIFT_WEIGHT`, `clearCommitCache`, `currentCommitOf`, `sameCommit` | — |
| `src/retrieve/documents.ts` | 取数层：把 SKILL.md / negatives.jsonl / facts-experiences.jsonl / sqlite 索引行都转成检索用的 Document。L4 整层（8 声明）。 | `ERROR_IDENTIFIER`, `STOPWORDS`, `contentOf`, `layerDocuments`, `looksLikeIncidentLog`, `negativeDocuments`, `skillDocuments`, `tierDocumentOf` | edges.ts, ledger-cache.ts, retrieve.ts (type-only), retrieve/interning.ts, skill-cache.ts, sqlite-index.ts (type-only), store/skill.ts, workspace.ts |
| `src/retrieve/scene.ts` | 场景分类闭环：`sceneCache` 状态 + 它的读写者 + 提示/正则 + LLM 与词法两条分类路径。搬完使 `retrieve.ts` 的模块级可变状态归零。 | `LEGACY_SCENE_HINTS`, `SCENE_PROMPT`, `SCENE_TAG`, `SceneCacheEntry`, `SceneOptions`, `classifyScene`, `clearSceneCache`, `inferScene`, `sceneCache`, `sceneCacheStats` | extract.ts (type-only) |
| `src/retrieve/types.ts` | 契约类型族：检索层与调用方之间的**形状**约定（12 个纯类型声明）。没有一行会执行，所以在值依赖图上是孤立的 —— 第六步搬完使 `retrieve.ts` 里不再混有「只是形状」的行。 | `DocumentKind`, `MemoryHit`, `Document`, `Scored`, `WorkspaceGate`, `TaskAlignmentGate`, `DocumentCacheEntry`, `CandidateOptions`, `HybridRecallOptions`, `RetrieveResult`, `FilterTrace`, `FilterOptions`（共 12） | extract.ts (type-only), filter.ts (type-only) |
