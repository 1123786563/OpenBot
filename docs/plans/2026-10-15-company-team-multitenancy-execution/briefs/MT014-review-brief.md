# MT014 / Issue #57 独立复审 Brief — coordinator 下发

你是 MT014 的独立复审者（全新 Pi 会话）。只读被审文件；唯一新建文件 = reports/MT014-review.md；不修复；无提交/推送/合并授权；skipped 不算通过。完成 worker_done 附 --report-path。

## 审阅对象（工作树 = 前置 34 项 + 本票 7 交付）

新建 4：`runtime-config.ts`（解析 seam：公司配置模型/严格文档解析/只收窄团队覆盖/纯函数+受限角色 RLS 读取）、`db/schema/enterprise-runtime-config.ts`（两张配置表）、`runtime-config.test.ts`（29 用例/100 expect）、`support/runtime-config.ts`。
编辑 3（声称最小 + pristine 重建哈希证明）：migrate-test.ts（纯追加 MT014 任务）、migration-tool.test.ts（窄例外第 4 次 + 4 行注释）、db/schema/index.ts（+1 行 barrel export）。
检查点 checkpoints/MT014/ + reports/MT014.md。

## 重点裁决

- **A. 纯追加/窄例外最小性**：pristine 重建 vs before-hashes 逐字节；migration-tool.test.ts 是否恰为断言行替换 + 注释（对照前三次先例形态）。
- **B. 只收窄语义**：团队覆盖只能收窄（不能放宽/升级）、个人凭据不升级——谓词逐条审 + 测试断言强度。
- **C. 泄漏面**：解析不读环境变量（开关 OPENBOT_MULTITENANCY 翻转输出逐字节相同的断言真实性）；错误消息零凭据值回显（canary 断言核实）。
- **D. RLS/角色**：读取全程 ob_ent_data + 事务本地上下文 + FORCE；MUT4（删上下文行 fail-closed）真实性；写路径经受限 operator + RLS（后续管理票说明是否诚实范围声明）。
- **E. 表设计**：两张配置表是否按 MT012 模板（复合 FK 内嵌 tenant_id、FORCE、最小列授权、identity_operator 永不授予）——迁移 SQL 逐语句审。
- **F. 无进程级全局状态**：纯函数 + 深冻结断言；schema barrel +1 行无副作用。
- **G. D1 决策披露**（不动 index.ts/config.ts 装配）——遗留装配路径一行未动的验证。

## 独立复跑（亲自执行并记录退出码）

1. 端口预检 55484；专用容器 mt014-review-pg（pgvector/pgvector:pg16，trust，psql 探针）；五变量 URL 显式用户 + 随机口令 0600 用后删。
2. base migrate + 按依赖序 apply 全部任务 **MT004→MT008→MT112→MT012**（勿乱序）+ MT014 CLI 链（dry-run→generate→apply→重复 apply up-to-date）。
3. `bun test tests/multitenancy/runtime-config.test.ts --timeout 30000`（预期 29/0/0skip）
4. 全量（MT003_ASSIGNED env）预期 **363/0/0skip** 13 文件 = 334+29。
5. `cd server && bun run typecheck`；biome 7 触及文件（新增 0 告警）。
6. 抽查：两张新表 pg_policies/授权面（对照 MT012 模板）；journal MT014 步骤留痕。
7. 清理容器与凭据。
