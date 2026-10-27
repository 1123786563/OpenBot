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
 * write queue, never a direct port call, and only after the T05 projection. Since the
 * f5a1 review's F2 the step bodies pass the SAME approval gate the model spans do
 * (FREV-01): free text projects only behind an approval minted from the Bot's
 * configured security policy — without one the step keeps its metrics and structural
 * fields and omits its prose — and even approved, the deny patterns run first and
 * always win. Since FREV-02 the write is also binding-gated: the run's local
 * authoritative binding (T07) is established before the span reaches the port, and a
 * binding that cannot be established fails the write closed — counted, never exported
 * unattributed. Scoping: a span is written upstream only when the observation carries
 * a scope this process issued (T06); a scope-less observation submits nothing rather
 * than inventing an owner.
 */
import { randomBytes } from "node:crypto";
import type { SafeValue } from "../../../shared/ai-observability";
import { type ObserverRunBindingGate, observerChainId } from "./bindings";
import type { ObservationScope } from "./contracts";
import type { OpikHealthService, OpikObservationWrite } from "./health";
import type { IdLinkStore } from "./id-links";
import { runUpstreamIdentity, spanUpstreamId } from "./opik-http";
import type { OpikOtlpSpan } from "./opik-port";
import {
  DEFAULT_METADATA_ALLOWLIST,
  denyReason,
  MAX_SAFE_RECORD_KEYS,
  MAX_SAFE_TEXT_BYTES,
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

/** The step kinds a built-in run is made of (the step-type enumeration, Issue #21 handoff). */
export type StepKind = "tool" | "retrieval";

/**
 * The run's W3C trace context a step observation carries (Issue #23/T17): the
 * cross-service chain a step span must join. `traceId`/`parentSpanId` are the W3C
 * coordinates the segment actually ran under; `opikTraceId` is the run's upstream
 * trace id under the explicit-id strategy, present only when the run's upstream
 * identity is honestly known (the run-association ticket threads it). A malformed
 * value is never adopted — the span falls back to its own honest identity rather
 * than claiming a context it cannot prove.
 */
export type StepTraceContext = Readonly<{
  /** W3C trace id, 32 lowercase hex. */
  traceId: string;
  /** W3C parent span id, 16 lowercase hex, when the ambient span is known. */
  parentSpanId?: string;
  /** The upstream Opik trace id (hyphenated UUIDv7), when known. */
  opikTraceId?: string;
  /** The run/attempt this step belonged to, when the association is known. */
  runRef?: Readonly<{ runId: string; attemptId: string }>;
}>;

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
  /**
   * The FREV-01 proof for this step's bodies (f5a1 review F2): an approval
   * minted from the Bot's configured security policy, carried where the run's
   * policy is known. Absent is no proof — input/output are omitted and the
   * span keeps its metrics and structural fields, exactly as for model spans.
   */
  contentApproval?: SpanContentApproval | null;
  /** The trusted scope, when this path carries one; absent submits nothing upstream. */
  scope?: ObservationScope;
  /**
   * The run's W3C trace context; absent (or unprovable) the span submits
   * nothing upstream — since FREV-02 the chain is the binding's identity, and
   * a chain-less step has no local authority to export under.
   */
  trace?: StepTraceContext;
  /**
   * R4-03: which path observed the step. `builtin` (the default) saw the run's
   * own event stream; `remote-agui` saw an endpoint's stream THROUGH this
   * server — a run whose tools executed elsewhere, whose observations therefore
   * never claim an execution, and whose binding is the run identity the fact
   * carried (not the chain-minted one). The span's `origin` attribute names it.
   */
  origin?: "builtin" | "remote-agui";
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
  /**
   * The FREV-01 proof for the query body (f5a1 review F2), on the same
   * footing as the tool-step bodies above: absent omits the query prose.
   */
  contentApproval?: SpanContentApproval | null;
  /** The trusted scope, when this path carries one; absent submits nothing upstream. */
  scope?: ObservationScope;
  /** The run's W3C trace context (the FREV-02 binding identity; see above). */
  trace?: StepTraceContext;
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
  "fragments_dropped",
  "fragments_original_bytes",
  "kb_ids",
  "origin",
  "content_policy_ref",
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

/**
 * The tool_call_id bound both faces answer to (OCR final #59): the read side
 * treats an id past this length as never provided, so the write side clamps to
 * the same line — one shared constant, never two ceilings that can drift apart.
 */
export const MAX_TOOL_CALL_ID_LENGTH = 256;

/** Hyphenated UUIDv7 — the explicit-id shape the verified contract adopts verbatim. */
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** One freshly minted UUIDv7, the id the backend adopts as this span's own. */
function mintUuidV7(): string {
  const timestamp = BigInt(Date.now());
  const bytes = randomBytes(16);
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The span's identity under the run's chain (Issue #23/T17): the W3C trace id and
 * parent the segment actually carries, plus the explicit upstream overrides when —
 * and only when — the run's upstream trace id is honestly known. A malformed value
 * is never adopted: the span falls back to its own honest identity (a fresh trace,
 * no parent, no overrides, and therefore nothing to link) rather than claiming a
 * context it cannot prove.
 */
function spanIdentity(
  trace: StepTraceContext | undefined,
): Pick<OpikOtlpSpan, "traceId" | "parentSpanId" | "opik"> {
  const traceId =
    trace !== undefined && W3C_TRACE_ID.test(trace.traceId)
      ? trace.traceId
      : randomBytes(16).toString("hex");
  const parentSpanId =
    trace?.parentSpanId !== undefined && W3C_SPAN_ID.test(trace.parentSpanId)
      ? trace.parentSpanId
      : undefined;
  const opikTraceId =
    trace?.opikTraceId !== undefined && UUID_V7.test(trace.opikTraceId)
      ? trace.opikTraceId
      : undefined;
  return opikTraceId === undefined
    ? { traceId, parentSpanId }
    : {
        traceId,
        parentSpanId,
        opik: { traceId: opikTraceId, spanId: mintUuidV7() },
      };
}

/** Fragments become one projected array of BARE locator records; a cap that drops says so. */
function projectFragments(fragments: readonly RetrievalFragment[]): {
  value: SafeValue;
  dropped: number;
} {
  const value = fragments.slice(0, MAX_FRAGMENTS).map((fragment) =>
    bareRecord(
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
    ),
  );
  if (fragments.length <= MAX_FRAGMENTS)
    return { value: { state: "projected", value }, dropped: 0 };
  const dropped = fragments.length - MAX_FRAGMENTS;
  return {
    value: {
      state: "truncated",
      value,
      originalBytes: -1,
      dropped,
    },
    dropped,
  };
}

/**
 * One projected record's SafeValue envelopes unwrapped to the bare values the
 * wire carries (OCR R2-32). The port's serializer unwraps only the OUTERMOST
 * envelope (attribute()/plainValue, opik-http.ts), so envelopes nested inside a
 * record's value reached the upstream row verbatim — the exact mechanism the
 * kb_ids list's T37 G3 fix removed one attribute earlier; this is the same
 * repair applied to the fragment records assembled into the outer array.
 * An omitted field drops out (nothing is invented); a truncated field keeps the
 * partial value its projection kept; null/undefined drop, as on the wire.
 */
function bareRecord(record: SafeRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(record)) {
    if (field.state === "omitted") continue;
    if (field.value === null || field.value === undefined) continue;
    out[key] = field.value;
  }
  return out;
}

function baseSpan(
  label: string,
  fallback: string,
  startedAt: Date,
  endedAt: Date,
  identity: ReturnType<typeof spanIdentity>,
): Pick<
  OpikOtlpSpan,
  | "traceId"
  | "spanId"
  | "parentSpanId"
  | "opik"
  | "name"
  | "startTimeUnixNano"
  | "endTimeUnixNano"
> {
  const name = projectSafeName(label);
  // Times degrade honestly (OCR m157): "0" would file the span in 1970, so an
  // unusable timestamp borrows its sibling's — zero duration beats a wrong epoch —
  // and only a span with no usable time at all lands at the write moment.
  const startNs = nanos(startedAt) ?? nanos(endedAt) ?? nowNs();
  const endNs = nanos(endedAt) ?? startNs;
  return {
    ...identity,
    spanId: randomBytes(8).toString("hex"),
    // A withheld name would be refused by the port; a known-safe literal stands in.
    name:
      name.state === "omitted" ? { state: "projected", text: fallback } : name,
    startTimeUnixNano: startNs,
    endTimeUnixNano: endNs,
  };
}

function buildToolStepSpan(observation: ToolStepObservation): OpikOtlpSpan {
  const executionState = toolStepExecutionState(observation);
  // f5a1 review F2 / FREV-01: bodies and audit attribute share ONE verdict —
  // the runtime-verified mint — the same discipline the model spans hold
  // since F5A1-R1-F1. The recorder's say-so stopped being a voucher when the
  // model half closed; without a minted approval the step is metrics-only.
  const approval = issuedSpanContentApproval(observation.contentApproval);
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
      /*
       * R4-03: the span names the path that observed it — `builtin` for the run's
       * own stream, `remote-agui` for an endpoint's stream this server mediated.
       * The call id ↔ step linkage this attribute set carries is the finding's
       * closure: a real business call never disappears from governance steps for
       * want of its identity, and a surface/endpoint execution reads unobserved,
       * never executed.
       */
      origin: observation.origin ?? "builtin",
      // The FREV-01 audit chain: a span that carried bodies names the policy
      // that approved them; a proof-less span carries no bodies to name.
      ...(approval ? { content_policy_ref: approval.policyRef } : {}),
    },
    SPAN_ATTRIBUTE_ALLOWLIST,
  );
  const input = projectApprovedSpanContent(observation.input, approval);
  if (input) attributes.input = input;
  const output = projectApprovedSpanContent(
    observation.output ?? observation.execution?.output ?? null,
    approval,
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
      spanIdentity(observation.trace),
    ),
    attributes,
  };
}

