/**
 * The Bifrost gateway's credit-admission capability negotiation (Bifrost 01.6, #212).
 *
 * HEALTHY IS NOT READY. 01.5's probe answers one question — reachable, and the credential is
 * allowed to manage me — and its 200 is never a readiness verdict. This module is the second,
 * deciding hop: an authenticated read of the gateway's extension manifest, hunting for the
 * OpenBot credit-admission extension (`openbot-credit-admission`) at a version this deployment
 * can trust. Three verdicts, and only one of them is a gateway to 01.7's readiness gate:
 * `absent` (the gateway is healthy but has no admission extension — the deployment must stay
 * closed), `incompatible` (it is there, but at a version outside the supported range), and
 * `present` — the only state that lets a readiness check proceed past the extension branch.
 *
 * A NEGOTIATION THAT DID NOT COMPLETE IS NOT A NEGOTIATION. The probe runs first and must be
 * `ok`; a probe refusal ends the run with the probe's own reason, before any manifest is
 * requested. A manifest hop that could not be read — refused, unexpected, unreachable, timed
 * out, oversized, unparseable, or a shape this module does not trust (duplicated names,
 * non-string fields) — ends the run with its own reason. Nothing is persisted on those paths:
 * there is no verdict to show, only a reason to act on, and an unfinished negotiation must
 * never masquerade as a completed one.
 *
 * WHAT A VERDICT BELONGS TO. The negotiation reads the endpoint configuration once and binds
 * its verdict to that snapshot's `configVersion` — the same contract the probe holds. The
 * latest verdict is persisted (an `enterprise_settings` row, the way the endpoint,
 * conversion-rate, credential and probe rows are), and `readLastGatewayNegotiation` answers
 * the stored verdict only while the current endpoint's `configVersion` still matches: a saved
 * configuration change retires the verdict on file — the row stays as history, but it answers
 * nothing, and the gate must renegotiate.
 *
 * REDACTION AS CONSTRUCTION, NOT FILTERING. The manifest's bytes are read only to be validated
 * and then dropped; response headers are never read back; fetch's error text is classified by
 * `error.name` and discarded; the log line carries the verdict, the reason code and the config
 * version, and nothing else. A version string that does not parse as strict `X.Y.Z` is never
 * echoed — not into the result, not into the log, not into the stored row — so the upstream
 * has no channel through this module at all.
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
import {
  GATEWAY_PROBE_MAX_BODY_BYTES,
  type GatewayProbeNotReadyReasonCode,
  type GatewayProbeReasonCode,
  probeGatewayManagementEndpoint,
} from "./probe";

/**
 * The management path this negotiation reads: the gateway's auth-gated extension/plugin list.
 * The endpoint configuration is an origin only (01.1 refuses paths); this module owns the
 * paths it calls, and this one is the extension manifest's.
 */
/**
 * The gateway path the extension manifest is read from. The dashboard's /api/plugins carries
 * management metadata its entries do not reduce to the identity pairs this module parses, so
 * the gateway serves the negotiation's manifest at its own path (/api/extensions, the
 * bifrost-http route that lists exactly the declared extensions with their versions).
 */
export const GATEWAY_EXTENSIONS_MANAGEMENT_PATH = "/api/extensions";

/** The extension this deployment cannot go live without: the strict credit admission gate. */
export const CREDIT_ADMISSION_EXTENSION_NAME = "openbot-credit-admission";

/**
 * The versions of the credit-admission extension this deployment trusts, expressed the way
 * 01.8 will show it. The rule itself is strict-numeric (major must equal the supported major);
 * this constant is its displayable name and is what an `incompatible` verdict carries.
 */
export const CREDIT_ADMISSION_SUPPORTED_RANGE = ">=1.0.0 <2.0.0";

/** The one major line of the extension this deployment trusts. */
const CREDIT_ADMISSION_SUPPORTED_MAJOR = 1;

/** The `enterprise_settings` row key the latest negotiation verdict is persisted under. */
export const GATEWAY_NEGOTIATION_RESULT_KEY = "gateway_negotiation_result";

/** `updatedBy` marker for the settings row the negotiation writes — it is no administrator's write. */
const NEGOTIATION_WRITER = "gateway-negotiation";

/** A version is trusted to echo only when it is exactly three dot-separated numbers. */
const STRICT_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export type GatewayCreditAdmissionExtensionState =
  | "present"
  | "absent"
  | "incompatible";

