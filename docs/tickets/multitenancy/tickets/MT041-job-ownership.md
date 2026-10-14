## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

每个任务/运行/触发/租约在创建时固定公司、团队、发起主体、业务对象与配置版本；用户之后切换团队不会改变已创建任务的归属。

## Acceptance criteria

- [ ] 创建时归属被持久化；后续请求携带不同选择标识不改变它。
- [ ] 租约只能被同一归属的执行者持有；跨范围认领被拒绝。
- [ ] 配置版本变化后可追溯当时的执行依据。
- [ ] 任务列表与详情只返回有权范围（含管理视图）。

## Blocked by

- MT005 团队资格进入集中授权 seam 与事务内重验
- MT014 公司运行配置装配（替换部署级单份租户包）

## Scope boundary

任务与运行记录归属字段、租约模型、配置版本快照、相关表 RLS。

## Verification

bun test server/tests/multitenancy/job-ownership.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A8, A5。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：这是所有后台执行 Ticket 的基础契约。
