## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

socket/SSE 订阅按订阅者权限校验，事件正文不泄露无权内容；与外部服务建立的线程映射固定公司团队归属，切换团队不会让旧线程继续推送。

## Acceptance criteria

- [ ] 订阅时校验权限；订阅后被撤权则停止推送并关闭连接。
- [ ] 事件正文不包含订阅者无权访问的内容（含错误与状态事件）。
- [ ] 外部线程 ID 携带归属但仍需授权；用另一公司的线程 ID 无法读取或续订。
- [ ] 切换公司/团队后旧范围订阅被取消，不产生跨范围推送。

## Blocked by

- MT022 消息读写、重命名、归档与历史 replay 的授权

## Scope boundary

订阅建立与续订校验、事件正文过滤、外部 thread mapping 归属与解绑。

## Verification

bun test server/tests/multitenancy/streams.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A5, A10。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：客户端在途响应与缓存在 MT080；这里只管服务端推送正确性。