/**
 * kb_ids is the retrieval summary's id list, and the read side's contract (T18) is a
 * BARE string array — so the list projects element-wise as plain ids, never through
 * the deep projection. The T37 probe showed why: the deep projection wraps every
 * element in a SafeValue envelope, the port's serializer unwraps only the outermost
 * one, and the envelopes reached the upstream row — blinding the read side's hit
 * summary (it reads strings) for every real retrieval step. Ids are structured
 * allowlisted data, not free text, so the deny patterns still run per element; one
 * withheld element withholds the whole list (a partial list would read as complete),
 * which is the honest absence the projection already speaks. The ceiling is the same
 * defensive bound the deep projection slices at; beyond it the list is not a shape
 * this recorder produces, and it is omitted rather than silently shortened.
 */
function projectKbIds(
  value: readonly string[] | undefined,
): SafeValue | undefined {
  if (value === undefined) return undefined;
  if (value.length > MAX_SAFE_RECORD_KEYS) return undefined;
  const kept: string[] = [];
  for (const id of value) {
    // An id is a locator, not free text: the deny patterns run (a credential-shaped
    // id is refused outright), and a kept id lands verbatim — truncation would break
    // the identity the read side resolves, so an over-bound id withholds instead.
    if (typeof id !== "string") return undefined;
    if (denyReason(id) !== undefined) return undefined;
    if (new TextEncoder().encode(id).length > MAX_SAFE_TEXT_BYTES) {
      return undefined;
    }
    kept.push(id);
  }
  return { state: "projected", value: kept };
}

