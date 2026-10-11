# WeKnora → Mastra 一对一移植实现方案

> 架构师：高见远 ｜ 状态：可实施 ｜ 阅读对象：工程师（T01-T05）、QA、主理人
> 事实来源：《research-weknora 知识库域研究》《research-openbot 宿主环境研究》+ 代码库复核（agent-mastra/src/mastra/index.ts、docker-compose、.env.example、WeKnora 目录结构均实地核对）
> 范围：WeKnora 知识库域（摄取/解析/切分/向量化/索引/检索/重排/元数据 + DocReader 客户端）用 TypeScript + Mastra 一对一移植；DocReader 本体（Python gRPC :50051）原样复用；对话/Agent/IM/FAQ/Wiki/图谱不在范围。

---

## 0. 结论速览（TL;DR）

| 决策点 | 结论 |
|---|---|
| 形态 | 新建独立包 `kb-mastra/`（仿 agent-mastra 先例，不入 workspaces，独立 node_modules），Mastra HTTP server 独立进程，替换 kb-service(Go) 作为 `KB_SERVICE_URL` 上游；OpenBot 代理层/P1 检索链路零改动 |
| 包名/端口 | `@openbot/kb-mastra`，端口 **8082**（8081 留给 Go 骨架做契约对照；可用 `KB_PORT` 覆盖） |
| Asynq 替代 | **BullMQ**（Redis）——重试/延迟/幂等消费语义/死信四件套与 Asynq 一一对应；Mastra Workflow 仅作管线结构参考（悬置字段恢复问题），不承载队列 |
| BM25 | **P1 降级纯向量 + RRF 退化**（kw 通道置空数组，融合公式退化为仅向量分支）；`KeywordsRetrieveEngine` 接缝+迁移路径三档（ParadeDB 镜像→zhparser→esbuild WASM）已写明 |
| 向量层 | **自建 embeddings 表（WeKnora 原 schema）+ pgvector 直写 SQL**，不用 @mastra/pg 的 PGVector 抽象（单维表 vs 多维度共存，一对一移植优先） |
| 元数据 | Drizzle ORM + drizzle-kit，表结构 = WeKnora 五表一对一翻译（含软删/UPSERT/回填迁移）；不用 Mastra storage/experimental-knowledge 域 |
| workflow | 不用 Mastra Workflow 做运行时编排；管线为纯 service 函数 + BullMQ job |
| ParseStatus | 7→4 投影：`finalizing→processing`、`deleting/cancelled→failed`；内部保留 7 态全保真 |
| 鉴权 | Bearer API Key（沿用 kb-service 的 `<key>:<tenant>:<role>[:kbIds]` 格式），RBAC 裁剪为 KB 级归属校验 |
| 任务规模 | 5 个任务（T01 基础设施 → T02 解析切分 → T03 摄取索引 → T04 检索重排 → T05 兼容验证） |

---

## 1. 目标与非目标

### 1.1 目标

1. **G-M1 一对一结构对应**：WeKnora 每个模块在 kb-mastra 有唯一对应物，目录能逐目录对照（§3 映射表）。
2. **G-M2 契约零破坏**：上游响应逐字段满足 OpenBot `server/src/knowledge/types.ts` 7 个 wire 类型 + 10 条代理路由语义 + 错误体 `{code,message,request_id}`（§6）。
3. **G-M3 管线保真**：解析→清洗→切分→向量化→索引→检索→融合→重排的步骤顺序、幂等守卫、attempt 世代号语义与 WeKnora 一致（§5）。
4. **G-M4 可验证**：curl 冒烟 + OpenBot 端到端可复跑（§9）。
5. **G-M5 DocReader 直连**：@grpc/grpc-js + proto 生成桩，进程外 :50051 复用（§5.1）。

### 1.2 非目标（主理人裁剪基线）

FAQ / Wiki / 图谱 / 多模态图片任务 / summary / question 后处理（管线位置留空步骤）；ES/Qdrant/Milvus 等外部向量库引擎；多对象存储后端（仅 local）；RBAC 四角色（裁剪为 KB 归属）；Langfuse（剥离留空）；WeKnora 对话/Agent 编排。

---

## 2. 总体架构

```mermaid
flowchart TB
  subgraph OpenBot[OpenBot 宿主（零改动）]
    APP[app 知识库页]
    SRV[server /api/knowledge 代理层<br/>client.ts Bearer+超时]
    P1M[P1 检索中间件/工具]
  end
  subgraph KBM[kb-mastra 独立进程 :8082]
    MW[Mastra server middleware<br/>Bearer 鉴权+requestId]
    API[apiRoutes 十条路由投影]
    HS[handler 服务层]
    SVC[application/service]
    CH[infrastructure/chunker]
    DP[infrastructure/docparser]
    EMB[models/embedding]
    RR[models/rerank + reranking]
    RET[application/service/retriever]
    REP[application/repository Drizzle]
    VEC[repository/retriever/postgres<br/>向量 SQL]
    WKR[BullMQ worker 进程]
    DR[docreader client<br/>@grpc/grpc-js]
  end
  subgraph Dep[外部依赖]
    PG[(Postgres+pgvector<br/>OpenBot data 网络)]
    RD[(Redis data 网络)]
    DOCR[docreader :50051<br/>原样复用]
    OLL[Ollama/OpenAI 兼容]
  end
  APP --> SRV --> MW --> API --> HS --> SVC
  P1M --> MW
  SVC --> CH
  SVC --> DP --> DR --> DOCR
  SVC --> EMB --> OLL
  SVC --> RR
  SVC --> RET --> VEC --> PG
  HS --> REP --> PG
  SVC -- enqueue --> RD -- consume --> WKR --> SVC
```

