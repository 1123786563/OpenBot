## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #205 S 观测（本 Ticket 是其 sub-issue）

## What to build

共享观测后端上的公司查询、导出与 trace 链接仍需授权；部署级 dashboard 不会直接开放给普通租户，审计与观测查询分域。

## Acceptance criteria

- [ ] 普通租户无法通过观测入口读取其他公司 trace 或日志。
- [ ] 导出遵守范围与脱敏规则，且导出动作留审计。
- [ ] trace 链接访问在打开时校验权限，不因链接不可猜而放行。
- [ ] 部署级 dashboard 只对平台操作身份开放。

## Blocked by

- #152 用量事件的账户区分与脱敏回归（MT109）
- #121 业务审计与身份审计分域，计费管理需明确授权（MT078）

## Scope boundary

观测查询与导出授权、trace 链接访问、部署级与租户级视图分域。

## Verification

bun test server/tests/multitenancy/observability-authz.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A1, A2, A9。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：与 MT078 的审计分域保持一致；两套查询不要互相绕过。
