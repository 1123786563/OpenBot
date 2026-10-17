/**
 * The sole server HTTP adapter for Opik (Issue #14 / DAG T08).
 *
 * Serialization here is governed by the verified T04 contract only: each operation is gated
 * on the manifest capability its evidence belongs to, the wire shapes mirror
 * docs/opik-contract.md (snake_case bodies, `project_name` for trace creation — there is no
 * `project_id` there — the `projectName` header routing OTLP writes, 32/16-hex ids, string
 * nanoseconds, hyphenated UUIDv7 overrides, the `page/size/total/content` envelope), and a
 * request body never exceeds the verified byte cap. Facts the contract does not state are not
 * guessed: unknown response fields pass through untyped and untrusted, and unstated success
 * shapes (a 200 where 201 is verified) are malformed.
 *
 * Every request races a finite deadline — response headers and body alike — so a slow,
 * dribbling or never-resolving upstream settles into the typed `unavailable` outcome instead
 * of hanging the caller's Agent run. Ownership drift
 * — a response or binding that disagrees with the trusted scope — records the scope key in a
 * suspended-writes set and every later write for that scope answers drift without touching
 * the transport; reads stay available. Suspension is per adapter instance: clearing it is an
 * operator remediation (restart or a future ticket), never an automatic retry, because
 * "retry against another project" is exactly the silent continuation this port exists to
 * refuse.
 */

import type { SafeText, SafeValue } from "../../../shared/ai-observability";
import type { ObservationScope } from "./contracts";
import {
  type OpikDriftReason,
  type OpikHttpPortDeps,
  type OpikOperation,
  type OpikOtlpSpan,
  type OpikPort,
  OpikPortError,
  type OpikPortResult,
  type OpikRunBindingRef,
  type OpikTraceRow,
  type VerifiedOpikContract,
} from "./opik-port";
import { MAX_SAFE_TEXT_BYTES } from "./redaction";
import { assertObservationScope, resolveStorageLocator } from "./scope";

/**
 * Which verified capability authorizes which operation. The mapping is to evidence, not
 * convenience: the query-path operations key off `trace-query-id-mapping` because that
 * capability's manifest evidence (fixtures 04+07: retrieve-by-name, query-by-id) is the
 * chain that produced the manifest's own idMapping and isolatedProject facts; the OTLP
 * write additionally needs the verified body limit. A new operation requires a capability
 * here before it can send anything.
 */
const REQUIRED_CAPABILITIES: Record<OpikOperation, readonly string[]> = {
  healthCheck: ["service-health"],
  retrieveProject: ["trace-query-id-mapping"],
  createTrace: ["trace-query-id-mapping"],
  writeSpans: ["otlp-write-parent-child", "body-limit-boundary"],
  listTraces: ["trace-query-id-mapping"],
  // T35: the physical-delete capabilities T04's manifest already verified (fixtures
  // 36/41 — absence read-backs after the deletes), so a manifest that carried those
  // checks authorizes deletion and one that did not refuses it like any other operation.
  deleteTraces: ["trace-span-physical-delete"],
  deleteDataset: ["experiment-dataset-physical-delete"],
};

/** The success status the contract observed for each operation. Anything else is a failure. */
const VERIFIED_STATUS: Record<OpikOperation, number> = {
  healthCheck: 200,
  retrieveProject: 200,
  createTrace: 201,
  writeSpans: 200,
  listTraces: 200,
  deleteTraces: 204,
  deleteDataset: 204,
};

const DEFAULT_TIMEOUT_MS = 5_000;

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const UUIDV7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NANOS = /^\d{1,19}$/;

type Failure = OpikPortResult<never>;

const unavailable = (
  operation: OpikOperation,
  code: "OPIK_TIMEOUT" | "OPIK_UNREACHABLE",
): Failure => ({ outcome: "unavailable", operation, code });

const malformed = (operation: OpikOperation, detail: string): Failure => ({
  outcome: "malformed",
  operation,
  code: "OPIK_MALFORMED_RESPONSE",
  detail,
});

/** A withheld projection value cannot become wire text — spans are located by name. */
function requireText(name: SafeText): string {
  if (name.state === "omitted") {
    throw new OpikPortError("OPERATION_INPUT_INVALID");
  }
  return name.text;
}

/** T05 container outputs back plain JSON: omitted leaves drop out, nothing is invented. */
function plainValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => plainValue(item))
      .filter((item) => item !== undefined && item !== null);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(source)) {
      const plain = plainValue(source[key]);
      if (plain !== undefined && plain !== null) out[key] = plain;
    }
    return out;
  }
  return value;
}

