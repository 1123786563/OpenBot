# kb-mastra 设计 Qdrant 增量修订

> 架构师：高见远 ｜ 修订基线：`weknora-mastra-migration-design.md`（v1）+ 主仓 commit ab0ec4b（Postgres→Qdrant 向量迁移）
> 事实核对（已实地复核）：compose `qdrant` 服务 = `qdrant/qdrant:1.19.2`、networks [data]、`127.0.0.1:6333` loopback、`qdrant-data:/qdrant/storage` 卷、`wget /healthz` healthcheck；主仓 `.env.example` 已有 `QDRANT_URL=http://localhost:6333` / `QDRANT_API_KEY=`（注释明示 Qdrant 是唯一向量库）；postgres 为 `openbot-postgres` 自建镜像（partman overlay 仅为 lago profile），**vector 扩展确认不可用且 compose 测试断言 pgvector 不得回潮**；仓内尚无任何 Qdrant TS 消费方——kb-mastra 是第一个。
> 性质：增量修订，只替换与向量存储相关的段落；BullMQ/DocReader gRPC/契约投影/鉴权/SSRF/检索融合重排算法**均不受影响**。

---

## 1. 修订摘要表

| # | 原设计位置 | 修订内容 |
|---|---|---|
| R1 | §4 数据模型 · embeddings 表 + 手写 HNSW halfvec SQL 迁移 | **删除 embeddings 表**（Qdrant 唯一向量真源），PG 只剩四张元数据表；HNSW 迁移 SQL 整体移除，由 Qdrant collection `hnsw_config` 承担 |
| R2 | §4 · 启动 describeIndex 自检 | 改为 **ensureCollection 启动自检**（存在性+维度+distance 校验+payload 索引幂等声明） |
| R3 | §5.2 processChunks · BatchSave 40/批 UPSERT | 改为 **Qdrant `PUT /collections/{c}/points?wait=true` 批量 upsert**（40/批，point id=chunk UUID 天然幂等覆盖） |
| R4 | §5.2 · 清旧索引幂等（SQL DELETE） | 改为 **Qdrant delete-by-filter(doc_id+tenant_id)**；删除顺序统一「先 Qdrant 后 SQL」（A15） |
| R5 | §5.3 · repository/retriever/postgres/vector.ts（pgvector `<=>` + halfvec 表达式索引 + SET LOCAL ef_search） | 改为 **repository/retriever/qdrant/vector.ts**（`POST /points/query` + filter must；score=similarity 与原语义对齐；阈值应用侧过滤） |
| R6 | §3 模块映射表 + 目录结构 · postgres 检索引擎目录 | 目录重构为 `src/infrastructure/qdrant/`（薄 REST 客户端+collections 自检）+ `src/application/repository/retriever/qdrant/`（vector/index-writer/cleanup）；keywords no-op 挪至 `retriever/keywords.ts`（引擎无关） |
| R7 | §7.1 BM25 迁移路径① | 微调：ParadeDB 独立实例只承担 BM25 副本表（向量不再回 postgres），其余不变 |
| R8 | §7.5 风险清单 | 移除 halfvec 手写 SQL 风险；新增 R-Q1~R-Q6（§5） |
| R9 | §8 配置 | 新增 `QDRANT_URL`/`QDRANT_API_KEY`（**沿用主仓命名**，容器内 `http://qdrant:6333`）；`KB_EMBED_DIMENSIONS` 角色变为 collection size + 自检基准；删除一切 pgvector 相关表述 |
| R10 | §10 任务分解 | T01-T05 内容更新向量相关项；**并行度提升**：T02 完全独立、T04 只依赖 T01，关键路径从 5 串行缩短为 3 层（§4） |
| R11 | §11 假设清单 | 新增 A8-A16（§6） |

---

## 2. 替换段落（按原章节号）

### 2.1 替换原 §4「数据模型」中 embeddings 相关内容

**（原：五表 = knowledge_bases/knowledges/chunks/embeddings/chunk_revisions；embeddings 含 halfvec 列、(source_id,source_type) UNIQUE UPSERT 键、HNSW 表达式部分索引手写 SQL、dimension INTEGER 多维度共存）**

**修订后：四张元数据表 + Qdrant 唯一向量真源**

