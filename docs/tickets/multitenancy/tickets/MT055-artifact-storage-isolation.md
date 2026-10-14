## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

Craft 与 Workshop 产生的产物在对象存储中按归属隔离寻址；路径前缀只用于寻址，任何读取都要经过授权，列举不会跨范围泄露。

## Acceptance criteria

- [ ] 产物路径包含归属标识但不可作为授权依据；直接猜测路径读取被拒绝。
- [ ] 列举只返回本范围产物；跨范围列举为空。
- [ ] 删除与清理只影响本范围。
- [ ] 产物元数据（名称、大小、时间）不泄露给无权用户。

## Blocked by

- MT053 Craft 会话、turn、消息与快照的作用域

## Scope boundary

产物记录归属、对象存储路径规则、列举与读取授权。

## Verification

bun test server/tests/multitenancy/artifact-storage.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A8, A1。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：下载签发与代理在 MT056；两者一起构成产物访问边界。