**形态与部署**：独立目录 `kb-mastra/`（与 agent-mastra 平级，遵循「agent-\*/独立服务不入 workspaces」惯例），内部自成 tsconfig/package.json/node_modules，通过相对路径引 `../shared/logger`（agent-mastra 同款做法）。容器化照抄 casdoor 先例：postgres 用宿主既有 data 网络实例 + init-db.sql 建独立 database/role（`kb_mastra`/`kb_mastra`）+ `CREATE EXTENSION IF NOT EXISTS vector`。docker-compose 增 `kb-mastra` 服务（挂 shared/、depends_on postgres/redis/docreader）、`docreader` 服务（镜像 `wechatopenai/weknora-docreader`，data 网络）、Redis 若无则一并补齐。**换上游 = 改一行 `KB_SERVICE_URL=http://kb-mastra:8082`**，Go kb-service 可保留做契约对照。

---

## 3. 模块映射表（一对一核心）

| WeKnora 源（internal/…） | kb-mastra 对应物 | 一对一说明 |
|---|---|---|
| `cmd/server/main.go` | `kb-mastra/src/index.ts` | 装配 Mastra 实例：vectors/storage 均不配（自建），server{port,middleware,apiRoutes} |
| `internal/router/routes_knowledge.go` | `src/router/routes.ts` | 十条路由注册表（路径/方法/中间件链），路由适配器模式（§6.2） |
| `internal/handler/knowledge{,base,chunk}.go` | `src/handler/{kb,document,chunk,retrieve}.ts` | 请求解析/DTO 校验/错误体构造/响应装配；无业务逻辑 |
| `internal/application/service/knowledge_process.go`（4600+行） | `src/application/service/knowledge-process.ts` | 摄取管线编排：幂等守卫→配置合并→convert→sanitize→sourceIndex→切分→processChunks（§5.2）；按职责拆纯函数文件，合并后等价 |
| `internal/application/service/knowledgebase_search*.go` | `src/application/service/kb-search.ts` | HybridSearch 入口：参数归一化→授权→同模型校验→storeGroup 分组→融合→上下文扩展 |
| `internal/application/service/retriever/composite.go` | `src/application/service/retriever/composite.ts` | CompositeRetrieveEngine：每类 retriever 一个 Promise（p-limit 并发），引擎级失败=丢弃、结果级=结果+error 并存 |
| `retriever/factory.go`/`registry.go`/`ownership.go` | `retriever/factory.ts`/`registry.ts`/`ownership.ts` | 引擎注册与 KB→引擎归属解析（P1 仅注册 postgres） |
| `retriever/keywords_vector_hybrid_indexer.go` | `retriever/hybrid-indexer.ts` | 批量索引入口：向量 UPSERT + BM25 通道（P1 no-op） |
| `internal/application/repository/`（GORM） | `src/application/repository/`（Drizzle） | 五表 CRUD + 软删 + UPSERT（§4） |
| `repository/retriever/postgres/` | `src/application/repository/retriever/postgres/` | vector.ts（pgvector 检索）+ keywords.ts（BM25 接缝）+ index.ts（BatchSave/UPSERT） |
| `internal/types/`（模型+DTO+interfaces/retriever.go） | `src/types/` | 逐类型翻译（GORM→Drizzle 定义、DTO→zod schema、Retriever 接口→TS interface） |
| `internal/infrastructure/chunker/` | `src/infrastructure/chunker/` | 逐文件：splitter/strategy/heading_splitter/heuristic_splitter/patterns/tokens/validator/profiler + parent-child |
| `internal/infrastructure/docparser/` | `src/infrastructure/docparser/` | 引擎路由：simple（本地 md/txt/csv/json）+ builtin（DocReader gRPC）；anydoc/mineru/paddleocr 留 TODO 注册点 |
| `docreader/client/client.go` + `grpc_parser.go` | `src/docreader/client.ts` | @grpc/grpc-js + 生成桩；断线重连；30min 调用超时（WeKnora DOCREADER_CALL_TIMEOUT） |
| `internal/models/embedding/` | `src/models/embedding/` | Embedder 接口（Embed/BatchEmbed/GetModelName/GetDimensions/GetModelID）+ ollama.ts + batch.ts（BATCH_EMBED_SIZE=5）+ concurrency.ts（限流 32） |
| `internal/models/rerank/` + `internal/reranking/` | `src/models/rerank/` + `src/reranking/` | Reranker 接口 + 协议适配（P1 只做 OpenAI 兼容/TEDashscope 形态）+ rerank.ts/mmr.ts/passage.ts |
| `internal/config/` | `src/config/index.ts` | env 解析（§8） |
| `internal/middleware/`（auth/api_key_gate/rbac/kb_access） | `src/middleware/`（auth.ts/api-key.ts/kb-access.ts） | Bearer API Key；RBAC 裁剪为 KB 归属（§7.2） |
| `internal/database/` | `src/db/`（drizzle client + migrate） | — |
| `migrations/`（117 版 golang-migrate） | `drizzle/`（drizzle-kit 生成 + 手写回填） | §4.4 |
| `internal/task/`（Asynq 6池/11队列） | `src/tasks/`（BullMQ） | §5.4 完整语义映射 |
| `internal/infracore/worker/`（子进程 worker） | `kb-mastra/src/index.ts --worker` 或独立 `src/worker.ts` | 同一包两进程形态（--worker 模式只起 BullMQ worker 不起 HTTP） |