function attribute(key: string, safe: SafeValue) {
  if (safe.state === "omitted") return null;
  const plain = plainValue(safe.value);
  if (plain === null || plain === undefined) return null;
  if (typeof plain === "string") return { key, value: { stringValue: plain } };
  if (typeof plain === "boolean") return { key, value: { boolValue: plain } };
  if (typeof plain === "number") {
    // OTLP carries 64-bit integers as strings in its JSON mapping.
    return Number.isInteger(plain)
      ? { key, value: { intValue: String(plain) } }
      : { key, value: { doubleValue: plain } };
  }
  return { key, value: { stringValue: JSON.stringify(plain) } };
}

function buildSpan(span: OpikOtlpSpan): Record<string, unknown> {
  if (!HEX32.test(span.traceId) || !HEX16.test(span.spanId)) {
    throw new OpikPortError("OPERATION_INPUT_INVALID");
  }
  if (span.parentSpanId !== undefined && !HEX16.test(span.parentSpanId)) {
    throw new OpikPortError("OPERATION_INPUT_INVALID");
  }
  if (!NANOS.test(span.startTimeUnixNano)) {
    throw new OpikPortError("OPERATION_INPUT_INVALID");
  }
  if (span.endTimeUnixNano !== undefined && !NANOS.test(span.endTimeUnixNano)) {
    throw new OpikPortError("OPERATION_INPUT_INVALID");
  }
  const wire: Record<string, unknown> = {
    traceId: span.traceId,
    spanId: span.spanId,
    name: requireText(span.name),
    startTimeUnixNano: span.startTimeUnixNano,
  };
  if (span.parentSpanId !== undefined) wire.parentSpanId = span.parentSpanId;
  if (span.endTimeUnixNano !== undefined) {
    wire.endTimeUnixNano = span.endTimeUnixNano;
  }
  const attributes: Array<{ key: string; value: unknown }> = [];
  if (span.attributes) {
    for (const key of Object.keys(span.attributes)) {
      const attributeEntry = attribute(key, span.attributes[key]);
      if (attributeEntry) attributes.push(attributeEntry);
    }
  }
  if (span.opik) {
    const { traceId, spanId, parentSpanId } = span.opik;
    if (!UUIDV7.test(traceId) || !UUIDV7.test(spanId)) {
      throw new OpikPortError("OPERATION_INPUT_INVALID");
    }
    if (parentSpanId !== undefined && !UUIDV7.test(parentSpanId)) {
      throw new OpikPortError("OPERATION_INPUT_INVALID");
    }
    attributes.push({ key: "opik.trace_id", value: { stringValue: traceId } });
    attributes.push({ key: "opik.span_id", value: { stringValue: spanId } });
    if (parentSpanId !== undefined) {
      attributes.push({
        key: "opik.parent_span_id",
        value: { stringValue: parentSpanId },
      });
    }
  }
  if (attributes.length > 0) wire.attributes = attributes;
  return wire;
}

function statusFailure(operation: OpikOperation, status: number): Failure {
  if (status >= 500) {
    return {
      outcome: "upstream_error",
      operation,
      code: "OPIK_UPSTREAM_ERROR",
      status,
    };
  }
  if (status >= 400) {
    return {
      outcome: "upstream_error",
      operation,
      code: "OPIK_CLIENT_ERROR",
      status,
    };
  }
  return malformed(operation, `unexpected_status:${status}`);
}

/** JSON body reader that never echoes what it could not read. */
async function readJsonObject(
  operation: OpikOperation,
  response: Response,
): Promise<OpikPortResult<Record<string, unknown>>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    return malformed(operation, "invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return malformed(operation, "invalid_json");
  }
  return { outcome: "ok", value: parsed as Record<string, unknown> };
}