| 存储 | 承载 | 说明 |
|---|---|---|
| Postgres（kb_mastra 库） | `knowledge_bases` / `knowledges` / `chunks` / `chunk_revisions` | 元数据、链表（pre/next）、source_locators、软删、修订历史——**全部不变**（v1 §4 原文继续有效，除 embeddings 行外） |
| Qdrant（主仓 qdrant:6333，collection `kb_chunks_{dim}`） | 全部 chunk 向量 + 检索 payload | **embeddings 表删除**。原 (source_id,source_type) UPSERT 键语义由「point id + payload.source_type」承担（A9）；原「dimension 列多维度共存」语义由「每维度一个 collection」承担（A8） |

**drizzle 迁移简化**：v1 中「HNSW 表达式部分索引手写 SQL（0002_embeddings_index.sql）」整体移除；迁移只剩四表 DDL + partial unique index（软删），drizzle-kit 全覆盖，无手写 SQL。`db/migrate.ts` 的 pg_advisory_lock 互斥保留。

**启动自检（替换原 describeIndex 自检）**——`src/infrastructure/qdrant/collections.ts`：

```
ensureCollection(dimension):
  GET /collections/kb_chunks_{dimension}
  ├─ 404 → PUT /collections/kb_chunks_{dimension}
  │        { vectors: { size: dimension, distance: "Cosine" },
  │          hnsw_config: { m: 16, ef_construct: 64 } }        // 对齐原 m=16/ef_construction=64
  │        → 随后立即幂等声明 payload 索引（见 2.2，建 collection 后、首次写入前——R-Q2）
  ├─ 200 → 校验 config.params.vectors.size === dimension 且 distance === "Cosine"
  │        不匹配 → fail fast（Qdrant collection 维度不可变，换模型=新 collection 全量重嵌，见 R-Q1）
  └─ 其它 → 启动失败（503 语义）
```

### 2.2 新增：Qdrant payload 设计与 point ID 映射（补充进修订后 §4）

**Point ID 映射（替代 (source_id, source_type) UPSERT 键）**：
- kb-mastra 的 `chunk_id` 生成即 **UUIDv4**（`crypto.randomUUID()`）——Qdrant point id 原生接受 UUID，**point id = chunk_id 一一对应，零映射表**。
- 幂等：Qdrant `PUT points` 同 id 覆盖 = 天然 UPSERT（替代 `ON CONFLICT (source_id,source_type) DO UPDATE`）。
- WeKnora 的 `source_type`（为未来 summary/entity 等非 chunk 源预留）降级为 **payload 字段**（P1 恒为 `"chunk"`）；未来非 chunk 源的 point id 用 `UUIDv5(chunkId + ":" + sourceType)` 派生或独立 collection，不在 P1 实现（A9）。

**Payload 结构**（每个 point）：

| 字段 | 类型 | payload 索引 | 用途 |
|---|---|---|---|
| `tenant_id` | string | **keyword** | 强制租户隔离（对应原 WHERE tenant_id） |
| `kb_id` | string | **keyword** | 单库/跨库过滤（对应 KnowledgeBaseIDs）、KB 级联删除 |
| `doc_id` | string | **keyword** | 文档级联删除、清旧索引 |
| `chunk_id` | string | keyword | 冗余自校（point id 已是，取回后无需解析） |
| `chunk_index` | number | **integer** | 相邻链表扩展排序 |
| `chunk_type` | string | keyword | P1 恒 "text"/"parent_text"（枚举对齐 WeKnora） |
| `source_type` | string | keyword | P1 恒 "chunk"（语义保留位） |
| `enabled` | boolean | **keyword** | 对应 IndexInfo.IsEnabled，检索 must 条件 |
| `content` | string | 无 | with_payload 取回（替代原 embeddings.content 冗余列） |
| `context_header` | string | 无 | 上下文扩展面包屑 |

索引声明：`PUT /collections/{c}/index {"field_name":"tenant_id","schema":"keyword"}`（tenant_id/kb_id/doc_id/chunk_id/chunk_type/source_type/enabled 七个 keyword + chunk_index integer）。幂等：已存在时 Qdrant 返回错误可吞（按「已存在」判断跳过）。索引为后台增量构建，构建期 filter 退化为暴力扫描——P1 数据量可接受（R-Q2）。

### 2.3 替换原 §5.2 processChunks 中 BatchSave 段

**（原：嵌入全完成后 40 条/批并发 5 BatchSave → UPSERT embeddings 表 ON CONFLICT (source_id,source_type)）**