**Mastra 组件用法界定**（回应主理人基线 5）：用到的是 Mastra **HTTP server**（`new Mastra({server})` + middleware + apiRoutes，仿 agent-mastra）；**不用** vectors 抽象（自建 embeddings 表直写 SQL——WeKnora 的多维度共存 schema 无法用 PGVector 单维表表达，一对一优先）；**不用** storage/experimental-knowledge 域（那是 agent 记忆图谱，与文档 KB 无关，且元数据表需一一对应 WeKnora schema）；**不用** Workflow 运行时（BullMQ 语义完整覆盖 Asynq；Workflow 的 suspend/resume 对应的是消息等待而非任务重试，见 §5.4 取舍）。

---

## kb-mastra 目录结构

```
kb-mastra/
├── package.json                    # @openbot/kb-mastra，type:module，deps 见 §8
├── tsconfig.json                   # extends ../tsconfig.base.json
├── biome.jsonc                     # 继承根配置（server/src 禁 console 惯例）
├── drizzle.config.ts
├── Dockerfile                      # bun 基础镜像，runner 需装 ca-certificates
├── .env.example                    # §8 全量变量
├── proto/docreader.proto           # 从 WeKnora 拷贝（唯一样本）
├── drizzle/                        # 迁移：0001_init.sql …（回填自 WeKnora 117 版精选）
└── src/
    ├── index.ts                    # 入口：装配 Mastra + apiRoutes（HTTP 模式）
    ├── worker.ts                   # 入口：BullMQ worker（worker 模式，与 HTTP 同包双进程）
    ├── config/index.ts             # env→Config（§8）
    ├── db/
    │   ├── client.ts               # postgres.js Pool + drizzle 实例 + pgvector 解析
    │   └── migrate.ts              # 启动时自动迁移（单实例互斥锁）
    ├── router/routes.ts            # 十条路由注册表（含中间件链）
    ├── handler/                    # HTTP 边界层
    │   ├── kb.ts                   # POST/GET /kb、GET/DELETE /kb/:id
    │   ├── document.ts             # /kb/:id/documents*、/kb/:id/tasks/:taskId
    │   ├── chunk.ts                # /kb/:id/documents/:docId/chunks
    │   └── retrieve.ts             # POST /kb/:id/retrieve
    ├── middleware/
    │   ├── auth.ts                 # Bearer API Key 解析→{tenantId,role,kbScope}
    │   ├── api-key.ts              # key 格式 <key>:<tenant>:<role>[:kbIds]
    │   └── kb-access.ts            # KB 归属校验（tenant+kbScope+role）
    ├── application/
    │   ├── service/
    │   │   ├── knowledge-process.ts     # 摄取管线（幂等守卫+convert+sanitize+chunk+embed+index）
    │   │   ├── knowledge-create.ts      # 三入口分发：file/url/manual(text)
    │   │   ├── knowledge-delete.ts      # 级联删除（chunks→embeddings→knowledge 软删）
    │   │   ├── kb-service.ts            # KB CRUD + 配额
    │   │   kb-search.ts             # HybridSearch 编排
    │   │   ├── task-service.ts          # 任务状态查询（tasks 投影视图）
    │   │   └── retriever/
    │   │       ├── composite.ts         # CompositeRetrieveEngine
    │   │       ├── factory.ts / registry.ts / ownership.ts
    │   │       └── hybrid-indexer.ts    # BatchIndex（向量 UPSERT + BM25 no-op 通道）
    │   └── repository/                  # Drizzle 仓储：kb.ts/document.ts/chunk.ts/embedding.ts/task-view.ts
    │   └── repository/retriever/postgres/
    │       ├── vector.ts                # pgvector HNSW <=> 余弦检索
    │       ├── keywords.ts              # BM25 接缝（P1 no-op，返回空集）
    │       └── index-writer.ts          # BatchSave 40/批 + UPSERT ON CONFLICT
    │   └── interfaces/retriever.ts      # Retriever 接口（types/interfaces/retriever.go 对应物）
    ├── infrastructure/
    │   ├── chunker/                # splitter/strategy/heading/heuristic/patterns/tokens/validator/profiler + parent-child
    │   └── docparser/              # registry.ts（引擎路由）+ simple.ts + builtin-grpc.ts
    ├── docreader/client.ts         # gRPC 客户端（生成桩 import）
    ├── docreader/generated/        # protoc 产物（.d.ts + js），提交入库
    ├── models/
    │   ├── embedding/              # embedder.ts(接口)/ollama.ts/batch.ts/concurrency.ts/sanitize.ts
    │   └── rerank/                 # reranker.ts(接口)/openai-compat.ts/transport.ts
    ├── reranking/                  # rerank.ts/mmr.ts/passage.ts
    ├── tasks/                      # BullMQ：queue.ts/worker.ts/document-process.ts（attempt 幂等）
    └── types/                      # 领域类型 + zod DTO + wire 类型镜像（对齐 OpenBot types.ts）
```

---

## 4. 数据模型（WeKnora 五表一对一翻译）

存储 = OpenBot 宿主 postgres（data 网络）独立 database `kb_mastra`，扩展 `vector`（宿主 pgvector-partman 镜像自带；`CREATE EXTENSION IF NOT EXISTS vector`，**不装 pg_search**）。

