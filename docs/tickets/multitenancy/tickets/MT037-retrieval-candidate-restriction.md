## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #195 I 知识与记忆（本 Ticket 是其 sub-issue）

## What to build

知识检索先确定允许的库与文档集合，再在检索端限制返回范围；无权内容不会进入重排、不会进入模型上下文，也不会通过引用泄露。

## Acceptance criteria

- [ ] 无权文档既不出现在结果，也不参与重排（可通过候选集合断言验证）。
- [ ] 向量集合/命名空间按归属隔离；跨范围检索返回空而不是他人内容。
- [ ] 引用只包含调用者有权访问的文档；引用文本不泄露无权内容片段。
- [ ] 公司范围 Key 不被当作团队授权使用（有专门测试）。

## Blocked by

- #79 知识库的团队归属与受限查询（独立库，不假装跨库外键）（MT036）

## Scope boundary

检索候选集合构造、向量命名空间隔离、引用与返回内容过滤。

## Verification

bun test server/tests/multitenancy/retrieval-restriction.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A4, A8。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：“检索后过滤”不算隔离；测试必须断言候选集合本身。
