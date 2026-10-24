// server/src/ai-observability/public.ts
// MOD17（Issue #637，根 #620）：M11 Observability 的 observer 接入出口门面（出口段）。
//
// 三个能力，全部是**薄委托/纯移动**——内件（model-span.ts、tool-steps.ts、health.ts、
// config.ts 等）零改动。两个 observer 工厂是 MOD17 前装配闭包（assembly/runtime.ts
// :7383/:7444）的「事实 → 观察」映射逐字段原样搬迁（移动，不是新写）：注册仍由装配
// 经 copilot.ts 的 setBuiltin*Observer 完成（模块目录 M11：M05 不静态引用 M11，「内部
// observer 由装配注入」的既有方向，本门面不改它）：
//
//   modelSpanObserver(sink)     → 受控观察事实入口（模型调用 span）：BuiltinModelSpanFact
//                                 → sink.record(ModelSpanObservation)（原装配闭包
//                                 :7383-7417 的映射，逐字段一致）
//   toolStepObserver(sink)      → 受控观察事实入口（工具步 span）：同上（原 :7444-7482）
//   observationEnabled(config)  → boot 配置判定只读透传（= config.enabled）
//
// 边界（Issue #637 验收 5 + 模块目录 M11 + Interface 合同 C09 + MOD04-10 先例）：
//   - 不 re-export Opik SDK / opik-http / opik-port / wiring 任何内部面：本文件只
//     import 组内类型（零运行时依赖），消费面=上述三能力与其输入形状。
//   - 事实类型是 M11 自有的结构合同，与 copilot.ts 的 Builtin*Fact 结构同一
//     （copilot.ts「必须不依赖观测模块」的既有纪律保持——M11 不 import 装配，
//     两套结构的 conformance 由装配处把本工厂产物赋给 setBuiltin*Observer 的
//     形参在编译期强制：任一侧漂移即 typecheck 红）。
//   - 有界队列语义由内件承载（health.ts 的 bounded write queue：固定容量、同步
//     submit、计数丢弃、单后台泵），门面不复制队列、不新建 sink、零缓存。
//   - 观察归属=服务器真实 Run/Attempt（验收①）：fact.scope 是服务端 ambient 线程在
//     doStream 入口 / 工具步 cell 开闸时捕获的受信 scope（unknown 结构位，唯一写者
//     是本 boot 的 threading）；无 scope 的 fact 上游零记账（recorder no-op）。
//   - 零新策略、零新存储、零新路由、零新页面字段：本文件无任何判定、落库或挂载面。

import type { OpikConfig } from "./config";
import type { ObservationScope } from "./contracts";
import type { ModelSpanEnding, ModelSpanRecorder } from "./model-span";
import type { ToolStepRecorder } from "./tool-steps";

// ---------------------------------------------------------------------------
// 受控观察事实（结构合同；源头形状 = copilot.ts 的 Builtin*Fact，见文件头）
// ---------------------------------------------------------------------------

/**
 * One built-in model call's observation fact, as the execution path raises it and
 * this module accepts it. Read-only server facts only — the run's trusted scope and
 * W3C chain arrive as structural `unknown`/coordinates captured INSIDE this process
 * at the call's entry; no client-supplied field exists on this contract.
 */
export type BuiltinModelSpanFact = Readonly<{
  /** The billed call's server-minted identity; not consumed by the adapter. */
  eventId: string;
  startedAt: Date;
  endedAt: Date;
  provider: string | undefined;
  modelId: string | null;
  ending: ModelSpanEnding;
  /**
   * The serialized provider request prompt, bounded AT CAPTURE and projected only
   * inside the recorder (never trusted, stored or logged here).
   */
  input: string | null;
  /** The accumulated output text, bounded AT CAPTURE; projected only at the recorder. */
  output: string | null;
  /** The run's trusted scope captured at `doStream` entry (see the cast below). */
  scope: unknown;
  /** The run's W3C chain captured at `doStream` entry; null roots the span's own trace. */
  trace: Readonly<{ traceId: string; spanId: string }> | null;
}>;

/**
 * One built-in tool step's observation fact: the proposal, the real execute and the
 * receipt as three separately observed facts, never collapsed. Same discipline as the
 * model-span fact — server-captured scope/trace, no client-supplied field.
 */
export type BuiltinToolStepFact = Readonly<{
  toolCallId: string;
  toolName: string | null;
  /** When the proposal was observed; null when only the execution was. */
  proposedAt: Date | null;
  endedAt: Date;
  proposalObserved: boolean;
  executionObserved: boolean;
  receiptObserved: boolean;
  /** What the real execute settled to; present only when executionObserved. */
  execution: Readonly<{
    kind: "succeeded" | "failed" | "canceled";
    output: string | null;
  }> | null;
  window: "interrupted" | "terminal";
  /** The run's trusted scope captured when the cell opened (see the cast below). */
  scope: unknown;
  /** The run's W3C chain captured when the cell opened. */
  trace: Readonly<{ traceId: string; spanId: string }> | null;
  /** The raw accumulated call arguments — BEFORE projection; the recorder projects. */
  input: string | null;
  /** The execution output or error text — BEFORE projection; the recorder projects. */
  output: string | null;
}>;

