## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #187 A 基础/前置（本 Ticket 是其 sub-issue）

## What to build

实现者可以为某个 Ticket 生成固定编号的迁移，并以 dry-run 预览、以显式 manifest 执行 apply；工具拒绝生产库与隐式环境回退，保证多租户改造期间的 schema 变更可追溯、可重放、可核验。

## Acceptance criteria

- [ ] 只接受枚举的任务标识与 generate/migrate 命令；未枚举标识被拒绝。
- [ ] 只读取显式测试数据库配置；指向生产库或缺少配置时拒绝执行并说明原因，不回退 .env 隐式值。
- [ ] 为每个任务生成固定名字与递增编号的迁移，重复编号或跳号被检测。
- [ ] apply 必须提供 manifest；默认 dry-run，输出将执行的语句与影响范围摘要。

## Blocked by

- #44 从真实装配生成全入口清单与覆盖缺口报告（MT001）

## Scope boundary

迁移生成与执行工具、编号校验、manifest 校验；不写任何业务迁移内容。

## Verification

bun test server/tests/multitenancy/migration-tool.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A6, A12。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：下游所有涉及 schema 的 Ticket 都用它；不要各自调用 drizzle-kit 绕过编号校验。