**修订后**：
```
嵌入全部完成后 → qdrantIndexWriter.upsertChunks(collection, chunksWithVectors):
  按 40 条/批（BATCH=40，并发 p-limit 5，对齐原 BatchSave 40/5）：
  PUT /collections/{c}/points?wait=true
      { points: [{ id: chunkUUID, vector: number[], payload: §2.2 结构 }] }
  wait=true：保证 finalizeIndexedKnowledgeState 前读己之写（状态机依赖）
  同 id 覆盖 = 幂等 UPSERT；批量调优项：batch 提至 128（Qdrant 官方建议 100+），A16
```

**清旧索引幂等（原「清旧 chunks+索引」）修订为双写双删**：
```
reparse/processChunks 开头：
  ① Qdrant：POST /collections/{c}/points/delete
       { filter: { must: [{key:"doc_id",match:{value}},{key:"tenant_id",match:{value}}] }, wait: true }
  ② SQL：DELETE FROM chunks WHERE knowledge_id = …（原逻辑）
删除顺序铁律（A15）：一律先 Qdrant 后 SQL——
  中途失败的残留形态是「SQL 有 chunks 行但无向量」（检索不可见、可重删、无害）；
  反序则产生「孤儿 point」（会被检索到，错误答案）。启动对账 job 列 P2。
```

### 2.4 替换原 §5.3 检索链路中 vector.ts 段

**（原：pgvector HNSW `<=>` 余弦、embedding::halfvec(dim) 表达式部分索引、SET LOCAL hnsw.ef_search、expandedTopK∈[100,200]、score=1-distance、distance<=1-threshold 过滤）**

**修订后**（`src/application/repository/retriever/qdrant/vector.ts`）：
```
POST /collections/{c}/points/query
{ query: <queryVector>,                     // 1.10+ 统一 query 接口
  filter: { must: [
    { key: "tenant_id", match: { value: tenantId } },        // 强制租户隔离
    { key: "kb_id",    match: { any: kbIds } },               // 单库=单元素，跨库=多元素
    { key: "enabled",  match: { value: true } },
  ] },
  limit: expandedTopK,                        // clamp(top_k,100,200)，对齐原 expandedTopK
  with_payload: true                          // content/context_header 取回供组装
}
// hnsw_ef 不显式传（Qdrant 自适应，见 A11）
```

**score 语义对齐说明**：Qdrant `Distance=_cosine` 下返回的 `score` 即 cosine similarity（Qdrant cosine distance = 1 − cosine similarity），与原 pgvector `score = 1 − distance` **数值与语义完全一致**（∈[0,1]，越大越相似）。`KB_VECTOR_THRESHOLD=0.15` 直接沿用。

**阈值过滤位置（A10）**：**应用侧过滤**（`score >= threshold`），不用 Qdrant `score_threshold` 参数。理由：①下游 RRF 归一化与 rerank 候选池需要完整 score 序列，Qdrant 参数是硬截断；②与 WeKnora「SQL 结果过滤」逻辑一一对应，翻译保真；③expandedTopK≤200 条，应用侧过滤开销可忽略。

**后续链路不变**：fuse 三分支（P1 仅向量分支：余弦分 + ChunkID 去重取最高分 → top_k 截断）→ processSearchResults（相邻链表一跳扩展，用 payload.chunk_index 排序）→ assemble → rerank（默认关）。跨库同 embedding 模型校验（validateSameEmbeddingModel）语义由「单 collection 单维度」天然保证，代码保留校验位（P1 全局单模型恒过）。

### 2.5 替换原 §3 模块映射与目录结构中的向量引擎部分

| v1 设计 | 修订后 |
|---|---|
| `repository/retriever/postgres/{vector,keywords,index-writer}.ts` | `repository/retriever/qdrant/{vector,index-writer,cleanup}.ts` + `repository/retriever/keywords.ts`（BM25 no-op，引擎无关，接缝不变） |
| （无） | **新增 `src/infrastructure/qdrant/{client.ts, collections.ts, types.ts}`**：client.ts=薄 REST fetch（见 2.6）；collections.ts=ensureCollection 自检+payload 索引声明；types.ts=wire 类型（手写窄面） |
| drizzle/0002_embeddings_index.sql（手写 HNSW） | 删除 |
| WeKnora `repository/retriever/postgres` 的对应物表述 | 对应物改为 `repository/retriever/qdrant`（WeKnora 引擎目录名照旧映射，P1 注册的引擎实现从 postgres 换 qdrant——factory/registry/ownership 抽象不变，与 WeKnora「多引擎可替换」结构一一对应） |

### 2.6 新增：Qdrant 客户端选型（决策 A12）

**决策：裸 REST fetch + 手写窄类型层（~150 行，`src/infrastructure/qdrant/client.ts`），不用 @qdrant/js-client-rest。**

