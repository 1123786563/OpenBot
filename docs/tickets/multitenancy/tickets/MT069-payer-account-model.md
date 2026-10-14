## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

一个公司对应唯一明确映射的计费 Customer；积分账户增加 company/personal 类型与稳定标识约束。本 Ticket 只扩展模型，不改变既有扣费行为。

## Acceptance criteria

- [ ] 公司与 Customer 的映射唯一且稳定；重复映射被拒绝。
- [ ] 账户类型是显式字段，不从字符串或用户身份猜测。
- [ ] 既有记录在迁移后行为不变（回归测试）；未知类型记录被隔离而不是默认归为某一类。
- [ ] 金额尺度、精度与既有约束保持不变。

## Blocked by

- MT014 公司运行配置装配（替换部署级单份租户包）
- MT008 资源可见性属性与 workspace-v1 策略版本（expand）

## Scope boundary

账户类型与映射约束、公司↔Customer 唯一映射、迁移与兼容。

## Verification

bun test server/tests/multitenancy/payer-accounts.test.ts（真实 PostgreSQL）。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A9, A13, A12。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：expand 阶段：只新增；MT070 起才改变扣费路径的账户解析。
