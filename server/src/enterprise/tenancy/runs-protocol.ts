// server/src/enterprise/tenancy/runs-protocol.ts
// MT048（Issue #91）：运行协议环节的归属——委托、能力、步骤、事件、恢复与取消。
//
// 票面：运行从委托、能力协商、步骤执行、事件回传到恢复与取消的每个协议
// 环节都携带并校验同一执行归属；恢复不能把运行漂移到别的公司或团队。
//
// 本文件是协议面的归属编排，不是第二套运行协议：每个环节的持久语义仍
// 由既有 RunService / EventService（真实 RLS + 归属三比 WHERE + 租约栅栏）
// 执行，本服务做三件它们各自不做的事：
//
//   1. 同一归属纪律的单一入口：六个环节共用同一个受信 PlatformScope
//      （MT005 集中签发 seam 的唯一产物），第一行 assertTrustedScope——
//      手造/JSON 往返的同形 scope 在任何环节都不产生执行（AC1「缺失归属
//      时拒绝执行」）。跨 scope 的对象在持久层就是不可见（scoped WHERE
//      不命中），不泄露存在性。
//   2. 取消的完整传播（AC3）：terminalize（租约栅栏 stop，回退 cancel）
//      → 中止在途步骤（步骤 seam，生产装配接线 runner 的活跃流注册表）
//      → 外部执行面传播（#90 的 cancelExecution：ExecutionGrant 判定 +
//      逐面 ExecutionSurface + 审计行）。三段都是先判定后动手，任何一段
//      失败不阻断其余（surface 单面抛错落 unavailable，#90 既有纪律）。
//   3. 订阅者的撤权重验（AC3 后半）：事件回放/订阅在读任何事件行之前
//      先经撤权检查点（MT007 guard）——已产生的事件不推送给无权订阅者，
//      「无权」包括持有已签发 scope 但成员资格已被停用/移除的主体。
//
// 外部线程上下文（AC4）不经由本服务：resolveForThread（tenancy/store.ts）
// 是持久线程记录 → 归属的唯一解析口，请求体/头里的归属字段在该路径上
// 结构性不存在（runner-scope 套件既有覆盖；本票测试再钉一次 forged 值
// 不被消费）。
//
// 边界（诚实披露）：
//   - 不接生产装配（index.ts）：seam 由接线票落（与 #86/#87/#90 同例）；
//     测试以真实服务组装并全绿。
//   - 取消传播的 bot 归属由 #90 的判定独立复核（异 workspace 的 bot =
//     canonical deny，一个执行面都不被调用）；run 取消与 bot 传播是两个
//     对象的两个判定，互不冒充（job-control 同款边界）。

import type {
  EventCursor,
  EventPage,
  EventProposal,
  EventService,
  ModelInvocationCapability,
  ModelInvocationCapabilityInput,
  PlatformScope,
  RunDTO,
  RunnerRequestLease,
  RunService,
  TrustedRunAdmission,
} from "../contracts";
import { RunDomainError } from "../runs/store";
import type { RevocationGuard } from "./revocation";
import { assertTrustedScope } from "./store";

/** #90 取消传播 seam 的结构面（createExecutionArtifactsService 满足它）。 */
export interface ExecutionCancellationSeam {
  cancelExecution(
    scope: PlatformScope,
    botId: string,
    input?: { readonly runId?: string },
  ): Promise<
    | { readonly outcome: "allow"; readonly attempts: readonly unknown[] }
    | { readonly outcome: "deny"; readonly code: "RESOURCE_NOT_FOUND" }
  >;
}

/**
 * 在途步骤的中止 seam（AC3「取消传播到执行中的步骤」）。
 *
 * 生产装配把 runner 的活跃流注册表（activeStreams，runId → AbortController）
 * 适配到这里；返回 false = 该 run 当前没有在途步骤（与「已中止」不可区分，
 * 调用方不需要区分）。
 */
export interface ProtocolStepsSeam {
  abort(runId: string): boolean;
}

export interface RunsProtocolDependencies {
  readonly runs: RunService;
  readonly events: EventService;
  /**
   * 订阅面撤权检查点（MT007）。提供时 replayEvents 在读任何事件行之前
   * 重验两级成员资格；生产装配总是提供（createRevocationGuard）。
   */
  readonly revocation?: RevocationGuard;
  /** #90 外部执行面传播；缺省 = 本部署无可传播面（取消只 terminalize）。 */
  readonly execution?: ExecutionCancellationSeam;
  /** 在途步骤中止；缺省 = 无在途步骤可中止（单请求部署语义不受影响）。 */
  readonly steps?: ProtocolStepsSeam;
}

