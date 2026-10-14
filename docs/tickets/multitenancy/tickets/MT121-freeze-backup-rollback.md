## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

交付可执行的上线与回退程序：冻结写入、备份、恢复、失败隔离，以及「存在多公司数据后不能回退到不理解归属的旧版本」的安全回退路径，并完成一次演练。

## Acceptance criteria

- [ ] 程序覆盖冻结写入、备份、恢复、失败隔离与回退每一步，且有明确判定条件。
- [ ] 完成一次演练并记录耗时、数据量与遇到的问题（停机窗口是实测输入，不是承诺）。
- [ ] 回退路径明确说明何时必须使用仍支持隔离的版本，何时必须先停止业务入口与任务执行。
- [ ] 演练发现的可修复问题在本 Ticket 内修正并重验。

## Blocked by

- MT120 无法归属外部状态的隔离清单与启用阻断

## Scope boundary

运维程序文档与脚本、演练记录、失败隔离与恢复判定。

## Verification

演练记录文档 + bun test server/tests/multitenancy/rollback-procedure.test.ts（可自动化部分）。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A12, A11。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：不执行生产迁移或部署；本 Ticket 只交付程序、脚本与演练证据。
