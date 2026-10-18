# MT037 实施计划 —— 检索在候选、重排与进入模型之前限制范围（Issue #80）

角色：backend_implementer。BASE f0520524（prereq-manifest 213 项领取时逐项复算全部一致）。
无提交/推送/合并/生产迁移/部署。RED→GREEN→REFACTOR；变异全捕获；交付未提交工作树 +
checkpoints/MT037/ + reports/MT037.md。

## 事实源

- Issue #80（gh 实取）：四条验收 + Scope boundary（检索候选集合构造、向量命名空间隔离、
  引用与返回内容过滤）+ Verification `bun test server/tests/multitenancy/retrieval-restriction.test.ts`。
  覆盖 A2/A4/A8。票注：「检索后过滤」不算隔离；测试必须断言候选集合本身。
- 父 Spec §6（知识检索先确定允许的 KB/文档集合，再在检索端限制返回范围；不能在内容已进入
  模型或重排之后过滤。当前 KB 的公司范围 Key 只可作为受控内部能力，普通请求不能获得无限
  公司知识范围）、§2（KB 服务身份空 kbScope=公司内全库——旧 Key 不能承担普通团队调用）、
  §116 行（向量检索命名空间按实际业务归属隔离）。
- ADR 0004 accepted；CONTEXT.md「公司与团队」「计费与积分」术语。
- 直接前置（读其报告+模块，只读消费）：
  - **MT036 kb-ownership**：主库权威（`createKbOwnershipAuthority`）+ KB 侧受限查询入口
    （`createRestrictedKbQueryService`，含 `narrowRetrievalScope`——「授权且跨库一致」集合）。
    **本票 = 其 D7 披露的下游检索/引用面消费票**：把收窄集合交给检索端，在候选/重排/进入
    模型之前限制范围。
  - **MT015 scoped-keys**：`scopedVectorNamespace`（向量命名空间 `vn-<40hex>` 派生纪律）与
    「键只做寻址不做保险箱」口径——本票的命名空间隔离沿用 payload-filter 契约（A8 单维度
    单 collection），候选集合即命名空间的授权投影。

## 设计

Spec §6 顺序不可逆：**先定允许集合 → 检索端限制 →（命中才有）重排 →（引用才进）模型上下文**。
「检索后过滤」不是隔离机制，只是纵深防御；候选集合断言是验收形态。

### 新文件（3，全部新建；无迁移——主库复用 enterprise 注册 + KB 库复用既有内容表）

1. `server/src/kb/application/service/kb-restricted-retrieval.ts`（受限检索入口，kb 域，
   消费 tenancy 权威）：
   - `createRestrictedRetrievalService({ authority, kbDb, search })`；`search` 与
     KbHandlerDeps.search 同形（`SearchRequest → SearchOutcome`），生产装配接 hybridSearch
     （本票测试接真实 hybridSearch + 内存向量引擎，见下）。
   - `retrieve(requester, request)`：
     a. **信任门 1**：assertRequester（结构检查 + assertTrustedScope）——与 MT036 入口同款；
        内部 API-Key Identity（tenantId+role+kbScope）与一切无 scope 形状结构性拒绝
        （KB_REQUESTER_INVALID）；伪造 scope → UNVERIFIED_SCOPE。
     b. **候选集合构造先于一切内容访问**：内部经 `createRestrictedKbQueryService(...).
        narrowRetrievalScope(requester, request.kbIds)` 收窄到「授权 + 跨库一致」集合
        （去重、保持首现序、输入卫生 >100/非串/空串 KB_RETRIEVAL_INPUT_INVALID）。
     c. **空候选 = 检索端零调用**：allowed 为空直接返回空结果——embedder/检索引擎/重排器
        一次都不被调用（测试以调用计数断言）；跨范围检索返回空而不是他人内容。
     d. **检索端限制**：唯一一次 search 调用，`kbIds = allowed`（候选集合本身）、
        `tenantId = scope.tenantId`（服务端身份，非客户端输入）。向量引擎 wire 层 filter
        = tenant_id match + kb_id any(候选) + enabled——命名空间按归属隔离的检索端实现。
     e. **纵深防御（非主机制）**：组装后丢弃 kbId ∉ 候选集合的结果行（诚实披露：这是兜底
        不是隔离——隔离由 b/d 结构成立）。
     f. **引用面**：citations 只从受限结果行投影（chunkId/docId/kbId/title/source/
        score + 有界 snippet）；snippet 有界截断，绝不拼接候选外内容；引用文本不泄露无权
        片段——无权内容根本不进入结果行（b/d 两道），citations 无从泄漏。
   - 返回 `{ ok: true, results, citations, candidateKbIds, count }`（candidateKbIds=实际
    进入检索端的候选集合，可观测审计面）。
   - 导出纯函数 `restrictedCitationOf(row, maxRunes)`（有界 snippet 投影，可单测冻结）。
