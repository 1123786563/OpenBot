/**
 * The Bifrost gateway endpoint configuration: where the model gateway listens and how long a
 * request to it may take, versioned so every consumer can say which revision it decided against.
 *
 * TWO ENTRY POINTS, ONE SET OF RULES. A deployment may name the gateway in its environment
 * (`BIFROST_GATEWAY_URL`, read at boot through `config.ts`), and an administrator may save it at
 * runtime (`saveGatewayEndpoint`, mounted on an admin surface by 01.8). Both validate through the
 * same refusal semantics in this file — an http or https origin, no credentials in the URL, no
 * path, query or fragment — so the two paths cannot drift into disagreeing about what is legal.
 *
 * THE VERSION. Every successful save produces the next `configVersion`: a positive integer,
 * assigned by the server inside the save's transaction under a transaction-scoped advisory lock
 * (`writeGatewayEndpointRow`), so two concurrent saves serialize — including two FIRST saves, where
 * a row lock would lock nothing and both would claim version 1 — and never accepted from a caller:
 * an input that names one is refused, which is what makes an old version impossible to write back.
 * The environment default, when no row has been saved, reads as version `0`: the boot revision,
 * distinguishable from every saved one. A saved row (version ≥ 1) always wins over it — and a row
 * that exists but does not validate reads as unconfigured rather than falling back to the
 * environment, so a consumer that has seen version N is never handed 0 by a damaged row.
 *
 * NO SECRETS HERE. This configuration is addressing only. The gateway's admin credential is 01.2's
 * concern and lives in the credential store; `GatewayEndpointConfig` has no field a secret could
 * occupy, so a read of it cannot leak one.
 */
import { getLogger } from "../../../shared/logger";
import { enterpriseControls } from "../admin/controls";

const log = getLogger("server");

export type GatewayEndpointSettings = {
  /** The gateway origin, such as `https://bifrost.internal`. No path, no query, no credentials. */
  baseUrl: string;
  /** One request's ceiling, in milliseconds. */
  requestTimeoutMs: number;
};

export type GatewayEndpointConfig = GatewayEndpointSettings & {
  /** Server-assigned, strictly increasing per successful save; `0` is the environment revision. */
  configVersion: number;
};

/** One request's ceiling when nobody said otherwise — the same default Lago's client carries. */
export const DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS = 10_000;

export const GATEWAY_URL_VARIABLE = "BIFROST_GATEWAY_URL";
export const GATEWAY_REQUEST_TIMEOUT_VARIABLE =
  "BIFROST_GATEWAY_REQUEST_TIMEOUT_MS";

/**
 * The URL refusal semantics both entry points share, in the voice `config.ts` uses: the caller
 * names the variable or field, this returns the sentence, or undefined when the address is legal.
 *
 * An ORIGIN, deliberately, for the same reason `LAGO_API_URL` is: the client owns the paths it
 * calls (the probe, the catalog sync, the admission extension), so a base URL that arrived with
 * one is a value copied from somewhere that spells it differently, and would produce requests to
 * `/v1/v1/...` at runtime. Refused where somebody is looking, with the reason.
 */
export function gatewayBaseUrlProblem(
  name: string,
  raw: string,
): string | undefined {
  if (!raw) {
    return `${name} is required: the gateway address, such as https://bifrost.internal`;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return `${name} must be a valid URL`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `${name} must be an http or https URL`;
  }
  if (parsed.username || parsed.password) {
    return `${name} must not carry credentials in the URL: the gateway's admin credential is stored separately (write-only), never addressed`;
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path !== "" || parsed.search || parsed.hash) {
    return `${name} must be the gateway origin only, without a path, query or fragment`;
  }
  return undefined;
}

/** A timeout's refusal, in the same voice. `undefined` means the caller may use it as-is. */
export function gatewayRequestTimeoutProblem(
  name: string,
  value: unknown,
): string | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return `${name} must be a whole number of milliseconds greater than zero`;
  }
  return undefined;
}

export type GatewayEndpointInputValidation =
  | { ok: true; settings: GatewayEndpointSettings }
  | { ok: false; error: string };

const ALLOWED_INPUT_KEYS = new Set(["baseUrl", "requestTimeoutMs"]);

/**
 * Validate an administrator's save. Strict: an unknown key is refused rather than dropped, so a
 * typo (`timeoutMs`) and an attempt to smuggle a field in (`adminKey`) both surface as errors
 * rather than half-work. `configVersion` is named in its own refusal so the sentence explains the
 * rule rather than just listing keys.
 */
