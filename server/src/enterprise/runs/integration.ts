// server/src/enterprise/runs/integration.ts
// MOD07（Issue #627，根 #620）：M05 的具名内部执行装配臂（出口段）。
//
// 只做一件事：把「治理执行 carrier」的装配从装配层内联直传
// （assembly/runtime.ts 原两处 `createGovernedModelExecution({...})`——headless
// 治理回合 governedExecutionFor 与续跑回路 governedResumeSurface，及
// runs/runner.ts admitAndExecute 的浏览器路径 carrier 装配）收拢为 M05 组内的
// **具名臂**。此前治理执行内部件（runs/governed-execution.ts：网关 dial、
// capability 签发/对账 ledger、路由重绑 fail-closed）在装配点被直接触达；
// 此后这一装配有唯一具名入口，且：
//
//   - governed-execution.ts 零改动：臂内逐字节调用同一工厂（同参、同缺省
//     语义——environment 缺省 process.env、fetch 缺省运行时 fetch）。
//   - 治理执行细节不进 public：ExecuteMastra/ExecutionBinding（mastra/
//     execution-contracts.ts）与引擎执行入口（mastra/governed-agent.ts 的
//     executeGovernedMastra）是 M05 内部 Adapter，经本臂/组内文件承载，
//     public.ts 结构性不含（Issue #627 验收 5；模块目录 M05「引擎只执行已
//     准入事实」）。
//   - 类型纪律（MOD05/06 先例）：入参与产物形状经 M05 组内 governed-execution
//     工厂签名以 Parameters<>/ReturnType<> 提取，本文件不 import M02
//     contracts——零新跨模块边（检查器 654 零 delta 的前提）。
//
// 边界（Issue #627 验收 5）：本臂是装配层接入治理执行 carrier 的具名通道；
// 「臂具名且逐字节包装内件工厂」由 tests/multitenancy/run-lifecycle-public.test.ts
// 源级/结构断言钉死（MOD06 createMastraStorageArm 同法）。

import { createGovernedModelExecution } from "./governed-execution";

/** 内件工厂类型（M05 组内；本臂的委托目标）。 */
type GovernedExecutionFactory = typeof createGovernedModelExecution;

/** 臂入参形状（= GovernedModelExecutionDependencies：受信 scope/agent/route/
 *  ceiling + runs/catalog/凭据读取 + 可选环境与 fetch、ME10 已结算种子——
 *  经工厂签名提取，字段语义留在内件）。 */
export type GovernedExecutionArmInput = Parameters<GovernedExecutionFactory>[0];

/** 臂产物（= GovernedModelExecution carrier：governedModel 协作者 + bind/
 *  wasModelConsumed/settlementClean/预算与对账探针）。 */
export type GovernedExecutionCarrier = ReturnType<GovernedExecutionFactory>;

/**
 * 具名装配臂：包装治理执行 carrier 的构造。逐字节转发内件工厂（零逻辑、
 * 零判定、零缺省改写）；装配层与浏览器 runner 经本臂接入治理执行，
 * 不再内联直传。
 */
export function createGovernedExecutionArm(
  input: GovernedExecutionArmInput,
): GovernedExecutionCarrier {
  return createGovernedModelExecution(input);
}