function buildRetrievalStepSpan(
  observation: RetrievalStepObservation,
): OpikOtlpSpan {
  // f5a1 review F2 / FREV-01: the query is a body like any other — gated by
  // the same verified mint, audit attribute included (see buildToolStepSpan).
  const approval = issuedSpanContentApproval(observation.contentApproval);
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
      span_state:
        observation.outcome.kind === "degraded" ? "failed" : "completed",
      origin: "builtin",
      ...(approval ? { content_policy_ref: approval.policyRef } : {}),
    },
    SPAN_ATTRIBUTE_ALLOWLIST,
  );
  const kbIds = projectKbIds(observation.kbIds);
  if (kbIds !== undefined) attributes.kb_ids = kbIds;
  const fragments =
    observation.outcome.kind === "hit"
      ? projectFragments(observation.outcome.fragments)
      : undefined;
  if (fragments) {
    attributes.fragments = fragments.value;
    // OCR R2-32: attribute() reads ONLY safe.value, so the truncated
    // envelope's own originalBytes/dropped fields never reached the wire —
    // a cap that dropped fragments said so to no one. They are promoted into
    // real span attributes instead of being silently dropped; the -1 is the
    // SafeValue vocabulary's own "cannot be measured".
    if (fragments.dropped > 0) {
      attributes.fragments_dropped = {
        state: "projected",
        value: fragments.dropped,
      };
      attributes.fragments_original_bytes = {
        state: "projected",
        value: -1,
      };
    }
  }
  const input = projectApprovedSpanContent(observation.query, approval);
  if (input) attributes.input = input;
  return {
    ...baseSpan(
      "retrieval",
      "retrieval",
      observation.occurredAt,
      observation.endedAt,
      spanIdentity(observation.trace),
    ),
    attributes,
  };
}

