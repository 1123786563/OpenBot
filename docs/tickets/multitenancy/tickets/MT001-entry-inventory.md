## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

任何 agent 或审阅者都能运行一个清单命令，得到当前真实注册的全部 HTTP/内部/stream 入口、后台程序、数据表与外部依赖，并看到哪些入口还没有归属负责人。清单是多租户覆盖验收的唯一入口事实源，替代人工猜测。

## Acceptance criteria

- [ ] 清单来自真实应用装配（部署入口与企业入口）而非手写常量，包含动态与条件注册的路由。
- [ ] 输出机器可读清单（入口、类型、所属业务闭环、负责人任务、状态）与人类可读缺口报告。
- [ ] 新增或删除一个入口后重跑清单，缺口报告随之变化，测试可检测到漂移。
- [ ] 清单命令在缺少测试数据库配置时仍可运行（静态部分），需要数据库的部分显式跳过并说明原因，不静默通过。

## Blocked by

None (can start immediately).

## Scope boundary

入口清单生成器与静态候选提取；只读现有装配，不改业务行为。

## Verification

bun test server/tests/multitenancy/inventory.test.ts；清单生成命令输出 JSON + 缺口报告。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A6, A11。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：后续所有闭环 Ticket 与验收 harness（MT132）都消费本清单；契约一旦定义不要私自改字段名。