| WeKnora 表 | Drizzle 表 | 关键翻译点 |
|---|---|---|
| `knowledge_bases` | `knowledgeBases` | chunking_config/indexing_strategy JSONB→`jsonb().$type<…>()`；embedding_model_id/vector_store_id 创建后不可改（service 层守卫）；软删 `deletedAt` |
| `knowledges` | `knowledges` | type ∈ file/url/manual（faq 裁剪）；parse_status **内部 7 态全保真**：`pending/processing/finalizing/completed/failed/deleting/cancelled`；file_hash 用于 SHA256 去重（tenant+kb+hash 唯一） |
| `chunks` | `chunks` | start_at/end_at 不变量（End-Start==Content.length）；pre/next 链表；chunk_type P1 仅 `text`+`parent_text`（其余枚举值保留，写入留空步骤）；source_locators jsonb；content_revision + chunk_revisions 历史表 |
| `embeddings` | `embeddings` | **保留 WeKnora 原样**：source_id+source_type UNIQUE（UPSERT 键）、dimension INTEGER 无固定维度、embedding halfvec 表达式索引。⚠️ Drizzle 无 halfvec 内建类型 → `customType`（`halfvec(${dimension})`，parse/Stringify）。HNSW 表达式部分索引：**drizzle-kit 不支持表达式索引** → 迁移 SQL 手写（0002_embeddings_index.sql），配 `CREATE INDEX … ON embeddings USING hnsw ((embedding::halfvec(3584))) WHERE dimension = 3584`（3584/798 两档照抄） |
| `chunk_revisions` | `chunkRevisions` | 不可变历史，仅追加 |
| `tasks`（WeKnora 无独立表） | **task_view 视图/查询** | WeKnora 语义=parse_status+spans；P1 投影：knowledges 行 + 摄取管线内存进度（BullMQ job progress 回写 knowledges.progress jsonb）→ 前端 KnowledgeTask DTO。契约缺口（kb-service GetTask 是 WeKnora 没有的单端点）在 P1 由「knowledges 行快照+job progress」补齐 |

**软删+唯一索引坑**（WeKnora 同款处理）：部分唯一索引 `WHERE deleted_at IS NULL`，Drizzle 支持 partial unique index。

**迁移策略**：drizzle-kit generate 起骨架，WeKnora 117 版中知识库域必需的 DO $$ 条件块/扩展初始化改写为手写 SQL 迁移；版本表 `drizzle.__drizzle_migrations` 由工具管理。启动时 `migrate.ts` 互斥锁（pg_advisory_lock）防多实例竞争。

---

## 5. 关键数据流设计

### 5.1 解析（convert）——DocReader 复用

```
resolveParser(fileType):
  md/txt/csv/json → simple.ts（本地 fs 读取，直译 WeKnora Go 本地解析）
  其他（pdf/docx/pptx/xlsx/html/epub…） → builtin-grpc.ts → docreader/client.ts
  anydoc/mineru/paddleocr_vl → TODO 注册点（P1 不注册，走 builtin 兜底）
```

DocReader 客户端：
- proto 从 `WeKnora/docreader/` 拷贝到 `kb-mastra/proto/docreader.proto`（唯一样本，docreader 服务契约不可变）
- 生成：`grpc_tools_node_protoc`（或 buf）生成 `src/docreader/generated/`，**产物提交入库**（与 biome 隔离）
- 调用：`Read`（≤50MB）；大 PDF 预留 `ReadStream` 分帧接缝（P1 用 Read+50MB 上限，超限 422）
- 超时：调用层 30min（DOCREADER_CALL_TIMEOUT=30m 对齐 WeKnora），客户端侧 grpc deadline 实现；重连：channel idle 后重建（对齐 grpc_parser.go 断线重连语义）
- 环境变量：`DOCREADER_ADDR=docreader:50051`（与 WeKnora 同名同义）
- ⚠️ 风险自验（research-openbot 结论：bun+grpc-js 无本仓先例）：T01 设冒烟步骤 `node/bun 起客户端→Read 一个 PDF`；若 bun 运行时出问题，回退方案 = worker 进程用 node 运行（package.json script 分 node/bun 两档），HTTP 进程不引 grpc-js（只 worker 引，天然隔离）

### 5.2 摄取管线（Asynq→BullMQ，语义一一对应）

```
POST /kb/:id/documents（file/url/text）
→ handler 解析（multipart: 字段名 file；url/text JSON）
→ knowledge-create.ts：
    类型白名单 → SHA256(tenant+kb+file_hash) 去重 → 配额检查
    → 存 local（STORAGE_TYPE=local, STORAGE_LOCAL_PATH）
    → knowledges 行 parse_status=pending
    → queue.add("document:process", payload, {attempts: 4(=MaxRetry 3+1), backoff: exponential 200ms*2^n})
→ 202 {task_id=knowledgeId, doc_id}
```

**DocumentProcessPayload**（对齐 WeKnora 字段）：`{requestId, tenantId, knowledgeId, kbId, filePath, fileName, fileType, url, fileUrl, passages, enableMultimodel:false, enableQuestionGeneration:false, questionCount:0, language, attempt}`。**attempt 世代号**：reparse 时 knowledge 行 attempt+1，payload 携带；worker 拿到后与 DB 比对，**不等则跳过**（attemptSuperseded）——幂等核心，直译。

**worker document-process.ts 主流程**（对应 WeKnora ProcessDocument）：
```
幂等守卫：deleting/cancelled/completed/attemptSuperseded/sourceReplaced → ack 跳过
resolveProcessConfig（KB chunking_config + 上传覆盖合并：chunkSize=512/overlap=80/separators/strategy）
→ parse_status=processing
→ convert()（§5.1 引擎路由）
→ sanitize（UTF-8 清洗/NormalizeLineEndings/NormalizeHTMLTables 直译）
→ buildSourceIndex（SourceBlock rune 偏移 → chunk 级 source_locators，PDF page/bbox 归一化坐标）
→ chunker（strategy 五档；P1 实现 auto/heading/heuristic/recursive，legacy 降级路径）
   父子切分：ParentChunkSize=4096/ChildChunkSize=384（父块入库不进索引）
→ parse_status=finalizing（内部 7 态）
→ processChunks：
    清旧 chunks+embeddings（幂等）→ CreateChunks
    → buildKnowledgeIndexContent（标题+ContextHeader+Content）
    → IndexInfo{Content, SourceID=chunkID, SourceType, ChunkID, KnowledgeID, KnowledgeBaseID, TagID, IsEnabled}
    → sanitizeForEmbedding（剥 base64/截 20000 字符）
    → batchEmbedWithBackoff（batch 5 + p-limit 32；失败重试 5 次指数退避 200ms）
    → BatchSave（40 条/批，UPSERT ON CONFLICT (source_id,source_type)）
    → BM25 通道 no-op（hybrid-indexer 内空实现，见 §5.3）
→ parse_status=completed / failed（error_message）
→ [空步骤] 多模态 fan-out / summary / question / graph —— 管线位置保留，直接跳过
```

