import type { SafeRecord, SafeValue } from "./ai-observability";

/**
 * The wire contract of the creator's runs API (Issue #17 list/detail, extended for Issue #18
 * and Issue #24's step timeline).
 *
 * This file is the ONE place the runs list contract is defined: the server's query service
 * answers these shapes, the browser renders these shapes, and a contract change is a change
 * here first. It lives beside the redaction shapes in `shared/ai-observability.ts` on purpose
 * — both are agreements between the two ends of the API rather than facts of either side.
 *
 * Issue #18 additions: `createdAt` (the upstream start time, or an explicit "unavailable"),
 * `capability` (the row's verified coverage verdict, joined from the binding table — an
 * upstream trace this scope never bound answers "unavailable", never a guess), and the
 * list-level `syncing` flag (bindings that began but never reconciled upstream exist, so the
 * store may still be catching up — a fact about the page, not a per-row state).
 */

/** The terminal-and-running state vocabulary shared by the wire and the binding table. */
export type RunState =
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted"
  | "unknown";

/** The verified coverage verdict (T10). Claimed only from instrumentation, never by default. */
export type RunCapabilityLevel = "detailed" | "basic" | "unavailable";

/** Provider usage as reported upstream, or the explicit absence of a report. */
export type RunUsageReport =
  | {
      source: "provider";
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }
  | { source: "unavailable" };

/** One upstream trace row, reduced to what may safely be shown. */
export type RunSummary = {
  opikTraceId: string;
  state: RunState;
  /** When the run started upstream, or an explicit "unavailable" — never a fabricated time. */
  createdAt: string | "unavailable";
  durationMs: number | "unavailable";
  usage: RunUsageReport;
  /** The verified coverage verdict for this trace; "unavailable" when no binding vouches. */
  capability: RunCapabilityLevel;
  metadata: SafeRecord;
};

export type RunsPagination = {
  /** Upstream's own count of the scope's traces — the truth, not the window. */
  total: number;
  /** How many rows the servable window actually holds. */
  window: number;
  offset: number;
  limit: number;
  nextCursor: string | null;
};

export type RunsListResult = {
  runs: readonly RunSummary[];
  pagination: RunsPagination;
  /** Whether bindings exist that never reconciled upstream — the honest "still syncing" signal. */
  syncing: boolean;
};

export type RunDetailResult = {
  run: {
    runId: string;
    attemptId: string;
    traceId: string;
    opikTraceId: string | null;
    capability: RunCapabilityLevel;
    state: RunState;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
  };
  upstream:
    | ({ status: "present" } & RunSummary)
    | { status: "unreconciled" }
    | { status: "absent" };
};

/*
 * The run's step timeline (Issue #24), one node per recorded span — T14's model spans and
 * T15's tool and retrieval steps. The wire follows the span families the recorders write:
 * each node carries the span's own locator and parent (display facts, never authorization),
 * T15's three-way execution determination for tool steps, and the retrieval seam's outcome
 * summary. Terminal states speak the same RunState vocabulary the whole chain already
 * renders; content survives only as T05 projections (SafeValue), exactly like metadata.
 */
export type RunStepKind = "model" | "tool" | "retrieval";

/** T15's determination, verbatim — the only words the step tree may use for it. */
export type RunStepExecutionState = "proposed" | "executed" | "unobserved";

/** The terminal vocabulary a step span may settle into (T15's toolStepTerminalState). */
export type RunStepState = "completed" | "failed" | "canceled" | "unknown";

/** One retrieval step's outcome summary, along T15's retrieval seam shape. */
export type RunStepRetrieval =
  | { outcome: "hit"; fragmentCount: number; kbIds: readonly string[] }
  | { outcome: "miss" }
  | { outcome: "degraded"; reason: string };

export type RunStep = {
  kind: RunStepKind;
  /** The step's own span id; with parentSpanId it fixes the tree's nesting. */
  spanId: string;
  /** The recorded parent, or null at the root. A dangling id nests at the root. */
  parentSpanId: string | null;
  /** The projected span name minus its kind prefix (a tool name, a model id). */
  name: string | null;
  state: RunStepState;
  /** The span's window, ISO strings; startedAt is the timeline's sort key. */
  startedAt: string;
  endedAt: string;
  /** Tool steps only: T15's determination over the three separately observed facts. */
  executionState?: RunStepExecutionState;
  /**
   * Tool steps only (R4-03): the call id the run's own protocol named the tool call
   * by — the correspondence that keeps a real business call locatable in the
   * governance record. Absent when the recorded span carried none.
   */
  toolCallId?: string;
  /** The projected call arguments, or the retrieval query. */
  input?: SafeValue | null;
  /** The projected result or error text. */
  output?: SafeValue | null;
  /** Retrieval steps only. */
  retrieval?: RunStepRetrieval;
};

export type RunStepsResult = {
  steps: readonly RunStep[];
};
