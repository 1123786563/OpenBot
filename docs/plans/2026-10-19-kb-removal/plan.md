# 知识库子系统全量下线（2026-10-19）

决策：用户确认范围 1——全量移除 KB 子系统（前后端 + docker + 工具 + 测试 + 文档）。
决策记录：docs/adr/0009-remove-knowledge-base-domain.md；CONTEXT.md 同步删域词条。

## 删除面
- server/src/kb/、server/src/knowledge/（含 colocated tests）
- server/src/craft/kb-search-relay.ts、builtin-skills/company-search/（kb 是唯一后端，技能随撤）
- server/src/enterprise/tenancy/kb-ownership.ts（MT036 主库侧权威）
- server/drizzle-kb/、drizzle-kb.config.ts、server/scripts/kb/
- docker/compose/kb.yml、docker/kb-mastra/
- app：routes knowledge.$kbId/knowledge.index、lib/knowledge*.ts(x5+tests)、components/knowledge/、lib/upload-queue/（仅 kb 用）、locales en+zh knowledge.json、nav/errors/admin 词条、i18n 接线、admin-sidebar 入口、routeTree 重生成
- tests/e2e/knowledge.e2e.ts、examples/fintech/knowledge.yaml
- server/tests：craft-kb-search-relay、multitenancy/{kb-ownership,document-lifecycle,retrieval-restriction}、multitenancy/support/{kb-ownership,retrieval-restriction,document-lifecycle}

## 编辑面
- server/src/index.ts：knowledge imports/runtime(2165-2172)/tools(2282)/loadKnowledgeForActor(2926)/craftKnowledgeBases+craftKbSearch(5262-5340)/kbSearch(5510)
- copilot.ts：LoadKnowledgeForBot import(74)+三参(2183/2474/3982)+穿线(4057)
- agents/agent-resolver.ts：import(18)+option(96)+call(166)
- app.ts：mount(153-154,2693-2694)
- craft/routes.ts：relay import(24-25)+option(112-116)+mount(306-309)
- craft/builtin-skills/index.ts：company-search/SourcesSection/渲染函数
- craft/managed-content.ts：companySearchSkillAvailable 门控
- craft/agent-instructions.ts：COMPANY_KNOWLEDGE_SECTION/anchor/flag
- enterprise/tenancy/team-public-rules.ts：kind "knowledge" 分支(87,411-419)；bot-publish.ts:10 注释
- billing/cleanup-execution.ts：PROTECTED_TABLES 去 knowledge_bases/knowledges；rehearsal/classification 注释
- tests 编辑：craft-builtin-skills、craft-agents-template、craft-managed-content、craft-session-config-mcp、opik-tool-steps、cleanup-execution.integration、multitenancy/inventory（去 2 个 kb 用例）
- package.json：root test:kb；server kb:* 11 条
- Dockerfile 143 注释、scripts/e2e-red-inventory.mjs:115、docs/compose.md kb 节

## 不动（独立线/误报）
acknowledge 系、MCP brokered_connections "knowledge lane" 注释、onyx 文案之外的
computer "knowledge"（supervisor/architecture-diagram）、kB 单位、plugins prose。

## 遗留（数据面，代码不动）
- 存量库的 knowledge_bases/knowledges 表、enterprise_resources kind='knowledge' 行：留着（惰性）
- docker 卷、server/data/kb-files 本地数据：不删
- KB_TEST_DATABASE_URL env：测试没了即无人读

## 验证
server typecheck、app typecheck（重生成 routeTree）、编辑过的测试 bun test 全绿。