**死信语义**：BullMQ attempts 耗尽 → worker 的 `failed` 事件钩子写 `parse_status=failed` + `error_message`（对应 WeKnora task_dead_letters 中间件）。**重试期间不可见问题**：Asynq 的 job 在重试等待中可查询；BullMQ delayed job 同样可查（queue.getJob(id).getState()=delayed），task-service 投影时 delayed/active/failed→processing/failed 对应换算（§6.3）。

### 5.3 检索链路（与 WeKnora 逐步对应）

```
POST /kb/:id/retrieve {query, top_k=5, score_threshold, hybrid=true, rerank}
→ handler zod 校验 → kb-search.ts HybridSearch：
    QueryEmbedding = embedder.embed(query)（一次）
    → CompositeRetrieveEngine.Retrieve：
        vector.ts：pgvector 查询
          SET LOCAL hnsw.ef_search → topK' = clamp(top_k,100,200)（expandedTopK）
          → SELECT … ORDER BY embedding::halfvec(dimension) <=> $vec LIMIT topK'
          → score = 1 - distance；distance <= 1 - threshold 过滤
        keywords.ts：P1 返回 []（BM25 降级通道，§7.1）
    → fuseOrDeduplicate（对齐 WeKnora 三分支）：
        仅向量（P1 实际分支）→ 余弦分 + ChunkID 去重取最高分 → top_k 截断
        仅关键词 → 列表最高分归一化[0,1]（P1 不会触发，代码保留）
        混合 → 加权 RRF score=0.7/(60+rank_v)+0.3/(60+rank_k)（P1 kw 空数组自然退化，代码保留）
    → processSearchResults：批量取 chunk + 上下文扩展（P1 仅相邻链表扩展：pre/next 各一跳；父子扩展留接缝）
    → assembleSearchResults → SearchResult{content,score,match_type,knowledge_title,…,source_locators}
    → rerank.enabled（默认 false，与 kb-service 契约一致）：
        候选池 max(top_k,50) → 截断 200 → ModelPassage（标题+正文）→ fitPassages rune 上限
        → Reranker.rerank（OpenAI 兼容协议，relevance_score/score、document.text 双形态兼容；超时 60s）
        → 阈值 0.2 过滤（全灭降级 *0.7 下限 0.3，仍全灭保底 0.15——直译）
        → 模型失败优雅降级保持检索序
        → SelectMMR（token-Jaccard lambda=0.7，gojieba→Intl.Segmenter 分词替代）
→ 路由适配器投影为 RetrieveResponse{results, count}（§6.2）
```

### 5.4 Asynq→BullMQ 语义映射表（决策依据）

| Asynq 能力 | BullMQ 对应 | 备注 |
|---|---|---|
| 队列+优先级（11 队列） | named queues（P1 仅 `kb:core` 一个） | WeKnora 6 池是全量业务;P1 单管线单队列足够，队列名常量集中管理留扩展 |
| MaxRetry 3 | attempts 4 + exponential backoff | 数值对齐 |
| 死信中间件（task_dead_letters+failed） | worker failed 事件→parse_status=failed | §5.2 |
| attempt 幂等 | payload.attempt 世代号 + DB 比对 | 直译，与 BullMQ attempts 正交 |
| 死信表查询 | queue.getFailed()（P1 不暴露 API） | 内部运维用 |
| 进度 | job.updateProgress → 回写 knowledges.progress jsonb | task-service 投影源 |

**为何不用 Mastra Workflow**：Workflow 的 suspend/resume 设计面向「等人/等事件」的长流程；摄取管线需要的是「重试+死信+幂等重放」的任务队列语义，Workflow 的 createRun 无内建重试/死信，且 run 状态在 Mastra storage 域（我们又决定不用它）。BullMQ 的 Redis 语义与 Asynq 一一对应、docker-compose 只需一个 Redis。管线代码结构上仍按 WeKnora ProcessDocument 的步骤边界组织为纯函数序列（convert/sanitize/chunk/embed/index 各自可单测），未来若要 Workflow 化是平移而非重写。

---

## 6. 兼容接口约定（OpenBot 侧零改动）

### 6.1 十条路由投影（WeKnora API 面 → kb-mastra 10 路由）

kb-mastra 对外只暴露 OpenBot 代理层认识的 10 条（`/kb` 前缀，无 `/api/v1`；与 kb-service 同形）：

