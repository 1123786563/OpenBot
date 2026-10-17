/**
 * The one seam every server-side Opik call goes through (Issue #14 / DAG T08).
 *
 * Consumers see operations and typed outcomes; URL construction, wire serialization, response
 * parsing and deadlines live in the HTTP adapter (opik-http.ts). Only a verified T04 contract
 * may authorize an operation here — the adapter refuses anything the manifest does not cover,
 * before any network I/O, rather than guessing an endpoint or a field name.
 *
 * Trust: a scope is only what T06's issuing process produced (`assertObservationScope` inside
 * the adapter fails closed on anything else) and a run binding is only T07's authoritative
 * row. An upstream id, project/workspace name, metadata echo or caller-supplied locator is a
 * value, never an authorization grant — when one disagrees with the trusted scope or binding,
 * the result is ownership drift, and drift suspends further writes for that scope instead of
 * retrying elsewhere.
 */

import type { SafeText } from "../../../shared/ai-observability";
import type { ObservationScope, ObservationStorageLocator } from "./contracts";
import type { SafeRecord } from "./redaction";

/** The operations the verified contract currently covers. Adding one requires new evidence. */
export type OpikOperation =
  | "healthCheck"
  | "retrieveProject"
  | "createTrace"
  | "writeSpans"
  | "listTraces"
  | "listSpans"
  | "deleteTraces"
  | "deleteDataset";

/**
 * The structural subset of T04's VerifiedOpikContract manifest the adapter depends on. The
 * manifest is only evidence when every check passed; the adapter re-verifies exactly that and
 * never treats a fixture or a partial run as authorization.
 */
export type VerifiedOpikContract = Readonly<{
  manifestVersion: number;
  capabilities: ReadonlyArray<Readonly<{ name: string; ok: boolean }>>;
  bodyLimit: Readonly<{
    maxAcceptedBytes: number | null;
    minRejectedBytes: number | null;
    cappedAtBytes: number | null;
  }>;
  checks: Readonly<{ total: number; passed: number }>;
}>;

/** What a drift result says went wrong. Enumerated on purpose: never a raw upstream value. */
export type OpikDriftReason =
  | "response_name_mismatch"
  | "response_project_mismatch"
  | "binding_mismatch"
  | "writes_suspended";

/**
 * Every operation answers with this union or it does not answer at all: pre-I/O refusals
 * throw OpikPortError, transport settles within the deadline into one of these outcomes.
 * Unavailable/timeout and upstream failure are distinct facts; malformed covers invalid JSON
 * and partial envelopes; ownership drift additionally suspends writes for the scope.
 */
export type OpikPortResult<T> =
  | { outcome: "ok"; value: T }
  | {
      outcome: "unavailable";
      operation: OpikOperation;
      code: "OPIK_TIMEOUT" | "OPIK_UNREACHABLE";
    }
  | {
      outcome: "upstream_error";
      operation: OpikOperation;
      code: "OPIK_UPSTREAM_ERROR" | "OPIK_CLIENT_ERROR";
      status: number;
    }
  | {
      outcome: "malformed";
      operation: OpikOperation;
      code: "OPIK_MALFORMED_RESPONSE";
      /** Stable, body-free reason such as `invalid_json` or `field:content`. */
      detail: string;
    }
  | {
      outcome: "ownership_drift";
      operation: OpikOperation;
      code: "OPIK_OWNERSHIP_DRIFT";
      reason: OpikDriftReason;
      /** The caller supplied this scope, so echoing its key back leaks nothing new. */
      scopeKey: string;
    };

/**
 * The run-binding facts the port cross-checks. Copied from T07's row by the caller — the
 * port never reads the binding table and a binding that disagrees with the presented scope
 * is ownership drift, not a fallback to writing under the binding's locator.
 */
export type OpikRunBindingRef = Readonly<{
  scopeKey: string;
  runId: string;
  attemptId: string;
  locatorWorkspace: string;
  locatorProject: string;
  opikTraceId: string | null;
}>;

/**
 * One span for the OTLP write path. Free text and metadata arrive as T05 projection outputs
 * only — `name` is a SafeText (a withheld name is refused, because the contract's read-back
 * locates a span by its name) and `attributes` is a SafeRecord. Ids follow the verified
 * shapes: OTel trace/span ids are hex (32/16), nanosecond timestamps are digit strings, and
 * the `opik` overrides must be hyphenated UUIDv7 values the backend adopts verbatim.
 */
export type OpikOtlpSpan = Readonly<{
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: SafeText;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes?: SafeRecord;
  opik?: Readonly<{
    traceId: string;
    spanId: string;
    parentSpanId?: string;
  }>;
}>;

/**
 * One trace row. Only `id` is typed and validated (it is what the verified read-back reads);
 * any other field the upstream happens to send passes through as data, untrusted — consumers
 * must not authorize anything off it.
 */
export type OpikTraceRow = Readonly<{ id: string } & Record<string, unknown>>;

export type OpikTracePage = Readonly<{
  page: number;
  size: number;
  total: number;
  content: readonly OpikTraceRow[];
}>;

