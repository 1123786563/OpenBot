## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #193 G 身份与凭据（本 Ticket 是其 sub-issue）

## What to build

每家公司的 SSO/SCIM 配置独立保存与生效；SCIM 离职只撤销该公司的成员资格与资源权限，不会删除用户在其他公司的资格或全局身份。

## Acceptance criteria

- [ ] 公司 A 的 SCIM 停用只影响公司 A 的成员资格；公司 B 的资格与全局登录不受影响。
- [ ] SSO 配置读取与修改仅限该公司授权管理员；跨公司读取返回不可见语义。
- [ ] SCIM 请求不能创建或修改其他公司的成员关系。
- [ ] 身份绑定回调按服务端持久状态归属，不接受回调参数改写公司。

## Blocked by

- #50 成员停用与撤权的级联生效与审计留痕（MT007）
- #57 公司运行配置装配（替换部署级单份租户包）（MT014）

## Scope boundary

SSO/SCIM 配置存储与归属、SCIM 用户变更处理、身份绑定回调。

## Verification

bun test server/tests/multitenancy/sso-scim.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A1, A5, A7。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：退出公司与全局账号删除的语义分离在 MT067，清理与恢复 manifest 在 MT068。
