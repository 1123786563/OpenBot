## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

运行从委托、能力协商、步骤执行、事件回传到恢复与取消的每个协议环节都携带并校验同一执行归属；恢复不能把运行漂移到别的公司或团队。

## Acceptance criteria

- [ ] 运行创建、步骤执行与事件回传都携带并校验同一归属；缺失归属时拒绝执行。
- [ ] 恢复只在原归属范围内允许；用另一范围的身份恢复被拒绝。
- [ ] 取消传播到执行中的步骤与外部执行，且已产生事件不推送给无权订阅者。
- [ ] 外部线程上下文按持久记录解析归属，不接受请求体指定。

## Blocked by

- MT042 全局扫描只有调度权，每项执行重建业务作用域
- MT046 电脑与浏览器实例分配、远程屏幕与人工接管授权

## Scope boundary

运行协议环节（委托、能力、步骤、事件、恢复、取消）的归属校验；不含各框架适配器。

## Verification

bun test server/tests/multitenancy/runs-protocol.test.ts

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A8, A7, A2。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：Go 侧与原生 agent 在 MT050；两侧契约必须一致，改动需同步。 （原 Ticket 已按粒度要求拆为 2 段，本段为第 1 段。）
