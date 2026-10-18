# MT010 / Issue #53 实现 Brief — coordinator 下发

你是 MT010 的实现者（backend_implementer）。RED→GREEN→REFACTOR；票据正文优先；未提交检查点；无提交/推送/合并/生产迁移/部署授权。

## 任务（#53，Epic #189）

个人会话、个人文件与个人连接凭据继续按个人权限控制，团队成员资格不开放它们；同公司跨团队访问只能通过显式分享，并同时验证受众、动作、有效期与撤销状态。

## 验收（四条）

1. 同团队另一人无法读取某人的个人会话、个人文件与个人连接凭据。
2. 显式分享只在指定受众、动作与有效期内有效；过期或撤销后立即失效。
3. 跨公司 Grant 与跨公司分享永远拒绝（即使资源 ID 正确）。
4. 分享不改变资源归属；被分享方不能转授管理动作。

Verification：`bun test server/tests/multitenancy/personal-share-rules.test.ts`（新建，真实 PostgreSQL）。

## 前置契约（同 MT009 brief：32 项哈希复算；resource-policy/visibility 只读消费；RLS 模板；MT013 启动段不动；workspace-admin.ts 为 MT006 态）

## 可写文件

- 新建：`server/src/enterprise/tenancy/personal-share-rules.ts`、`server/tests/multitenancy/personal-share-rules.test.ts`、support 夹具。
- 纯追加：index.ts 装配段；如需迁移 migrate-test.ts（MT010 任务）+ migration-tool.test.ts 窄例外（第 4 次先例）。
- **不得改**：同 MT009 清单（resource-policy/visibility/store/scope-gate/workspace-admin/revocation/enterprise-tenancy/startup-checks）。
- 分享事实存储：优先复用既有 grants 表语义（MT008 判定的 grant 路径）扩展动作/有效期/撤销属性；若需新表按 MT012 模板（复合 FK 内嵌 tenant_id + FORCE RLS + 最小列授权），迁移任务实现。

## 基线与环境

- 全量基线 **305/0/0skip**（11 文件）→ 完成 305+新用例。
- 专用库端口 **55480**（容器 mt010-impl-pg），其余同 MT009（迁移前置按依赖序全 apply）。

## 交付物

archive/plans/multitenancy-execution/reports/MT010.md + archive/plans/multitenancy-execution/checkpoints/MT010/ 全套。完成 worker_done 附 --report-path。