2. `server/tests/multitenancy/support/retrieval-restriction.ts`（测试支撑）：
   - `createInMemoryVectorStore(collection)`：内存 QdrantClient 假体——queryPoints 逐字段
     按 must filter 语义过滤（tenant_id match value / kb_id match any / enabled true）、
     余弦相似度、limit 截断、with_payload 映射；**记录每次调用的 collection+body**（候选
     集合断言的引擎边界探针）。
   - `createRecordingEmbedder(dim)`：确定性非负向量（文本哈希→归一化），记录调用次数。
   - `createRecordingReranker()`：记录每次收到的 documents 文本；恒定 relevanceScore 按
     输入序衰减（RankResult）。
   - `seedRetrievalContent(...)`：向 KB 库种 knowledges+chunks 行（含 pre/next 链、
     isEnabled=false 反例）+ 向内存向量库种 points（tenant_id/kb_id/doc_id/chunk_id/
     enabled/content/vector）。
3. `server/tests/multitenancy/retrieval-restriction.test.ts`（票面 Verification 指定路径）。

### 测试矩阵（验收映射，~17 用例）

- **AC1 候选集合断言 + 重排排除**：混合授权/未授权请求 → candidateKbIds 恰为授权子集且
  引擎收到的 kbIds 逐字节等于该集合（t1）；rerank=true 时重排器收到的文本全部来自候选
  （canary 零出现，t2）；全未授权请求 → embedder/引擎/重排器调用计数全 0（t3）；不一致
  镜像库不进候选（t4）；输入卫生继承（t5）。
- **AC2 向量命名空间按归属隔离**：内存库预载 A1/A2/B 公司与团队 + disabled 点 → a1 只见
  本命名空间（t6）；跨团队 a2（t7）；跨公司 b1（t8）；引擎 wire 层 filter 结构断言
  tenant_id+kb_id any⊆候选（t9）。
- **AC3 引用面**：citations 与结果 1:1 且 kbId 全在候选内（t10）；全响应 canary 扫描
  （t11）；相邻链表扩展不出命名空间（t12）；stale 镜像库不进引用（t13）。
- **AC4 公司范围 Key 专门测试**：内部 Identity 空 kbScope（=公司内全库）→ KB_REQUESTER_
  INVALID 且检索端零调用（t14）；带 kbScope 白名单的 Identity 同拒——Key 自带白名单不是
  授权（t15）；伪造 scope → UNVERIFIED_SCOPE（t16）；正向对照：seam scope 正常检索
  （t17）。

### 明确不改（冻结面）

- MT036 三模块（kb-ownership / kb-restricted-query / ownership-schema）、MT015 scoped-keys、
  migrate-test.ts / migration-tool.test.ts（**主库零迁移**：复用 enterprise 注册表路径 +
  KB 库既有 knowledges/chunks/knowledge_bases 表，无新表新列 → 无任务注册、无窄例外）、
  kb-search.ts / retriever 引擎 / qdrant 引擎 / index.ts / config.ts、全部既有 tenancy 模块、
  enterprise-tenancy schema。

## 环境契约

- 容器 `mt037-impl-pg`（pgvector/pgvector:pg16，127.0.0.1:**55531** 预检空闲已存档
  verification/00）。
- 库：`openbot_enterprise_mt037_test` + `_assigned`（MT003 用）+ `openbot_kb_mt037_test`
  （专用 KB 库，受限登录 `ent_mt037_kb` NOSUPERUSER NOBYPASSRLS 属主通道跑 drizzle-kb）。
- env 八变量（含 KB_TEST_DATABASE_URL）仅存 0600 /tmp/mt037-env.sh；缺 env 显式 skip、
  绝不回退开发库、skipped ≠ 通过。
- 迁移链 **十四任务** MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→
  MT069→MT016→MT041→MT027（provision-db.sh 落账已验证）+ KB 库 drizzle-kb 幂等迁移。
- 已知环境特性：MT069 计费回归用全局唯一固定幂等键 → 同库单次有效；全量门槛前用
  reset-testdb.sh 重置（已存档）。

## 变异计划（≥5，全部捕获或冗余防线披露）

- MUT-A：候选收窄旁路（直接把请求 kbIds 原样交给 search）→ t1/t3/t8 捕获。
- MUT-B：空候选仍调用 search（去掉 early-return）→ t3 捕获。
- MUT-C：信任门移除（结构检查跳过）→ 单门存活（narrowRetrievalScope 内部门兜底，MT036
  MUT4a/b 同款冗余防线如实披露）；双门同移 → t14 捕获。
- MUT-D：纵深防御过滤移除 → 预期存活（主机制是候选收窄；披露）——若存活则证明过滤确实
  非主机制（诚实验证）。
- MUT-E：citation snippet 无界（去掉截断）→ 投影冻结测试捕获。
- MUT-F：tenantId 取请求侧而非 scope（若存在该输入面）→ t9 wire 断言捕获。

## 门槛

聚焦全绿 0 skip；全量 ≥770+新增（reset 后干净运行）；变异全捕获（冗余防线如实披露）；
typecheck 0；biome 触及文件 0 新增（含 --write 修复过程存档）；容器 docker rm 真实执行
并回显存档；checkpoints/MT037/ 全套 + reports/MT037.md + worker_done 附 --report-path；
披露 D1-Dn。
