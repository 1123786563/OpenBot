## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

移动端（canonical OpenMuse）通过 tenancy 适配层获得公司/团队选择与按范围隔离的缓存，行为与 Web 侧规则一致。

## Acceptance criteria

- [ ] 选择界面只列出真实有资格的公司与团队；无资格显示空状态。
- [ ] 缓存键包含用户、公司与团队；切换后旧范围数据不出现。
- [ ] 适配器契约与 Web 侧一致（同一选择语义与拒绝行为）。
- [ ] 适配层测试可在 CI 中独立运行。

## Blocked by

- MT103 移动端 submodule 基线核对与可审查差异报告
- MT083 按公司团队隔离查询缓存并拒绝旧 generation 的在途响应

## Scope boundary

移动端 tenancy 适配器、选择状态与持久化、查询缓存隔离。

## Verification

bun test apps/openmuse/apps/mobile/src/openbot/tenancy.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A3, A10, A2。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：记录 nested BASE/HEAD 或未提交检查点，供最终 gitlink 集成核验。
