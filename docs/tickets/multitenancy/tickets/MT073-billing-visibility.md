## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

付款人继续只能看到自己的订单与支付资料；公司财务读取是明确管理授权；团队用量视图只统计公司付款账户的消费，不把个人 Bifrost 直连消费算作公司支出。

## Acceptance criteria

- [ ] 普通公司成员看不到其他人的订单与支付资料（即使共用公司余额）。
- [ ] 具备公司财务管理授权的主体可查看公司账务与团队用量；无此授权则不可。
- [ ] 团队用量汇总与公司总额一致，且不含个人直连消费。
- [ ] 旧按创建人限制的订单读取没有被放宽为全公司成员可读（回归测试）。

## Blocked by

- MT070 公司调用归属与同一余额的原子预扣
- MT010 个人资源权限与显式跨团队分享例外

## Scope boundary

订单与账单读取授权、公司财务管理授权、团队用量汇总视图。

## Verification

bun test server/tests/multitenancy/billing-visibility.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A9, A13, A2。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：前端账单与用量视图在 MT097；契约以本 Ticket 为准。
