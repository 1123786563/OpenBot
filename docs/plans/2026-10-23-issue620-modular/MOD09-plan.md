# MOD09 计划（#629：收拢受管模型调用与双重预算结算链路，S4 M06/M07）

状态：冻结（2026-10-25）。实施基点 `5f5528900`（集成 HEAD）。实施 Agent claude；Brief 全文内嵌。

## 0. 侦察事实（编排者已核实 @ `5f5528900`）

- `enterprise/models/`（4 文件 3060 行）：budget.ts（`createModelBudgetService`/`reserveModelBudgetInTransaction`/`ModelBudgetError`/`assertRunBudgetClaim`/`runCeilingIdempotencyKey`）、gateway.ts（`ModelGateway`/`AuthorizedModelInvocation`/`ResolveAuthorizedInvocation`）、两 Adapter。
- `runs/governed-execution.ts`：capability issue 面（`budgetExhausted()` :71-72、续跑询问**剩余**预算 :95-107、402 归类 :119-150）——M05 内件，capability issue/resolve/confirm/unknown 属 worker/engine 内部面（MOD07 普查已登记）。
- billing 侧：`credit-reserve.ts`（RESERVE_REFUSAL_REASONS/ReserveBoundEvidence）、credit-settle/credit-release/credits-writer（runtime :5995 `billing.creditWriter.reserveCredits`）；结算入口族 batch/image/speech/transcription/video-settlement。
- **assembly 内联预算组合**（票面「assembly 的具名预算组合」靶点）：runtime.ts :5879 `createCreditWriter` → :5961 creditPolicy → :5976-5995 reserveCredits 内联链。
- MOD08 已建 M06 出口（gateway/public.ts 六能力，无 invoke——dispatch 属内部 Adapter）；75 条 M06 环例外与 M07 环例外（10 条 runs→conversations-store 等）不属本票消除对象（消费迁移票处理）。
- 存量测试：billing-credits 族、async-settle-once、credit-remainder、governed-execution 族（MOD07 native 桶）、budget/gateway adapter 测试。
- **验收②设计约束**：ModelAccess 不 import Run store——预算协作者经**装配注入**（依赖倒置，非模块 import）。

## 1. 目标形态

### A. `server/src/enterprise/models/public.ts`（新增全权）

受管调用+预算出口门面（能力面以代码+合同证实后冻结，候选：`authorizeInvocation`/`reserveBudget`/`settleInvocation`/`releaseUnknown` 一族）——委托 models/budget+gateway 与 billing credit 既有判定；**不 import runs/store**（验收②：Run 协作者经构造注入的协作者接口，类型经组内/参数签名提取）；价格/上限依据集中（验收③原 Payer/价格版本）。

### B. `server/src/assembly/model-budget.ts`（新增全权，具名预算组合）

把 runtime.ts :5879-5995 一带内联组合（creditWriter/creditPolicy/reserve 调用形状）收拢为具名组合体，注入 A 门面所需的预算协作者；runtime.ts 受限 hunk 改用之。零新策略——组合搬移。

### C. 迁移臂（普查先行）

执行者**先普查**受管调用链全消费点（governed-execution capability 面、gateway dispatch Adapter、billing reserve/settle 入口、assembly 组合点），冻结实际迁移清单后动刀：主候选=assembly 内联组合经 B + A 门面在受管调用链的真实接线点。M05 governed-execution 内件与 billing 结算入口族预期零改动（内件），dispatch Adapter 若需经门面按普查结论登记/迁移。事实不符→停下上报。

### D. `server/tests/multitenancy/model-invocation-budget-public.test.ts`（新增全权）

1. 委托等价；2. 验收①token+资金双放行才 dispatch（顺序钉，第二阶段失败不误 dispatch）；3. 验收②ModelAccess 零 Run store import（源级钉+装配注入类型证）；4. 验收③原 Payer/价格版本固定、取消/断流不释放未知费用（现状源级钉）；5. 验收④reserve/settle/ack 重放不重扣（幂等现状钉+存量对照）；6. 验收⑤token 确认不冒充资金结算、网络调用不入长 DB 事务（结构断言）；7. 存量 governed/reserve/settle 套件两树对照（双侧落盘；完整命令防 config 排除项坑——MOD08 教训）。

## 2. owned_files（冻结）

A/B/D 新增全权；`assembly/runtime.ts`（受限：内联组合改 B+接线 hunk）；`gateway/` dispatch Adapter 或 `billing/` 结算入口**仅在普查结论要求时**经上报获批后加入（先上报后扩权）；`tests/config/module-imports.json`（预期零 delta；A 在 enterprise/models=M06 组内，import billing 会成 M06→M07 新边——**B 组合体在 assembly 不判边**，A 若需 billing 类型须参数签名提取，MOD06 先例）。其余全仓只读。

## 3. 验证门

checker 654 零 delta；typecheck 恰 3；审计 26+608 native；D 全部根入口；存量 governed/reserve/settle 两树对照（双侧落盘，完整命令）；biome 我方零新增。

## 4. 验收映射

①→D2；②→D3；③→D4；④→D5；⑤→D6。
