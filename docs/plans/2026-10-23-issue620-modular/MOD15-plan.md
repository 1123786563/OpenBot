# MOD15 计划（#635：统一个人记忆审核召回与遗忘的业务出口，S7-memory M10）

状态：冻结（2026-10-26）。实施基点 `9e352088c`（集成 HEAD）。实施 Agent claude；Brief 全文内嵌。

## 0. 侦察事实（编排者已核实 @ `9e352088c`）

- `memory/`（8 文件 2631 行）：store.ts（createMemoryStore :47）、ingestion.ts（normalizeConnectorRecords/quoteMemoryContext/defaultSourceTool/createMemoryIngestion :185）、routes.ts（createMemoryRoutes+MemoryPauseControlAccess）、sensitivity/defaults/tools/types/company。
- `hindsight/`（23 文件 11.5k 行，#376 收口合入）：scoped-recall/degraded-recall/preference-recall/revocation(ledger)/sensitivity-gate/sync-queue/pause-controls/judgment-review/derived-judgments/personal-memory-context/budget-gate/health 等。
- `openmuse-personal/memories.ts`（438 行，当前适配面）。
- 跨模块记忆消费者：`copilot.ts`、`agents/lifecycle-reset.ts`、`agents/agent-resolver.ts`、`proactive/engine.ts`、`assembly/http.ts`+`runtime.ts`、`app.ts`、`hindsight/sensitivity-gate.ts`。
- **本票=合并汇入 4 条 cycle 例外（M10→M01/M02，hindsight/memory routes→auth guards/contracts）exit_condition 指向的出口建立票**——出口建立后登记第二段（消费者迁移）。
- 存量测试：memory/hindsight 族（普查补全：opik/hindsight-* 族 + memory 族）。

## 1. 目标形态

### A. `server/src/memory/public.ts`（新增全权）

PersonalMemory 出口门面（能力面以代码+验收证实后冻结，候选）：
- `reviewStatus`/候选读取（委托 store 现有审核判定）；
- `recallAuthorized`（验收①：未审核不可召回+OpenBot 权威重读授权——委托 store + sensitivity/scope 现有过滤，不重做过滤）；
- `forget`/`revokeSource`（验收②：本人确认不扩大来源范围、撤销/遗忘先阻断再清理——委托 revocation/pause 现有机制）；
- 降级同过滤（验收③：Hindsight 故障降级仍同一过滤——委托 hindsight/degraded-recall 现状语义经组内注入）。
硬约束：不暴露 Hindsight 索引/同步实现；类型经组内签名提取；零新策略；只 import M10 组内（memory/**+hindsight/** 组内方向需证）。

### B. `server/src/memory/integration.ts`（新增全权）

具名臂：Hindsight 索引/同步/降级接入的具名装配臂（sync-queue/degraded-recall 装配收拢），装配点改经臂。

### C. 迁移臂（普查先行）

实际召回/过滤/遗忘消费者改经 A：主候选=copilot.ts、agents/lifecycle-reset.ts、agents/agent-resolver.ts、proactive/engine.ts 中的 recall/filter 消费面（普查冻结）；openmuse-personal/memories.ts 按票面「当前适配」处登；其余（identity/bot-services 等）按普查登记。

### D. `server/tests/multitenancy/memory-public.test.ts`（新增全权）

1. 委托等价；2. 验收①未审核不可召回+权威重读；3. 验收②来源范围不扩大+先阻断后清理（现状钉）；4. 验收③降级同过滤（现状钉）；5. 验收④记忆模型成本经受管调用+Learning Skill 独立（结构断言）；6. 验收⑤负向（不默认合并 openmuse_memories 整表/不补做 #376 未完成）；7. 存量 memory/hindsight 套件两侧对照（双侧落盘、完整命令、复跑独立落盘）。

## 2. owned_files（冻结）

A/B/D 新增全权；`assembly/runtime.ts`/`assembly/http.ts`（受限：B 装配+迁移传参最小 hunk）；`server/src/copilot.ts`、`server/src/agents/lifecycle-reset.ts`、`server/src/agents/agent-resolver.ts`、`server/src/proactive/engine.ts`（受限：普查后冻结的 recall/filter 消费点经门面）；`server/src/openmuse-personal/memories.ts`（受限：仅「当前适配」票面衔接点，若需）；两 config（预期零 delta；driven 层照先例）。其余全仓只读（memory 内件/hindsight 23 文件/store 内件零改动——除非适配必须先上报）。事实不符→停下上报。

## 3. 验证门

checker 658 基线一致（M10 合并汇入 4 例外出口段兑现，第二段消费者迁移）；typecheck 0；审计 32 缺口零新增（+新测试 native）；D 全部根入口；存量 memory/hindsight 套件两侧对照（双侧落盘）；biome 我方零新增；复跑独立落盘。

## 4. 验收映射

①→D2；②→D3；③→D4；④→D5；⑤→D6。
