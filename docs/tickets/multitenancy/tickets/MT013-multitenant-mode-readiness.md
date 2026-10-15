## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #190 D 运行配置（本 Ticket 是其 sub-issue）

## What to build

运维可以用一个显式开关进入多租户模式；该模式下启动会校验入口覆盖清单是否完整、是否仍存在单用户/开发绕过、数据库角色是否安全，任何一项不满足都拒绝启动而不是带着缺口上线。

## Acceptance criteria

- [ ] 多租户模式下存在未登记入口、单用户绕过或不安全数据库角色时拒绝启动，并列出具体缺口。
- [ ] 单租户部署保持既有行为（回归测试），多租户模式下没有旧默认回退。
- [ ] readiness 结果是机器可读的，可被 CI 与启动就绪强制（MT130）、上线候选包（MT143）消费。
- [ ] 开关缺失或值非法时按安全侧处理（不进入多租户模式且记录原因）。

## Blocked by

- #44 从真实装配生成全入口清单与覆盖缺口报告（MT001）
- #48 团队资格进入集中授权 seam 与事务内重验（MT005）

## Scope boundary

模式开关、启动 readiness 校验、覆盖清单比对、单租户兼容行为。

## Verification

bun test server/tests/multitenancy/readiness.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A6, A11。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：这是 contract 阶段的闸门；在启动就绪强制（MT130）之前允许缺口存在，但必须可见。