理由：①kb-mastra 用到的 Qdrant 面极窄——6 个端点（GET/PUT collection、PUT points、POST points/query、POST points/delete、PUT index），REST 契约 1.x 稳定；②依赖面最小化（grpc-js/bullmq/drizzle 已不少，官方 SDK 还要拖 openapi 生成层与版本对齐约束）；③bun 原生 fetch 零适配，与 OpenBot 代理层 client.ts 的「薄 fetch 客户端」先例一致；④API Key 头（`api-key`）与超时熔断自己三行搞定。

兜底：接口隔离在 `infrastructure/qdrant/` 单目录，若团队偏好官方 SDK，换 `@qdrant/js-client-rest@1.19.x` 不动 service 层（风险 R-Q6 由 T01 roundtrip 冒烟覆盖）。

### 2.7 替换原 §8 配置段

```diff
 # ── kb-mastra ──
 KB_PORT=8082
 KB_DATABASE_URL=postgres://kb_mastra:***@postgres:5432/kb_mastra   # 仅元数据四表
 KB_REDIS_URL=redis://redis:6379
+# Qdrant（沿用主仓命名；kb-mastra 容器在 data 网络内直连，宿主开发用 localhost:6333）
+QDRANT_URL=http://qdrant:6333
+QDRANT_API_KEY=
 KB_API_KEYS=sk-kb-dev-001:tenant-a:admin
 DOCREADER_ADDR=docreader:50051
 OLLAMA_BASE_URL=…
 KB_EMBED_MODEL=…
-KB_EMBED_DIMENSIONS=1024            # 用于建 HNSW 表达式索引档位
+KB_EMBED_DIMENSIONS=1024            # 角色：collection vectors.size（kb_chunks_1024）+ 启动自检基准
 KB_QDRANT_BATCH=40                  # upsert 批量（调优项，默认 40 对齐原 BatchSave）
 （其余不变）
```

命名决策（A13）：**沿用主仓 `QDRANT_URL`/`QDRANT_API_KEY`** 而非 `KB_QDRANT_URL`——同一部署同一变量，compose `environment:` 直传免二次配置；kb-mastra 容器内值为 `http://qdrant:6333`（data 网络），宿主本机开发为 `http://localhost:6333`（loopback 已发布）。**不重复建 qdrant 服务**，直接挂主仓既有服务的 data 网络。gRPC 6334 未发布，仅用 REST。

### 2.8 微调原 §7.1 BM25 迁移路径①

ParadeDB 独立实例路径微调：v1 中该档表述为「仅存 embeddings BM25 副本表」隐含向量也回 postgres——修订为**BM25 副本表只存 content+过滤键（tenant/kb/doc），向量仍留 Qdrant**；keywords.ts 实现替换方式不变。②zhparser、③WASM jieba 两档不变。

---

## 3. 兼容性影响评估（对 v1 契约承诺的复核）

逐项复核 v1 §6 兼容承诺，**全部不受影响**：
- 7 wire 类型 + 10 路由 + 错误体：向量层在 service 之下，投影层无感；
- RetrieveResponse.results[].score：Qdrant similarity 与原 score 语义一致（§2.4），OpenBot P1 熔断/SOURCE 注入无感；
- ParseStatus 7→4、multipart 字段名、hybrid=true 接受：不变；
- G4 降级：Qdrant 不可达 → vector.ts 抛错 → composite 引擎级失败=丢弃候选 → 融合退化为空结果（miss 语义）→ 检索链路静默降级路径与 v1 一致；摄取路径 Qdrant 不可达 → embedder 批次失败 → BullMQ 重试 → 死信 failed，与 v1 一致。

---

## 4. 修订后任务分解（并行度提升：关键路径 5 串行 → 3 层）

```
     ┌─ T01 基础设施（DB四表+Mastra server+鉴权+qdrant client+ensureCollection+grpc冒烟）
并行 │
     └─ T02 解析+切分纯函数层（chunker五档+父子+validator+SSRF+docparser注册）——零基础设施依赖
            ↓                    ↓
        T03 摄取管线 ──(并行)── T04 检索+重排+10路由
        （依赖 T01+T02）        （仅依赖 T01：fixture 直接 qdrant upsert 测试向量+造 chunks 行，
                                  不必等摄取管线）
                   ↓
               T05 OpenBot 端到端+回归（依赖 T03+T04）
```

