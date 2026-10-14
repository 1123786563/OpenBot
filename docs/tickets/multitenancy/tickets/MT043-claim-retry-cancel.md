## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

任务认领、失败重试与人工取消都在原归属范围内进行；取消只对有权主体生效，重试不会把任务漂移到别的公司或团队。

## Acceptance criteria

- [ ] 无权主体不能取消他人任务；取消请求返回不可见语义。
- [ ] 重试后归属、发起主体与配置版本保持不变。
- [ ] 取消会传播到执行中的敏感动作与外部执行（含沙箱/浏览器），并有测试证据。
- [ ] 并发认领不会让两个执行者同时持有同一租约。

## Blocked by

- MT042 全局扫描只有调度权，每项执行重建业务作用域

## Scope boundary

认领与租约续期、重试策略与归属保持、取消入口授权与传播。

## Verification

bun test server/tests/multitenancy/job-claim-cancel.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A8, A5, A2。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：取消传播依赖 MT047/MT050 的执行侧接口。
