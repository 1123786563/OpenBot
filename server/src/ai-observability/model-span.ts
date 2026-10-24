/**
 * Model-call recording for the built-in execution path (Issue #20 / DAG T14).
 *
 * This is the observation BYPASS: it never calls a provider, never recomputes a usage
 * number and never sits between the metered path and its Settlement — it reads the
 * verdict the existing path already reached and turns it into exactly one span.
 *
 * Honesty rules, inherited from T10 rather than reinvented: a span ends on an actual
 * outcome, usage is `actual` only when the provider's finish chunk reported it, and a
 * missing report is an explicit `unavailable` — never a silent 0, because "we do not
 * know" and "it was free" are different facts. A refusal or settlement failure is a
 * failure-terminal span; nothing here can upgrade it into a success.
 *
 * Egress is structural: the projected span enters ONLY through the T09 bounded write
 * queue, never a direct port call. Content reaches the queue only after the T05
 * projection — and since FREV-01, span bodies carry free text only behind an approval
 * minted from the Bot's configured security policy; without one the span is
 * metrics-only. Even approved, the deny patterns run first and always win, so a
 * credential-shaped canary dies at the projection, not in transit.
 *
 * Scoping: a span is written upstream only when the observation carries a scope this
 * process issued (T06). The built-in path's facts arrive without one today — the
 * run-association tickets own threading it — and a scope-less observation submits
 * nothing rather than inventing an owner.
 */
import { randomBytes } from "node:crypto";
import type { ObservationScope } from "./contracts";
import type { OpikHealthService, OpikObservationWrite } from "./health";
import type { OpikOtlpSpan } from "./opik-port";
import {
  DEFAULT_METADATA_ALLOWLIST,
  projectSafeName,
  projectSafeRecord,
  type SafeRecord,
} from "./redaction";
import {
  issuedSpanContentApproval,
  nanos,
  nowNs,
  projectApprovedSpanContent,
  type SpanContentApproval,
  W3C_SPAN_ID,
  W3C_TRACE_ID,
} from "./span-support";

/**
 * The one ending a model call's observation carries. `succeeded` is the metered path's
 * settled verdict with the usage it committed (a confirmed 0/0 included); every other
 * kind is the honest non-success.
 */
export type ModelSpanEnding =
  | { kind: "succeeded"; inputTokens: number; outputTokens: number }
  /** The call was refused before the provider saw anything (gate or bound refusal). */
  | { kind: "refused"; code: string }
  /** The stream completed but the settlement rejected the usage (ModelUsageSettlementError). */
  | { kind: "settlement_failed"; code: string }
  | { kind: "failed"; code: "provider_error" | "stream_error" }
  | { kind: "canceled" }
  /** The stream completed but no usage was ever reported: unknown, not zero. */
  | { kind: "usage_missing" };

/** What the built-in path actually observed for one model call. Read-only facts. */
export type ModelSpanObservation = Readonly<{
  occurredAt: Date;
  endedAt: Date;
  provider?: string;
  modelId?: string | null;
  ending: ModelSpanEnding;
  /**
   * The serialized provider request prompt, BEFORE any projection: the raw fact the
   * observation bypass saw. Projection happens only inside this recorder, so this value
   * is never trusted, never stored, never logged as-is.
   */
  input?: string | null;
  /**
   * The accumulated output text, BEFORE any projection (see `input`): projected only
   * inside this recorder.
   */
  output?: string | null;
  /**
   * The FREV-01 proof for this call's bodies: an approval minted from the Bot's
   * configured security policy, resolved where the run's policy is known and carried
   * here on the same journey as `scope`. Absent — every wiring today — is no proof:
   * `input`/`output` are omitted and the span keeps its metrics. The token is
   * process-internal trust (span-support mints and verifies it); a wire value or a
   * hand-built lookalike projects nothing.
   */
  contentApproval?: SpanContentApproval | null;
  /** The trusted scope, when this path carries one; absent submits nothing upstream. */
  scope?: ObservationScope;
  /**
   * The run's W3C trace context captured when the model call began — the chain this
   * span joins instead of rooting its own (the T15 tool-step precedent, OCR round-1
   * h6). Absent, malformed, or outside the W3C shapes roots the span's own trace with
   * no parent, exactly as before: a context the caller cannot prove is never claimed.
   */
  trace?: Readonly<{ traceId: string; parentSpanId?: string }>;
}>;

export type ModelSpanRecorder = {
  /**
   * Records one observation: projects, builds the span and hands it to the write
   * queue. Synchronous and network-free by construction (the queue guarantees that);
   * a missing scope is a no-op, and a defect here surfaces to the caller's own
   * containment rather than being swallowed invisibly.
   */
  record(observation: ModelSpanObservation): void;
};

/** The span attribute keys the metadata allowlist here admits beyond T05's defaults. */
const SPAN_ATTRIBUTE_ALLOWLIST: readonly string[] = [
  ...DEFAULT_METADATA_ALLOWLIST,
  "usage_state",
  "span_state",
  "ending_kind",
  "ending_code",
  "origin",
  "content_policy_ref",
];

