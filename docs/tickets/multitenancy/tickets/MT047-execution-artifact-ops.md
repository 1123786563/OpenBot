## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #197 K 执行隔离（本 Ticket 是其 sub-issue）

## What to build

执行侧的快照、shell 命令、文件读写、取消、重置与清理操作都按归属授权，工作目录与快照不跨公司/团队可见或可复用。

## Acceptance criteria

- [ ] 快照与工作目录按归属命名与隔离；列举与下载都需要授权。
- [ ] shell 与文件操作以执行业务身份授权，不以机器身份放大权限。
- [ ] cancel/reset/cull 只对有权主体生效，且操作留审计。
- [ ] 清理任务不会删除其他范围的快照或工作目录。

## Blocked by

- #89 电脑与浏览器实例分配、远程屏幕与人工接管授权（MT046）

## Scope boundary

快照与工作目录归属、shell 与文件操作授权、cancel/reset/cull 入口。

## Verification

bun test server/tests/multitenancy/execution-artifacts.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A1, A2, A8, A5。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：Craft/Workshop 产物在 MT055；这里只管执行侧运行时状态。
