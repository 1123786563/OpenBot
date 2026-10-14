## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

群聊的创建、成员增删与 Bot 席位都限定在同一公司（且符合团队规则）范围内；不能把另一公司的用户或 Bot 拉进群，也不能通过群成员关系读到无权内容。

## Acceptance criteria

- [ ] 跨公司用户或 Bot 无法被加入群；此类请求被拒绝且不泄露对象存在性。
- [ ] 群成员只能访问该群内容，不因此获得其他会话或团队资源权限。
- [ ] 移除成员后其后续读取与事件订阅立即失效。
- [ ] Bot 席位变更经过与 Bot 发布一致的授权判定。

## Blocked by

- MT022 消息读写、重命名、归档与历史 replay 的授权
- MT018 使用团队公共 Bot 时保持使用者自己的会话与凭据

## Scope boundary

群成员模型、Bot 席位分配、群创建与邀请入口。

## Verification

bun test server/tests/multitenancy/group-membership.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A1, A2, A3。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：群内公共 Bot 的身份规则复用 MT018。
