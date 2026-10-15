## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #206 T 迁移与收尾（本 Ticket 是其 sub-issue）

## What to build

剩余主库业务对象的子记录按同一复合关联规则回填，沿用第一批的进度与校验机制，不重复实现回填框架。

## Acceptance criteria

- [ ] 本批对象的子记录归属与父记录一致；不一致被检测并报告。
- [ ] 复用第一批的进度记录与幂等机制；中断后可续跑。
- [ ] 跨公司关联被数据库拒绝（约束 + 校验）。
- [ ] 输出本批进度与计数校验报告，并标记主库回填完成状态。

## Blocked by

- #157 主库子记录回填第一批：Bot、会话、凭据与插件（MT114）
- #82 个人记忆与来源选择保持个人权限（MT039）
- #84 任务、运行、触发与租约固定原始归属与配置版本（MT041）
- #96 Craft 会话、turn、消息与快照的作用域（MT053）
- #100 Workshop 会话、执行、产物与沙箱实例关联的作用域（MT057）
- #103 OpenMuse 任务、计划、监控与租约的作用域（MT060）
- #112 公司计费 Customer 映射与公司/个人账户类型（expand）（MT069）
- #120 网络、能力与模型路由策略和模板按归属保存（MT077）
- #152 用量事件的账户区分与脱敏回归（MT109）

## Scope boundary

主库中记忆、任务、Craft/Workshop、OpenMuse、账务、策略与遥测子记录的回填；复用第一批框架。

## Verification

bun test server/tests/multitenancy/child-backfill-main-batch2.test.ts（真实 PostgreSQL）

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A12, A1, A6。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：由「子记录复合关联回填与主库/知识库进度一致性」拆出的第 2/4 段；上一段（主库子记录回填第一批：Bot、会话、凭据与插件）完成并集成后再领取。
