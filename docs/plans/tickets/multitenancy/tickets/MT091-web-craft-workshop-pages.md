## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #202 P Web 客户端（本 Ticket 是其 sub-issue）

## What to build

Craft 与 Workshop 的列表、详情、产物与执行页面按范围工作；产物下载走授权签发。

## Acceptance criteria

- [ ] 列表与详情只反映当前范围；跨范围 ID 得到不可见语义。
- [ ] 产物下载与预览走授权签发，撤销后界面立即反映不可用。
- [ ] 执行与调度动作提交当前范围。
- [ ] 既有创作与执行交互回归通过。

## Blocked by

- #126 按公司团队隔离查询缓存并拒绝旧 generation 的在途响应（MT083）
- #100 Workshop 会话、执行、产物与沙箱实例关联的作用域（MT057）

## Scope boundary

Craft 与 Workshop 列表、详情、产物与执行页面绑定；不含分享页受众逻辑。

## Verification

bun test app/tests/multitenancy/web-craft-workshop.test.tsx

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A3, A4, A10。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：分享契约以 MT058 为准；前端不自行放宽受众判断。 （原 Ticket 已按粒度要求拆为 2 段，本段为第 1 段。）
