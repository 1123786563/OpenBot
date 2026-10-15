/**
 * Tool- and retrieval-step recording for the built-in execution path (Issue #21 / DAG T15).
 *
 * This is the observation BYPASS for the steps a run is made of, on the same footing as
 * T14's model spans: it never executes a tool, never calls a provider and never sits
 * between a run and its events — it reads what the path already observed and turns each
 * step into exactly one span.
 *
 * Honesty rules, inherited rather than reinvented: a tool PROPOSAL, a REAL execute and a
 * RECEIPT are three separately observed facts, recorded as three separate span attributes
 * and collapsed into no single status. The only evidence that may mark a step `executed`
 * is an execute callback this deployment actually ran (A3: a proposal does not impersonate
 * an execution); everything else — a call the run left unanswered, a browser-side receipt
 * for an execution this process never observed — stays `proposed` or `unobserved`, both of
 * which are terminal `unknown`, never success. A run interrupted while a call hangs is the
 * one window that may honestly leave a step `proposed`: the answer may still arrive.
 *
 * Step typing reads event/callback SEMANTICS only: the observation types here are plain
 * structural facts a producer translates from public events and callbacks. This module
 * imports no framework — nothing from @ag-ui or @copilotkit, public or private — so the
 * classification cannot lean on a framework's internal shapes (acceptance 4).
 *
 * Egress is structural, as in T14: the projected span enters ONLY through the T09 bounded
 * write queue, never a direct port call, and only after the T05 projection — free text is
 * asserted-by-the-recorder span content (`allowFreeText`), and even then the deny patterns
 * run first and always win. Scoping: a span is written upstream only when the observation
 * carries a scope this process issued (T06); a scope-less observation submits nothing
 * rather than inventing an owner.
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

/** The step kinds a built-in run is made of (the step-type enumeration, Issue #21 handoff). */
export type StepKind = "tool" | "retrieval";

/**
 * The three-way execution determination over the three separately observed facts:
 * `executed` (a real execute ran here), `proposed` (an interrupted window left the call
 * open for an answer that may still arrive) and `unobserved` (the window closed without
 * learning the execution — a missing receipt, an unknown browser execution).
 */
export type ToolStepExecutionState = "proposed" | "executed" | "unobserved";

/** How an execution this deployment ran settled. */
export type ToolStepExecutionKind = "succeeded" | "failed" | "canceled";

/** How the observation window closed. Only an interrupted window may leave a step proposed. */
export type ToolStepWindow = "interrupted" | "terminal";

/** What one tool step's observation bypass saw. Read-only facts, BEFORE any projection. */
export type ToolStepObservation = Readonly<{
  toolCallId: string;
  toolName?: string;
  /** When the proposal was observed; absent when only the execution was. */
  proposedAt?: Date;
  endedAt: Date;
  /** The model emitted this call in the event stream. */
  proposalObserved: boolean;
  /** An execute callback in this process actually ran and settled. */
  executionObserved: boolean;
  /** A result receipt was observed (the settlement, or a TOOL_CALL_RESULT). */
  receiptObserved: boolean;
  /** What the real execute settled to; present only when executionObserved. */
  execution?: { kind: ToolStepExecutionKind; output?: string | null } | null;
  window: ToolStepWindow;
  /** The raw serialized call arguments — projected at the recorder, never trusted raw. */
  input?: string | null;
  /** The raw execution output (or error text) — projected at the recorder. */
  output?: string | null;
  /** The trusted scope, when this path carries one; absent submits nothing upstream. */
  scope?: ObservationScope;
}>;

/**
 * The determination itself. A receipt for an execution this deployment never ran — the
 * browser answered, we only saw the result — is deliberately NOT `executed`: the receipt
 * is recorded as its own fact, and the step stays unobserved-by-us, never success.
 */
export function toolStepExecutionState(
  observation: Pick<
    ToolStepObservation,
    "executionObserved" | "receiptObserved" | "window"
  >,
): ToolStepExecutionState {
  if (observation.executionObserved) return "executed";
  if (observation.window === "interrupted" && !observation.receiptObserved)
    return "proposed";
  return "unobserved";
}