export function validateGatewayEndpointInput(
  input: unknown,
): GatewayEndpointInputValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error:
        "The gateway endpoint configuration must be a JSON object naming baseUrl (and optionally requestTimeoutMs).",
    };
  }
  const record = input as Record<string, unknown>;
  if ("configVersion" in record) {
    return {
      ok: false,
      error:
        "configVersion is assigned by the server on every save and cannot be written. Send only baseUrl and requestTimeoutMs.",
    };
  }
  for (const key of Object.keys(record)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      return {
        ok: false,
        error: `Unknown field "${key}": the gateway endpoint configuration accepts only baseUrl and requestTimeoutMs.`,
      };
    }
  }
  const baseUrl =
    typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
  if (!baseUrl) {
    return {
      ok: false,
      error: gatewayBaseUrlProblem("baseUrl", "") as string,
    };
  }
  const baseUrlProblem = gatewayBaseUrlProblem("baseUrl", baseUrl);
  if (baseUrlProblem) return { ok: false, error: baseUrlProblem };

  let requestTimeoutMs = DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS;
  if (record.requestTimeoutMs !== undefined) {
    const problem = gatewayRequestTimeoutProblem(
      "requestTimeoutMs",
      record.requestTimeoutMs,
    );
    if (problem) return { ok: false, error: problem };
    requestTimeoutMs = record.requestTimeoutMs as number;
  }
  return { ok: true, settings: { baseUrl, requestTimeoutMs } };
}

/**
 * A stored row, as this module is willing to hand it back: the whole shape must validate, because
 * a caller dials the address. A row that does not (nothing writes one except
 * `writeGatewayEndpointRow`, which validates first — so this is tampering or a hand edit) is the
 * caller's problem to refuse, not to paper over.
 */
export function gatewayEndpointFromStored(
  stored: Record<string, unknown> | undefined,
): GatewayEndpointConfig | undefined {
  const value = stored?.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const baseUrl =
    typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
  if (
    !baseUrl ||
    gatewayBaseUrlProblem("The stored gateway address", baseUrl)
  ) {
    return undefined;
  }
  const requestTimeoutMs = record.requestTimeoutMs;
  if (
    typeof requestTimeoutMs !== "number" ||
    gatewayRequestTimeoutProblem("The stored timeout", requestTimeoutMs)
  ) {
    return undefined;
  }
  const configVersion = record.configVersion;
  if (
    typeof configVersion !== "number" ||
    !Number.isInteger(configVersion) ||
    configVersion < 1
  ) {
    return undefined;
  }
  return { baseUrl, requestTimeoutMs, configVersion };
}

/**
 * The version a stored row carries, even when the rest of it is broken. The next save is this plus
 * one, so a corrupted address cannot drag the version backwards and hand a consumer that saw
 * version N a number lower than N. Absent or nonsense reads as 0, the pre-first-save state.
 */
export function gatewayVersionFromStored(
  stored: Record<string, unknown> | undefined,
): number {
  const value = stored?.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return 0;
  }
  const configVersion = (value as Record<string, unknown>).configVersion;
  if (
    typeof configVersion !== "number" ||
    !Number.isInteger(configVersion) ||
    configVersion < 1
  ) {
    return 0;
  }
  return configVersion;
}

/** What the settings store found for the gateway endpoint row — three answers, not two. */
export type StoredGatewayEndpoint =
  | { state: "configured"; config: GatewayEndpointConfig }
  /** A row exists but does not validate: damaged, not absent, and read as unconfigured. */
  | { state: "corrupted" }
  /** No row at all: nothing was ever saved, so the environment default applies. */
  | { state: "absent" };

/**
 * Classify a stored row. The distinction the service turns on: `absent` may fall back to the
 * environment's address, `corrupted` may not — a deployment whose saved configuration was damaged
 * must read as unconfigured (loud, refusing) rather than silently dial a different gateway.
 */
export function storedGatewayEndpointState(
  stored: Record<string, unknown> | undefined,
): StoredGatewayEndpoint {
  if (stored === undefined) return { state: "absent" };
  const config = gatewayEndpointFromStored(stored);
  return config === undefined
    ? { state: "corrupted" }
    : { state: "configured", config };
}

/**
 * The environment's gateway default, at version 0, or undefined when the deployment names none.
 *
 * Refuses rather than coerces, exactly as `config.ts` does everywhere: a half-shape or a wrong
 * value stops the boot with the variable named (a timeout with no URL is a leftover naming
 * nothing, the same way a `MANAGED_AGENT_TOKEN` with no endpoint is), and an invalid URL stops it
 * with the shared refusal sentence.
 */