/**
 * The displayable, sanitized reason a completed negotiation carries: a stable code this module
 * owns, safe to show anywhere. None of these is ever built by interpolating upstream bytes,
 * an address, or a credential.
 */
export type GatewayCapabilityReasonCode =
  | "gateway_capability_extension_present"
  | "gateway_capability_extension_absent"
  | "gateway_capability_extension_version_incompatible"
  | "gateway_capability_extension_version_unparseable";

/** Why the manifest hop could not be read. Each one has a different remedy. */
export type GatewayNegotiationManifestReasonCode =
  | "gateway_negotiation_manifest_unauthorized"
  | "gateway_negotiation_manifest_unexpected_status"
  | "gateway_negotiation_manifest_connection_failed"
  | "gateway_negotiation_manifest_timeout"
  | "gateway_negotiation_manifest_invalid_body"
  | "gateway_negotiation_manifest_response_too_large";

/**
 * Why no negotiation completed: this deployment's gaps (the probe's not-ready reasons), the
 * probe's own refusal reasons (it ran and did not succeed — `ok` never occurs here), or the
 * manifest hop's reasons. An unfinished negotiation is persisted as nothing.
 */
export type GatewayNegotiationNotCompletedReasonCode =
  | GatewayProbeNotReadyReasonCode
  | GatewayProbeReasonCode
  | GatewayNegotiationManifestReasonCode;

/**
 * The contract 01.7's gate and 01.8's screen consume. Exactly six fields — there is no seventh
 * place an echo could hide.
 */
export type GatewayCapabilityNegotiation = {
  /** `present` is the only state that lets a readiness check proceed. */
  creditAdmissionExtension: GatewayCreditAdmissionExtensionState;
  /** The extension's version, echoed only when it parsed as strict `X.Y.Z`; otherwise null. */
  extensionVersion: string | null;
  reasonCode: GatewayCapabilityReasonCode;
  /** The supported range, named when (and only when) the verdict is a version verdict. */
  supportedRange: string | null;
  /** When the verdict was reached, ISO 8601 — the time the verdict speaks of. */
  checkedAt: string;
  /** The `configVersion` of the endpoint snapshot the negotiation decided against. */
  configVersion: number;
};

/** A persisted verdict. The same shape as the verdict; the name marks the storage boundary. */
export type GatewayNegotiationRecord = GatewayCapabilityNegotiation;

/** What {@link GatewayCapabilityNegotiationService.negotiateGatewayCapabilities} answers. */
export type GatewayCapabilityNegotiationRun =
  | { negotiated: true; negotiation: GatewayCapabilityNegotiation }
  | { negotiated: false; reasonCode: GatewayNegotiationNotCompletedReasonCode };

/** Where the latest verdict lives; the enterprise settings store is one implementation. */
export type GatewayNegotiationResultStore = {
  /**
   * Persist the verdict as the latest one. An older completion must not overwrite what a newer
   * attempt already recorded.
   */
  saveGatewayNegotiationResult(record: GatewayNegotiationRecord): Promise<void>;
  /** The latest persisted verdict, or undefined when none survives — including a damaged row. */
  readGatewayNegotiationResult(): Promise<GatewayNegotiationRecord | undefined>;
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
 * Read at most `cap` bytes of the body, refusing more. The bytes are validated below and never
 * stored, logged or returned.
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
  const error = new Error("The gateway negotiation timed out.");
  error.name = "TimeoutError";
  return error;
}

export type GatewayExtensionEntry = { name: string; version: string };

/** What the manifest hop answers: the trusted list, or the reason there is no list. */
export type GatewayExtensionManifestFetch =
  | { ok: true; plugins: GatewayExtensionEntry[] }
  | { ok: false; reasonCode: GatewayNegotiationManifestReasonCode };

/**
 * The manifest contract this module defines and trusts: a 2xx JSON object whose `plugins` is an
 * array of `{ name, version }` objects, each field a non-empty string, no name twice. Anything
 * else — a missing `plugins` key, a non-array, a malformed entry, a duplicate — makes the whole
 * manifest untrusted: a manifest that fails its own shape is not evidence about extensions.
 */
function parseExtensionManifest(
  parsed: unknown,
): GatewayExtensionEntry[] | undefined {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const plugins = (parsed as Record<string, unknown>).plugins;
  if (!Array.isArray(plugins)) return undefined;
  const entries: GatewayExtensionEntry[] = [];
  const seen = new Set<string>();
  for (const entry of plugins) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return undefined;
    }
    const { name, version } = entry as Record<string, unknown>;
    if (
      typeof name !== "string" ||
      name === "" ||
      typeof version !== "string" ||
      version === ""
    ) {
      return undefined;
    }
    if (seen.has(name)) return undefined;
    seen.add(name);
    entries.push({ name, version });
  }
  return entries;
}

