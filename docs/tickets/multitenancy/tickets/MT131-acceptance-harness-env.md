## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

交付验收 harness：使用独立测试端口、数据库与外部命名空间，可与开发环境并行运行，并能按入口清单驱动用例。

## Acceptance criteria

- [ ] harness 使用独立端口、测试数据库与外部命名空间，不污染开发环境。
- [ ] harness 能证明自身有效：先检测到一个人为植入的越权，再用于出证据。
- [ ] 缺少测试环境时明确失败，不把 skipped 记为通过。
- [ ] 运行方式与输出格式被文档化，可被其他 agent 直接使用。

## Blocked by

- MT001 从真实装配生成全入口清单与覆盖缺口报告
- MT002 多公司多团队测试身份夹具与受限角色数据库 harness

## Scope boundary

验收 harness 与独立测试端口/数据库/外部命名空间；不含身份矩阵用例本身。

## Verification

bun test server/tests/multitenancy/acceptance-harness.test.ts

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A11, A1, A2, A6。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：harness 本身也要被独立验证：先证明它能发现一个已知越权，再用它出证据。 （原 Ticket 已按粒度要求拆为 2 段，本段为第 1 段。）
