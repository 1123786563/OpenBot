## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #205 S 观测（本 Ticket 是其 sub-issue）

## What to build

对实际启用的外部集成（模型网关、观测后端等）提交隔离与账户路由证据；未落地的设计不被当作已验证，计划中的配置也不算证据。

## Acceptance criteria

- [ ] 清单区分「已启用并验证」「已启用未验证」「未落地」三类，且各自有依据。
- [ ] 已启用集成的隔离与付款账户路由有测试或可复核证据。
- [ ] 缺外部凭据时完成本地确定性测试并显式标记未验证，不编造供应商证据。
- [ ] 结论回写 MT001 清单，未验证项阻断 MT130 就绪。

## Blocked by

- #152 用量事件的账户区分与脱敏回归（MT109）
- #115 支付回调、订阅激活、outbox 与对账从原记录解析付款账户（MT072）

## Scope boundary

已启用集成清单、隔离与账户路由验证、未验证项标记。

## Verification

bun test server/tests/multitenancy/integration-evidence.test.ts + 证据清单文档。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A13, A9, A11。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：本 Ticket 产出的是证据与状态，不是新功能实现。