/**
 * One span row, exactly as the verified read-back observed it (Issue #24 / T18-server):
 * OTLP-written spans answer with their attributes merged into the row's `input` object and
 * the `input`/`output` attributes under their own keys. Only `id` is typed and validated;
 * every other field — `name`, `parent_span_id`, the attribute carrier — passes through as
 * data, untrusted, for the step projection to read defensively.
 */
export type OpikSpanRow = Readonly<{ id: string } & Record<string, unknown>>;

export type OpikSpanPage = Readonly<{
  page: number;
  size: number;
  total: number;
  content: readonly OpikSpanRow[];
}>;

export type OpikPort = {
  /** Deployment-level liveness on the verified path. No scope: it authorizes nothing. */
  healthCheck(): Promise<OpikPortResult<{ healthy: true }>>;
  /**
   * Resolve this scope's locator project name to the upstream project id, or `null` on the
   * verified 404. A response naming a different project than the one asked for is drift.
   */
  retrieveProject(
    scope: ObservationScope,
  ): Promise<OpikPortResult<{ id: string } | null>>;
  /**
   * Create a trace under this scope's locator project with a caller-chosen UUIDv7 id — the
   * explicit-path half of the verified cross-service identity strategy (REST trace first,
   * OTLP spans with `opik.*` overrides attached after). The echoed id is our own, not an
   * upstream grant.
   */
  createTrace(
    scope: ObservationScope,
    input: {
      traceId: string;
      threadId?: string;
      startTime: Date;
      /**
       * Required (OCR m154): the binding is what ties this creation to the run's
       * verified identity; a creation without one is an unattributable write, and
       * the guard refuses it before any I/O.
       */
      binding: OpikRunBindingRef;
    },
  ): Promise<OpikPortResult<{ traceId: string }>>;
  /**
   * Write spans over OTLP HTTP/JSON, routed to this scope's locator project by the
   * `projectName` header per the verified contract. Both id paths are supported: derived
   * (backend derives Opik ids; read them back afterwards) and explicit (`opik.*` overrides).
   */
  writeSpans(
    scope: ObservationScope,
    input: {
      spans: readonly OpikOtlpSpan[];
      binding?: OpikRunBindingRef;
    },
  ): Promise<OpikPortResult<{ accepted: true }>>;
  /**
   * List traces in one upstream project. The verified answer is a `page/size/total/content`
   * envelope whose rows carry `id`; a page that never arrives whole is malformed, never an
   * empty success, and a row attesting a different project than the one queried is drift.
   * `page` is the envelope's own position field, defaulted upstream when omitted — the T34
   * export walks it to cover a whole project inside its row cap.
   */
  listTraces(
    scope: ObservationScope,
    input: { projectId: string; size?: number; page?: number },
  ): Promise<OpikPortResult<OpikTracePage>>;
  /**
   * List a trace's spans in one upstream project — the step-tree read-back (Issue #24 /
   * T18-server), gated on the parent-child query-link capability whose T04 evidence is the
   * span query/detail round-trip. The verified answer is the same `page/size/total/content`
   * envelope with rows carrying `id`; a row attesting a different project than the one
   * queried is drift, exactly like listTraces.
   */
  listSpans(
    scope: ObservationScope,
    input: { projectId: string; traceId: string; size?: number; page?: number },
  ): Promise<OpikPortResult<OpikSpanPage>>;
  /**
   * Delete traces upstream by the locator's own project (Issue #41 / T35). The locator, not a
   * scope: retention freezes it at discovery and a deletion's upstream half must run against
   * exactly that address even when no live scope can be presented anymore. A verified 404 on
   * the project answers `ok` with `deleted: false` — the project being gone means the traces
   * are — while any failure from the delete itself stays a retryable failure.
   */
  deleteTraces(
    locator: ObservationStorageLocator,
    input: { traceIds: readonly string[] },
  ): Promise<OpikPortResult<{ deleted: boolean }>>;
  /**
   * Delete one upstream dataset by id (Issue #41 / T35), same locator discipline as
   * deleteTraces. Unlike the trace path there is no verified 404-on-retrieve here: a client
   * error from the delete endpoint itself is an upstream failure, never a disguised success.
   */
  deleteDataset(
    locator: ObservationStorageLocator,
    input: { datasetId: string },
  ): Promise<OpikPortResult<{ deleted: boolean }>>;
};

/** Injection seams: the deployment target, the verified contract, and (for tests) transport
 * and deadline. There is no unverified default contract and no raw fetch escape hatch. */
export type OpikHttpPortDeps = {
  baseUrl: string;
  contract: VerifiedOpikContract;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type OpikPortErrorCode =
  | "CONTRACT_UNVERIFIED"
  | "OPERATION_UNSUPPORTED"
  | "OPERATION_INPUT_INVALID"
  | "REQUEST_BODY_TOO_LARGE"
  | "BODY_LIMIT_UNVERIFIED";

/**
 * Pre-I/O refusal, in the house convention: the code is the contract, the message is just
 * the code, and nothing about the request or response rides along.
 */
export class OpikPortError extends Error {
  constructor(public code: OpikPortErrorCode) {
    super(code);
  }
}
