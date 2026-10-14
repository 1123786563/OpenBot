## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

人员、身份提供方与凭据管理界面只对具备相应公司能力的主体开放，且只显示本公司范围内容。

## Acceptance criteria

- [ ] 入口由服务端能力决定；无能力者访问路由得到明确拒绝状态。
- [ ] 人员与身份提供方列表只含本公司范围；凭据界面脱敏。
- [ ] 管理动作（提升/降级/离职）提交本公司范围并留审计。
- [ ] 平台级管理入口不出现在公司管理员界面。

## Blocked by

- MT083 按公司团队隔离查询缓存并拒绝旧 generation 的在途响应
- MT076 人员提升、降级与离职按公司授权

## Scope boundary

people、身份提供方与凭据管理界面的能力门控与脱敏；不含审计与企业设置界面。

## Verification

bun test app/tests/multitenancy/web-admin-people.test.tsx

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A5, A9, A10。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：能力清单来自 MT075/MT078；前端不要复制角色判断逻辑。 （原 Ticket 已按粒度要求拆为 2 段，本段为第 1 段。）