/**
 * One authenticated GET of the extension manifest, classified — with the request, the clock and
 * the fetch supplied, so tests can stage every answer and nothing here owns state. The body is
 * read under the same deadline the fetch carries and capped the way the probe's is.
 */
export async function fetchGatewayExtensionManifest(options: {
  config: GatewayEndpointConfig;
  adminKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<GatewayExtensionManifestFetch> {
  const { config, adminKey } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();
  const url = `${config.baseUrl.replace(/\/+$/, "")}${GATEWAY_EXTENSIONS_MANAGEMENT_PATH}`;

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
    // The error object is deliberately dropped: its message names the address.
    return "unreachable" as const;
  });

  if (response === "timeout") {
    return { ok: false, reasonCode: "gateway_negotiation_manifest_timeout" };
  }
  if (response === "unreachable") {
    return {
      ok: false,
      reasonCode: "gateway_negotiation_manifest_connection_failed",
    };
  }

  if (response.status === 401 || response.status === 403) {
    await discardBody(response);
    return {
      ok: false,
      reasonCode: "gateway_negotiation_manifest_unauthorized",
    };
  }
  if (response.status < 200 || response.status > 299) {
    await discardBody(response);
    return {
      ok: false,
      reasonCode: "gateway_negotiation_manifest_unexpected_status",
    };
  }

  // The deadline covers the body read too, the way the probe's does. The losing
  // timer is cleared once the race settles, so it cannot fire into an already-
  // settled result or spin for the rest of the budget.
  const remainingMs = config.requestTimeoutMs - (now().getTime() - startedAt);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const body = await Promise.race([
    readBodyCapped(response, GATEWAY_PROBE_MAX_BODY_BYTES),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(timeoutError()),
        Math.max(1, remainingMs),
      );
    }),
  ])
    .catch((error: unknown) => {
      if (isTimeoutError(error)) return "timeout" as const;
      void response.body?.cancel().catch(() => {});
      return "unreadable" as const;
    })
    .finally(() => clearTimeout(timeout));

  if (body === "timeout") {
    return { ok: false, reasonCode: "gateway_negotiation_manifest_timeout" };
  }
  if (body === "unreadable") {
    return {
      ok: false,
      reasonCode: "gateway_negotiation_manifest_invalid_body",
    };
  }
  if (!body.ok) {
    return {
      ok: false,
      reasonCode:
        body.reason === "too_large"
          ? "gateway_negotiation_manifest_response_too_large"
          : "gateway_negotiation_manifest_invalid_body",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return {
      ok: false,
      reasonCode: "gateway_negotiation_manifest_invalid_body",
    };
  }
  const plugins = parseExtensionManifest(parsed);
  if (!plugins) {
    return {
      ok: false,
      reasonCode: "gateway_negotiation_manifest_invalid_body",
    };
  }
  return { ok: true, plugins };
}

/** The stored row's shape, read strictly. There is no lenient reading of a verdict. */
export function gatewayNegotiationRecordFromStored(
  stored: unknown,
): GatewayNegotiationRecord | undefined {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return undefined;
  }
  const record = stored as Record<string, unknown>;
  const {
    creditAdmissionExtension,
    extensionVersion,
    reasonCode,
    supportedRange,
    checkedAt,
    configVersion,
  } = record;
  if (
    (creditAdmissionExtension !== "present" &&
      creditAdmissionExtension !== "absent" &&
      creditAdmissionExtension !== "incompatible") ||
    (extensionVersion !== null &&
      (typeof extensionVersion !== "string" ||
        !STRICT_VERSION_PATTERN.test(extensionVersion))) ||
    typeof reasonCode !== "string" ||
    !reasonCode.startsWith("gateway_capability_") ||
    (supportedRange !== null &&
      (typeof supportedRange !== "string" || supportedRange === "")) ||
    typeof checkedAt !== "string" ||
    Number.isNaN(Date.parse(checkedAt)) ||
    typeof configVersion !== "number" ||
    !Number.isInteger(configVersion) ||
    configVersion < 0
  ) {
    return undefined;
  }
  return {
    creditAdmissionExtension,
    extensionVersion,
    reasonCode: reasonCode as GatewayCapabilityReasonCode,
    supportedRange,
    checkedAt,
    configVersion,
  };
}

