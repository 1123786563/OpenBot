/**
 * Run/attempt terminal semantics and the capability verdict (Issue #16 / DAG T10).
 *
 * A run ends only on an actual outcome: completion, failure, a confirmed cancellation,
 * or an ending that is explicitly interrupted/unknown. Receiving an HTTP first frame —
 * or a client that stops watching — is an OBSERVATION, never an outcome; the run may
 * still be executing in the background, so nothing here may upgrade those into
 * "canceled" or "completed".
 *
 * Each attempt terminates at most once. The first terminal event wins and every later
 * event for that attempt — duplicate, divergent or plain straggler — is rejected with
 * the standing outcome, so aggregation can never count an attempt twice. A retry is
 * the same rule seen from the run side: it closes the current attempt as a superseded
 * one and names the next attempt id; the next attempt is a separate lifecycle with a
 * separate identity.
 *
 * Only events actually observed are recorded. A tool proposal (the model suggested a
 * call) is never an execution; a proposal without an observed receipt stays
 * `unobserved`, never "succeeded". Internal runtime steps the observer cannot see are
 * reported as unobserved, not as absent.
 */

export type RunCapability = "detailed" | "basic" | "unavailable";

/** What the observer actually saw. Nothing here was inferred or synthesized. */
export type RunObservationEvent =
  | { type: "http_first_frame" }
  | { type: "run_started" }
  | { type: "tool_proposed"; toolCallId: string }
  | { type: "tool_executed"; toolCallId: string }
  | { type: "disconnected" }
  | { type: "success" }
  | { type: "error" }
  | { type: "canceled" }
  | { type: "retry"; nextAttemptId: string }
  | { type: "interrupted" }
  | { type: "unknown" };

export type AttemptTerminalState =
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted"
  | "unknown";

export type AttemptRunState = "running" | AttemptTerminalState;

/** The observed ending, preserved distinctly: the state is what to store, the outcome is what happened. */
export type AttemptTerminalOutcome =
  | { outcome: "success"; state: "completed" }
  | { outcome: "error"; state: "failed" }
  | { outcome: "canceled"; state: "canceled" }
  /** The attempt was superseded by another try; the run continues on `nextAttemptId`. */
  | { outcome: "retry"; state: "interrupted"; nextAttemptId: string }
  | { outcome: "interrupted"; state: "interrupted" }
  | { outcome: "unknown"; state: "unknown" };

/**
 * The trusted association every observed execution carries. Built-in and OpenBot-mediated
 * remote AG-UI executions use the same shape: the scope/bot identity comes from a scope
 * this process issued (T06), never from the caller; the caller contributes only the
 * thread/run/attempt references.
 */
export type RunAssociation = Readonly<{
  scopeKey: string;
  botId: string;
  threadId: string;
  runId: string;
  attemptId: string;
  origin: "builtin" | "remote-agui";
}>;

export type AttemptEventDisposition =
  | { accepted: true; terminal: false }
  | { accepted: true; terminal: true; outcome: AttemptTerminalOutcome }
  /** The attempt already ended; the standing outcome is returned, unchanged. */
  | {
      accepted: false;
      reason: "already_terminal";
      outcome: AttemptTerminalOutcome;
    };

/** Proposals are what the model suggested; executions are receipts actually observed. */
export type RunToolObservation = Readonly<{
  proposed: readonly string[];
  executed: readonly string[];
  /** Proposals with no observed receipt — unobserved, never succeeded. */
  unobserved: readonly string[];
}>;

export type RunAttemptRecord = Readonly<{
  association: RunAssociation;
  state: AttemptRunState;
  outcome: AttemptTerminalOutcome | null;
  observed: Readonly<{
    firstFrame: boolean;
    started: boolean;
    disconnected: boolean;
  }>;
  tools: RunToolObservation;
}>;

export type RunLifecycleErrorCode = "LIFECYCLE_INPUT_INVALID";

export class RunLifecycleError extends Error {
  constructor(
    public code: RunLifecycleErrorCode,
    public status: 400,
  ) {
    super(code);
  }
}

/**
 * The capability verdict. A capability is claimed only from verified instrumentation:
 * `detailed` needs runtime-internal steps that are verified observable on this path;
 * `basic` is the honest ceiling when only OpenBot-observed run/AG-UI events exist;
 * `unavailable` when nothing was observed and nothing is verified. Never the reverse —
 * an unobserved internal call is not evidence it did not happen.
 */
export type RunCapabilityEvidence = Readonly<{
  /** Runtime-internal model/tool/retrieval steps are verified observable on this path. */
  internalStepsVerified: boolean;
  /** OpenBot actually observed run or AG-UI events on this path. */
  observedEvents: boolean;
}>;

export function resolveRunCapability(
  evidence: RunCapabilityEvidence,
): RunCapability {
  if (evidence.internalStepsVerified) return "detailed";
  if (evidence.observedEvents) return "basic";
  return "unavailable";
}

