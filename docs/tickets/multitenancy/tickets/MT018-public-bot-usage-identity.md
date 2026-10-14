## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

团队成员运行公共 Bot 时，产生的会话、个人连接与个人凭据属于使用者本人，不会绑定为 Bot 创建者身份；创建者的私人凭据也不会因此暴露给使用者。

## Acceptance criteria

- [ ] 使用者运行公共 Bot 产生的会话归其个人所有，创建者看不到该会话内容。
- [ ] 运行过程中使用的是使用者自己的连接与凭据；缺少个人凭据时按既有规则请求授权，而不是借用创建者的。
- [ ] 创建者的个人凭据、个人文件与个人会话不因发布公共 Bot 而对使用者可见。
- [ ] 多团队成员并发使用同一公共 Bot 时状态不串用（含浏览器/沙箱状态，见 MT052）。

## Blocked by

- MT017 Bot 发布受众与旧 public 语义的显式迁移
- MT009 团队公共资源动作规则（可用不可改）

## Scope boundary

公共 Bot 运行入口的身份解析、会话归属、凭据选择规则。

## Verification

bun test server/tests/multitenancy/public-bot-usage.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A4, A2, A1。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：与 MT029（凭据取用 lease）、MT052（状态化公共 Bot）共同构成公共 Bot 安全边界。
