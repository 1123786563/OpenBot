## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

个人会话、个人文件与个人连接凭据继续按个人权限控制，团队成员资格不开放它们；同公司跨团队访问只能通过显式分享，并同时验证受众、动作、有效期与撤销状态。

## Acceptance criteria

- [ ] 同团队另一人无法读取某人的个人会话、个人文件与个人连接凭据。
- [ ] 显式分享只在指定受众、动作与有效期内有效；过期或撤销后立即失效。
- [ ] 跨公司 Grant 与跨公司分享永远拒绝（即使资源 ID 正确）。
- [ ] 分享不改变资源归属；被分享方不能转授管理动作。

## Blocked by

- MT008 资源可见性属性与 workspace-v1 策略版本（expand）

## Scope boundary

个人所有权判定、显式 Grant、分享受众/动作/有效期/撤销校验。

## Verification

bun test server/tests/multitenancy/personal-share-rules.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A1, A2, A3, A4。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：分享令牌与分享页在 MT058（分享授权）与 MT092（分享页受众）落地。
