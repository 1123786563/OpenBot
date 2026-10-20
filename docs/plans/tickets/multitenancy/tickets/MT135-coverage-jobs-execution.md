## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #206 T 迁移与收尾（本 Ticket 是其 sub-issue）

## What to build

为后台任务、电脑与沙箱、运行协议与原生适配器补齐归属与越权证据，重点覆盖状态串用风险。

## Acceptance criteria

- [ ] 扫描、认领、重试、取消、恢复路径都有归属与越权证据。
- [ ] 浏览器、沙箱、工作目录与快照无跨范围串用证据。
- [ ] 跨语言边界（Go/原生）归属传递有证据。
- [ ] 缺口被修复并重跑，或明确记录为阻塞项。

## Blocked by

- #175 身份矩阵 runner 与逐入口覆盖状态输出（MT132）
- #88 主动建议与外部调用前后的事务边界（MT045）
- #94 执行上界、审批与机密脱敏的既有保证不回退（MT051）

## Scope boundary

后台任务、电脑与沙箱、运行协议与原生适配器的覆盖证据与小缺口修复。

## Verification

bun test server/tests/multitenancy/coverage-jobs-execution.test.ts + 覆盖报告

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A5, A8, A11, A12。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：与 MT134 并行时注意共享测试数据库与端口冲突，需分开实例或串行。 （原 Ticket 已按粒度要求拆为 2 段，本段为第 1 段。）
