## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

把主库与知识库的回填结果做跨库一致性校验，检测一侧成功一侧失败的情况，并输出可复核的回填报告。

## Acceptance criteria

- [ ] 跨库不一致被检测、报告并可从断点续跑，不被当作完成。
- [ ] 报告包含范围、计数、抽样对照、隔离清单与未决项。
- [ ] 报告可被独立验证者用记录的命令复现。
- [ ] 存在未决项时阻断后续启用（与就绪强制一致）。

## Blocked by

- MT114 主库子记录回填第一批：Bot、会话、凭据与插件
- MT115 主库子记录回填第二批：记忆、任务、Craft/Workshop、OpenMuse、账务与策略
- MT116 知识库侧归属回填与独立进度记录

## Scope boundary

主库与知识库回填结果的跨库一致性校验、断点续跑与可复核报告；不含具体回填实现。

## Verification

bun test server/tests/multitenancy/backfill-consistency.test.ts（两个测试库）

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A12, A1, A6。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：由「子记录复合关联回填与主库/知识库进度一致性」拆出的第 4/4 段；上一段（知识库侧归属回填与独立进度记录）完成并集成后再领取。
