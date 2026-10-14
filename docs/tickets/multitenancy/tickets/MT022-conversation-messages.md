## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

会话内的消息发送、读取、重命名、归档与历史线程 replay 都要求对应权限；公共 Bot 不会把使用者的个人会话公开给团队。

## Acceptance criteria

- [ ] 非成员不能读取或写入该会话消息；不能通过历史 replay 绕过。
- [ ] 重命名与归档分别授权；可读不派生可改。
- [ ] 公共 Bot 使用者的个人会话不出现在团队列表或团队搜索中。
- [ ] 撤权后（MT007）消息读写与 replay 立即失效。

## Blocked by

- MT021 频道与会话列表、计数、分页游标的作用域

## Scope boundary

消息写入与读取入口、重命名/归档动作、历史线程 replay 授权。

## Verification

bun test server/tests/multitenancy/conversation-messages.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A3, A4。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：附件与事件流分别在 MT024、MT025。