/** 取消请求里调用方关联的执行侧对象（传播目标；归属由 seam 独立判定）。 */
export interface ProtocolCancelInput {
  /** 按线程取消（runner stop 的形状）：只作用于该线程的活跃 run。 */
  readonly threadId?: string;
  /** 按 runId 取消：scoped 读取，他人/异 scope 的 run 不可见。 */
  readonly runId?: string;
  readonly reason: "user_requested" | "timeout" | "superseded";
  /** 关联的 Bot（传播目标）；归属由 #90 判定独立复核。 */
  readonly botId?: string;
}

export type CancelProtocolOutcome =
  | {
      readonly outcome: "cancelled";
      readonly run: RunDTO;
      /** 在途步骤中止的结果：aborted = 有流被中止；none = 本无在途流。 */
      readonly steps: "aborted" | "none";
      /** 传播摘要：未关联执行对象时 requested:false；deny 与 allow 都如实回传。 */
      readonly propagation: {
        readonly requested: boolean;
        readonly verdict?: "allow" | "deny";
      };
    }
  | { readonly outcome: "not-found" };

/** run 终态前的活跃状态（store 的 activeRunStatuses 同集）。 */
const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "running",
  "waiting_approval",
  "suspended",
]);

const CANCEL_REASONS = new Set(["user_requested", "timeout", "superseded"]);

