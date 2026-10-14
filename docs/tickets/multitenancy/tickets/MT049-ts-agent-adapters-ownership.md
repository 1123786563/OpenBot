## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

各 TypeScript agent 适配器（不同框架）都消费同一个已验证的执行归属与回调解析结果，不因框架不同而跳过授权。

## Acceptance criteria

- [ ] 逐个适配器验证：归属缺失或被篡改时拒绝执行，而不是以默认身份继续。
- [ ] 适配器不自行构造 Scope，只消费签发入口产生的作用域。
- [ ] 回调解析结果在适配器之间一致（共享测试用例覆盖全部适配器）。
- [ ] 适配器日志与错误包含归属标识但不含明文秘密。

## Blocked by

- MT048 运行协议环节的归属：委托、能力、步骤、事件、恢复与取消

## Scope boundary

TypeScript agent 适配器对已验证归属的消费一致性；不含运行协议实现。

## Verification

bun test server/tests/multitenancy/agent-adapters.test.ts

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A8, A7, A2。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：由「企业运行与回调、TypeScript agent 适配器消费同一已验证归属」拆出的第 2/2 段；上一段（运行协议环节的归属：委托、能力、步骤、事件、恢复与取消）完成并集成后再领取。
