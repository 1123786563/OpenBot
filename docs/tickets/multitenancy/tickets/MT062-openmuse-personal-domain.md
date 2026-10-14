## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

目标、想法、个人记忆与财务产物按范围与个人权限保存；精确动作提案、确认与取消的既有行为保持不变。

## Acceptance criteria

- [ ] 个人域对象只对本人在当前范围可见；同团队他人不可读取。
- [ ] 财务产物（含导出与附件）遵守账务可见性规则（与 MT073 一致）。
- [ ] 既有精确动作提案/确认/取消行为回归通过。
- [ ] 删除与恢复只影响本范围对象。

## Blocked by

- MT060 OpenMuse 任务、计划、监控与租约的作用域
- MT039 个人记忆与来源选择保持个人权限

## Scope boundary

goals/ideas/memories 与财务产物归属、个人权限校验、既有动作行为回归。

## Verification

bun test server/tests/multitenancy/openmuse-personal.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A4, A1。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：账务可见性冲突时以 MT073 的规则为准并记录。
