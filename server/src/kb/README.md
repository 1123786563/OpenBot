# kb（知识库域，原 kb-mastra）

WeKnora 知识库域的 TypeScript 移植，替换 Go kb-service 作为 OpenBot 的
`KB_SERVICE_URL` 上游。契约零破坏：OpenBot 代理层与 P1 检索链路零改动。
现随 server 工作区一起开发（scripts 见 server/package.json 的 `kb:*`）。

## 形态

- server 工作区内的一个域（`server/src/kb`），Bun 运行时，两个进程：
  - **HTTP**（`bun run kb:dev`，即 `src/kb/index.ts`）：Hono + Bun.serve，
    十条 `/kb` 路由 + `/health`
  - **worker**（`bun run kb:worker`，即 `src/kb/worker.ts`）：BullMQ 消费
    `kb-core` 队列（摄取管线）
- 存储：Postgres 元数据四表（`kb_mastra` 库，迁移在 `server/drizzle-kb/`，
  与 server 主库 `server/drizzle/` 分库分目录）+ Qdrant 唯一向量真源
  （collection `kb_chunks_{KB_EMBED_DIMENSIONS}`）+ Redis（队列）+ DocReader
  （WeKnora 原样复用的 gRPC 解析服务 :50051）
- proto 契约随包分发：`server/proto/docreader.proto`

## 运行

### 宿主开发

```bash
# 依赖在仓库根 bun install 一次即可；kb 的 compose 依赖（qdrant/redis/docreader）：
docker compose --project-directory . -f docker/compose/kb.yml up -d
# postgres 的 kb_mastra 库见 docker/kb-mastra/init-db.sql（主 compose postgres 初始化）

# 根 .env 填 KB_EMBED_MODEL（必填）等（见 .env.example 的 kb 段落）
cd server
bun run kb:db:migrate    # 建表（幂等，advisory lock 互斥）
bun run kb:dev           # HTTP :8082（--watch）
bun run kb:worker        # 另一终端：摄取 worker
```

冒烟（前置栈起好）：

```bash
cd server
bun run kb:grpc-smoke    # docreader gRPC 三级结论
bun run kb:t03-smoke     # 摄取管线数据面（mock embedding）
bun run kb:t05-smoke     # HTTP 十路由全序列（含 PDF 全链 + 越权）
bun run kb:contract-diff # 与 Go kb-service(:8081) 契约结构 diff
```

单测：`bun test src/kb/`（或仓库根 `bun test server/src/kb/`）。

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