/** A non-empty opaque reference. Stored as-is; only emptiness is refused. */
function reference(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunLifecycleError("LIFECYCLE_INPUT_INVALID", 400);
  }
  return value;
}

const ORIGINS = ["builtin", "remote-agui"] as const;

/** Parses one observation from an untrusted value. Unknown shapes fail closed. */
export function parseRunObservationEvent(value: unknown): RunObservationEvent {
  if (typeof value !== "object" || value === null) {
    throw new RunLifecycleError("LIFECYCLE_INPUT_INVALID", 400);
  }
  const event = value as {
    type?: unknown;
    toolCallId?: unknown;
    nextAttemptId?: unknown;
  };
  if (typeof event.type !== "string") {
    throw new RunLifecycleError("LIFECYCLE_INPUT_INVALID", 400);
  }
  if (event.type === "tool_proposed" || event.type === "tool_executed") {
    if (typeof event.toolCallId !== "string") {
      throw new RunLifecycleError("LIFECYCLE_INPUT_INVALID", 400);
    }
    reference(event.toolCallId);
    return { type: event.type, toolCallId: event.toolCallId };
  }
  if (event.type === "retry") {
    if (typeof event.nextAttemptId !== "string") {
      throw new RunLifecycleError("LIFECYCLE_INPUT_INVALID", 400);
    }
    reference(event.nextAttemptId);
    return { type: "retry", nextAttemptId: event.nextAttemptId };
  }
  switch (event.type) {
    case "http_first_frame":
    case "run_started":
    case "disconnected":
    case "success":
    case "error":
    case "canceled":
    case "interrupted":
    case "unknown":
      return { type: event.type };
    default:
      throw new RunLifecycleError("LIFECYCLE_INPUT_INVALID", 400);
  }
}

export type RunAttemptLifecycle = {
  /** Applies one observed event. Never invents an outcome an event did not carry. */
  observe(event: RunObservationEvent): AttemptEventDisposition;
  /** The classification so far — only what was actually observed. */
  record(): RunAttemptRecord;
};

/**
 * Begins one attempt. Retry handling is the caller's composition: when `observe` answers
 * a `retry` outcome, the caller begins the next attempt separately with the next id —
 * the two lifecycles never share terminal state.
 */
export function beginRunAttempt(
  association: RunAssociation,
): RunAttemptLifecycle {
  reference(association.scopeKey);
  reference(association.botId);
  reference(association.threadId);
  reference(association.runId);
  reference(association.attemptId);
  if (!ORIGINS.includes(association.origin)) {
    throw new RunLifecycleError("LIFECYCLE_INPUT_INVALID", 400);
  }

  let state: AttemptRunState = "running";
  let outcome: AttemptTerminalOutcome | null = null;
  const observed = { firstFrame: false, started: false, disconnected: false };
  const proposed = new Set<string>();
  const executed = new Set<string>();

  const terminal = (next: AttemptTerminalOutcome): AttemptEventDisposition => {
    state = next.state;
    outcome = next;
    return { accepted: true, terminal: true, outcome: next };
  };

  return {
    observe(event) {
      if (event.type === "tool_proposed" || event.type === "tool_executed") {
        reference(event.toolCallId);
      }
      if (event.type === "retry") {
        reference(event.nextAttemptId);
      }
      // First terminal outcome wins: every later event — duplicate, divergent or
      // straggler — is refused with the standing outcome.
      if (state !== "running") {
        return {
          accepted: false,
          reason: "already_terminal",
          outcome: outcome as AttemptTerminalOutcome,
        };
      }
      switch (event.type) {
        case "http_first_frame":
          observed.firstFrame = true;
          return { accepted: true, terminal: false };
        case "run_started":
          observed.started = true;
          return { accepted: true, terminal: false };
        case "tool_proposed":
          proposed.add(event.toolCallId);
          return { accepted: true, terminal: false };
        case "tool_executed":
          executed.add(event.toolCallId);
          return { accepted: true, terminal: false };
        case "disconnected":
          // The client stopped watching; the run may still be executing. Never "canceled".
          observed.disconnected = true;
          return { accepted: true, terminal: false };
        case "success":
          return terminal({ outcome: "success", state: "completed" });
        case "error":
          return terminal({ outcome: "error", state: "failed" });
        case "canceled":
          // Only a confirmed cancellation; a disconnect must not map here.
          return terminal({ outcome: "canceled", state: "canceled" });
        case "retry":
          return terminal({
            outcome: "retry",
            state: "interrupted",
            nextAttemptId: event.nextAttemptId,
          });
        case "interrupted":
          return terminal({ outcome: "interrupted", state: "interrupted" });
        case "unknown":
          return terminal({ outcome: "unknown", state: "unknown" });
      }
    },
    record() {
      const unobserved = [...proposed].filter((id) => !executed.has(id));
      return {
        association,
        state,
        outcome,
        observed: { ...observed },
        tools: {
          proposed: [...proposed],
          executed: [...executed],
          unobserved,
        },
      };
    },
  };
}
