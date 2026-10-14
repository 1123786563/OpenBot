## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

Craft 的计划任务、子任务与应用连接在创建时固定归属，后台触发与执行遵守与通用任务相同的规则；连接不会跨范围复用。

## Acceptance criteria

- [ ] 计划任务保存原始归属；触发执行时重建作用域（复用 MT042 规则）。
- [ ] 子任务不能引用其他范围的父任务或连接。
- [ ] 取消计划任务只影响本范围；跨范围请求被拒绝。
- [ ] 连接凭据通过 lease 取用，撤销后触发失败而不是静默使用他人凭据。

## Blocked by

- MT053 Craft 会话、turn、消息与快照的作用域
- MT041 任务、运行、触发与租约固定原始归属与配置版本

## Scope boundary

Craft 计划与子任务归属、触发执行路径、应用连接引用。

## Verification

bun test server/tests/multitenancy/craft-schedules.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A8, A2, A5。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：与 MT043 的取消传播共用实现。
