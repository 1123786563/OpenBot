## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

主动建议、职责与计划类功能按归属生成与投递；数据库事务不跨外部网络调用持有，避免长事务持锁并保证失败可安全重试。

## Acceptance criteria

- [ ] 主动建议只投递给归属范围内的授权接收者；正文不含无权内容。
- [ ] 外部调用前后是独立事务；测试证明没有在等待外部 API 时持有数据库授权锁。
- [ ] 外部调用失败后重试安全（幂等），不产生重复投递或重复扣费。
- [ ] 撤销接收者权限后不再投递，且已投递内容不可被无权者读取。

## Blocked by

- MT042 全局扫描只有调度权，每项执行重建业务作用域

## Scope boundary

主动建议生成与投递、职责/计划触发、事务边界与外部调用分离。

## Verification

bun test server/tests/multitenancy/proactive-tx.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A8, A2。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：事务边界规则同样适用于 MT043/MT044；发现违例统一在此 Ticket 修正模式。
