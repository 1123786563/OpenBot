## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #206 T 迁移与收尾（本 Ticket 是其 sub-issue）

## What to build

主库中 Bot、会话与附件、凭据与插件相关子记录按复合关联回填公司/团队归属，保证不会关联到与父记录不同的公司。

## Acceptance criteria

- [ ] 本批对象的子记录归属与父记录一致；不一致情况被检测并报告，不静默覆盖。
- [ ] 回填可中断续跑且不重复写入；幂等重跑结果一致。
- [ ] 约束与校验双重保证跨公司关联被数据库拒绝。
- [ ] 输出本批进度与计数校验报告，供后续批次与一致性校验消费。

## Blocked by

- #156 历史根记录归属回填并保持既有个人授权（MT113）
- #59 Bot 与配置的创建、列表、详情按公司团队归属（MT016）
- #64 频道与会话列表、计数、分页游标的作用域（MT021）
- #70 连接凭据与站点登录归属，可用不等于可读明文（MT027）
- #74 插件安装与连接归属（目录只读，安装不全局）（MT031）

## Scope boundary

主库中 Bot、会话与附件、凭据、插件相关子记录的复合关联回填与进度记录。

## Verification

bun test server/tests/multitenancy/child-backfill-main-batch1.test.ts（真实 PostgreSQL）

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A12, A1, A6。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：依赖清单较长是因为需要各闭环的归属字段先存在；领取前逐项核对依赖已集成。 （原 Ticket 已按粒度要求拆为 4 段，本段为第 1 段。）
