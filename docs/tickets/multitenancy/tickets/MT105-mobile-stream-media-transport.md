## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

移动端的流式响应、上传下载与媒体请求携带当前公司/团队选择，切换范围后旧连接与旧媒体缓存失效。

## Acceptance criteria

- [ ] 流式与媒体请求携带正确选择标识；非同源或未审核路径不附加。
- [ ] 切换范围后旧流订阅被取消，旧媒体缓存不再展示。
- [ ] 在途响应按 generation 规则丢弃。
- [ ] 断网重连后仍使用当前范围，不回退默认。

## Blocked by

- MT104 移动端 tenancy 适配层：选择与缓存
- MT025 事件流订阅授权与外部线程映射归属

## Scope boundary

移动端传输层附加逻辑、流式订阅、媒体请求与缓存。

## Verification

bun test apps/openmuse/apps/mobile/src/openbot/transport.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A10, A2, A7。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：规则与 MT082 一致；发现差异以服务端契约为准并记录。
