## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

实现者可以在测试里一行拿到「公司 A 团队甲、公司 A 团队乙、公司 B 团队丙」以及仅属甲、仅属乙、甲乙双成员、同团队另一人、跨公司用户、公司管理员、平台操作身份、受限 Worker 身份等固定身份，并在真实受限 PostgreSQL 角色下打开业务事务。所有正向与越权测试共用同一套身份，避免每个 Ticket 自造夹具。

## Acceptance criteria

- [ ] 夹具覆盖 Spec §11 最低身份矩阵的全部 8 类身份，并可按公司/团队/成员状态组合。
- [ ] harness 使用专用测试数据库与受限业务角色；缺少 TEST_DATABASE_URL 时报错而不是回退开发库。
- [ ] 事务提交或回滚后上下文被清除；同一连接被下一个测试复用时不携带上一次范围（有专门测试）。
- [ ] 夹具通过真实业务 factory 建立数据，不用模拟授权器替代真实授权路径。

## Blocked by

None (can start immediately).

## Scope boundary

测试身份夹具、受限数据库角色与事务上下文 harness、连接池上下文清理。

## Verification

bun test server/tests/multitenancy/fixtures.test.ts（含连接池复用泄漏用例）。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A6。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：这是几乎所有后端 Ticket 的前置；接口变更需在此 Ticket 内更新并通知下游。
