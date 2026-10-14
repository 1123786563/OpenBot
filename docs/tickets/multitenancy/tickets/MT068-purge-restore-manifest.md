## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

purge、retention 与 restore 操作都携带归属与发起权限，并以不可伪造的 manifest 限定范围；不会仅凭 user_id 扫遍所有公司的外部文件或凭据。

## Acceptance criteria

- [ ] manifest 由服务端依据归属生成并签名/校验；客户端提交的 manifest 被拒绝。
- [ ] 清理只触及 manifest 列出的范围；跨公司资源不被扫描或删除。
- [ ] restore 只恢复到原归属范围，不产生跨范围数据。
- [ ] 操作全程留审计，且失败可安全重跑（幂等）。

## Blocked by

- MT067 退出公司与全局账号删除是两个不同操作

## Scope boundary

purge/retention/restore 入口授权、manifest 生成与校验、外部资源范围限定。

## Verification

bun test server/tests/multitenancy/purge-restore.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A5, A12, A2。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：与 MT120 的外部状态迁移共用「无法归属即隔离」的原则。