// ---------------------------------------------------------------------------
// 门面
// ---------------------------------------------------------------------------

/** The model-span half's minimal dependency: any sink exposing the recorder's
 * `record`（含真实 createModelSpanRecorder 的产物——队列语义在内件）。 */
export type ModelSpanObserverSink = Pick<ModelSpanRecorder, "record">;

/** The tool-step half's minimal dependency（同上）。 */
export type ToolStepObserverSink = Pick<ToolStepRecorder, "record">;

/**
 * The model-call observation entry: adapts one built-in model-span fact into the
 * recorder's observation. The mapping is the pre-MOD17 assembly closure
 * (:7383-7417) moved verbatim — zero new policy, zero filtering, zero containment
 * (an observer that throws propagates to the execution path's own containment,
 * exactly as before). Registered by assembly via setBuiltinModelSpanObserver only
 * when the boot config says enabled; unregistered means no capture happens at all.
 */
export function modelSpanObserver(
  sink: ModelSpanObserverSink,
): (fact: BuiltinModelSpanFact) => void {
  return (fact) =>
    sink.record({
      occurredAt: fact.startedAt,
      endedAt: fact.endedAt,
      provider: fact.provider,
      modelId: fact.modelId,
      ending: fact.ending,
      input: fact.input,
      output: fact.output,
      // The run's trusted scope (T-final M1), CAPTURED at the fact's doStream
      // entry and carried here on the fact itself (OCR R2-58): by stream
      // teardown — where settlement reports the fact — the ambient context is
      // not guaranteed (the same discipline the fact's trace field documents),
      // so reading the ambient store at THIS moment silently no-op'd the main
      // path's success spans. A fact whose entry captured no scope — a run that
      // started scope-less — stays exactly as scope-less as before: the record
      // is a no-op upstream. The cast is the wiring seam's own: the ONLY writer
      // of that captured value is copilot.ts's entry read of the store this
      // boot's threading established — a scope this process issued (T06's
      // WeakSet trust), never a wire value.
      scope: fact.scope as ObservationScope | undefined,
      // The run's W3C chain captured at doStream entry (OCR h6, the tool-step
      // precedent): the model span joins the run's trace instead of rooting a
      // fresh random one — one trace per run, no orphan pseudo-runs in the
      // collection window.
      ...(fact.trace
        ? {
            trace: {
              traceId: fact.trace.traceId,
              parentSpanId: fact.trace.spanId,
            },
          }
        : {}),
    });
}

/**
 * The tool-step observation entry: the pre-MOD17 assembly closure (:7444-7482)
 * moved verbatim, on the same footing as the model spans above — zero new
 * policy, zero containment, registered by assembly only when enabled.
 */
export function toolStepObserver(
  sink: ToolStepObserverSink,
): (fact: BuiltinToolStepFact) => void {
  return (fact) =>
    sink.record({
      toolCallId: fact.toolCallId,
      toolName: fact.toolName ?? undefined,
      proposedAt: fact.proposedAt ?? undefined,
      endedAt: fact.endedAt,
      proposalObserved: fact.proposalObserved,
      executionObserved: fact.executionObserved,
      receiptObserved: fact.receiptObserved,
      execution: fact.execution,
      window: fact.window,
      input: fact.input,
      output: fact.output,
      // The run's trusted scope (T-final M1), CAPTURED at the tool-step cell's
      // open and carried here on the fact itself (OCR R3-39 — the model-span
      // adapter's own OCR R2-58 discipline, now on the tool-step half): the
      // settlement that reports the fact can land at stream teardown — the
      // finalize hook runs OUTSIDE the run's ambient context — where reading
      // the ambient store silently no-op'd the record. A fact whose open
      // captured no scope — a run that started scope-less — stays exactly as
      // scope-less as before: the record is a no-op upstream. The cast is the
      // wiring seam's own: the ONLY writer of that captured value is
      // copilot.ts's cell-open read of the store this boot's threading
      // established — a scope this process issued (T06's WeakSet trust), never
      // a wire value.
      scope: fact.scope as ObservationScope | undefined,
      // The run's W3C chain captured at cell open (Issue #23/T17): the step span
      // joins the cross-service trace instead of rooting a fresh random one.
      ...(fact.trace
        ? {
            trace: {
              traceId: fact.trace.traceId,
              parentSpanId: fact.trace.spanId,
            },
          }
        : {}),
    });
}

/**
 * The read-only boot judgement: only the literal `true` enabled the integration
 * (config.ts's own parsing), and this delegates that one boolean with no second
 * opinion. Assembly gates both observer registrations on it — a disabled
 * deployment registers nothing, so no capture happens at all.
 */
export function observationEnabled(
  config: Pick<OpikConfig, "enabled">,
): boolean {
  return config.enabled;
}
