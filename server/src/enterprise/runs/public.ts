// server/src/enterprise/runs/public.ts
// MOD07（Issue #627，根 #620）：M05 RunLifecycle 的业务门面（出口段）。
//
// 五个能力，全部是**薄委托**——内件（runs/service.ts、store.ts、events.ts、
// governed-execution.ts 等）零改动，提交幂等/准入校验/lease 与 generation 栅栏/
// 取消-完成竞争语义逐字节不动：
//
//   start(scope, admission)              → RunService.start：聊天提交→Run 建立
//                                          （服务端签发 TrustedRunAdmission；
//                                          Run/Attempt/generation 全部内件铸造，
//                                          不由客户端选择）。
//   get(scope, runId)                    → RunService.get：读取运行状态。
//   getActiveForThread(scope, threadId)  → RunService.getActiveForThread：线程
//                                          当前活动运行（含服务端读回的
//                                          attemptId/generation，只读投影）。
//   cancel(scope, input)                 → RunService.cancel：终态写入（无租约
//                                          取消——超时/取代回退语义，内件原样）。
//   stop(scope, input)                   → RunService.stop：终态写入（代次栅栏
//                                          停止——用户主动取消，内件原样）。
//
// 边界（Issue #627 验收 5 + 模块目录 M05 + MOD06 先例）：
//   - **worker/engine 面零暴露**：领取/续约/释放租约、fail/complete 终态写入、
//     capability issue/resolve/confirm、预算预留、suspension（markRunSuspended/
//     reactivateSuspensionLease/disposeUnresumableSuspensions）全部留在 M05 内部
//     （模块目录 M05：「领取、续约、complete/fail、capability issue 等进入内部
//     worker/engine Interface，不向浏览器开放」）。Mastra 执行细节
//     （ExecuteMastra/ExecutionBinding/治理执行 carrier）经 integration.ts 具名臂
//     留 M05 内部，同样不进本门面。
//   - 不 re-export RunService/store/lease 整面：消费面 = 上述五能力 + 其输入/
//     结果形状；构造依赖用 Pick<内件服务, 五能力> 最小面
//     （run-lifecycle-public.test.ts D5 结构断言钉死）。
//   - 类型纪律（MOD05/06 先例）：形状源头是 M02 enterprise/contracts
//     （PlatformScope/TrustedRunAdmission/RunDTO/CancelRunInput），但为守住检查器
//     654 零 delta（module-imports.json 预期零 delta），本文件不直接 import M02——
//     全部经 M05 组内 service.ts 工厂签名以 Parameters<>/Awaited<>/ReturnType<>
//     提取（零新跨模块边；提取物与 contracts 定义结构同一）。
//   - 零新策略、零缓存、零新 durable workflow 权威：门面不含任何判定逻辑，
//     逐项透传（断线 vs 主动取消的区别、终态与业务证据一致性全部留在内件）。

import type { createRunService } from "./service";

// ---------------------------------------------------------------------------
// 输入/结果形状（源头 = M02 contracts，经 M05 组内 service 签名提取）
// ---------------------------------------------------------------------------

/** 内件服务实例类型（M05 组内；其公开能力即本门面的委托目标）。 */
type InternalRunService = ReturnType<typeof createRunService>;

/** 受信业务上下文（M02 PlatformScope 形状）。 */
export type RunLifecycleScope = Parameters<InternalRunService["start"]>[0];

/** 服务端签发的 Run 准入（M02 TrustedRunAdmission 形状：input + agentId +
 *  expertVersionRef + routeRef——两个 ref 均为服务端组合独立签发，非客户端
 *  wire 字段；客户端不可选择 Run/Attempt/generation）。 */
export type TrustedRunLifecycleAdmission = Parameters<
  InternalRunService["start"]
>[1];

/** 运行记录（M02 RunDTO 形状：服务端铸造的 run_id/attempt/generation 状态）。 */
export type RunLifecycleRecord = Awaited<
  ReturnType<InternalRunService["start"]>
>;

/** 线程当前活动运行（含服务端读回的 attemptId/generation；null=无活动）。 */
export type ActiveThreadRunState = Awaited<
  ReturnType<InternalRunService["getActiveForThread"]>
>;

/** 无租约取消输入（M02 CancelRunInput 形状：runId + reason 三值枚举）。 */
export type CancelRunLifecycleInput = Parameters<
  InternalRunService["cancel"]
>[1];

/** 代次栅栏停止输入（CancelRunInput & { attemptId, generation }——内件
 *  validateStopInput 原样校验）。 */
export type StopRunLifecycleInput = Parameters<InternalRunService["stop"]>[1];

// ---------------------------------------------------------------------------
// 门面
// ---------------------------------------------------------------------------

/** M05 RunLifecycle 公开门面（模块目录 M05：公共用例 = 启动、取消/停止、读取
 *  状态；本票面 = 五能力）。 */
export interface RunLifecyclePublic {
  /** 聊天提交→Run 建立：委托内件 start（准入校验/幂等/路由夹逼/预算预留
   *  合同全部留在内件）。 */
  start(
    scope: RunLifecycleScope,
    admission: TrustedRunLifecycleAdmission,
  ): Promise<RunLifecycleRecord>;
  /** 读取运行状态：委托内件 get。 */
  get(scope: RunLifecycleScope, runId: string): Promise<RunLifecycleRecord>;
  /** 线程当前活动运行：委托内件 getActiveForThread。 */
  getActiveForThread(
    scope: RunLifecycleScope,
    threadId: string,
  ): Promise<ActiveThreadRunState>;
  /** 终态（无租约取消）：委托内件 cancel。 */
  cancel(
    scope: RunLifecycleScope,
    input: CancelRunLifecycleInput,
  ): Promise<RunLifecycleRecord>;
  /** 终态（代次栅栏停止）：委托内件 stop。 */
  stop(
    scope: RunLifecycleScope,
    input: StopRunLifecycleInput,
  ): Promise<RunLifecycleRecord>;
}

/** 门面构造依赖：内件服务的五能力最小面（装配层构造后注入）。 */
export interface RunLifecyclePublicDeps {
  readonly runs: Pick<
    InternalRunService,
    "start" | "get" | "getActiveForThread" | "cancel" | "stop"
  >;
}

/**
 * 构造 M05 生命周期门面。零新策略、零缓存、零写入判定：每个能力逐项委托
 * deps.runs 的既有内件实例（幂等/租约/代次栅栏/取消-完成竞争合同全部留在
 * 内件，逐字节不动）。
 */
export function createRunLifecyclePublic(
  deps: RunLifecyclePublicDeps,
): RunLifecyclePublic {
  const { runs } = deps;
  return {
    start(scope: RunLifecycleScope, admission: TrustedRunLifecycleAdmission) {
      return runs.start(scope, admission);
    },
    get(scope: RunLifecycleScope, runId: string) {
      return runs.get(scope, runId);
    },
    getActiveForThread(scope: RunLifecycleScope, threadId: string) {
      return runs.getActiveForThread(scope, threadId);
    },
    cancel(scope: RunLifecycleScope, input: CancelRunLifecycleInput) {
      return runs.cancel(scope, input);
    },
    stop(scope: RunLifecycleScope, input: StopRunLifecycleInput) {
      return runs.stop(scope, input);
    },
  };
}
