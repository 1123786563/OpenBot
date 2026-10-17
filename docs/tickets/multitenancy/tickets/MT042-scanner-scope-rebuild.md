## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #196 J 任务与执行（本 Ticket 是其 sub-issue）

## What to build

平台扫描可以发现所有公司的到期任务，但每项执行都必须依据服务器持久化记录重建业务作用域与资格；机器认证不能伪造普通用户身份，序列化 Scope 不被当作可信 Scope。

## Acceptance criteria

- [ ] 扫描器可以列出跨公司到期任务，但不能读取其业务内容。
- [ ] 每项执行前从持久化记录重建 Scope；队列消息里的公司/团队字段不被信任。
- [ ] 机器身份不会得到 dev-local-user 或普通用户权限；试图这样使用时被拒绝。
- [ ] 反序列化的 Scope 被拒绝；只有签发入口产生的 Scope 有效。

## Blocked by

- #84 任务、运行、触发与租约固定原始归属与配置版本（MT041）

## Scope boundary

扫描与调度入口、执行前作用域重建、机器认证与业务身份分离。

## Verification

bun test server/tests/multitenancy/scanner-scope.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A8, A6, A2。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：与 MT005 的签发校验共用实现；不要复制一份判定逻辑。
