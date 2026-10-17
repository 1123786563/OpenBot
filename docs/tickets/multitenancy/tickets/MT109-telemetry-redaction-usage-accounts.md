## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #205 S 观测（本 Ticket 是其 sub-issue）

## What to build

用量事件能区分公司与个人付款账户，避免标识冲突或重放到另一账户；既有脱敏规则在新增字段后仍生效。

## Acceptance criteria

- [ ] 用量事件携带付款账户类型与稳定标识；公司与个人事件不混淆。
- [ ] 重放同一事件不会记到另一账户（幂等测试）。
- [ ] 脱敏规则覆盖服务 token、cookie、OAuth、个人 Key 与凭据正文（含错误与异常路径）。
- [ ] 既有脱敏回归套件全部通过。

## Blocked by

- #151 Trace、日志与事件的归属字段注入（MT108）
- #112 公司计费 Customer 映射与公司/个人账户类型（expand）（MT069）

## Scope boundary

用量事件账户类型区分、幂等与脱敏回归；不含归属字段注入实现。

## Verification

bun test server/tests/multitenancy/telemetry-usage.test.ts + 既有脱敏回归套件

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A8, A9, A13, A2。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：由「Trace、日志与用量事件携带真实归属并保持脱敏」拆出的第 2/2 段；上一段（Trace、日志与事件的归属字段注入）完成并集成后再领取。