| ID | 名称（修订处加粗） | 文件清单 | 依赖 | 验收（向量相关更新点） |
|---|---|---|---|---|
| T01 | 包骨架+DB+**Qdrant 接入**+DocReader 冒烟 | package.json/tsconfig/biome/Dockerfile/.env.example；src/{index,config,db/{client,migrate}}；drizzle 四表迁移（**无手写 SQL**）；middleware/{auth,api-key,kb-access}；/health；**src/infrastructure/qdrant/{client,collections,types}**；docreader proto+生成桩+冒烟；compose kb-mastra/docreader（qdrant/redis 用主仓既有） | 无 | /health 200；migrate 幂等；**ensureCollection：404→建+索引声明；已存在→维度/Cosine 校验；维度不匹配 fail fast**；**qdrant roundtrip 冒烟（upsert→query→delete by filter）**；grpc 冒烟结论（bun 档或 node 回退档） |
| T02 | 解析+切分层（同 v1，**完全独立可并行**） | infrastructure/chunker/ 全量纯函数；docparser/{registry,simple,builtin-grpc}；SSRF 防护 | 无（与 T01 并行） | 同 v1：chunker 用例对齐 WeKnora（512/80/五档/父子 4096/384/不变量）；SSRF 用例；双路解析产出 markdown+SourceBlock |
| T03 | 摄取管线+**Qdrant 索引** | knowledge-create（三入口+SHA256+配额+local）；tasks/{queue,worker,document-process}（attempt 幂等+死信）；**repository/retriever/qdrant/{index-writer,cleanup}**；progress 回写；retriever/keywords.ts（no-op） | T01+T02 | 上传→completed；**DB 四表行数验证（无 embeddings 表）；qdrant points 数=chunks 数、payload 字段/索引齐**；**重跑 reparse 不翻倍（id 覆盖幂等）+先 Qdrant 后 SQL 删除顺序用例**；kill docreader→重试→failed；attempt 竞态用例 |
| T04 | 检索+重排+10 路由（**仅依赖 T01，与 T03 并行**） | models/{embedding,rerank}；reranking/{rerank,mmr,passage}；retriever/{composite,factory,registry,ownership}；**repository/retriever/qdrant/vector.ts**；kb-search；handler/router 十路由+错误体+ParseStatus 投影+task 投影 | T01（与 T03 并行；fixture=直接 upsert 测试向量+造 chunks 行） | 冒烟 1-4 过；**filter 必须含 tenant_id/kb_id/enabled 三 must（缺一不可，单测断言请求体）**；**score∈[0,1] 且阈值应用侧过滤**；与 Go kb-service 同输入 diff 响应逐字段一致；越权（tenant-b→0 结果而非 403 泄漏）/422/429 |
| T05 | OpenBot 端到端+回归（同 v1） | .env 切换（KB_SERVICE_URL→8082，QDRANT_URL 指主仓 qdrant）；P1 回归；README（运行/回退） | T03+T04 | 端到端 5-8 过；server 零改动；回退=KB_SERVICE_URL 指回 :8081；**qdrant-data 卷快照说明入 README（P2 自动化）** |

并行说明：T02 的全部输入是 WeKnora chunker 源码与纯函数测试（零基础设施）；T04 的检索层测试用 fixture 直接造 Qdrant points（无需摄取管线）。两人并行时日历时间 ≈ T01/T02 中较长者 + max(T03,T04) + T05。

---

## 5. 风险表更新

**移除**：v1 §7.5 中「halfvec 表达式索引手写 SQL」「启动 describeIndex 自检」两条。

**新增**：

