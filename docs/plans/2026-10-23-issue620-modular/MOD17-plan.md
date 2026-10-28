# MOD17 计划（#637：让运行观测通过内部 observer 接入并隔离可选故障，S7 M11）

状态：冻结（2026-10-26）。实施基点 `cd9f43a02`（集成 HEAD）。实施 Agent claude；Brief 全文内嵌。

## 0. 侦察事实（编排者已核实 @ `cd9f43a02`）

- `ai-observability/`：33 项 12.4k 行（opik-* 族/opik-contract/opik-port/bindings/context/model-span/tool-steps/span-support/execution-*/admin-summary/redaction/scope/datasets/queries/routes/scoring…）；`telemetry/`：4 文件 510 行（otel/request-tracking/scrub/trace-middleware）。
- **observer 接线真实（生产）**：runtime.ts :7383 `setBuiltinModelSpanObserver((fact)=>…)`、:7444 `setBuiltinToolStepObserver((fact)=>…)`——仅 boot 配置启用时注册、有界写队列、未注册即零记账（现状机制正合验收②）。
- MOD17 环例外 3 条：`tenancy/telemetry-usage.ts → telemetry/scrub.ts`（M02→M11）、`mastra/continuation-routes.ts` 与 `mastra/tools.ts → ai-observability/datasets.ts`（M05→M11）——exit_condition 两段式，消费者迁移属后续票（本票=出口段，零 delta）。
- 存量测试：opik-* 族（bindings/case-review/comparison/contract/admin-summary 等 native+integration 双层）。
- 验收③「强制审计失败不能一起降为 best effort」=审计与观测的独立性（审计路径不经 observer best-effort 通道）；⑤「不重复 #4 原树新观测页面/存储」=负向边界。

## 1. 目标形态

### A. `server/src/ai-observability/public.ts`（新增全权）

observer 接入出口门面（能力面以代码证实后冻结，候选）：
- `modelSpanObserver` / `toolStepObserver`：受控观察事实入口（fact 类型=服务器真实 Run/Attempt 绑定——验收①，不暴露 Opik SDK 类型）；
- `observationEnabled`（boot 配置判定只读）；
- 有界队列语义由内件承载（wiring/model-span/tool-steps 的 bounded queue 现状），门面不复制队列。
硬约束：不 re-export Opik SDK/opik-http/opik-port 内部面；类型经组内签名提取；零新策略；只 import M11 组内（ai-observability/**、telemetry/**）+合法方向。

### B. 迁移臂

runtime.ts :7383/:7444 两 observer 注册改经 A 门面（组内→装配的合法方向，生产链路真实）；装配闭包其余逐字节不动。`telemetry/scrub` 与 `datasets` 跨模块面不迁移（3 环例外第二段登记）。

### C. `server/tests/multitenancy/observability-observer-public.test.ts`（新增全权）

1. 委托等价；2. 验收①运行归属=服务器 Run/Attempt（源级钉：fact 出自服务端上下文，无客户端自报字段）；3. 验收②关闭/故障不影响执行+队列/丢弃有界（现状队列语义钉+未注册零记账）；4. 验收③审计独立（结构断言：审计路径零 observer 调用）；5. 验收④查询/导出权限按当前权限（现状钉，公司汇总不放开私人内容）；6. 验收⑤负向（门面零新存储/零新页面字段）；7. 存量 opik 套件两侧对照（双侧落盘、完整命令）。

## 2. owned_files（冻结）

A/C 新增全权；`assembly/runtime.ts`（受限：两 observer 注册改经门面，逐 hunk）；`tests/config/module-imports.json`（预期零 delta）。其余全仓只读（ai-observability 内件、telemetry/**、mastra/**、tenancy/**）。事实不符→停下上报；纯类型零运行时适配可先行但置顶登记。

## 3. 验证门

checker 654 零 delta；typecheck 恰 3；审计 26 缺口+609 native（新测试计入）；D 全部根入口；存量 opik 套件两侧对照（双侧落盘）；biome 我方零新增；复跑结果独立落盘（MOD10 F-3 纪律）。

## 4. 验收映射

①→C2；②→C3；③→C4；④→C5；⑤→C6。
