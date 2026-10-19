# ADR 0009：移除知识库（KB）子系统

日期：2026-10-19　状态：已接受

## 背景

KB 子系统（`server/src/kb` gRPC 服务 + worker + docreader/qdrant/kb-redis 依赖、
`server/src/knowledge` 检索中间件与 `search_knowledge` 工具、`/admin/knowledge`
管理页、craft company-search 技能中继、MT036 kb-ownership 多租户权威）横跨
前后端与部署面，是 ADR 0004 多租户与 enterprise spec 的一部分。

## 决策

全量下线（用户 2026-10-19 确认）：

- 删除 `server/src/kb/`、`server/src/knowledge/`、drizzle-kb 迁移、kb:* 脚本、
  `docker/compose/kb.yml`、`docker/kb-mastra/`、前端 knowledge 页面/词条、
  craft company-search 技能与 kb-search 中继、kb-ownership 及其测试。
- `ResourceDependencyKind` 去掉 `"knowledge"`；billing cleanup 的
  PROTECTED_TABLES 去掉 kb 表；inventory 生成器去掉 kb-service 装配与 kb
  外部依赖/闭包映射。
- ADR 0004 与各 spec 为历史记录不改写；本文取代其中 kb 相关部分。

## 后果与遗留

- **数据不删**：存量库的 `knowledge_bases`/`knowledges` 表、
  `enterprise_resources` kind='knowledge' 行、`enterprise_resource_dependencies`
  kind='knowledge' 行保留为惰性数据；无生产方后 `team-public-rules` 不再解析该
  kind，历史行不影响判定。
- **ai-observability 的 retrieval step seam 保留**（`tool-steps.ts` 的
  `recordRetrieval`/RetrievalStepObservation）：通用观测面，读侧服务历史运行；
  kb 下线后暂无生产方。
- 本地 `server/data/kb-files`、docker 卷（qdrant-data、kb-redis-data）属运行
  数据，不在本次代码清理范围。
- KB_TEST_DATABASE_URL 等 env 不再被任何测试读取。