/**
 * The run chain an observation can prove (FREV-02): a W3C-valid trace id plus,
 * only when the association is honestly carried and usable, its runRef. Null —
 * nothing provable — submits nothing upstream.
 */
function observerChain(
  trace: StepTraceContext | undefined,
): {
  traceId: string;
  runRef?: Readonly<{ runId: string; attemptId: string }>;
} | null {
  const traceId = observerChainId(trace?.traceId);
  if (traceId === null) return null;
  const runRef = trace?.runRef;
  if (runRef === undefined) return { traceId };
  if (
    typeof runRef.runId !== "string" ||
    runRef.runId.trim() === "" ||
    typeof runRef.attemptId !== "string" ||
    runRef.attemptId.trim() === ""
  ) {
    // An association that names the run half-honestly is worse than none.
    return null;
  }
  return { traceId, runRef };
}

/**
 * The counted half of the FREV-02 chain gate for steps (OCR final #49), on the
 * model-span recorder's footing (OCR R2 C1): a scoped observation whose run
 * cannot prove a chain exports nothing — the fail-closed verdict is unchanged —
 * but the drop is a fact, never silence: counted here, bounded by construction
 * (one number per reason, no ids, no content). record and recordRetrieval share
 * the one counter, so operation cannot distinguish a dropped tool step from a
 * dropped retrieval by which one was silent. The count has the operator outlet
 * the id-link counters have (T-M #2): the health service projects it into
 * writeStats()/snapshot() as `chainGateDrops.steps`, so it reaches the health
 * route — not only the tests that pin the gate.
 */
const chainGateDrops = { missingChain: 0 };

/** Read the step chain-gate drop counts (a copy: readers cannot reset what was counted). */
export function toolStepChainGateDrops(): Readonly<{ missingChain: number }> {
  return { ...chainGateDrops };
}

