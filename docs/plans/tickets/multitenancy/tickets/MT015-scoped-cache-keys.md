## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #190 D 运行配置（本 Ticket 是其 sub-issue）

## What to build

缓存、事件通道、对象存储前缀、向量命名空间等键都包含真实归属与配置版本，因此切换公司/团队或更新配置后不会读到旧范围的数据。

## Acceptance criteria

- [ ] 同一逻辑键在不同公司/团队下互不命中（有跨范围污染测试）。
- [ ] 配置版本变化后旧缓存条目不再被使用。
- [ ] 键中不包含明文凭据或可反推秘密的信息。
- [ ] 共享基础设施（连接池、模板、静态目录）仍可全局复用，不被误加归属。

## Blocked by

- #57 公司运行配置装配（替换部署级单份租户包）（MT014）

## Scope boundary

缓存键构造、配置版本注入、命名空间前缀规则。

## Verification

bun test server/tests/multitenancy/cache-keys.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A8, A10, A1。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：客户端侧缓存与在途响应在 MT083（Web）与 MT104/MT105（移动）；这里只管服务端与外部命名空间。
