## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #206 T 迁移与收尾（本 Ticket 是其 sub-issue）

## What to build

为插件与审批、知识与记忆闭环补齐正向与越权证据，重点覆盖检索范围与审批归属。

## Acceptance criteria

- [ ] 插件安装/工具调用/共享审批逐入口有正向与越权证据。
- [ ] 检索候选范围与个人记忆隔离有证据（不止结果过滤）。
- [ ] 缺口被修复并重跑，或明确记录为阻塞项。
- [ ] 覆盖状态标记为已覆盖。

## Blocked by

- #176 覆盖证据：Bot、会话与附件（MT133）
- #78 Host Access、签入帮助与危险动作审批的归属与既有行为保持（MT035）
- #83 学习容器、研究与演示记录隔离（MT040）

## Scope boundary

插件与审批、知识与记忆闭环的覆盖证据与小缺口修复。

## Verification

bun test server/tests/multitenancy/coverage-plugins-knowledge.test.ts + 覆盖报告

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A1, A2, A3, A4, A11。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：由「覆盖证据：Bot、会话、附件、插件审批与知识记忆」拆出的第 2/2 段；上一段（覆盖证据：Bot、会话与附件）完成并集成后再领取。
