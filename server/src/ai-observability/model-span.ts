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
 * projection — free text is asserted-by-the-recorder span content (`allowFreeText`),
 * and even then the deny patterns run first and always win, so a credential-shaped
 * canary dies at the projection, not in transit.
 *
 * Scoping: a span is written upstream only when the observation carries a scope this
 * process issued (T06). The built-in path's facts arrive without one today — the
 * run-association tickets own threading it — and a scope-less observation submits
 * nothing rather than inventing an owner.
 */
import { randomBytes } from "node:crypto";
import type { SafeText, SafeValue } from "../../../shared/ai-observability";
import type { ObservationScope } from "./contracts";
import type { OpikHealthService, OpikObservationWrite } from "./health";
import type { OpikOtlpSpan } from "./opik-port";
import {
  DEFAULT_METADATA_ALLOWLIST,
  projectSafeName,
  projectSafeRecord,
  projectSafeText,
  type SafeRecord,
} from "./redaction";

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
  /** The trusted scope, when this path carries one; absent submits nothing upstream. */
  scope?: ObservationScope;
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

/** SafeText → SafeValue: same tri-state, `text` leaves renamed to `value`. */
function asValue(text: SafeText): SafeValue {
  if (text.state === "projected")
    return { state: "projected", value: text.text };
  if (text.state === "truncated") {
    return {
      state: "truncated",
      value: text.text,
      originalBytes: text.originalBytes,
    };
  }
  return text;
}

function nanos(date: Date): string | undefined {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return undefined;
  return (BigInt(date.getTime()) * 1_000_000n).toString();
}

/** Span content: the recorder's own assertion that this IS the span's product — the
 * deny patterns still run first and always win. */
function projectSpanContent(text: string | null | undefined): SafeValue | null {
  if (text === null || text === undefined) return null;
  return asValue(projectSafeText(text, { allowFreeText: true }));
}

function buildModelSpan(observation: ModelSpanObservation): OpikOtlpSpan {
  const { ending } = observation;
  const usage = usageOf(ending);
  const spanState = modelSpanTerminalState(ending);

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
    },
    SPAN_ATTRIBUTE_ALLOWLIST,
  );
  const input = projectSpanContent(observation.input);
  if (input) attributes.input = input;
  const output = projectSpanContent(observation.output);
  if (output) attributes.output = output;

  const label =
    typeof observation.modelId === "string" && observation.modelId.trim() !== ""
      ? `model:${observation.modelId}`
      : "model";
  const name = projectSafeName(label);
  return {
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    // A withheld name would be refused by the port; a known-safe literal stands in.
    name:
      name.state === "omitted" ? { state: "projected", text: "model" } : name,
    startTimeUnixNano: nanos(observation.occurredAt) ?? "0",
    endTimeUnixNano: nanos(observation.endedAt) ?? "0",
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
