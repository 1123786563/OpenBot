## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #192 F 会话（本 Ticket 是其 sub-issue）

## What to build

用户看到的会话列表、未读计数与分页结果只包含当前公司团队范围内自己有权访问的会话；跨范围会话既不出现在列表，也不影响计数与游标。

## Acceptance criteria

- [ ] 列表、计数、分页游标三者在有权/无权混合数据下都只反映可见集合。
- [ ] 用另一公司的会话 ID 直接访问详情返回不可见语义。
- [ ] 切换团队后列表与计数立即变化，不需要重新登录。
- [ ] 游标不因隐藏条目而跳过或重复可见条目。

## Blocked by

- #59 Bot 与配置的创建、列表、详情按公司团队归属（MT016）
- #57 公司运行配置装配（替换部署级单份租户包）（MT014）

## Scope boundary

频道/会话归属字段、列表与计数查询、游标稳定性、相关表 RLS。

## Verification

bun test server/tests/multitenancy/conversations-list.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A1, A2, A3。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：不可见语义复用 MT011；不要在本 Ticket 内自造错误码。