export function createOpikHttpPort(deps: OpikHttpPortDeps): OpikPort {
  // The call signature only: this adapter never reaches for fetch's static members, and a
  // plain wrapper would not satisfy Bun's `typeof fetch` which carries `preconnect`.
  const transport = (deps.fetch ??
    ((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init))) as (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = deps.baseUrl.replace(/\/+$/, "");
  const contract: VerifiedOpikContract = deps.contract;

  // Verified means: the manifest shape this adapter was written against, and a run in which
  // every check passed. Anything else authorizes nothing — not even the health check.
  const contractVerified =
    contract.manifestVersion === 1 &&
    contract.checks.total > 0 &&
    contract.checks.total === contract.checks.passed;
  const okCapabilities = new Set(
    contract.capabilities
      .filter((capability) => capability.ok)
      .map((capability) => capability.name),
  );

  /** Scope keys whose writes are suspended after ownership drift, until an operator intervenes. */
  const suspendedWrites = new Set<string>();

  const requireOperation = (operation: OpikOperation) => {
    if (!contractVerified) throw new OpikPortError("CONTRACT_UNVERIFIED");
    for (const name of REQUIRED_CAPABILITIES[operation]) {
      if (!okCapabilities.has(name))
        throw new OpikPortError("OPERATION_UNSUPPORTED");
    }
  };

  const drift = (
    operation: OpikOperation,
    scopeKey: string,
    reason: OpikDriftReason,
  ): Failure => {
    suspendedWrites.add(scopeKey);
    return {
      outcome: "ownership_drift",
      operation,
      code: "OPIK_OWNERSHIP_DRIFT",
      reason,
      scopeKey,
    };
  };

  /** Scope and binding agreement for write paths: no request leaves while they disagree. */
  const guardWriteScope = (
    scope: ObservationScope,
    binding: OpikRunBindingRef | undefined,
    operation: OpikOperation,
  ): Failure | null => {
    assertObservationScope(scope);
    if (suspendedWrites.has(scope.key)) {
      return drift(operation, scope.key, "writes_suspended");
    }
    if (binding) {
      const locator = resolveStorageLocator(scope);
      if (
        binding.scopeKey !== scope.key ||
        binding.locatorWorkspace !== locator.workspace ||
        binding.locatorProject !== locator.project
      ) {
        return drift(operation, scope.key, "binding_mismatch");
      }
    }
    return null;
  };

  /**
   * One exchange with the deadline. The race — not the transport's good behavior — bounds
   * the call: even a fetch that ignores its abort signal loses to the deadline promise, and
   * a body delivered through `readBody` is read under the same deadline — a stream that
   * resolves the headers but never completes is still a slow upstream, never a hang.
   */
  const exchange = async <T = Response>(
    operation: OpikOperation,
    path: string,
    init: RequestInit,
    readBody?: (response: Response) => Promise<OpikPortResult<T>>,
  ): Promise<OpikPortResult<T>> => {
    let timedOut = false;
    const controller = new AbortController();
    let fireDeadline: () => void = () => {};
    const deadline = new Promise<"deadline">((resolve) => {
      fireDeadline = () => resolve("deadline");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      fireDeadline();
    }, timeoutMs);
    try {
      const raced = await Promise.race([
        transport(`${base}${path}`, { ...init, signal: controller.signal }),
        deadline,
      ]);
      if (raced === "deadline") return unavailable(operation, "OPIK_TIMEOUT");
      if (readBody === undefined) {
        // Without a readBody the caller asked for the raw Response; the generic's
        // default. The cast is the boundary where that assumption is asserted.
        return { outcome: "ok" as const, value: raced as T };
      }
      const settled = await Promise.race([readBody(raced), deadline]);
      if (settled === "deadline") return unavailable(operation, "OPIK_TIMEOUT");
      return settled;
    } catch {
      return unavailable(
        operation,
        timedOut ? "OPIK_TIMEOUT" : "OPIK_UNREACHABLE",
      );
    } finally {
      clearTimeout(timer);
    }
  };

  const verifiedBodyLimit = (): number => {
    const cap = contract.bodyLimit?.cappedAtBytes;
    if (typeof cap !== "number" || cap <= 0) {
      throw new OpikPortError("BODY_LIMIT_UNVERIFIED");
    }
    return cap;
  };

  /** Every serialized body is measured against the verified cap before anything is sent. */
  const withinVerifiedCap = (body: string): boolean =>
    new TextEncoder().encode(body).length <= verifiedBodyLimit();

  const postJson = (operation: OpikOperation, path: string, body: string) =>
    exchange(operation, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  return {
    async healthCheck() {
      requireOperation("healthCheck");
      return exchange(
        "healthCheck",
        "/health-check",
        { method: "GET" },
        // Healthy is a fact about the verified status alone — anything else,
        // a 401 above all, settles through statusFailure with the bare status;
        // the body is never read, so no upstream text rides along.
        async (response) => {
          if (response.status !== VERIFIED_STATUS.healthCheck) {
            return statusFailure("healthCheck", response.status);
          }
          return { outcome: "ok" as const, value: { healthy: true as const } };
        },
      );
    },

    async retrieveProject(scope) {
      requireOperation("retrieveProject");
      assertObservationScope(scope);
      const locator = resolveStorageLocator(scope);
      const body = JSON.stringify({ name: locator.project });
      if (!withinVerifiedCap(body)) {
        throw new OpikPortError("REQUEST_BODY_TOO_LARGE");
      }
      return exchange(
        "retrieveProject",
        "/v1/private/projects/retrieve",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        },
        async (response) => {
          // The verified not-found answer is a fact about the project, not a transport
          // failure.
          if (response.status === 404) {
            return { outcome: "ok" as const, value: null };
          }
          if (response.status !== VERIFIED_STATUS.retrieveProject) {
            return statusFailure("retrieveProject", response.status);
          }
          const parsed = await readJsonObject("retrieveProject", response);
          if (parsed.outcome !== "ok") return parsed;
          const id = parsed.value.id;
          if (typeof id !== "string" || id === "") {
            return malformed("retrieveProject", "field:id");
          }
          // The name is not a verified field of this response, but when an adversary or a
          // misrouted proxy sends it, it is checked against the authorized locator — never
          // trusted as the answer to "whose project is this".
          const name = parsed.value.name;
          if (typeof name === "string" && name !== locator.project) {
            return drift(
              "retrieveProject",
              scope.key,
              "response_name_mismatch",
            );
          }
          return { outcome: "ok" as const, value: { id } };
        },
      );
    },

    async createTrace(scope, input) {
      requireOperation("createTrace");
      const refused = guardWriteScope(scope, input.binding, "createTrace");
      if (refused) return refused;
      if (!UUIDV7.test(input.traceId)) {
        throw new OpikPortError("OPERATION_INPUT_INVALID");
      }
      if (input.threadId !== undefined && input.threadId.trim() === "") {
        throw new OpikPortError("OPERATION_INPUT_INVALID");
      }
      // A threadId is caller text that reaches Opik storage, so it may not be longer
      // than any T05 projection could have produced — no raw string rides past the
      // safe-projection ceiling by taking this field instead of a projected one.
      if (
        input.threadId !== undefined &&
        new TextEncoder().encode(input.threadId).length > MAX_SAFE_TEXT_BYTES
      ) {
        throw new OpikPortError("OPERATION_INPUT_INVALID");
      }
      if (
        !(input.startTime instanceof Date) ||
        Number.isNaN(input.startTime.getTime())
      ) {
        throw new OpikPortError("OPERATION_INPUT_INVALID");
      }
      const locator = resolveStorageLocator(scope);
      const body: Record<string, string> = {
        id: input.traceId,
        project_name: locator.project,
        start_time: input.startTime.toISOString(),
      };
      if (input.threadId !== undefined) body.thread_id = input.threadId;
      const payload = JSON.stringify(body);
      if (!withinVerifiedCap(payload)) {
        throw new OpikPortError("REQUEST_BODY_TOO_LARGE");
      }
      const exchanged = await postJson(
        "createTrace",
        "/v1/private/traces",
        payload,
      );
      if (exchanged.outcome !== "ok") return exchanged;
      const response = exchanged.value;
      if (response.status !== VERIFIED_STATUS.createTrace) {
        return statusFailure("createTrace", response.status);
      }
      // The contract does not state a response body for creation; nothing is read, so
      // nothing unverified can be mistaken for an upstream-granted identity.
      return { outcome: "ok", value: { traceId: input.traceId } };
    },

    async writeSpans(scope, input) {
      requireOperation("writeSpans");
      const refused = guardWriteScope(scope, input.binding, "writeSpans");
      if (refused) return refused;
      if (!Array.isArray(input.spans) || input.spans.length === 0) {
        throw new OpikPortError("OPERATION_INPUT_INVALID");
      }
      const payload = JSON.stringify({
        resourceSpans: [
          { scopeSpans: [{ spans: input.spans.map(buildSpan) }] },
        ],
      });
      if (!withinVerifiedCap(payload)) {
        throw new OpikPortError("REQUEST_BODY_TOO_LARGE");
      }
      const locator = resolveStorageLocator(scope);
      const exchanged = await exchange(
        "writeSpans",
        "/v1/private/otel/v1/traces",
        {
          method: "POST",
          // Verified routing fact: the OTLP endpoint takes the project from this header.
          headers: {
            "content-type": "application/json",
            projectName: locator.project,
          },
          body: payload,
        },
      );
      if (exchanged.outcome !== "ok") return exchanged;
      const response = exchanged.value;
      if (response.status !== VERIFIED_STATUS.writeSpans) {
        return statusFailure("writeSpans", response.status);
      }
      // Verified answer is 200 with an empty body; derived ids must be read back, and the
      // read-back is listTraces' job, never an invented echo here.
      return { outcome: "ok", value: { accepted: true } };
    },

    async listTraces(scope, input) {
      requireOperation("listTraces");
      assertObservationScope(scope);
      if (typeof input.projectId !== "string" || input.projectId === "") {
        throw new OpikPortError("OPERATION_INPUT_INVALID");
      }
      const query = new URLSearchParams({ project_id: input.projectId });
      if (input.size !== undefined) {
        if (!Number.isInteger(input.size) || input.size <= 0) {
          throw new OpikPortError("OPERATION_INPUT_INVALID");
        }
        query.set("size", String(input.size));
      }
      if (input.page !== undefined) {
        if (!Number.isInteger(input.page) || input.page < 0) {
          throw new OpikPortError("OPERATION_INPUT_INVALID");
        }
        query.set("page", String(input.page));
      }
      const exchanged = await exchange(
        "listTraces",
        `/v1/private/traces?${query.toString()}`,
        { method: "GET" },
        async (response) => {
          if (response.status !== VERIFIED_STATUS.listTraces) {
            return statusFailure("listTraces", response.status);
          }
          const parsed = await readJsonObject("listTraces", response);
          if (parsed.outcome !== "ok") return parsed;
          const envelope = parsed.value;
          const page = envelope.page;
          const size = envelope.size;
          const total = envelope.total;
          if (
            typeof page !== "number" ||
            typeof size !== "number" ||
            typeof total !== "number"
          ) {
            return malformed(
              "listTraces",
              typeof page !== "number"
                ? "field:page"
                : typeof size !== "number"
                  ? "field:size"
                  : "field:total",
            );
          }
          const content = envelope.content;
          if (!Array.isArray(content)) {
            return malformed("listTraces", "field:content");
          }
          const rows: OpikTraceRow[] = [];
          for (const row of content) {
            if (!row || typeof row !== "object" || Array.isArray(row)) {
              return malformed("listTraces", "field:content.id");
            }
            const record = row as Record<string, unknown>;
            if (typeof record.id !== "string" || record.id === "") {
              return malformed("listTraces", "field:content.id");
            }
            // `project_id` on rows is not a verified field, but when present it is held
            // against the project the port itself queried — cross-project data in our
            // page is drift.
            const projectId = record.project_id;
            if (
              typeof projectId === "string" &&
              projectId !== input.projectId
            ) {
              return drift(
                "listTraces",
                scope.key,
                "response_project_mismatch",
              );
            }
            rows.push(record as OpikTraceRow);
          }
          return {
            outcome: "ok",
            value: {
              page,
              size,
              total,
              content: rows,
            },
          };
        },
      );
      return exchanged;
    },

    async deleteTraces(scope, input) {
      requireOperation("deleteTraces");
      const refused = guardWriteScope(scope, undefined, "deleteTraces");
      if (refused) return refused;
      if (
        typeof input.projectId !== "string" ||
        input.projectId === "" ||
        !Array.isArray(input.traceIds) ||
        input.traceIds.length === 0 ||
        input.traceIds.some((id) => typeof id !== "string" || id === "")
      ) {
        throw new OpikPortError("OPERATION_INPUT_INVALID");
      }
      const payload = JSON.stringify({
        ids: input.traceIds,
        project_id: input.projectId,
      });
      if (!withinVerifiedCap(payload)) {
        throw new OpikPortError("REQUEST_BODY_TOO_LARGE");
      }
      const exchanged = await postJson(
        "deleteTraces",
        "/v1/private/traces/delete",
        payload,
      );
      if (exchanged.outcome !== "ok") return exchanged;
      const response = exchanged.value;
      if (response.status !== VERIFIED_STATUS.deleteTraces) {
        return statusFailure("deleteTraces", response.status);
      }
      // Verified answer is 204 with no body; nothing is read, so nothing unverified
      // can be mistaken for an upstream acknowledgment.
      return { outcome: "ok", value: { deleted: true as const } };
    },

    async deleteDataset(scope, input) {
      requireOperation("deleteDataset");
      const refused = guardWriteScope(scope, undefined, "deleteDataset");
      if (refused) return refused;
      if (typeof input.datasetId !== "string" || input.datasetId === "") {
        throw new OpikPortError("OPERATION_INPUT_INVALID");
      }
      const payload = JSON.stringify({ ids: [input.datasetId] });
      if (!withinVerifiedCap(payload)) {
        throw new OpikPortError("REQUEST_BODY_TOO_LARGE");
      }
      const exchanged = await postJson(
        "deleteDataset",
        "/v1/private/datasets/delete-batch",
        payload,
      );
      if (exchanged.outcome !== "ok") return exchanged;
      const response = exchanged.value;
      if (response.status !== VERIFIED_STATUS.deleteDataset) {
        return statusFailure("deleteDataset", response.status);
      }
      return { outcome: "ok", value: { deleted: true as const } };
    },
  };
}