| # | kb-mastra 路由 | 处理 | 对应 WeKnora 语义 |
|---|---|---|---|
| 1 | `POST /kb` | 建 KB | POST /knowledge-bases（裁剪：name/description/embedder/chunk_size/chunk_overlap/rerank_model） |
| 2 | `GET /kb` | 列表 | GET /knowledge-bases → `{items,count}` |
| 3 | `GET /kb/:id` | 详情+doc_count | GET /knowledge-bases/:id |
| 4 | `DELETE /kb/:id` | 删 KB（级联软删） | DELETE /knowledge-bases/:id |
| 5 | `POST /kb/:id/documents` | 上传（multipart file / url / text） | POST /:id/knowledge/file\|url\|manual 三入口合一（multipart 或 JSON 分发） |
| 6 | `GET /kb/:id/documents` | 文档列表 | GET /:id/knowledge（过滤分页）→ `{items,count}` |
| 7 | `GET /kb/:id/documents/:docId` | 文档详情 | GET /knowledge/:id |
| 8 | `DELETE /kb/:id/documents/:docId` | 删文档 | DELETE /knowledge/:id（级联清 chunks+索引） |
| 9 | `GET /kb/:id/tasks/:taskId` | 任务状态 | **WeKnora 无单端点**（parse_status+spans+Asynq 内省）→ task-service 投影（knowledges 行+job progress → KnowledgeTask DTO） |
| 10 | `POST /kb/:id/retrieve` | 检索 | POST /:id/hybrid-search → 路由适配器投影（§6.2） |

内部实现完整 WeKnora 语义，对外 10 路由 = **路由适配器模式**投影层：`handler/` 只做 DTO 转换，不承载业务。

### 6.2 wire 类型逐字段对照（types.ts 7 类型）

| OpenBot 类型 | kb-mastra 来源 | 注意点 |
|---|---|---|
| `KnowledgeBase` | knowledgeBases 行 | chunk_size/chunk_overlap 从 chunking_config JSONB 取默认；doc_count 实时 COUNT；created_at/updated_at ISO 8601 |
| `KnowledgeDocument` | knowledges 行 | `source` 字段：OpenBot 是 `file\|url\|text`，WeKnora 是 `file\|url\|manual\|faq` → **manual→text 映射**（出向），入向 text→manual |
| `KnowledgeTask` | task-service 投影 | status 映射见 6.3；progress 0-100；chunks_done/chunks_total 来自管线进度回写 |
| `KnowledgeSearchResult` | assembleSearchResults | chunk_id/doc_id/content/score/source/metadata（source=knowledge.source；metadata 携带 title/filename/chunk_index/source_locators） |
| `ParseStatus`（4 态） | 内部 7 态投影 | 见 6.3 |
| `ListEnvelope` | `{items,count}` | 路由 2/6 |
| `RetrieveResponse` | `{results,count}` | 路由 10 |

**错误体**：所有非 2xx → `{code, message, request_id}`；requestId 由 middleware 生成（或透传 x-request-id），贯穿日志。状态码约定照抄 kb-service：400/401/403/404/409/422/429/500/503。

### 6.3 ParseStatus 7→4 投影（决策）

| 内部态 | 对外 (OpenBot 4 态) | 理由 |
|---|---|---|
| pending | pending | 直映 |
| processing | processing | 直映 |
| finalizing | **processing** | 「写索引收尾」对用户仍是进行中；OpenBot 前端轮询语义不变（processing→completed 单调跳变） |
| completed | completed | 直映 |
| failed | failed | 直映 |
| deleting | **failed** | OpenBot 无 deleting 态；删除是终局动作，投影为 failed 可让前端停止轮询（error_message="deleting"）；DELETE 调用本身同步返回 {deleted:true} |
| cancelled | **failed** | 同上，error_message="cancelled"；与 kb-service 现行为一致（kb-service 无取消功能，直接 failed） |

投影发生在 handler 出向序列化处（单向函数 `toWireParseStatus()`）；内部 7 态全保真存储，P2 若 OpenBot 扩态无需迁移。

### 6.4 P1 检索链路兼容（零改动验证点）

- 检索响应 `{results:[{chunk_id,doc_id,content,score,source,metadata}],count}` —— P1 中间件的 RetrievedChunk（title=metadata.title?…、score 原始值、content）全部可从投影结果取到；
- 错误体非 2xx 时 OpenBot client.ts 折 503 → P1 熔断计数 5xx/429 —— kb-mastra 需保证 5xx/429 真实语义（上游 embedder 超时→503，限流→429）；
- `hybrid=true` 参数必须接受（P1 中间件固定传 true）——即使 BM25 降级，参数解析不得 422；
- multipart 字段名 `file`（前端 uploadDocumentFile 约定）。

---

## 7. 关键技术决策与注意事项

### 7.1 BM25 降级决策（P1 纯向量 + 接缝）

**决策**：P1 `KeywordsRetrieveEngine` 实现为返回空数组的 no-op（接口、注册、融合分支代码全部保留）。理由：① OpenBot 宿主 postgres 未带 pg_search（ParadeDB），换镜像影响 casdoor/主库等全部依赖该实例的服务，代价不可控；② 一对一移植优先级在「检索链路结构保真」，kw 通道空数组时 RRF 公式自然退化为仅向量分支，融合/去重/截断逻辑不变；③ 中文分词替代（zhparser 编译/ES/WASM）各有部署代价，P1 不引入。

**接缝与迁移路径（三档，P2 任选）**：
1. **ParadeDB 独立实例**：kb-mastra 配第二数据源指向 paradedb 镜像 postgres（仅存 embeddings BM25 副本表），`|||`/`score()`/`chinese_lindera` SQL 原样恢复——代码层只需 keywords.ts 从 no-op 换真实实现；
2. **zhparser + tsvector**：宿主 postgres 装 zhparser 扩展，to_tsvector 替代，分数用 ts_rank 归一化模拟 BM25 排序；
3. **esbuild WASM jieba**（进程内，无部署依赖）：分词自管 + 倒排表自建（代价最大，兜底）。

### 7.2 鉴权与租户隔离（RBAC 裁剪）