/**
 * The terminal state, in T10's vocabulary: the run-lifecycle states a model call can
 * honestly end in. `usage_missing` is `unknown` — an explicitly unlearned cost, never a
 * success and never a failure the settlement did not name.
 */
export function modelSpanTerminalState(
  ending: ModelSpanEnding,
): "completed" | "failed" | "canceled" | "unknown" {
  switch (ending.kind) {
    case "succeeded":
      return "completed";
    case "canceled":
      return "canceled";
    case "usage_missing":
      return "unknown";
    case "refused":
    case "settlement_failed":
    case "failed":
      return "failed";
    default: {
      // Compile-time exhaustive guard (T14 review minor c): a new ending kind fails
      // the build here instead of silently falling through as undefined.
      const exhausted: never = ending;
      return exhausted;
    }
  }
}

/** The usage verdict: actual only when the provider's finish reported it. */
function usageOf(
  ending: ModelSpanEnding,
):
  | { state: "actual"; inputTokens: number; outputTokens: number }
  | { state: "unavailable" } {
  return ending.kind === "succeeded"
    ? {
        state: "actual",
        inputTokens: ending.inputTokens,
        outputTokens: ending.outputTokens,
      }
    : { state: "unavailable" };
}

function buildModelSpan(observation: ModelSpanObservation): OpikOtlpSpan {
  const { ending } = observation;
  const usage = usageOf(ending);
  const spanState = modelSpanTerminalState(ending);

  // The run's chain (OCR h6): a provable W3C context joins the run's trace and
  // parents under the run span, so every model call of one run lands in one trace
  // instead of minting an orphan per call. The context is adopted whole — a
  // malformed trace id claims nothing, not even a well-formed parent. Same
  // discipline as the tool-step spanIdentity.
  const proven =
    observation.trace !== undefined &&
    W3C_TRACE_ID.test(observation.trace.traceId);
  const traceId = proven
    ? observation.trace.traceId
    : randomBytes(16).toString("hex");
  const parentSpanId =
    proven &&
    observation.trace?.parentSpanId !== undefined &&
    W3C_SPAN_ID.test(observation.trace.parentSpanId)
      ? observation.trace.parentSpanId
      : undefined;

  // FREV-01 / F5A1-R1-F1: bodies and audit attribute share ONE verdict — the
  // runtime-verified mint, never the carried token's truthiness — so a forged or
  // spread-copied approval withholds the bodies AND names no policy.
  const approval = issuedSpanContentApproval(observation.contentApproval);

  const attributes: SafeRecord = projectSafeRecord(
    {
      model: observation.modelId ?? undefined,
      provider: observation.provider,
      // Absent when unavailable — an explicit state, never a zero-filled number
      // (an explicit undefined key would project as null, which reads as a number).
      ...(usage.state === "actual"
        ? {
            tokens_input: usage.inputTokens,
            tokens_output: usage.outputTokens,
          }
        : {}),
      usage_state: usage.state,
      span_state: spanState,
      ending_kind: ending.kind,
      ending_code:
        "code" in ending && typeof ending.code === "string"
          ? ending.code
          : undefined,
      origin: "builtin",
      // FREV-01 audit chain: a span that carried bodies names the policy that
      // approved them; a proof-less span carries no bodies to name. The name comes
      // from the same verified mint the bodies pass through, never the raw carry.
      ...(approval ? { content_policy_ref: approval.policyRef } : {}),
    },
    SPAN_ATTRIBUTE_ALLOWLIST,
  );
  // FREV-01: bodies project only behind the observation's minted policy approval —
  // the recorder's say-so is not one. Deny patterns still run first and always win.
  const input = projectApprovedSpanContent(observation.input, approval);
  if (input) attributes.input = input;
  const output = projectApprovedSpanContent(observation.output, approval);
  if (output) attributes.output = output;

  const label =
    typeof observation.modelId === "string" && observation.modelId.trim() !== ""
      ? `model:${observation.modelId}`
      : "model";
  const name = projectSafeName(label);
  // Times degrade honestly (OCR m157): see baseSpan in tool-steps — a borrowed
  // sibling timestamp beats filing the span in 1970 under "0".
  const startNs =
    nanos(observation.occurredAt) ?? nanos(observation.endedAt) ?? nowNs();
  return {
    traceId,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    spanId: randomBytes(8).toString("hex"),
    // A withheld name would be refused by the port; a known-safe literal stands in.
    name:
      name.state === "omitted" ? { state: "projected", text: "model" } : name,
    startTimeUnixNano: startNs,
    endTimeUnixNano: nanos(observation.endedAt) ?? startNs,
    attributes,
  };
}

export function createModelSpanRecorder(
  deps: Readonly<{ healthService: Pick<OpikHealthService, "submit"> }>,
): ModelSpanRecorder {
  return {
    record(observation) {
      const scope = observation.scope;
      if (scope === undefined) return;
      const span = buildModelSpan(observation);
      const write: OpikObservationWrite = {
        scopeKey: scope.key,
        operation: "writeSpans",
        perform: (port) => port.writeSpans(scope, { spans: [span] }),
      };
      deps.healthService.submit(write);
    },
  };
}
