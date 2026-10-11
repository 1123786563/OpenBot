# kb-mastra

WeKnora 知识库域的 TypeScript + Mastra 移植，替换 Go kb-service 作为 OpenBot 的
`KB_SERVICE_URL` 上游。契约零破坏：OpenBot 代理层与 P1 检索链路零改动。

## 形态

- 独立包（不入 workspaces，仿 agent-mastra），Bun 运行时，两个进程：
  - **HTTP**（`bun src/index.ts`）：Hono + Bun.serve，十条 `/kb` 路由 + `/health`
  - **worker**（`bun src/worker.ts`）：BullMQ 消费 `kb-core` 队列（摄取管线）
- 存储：Postgres 元数据四表（`kb_mastra` 库）+ Qdrant 唯一向量真源
  （collection `kb_chunks_{KB_EMBED_DIMENSIONS}`）+ Redis（队列）+ DocReader
  （WeKnora 原样复用的 gRPC 解析服务 :50051）

## 运行

### 宿主开发

```bash
# 依赖（postgres 的 kb_mastra 库见 docker/kb-mastra/init-db.sql；qdrant/redis/docreader 起容器）
cd kb-mastra && bun install

cp .env.example .env   # 填 KB_EMBED_MODEL（必填）等

bun run db:migrate     # 建表（幂等，advisory lock 互斥）
bun run dev            # HTTP :8082（--watch）
bun run worker         # 另一终端：摄取 worker
```

### compose 全栈

```bash
docker compose up -d postgres qdrant redis docreader kb-mastra
# kb-mastra 容器内直连 postgres:5432 / qdrant:6333 / redis:6379 / docreader:50051
```

冒烟（前置栈起好）：

```bash
bun scripts/grpc-smoke.ts    # docreader gRPC 三级结论
bun scripts/t03-smoke.ts     # 摄取管线数据面（mock embedding）
bun scripts/t05-smoke.ts     # HTTP 十路由全序列（含 PDF 全链 + 越权）
bun scripts/contract-diff.ts # 与 Go kb-service(:8081) 契约结构 diff
```

## 回退

`KB_SERVICE_URL` 指回 `http://localhost:8081`（Go kb-service）即回滚——两服务
同契约，OpenBot 侧无其它改动。8081 上的 Go 骨架保留为契约对照与回退位。

## 已知边界（P1）

- **BM25 降级纯向量**：keywords 引擎返回空数组（接口/注册/RRF 融合分支代码
  保留）；迁移路径三档见设计 §7.1（ParadeDB 副本表 / zhparser / WASM jieba）。
- **manual 文档 reparse**：text 型文档的原文不随行存储（WeKnora 由
  SourceContent 列承担，P1 未搬）；reparse 需重新提交内容，file/url 型完整支持。
- **chunk 父子索引**：父块（4096）只入库不进索引；命中子块返回父块是 P1.5
  接缝（kb-search 内预留）。
- **chunk 编辑/标签/文件夹/Wiki/FAQ/时间线**：上游契约外（二阶段清单）。
- **Qdrant collection 维度不可变**：换 embedding 模型（维度变）= 新 collection
  全量重嵌；启动自检 fail fast（配置维度≠collection 维度即拒绝启动）。
- **删除顺序铁律**：一律先 Qdrant 后 SQL——中途失败残留「无向量的 chunks 行」
  （检索不可见、可重删）；反序会产生会被检索到的孤儿 point。

## 设计文档

- `deliverables/software-company/weknora-mastra-migration-design.md`（v1）
- `deliverables/software-company/weknora-mastra-qdrant-revision.md`（Qdrant 增量修订，冲突处以修订为准）