/**
 * The terminal state in T10's vocabulary. Only an observed, successful execution may be
 * `completed`; everything unlearned is `unknown` — an explicit non-success, never a
 * failure the observation did not name.
 */
export function toolStepTerminalState(
  observation: ToolStepObservation,
): "completed" | "failed" | "canceled" | "unknown" {
  const state = toolStepExecutionState(observation);
  switch (state) {
    case "executed":
      switch (observation.execution?.kind) {
        case "succeeded":
          return "completed";
        case "failed":
          return "failed";
        case "canceled":
          return "canceled";
        default:
          // Execution observed but its outcome missing: unknown, not success.
          return "unknown";
      }
    case "proposed":
    case "unobserved":
      return "unknown";
    default: {
      // Compile-time exhaustive guard (T14 review minor c): a new state kind fails the
      // build here instead of silently falling through.
      const exhausted: never = state;
      return exhausted;
    }
  }
}

/** One retrieval fragment's locators: which kb, which chunk, which document, where from. */
export type RetrievalFragment = Readonly<{
  kbId?: string;
  chunkId?: string;
  docId?: string;
  source?: string;
  score?: number;
}>;

/** What one retrieval step's observation bypass saw. Read-only facts, BEFORE any projection. */
export type RetrievalStepObservation = Readonly<{
  occurredAt: Date;
  endedAt: Date;
  /** The sanitized query actually sent upstream — projected at the recorder. */
  query: string;
  kbIds?: readonly string[];
  outcome:
    | { kind: "hit"; fragments: readonly RetrievalFragment[] }
    | { kind: "miss" }
    | { kind: "degraded"; reason: string };
  /** The trusted scope, when this path carries one; absent submits nothing upstream. */
  scope?: ObservationScope;
}>;

export type ToolStepRecorder = {
  /**
   * Records one tool-step observation: projects, builds the span, hands it to the write
   * queue. Synchronous and network-free by construction; a missing scope is a no-op.
   */
  record(observation: ToolStepObservation): void;
  /** Same contract for one retrieval step. */
  recordRetrieval(observation: RetrievalStepObservation): void;
};

/** The span attribute keys the metadata allowlist here admits beyond T05's defaults. */
const SPAN_ATTRIBUTE_ALLOWLIST: readonly string[] = [
  ...DEFAULT_METADATA_ALLOWLIST,
  "step_kind",
  "tool_call_id",
  "execution_state",
  "execution_outcome",
  "span_state",
  "proposal_observed",
  "execution_observed",
  "receipt_observed",
  "window",
  "retrieval_outcome",
  "degraded_reason",
  "fragment_count",
  "fragments",
  "kb_ids",
  "origin",
];

/** The fragment locator keys that survive projection, in the span's own naming. */
const FRAGMENT_KEYS: readonly string[] = [
  "kb_id",
  "chunk_id",
  "doc_id",
  "source",
  "score",
];

/** Retriever options cap top_k at 10; the cap here is a defensive ceiling, not policy. */
const MAX_FRAGMENTS = 64;

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

/** Span content: the recorder's own assertion that this IS the span's product — the deny
 * patterns still run first and always win. */
function projectSpanContent(text: string | null | undefined): SafeValue | null {
  if (text === null || text === undefined) return null;
  return asValue(projectSafeText(text, { allowFreeText: true }));
}

/** Fragments become one projected array of locator records; a cap that drops says so. */
function projectFragments(
  fragments: readonly RetrievalFragment[],
): SafeValue | undefined {
  const value = fragments.slice(0, MAX_FRAGMENTS).map((fragment) =>
    projectSafeRecord(
      {
        kb_id: fragment.kbId,
        chunk_id: fragment.chunkId,
        doc_id: fragment.docId,
        source: fragment.source,
        ...(typeof fragment.score === "number"
          ? { score: fragment.score }
          : {}),
      },
      FRAGMENT_KEYS,
    ),
  );
  if (fragments.length <= MAX_FRAGMENTS) return { state: "projected", value };
  return {
    state: "truncated",
    value,
    originalBytes: -1,
    dropped: fragments.length - MAX_FRAGMENTS,
  };
}

