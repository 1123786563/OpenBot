## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #206 T 迁移与收尾（本 Ticket 是其 sub-issue）

## What to build

为 Web 端选择、缓存、在途响应、深链接与长连接补齐验收证据。

## Acceptance criteria

- [ ] 切换公司与团队后不显示旧范围在途响应或缓存（有证据）。
- [ ] 新标签页、深链接与长连接遵守相同规则。
- [ ] 无资格与撤权状态有明确界面与拒绝行为。
- [ ] 缺口被修复并重跑，或明确记录为阻塞项。

## Blocked by

- #175 身份矩阵 runner 与逐入口覆盖状态输出（MT132）
- #140 Web 账单、订单与团队用量视图（MT097）

## Scope boundary

Web 端选择、缓存、在途响应、深链接与长连接的覆盖证据。

## Verification

bun test app/tests/multitenancy + 覆盖报告

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A3, A10, A11, A13。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：真机或模拟器不可用时显式标记未验证，不计入通过。 （原 Ticket 已按粒度要求拆为 2 段，本段为第 1 段。）
