## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #200 N 账务（本 Ticket 是其 sub-issue）

## What to build

按部署客户归属的历史积分只迁移一次到原有公司账户；已存在的个人余额保留个人归属；无法判断类型的记录先受控隔离再核验。外部 Bot 直连 Bifrost 的个人余额机制完全不变。

## Acceptance criteria

- [ ] 迁移幂等：重复执行不会重复入账或复制余额到个人账户。
- [ ] 无法判断账户类型的记录进入隔离清单并阻断相关启用，不按用户身份猜测。
- [ ] 个人 Bifrost 直连路径的准入、Key 与余额行为回归通过，未被公司路径改变。
- [ ] 迁移前后总额守恒，有对账证据。

## Blocked by

- #112 公司计费 Customer 映射与公司/个人账户类型（expand）（MT069）
- #46 按任务生成迁移的安全迁移工具（dry-run/apply + manifest）（MT003）

## Scope boundary

历史余额映射与迁移、隔离清单、个人直连路径回归。

## Verification

bun test server/tests/multitenancy/balance-migration.test.ts + Bifrost 个人路径回归套件。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A12, A13。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：实际生产迁移不在本 Ticket；只提供工具、测试与证据。