function baseSpan(
  label: string,
  fallback: string,
  startedAt: Date,
  endedAt: Date,
): Pick<
  OpikOtlpSpan,
  "traceId" | "spanId" | "name" | "startTimeUnixNano" | "endTimeUnixNano"
> {
  const name = projectSafeName(label);
  return {
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    // A withheld name would be refused by the port; a known-safe literal stands in.
    name:
      name.state === "omitted" ? { state: "projected", text: fallback } : name,
    startTimeUnixNano: nanos(startedAt) ?? "0",
    endTimeUnixNano: nanos(endedAt) ?? "0",
  };
}

function buildToolStepSpan(observation: ToolStepObservation): OpikOtlpSpan {
  const executionState = toolStepExecutionState(observation);
  const attributes: SafeRecord = projectSafeRecord(
    {
      step_kind: "tool",
      tool_call_id: observation.toolCallId,
      execution_state: executionState,
      execution_outcome: observation.execution?.kind,
      proposal_observed: observation.proposalObserved,
      execution_observed: observation.executionObserved,
      receipt_observed: observation.receiptObserved,
      window: observation.window,
      span_state: toolStepTerminalState(observation),
      origin: "builtin",
    },
    SPAN_ATTRIBUTE_ALLOWLIST,
  );
  const input = projectSpanContent(observation.input);
  if (input) attributes.input = input;
  const output = projectSpanContent(
    observation.output ?? observation.execution?.output ?? null,
  );
  if (output) attributes.output = output;
  return {
    ...baseSpan(
      observation.toolName && observation.toolName.trim() !== ""
        ? `tool:${observation.toolName}`
        : "tool",
      "tool",
      observation.proposedAt ?? observation.endedAt,
      observation.endedAt,
    ),
    attributes,
  };
}

function buildRetrievalStepSpan(
  observation: RetrievalStepObservation,
): OpikOtlpSpan {
  const attributes: SafeRecord = projectSafeRecord(
    {
      step_kind: "retrieval",
      retrieval_outcome: observation.outcome.kind,
      degraded_reason:
        observation.outcome.kind === "degraded"
          ? observation.outcome.reason
          : undefined,
      // Absent unless a hit — an explicit state, never a zero-filled count.
      ...(observation.outcome.kind === "hit"
        ? { fragment_count: observation.outcome.fragments.length }
        : {}),
      kb_ids: observation.kbIds,
      span_state:
        observation.outcome.kind === "degraded" ? "failed" : "completed",
      origin: "builtin",
    },
    SPAN_ATTRIBUTE_ALLOWLIST,
  );
  const fragments =
    observation.outcome.kind === "hit"
      ? projectFragments(observation.outcome.fragments)
      : undefined;
  if (fragments) attributes.fragments = fragments;
  const input = projectSpanContent(observation.query);
  if (input) attributes.input = input;
  return {
    ...baseSpan(
      "retrieval",
      "retrieval",
      observation.occurredAt,
      observation.endedAt,
    ),
    attributes,
  };
}

export function createToolStepRecorder(
  deps: Readonly<{ healthService: Pick<OpikHealthService, "submit"> }>,
): ToolStepRecorder {
  return {
    record(observation) {
      const scope = observation.scope;
      if (scope === undefined) return;
      const span = buildToolStepSpan(observation);
      const write: OpikObservationWrite = {
        scopeKey: scope.key,
        operation: "writeSpans",
        perform: (port) => port.writeSpans(scope, { spans: [span] }),
      };
      deps.healthService.submit(write);
    },
    recordRetrieval(observation) {
      const scope = observation.scope;
      if (scope === undefined) return;
      const span = buildRetrievalStepSpan(observation);
      const write: OpikObservationWrite = {
        scopeKey: scope.key,
        operation: "writeSpans",
        perform: (port) => port.writeSpans(scope, { spans: [span] }),
      };
      deps.healthService.submit(write);
    },
  };
}
