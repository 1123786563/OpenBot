/**
 * The Bifrost gateway's connection and authentication probe (Bifrost 01.5, #211).
 *
 * ONE AUTHENTICATED GET, FIVE HONEST ANSWERS. The probe dials the gateway's management surface
 * with the deployment's admin credential (01.2's `resolveGatewayAdminCredential`) and classifies
 * what came back into exactly the statuses a person can act on: `ok`, `unauthenticated` (the
 * gateway answered and refused the credential), `unreachable` (no connection was ever
 * established), `timeout` (the deadline passed first), and `invalid_response` (something
 * answered, but not the management API this deployment expects). A failure is never one blur of
 * "it did not work": 01.7's readiness gate and 01.8's screen must be able to say which of those
 * five things is true, because each one has a different remedy.
 *
 * REDACTION AS CONSTRUCTION, NOT FILTERING. The upstream's bytes can never leak because they are
 * never kept. Response bodies are read only to be validated and then dropped; response headers
 * are never read back; fetch's own error text (which names the address) is classified by
 * `error.name` alone and discarded; the log line carries the status, the reason code, the
 * config version and the duration, and nothing else. A `reasonCode` is a fixed constant of this
 * module — no interpolation of anything the gateway sent, no internal address, no credential —
 * so it is safe to show on any screen.
 *
 * WHAT A RESULT BELONGS TO. The probe reads the endpoint configuration once, dials that snapshot,
 * and the result is bound to that snapshot's `configVersion` forever — a save that lands while
 * the request is in flight does not re-label a result that version N produced. The latest result
 * is persisted (an `enterprise_settings` row, the way the endpoint, conversion-rate and
 * credential rows are) so a status page can show the last known answer after a restart, and an
 * older completion never overwrites a newer persisted one.
 *
 * NOT READY IS NOT A PROBE. With no address, or no credential, there is nothing to probe; the
 * service refuses with its own not-ready reason rather than minting a fake `unreachable`, and
 * persists nothing. A probe — of any status — writes only its own row: it never touches the
 * saved endpoint, credential or conversion-rate configuration.
 */
import { eq, sql } from "drizzle-orm";
import type { Logger } from "../../../shared/logger";
import { getLogger } from "../../../shared/logger";
import { enterpriseControls } from "../admin/controls";
import type { Database } from "../db/client";
import { enterpriseSettings } from "../db/schema";
import {
  GatewayAdminCredentialNotConfiguredError,
  gatewayAdminCredentialControls,
} from "./admin-credential";
import {
  type GatewayEndpointConfig,
  gatewayEndpointControls,
} from "./endpoint-config";

/**
 * The management path the probe calls: the gateway's auth-gated configuration read, the one
 * endpoint whose 200 means "reachable and this credential is allowed to manage me" — which is
 * the question 01.5 answers. The endpoint configuration is an origin only (01.1 refuses paths);
 * each consumer owns the paths it calls, and this one is the probe's.
 */
export const GATEWAY_PROBE_MANAGEMENT_PATH = "/api/config";

/** The `enterprise_settings` row key the latest probe result is persisted under. */
export const GATEWAY_PROBE_RESULT_KEY = "gateway_probe_result";

/** `updatedBy` marker for the settings row the probe writes — it is no administrator's write. */
const PROBE_WRITER = "gateway-probe";

/**
 * How much of a response body the probe will read before it stops believing the peer: a
 * management read is a few kilobytes, so a peer pushing more is not the configured gateway.
 * The cap is what keeps a misbehaving endpoint from turning a probe into a memory event.
 */
export const GATEWAY_PROBE_MAX_BODY_BYTES = 512 * 1024;

export type GatewayProbeStatus =
  | "ok"
  | "unauthenticated"
  | "unreachable"
  | "timeout"
  | "invalid_response";

/**
 * The displayable, sanitized reason: a stable code this module owns, safe to show anywhere.
 * None of these is ever built by interpolating upstream bytes, an address, or a credential.
 */
export type GatewayProbeReasonCode =
  | "gateway_probe_ok"
  | "gateway_probe_unauthorized"
  | "gateway_probe_connection_failed"
  | "gateway_probe_timeout"
  | "gateway_probe_unexpected_status"
  | "gateway_probe_invalid_body"
  | "gateway_probe_response_too_large";

/** Why no probe ran at all. These name this deployment's gaps, not the gateway's answers. */
export type GatewayProbeNotReadyReasonCode =
  | "gateway_probe_endpoint_not_configured"
  | "gateway_probe_credential_not_configured"
  | "gateway_probe_credential_unavailable";

