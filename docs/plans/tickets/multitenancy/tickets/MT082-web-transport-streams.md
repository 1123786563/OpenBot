## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #202 P Web 客户端（本 Ticket 是其 sub-issue）

## What to build

流式连接在建连、续订与重连时携带当前范围；切换范围后旧连接被取消，不再推送旧范围事件。

## Acceptance criteria

- [ ] 建连与重连都携带当前选择；缺失时不建立业务订阅。
- [ ] 切换范围后旧连接被取消，界面无旧范围事件。
- [ ] 断网重连后使用当前范围，不回退默认。
- [ ] 与客户端缓存 generation 规则一致，不产生旧响应写入。

## Blocked by

- #124 Web REST 与上传下载签发统一附加当前范围（MT081）
- #68 事件流订阅授权与外部线程映射归属（MT025）

## Scope boundary

SSE/WebSocket 建连、续订、重连的范围附加与旧连接终止；不含 REST 与上传下载。

## Verification

bun test app/tests/multitenancy/transport-streams.test.tsx

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A10, A6, A3。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：由「REST、SSE、WebSocket 与上传下载统一附加当前范围」拆出的第 2/2 段；上一段（Web REST 与上传下载签发统一附加当前范围）完成并集成后再领取。
