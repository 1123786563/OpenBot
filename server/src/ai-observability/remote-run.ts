/**
 * The governed basic record for a remote AG-UI run this server mediated (F5E1-F2).
 *
 * OWNERSHIP: new with F5E1-F2, because the two compositions this fact otherwise fits each
 * own one half of it and would have to grow the other's contract to serve it —
 * `routes/basic-run.ts` owns the HTTP reporter's shape (classification only, deliberately no
 * upstream write) and `bindings.ts`'s observer gate owns the built-in span path (whose
 * capability is `detailed` by construction). This recorder composes the same machinery — the
 * T07 binding store, T10's run lifecycle, and F5E1-F3's deterministic upstream identity
 * through the verified port — for the in-process remote run, without editing either.
 *
 * WHAT A REMOTE RUN CAN HONESTLY CLAIM (T10): this path sees the AG-UI events that passed
 * through this server and nothing inside the endpoint, so `internalStepsVerified` is always
 * false — the capability is `basic` when events were observed, `unavailable` when none were,
 * never `detailed`.
 *
 * THE CHAIN IS THE RUN'S W3C TRACE (F5E1-F3's discipline, not a second identity scheme): the
 * binding's trace id is the chain the dial propagated to the endpoint, the upstream objects
 * are derived from it deterministically, and a retried materialization asks the backend for
 * the very same trace. A fact with no provable chain records nothing — the same honest no-op
 * the span recorders keep — because a trace id this side cannot prove is never claimed.
 *
 * SETTLEMENT DIVERGES FROM THE SPAN GATE ON ONE POINT, DELIBERATELY. The observer gate fails
 * a span's export closed when upstream objects cannot be established, because an unattributed
 * span is exactly the unattributable write the port refuses. A basic record exports no spans;
 * its deliverable is the LOCAL authoritative binding, and an outcome this process observed is
 * not made unrecorded by an upstream outage — the finish lands, the materialization failure
 * is logged, and the run stays locatable in the binding table (and, after a later successful
 * reconcile path, upstream) rather than silently absent from both.
 */
import type { SafeText } from "../../../shared/ai-observability";
import { getLogger } from "../../../shared/logger";
import type { RunBindingStore } from "./bindings";
import type { ObservationScope } from "./contracts";
import { runUpstreamIdentity } from "./opik-http";
import type { OpikOtlpSpan, OpikPort, OpikRunBindingRef } from "./opik-port";
import {
  beginRunAttempt,
  type RunObservationEvent,
  resolveRunCapability,
} from "./run-lifecycle";
import { nanos, nowNs, W3C_TRACE_ID } from "./span-support";

const log = getLogger("server");

/** The same seven-day lease the HTTP report path and the observer gate write. */
const DEFAULT_BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The run root span's name — the tree's own word for the run, never projected text (the
 * port refuses a withheld name because the read-back locates spans by name). MUST stay the
 * literal `bindings.ts` materializes for built-in runs: the query face locates a run's root
 * by this name without asking which origin wrote it.
 */
const RUN_ROOT_SPAN_NAME: SafeText = { state: "projected", text: "run" };

/** What one remote run's fact carries, in the closed event vocabulary the middleware observed. */
export type RemoteRunRecordInput = Readonly<{
  /** The trusted scope the run's threading minted; null or unissued records nothing. */
  scope: unknown;
  botId: string;
  threadId: string;
  runId: string;
  attemptId: string;
  /** The run's W3C trace id; a fact that carried none provable records nothing. */
  traceId: string | null;
  events: readonly (
    | {
        type:
          | "http_first_frame"
          | "run_started"
          | "disconnected"
          | "success"
          | "error"
          | "interrupted"
          | "canceled";
      }
    | { type: "tool_proposed" | "tool_executed"; toolCallId: string }
  )[];
  endedAt: Date;
}>;

export type RemoteRunRecorder = {
  /** Records one fact. Sync-entry, network-free by contract: the durable work is contained. */
  record(input: RemoteRunRecordInput): void;
};

export function createRemoteRunRecorder(
  deps: Readonly<{
    bindings: Pick<RunBindingStore, "begin" | "finish"> &
      Partial<Pick<RunBindingStore, "reconcile">>;
    /** The verified port behind this deployment, asked at record time, never boot-frozen. */
    port: () => OpikPort | null;
    ttlMs?: number;
    now?: () => Date;
  }>,
): RemoteRunRecorder {
  const ttlMs = deps.ttlMs ?? DEFAULT_BINDING_TTL_MS;
  const now = deps.now ?? (() => new Date());
  return {
    record(input) {
      void recordRemoteRun(deps, { ttlMs, now }, input).catch((error) => {
        log.warn(
          {
            type: "opik-remote-run-record-failed",
            name: (error as Error | null | undefined)?.name,
          },
          "opik-remote-run-record-failed",
        );
      });
    },
  };
}