/** The latest-verdict store over `enterprise_settings`, the way the sibling gateway rows do. */
export function createEnterpriseGatewayNegotiationStore(
  database: Database,
): GatewayNegotiationResultStore {
  return {
    /**
     * The conditional upsert, the way the probe's store works: a verdict checked no earlier
     * than the persisted one may replace it, so out-of-order completions cannot make the older
     * answer the one on file.
     */
    async saveGatewayNegotiationResult(record) {
      await database
        .insert(enterpriseSettings)
        .values({
          key: GATEWAY_NEGOTIATION_RESULT_KEY,
          value: record,
          updatedBy: NEGOTIATION_WRITER,
          updatedAt: new Date(record.checkedAt),
        })
        .onConflictDoUpdate({
          target: enterpriseSettings.key,
          set: {
            value: record,
            updatedBy: NEGOTIATION_WRITER,
            updatedAt: new Date(record.checkedAt),
          },
          setWhere: sql`coalesce(${enterpriseSettings.value} ->> 'checkedAt', '') <= ${record.checkedAt}`,
        });
    },

    async readGatewayNegotiationResult() {
      const [row] = await database
        .select({ value: enterpriseSettings.value })
        .from(enterpriseSettings)
        .where(eq(enterpriseSettings.key, GATEWAY_NEGOTIATION_RESULT_KEY))
        .limit(1);
      return row === undefined
        ? undefined
        : gatewayNegotiationRecordFromStored(row.value);
    },
  };
}

