## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

语音会话、听写与模型调用按归属记录并计费；移动聚合接口只返回请求所属范围的数据，不会一次带回多个公司的内容。

## Acceptance criteria

- [ ] 语音与听写会话只对本范围授权主体可见；用量记录归属（供 MT070 计费）。
- [ ] 移动聚合接口的每个子查询都受当前范围限制（逐子查询测试）。
- [ ] 推送设备绑定到具体用户与范围；解绑或撤权后停止推送。
- [ ] 切换范围后聚合结果立即变化，无跨范围缓存。

## Blocked by

- MT060 OpenMuse 任务、计划、监控与租约的作用域
- MT065 OpenMuse 活动流与通知的归属与正文过滤

## Scope boundary

语音/听写会话归属与用量、移动聚合接口作用域、推送设备绑定。

## Verification

bun test server/tests/multitenancy/voice-mobile-bff.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A10, A9。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：客户端选择与传输在 MT104/MT105；本 Ticket 只保证服务端正确。