| 风险 | 缓解 |
|---|---|
| R-Q1 **collection 维度不可变**：换 embedding 模型（维度变）无法原地迁移，必须新 collection（kb_chunks_{newDim}）+全量重嵌+旧 collection 归档删除 | collection 命名带维度；启动自检 fail fast（配置维度≠collection 维度即拒绝启动，提示换 collection 名或重建）；KB 级 embedding_model_id 不可改守卫（v1 已有）；P2 提供 rebuild-collection 管理任务 |
| R-Q2 **payload 索引声明时机**：索引后台增量构建，构建期 filter 暴力扫描；若先写后建索引，大批量下构建耗时且期间查询慢 | ensureCollection 在建 collection 后、首次写入前立即声明全部 payload 索引；声明幂等（已存在→跳过）；P1 数据量下构建期可接受 |
| R-Q3 **score 语义差异**：Qdrant score=similarity 仅在 Distance=_cosine 成立，误配 Euclid 则阈值/RRF 语义断裂 | ensureCollection 硬编码 `distance:"Cosine"` + 自检 config 中 distance 字段；T04 单测断言 score∈[0,1] |
| R-Q4 **wait=true 吞吐**：批量 upsert 同步等待索引，摄取时长上升 | 保持 40/批×5 并发（对齐 WeKnora 40/5 语义）；调优项 KB_QDRANT_BATCH=128（A16）；摄取本就是异步管线，时长不阻塞用户 |
| R-Q5 **双存储删除非事务**：Qdrant 与 PG 删除无跨库事务 | 删除顺序铁律「先 Qdrant 后 SQL」（残留形态=无向量的 chunks 行，检索不可见可重删；反序会产生会被检索到的孤儿 point）；启动对账 job 列 P2 |
| R-Q6 **自写 REST 客户端 wire 偏差**（1.19 契约细节） | T01 roundtrip 冒烟（ensure/upsert/query/delete）全链验证；types.ts 手写窄面集中定义；备选切换 @qdrant/js-client-rest@1.19.x（接口隔离层不动 service） |

保留不变：bun+grpc（T01 冒烟+node 回退档）、4600 行管线翻译遗漏（幂等/attempt/失败路径用例强制）、BullMQ 重试可见性投影、Mastra apiRoutes multipart 能力、postgres 共载（元数据侧仍独立 db/role）。

---

## 6. 新增假设清单（A8-A16，接续 v1 的 A1-A7）

- **A8 collection 策略=按维度单 collection**：P1 全局一个 `kb_chunks_{KB_EMBED_DIMENSIONS}`，tenant/kb 隔离靠 payload filter（tenant_id/kb_id keyword 索引）。否决 per-KB collection 的理由：collection 数=KB 数（管理/内存/optimizer 开销）、跨库检索（WeKnora KnowledgeBaseIDs 语义）需多查询合并、与「多维度共存=每维度一 collection」的原语义对齐。若未来单 collection point 数上千万或需 per-KB 快照迁移，经 retriever/ownership 抽象升级为 per-KB collection+alias 路由，不动 service 层。
- **A9 point id=chunk UUIDv4 直用**：(source_id,source_type) UPSERT 键降级为 payload.source_type（P1 恒 "chunk"）；非 chunk 源（summary/entity 等，P2+）用 UUIDv5(chunkId+sourceType) 派生 id 或独立 collection。
- **A10 阈值过滤在应用侧**：不用 Qdrant score_threshold 参数（RRF/rerank 候选池需完整 score 序列；与 WeKnora SQL 结果过滤逻辑一一对应）。
- **A11 hnsw_ef 不显式传**：hnsw_config 建档时 m=16/ef_construct=64（对齐原手写 SQL）；检索 ef 用 Qdrant 自适应（动态跟随 limit）。若后续召回不达标，query 参数加 hnsw_ef=expandedTopK 即一行改动。
- **A12 客户端=裸 REST fetch**：~150 行窄类型层；官方 SDK 为备选（隔离层可换）。
- **A13 env 命名沿用主仓 QDRANT_URL/QDRANT_API_KEY**：compose 直传；kb-mastra 容器内 `http://qdrant:6333`，宿主开发 `http://localhost:6333`；不重复建 qdrant 服务。
- **A14 embeddings 表删除**：Qdrant 唯一向量真源；PG 仅元数据四表；qdrant-data 卷成为关键数据（快照备份运维项，P2 接 snapshots API）。
- **A15 删除顺序=先 Qdrant 后 SQL**（可恢复性优先，见 R-Q5）。
- **A16 upsert 批量默认 40/批 wait=true**（对齐原 BatchSave 40/5）；KB_QDRANT_BATCH 留调优档。

---

## 7. 验证方式补充（并入 v1 §9）

冒烟序列在 v1 §9 基础上追加：
- `curl http://localhost:6333/collections/kb_chunks_1024` → 确认 size/distance/hnsw_config/payload 索引齐（T01 验收）；
- 摄取完成后 `POST /collections/kb_chunks_1024/points/count {exact:true}` = chunks 表行数（T03 验收，替代原「DB 行数验证 embeddings 表」）；
- 删除文档后同 count 递减且 `GET /kb/:id/retrieve` 不再命中（级联验证）；
- `docker stop qdrant`（不 stop kb-mastra）→ 检索返回空（miss 降级）+ 摄取任务重试——G4 对 Qdrant 故障的验证。

（完。本文档为 v1 的增量修订，与 v1 并读；冲突处以本文档为准。）