async function recordRemoteRun(
  deps: Parameters<typeof createRemoteRunRecorder>[0],
  timing: { ttlMs: number; now: () => Date },
  input: RemoteRunRecordInput,
): Promise<void> {
  if (input.scope === null || input.scope === undefined) return;
  /*
   * The wiring seam's own cast discipline: the ONLY writer of this value is the boot
   * threading's `resolveObservationScope` — a scope this process issued. Anything else fails
   * the store's own `assertObservationScope` on the write below, and the refusal is
   * attributable to the scope rather than to a constraint downstream of it.
   */
  const scope = input.scope as ObservationScope;
  const traceId = input.traceId;
  if (traceId === null || !W3C_TRACE_ID.test(traceId)) return;

  // T10: this path sees events, never internals, so `basic` is the honest ceiling.
  const capability = resolveRunCapability({
    internalStepsVerified: false,
    observedEvents: input.events.length > 0,
  });

  const { binding } = await deps.bindings.begin(scope, {
    runId: input.runId,
    attemptId: input.attemptId,
    traceId,
    capability,
    expiresAt: new Date(timing.now().getTime() + timing.ttlMs),
  });
  if (binding.traceId !== traceId) {
    // The authoritative row exists and names a different chain: the first claim stands, the
    // same reconcile discipline the observer gate keeps, and this fact records nothing.
    log.warn(
      { type: "opik-remote-run-binding-trace-conflict", botId: input.botId },
      "opik-remote-run-binding-trace-conflict",
    );
    return;
  }

  /*
   * F5E1-F3's materialization, same ordering on the crash path: create, root, THEN
   * reconcile. A crash between the create and the reconcile leaves upstream objects the
   * deterministic derivation finds again on a retry; a reconcile written first could claim a
   * tree nobody wrote. Absent port (Opik disabled or unverified) or an already-materialized
   * row keeps the binding-only shape — the recorder's local record is complete without it.
   */
  await materializeUpstream(
    deps,
    scope,
    {
      scopeKey: binding.scopeKey,
      runId: binding.runId,
      attemptId: binding.attemptId,
      locatorWorkspace: binding.locatorWorkspace,
      locatorProject: binding.locatorProject,
      opikTraceId: binding.opikTraceId,
    },
    traceId,
  ).catch((error) => {
    log.error(
      {
        type: "opik-remote-run-materialize-failed",
        name: (error as Error | null | undefined)?.name,
      },
      "opik-remote-run-materialize-failed",
    );
  });

  /*
   * The classification, under the same first-terminal-wins discipline the HTTP reporter
   * runs: events already rejected by the lifecycle (a straggler terminal after a standing
   * outcome) are counted, never re-decided, and the store's own first-terminal-write-wins
   * makes a replayed report unable to rewrite a standing outcome.
   */
  const attempt = beginRunAttempt({
    scopeKey: scope.key,
    botId: input.botId,
    threadId: input.threadId,
    runId: input.runId,
    attemptId: input.attemptId,
    origin: "remote-agui",
  });
  for (const event of input.events) {
    attempt.observe(event as RunObservationEvent);
  }
  const record = attempt.record();
  if (record.outcome !== null) {
    await deps.bindings.finish(
      scope,
      input.runId,
      input.attemptId,
      record.outcome.state,
    );
  }
  // No terminal outcome: the binding stays `running` and the lease sweeper's `unknown` is
  // the net — the run may still be executing at the endpoint, and nothing here invents an
  // ending it did not see (T10).
}

async function materializeUpstream(
  deps: Parameters<typeof createRemoteRunRecorder>[0],
  scope: ObservationScope,
  ref: OpikRunBindingRef,
  traceId: string,
): Promise<void> {
  const port = deps.port();
  if (port === null) return;
  if (ref.opikTraceId !== null) return; // an earlier pass materialized this chain
  const reconcile = deps.bindings.reconcile;
  if (reconcile === undefined) {
    // A port without the authoritative store's mapping write is a wiring defect: fail
    // loudly rather than export under an identity nobody records.
    throw new Error("REMOTE_RUN_RECONCILE_UNWIRED");
  }
  const identity = runUpstreamIdentity(traceId);
  const startedAt = new Date();
  const created = await port.createTrace(scope, {
    traceId: identity.opikTraceId,
    name: RUN_ROOT_SPAN_NAME,
    startTime: startedAt,
    binding: ref,
  });
  if (created.outcome !== "ok") {
    throw new Error("REMOTE_RUN_UPSTREAM_UNAVAILABLE");
  }
  const rootSpan: OpikOtlpSpan = {
    traceId,
    spanId: identity.rootSpanId,
    name: RUN_ROOT_SPAN_NAME,
    startTimeUnixNano: nanos(startedAt) ?? nowNs(),
    // The root's close is not observed here — an end time would be a duration nobody
    // measured, so the row stays open and the query face reports what it knows.
    opik: {
      traceId: identity.opikTraceId,
      spanId: identity.rootOpikSpanId,
    },
  };
  const rooted = await port.writeSpans(scope, {
    spans: [rootSpan],
    binding: { ...ref, opikTraceId: identity.opikTraceId },
  });
  if (rooted.outcome !== "ok") {
    throw new Error("REMOTE_RUN_UPSTREAM_UNAVAILABLE");
  }
  await reconcile(scope, ref.runId, ref.attemptId, identity.opikTraceId);
}
