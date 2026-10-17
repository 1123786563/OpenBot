/**
 * Four-state health check for the self-hosted Hindsight service.
 *
 * The check distinguishes the three conditions the spec requires a platform operator to tell
 * apart — the service is usable, the model gateway is unreachable, the privacy configuration is
 * noncompliant — plus the honest fourth: the service itself is unreachable, which must not be
 * misreported as a gateway problem. It reports states and rule names only: no memory content,
 * no tokens, no provider endpoints leak into a status object that ends up in admin views.
 *
 * Gateway reachability is probed through Hindsight's own bank LLM health endpoint
 * (POST /v1/{tenant}/banks/{bank}/health/llm), which makes one minimal provider call per
 * operation and by construction returns status only — never the provider, model, endpoint,
 * API key, or raw error. That is the same path real retain/reflect traffic takes, so "gateway
 * reachable" here means "Hindsight can actually run model calls through the approved gateway",
 * not merely "some TCP port is open".
 *
 * Beyond the declared posture, the one privacy knob the service itself exposes — the version
 * endpoint's llm_trace feature flag — is cross-checked against this deployment's declaration
 * on the service_up path, so a declaration of "not traced" that the running service contradicts
 * is reported as config_noncompliant with a runtime violation, not swallowed as service_up.
 */
import { getLogger } from "../../../shared/logger";
import {
  type HindsightConfig,
  type PrivacyViolationId,
  validateHindsightPrivacy,
} from "./config";

const log = getLogger("server");

/**
 * Tenant segment of the Hindsight API path (/v1/{tenant}/...). The pinned deployment is
 * single-tenant, so the segment stays a module constant here — symmetric with the bank id,
 * which remains per-deployment configuration (HINDSIGHT_BANK_ID) because the probe exercises
 * a configured bank, not a fixed one.
 */
const HINDSIGHT_TENANT_SEGMENT = "default";

export type HindsightHealthState =
  | "service_up"
  | "gateway_down"
  | "config_noncompliant"
  | "service_down";

export type HindsightHealthStatus = {
  state: HindsightHealthState;
  /** When the probe ran. ISO timestamp. */
  checkedAt: string;
  /** Hindsight's reported API version, when the service answered. Rule names on noncompliance. */
  version?: string;
  /** Privacy rule identifiers that failed, present only on config_noncompliant. */
  violations?: PrivacyViolationId[];
};

export type HindsightHealthDeps = {
  /** Injectable for tests; the real check uses the platform's fetch with a timeout. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
};

type LlmProbeOperation = {
  operation?: string;
  /** Authoritative on the pinned 1.0.0 build: true when the provider call succeeded. */
  ok?: boolean;
  /** "connected" on the pinned build; "healthy" accepted for older shapes. */
  status?: string;
};

type LlmProbeResponse = {
  operations?: LlmProbeOperation[];
};

async function requestJson(
  deps: HindsightHealthDeps,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await deps.fetch(url, init);
  if (!response.ok) {
    throw new Error(`request failed with status ${response.status}`);
  }
  return response.json();
}

