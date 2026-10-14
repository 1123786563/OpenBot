## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

公司或团队管理员停用某人后，此人的后续请求、下载签发、订阅、任务敏感动作与凭据获取都失效，且变更留有可追溯的审计记录；其他公司的资格不被误删。

## Acceptance criteria

- [ ] 团队停用后：列表、详情、下载签发、事件订阅、任务敏感动作、凭据取用全部被拒绝（逐点测试）。
- [ ] 公司停用后：该公司范围内全部团队权限失效；同一用户在另一公司的资格与数据完好。
- [ ] 恢复成员后权限按当前策略重新生效，不残留旧的拒绝缓存。
- [ ] 每次停用/恢复/撤权写入审计：操作者、对象、范围、版本、时间。

## Blocked by

- MT005 团队资格进入集中授权 seam 与事务内重验
- MT006 公司与团队列表、选择与管理入口

## Scope boundary

停用/恢复动作、级联失效点、审计事件写入。

## Verification

bun test server/tests/multitenancy/revocation.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A5, A2。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：下游每个闭环 Ticket 都要复用这里的失效点清单，不要各自实现撤权判断。
