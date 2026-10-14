## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

Go Runtime、supervisor、agent-computer 与 agent-sandbox 等原生组件从调用方接收并回传同一执行归属，跨语言边界不丢失授权事实。

## Acceptance criteria

- [ ] 归属字段在跨语言调用中不被丢弃或改写；缺失时拒绝执行。
- [ ] 原生组件不以本地信任为由跳过授权校验（含 supervisor 与 sandbox）。
- [ ] 日志与错误包含归属标识但不含明文秘密。
- [ ] Go 侧测试覆盖正向与越权两类用例。

## Blocked by

- MT049 TypeScript agent 适配器统一消费已验证归属

## Scope boundary

跨语言契约（归属字段与校验）、原生组件的授权检查点、回调与日志归属。

## Verification

go test ./...（runtime-go 及受影响 module）+ bun test server/tests/multitenancy/native-runtime.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A8, A1, A2。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：跨语言契约变更必须同时更新 MT049 侧，并在两个 Ticket 的报告中互相引用。
