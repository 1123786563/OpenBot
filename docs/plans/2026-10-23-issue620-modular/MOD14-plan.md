# MOD14 计划（#634：让定时职责投递与 Worker 统一消费持久 Run 用例，S7 Automation）

状态：冻结（2026-10-26）。实施基点 `d4e6140c5`（集成 HEAD）。实施 Agent claude；Brief 全文内嵌。**本票为普查先行型**（后台入口经 deps 注入间接触发，编排者侦察证实零直调 `runs.start`——实际触发链须普查冻结后动刀）。

## 0. 侦察事实（编排者已核实 @ `d4e6140c5`）

- 五 Automation 模块：`routines/`（2456 行：routes/runner/schedule/store/sweep）、`responsibilities/`（4090 行：bindings/email/engine/github/routes/signatures）、`proactive/`（1339 行：engine/private-share/restriction/routes/store）、`delivery/`（3209 行：opentag/push/router/routes/store）、`work/`（721 行：culler/loop/queue）+ `worker/src/index.ts`（199 行）。
- **零直调 `runs.start`/`runLifecycle`**（上述六处 grep 证实）——触发链经 deps 注入间接到达（疑似路径：work/loop.ts 队列→worker；routines/runner→？；responsibilities/engine→？）。**实际触发链=本票第一交付物（普查表）**。
- MOD07 `runs/public.ts` 五能力（start/get/getActiveForThread/cancel/stop）+ MOD09 continuations.ts（WaitRef/claim）在档；生产消费者现状=runner admit + HMR gateway（MOD11）。
- 存量测试：routines/responsibilities/proactive/delivery/work 族（普查补全精确清单）。
- 基线：checker 658、typecheck 0、审计 32 缺口/615 native。

## 1. 目标形态

### A. 统一消费改造（普查冻结后动刀）

按触发类型逐项把后台执行入口的 Run 创建/恢复面改经 `runs/public.ts` RunLifecycle（additive；不另写 turn/预算/恢复——复用 MOD07/09/13 既有语义）。触发语义（频率/收件人/投递）**留在各 Automation Module**（票面明示）。

### B. 普查表（第一交付物）

全量后台入口×触发类型×当前 Run 触达方式（deps 链）×迁移/登记处置；「所有实际启用入口」覆盖性论证（验收④）。worker/server 循环/CronJob 三形态同用例证据。

### C. `server/tests/multitenancy/automation-runs-public.test.ts`（新增全权）

1. 统一消费等价（迁移前后同触发→同 Run 事实）；2. 验收①重投递收敛（幂等现状钉）；3. 验收②领取/重试/恢复从持久事实重建资格+Payer（不用当前 UI/旧缓存 scope——源级钉）；4. 验收③触发语义保持+暂停/租约失效可证（存量对照）；5. 验收④三形态同用例覆盖（结构断言+普查表冻结）；6. 存量 Automation 套件两侧对照（双侧落盘、完整命令、复跑独立落盘）。

## 2. owned_files（冻结——普查后一次性细化报批）

A/C 新增全权；**普查冻结的消费者文件**（预期 routines/runner.ts、responsibilities/engine.ts、proactive/engine.ts、delivery/router.ts、work/loop.ts、worker/src/index.ts 中实际触 Run 的子集，受限 hunk）；`assembly/runtime.ts`（受限最小接线）；两 config（预期零 delta；driven 层照先例）。**普查结论超出本清单时停下上报获扩权**。其余全仓只读（runs 内件/各 Automation 模块触发语义内件零改动）。事实不符→停下上报。

## 3. 验证门

checker 658 基线一致；typecheck 0；审计 32 缺口零新增（+新测试 native）；C 全部根入口；存量 Automation 套件两侧对照（双侧落盘、完整命令、复跑独立落盘）；biome 我方零新增。

## 4. 验收映射

①→C2；②→C3；③→C4；④→C5。
