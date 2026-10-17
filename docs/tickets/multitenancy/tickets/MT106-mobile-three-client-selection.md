## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #204 R Canonical 移动端（本 Ticket 是其 sub-issue）

## What to build

在同一身份矩阵下验证三端的选择、空状态、切换与撤权行为一致，缓存不跨范围污染。

## Acceptance criteria

- [ ] 三端选择界面只列出真实有资格的公司与团队，行为一致。
- [ ] 无资格与撤权状态在三端都有明确界面与拒绝行为。
- [ ] 切换范围后三端都不显示旧范围缓存或在途响应。
- [ ] 发现的平台差异被记录并修复或显式标记未验证。

## Blocked by

- #147 移动端 tenancy 适配层：选择与缓存（MT104）
- #148 移动端流式与媒体传输携带当前范围（MT105）

## Scope boundary

三端选择、空状态、切换与撤权行为一致性及缓存隔离验证；不含聚合接口与媒体。

## Verification

bun test apps/openmuse/apps/mobile/src/openbot/three-client-selection.test.ts + 三端运行记录

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A3, A10, A11。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：真机或模拟器不可用时完成可运行部分并显式标记未验证项，不编造证据。 （原 Ticket 已按粒度要求拆为 2 段，本段为第 1 段。）
