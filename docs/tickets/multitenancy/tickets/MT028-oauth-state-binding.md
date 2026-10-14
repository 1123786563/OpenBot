## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

发起 OAuth 时服务端保存发起公司、团队、用户与目标连接；回调只按这份持久状态绑定结果，用户在回调期间切换团队也不会把连接绑到错误的范围。

## Acceptance criteria

- [ ] 回调绑定到发起时的公司/团队/用户/连接目的，与回调时客户端选择无关。
- [ ] state 缺失、过期、重复使用或跨范围复用时拒绝，并记录安全事件。
- [ ] 回调失败不产生半成品连接；重试使用新 state。
- [ ] 回调响应与日志不含 token 明文。

## Blocked by

- MT027 连接凭据与站点登录归属，可用不等于可读明文

## Scope boundary

OAuth state 生成与持久化、回调解析与绑定、失败与重放处理。

## Verification

bun test server/tests/multitenancy/oauth-state.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A7, A1, A5。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：桌面端 authority 绑定在 MT099；同一规则不要在两处各写一份。