- `Authorization: Bearer <apiKey>`，key 格式沿用 kb-service：`<key>:<tenant_id>:<role>[:kb1,kb2;…]`，`;` 分隔多 key（env `KB_API_KEYS`）。
- role ∈ read/write/admin：read=检索+读；write=+上传/删文档；admin=+建/删 KB（对齐 kb-service 三档，即 WeKnora 能力 retrieve/ingest/manage_kbs 的粗粒度投影）。
- **租户隔离强制**：所有仓储查询 WHERE tenant_id（对齐 WeKnora「不信任客户端传参」）；kbScope 白名单非空则叠加 kb_id IN。
- 越权语义：跨 tenant 404（不泄漏存在性，对齐 kb-service 行为）、role 不足 403。
- JWT/RBAC 四角色/KBAccess 细粒度 → TODO 接缝（middleware 结构留位）。

### 7.3 SSRF 防护直译

URL 入口（POST documents type=url）必须有 ValidateURLForSSRF 等价物：协议白名单 http/https、私网/环回/链路本地 CIDR 拒绝、DNS 解析后 IP 复查（防 DNS rebinding）、重定向逐跳校验、响应大小/超时上限。WeKnora 有完整实现，TS 直译 + 单测（T02 验收项）。

### 7.4 其它直译注意点

- **chunk 不变量**：end_at-start_at==content.length（rune 计数），validator 直译并单测；
- **UPSERT 键**：(source_id, source_type) UNIQUE，BatchSave 40/批；
- **sanitizeForEmbedding**：剥 base64 数据 URI、截 20000 字符（对齐）；
- **并发**：ants 池→p-limit（embed 32、batch 5、索引批 5 并发）；
- **MMR 分词**：gojieba→`Intl.Segmenter("zh")`（仅影响 token-Jaccard 相似度，无功能等价性风险）；
- **时间**：一律 ISO 8601 UTC 字符串出向；
- **日志**：pino（shared/logger），结构化 type 命名沿用 OpenBot 惯例（kb-retrieve-hit / kb-ingest-completed 等），requestId 贯穿；
- **biome**：kb-mastra/src 禁 console（对齐 server 惯例）；
- **测试**：bun test，测试与实现同目录；chunker/sanitize/RRF/MMR 纯函数必须单测（WeKnora 同款用例可平移参考）。

### 7.5 已知风险清单

| 风险 | 缓解 |
|---|---|
| bun + grpc-js 无本仓先例 | T01 冒烟步骤先行验证；回退：worker 用 node 运行（脚本双档），HTTP 进程不引 grpc |
| halfvec 表达式索引手写 SQL | 迁移文件独立 review；启动时 describeIndex 自检 |
| WeKnora 源 4600 行管线的翻译遗漏 | 幂等守卫/attempt/失败路径三类用例必须单测覆盖；对照 WeKnora 测试文件名平移用例 |
| BullMQ 与 Asynq 语义细差（重试可见性） | task-service 投影时 delayed/active→processing 映射已定义（§5.2） |
| Mastra server 中间件能力差异（multipart/大 body） | T01 验证 apiRoutes 的 multipart 支持；不足则在 middleware 层手写 body 解析（busboy）兜底 |
| OpenBot postgres 同时承载 casdoor/主库/kb | data 网络独立 database+role 隔离；索引/查询走 kb_mastra 库，互不干扰 |

---

## 8. 配置与依赖

### 8.1 环境变量（.env.example 新段）

```
# ── kb-mastra（WeKnora→Mastra 移植，替换 kb-service）──
KB_PORT=8082
# DB（复用 OpenBot postgres 实例，独立 database/role）
KB_DATABASE_URL=postgres://kb_mastra:***@postgres:5432/kb_mastra
KB_REDIS_URL=redis://redis:6379
# 鉴权：格式 <key>:<tenant>:<role>[:kb1,kb2]，; 分隔多 key（与 kb-service 同形）
KB_API_KEYS=sk-kb-dev-001:tenant-a:admin
# DocReader（原样复用）
DOCREADER_ADDR=docreader:50051
DOCREADER_CALL_TIMEOUT_MS=1800000
# Embedding
OLLAMA_BASE_URL=http://ollama:11434
KB_EMBED_MODEL=<model-name>
KB_EMBED_DIMENSIONS=1024            # 用于建 HNSW 表达式索引档位
BATCH_EMBED_SIZE=5
KB_EMBED_MAX_CONCURRENCY=32
# Rerank（可选）
KB_RERANK_ENABLED=false
KB_RERANK_URL=
KB_RERANK_MODEL=
# 存储（P1 仅 local）
STORAGE_TYPE=local
STORAGE_LOCAL_PATH=/data/kb-files
MAX_FILE_SIZE_MB=50
# 检索默认值（对齐 WeKnora tenants.retrieval_config）
KB_VECTOR_THRESHOLD=0.15
KB_KEYWORD_THRESHOLD=0.3
KB_DEFAULT_TOP_K=50
KB_RERANK_TOP_K=10
KB_RERANK_THRESHOLD=0.2
```

OpenBot 侧唯一改动：`.env.example` 的 `KB_SERVICE_URL` 指向 `http://kb-mastra:8082`（注释里给两档示例）。

### 8.2 依赖清单（kb-mastra/package.json）

```
@mastra/core@^1.64.0        # 与 server 同版本基线（API 同形；如升 1.75.x 需回归 agent 注册面，P1 不升）
mastra@^1.33.0              # CLI/dev（对齐 agent-mastra）
zod@^3.x                    # DTO（Standard Schema 兼容）
postgres-js（postgres@^3）  # pg 驱动 + pgvector 值解析
drizzle-orm@latest + drizzle-kit
bullmq@^5 + ioredis@^5
@grpc/grpc-js@^1.14 + @grpc/proto-loader（或 protoc 生成桩）
p-limit@^6
pino（经 ../shared/logger）
nanoid / crypto（SHA256）
```