/** The contract 01.6 and 01.8 consume. Exactly five fields — there is no sixth place an echo could hide. */
export type GatewayProbeResult = {
  status: GatewayProbeStatus;
  reasonCode: GatewayProbeReasonCode;
  /** When the answer was classified, ISO 8601 — the time the result speaks of. */
  checkedAt: string;
  /** The `configVersion` of the endpoint snapshot the probe actually dialed. */
  configVersion: number;
  /** How long the attempt took, in milliseconds — diagnostics, not a secret. */
  durationMs: number;
};

/** A persisted probe result. The same shape as the result; the name marks the storage boundary. */
export type GatewayProbeRecord = GatewayProbeResult;

/** What {@link GatewayProbeService.probeGateway} answers. */
export type GatewayProbeRun =
  | { ready: true; result: GatewayProbeResult }
  | { ready: false; reasonCode: GatewayProbeNotReadyReasonCode };

/** Where the latest result lives; the enterprise settings store is one implementation. */
export type GatewayProbeResultStore = {
  /**
   * Persist the result as the latest one. An older completion (a slow probe finishing after a
   * fast later one) must not overwrite what a newer attempt already recorded.
   */
  saveGatewayProbeResult(record: GatewayProbeRecord): Promise<void>;
  /** The latest persisted result, or undefined when none survives — including a damaged row. */
  readGatewayProbeResult(): Promise<GatewayProbeRecord | undefined>;
};

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/** Drop the response's body without reading it into memory. */
function discardBody(response: Response): Promise<void> {
  return response.body
    ? response.body.cancel().then(() => undefined)
    : Promise.resolve();
}

/**
 * Read at most `cap` bytes of the body, refusing more. Reading is the only thing the probe ever
 * does with an upstream body: the bytes are validated below and never stored, logged or returned.
 */
async function readBodyCapped(
  response: Response,
  cap: number,
): Promise<
  { ok: true; text: string } | { ok: false; reason: "too_large" | "unreadable" }
