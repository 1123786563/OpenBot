## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #206 T 迁移与收尾（本 Ticket 是其 sub-issue）

## What to build

全局登录、健康检查与平台静态目录等端点被逐项显式登记为例外并说明理由与责任人；未登记端点一律要求归属上下文。

## Acceptance criteria

- [ ] 例外清单完整，每项有理由、责任人与验证方式。
- [ ] 未登记端点访问业务数据时被拒绝（有反向测试）。
- [ ] 全局端点不返回任何公司私有内容。
- [ ] 就绪校验在例外登记不完整时失败。

## Blocked by

- #168 旧 REST、Copilot 与移动聚合入口装配与兼容（MT125）
- #73 全局身份、刷新锁与例外端点显式登记（MT030）

## Scope boundary

全局登录、健康检查与平台静态目录的例外登记闭合；不含机器回调与个人直连路径。

## Verification

bun test server/tests/multitenancy/global-exception-closure.test.ts + 登记表审阅

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A6, A11, A13。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：登记表是 MT130 与 MT132 的输入；改动需同步更新。 （原 Ticket 已按粒度要求拆为 2 段，本段为第 1 段。）
