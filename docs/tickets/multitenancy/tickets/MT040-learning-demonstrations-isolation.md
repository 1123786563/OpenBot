## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #195 I 知识与记忆（本 Ticket 是其 sub-issue）

## What to build

学习容器、连接应用研究与演示记录按归属隔离；外部学习服务不会把不同公司的客户内容放进同一个容器或同一个命名空间。

## Acceptance criteria

- [ ] 容器分配记录归属；回收后不复用给另一范围而不清理状态。
- [ ] 研究与演示记录只对本范围授权主体可见。
- [ ] 外部服务调用的命名空间/路径按归属隔离，且不含明文凭据。
- [ ] 撤销访问后正在运行的学习任务在下一个敏感动作处失败或取消。

## Blocked by

- #79 知识库的团队归属与受限查询（独立库，不假装跨库外键）（MT036）
- #57 公司运行配置装配（替换部署级单份租户包）（MT014）

## Scope boundary

学习容器分配与回收、研究记录归属、演示记录与缓存。

## Verification

bun test server/tests/multitenancy/learning-demonstrations.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A8, A1。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：外部服务缺凭据时完成本地确定性测试并标记该能力未验证，不编造证据。
