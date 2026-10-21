## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #189 C 资源授权策略（本 Ticket 是其 sub-issue）

## What to build

公司成员、团队、成员关系、授权、凭据与账务等核心租户域表启用行级安全，并以受限业务角色访问；即使应用层出错，跨公司查询与关联也在数据库层被拒绝。

## Acceptance criteria

- [ ] 受限角色下跨公司 SELECT/UPDATE/DELETE 与跨公司外键关联被数据库拒绝。
- [ ] 团队公共、个人所有权与显式分享的数据库策略与应用层规则一致（同一用例两侧对照）。
- [ ] 事务结束后上下文被清除；连接复用不带上一次范围。
- [ ] 应用不使用可绕过 RLS 的角色作为普通数据访问入口；平台级机器读权限单独登记且不可用于普通业务接口。

## Blocked by

- #45 多公司多团队测试身份夹具与受限角色数据库 harness（MT002）
- #51 资源可见性属性与 workspace-v1 策略版本（expand）（MT008）

## Scope boundary

RLS 策略与受限角色（核心租户域表）、事务本地上下文设置与清理、RLS 一致性测试。

## Verification

bun test server/tests/multitenancy/rls-core.test.ts（真实 PostgreSQL）。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A6, A1, A2。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：其余业务闭环表的 RLS 在各自闭环 Ticket 内启用，复用这里的策略模板与测试写法。
