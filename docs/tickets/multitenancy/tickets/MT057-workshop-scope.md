## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

Workshop 的会话、turn、执行、产物与沙箱实例关联都按归属隔离；公开入口不再成为跨公司通道。

## Acceptance criteria

- [ ] 会话与执行记录固定归属；跨范围访问返回不可见语义。
- [ ] 沙箱实例只与同范围会话关联；回收后不复用给其他范围而不清理。
- [ ] 原匿名公开入口改为要求有效身份与受众（与 MT058 一致）。
- [ ] 调度与实例关联的一致性有测试覆盖。

## Blocked by

- MT053 Craft 会话、turn、消息与快照的作用域
- MT047 快照、shell、文件、cancel/reset/cull 的归属

## Scope boundary

Workshop 会话与执行归属、沙箱实例关联、原公开入口的授权改造。

## Verification

bun test server/tests/multitenancy/workshop-scope.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A1, A2, A8。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：公开入口分类结果要回写 MT001 清单；未分类入口阻断 MT130 就绪。
