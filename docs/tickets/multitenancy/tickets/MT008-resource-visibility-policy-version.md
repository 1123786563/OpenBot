## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #189 C 资源授权策略（本 Ticket 是其 sub-issue）

## What to build

资源可以标记为个人或团队公共，并通过新的策略版本表达团队公共授权；旧策略版本的语义保持不变，历史资源的暴露范围只能经明确迁移或明确选择改变。

## Acceptance criteria

- [ ] 资源具有 private/workspace 可见性；未标记的资源保持既有行为（有回归测试）。
- [ ] 新策略版本独立注册；旧版本判定结果在升级前后完全一致（对照测试）。
- [ ] 把旧 public 资源迁移为团队公共必须经显式动作，迁移工具不会自动扩大范围。
- [ ] 跨公司资源引用在新策略下永远拒绝。

## Blocked by

- #48 团队资格进入集中授权 seam 与事务内重验（MT005）

## Scope boundary

资源可见性属性、策略版本注册与解析、旧版本兼容测试。

## Verification

bun test server/tests/multitenancy/resource-policy.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A4, A2。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：expand 阶段；MT009/MT010 在此之上实现具体动作规则。
