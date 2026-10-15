## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #206 T 迁移与收尾（本 Ticket 是其 sub-issue）

## What to build

Worker 与后台程序装配不含启动期默认公司；每项执行按持久记录重建业务作用域，机器身份不获得普通用户权限。

## Acceptance criteria

- [ ] Worker 启动不装配默认公司/团队；缺失归属的任务被隔离而非以默认身份执行。
- [ ] 每项执行重建作用域并校验资格（复用扫描侧规则）。
- [ ] 机器身份不能读取任意公司业务数据（越权测试）。
- [ ] 后台程序的配置解析按记录归属，不读全局可变状态。

## Blocked by

- #172 多租户启动就绪强制与缺口阻断（MT129）
- #85 全局扫描只有调度权，每项执行重建业务作用域（MT042）

## Scope boundary

Worker 与后台程序装配去默认公司及执行前作用域重建；不含启动就绪判定实现。

## Verification

bun test server/tests/multitenancy/worker-assembly.test.ts

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A6, A8, A11。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：由「多租户启动就绪强制与 Worker 装配去默认公司」拆出的第 2/2 段；上一段（多租户启动就绪强制与缺口阻断）完成并集成后再领取。