function authorizedInit(
  config: HindsightConfig,
  method: "GET" | "POST",
): RequestInit {
  return {
    method,
    headers: {
      authorization: `Bearer ${config.apiToken}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  };
}

/**
 * Read the version endpoint's identity and runtime feature surface. The pinned build answers
 * { api_version, features: { ..., llm_trace } }; anything unreadable (older shape, failure)
 * comes back undefined, which callers treat as "no runtime evidence", never as a violation.
 */
async function readVersion(
  deps: HindsightHealthDeps,
  config: HindsightConfig,
): Promise<{ version?: string; llmTrace?: boolean }> {
  try {
    const body = (await requestJson(
      deps,
      `${config.apiUrl}/version`,
      authorizedInit(config, "GET"),
    )) as {
      version?: string;
      api_version?: string;
      features?: { llm_trace?: unknown };
    };
    const version = body?.api_version ?? body?.version;
    const llmTrace = body?.features?.llm_trace;
    return {
      version: typeof version === "string" ? version : undefined,
      llmTrace: typeof llmTrace === "boolean" ? llmTrace : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * One operation is healthy when its provider call succeeded. The pinned 1.0.0 build reports
 * `ok: true, status: "connected"`; the `ok` boolean decides when present, and status is a
 * fallback so the check does not silently turn a build's wording change into "gateway down".
 */
function operationHealthy(entry: LlmProbeOperation): boolean {
  if (typeof entry?.ok === "boolean") return entry.ok;
  return ["healthy", "connected"].includes((entry?.status ?? "").toLowerCase());
}

/**
 * Probe the deployment. Order matters: a noncompliant privacy declaration is reported even when
 * the service is down, because it is a property of this deployment's configuration, not of the
 * network right now; then the service must be reachable before a gateway verdict means anything.
 */
export async function checkHindsightHealth(
  config: HindsightConfig,
  deps?: Partial<HindsightHealthDeps>,
): Promise<HindsightHealthStatus> {
  const resolved: Required<HindsightHealthDeps> = {
    // Per-key fallbacks, not a spread: an explicitly `undefined` dep must not erase the default.
    fetch: deps?.fetch ?? ((input, init) => fetch(input, init)),
    now: deps?.now ?? (() => new Date()),
  };
  const checkedAt = resolved.now().toISOString();

  const compliance = validateHindsightPrivacy(config.privacy);
  if (!compliance.compliant) {
    return {
      state: "config_noncompliant",
      checkedAt,
      violations: compliance.violations,
    };
  }

  try {
    await requestJson(
      resolved,
      `${config.apiUrl}/health`,
      authorizedInit(config, "GET"),
    );
  } catch (error) {
    // Same logging contract as the gateway-probe catch below: the verdict stays service_down
    // and the status object reports states only, but the log keeps the original failure — the
    // error name and its message, which carries the HTTP status when the probe got one.
    // Deliberately coarse mapping, spelled out: service_down covers not only "the service never
    // answered" (connect failure / timeout) but also "the service answered and refused" —
    // /health requires the bearer token (ApiKeyTenantExtension checks every request), so a
    // misconfigured or rotated apiToken makes /health answer 401 and lands here too. The four
    // states have no auth verdict, so the HTTP status inside the logged detail is the
    // discriminator between the two ("request failed with status 401" means fix the token,
    // not restart the container).
    log.warn(
      {
        type: "hindsight-health-service-probe-failed",
        error: error instanceof Error ? error.name : "UnknownError",
        detail: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      },
      "hindsight-health-service-probe-failed",
    );
    return { state: "service_down", checkedAt };
  }

  const runtime = await readVersion(resolved, config);
  const version = runtime.version;

  try {
    const probe = (await requestJson(
      resolved,
      `${config.apiUrl}/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${encodeURIComponent(config.bankId)}/health/llm`,
      authorizedInit(config, "POST"),
    )) as LlmProbeResponse;
    const operations = Array.isArray(probe?.operations) ? probe.operations : [];
    const allHealthy =
      operations.length > 0 && operations.every(operationHealthy);
    if (!allHealthy) {
      return {
        state: "gateway_down",
        checkedAt,
        ...(version !== undefined ? { version } : {}),
      };
    }
    // Runtime cross-check of the one privacy knob the API does expose: the version endpoint's
    // llm_trace feature flag against this deployment's own declaration. A service that reports
    // llm_trace enabled while the declaration says false is noncompliant no matter what the
    // deployment claims, so the verdict escalates to config_noncompliant with a violation that
    // names the runtime evidence. Honest scope: the operation/backup retention windows have no
    // readable runtime values in the API, so they remain a deployment-reconciliation matter
    // (the #391 cleanup-evidence ticket keeps tracking that); a missing or unreadable flag is
    // not evidence of anything and stays service_up.
    if (config.privacy.llmTraceEnabled === false && runtime.llmTrace === true) {
      return {
        state: "config_noncompliant",
        checkedAt,
        violations: ["runtime_llm_trace_enabled"],
        ...(version !== undefined ? { version } : {}),
      };
    }
    return {
      state: "service_up",
      checkedAt,
      ...(version !== undefined ? { version } : {}),
    };
  } catch (error) {
    // The verdict stays gateway_down — the four states and the status key set do not move — but
    // the log keeps the original failure: the error name and its message, which carries the HTTP
    // status when the probe got one. The status object itself still reports states only.
    // Deliberate coarse semantics, worth spelling out before #393 wires this into an admin view:
    // every non-2xx probe answer (4xx/5xx) throws out of requestJson and lands here, so a probe
    // 404 from a renamed or removed bank, or a 5xx on the probe path, surfaces as "gateway
    // unavailable" alongside real gateway outages — the state means "the probe path did not
    // complete through the approved gateway", never a diagnosis of which link broke. This catch
    // is only reachable once /health has succeeded, i.e. the apiToken was accepted: a
    // misconfigured or rotated apiToken never gets here — it is rejected earlier at /health and
    // reported as service_down (see that catch above).
    log.warn(
      {
        type: "hindsight-health-gateway-probe-failed",
        error: error instanceof Error ? error.name : "UnknownError",
        detail: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      },
      "hindsight-health-gateway-probe-failed",
    );
    return {
      state: "gateway_down",
      checkedAt,
      ...(version !== undefined ? { version } : {}),
    };
  }
}