> {
  if (!response.body) return { ok: true, text: "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    // The headers promised a body the connection never finished delivering.
    return { ok: false, reason: "unreadable" };
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

/** Reject with the same shape `AbortSignal.timeout` produces, so classification stays one branch. */
function timeoutError(): Error {
  const error = new Error("The gateway probe timed out.");
  error.name = "TimeoutError";
  return error;
}

/**
 * One authenticated GET against the management surface, classified — with the request, the
 * clock and the fetch supplied, so tests can stage every answer and nothing here owns state.
 * The result's `checkedAt` is stamped when the answer is classified, and `configVersion` is
 * the version of the `config` snapshot handed in — never re-read, never revised.
 */
export async function probeGatewayManagementEndpoint(options: {
  config: GatewayEndpointConfig;
  adminKey: string;
  fetchImpl: typeof fetch;
  now: () => Date;
}): Promise<GatewayProbeResult> {
  const { config, adminKey, fetchImpl, now } = options;
  const startedAt = now().getTime();
  const url = `${config.baseUrl.replace(/\/+$/, "")}${GATEWAY_PROBE_MANAGEMENT_PATH}`;

  // The only signal there is, is this deadline: any abort is ours, so any abort is a timeout.
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${adminKey}`,
      accept: "application/json",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  }).catch((error: unknown) => {
    if (isTimeoutError(error)) return "timeout" as const;
    // The error object is deliberately dropped here: its message names the address and could
    // carry anything else the network layer saw. The classification needs only the class.
    return "unreachable" as const;
  });

  if (response === "timeout" || response === "unreachable") {
    return finish(
      response === "timeout" ? "timeout" : "unreachable",
      response === "timeout"
        ? "gateway_probe_timeout"
        : "gateway_probe_connection_failed",
    );
  }

  if (response.status === 401 || response.status === 403) {
    await discardBody(response);
    return finish("unauthenticated", "gateway_probe_unauthorized");
  }
  if (response.status < 200 || response.status > 299) {
    // A 3xx, a 404, a 500: something answered, but not the management API as expected. The
    // status number itself is a fact about the peer, but the body is upstream's to keep.
    await discardBody(response);
    return finish("invalid_response", "gateway_probe_unexpected_status");
  }

  // The deadline covers the body read too: a peer that sends headers and then trickles or
  // stalls forever is a timeout, not a hung probe. The signal bound to the fetch does not
  // reach every stream read on every runtime, so the budget is enforced here as well.
  const remainingMs = config.requestTimeoutMs - (now().getTime() - startedAt);
  const body = await Promise.race([
    readBodyCapped(response, GATEWAY_PROBE_MAX_BODY_BYTES),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(timeoutError()), Math.max(1, remainingMs));
    }),
  ]).catch((error: unknown) => {
    if (isTimeoutError(error)) return "timeout" as const;
    void response.body?.cancel().catch(() => {});
    return "invalid_body" as const;
  });

  if (body === "timeout") {
    return finish("timeout", "gateway_probe_timeout");
  }
  if (body === "invalid_body") {
    return finish("invalid_response", "gateway_probe_invalid_body");
  }
  if (!body.ok) {
    return finish(
      "invalid_response",
      body.reason === "too_large"
        ? "gateway_probe_response_too_large"
        : "gateway_probe_invalid_body",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return finish("invalid_response", "gateway_probe_invalid_body");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return finish("invalid_response", "gateway_probe_invalid_body");
  }
  // Every path above returned without keeping the body: the bytes were validated and dropped,
  // so there is nothing an echo could ride on.
  return finish("ok", "gateway_probe_ok");

  function finish(
    status: GatewayProbeStatus,
    reasonCode: GatewayProbeReasonCode,
  ): GatewayProbeResult {
    const checkedAt = now();
    return {
      status,
      reasonCode,
      checkedAt: checkedAt.toISOString(),
      configVersion: config.configVersion,
      durationMs: Math.max(0, checkedAt.getTime() - startedAt),
    };
  }
}

/** The stored row's shape, read strictly. There is no lenient reading of a probe answer. */
export function gatewayProbeRecordFromStored(
  stored: unknown,
): GatewayProbeRecord | undefined {
  if (stored === null || typeof stored !== "object") return undefined;
  const record = stored as Partial<GatewayProbeRecord>;
  const statuses: readonly string[] = [
    "ok",
    "unauthenticated",
    "unreachable",
    "timeout",
    "invalid_response",
  ];
  if (
    typeof record.status !== "string" ||
    !statuses.includes(record.status) ||
    typeof record.reasonCode !== "string" ||
    !record.reasonCode.startsWith("gateway_probe_") ||
    typeof record.checkedAt !== "string" ||
    Number.isNaN(Date.parse(record.checkedAt)) ||
    typeof record.configVersion !== "number" ||
    !Number.isInteger(record.configVersion) ||
    record.configVersion < 0 ||
    typeof record.durationMs !== "number" ||
    !Number.isFinite(record.durationMs) ||
    record.durationMs < 0
  ) {
    return undefined;
  }
  return {
    status: record.status as GatewayProbeStatus,
    reasonCode: record.reasonCode as GatewayProbeReasonCode,
    checkedAt: record.checkedAt,
    configVersion: record.configVersion,
    durationMs: record.durationMs,
  };
}

/** The latest-result store over `enterprise_settings`, the way the sibling gateway rows do. */
export function createEnterpriseGatewayProbeStore(
  database: Database,
): GatewayProbeResultStore {
  return {
    /**
     * The conditional upsert: the row is replaced only by a result checked no earlier than the
     * one persisted — ISO 8601 UTC strings from one clock compare chronologically as text — so
     * two probes finishing out of order cannot make the older answer the one on file.
     */
    async saveGatewayProbeResult(record) {
      await database
        .insert(enterpriseSettings)
        .values({
          key: GATEWAY_PROBE_RESULT_KEY,
          value: record,
          updatedBy: PROBE_WRITER,
          updatedAt: new Date(record.checkedAt),
        })
        .onConflictDoUpdate({
          target: enterpriseSettings.key,
          set: {
            value: record,
            updatedBy: PROBE_WRITER,
            updatedAt: new Date(record.checkedAt),
          },
          setWhere: sql`coalesce(${enterpriseSettings.value} ->> 'checkedAt', '') <= ${record.checkedAt}`,
        });
    },

    async readGatewayProbeResult() {
      const [row] = await database
        .select({ value: enterpriseSettings.value })
        .from(enterpriseSettings)
        .where(eq(enterpriseSettings.key, GATEWAY_PROBE_RESULT_KEY))
        .limit(1);
      return row === undefined
        ? undefined
        : gatewayProbeRecordFromStored(row.value);
    },
  };
}

export type GatewayProbeDeps = {
  store: GatewayProbeResultStore;
  /** The current endpoint snapshot, or undefined when this deployment has named no gateway. */
  readGatewayEndpoint: () => Promise<GatewayEndpointConfig | undefined>;
  /** 01.2's internal resolve — the only place the admin key's plaintext may come from. */
  resolveGatewayAdminCredential: () => Promise<{ adminKey: string }>;
  /** Injectable for tests; the real deployment dials the network. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => Date;
  log?: Logger;
};

export type GatewayProbeService = {
  /**
   * Probe once, now. A run that could not even start (no address, no usable credential) answers
   * `ready: false` with the reason and persists nothing — it is not a probe result and must not
   * masquerade as one. A run that dialed answers `ready: true` with the classified result,
   * which has been persisted as the latest one (persistence failure is logged and does not
   * unmake the answer the probe already holds).
   */
  probeGateway: () => Promise<GatewayProbeRun>;
  /** The latest persisted result — what a status page shows after a restart. */
  readLastGatewayProbe: () => Promise<GatewayProbeRecord | undefined>;
};

export function createGatewayProbeService(
  deps: GatewayProbeDeps,
): GatewayProbeService {
  const log = deps.log ?? getLogger("server");
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());

  return {
    async probeGateway() {
      const config = await deps.readGatewayEndpoint();
      if (!config) {
        log.warn(
          {
            type: "gateway-probe-not-ready",
            reason: "endpoint-not-configured",
          },
          "No gateway endpoint is configured, so the probe did not run.",
        );
        return {
          ready: false,
          reasonCode: "gateway_probe_endpoint_not_configured",
        };
      }

      let adminKey: string;
      try {
        adminKey = (await deps.resolveGatewayAdminCredential()).adminKey;
      } catch (error) {
        if (error instanceof GatewayAdminCredentialNotConfiguredError) {
          log.warn(
            {
              type: "gateway-probe-not-ready",
              reason: "credential-not-configured",
            },
            "No gateway admin credential is configured, so the probe did not run.",
          );
          return {
            ready: false,
            reasonCode: "gateway_probe_credential_not_configured",
          };
        }
        // The resolver's own words may carry key material (a decrypt error does); the log gets
        // the error's class, never its message.
        log.warn(
          {
            type: "gateway-probe-not-ready",
            reason: "credential-unavailable",
            errorName:
              error instanceof Error ? error.name : String(typeof error),
          },
          "The gateway admin credential could not be resolved, so the probe did not run.",
        );
        return {
          ready: false,
          reasonCode: "gateway_probe_credential_unavailable",
        };
      }

      const result = await probeGatewayManagementEndpoint({
        config,
        adminKey,
        fetchImpl,
        now,
      });

      // One line, and none of it is the gateway's: status, reason, version, duration.
      const logLine = {
        type: "gateway-probe-result",
        status: result.status,
        reasonCode: result.reasonCode,
        configVersion: result.configVersion,
        durationMs: result.durationMs,
      };
      if (result.status === "ok") {
        log.info(logLine, "The gateway probe succeeded.");
      } else {
        log.warn(logLine, "The gateway probe did not succeed.");
      }

      try {
        await deps.store.saveGatewayProbeResult(result);
      } catch (error) {
        // The answer is already in hand; a broken store must not unmake it. The latest-result
        // row stays stale, which the next successful probe repairs.
        log.error(
          {
            type: "gateway-probe-persist-failed",
            errorName:
              error instanceof Error ? error.name : String(typeof error),
          },
          "The probe result could not be persisted.",
        );
      }
      return { ready: true, result };
    },

    async readLastGatewayProbe() {
      return deps.store.readGatewayProbeResult();
    },
  };
}

/**
 * The running probe, resolved through the installed enterprise controls so 01.6 and 01.8 need no
 * wiring of their own: the endpoint snapshot comes from 01.1's service, the credential from
 * 01.2's, and the latest result from the shared settings table. Undefined in a test or script
 * that never installed the controls — the same answer the sibling accessors give.
 */
export function gatewayProbeControls(): GatewayProbeService | undefined {
  const controls = enterpriseControls();
  if (!controls) return undefined;
  const endpoint = gatewayEndpointControls();
  const credential = gatewayAdminCredentialControls();
  if (!endpoint || !credential) return undefined;
  return createGatewayProbeService({
    store: createEnterpriseGatewayProbeStore(controls.deps.database),
    readGatewayEndpoint: () => endpoint.readGatewayEndpoint(),
    resolveGatewayAdminCredential: () =>
      credential.resolveGatewayAdminCredential(),
    log: getLogger("server"),
  });
}
