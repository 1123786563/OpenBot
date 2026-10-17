# Issue #6 摄取快照

- 读取时间：2026-10-15 22:46 Asia/Shanghai（GitHub API 返回时间以 UTC 记录）。
- 来源：GitHub API `repos/1123786563/OpenBot/issues/6`、`sub_issues`（分页）、每个正式子 Issue 正文；本地分支 `1123786563/company-team-multitenancy` 的 `docs/tickets/multitenancy` 与 `docs/plans/2026-10-15-company-team-multitenancy`。
- 根 Issue：#6，open；直接正式子 Issue 21 个，其中 20 个多租户 Epic（#187–#206）和 1 个账费支付 Epic（#368）。
- 递归正式子 Issue：150 个唯一节点 = 20 个多租户 Epic + 143 个 MT001–MT143（#44–#186）+ 7 个 BP01–BP07（#369–#375）。本次执行范围包含根 Issue 及其全部正式子 Issue；143 与用户已知值一致，另有 7 个计费支付正式子 Ticket 不能遗漏。
- 层级核验：20 个多租户 Epic 含 143 个 MT Ticket；#368 含 7 个 BP Ticket。逐 Epic 分页结果与本地 `hierarchy-report.json` 一致；尚未发现 Ticket 下的额外正式子 Issue。
- Blocked by：逐 Ticket 正文解析；明确 `None` 的首波为 #44/MT001、#45/MT002、#146/MT103。其余依赖必须按正文显式 Blocked by 与代码/接口前置条件建立，不把 contains 关系当依赖。
- 缺页/冲突：GitHub API 分页完整返回；未发现 403/404 或缺页。旧计划曾写 `source_issues=[]`、无目标 Issue、允许提交和旧工作区路径，这些均被本次用户授权覆盖并已判为过时；本次不提交。
- 外部阻塞：需要专用 PostgreSQL 的 Ticket 缺少 `TEST_DATABASE_URL` 时只能报告环境阻塞，不得回退开发库；生产迁移、部署、启用多租户和发布均明确不在授权内。
- 执行 BASE：Orca 工作区 `/Users/wuyongjun/orca/workspaces/OpenBot/issue6-multitenancy-coordinator-2`，branch `1123786563/issue6-multitenancy-coordinator-2`，HEAD `bab7c0b9b481d6563fdacb99fddf8af21f08c729`，未提交检查点策略。

## 正式事实源

- Spec：`docs/specs/2026-10-14-company-team-multitenancy-design.md`，覆盖 R1–R7、A1–A13 与 §8。
- ADR：`docs/adr/0002-per-user-bot-model-access.md`、`0003-bifrost-openbot-credit-admission.md`、`0004-company-team-tenancy.md`。
- 领域：根 `CONTEXT.md`；`docs/agents/domain.md` 当前缺失，已记录为缺口。
- 分支文档已安全复制到执行工作区并校验存在；当前 `main` 原本缺失这些路径，来源分支为 `1123786563/company-team-multitenancy`。
