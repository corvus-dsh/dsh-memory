# 模块登记表（source of truth）

> **这张表是"哪些模块存在、各自干什么、依赖谁"的唯一权威。**
> 由 `test/module-registry.test.mjs` 双向守护：磁盘上多一个文件、或表里多一行幽灵，都会红。

## 分母算法（先说清，否则数字没有意义）

- 覆盖目录：`src`（**扁平一层**，没有 `src/core` 子目录）
- 计入条件：文件名 `endsWith('.ts')`
- 实测：**27 个模块 / 14,211 行**
- 三个方向都查：① 磁盘 → 表（新文件不能悄悄进）；② 表 → 磁盘（删掉的行不能留着）；
  ③ 依赖列 → 磁盘（不能指向不存在的模块）。第四条额外查：表本身不能有**值**环。

## 现状分布（实测，非估计）

| 项 | 值 |
|---|---|
| 模块数 | **27** |
| 总行数 | **14,211** |
| > 800 行的文件 | **3** 个（`store.ts` 2479、`index.ts` 2361、`retrieve.ts` 2009） |
| 最大文件 | **`store.ts`** 2479 行（占 **17.4%**） |

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
| `src/graph.ts` | DYNAMIC TASK GRAPH — the durable shape of "what this task is, right now". | `GOAL_NODE_ID`, `GraphHistoryEntry`, `GraphNode`, `GraphNodeView`, `GraphOp`, `GraphUpdateInput` …（共 22） | knowledge.ts, lock.ts, store.ts |
| `src/knowledge.ts` | GLOBAL KNOWLEDGE BASE — the layer that stops every workspace being an island. | `KnowledgeEntry`, `KnowledgeQueryHit`, `KnowledgeQueryInput`, `KnowledgeQueryResult`, `KnowledgeRef`, `KnowledgeWriteInput` …（共 17） | extract.ts (type-only), lock.ts, store.ts, threat.ts, workspace.ts |
| `src/sqlite-index.ts` | SQLITE INDEX LAYER — the answer to "the heap cannot hold the corpus". | `IndexDocument`, `SqliteIndex`, `SqliteIndexOptions`, `indexFromRows`, `rebuildIndexFromLedger`, `sqliteAvailable` | — |
| `src/ledger-cache.ts` | LEDGER CACHE — the fix for the measured 41%. | `FLUSH_EVERY`, `FLUSH_INTERVAL_MS`, `LedgerSnapshot`, `TEST_MODE`, `appendRecords`, `clearLedgerCache` …（共 19） | — |
| `src/dedupe.ts` | Dedupe gates for capability memory. | `DEFAULT_ENTITY_ALIASES`, `EntityAliases`, `NegativePlan`, `NegativeRecord`, `SHORT_WHEN_MAX_CHARS`, `SHORT_WHEN_THRESHOLD` …（共 17） | — |
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
