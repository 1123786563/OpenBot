## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

业务执行需要凭据时通过 lease 取用：lease 固定用途、作用域与有效期，可被撤销；个人凭据不会因为团队公共 Bot 而被自动共享给其他使用者。

## Acceptance criteria

- [ ] lease 只能用于签发时声明的用途与作用域；改用途或改范围被拒绝。
- [ ] 撤销或过期后，正在进行的取用在下一次校验点失效；后续新取用被拒绝。
- [ ] 公共 Bot 的其他使用者无法获得创建者个人凭据的 lease。
- [ ] 每次签发、使用与撤销留审计（不含明文）。

## Blocked by

- MT027 连接凭据与站点登录归属，可用不等于可读明文
- MT018 使用团队公共 Bot 时保持使用者自己的会话与凭据

## Scope boundary

lease 签发与校验、用途/作用域绑定、撤销与过期、审计。

## Verification

bun test server/tests/multitenancy/credential-lease.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A5, A4。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：执行链路（MT046 起）在敏感动作处重新校验 lease。