devDeps：typescript、@types/node、grpc-tools（protoc 生成）、biome。

---

## 9. 运行与验证方式（用户要求⑦）

**冒烟（kb-mastra 单独）**：
1. `docker compose up -d postgres redis docreader`（docreader 用 wechatopenai/weknora-docreader 镜像）；
2. `cd kb-mastra && bun install && bun run db:migrate && bun run dev`（HTTP）+ `bun run worker`；
3. curl 序列（Bearer sk-kb-dev-001）：建库 → 上传 text → 轮询 GET /kb/:id/tasks/:taskId 至 completed → POST retrieve 命中 → 删除 → 404；
4. 越权：第二把 key（tenant-b）访问 tenant-a 的 kb → 404；read 角色建库 → 403。

**端到端（OpenBot 零改动验证）**：
5. `.env` 设 `KB_SERVICE_URL=http://localhost:8082`（及 P1 四变量），起 OpenBot server+app；
6. 前端知识库页走完「建库→上传→解析完成→检索测试→删除」；
7. 对话提问 → P1 中间件日志出现 knowledge-retrieval-hit 且回答带 [n] 引用；
8. `docker stop kb-mastra` → 对话不中断（G4 降级）。

**回归**：`cd kb-mastra && bun test`；`cd server && bun run typecheck`（应零改动零影响）。

---

## 10. 任务分解（给工程师，5 个任务线性链）

| ID | 名称 | 内容 | 依赖 | 验收 |
|---|---|---|---|---|
| T01 | 包骨架+DB+DocReader 冒烟 | 目录/package.json/tsconfig/biome/Dockerfile；config 模块；Drizzle 五表+迁移（含手写 HNSW/halfvec SQL）；Mastra server 骨架+middleware（鉴权+requestId）+ /health；docreader proto 拷贝+生成桩+客户端冒烟（Read 一份 PDF，验证 bun+grpc-js；失败触发 node 回退档）；docker-compose 增 kb-mastra/docreader/redis | 无 | compose 起→/health 200；migrate 幂等重跑；grpc 冒烟记录结论（bun 或 node 档） |
| T02 | 解析+切分层 | docparser（simple+builtin 路由+引擎注册表）；SSRF 防护直译；chunker 全量纯函数（splitter/strategy 五档/heading/heuristic/patterns/tokens/validator/parent-child） | T01 | bun test：chunker 用例对齐 WeKnora 行为（512/80/分隔符/标题面包屑/父子 4096/384/不变量校验）；SSRF 用例；simple+grpc 双路解析产出 markdown+SourceBlock |
| T03 | 摄取管线+索引 | knowledge-create（三入口+SHA256 去重+配额+local 存储）；BullMQ queue/worker；DocumentProcessPayload+attempt 幂等；processChunks（清旧→建 chunk→index content→batchEmbedWithBackoff→BatchSave UPSERT）；progress 回写；死信→failed | T02 | curl 上传→轮询 completed→DB 验 chunks+embeddings 行数与 UPSERT 幂等（重跑不翻倍）；kill docreader 中途→重试→failed 路径；attempt 并发竞态用例 |
| T04 | 检索+重排+对外 10 路由 | embedding/rerank 客户端；retriever（composite+factory+postgres vector+keywords no-op）；RRF 融合三分支；上下文扩展；MMR；kb-search 编排；handler+router 十条路由+错误体+ParseStatus 投影+task-service 投影 | T03 | §9 冒烟 1-4 全过；对 kb-service（Go）同输入 diff 响应 JSON 结构逐字段一致；越权/角色/422/429 用例 |
| T05 | OpenBot 端到端+回归 | .env 切换上游；P1 链路回归（中间件 hit/引用/降级）；Go kb-service 对照留存说明；README（运行/回退） | T04 | §9 端到端 5-8 全过；server typecheck/biome 零改动；文档含回退步骤（KB_SERVICE_URL 指回 :8081 即回滚） |

依赖图：`T01 → T02 → T03 → T04 → T05`（线性，无并行需求）。

---

## 11. 待明确事项（假设，请主理人确认）

- **A1** BM25 P1 降级纯向量（§7.1）——中文关键词召回在 P1 缺失，若不可接受需提前决策 ParadeDB 独立实例（影响 T01 compose）。
- **A2** embedding 模型与维度由部署决定（`KB_EMBED_MODEL/KB_EMBED_DIMENSIONS`）；WeKnora 多维度共存 schema 已保真，但 P1 实际只建一档 HNSW 索引。
- **A3** ParseStatus 投影（§6.3）：deleting/cancelled→failed 是为兼容 4 态的妥协，P2 OpenBot 扩态后可直出。
- **A4** rerank 默认关闭（对齐 kb-service 契约）；WeKnora 的租户级 rerank 配置继承机制 P1 不实现（KB 级 rerank_model 字段保留）。
- **A5** chunk 上下文扩展 P1 仅相邻链表一跳；父子扩展（命中子块返回父块）代码接缝在 kb-search，P1.5 可加。
- **A6** docreader 镜像 `wechatopenai/weknora-docreader` 需要 JVM/LibreOffice/Playwright，资源开销大（§研究 6.2）；若部署环境受限，P1 可先用 simple 引擎（md/txt）+ 上传文本为主，PDF 路径待 docreader 就绪。
- **A7** 8081（Go kb-service）保留为契约对照与回退位，不删除；正式切换后建议保留一个冒烟标记任务。