export type GatewayCapabilityNegotiationDeps = {
  store: GatewayNegotiationResultStore;
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

export type GatewayCapabilityNegotiationService = {
  /**
   * Negotiate once, now. A run that could not even start (no address, no usable credential,
   * a probe that did not succeed, a manifest that could not be read) answers
   * `negotiated: false` with the reason and persists nothing — there is no verdict to show.
   * A run that completed answers `negotiated: true` with the verdict, which has been
   * persisted as the latest one (persistence failure is logged and does not unmake the
   * answer the negotiation already holds).
   */
  negotiateGatewayCapabilities: () => Promise<GatewayCapabilityNegotiationRun>;
  /**
   * The latest persisted verdict — what a gate reads after a restart. Answers nothing once the
   * endpoint's `configVersion` has moved past the version the verdict decided against: the row
   * stays as history, but the configuration it described is gone.
   */
  readLastGatewayNegotiation: () => Promise<
    GatewayNegotiationRecord | undefined
  >;
};

function classifyExtensionVersion(
  version: string,
  checkedAt: string,
  configVersion: number,
): GatewayCapabilityNegotiation {
  const match = STRICT_VERSION_PATTERN.exec(version);
  if (!match) {
    // An unparseable version is upstream's to keep: never echoed, never stored.
    return {
      creditAdmissionExtension: "incompatible",
      extensionVersion: null,
      reasonCode: "gateway_capability_extension_version_unparseable",
      supportedRange: CREDIT_ADMISSION_SUPPORTED_RANGE,
      checkedAt,
      configVersion,
    };
  }
  if (Number(match[1]) !== CREDIT_ADMISSION_SUPPORTED_MAJOR) {
    return {
      creditAdmissionExtension: "incompatible",
      extensionVersion: version,
      reasonCode: "gateway_capability_extension_version_incompatible",
      supportedRange: CREDIT_ADMISSION_SUPPORTED_RANGE,
      checkedAt,
      configVersion,
    };
  }
  return {
    creditAdmissionExtension: "present",
    extensionVersion: version,
    reasonCode: "gateway_capability_extension_present",
    supportedRange: null,
    checkedAt,
    configVersion,
  };
}

export function createGatewayCapabilityNegotiationService(
  deps: GatewayCapabilityNegotiationDeps,
): GatewayCapabilityNegotiationService {
  const log = deps.log ?? getLogger("server");
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());

  return {
    async negotiateGatewayCapabilities() {
      const config = await deps.readGatewayEndpoint();
      if (!config) {
        log.warn(
          {
            type: "gateway-negotiation-not-completed",
            reasonCode: "gateway_probe_endpoint_not_configured",
          },
          "No gateway endpoint is configured, so the capability negotiation did not run.",
        );
        return {
          negotiated: false,
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
              type: "gateway-negotiation-not-completed",
              reasonCode: "gateway_probe_credential_not_configured",
            },
            "No gateway admin credential is configured, so the capability negotiation did not run.",
          );
          return {
            negotiated: false,
            reasonCode: "gateway_probe_credential_not_configured",
          };
        }
        // The resolver's own words may carry key material; the log gets the error's class.
        log.warn(
          {
            type: "gateway-negotiation-not-completed",
            reasonCode: "gateway_probe_credential_unavailable",
            errorName:
              error instanceof Error ? error.name : String(typeof error),
          },
          "The gateway admin credential could not be resolved, so the capability negotiation did not run.",
        );
        return {
          negotiated: false,
          reasonCode: "gateway_probe_credential_unavailable",
        };
      }

      // Hop one: the probe. Its 200 is a precondition here, never a verdict — a gateway that
      // answers health but refuses the credential is a gateway nobody may trust yet.
      const probe = await probeGatewayManagementEndpoint({
        config,
        adminKey,
        fetchImpl,
        now,
      });
      if (probe.status !== "ok") {
        log.warn(
          {
            type: "gateway-negotiation-not-completed",
            reasonCode: probe.reasonCode,
            configVersion: config.configVersion,
          },
          "The gateway probe did not succeed, so the capability negotiation did not run.",
        );
        return { negotiated: false, reasonCode: probe.reasonCode };
      }

      // Hop two: the extension manifest.
      const manifest = await fetchGatewayExtensionManifest({
        config,
        adminKey,
        fetchImpl,
        now,
      });
      if (!manifest.ok) {
        log.warn(
          {
            type: "gateway-negotiation-not-completed",
            reasonCode: manifest.reasonCode,
            configVersion: config.configVersion,
          },
          "The gateway extension manifest could not be read, so the capability negotiation did not complete.",
        );
        return { negotiated: false, reasonCode: manifest.reasonCode };
      }

      const entry = manifest.plugins.find(
        (candidate) => candidate.name === CREDIT_ADMISSION_EXTENSION_NAME,
      );
      const checkedAt = now().toISOString();
      const negotiation: GatewayCapabilityNegotiation = entry
        ? classifyExtensionVersion(
            entry.version,
            checkedAt,
            config.configVersion,
          )
        : {
            creditAdmissionExtension: "absent",
            extensionVersion: null,
            reasonCode: "gateway_capability_extension_absent",
            supportedRange: null,
            checkedAt,
            configVersion: config.configVersion,
          };

      // One line, and none of it is the gateway's: verdict, reason, version.
      log.info(
        {
          type: "gateway-negotiation-result",
          outcome: negotiation.creditAdmissionExtension,
          reasonCode: negotiation.reasonCode,
          configVersion: negotiation.configVersion,
        },
        "The gateway capability negotiation completed.",
      );

      try {
        await deps.store.saveGatewayNegotiationResult(negotiation);
      } catch (error) {
        // The verdict is already in hand; a broken store must not unmake it.
        log.error(
          {
            type: "gateway-negotiation-persist-failed",
            errorName:
              error instanceof Error ? error.name : String(typeof error),
          },
          "The gateway capability negotiation result could not be persisted.",
        );
      }
      return { negotiated: true, negotiation };
    },

    async readLastGatewayNegotiation() {
      const [config, record] = await Promise.all([
        deps.readGatewayEndpoint(),
        deps.store.readGatewayNegotiationResult(),
      ]);
      if (!config || !record) return undefined;
      // A verdict answers only for the configuration it decided against.
      return record.configVersion === config.configVersion ? record : undefined;
    },
  };
}

/**
 * The running negotiation, resolved through the installed enterprise controls so 01.7's gate
 * and 01.8's screen need no wiring of their own: the endpoint snapshot comes from 01.1's
 * service, the credential from 01.2's, and the latest verdict from the shared settings table.
 * Undefined in a test or script that never installed the controls — the same answer the
 * sibling accessors give.
 */
export function gatewayCapabilityControls():
  | GatewayCapabilityNegotiationService
  | undefined {
  const controls = enterpriseControls();
  if (!controls) return undefined;
  const endpoint = gatewayEndpointControls();
  const credential = gatewayAdminCredentialControls();
  if (!endpoint || !credential) return undefined;
  return createGatewayCapabilityNegotiationService({
    store: createEnterpriseGatewayNegotiationStore(controls.deps.database),
    readGatewayEndpoint: () => endpoint.readGatewayEndpoint(),
    resolveGatewayAdminCredential: () =>
      credential.resolveGatewayAdminCredential(),
    log: getLogger("server"),
  });
}