export function gatewayEnvDefaultConfig(
  environment: Record<string, string | undefined>,
): GatewayEndpointConfig | undefined {
  const raw = environment[GATEWAY_URL_VARIABLE]?.trim();
  const timeoutRaw = environment[GATEWAY_REQUEST_TIMEOUT_VARIABLE]?.trim();
  if (!raw) {
    if (timeoutRaw) {
      throw new Error(
        `${GATEWAY_REQUEST_TIMEOUT_VARIABLE} is set but ${GATEWAY_URL_VARIABLE} is not: a request ceiling for a gateway this deployment has not named`,
      );
    }
    return undefined;
  }
  const problem = gatewayBaseUrlProblem(GATEWAY_URL_VARIABLE, raw);
  if (problem) throw new Error(problem);

  let requestTimeoutMs = DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS;
  if (timeoutRaw) {
    const value = Number(timeoutRaw);
    const timeoutProblem = gatewayRequestTimeoutProblem(
      GATEWAY_REQUEST_TIMEOUT_VARIABLE,
      value,
    );
    if (timeoutProblem) throw new Error(timeoutProblem);
    requestTimeoutMs = value;
  }
  return { baseUrl: raw, requestTimeoutMs, configVersion: 0 };
}

/** What the service needs from the settings store; `EnterpriseStore` satisfies it structurally. */
export type GatewayEndpointRowStore = {
  /** The writer's role, from the same `user_roles` table `requireAdmin` consults. */
  member: (userId: string) => Promise<{
    role: "admin" | "user";
    groups: readonly string[];
  }>;
  readGatewayEndpointRow: () => Promise<StoredGatewayEndpoint>;
  writeGatewayEndpointRow: (
    settings: GatewayEndpointSettings,
    by: string,
  ) => Promise<GatewayEndpointConfig>;
};

export type SaveGatewayEndpointResult =
  | { ok: true; config: GatewayEndpointConfig }
  | { ok: false; status: 400 | 403 | 503; error: string };

export type GatewayEndpointService = {
  /**
   * Save the gateway endpoint as an administrator. Refused (403) for anybody else, with the role
   * read through the store rather than taken on trust — the seam 01.8's routes sit on, and the one
   * a script or a future caller cannot talk past. A role that cannot be read refuses (503) rather
   * than skips the check: fail closed, the same sentence every enterprise control uses.
   */
  saveGatewayEndpoint: (
    input: unknown,
    by: { userId: string; email: string },
  ) => Promise<SaveGatewayEndpointResult>;
  /**
   * The current configuration: the saved row when there is one, the environment default at
   * version 0 when there is not, undefined when the deployment has none — and undefined for a
   * row that exists but does not validate, which reads as unconfigured rather than switching to
   * the environment's address. Carries no credential field — there is none to carry.
   */
  readGatewayEndpoint: () => Promise<GatewayEndpointConfig | undefined>;
};

export function createGatewayEndpointService(options: {
  store: GatewayEndpointRowStore;
  envDefault?: GatewayEndpointConfig;
}): GatewayEndpointService {
  const { store, envDefault } = options;
  return {
    async saveGatewayEndpoint(input, by) {
      const validated = validateGatewayEndpointInput(input);
      if (!validated.ok) {
        return { ok: false, status: 400, error: validated.error };
      }
      let role: "admin" | "user";
      try {
        role = (await store.member(by.userId)).role;
      } catch (error) {
        log.error(
          { type: "gateway-endpoint-role-check-failed", error: String(error) },
          "gateway-endpoint-role-check-failed",
        );
        return {
          ok: false,
          status: 503,
          error:
            "Your role could not be checked, so the gateway configuration was not changed.",
        };
      }
      if (role !== "admin") {
        return {
          ok: false,
          status: 403,
          error: "Only an administrator may change the gateway configuration.",
        };
      }
      const config = await store.writeGatewayEndpointRow(
        validated.settings,
        by.email,
      );
      return { ok: true, config };
    },
    async readGatewayEndpoint() {
      const stored = await store.readGatewayEndpointRow();
      if (stored.state === "configured") return stored.config;
      if (stored.state === "corrupted") {
        log.warn(
          "The stored gateway endpoint configuration is present but does not validate, so it reads as unconfigured rather than falling back to the environment's address. An administrator must re-save it.",
        );
        return undefined;
      }
      return envDefault;
    },
  };
}

/**
 * The running gateway endpoint service, resolved through the installed enterprise controls so the
 * downstream consumers (01.5's probe, 01.7's readiness gate) need no wiring of their own: one
 * call reads the current configuration and its configVersion. Undefined in a test or script that
 * never installed the controls — the same answer `enterpriseControls()` gives, for the same
 * reason.
 */
export function gatewayEndpointControls(): GatewayEndpointService | undefined {
  const controls = enterpriseControls();
  if (!controls) return undefined;
  return createGatewayEndpointService({
    store: controls.store,
    envDefault: gatewayEnvDefaultConfig(controls.deps.env ?? process.env),
  });
}
