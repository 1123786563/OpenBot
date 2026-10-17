/**
 * Configuration and privacy compliance for the self-hosted Hindsight service.
 *
 * OpenBot stays the authority for memory review, permissions, and deletion; this module only
 * describes how this deployment reaches its private Hindsight instance and how that instance's
 * privacy posture is declared. The declaration lives in the environment because that is where
 * Hindsight itself reads configuration from (see deploy/hindsight/hindsight.env, which feeds the
 * container the matching HINDSIGHT_API_* values).
 *
 * The privacy rules pinned here come from the Hindsight personal-memory spec and ADR 0005:
 * model calls carrying content must not be traced, terminal operation payloads (which can
 * contain memory text) are kept at most one day, and controlled backups are kept at least one
 * and at most thirty days (a zero-day backup window is rejected — see MIN_BACKUP_RETENTION_DAYS).
 * A deployment that has not declared these explicitly is treated as noncompliant, never as
 * "probably fine".
 */

/** The privacy posture as declared in the environment; null means "not declared". */
export type HindsightPrivacy = {
  /** HINDSIGHT_API_LLM_TRACE_ENABLED on the Hindsight side. Must be false. */
  llmTraceEnabled: boolean | null;
  /** HINDSIGHT_API_OPERATION_RETENTION_DAYS on the Hindsight side. At most 1. */
  operationRetentionDays: number | null;
  /** Retention of controlled backups of the Hindsight database. At least 1, at most 30. */
  backupRetentionDays: number | null;
};

/** The raw environment keys the privacy declaration is read from. */
export type HindsightPrivacyEnv = {
  HINDSIGHT_PRIVACY_LLM_TRACE_ENABLED?: string;
  HINDSIGHT_PRIVACY_OPERATION_RETENTION_DAYS?: string;
  HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS?: string;
};

export type HindsightConfig = {
  /** Base URL of the private Hindsight API, e.g. http://127.0.0.1:8888. */
  apiUrl: string;
  /** Bearer token Hindsight's ApiKeyTenantExtension checks on every request. */
  apiToken: string;
  /**
   * Base URL of the OpenBot-approved OpenAI-compatible model gateway (Bifrost). Hindsight's
   * LLM and embedding providers are pinned to this endpoint so no model call that leaves the
   * host can bypass the gateway. The URL must be a bare origin: no credentials, no path.
   */
  modelGatewayUrl: string;
  modelGatewayApiKey: string;
  /** Bank the health probe exercises. Bank choice stays internal to the memory module. */
  bankId: string;
  privacy: HindsightPrivacy;
  /** Per-request timeout for health probes, in milliseconds. */
  requestTimeoutMs: number;
};

/** Rule identifiers a compliance result reports. Values are deliberately not included. */
export type PrivacyCompliance = {
  compliant: boolean;
  violations: PrivacyViolationId[];
};

export type PrivacyViolationId =
  | "llm_trace_enabled"
  | "operation_retention_days"
  | "backup_retention_days"
  /**
   * Not a declaration rule: reported only by the health check's runtime cross-check, when the
   * running Hindsight service itself reports its llm_trace feature enabled while this deployment
   * declares llmTraceEnabled=false. The declared rules above are validated before any request is
   * made; this one is evidence about the service behind the declaration.
   */
  | "runtime_llm_trace_enabled";

/** Days a terminal operation row (payload included) may be kept. The spec pins one day. */
export const MAX_OPERATION_RETENTION_DAYS = 1;
/** Days a controlled backup may be kept. The spec pins at most thirty days. */
export const MAX_BACKUP_RETENTION_DAYS = 30;
/**
 * Floor for the backup retention declaration. Zero is noncompliant, not read as "no backups":
 * the backup job cannot honor a zero-day window (every run writes a new copy before any sweep
 * could delete), so deploy/hindsight/backup.sh refuses 0 outright and this validation rejects
 * the same 1..30 domain.
 */
export const MIN_BACKUP_RETENTION_DAYS = 1;

function parseBoolean(raw: string | undefined): boolean | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  return null;
}

function parseWholeDays(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/** Read the privacy declaration. Missing or malformed keys stay null; validation decides. */
export function parseHindsightPrivacy(
  env: HindsightPrivacyEnv,
): HindsightPrivacy {
  return {
    llmTraceEnabled: parseBoolean(env.HINDSIGHT_PRIVACY_LLM_TRACE_ENABLED),
    operationRetentionDays: parseWholeDays(
      env.HINDSIGHT_PRIVACY_OPERATION_RETENTION_DAYS,
    ),
    backupRetentionDays: parseWholeDays(
      env.HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS,
    ),
  };
}

/**
 * Check the declared posture against the spec's limits. The result names rules, not values, so a
 * compliance report can never leak configuration details it has no business echoing.
 */
export function validateHindsightPrivacy(
  privacy: HindsightPrivacy,
): PrivacyCompliance {
  const violations: PrivacyViolationId[] = [];
  if (privacy.llmTraceEnabled !== false) violations.push("llm_trace_enabled");
  if (
    privacy.operationRetentionDays === null ||
    privacy.operationRetentionDays > MAX_OPERATION_RETENTION_DAYS
  ) {
    violations.push("operation_retention_days");
  }
  if (
    privacy.backupRetentionDays === null ||
    privacy.backupRetentionDays < MIN_BACKUP_RETENTION_DAYS ||
    privacy.backupRetentionDays > MAX_BACKUP_RETENTION_DAYS
  ) {
    violations.push("backup_retention_days");
  }
  return { compliant: violations.length === 0, violations };
}

/** Accept only a bare http(s) origin: scheme and host, no credentials, path, or query. */
function bareOrigin(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const raw = env[name]?.trim();
  if (!raw) {
    throw new Error(`${name} is required and is not configured.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `${name} must be a valid http(s) URL, got a value that is not a URL.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not carry credentials in the URL.`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(
      `${name} must be a bare origin: no path, query, or fragment.`,
    );
  }
  return parsed.origin;
}

function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required and is not configured.`);
  }
  return value;
}

/**
 * Load the Hindsight connection and privacy configuration from the environment, throwing with
 * the offending variable name on a misconfigured declaration. Honest scope, as of this ticket:
 * nothing in the server runtime calls this yet — the only callers are the test suite and the
 * manual deploy/hindsight/test/verify-health.ts script. Wiring this loader (and the health
 * check) into server startup or an inspection endpoint is future work (ticket #393, the admin
 * view); until that lands, this module serves deployment verification and tests and does not
 * by itself make the server fail loudly at startup.
 */
export function loadHindsightConfig(
  env: Record<string, string | undefined> = process.env,
): HindsightConfig {
  const config: HindsightConfig = {
    apiUrl: bareOrigin(env, "HINDSIGHT_API_URL"),
    apiToken: required(env, "HINDSIGHT_API_TOKEN"),
    modelGatewayUrl: bareOrigin(env, "HINDSIGHT_MODEL_GATEWAY_URL"),
    modelGatewayApiKey: required(env, "HINDSIGHT_MODEL_GATEWAY_API_KEY"),
    bankId: env.HINDSIGHT_BANK_ID?.trim() || "default",
    privacy: parseHindsightPrivacy(env),
    requestTimeoutMs: Number(env.HINDSIGHT_REQUEST_TIMEOUT_MS ?? 5000),
  };
  if (
    !Number.isFinite(config.requestTimeoutMs) ||
    config.requestTimeoutMs <= 0
  ) {
    throw new Error(
      "HINDSIGHT_REQUEST_TIMEOUT_MS must be a positive number of milliseconds.",
    );
  }
  return config;
}