export function createRunsProtocolService(
  deps: RunsProtocolDependencies,
): RunsProtocolService {
  const { runs, events } = deps;

  /** 委托（AC1）：受信归属 + 入场票据 → 持久 run 行携带归属三比。 */
  async function startRun(
    scope: PlatformScope,
    admission: TrustedRunAdmission,
  ): Promise<RunDTO> {
    assertTrustedScope(scope);
    return runs.start(scope, admission);
  }

  /** 能力（AC1）：能力签发钉在 scope+run+attempt+generation 上。 */
  async function issueCapability(
    scope: PlatformScope,
    input: ModelInvocationCapabilityInput,
  ): Promise<ModelInvocationCapability> {
    assertTrustedScope(scope);
    return runs.issueModelInvocationCapability(scope, input);
  }

  /**
   * 步骤/事件写面（AC1）：事件回传必须携带该 run 的当前租约，且租约
   * 属于本 scope——异 scope 的同形租约在 lockRunAndAttempt 处即
   * RUN_ATTEMPT_STALE，不落一行事件。
   */
  async function appendEvent(
    scope: PlatformScope,
    proposal: EventProposal,
  ): Promise<ReturnType<EventService["append"]>> {
    assertTrustedScope(scope);
    return events.append(scope, proposal);
  }

  /**
   * 事件读/订阅面（AC3 后半）：数据访问之前先判撤权（级联生效），然后
   * 按 scope 三比分页——已产生的事件对异 scope 订阅者是空页，对已撤权
   * 订阅者是一次拒绝，都不是内容。
   */
  async function replayEvents(
    scope: PlatformScope,
    cursor: EventCursor,
  ): Promise<EventPage> {
    assertTrustedScope(scope);
    if (deps.revocation) {
      await deps.revocation.assert(scope, "events.subscribe");
    }
    return events.replay(scope, cursor);
  }

  /**
   * 恢复（AC2）：断线重连/租约过期后的重新认领。只在原归属范围内允许
   * ——认领的 WHERE 带归属三比，另一范围的受信身份对同一 runId 得到的
   * 是 RUN_NOT_ACTIVE（不可见语义），不产生第二次执行。
   */
  async function recoverLease(
    scope: PlatformScope,
    runId: string,
  ): Promise<RunnerRequestLease> {
    assertTrustedScope(scope);
    if (typeof runId !== "string" || !runId.trim())
      throw new Error("INVALID_RUN_ID");
    return runs.acquireRequestLease(scope, runId);
  }

  /**
   * 取消（AC3）：terminalize → 中止在途步骤 → 外部执行面传播。
   *
   * 先 scoped 解析活跃 run（线程路径给出活跃 attempt，可直接走租约栅栏
   * stop；runId 路径先 scoped 读取再 cancel）。跨 scope 的 run 在这里
   * 就是 not-found：不 terminalize、不中止、不传播、不泄露存在性。
   */
  async function cancelRun(
    scope: PlatformScope,
    input: ProtocolCancelInput,
  ): Promise<CancelProtocolOutcome> {
    assertTrustedScope(scope);
    if (!input || !CANCEL_REASONS.has(input.reason))
      throw new Error("INVALID_CANCEL_REASON");
    const runId =
      typeof input.runId === "string" && input.runId.trim()
        ? input.runId
        : null;
    if (!input.threadId && !runId) throw new Error("CANCEL_TARGET_REQUIRED");

    let run: RunDTO;
    if (input.threadId) {
      const active = await runs.getActiveForThread(scope, input.threadId);
      if (!active) return { outcome: "not-found" };
      if (input.runId && active.run.run_id !== input.runId)
        return { outcome: "not-found" };
      try {
        run = await runs.stop(scope, {
          runId: active.run.run_id,
          reason: input.reason,
          attemptId: active.attemptId,
          generation: active.generation,
        });
      } catch (error) {
        // 只有结构化 stale 码是安静落空（并发终态化）；其它错误如实抛出。
        if (
          error instanceof RunDomainError &&
          error.code === "RUN_ATTEMPT_STALE"
        ) {
          return { outcome: "not-found" };
        }
        throw error;
      }
    } else if (runId !== null) {
      // scoped 读取：异 scope 的 runId 在这里就是不可见（RUN_NOT_FOUND
      // 是行级事实，不是存在性信号——与「不存在」共用同一出口）。
      let target: RunDTO;
      try {
        target = await runs.get(scope, runId);
      } catch (error) {
        if (error instanceof RunDomainError && error.code === "RUN_NOT_FOUND") {
          return { outcome: "not-found" };
        }
        throw error;
      }
      if (!ACTIVE_RUN_STATUSES.has(target.status)) {
        return { outcome: "not-found" };
      }
      try {
        run = await runs.cancel(scope, {
          runId: target.run_id,
          reason: input.reason,
        });
      } catch (error) {
        if (error instanceof RunDomainError && error.code === "RUN_NOT_FOUND") {
          return { outcome: "not-found" };
        }
        throw error;
      }
    } else {
      // CANCEL_TARGET_REQUIRED 已在入口拦截；这行只让控制流闭合。
      throw new Error("CANCEL_TARGET_REQUIRED");
    }

    // 步骤中止：run 已不存在，其事件不得再持久化（runner 的 relay 纪律）。
    const steps = deps.steps?.abort(run.run_id) === true ? "aborted" : "none";

    // 外部执行面传播：归属判定在 #90（ExecutionGrant → 逐面 surface → 审计行）。
    let propagation: { requested: boolean; verdict?: "allow" | "deny" };
    if (deps.execution && input.botId !== undefined) {
      const verdict = await deps.execution.cancelExecution(scope, input.botId, {
        runId: run.run_id,
      });
      propagation =
        verdict.outcome === "allow"
          ? { requested: true, verdict: "allow" }
          : { requested: true, verdict: "deny" };
    } else {
      propagation = { requested: false };
    }
    return { outcome: "cancelled", run, steps, propagation };
  }

  return {
    startRun,
    issueCapability,
    appendEvent,
    replayEvents,
    recoverLease,
    cancelRun,
  };
}

export interface RunsProtocolService {
  /** 委托。 */
  startRun(
    scope: PlatformScope,
    admission: TrustedRunAdmission,
  ): Promise<RunDTO>;
  /** 能力。 */
  issueCapability(
    scope: PlatformScope,
    input: ModelInvocationCapabilityInput,
  ): Promise<ModelInvocationCapability>;
  /** 步骤/事件（写面：步骤把自己的事件回传到持久流上）。 */
  appendEvent(
    scope: PlatformScope,
    proposal: EventProposal,
  ): Promise<ReturnType<EventService["append"]>>;
  /** 事件（读/订阅面）。 */
  replayEvents(scope: PlatformScope, cursor: EventCursor): Promise<EventPage>;
  /** 恢复（重连/租约过期后的重新认领）。 */
  recoverLease(
    scope: PlatformScope,
    runId: string,
  ): Promise<RunnerRequestLease>;
  /** 取消（terminalize + 在途步骤中止 + 外部执行面传播）。 */
  cancelRun(
    scope: PlatformScope,
    input: ProtocolCancelInput,
  ): Promise<CancelProtocolOutcome>;
}
