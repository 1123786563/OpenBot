# MOD18 计划（#638：让评测与 Judge 复用受管模型和隔离工具 Interface，S7-observability M11）

状态：冻结（2026-10-26）。实施基点 `16f97f260`（集成 HEAD，MOD15 已并入）。载体制裁=Orca 或编排者进程内（三连败后按判据择形，落盘纪律入派发 prompt）。

## 0. 侦察事实（编排者已核实 @ `16f97f260`）

- **M11 六条环边（本票出口对象，全部 exit_condition 指向「让 M11 改走公开出口」）**：
  - `judge.ts → billing/{credits-writer,types,usage-evidence,usage-outbox}`（4 条，MOD09/M07 出口段）；
  - `judge.ts → workshop/metering`（1 条，MOD22/WORKSHOP 出口段——**票面属 MOD22，本票仅登记不迁移**）；
  - `routes/experiments.ts → agents/profile-types`（MOD05/M03）、`routes/experiments.ts → auth/guards`（MOD04/M01）——**仅两个纯类型**（`AgentActor`/`AppVariables`），无运行时语义。
- 关键结构：**judge.ts 的 billing/workshop 面全是运行时注入**（注入参数 `deps.billing.{creditWriter,outbox,externalCustomerId}`），import 只取 `USAGE_IDEMPOTENCY_KEY_PREFIX` 常量、两个类型、`createUsageEvidenceRecorder` 工厂、`calculateExactModelUsageCharge` 纯函数与 `UsageChargeError` 类——环边由 import 造成，不是由直调造成。
- **供应商直调点（票面「复用受管模型」的真正对象）**：`execution-runner.ts:221 createGatewayModelCall`——`createOpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL })` + `generateText`；`execution-boot.ts:155 createJudgeEntranceCall` 按 entrance 分派（含 `createEntranceModelCall`），缺席回落 `createGatewayModelCall()`。`EvaluationModelCall` 是接口（:29），`callModel` 可注入覆盖（测试用）。
- **工具面现状**：`execution-boot.ts:136 evaluationToolClassifier`（fail-closed：未声明名一律写）；`tool-steps.ts` 只做观测分类（proposed/executed/unobserved，无执行）；评测不声明工具（runner 头注明示）——**「隔离 Adapter」=既有 `EvaluationToolClassifier` 失败闭合语义，本票不新造 Adapter**。
- 现有出口：`agents/public.ts`（MOD05）、`auth/public.ts`（MOD04）、`enterprise/models/public.ts`（MOD09 七能力受管+双重预算）、`plugins/public.ts`（MOD12 ToolAccess）、`ai-observability/public.ts`（MOD17 observer 门面，同组已存在）。
- 存量测试：`opik-{execution-runner,experiments,judge-scoring,scoring-rules}.test.ts` + 三 integration（**全部 driven，在 e2e-bun-suites.json manifest 内**——两侧对照须走 bun-suites 驱动，不能直跑 bun test：本机 bun 缺 registerHooks）。
- 基线：checker **654**、server typecheck 0、审计 32 缺口/617 native。

## 1. 目标形态

### A. `server/src/ai-observability/scoring/judge.ts` 的跨模块 import 改经公开出口（本票主交付）

- billing 四面经 **MOD09 `enterprise/models/public.ts`**（受管模型/预算门面）与 **MOD10 `billing/public.ts`**（账务族）提供的公开形状：
  - 优先形态=**类型/常量/纯函数经 M11 组内 `ai-observability/public.ts`（MOD17 已建同组门面）再导出**，judge.ts 改 import 门面（一段式，M11 内零跨模块 import）；
  - 若门面侧需要新形状（如 `USAGE_IDEMPOTENCY_KEY_PREFIX` 常量、`CreditWriter`/`UsageOutbox` 类型、`BillingModelCreditPolicyEntry`），按 MOD15 先例**在 M11 组内 public.ts 以类型/常量再导出+签名提取收拢**（零运行时、零新策略）。
- `workshop/metering` 边（MOD22 WORKSHOP 出口段）**本票只登记**：保持现状例外不走迁移，报告列名+入第二段台账。
- 两条身份边（仅类型）经 `agents/public.ts` / `auth/public.ts` 再导出（MOD05/04 出口已建），两段式第二段兑现。

### B. 供应商直调经受管模型 Interface（票面验收②③）

- 把 `createGatewayModelCall`/`createEntranceModelCall` 的「拨号」面收拢为**具名臂**：`ai-observability/integration.ts`（新增全权）或沿用 `execution-boot.ts` 的装配——**落点择形由实施者普查后冻结**（须证明：①经 MOD09 受管模型门面授权与预算裁决 ②拨号与入场同一事实（entranceId 分派不变）③缺席回落语义不变 ④**不新增评分器/供应商能力**）。
- 硬边界：**不在本票新增供应商、不新增模型能力、不改评测产品语义**；`EvaluationModelCall` 接口形状与注入覆盖能力保持。

### C. 迁移臂（普查先行）

「评测协作者」装配侧（assembly/ 中评测相关 wiring）若需传参最小 hunk 可动；其余按普查登记。**普查表先行入报告**（照 MOD15 表式）。

### D. `server/tests/multitenancy/evaluation-governed-model.test.ts`（新增全权，native）

1. 委托等价（judge 的 billing 面经门面 vs 现状注入：同参同结果/错误实例透传）；
2. 验收①冻结数据集/配置/被测版本不随普通 Bot 更新漂移（entrance/approvedVersions/JUDGE_SCORER_VERSION 三键现状钉）；
3. 验收②Judge/样本调用实际走预算与结算+取消后未知费用仍保留（reserveCredits→settle→unknown 证据行；idempotencyKey 前缀常量同源钉）；
4. 验收③评测写工具只接隔离 Adapter，不能回落生产凭据（classifier fail-closed+零生产凭据路径源级钉）；
5. 验收④重试/lease/逐样本重授权维持既有合同（lease 时长三倍 gateway timeout、worker 重授权现状钉）；
6. 验收⑤负向（不新增评分器/供应商能力：门面零新 scorer、零新 provider 面）；
7. 存量评测族七套件两侧对照（双侧落盘、完整命令、复跑独立落盘）。

## 2. owned_files（冻结——与 checker 例外表源端交叉核对后）

`ai-observability/public.ts`（受限：A 所需再导出/签名收拢）；`ai-observability/scoring/judge.ts`、`ai-observability/routes/experiments.ts`（受限：import 改道）；`ai-observability/integration.ts`（新增全权，若 B 择此形）；`assembly/` 评测协作者（受限最小 hunk，若 C 需要）；D 新增全权；两 config（预期零 delta，driven 层照先例——新套件 native 落 e2e 收集）。其余全仓只读（**execution-runner.ts / execution-boot.ts / billing/** / workshop/** / agents 内件 / auth 内件零改动——除非适配必须先上报**）。事实不符→停下上报。

> R1-F1 教训：本清单已与 checker 例外表源端逐一交叉核对（judge/experiments 六条边全在清单内）。

## 3. 验证门

checker **654 基线**（六条边中五条应脱环或两段式兑现；workshop/metering 边维持例外并登记）；typecheck 0；审计 32 零新增（+新测试 native 618）；D 全部根入口；存量评测族七套件两侧对照（BASE=干净树 @ 16f97f260 stash 后首跑，IMPL=同树复跑，走 bun-suites 驱动）；biome 我方零新增；复跑独立落盘。

## 4. 验收映射

①→D2；②→D3；③→D4；④→D5；⑤→D6（D7=存量对照）。