export function createToolStepRecorder(
  deps: Readonly<{
    healthService: Pick<OpikHealthService, "submit" | "countIdLink">;
    /**
     * FREV-02: the local authoritative run binding, established (or replayed)
     * before any business span of the run is exported. Required on purpose —
     * see the model-span recorder's own seam note.
     */
    bindings: Pick<ObserverRunBindingGate, "ensure">;
    /**
     * The id-mapping store (Issue #23/T17). When present, a tool step whose
     * upstream span id is verifiable — the span's explicit override, or the
     * chain-derived id when it derives to the binding's upstream trace — is
     * linked AFTER the upstream write landed — the governed write path's
     * ordering: projection, span, then the mapping, so an id the backend never
     * adopted can never be claimed. Absent means no mapping happens and the
     * span write is unchanged.
     */
    idLinks?: Pick<IdLinkStore, "link">;
  }>,
): ToolStepRecorder {
  return {
    record(observation) {
      const scope = observation.scope;
      if (scope === undefined) return;
      // FREV-02: the run's provable chain is the binding's identity — a
      // chain-less step has no local authority to export under and submits
      // nothing, rather than rooting a fresh unattributable trace.
      const chain = observerChain(observation.trace);
      if (chain === null) {
        // Counted, never silent (OCR R2 C1 — the model-span gate's discipline,
        // OCR final #49): the refusal is the FREV-02 verdict; this count is its
        // visibility.
        chainGateDrops.missingChain += 1;
        return;
      }
      // One bound on both faces (#59): an id past MAX_TOOL_CALL_ID_LENGTH would
      // otherwise land in the store only for the read side to judge "never
      // provided" — the association lost silently. Clamped once here, so the
      // span's attribute and the id link below carry the SAME readable id.
      const bounded: ToolStepObservation =
        observation.toolCallId.length > MAX_TOOL_CALL_ID_LENGTH
          ? {
              ...observation,
              toolCallId: observation.toolCallId.slice(
                0,
                MAX_TOOL_CALL_ID_LENGTH,
              ),
            }
          : observation;
      const span = buildToolStepSpan(bounded);
      const idLinks = deps.idLinks;
      const write: OpikObservationWrite = {
        scopeKey: scope.key,
        operation: "writeSpans",
        perform: async (port) => {
          // The binding first (FREV-02): its failure fails this write visibly
          // and the span never reaches the port.
          const binding = await deps.bindings.ensure(scope, chain);
          const result = await port.writeSpans(scope, {
            spans: [span],
            binding,
          });
          if (result.outcome === "ok" && idLinks !== undefined) {
            // The mapping follows the write, never precedes it. The upstream id is
            // the three-state verdict (OCR delta T-J #7): the span's explicit
            // override when it carries one, else — and only when the chain derives
            // to the binding's recorded upstream trace, the same derivation the
            // port's completion adopts — the derived id, so a link never claims an
            // id the backend did not take. A chain that derives elsewhere names no
            // verifiable span: nothing to link.
            const upstreamSpanId =
              span.opik !== undefined
                ? span.opik.spanId
                : binding.opikTraceId !== null &&
                    runUpstreamIdentity(span.traceId).opikTraceId ===
                      binding.opikTraceId
                  ? spanUpstreamId(span.traceId, span.spanId)
                  : undefined;
            if (upstreamSpanId !== undefined) {
              // A refused verdict (chain_broken, divergent) is a detected fact,
              // and a link store that throws must not turn a span that already
              // landed into a counted failure — both are observations here,
              // swallowed by design, but never silently: each lands on one
              // governed counter (safe labels, no ids, no evidence) so a broken
              // chain is observable in operation.
              try {
                const verdict = await idLinks.link(scope, {
                  local: { kind: "tool_step", id: bounded.toolCallId },
                  upstream: { kind: "span", id: upstreamSpanId },
                  ...(observation.trace?.runRef !== undefined
                    ? { runRef: observation.trace.runRef }
                    : {}),
                  observedTraceId: span.traceId,
                });
                if (!verdict.linked) {
                  deps.healthService.countIdLink(verdict.reason);
                }
              } catch {
                // See above: the span write's own outcome is the queue's truth;
                // the mapping failure is counted, never propagated.
                deps.healthService.countIdLink("error");
              }
            }
          }
          return result;
        },
      };
      deps.healthService.submit(write);
    },
    recordRetrieval(observation) {
      const scope = observation.scope;
      if (scope === undefined) return;
      // No id link: a retrieval step has no local id of its own (queries are not
      // id'd), and a synthesized one would make the mapping ambiguous. Only tool
      // steps — which carry a toolCallId — link.
      const chain = observerChain(observation.trace);
      if (chain === null) {
        // FREV-02: see record above — same gate, same count (#49).
        chainGateDrops.missingChain += 1;
        return;
      }
      const span = buildRetrievalStepSpan(observation);
      const write: OpikObservationWrite = {
        scopeKey: scope.key,
        operation: "writeSpans",
        perform: async (port) => {
          const binding = await deps.bindings.ensure(scope, chain);
          return port.writeSpans(scope, { spans: [span], binding });
        },
      };
      deps.healthService.submit(write);
    },
  };
}
