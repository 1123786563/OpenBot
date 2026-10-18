## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #200 N 账务（本 Ticket 是其 sub-issue）

## What to build

公司工作台的每次被计费执行固定公司、团队、使用人、Bot/授权与稳定调用标识；多个团队并发消费从同一公司余额原子预扣，不会各自读一次余额后独立扣费。

## Acceptance criteria

- [ ] 并发预扣测试证明总额不超过余额（真实数据库、并发用例）。
- [ ] 公司 A 不能消费公司 B 的余额，即使请求携带伪造标识。
- [ ] 每次预扣记录公司、团队、使用人、Bot/授权与稳定调用标识。
- [ ] 预扣上界与幂等键语义保持不变；重复请求不重复预扣。

## Blocked by

- #112 公司计费 Customer 映射与公司/个人账户类型（expand）（MT069）
- #84 任务、运行、触发与租约固定原始归属与配置版本（MT041）

## Scope boundary

计费执行的归属记录、原子预扣路径、并发行为、上界与幂等。

## Verification

bun test server/tests/multitenancy/company-reservation.test.ts（真实 PostgreSQL 并发）。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A9, A13, A1。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：付款账户由服务端固定；客户端指定账户的请求被拒绝。
