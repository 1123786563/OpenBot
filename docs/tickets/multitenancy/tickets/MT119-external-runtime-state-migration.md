## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

外部线程映射、浏览器登录态与工作目录、向量集合命名空间按归属迁移或受控隔离，避免跨范围状态残留。

## Acceptance criteria

- [ ] 外部线程映射迁移后归属正确，旧映射不可被其他范围复用。
- [ ] 浏览器状态与工作目录要么迁移到正确命名空间，要么被清理并记录。
- [ ] 向量集合/命名空间按归属隔离；跨范围检索返回空。
- [ ] 迁移过程可续跑且不破坏正在执行的运行（有失败注入测试）。

## Blocked by

- MT118 对象存储文件与产物的归属迁移
- MT037 检索在候选、重排与进入模型之前限制范围
- MT052 状态化公共 Bot 为不同使用者隔离浏览器与工作区

## Scope boundary

外部线程映射、浏览器状态、工作目录与向量命名空间迁移；不含对象存储文件。

## Verification

bun test server/tests/multitenancy/external-runtime-migration.test.ts

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A12, A8, A6。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：由「外部状态迁移：文件、线程、浏览器、向量与无法归属隔离」拆出的第 2/3 段；上一段（对象存储文件与产物的归属迁移）完成并集成后再领取。
