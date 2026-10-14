## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

用户登录后能列出自己有权进入的公司与团队并选择当前工作范围；公司管理员能管理本公司的团队与成员名单，但不会因此获得业务内容读取权。没有可用团队时返回明确的空状态而不是默认团队。

## Acceptance criteria

- [ ] 列表只返回该用户真实有资格的公司与团队；跨公司用户看到各自独立的条目。
- [ ] 选择标识只影响后续请求的作用域解析，不授予任何未持有的权限。
- [ ] 公司管理员可以创建/停用本公司团队并管理成员名单；不能读取非成员团队的业务内容。
- [ ] 团队管理动作按 公司→主体→公司成员→团队→团队成员 顺序锁定并递增版本，写入审计记录。
- [ ] 无资格时返回空列表与明确状态码，不返回默认团队或第一项。

## Blocked by

- MT005 团队资格进入集中授权 seam 与事务内重验

## Scope boundary

公司/团队列表查询、选择语义、团队与成员管理动作入口。

## Verification

bun test server/tests/multitenancy/selection-api.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A1, A3, A6。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：Web 选择界面（MT080）、桌面选择（MT101）与移动适配层（MT104）都消费此契约；字段名冻结后不要改。
