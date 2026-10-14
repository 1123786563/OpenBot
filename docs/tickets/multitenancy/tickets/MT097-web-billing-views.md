## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

用户看到自己的订单与支付资料；具备公司财务授权的主体看到公司账务与按团队/用户汇总的用量，且用量只统计公司付款账户。

## Acceptance criteria

- [ ] 普通成员只看到自己的订单；看不到他人支付资料。
- [ ] 公司财务视图对授权主体开放，团队用量与公司总额一致。
- [ ] 个人 Bifrost 直连消费不出现在公司用量视图中。
- [ ] 切换范围后视图立即更新，无旧范围金额残留。

## Blocked by

- MT083 按公司团队隔离查询缓存并拒绝旧 generation 的在途响应
- MT073 账务可见性：付款人订单、公司财务授权与团队用量视图

## Scope boundary

账单与订单页面、公司财务视图、团队用量汇总视图。

## Verification

bun test app/tests/multitenancy/web-billing.test.tsx。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A9, A13, A10, A2。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：金额与汇总口径以 MT073 为准；界面不做二次汇总口径变更。
