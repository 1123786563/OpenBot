# MT012 / Issue #55 实现Brief — coordinator 下发

你是 MT012 的实现者（backend_implementer）。按 RED→GREEN→REFACTOR 交付；本 brief 与票据正文冲突时以票据正文为准。

## 任务（#55，Epic #189）

公司成员、团队、成员关系、授权、凭据与账务等核心租户域表启用行级安全，并以受限业务角色访问；即使应用层出错，跨公司查询与关联也在数据库层被拒绝。

## 验收（票据四条）

1. 受限角色下跨公司 SELECT/UPDATE/DELETE 与跨公司外键关联被数据库拒绝。
2. 团队公共、个人所有权与显式分享的数据库策略与应用层规则一致（同一用例两侧对照）。
3. 事务结束后上下文被清除；连接复用不带上一次范围。
4. 应用不使用可绕过 RLS 的角色作为普通数据访问入口；平台级机器读权限单独登记且不可用于普通业务接口。

Verification：`bun test server/tests/multitenancy/rls-core.test.ts`（新建，真实 PostgreSQL）。

## 事实源与前置契约

- 父 Spec #6、ADR 0004（accepted）/0002/0003、CONTEXT.md。覆盖 A6、A1、A2。
- BASE `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`；前置已转移（prereq-manifest.txt 29 文件）= MT001–MT006 + MT008 + MT112 verified 集合。
- 领取时先复算哈希；重点前置：MT004（20 表 RLS 策略 + ob_ent_* 能力角色 + operator/directory/data 三登录，见 migrate-test.ts MT004 任务与 enterprise-test-db.ts）、MT008（enterprise_resources.visibility 列 + workspace-v1 判定 + resource-policy 注册表）、MT002（受限角色测试 harness，tests/support/enterprise-database.ts 的 ROLE_DATABASE_VARIABLES）。报告在 archive/plans/multitenancy-execution/reports/。
- **票据备注（必须遵守）**：其余业务闭环表的 RLS 在各自 Ticket 内启用、复用你的策略模板与测试写法——模板化交付（报告给出策略模板章节）。

## 可写文件（票面域；其余只读）

- 新建：`server/tests/multitenancy/rls-core.test.ts`（跨公司三操作 + FK 关联拒绝、两侧对照、上下文清理、连接复用）。
- 扩展（纯追加）：`server/src/db/schema/enterprise-tenancy.ts`（如需表定义侧变更）、`server/scripts/multitenancy/migrate-test.ts`（新 MT012 任务：既有表 ENABLE/FORCE RLS、缺补策略、上下文清理函数等，expand-only 不 DROP/REVOKE 既有对象）、`server/tests/multitenancy/migration-tool.test.ts`（**仅** ALLOWED_TASK_IDS 断言追加 "MT012"——第 3 次窄例外先例：MT112（裁决 #5）、MT008（裁决 #10 §4.3），保持 3-4 行形态 + 裁决注释）。
- 勘察决定：enterprise-test-db.ts / support harness 是否需最小扩展（受限角色清单）；如需，纯追加并披露。
- `server/src/index.ts` 如需装配：纯追加段。**本票不得改**：workspace-admin.ts、scope-gate.ts、store.ts、revocation 域（MT007 并行中）、resource-policy.ts 判定逻辑（对照测试只读消费；若发现判定面缺陷升级问 coordinator）。

## 基线与环境

- 全量基线 232/0/0skip（同 MT007 brief）。完成后期望 232+新用例。
- 专用库：pgvector/pgvector:pg16（端口 55472，容器名 mt012-impl-pg），trust，psql 探针；base migrate + MT004 apply 前置；五变量 URL 显式用户 + 随机口令 0600 env 用后删。
- typecheck 与 biome（触及文件存量比对披露）。

## 交付物（未提交检查点）

archive/plans/multitenancy-execution/reports/MT012.md + archive/plans/multitenancy-execution/checkpoints/MT012/（同 MT007 惯例全套）+ 策略模板章节（供下游闭环 Ticket 复用）。完成后 worker_done 附 --report-path。无提交/推送/合并/生产迁移/部署授权。
