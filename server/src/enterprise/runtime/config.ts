/**
 * The enterprise runtime candidate's configuration, per the R1–R4 integration plan.
 *
 * The whole runtime candidate is OPTIONAL: with none of the ENTERPRISE_RUNTIME_* keys set the
 * entry boots exactly as before and mounts nothing. With ANY of them set the block is enabled and
 * every required key must be present — a half-configured runtime is a boot failure somebody has
 * to see, not a runtime that silently answers 503 for reasons nobody wrote down.
 *
 * Two of the keys are database URLs, and they join the three the entry already opens: the runs
 * business path (ob_ent_run_writer — threads/runs/reservations, owner-pinned) and the runtime
 * internal path (ob_ent_runtime_writer — attempts/capabilities/events, pinned to one bound run).
 * Both must point at the SAME database as the auth/directory/data logins; the loader's one-database
 * rule in ../config.ts enforces that alongside its own three.
 *
 * Nothing here opens a pool or dials a URL: this module only parses and refuses, in the stable-code
 * style of ../config.ts (no credential value is ever repeated into an error message).
 */

/** One governed tool the Go runtime may call through the tool plane, version pinned. */
export type GovernedToolRef = {
  name: string;
  installationVersion: string;
};

export type EnterpriseRuntimeConfig = {
  /** The deployment-shared service credential both directions present. */
  serviceCredential: string;
  /** The Go service's identity, recorded on capability rows. */
  serviceId: string;
  /** Full URL of the Go execution endpoint (SSE). */
  executionUrl: string;
  /** Full URL of the Go cancel endpoint. */
  cancelUrl: string;
  /** The runs business login (ob_ent_run_writer) the gateway writes through. */
  runWriterDatabaseUrl: string;
  /** The runtime internal login (ob_ent_runtime_writer) for attempts/capabilities/events. */
  runtimeWriterDatabaseUrl: string;
  /** OpenAI-compatible model endpoint the Go service dials (mirrored for provisioning/runbook). */
  modelBaseUrl: string;
  modelAlias: string;
  modelCredential?: string;
  /** The model route this deployment pins runs to; Go refuses any other value. */
  modelRouteRef: string;
  /** The one expert version this candidate serves, and its instruction file (release digest). */
  expertVersion: string;
  expertInstructionPath: string;
  /** Tools the Go service may call; every entry version-pinned. */
  governedTools: ReadonlyArray<GovernedToolRef>;
  /** The per-run budget reservation cap. */
  budgetCapMicros: number;
  budgetCurrency: string;
  /** How long an attempt lease is held before it can be fenced off. */
  leaseTtlMs: number;
  /** How long a minted capability verifies. */
  capabilityTtlMs: number;
};

type Environment = Record<string, string | undefined>;

const ENV_KEYS = {
  serviceCredential: "ENTERPRISE_RUNTIME_SERVICE_CREDENTIAL",
  serviceId: "ENTERPRISE_RUNTIME_SERVICE_ID",
  executionUrl: "ENTERPRISE_RUNTIME_EXECUTION_URL",
  cancelUrl: "ENTERPRISE_RUNTIME_CANCEL_URL",
  runWriterDatabaseUrl: "ENTERPRISE_RUNTIME_RUN_WRITER_DATABASE_URL",
  runtimeWriterDatabaseUrl: "ENTERPRISE_RUNTIME_RUNTIME_WRITER_DATABASE_URL",
  modelBaseUrl: "ENTERPRISE_RUNTIME_MODEL_BASE_URL",
  modelAlias: "ENTERPRISE_RUNTIME_MODEL_ALIAS",
  modelCredential: "ENTERPRISE_RUNTIME_MODEL_CREDENTIAL",
  modelRouteRef: "ENTERPRISE_RUNTIME_MODEL_ROUTE_REF",
  expert: "ENTERPRISE_RUNTIME_EXPERT",
  governedTools: "ENTERPRISE_RUNTIME_GOVERNED_TOOLS",
  budgetCapMicros: "ENTERPRISE_RUNTIME_BUDGET_CAP_MICROS",
  budgetCurrency: "ENTERPRISE_RUNTIME_BUDGET_CURRENCY",
  leaseTtlMs: "ENTERPRISE_RUNTIME_LEASE_TTL_MS",
  capabilityTtlMs: "ENTERPRISE_RUNTIME_CAPABILITY_TTL_MS",
} as const;

function optional(env: Environment, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

function required(env: Environment, name: string): string {
  const value = optional(env, name);
  if (value === undefined) {
    throw new Error(`${name} must be configured when the enterprise runtime is enabled`);
  }
  return value;
}

function boundedInteger(
  env: Environment,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}`);
  }
  return value;
}

/** An absolute http(s) URL with a path; the runtime dials it verbatim, so anything else is a typo. */
function httpUrl(name: string, raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(`${name} must be an absolute http(s) URL without credentials`);
  }
  return raw;
}

/** A PostgreSQL URL naming its login role, reusing the entry's one-database rule downstream. */
function databaseUrl(name: string, raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !parsed.username
  ) {
    throw new Error(`${name} must be a PostgreSQL URL naming its login role`);
  }
  return raw;
}

/** `version=path`, exactly one expert: the candidate serves a single frozen expert version. */
function expert(env: Environment): { version: string; instructionPath: string } {
  const raw = required(env, ENV_KEYS.expert);
  const separator = raw.indexOf("=");
  if (separator <= 0 || separator === raw.length - 1 || raw.indexOf("=", separator + 1) !== -1) {
    throw new Error(`${ENV_KEYS.expert} must be exactly one version=instruction-path pair`);
  }
  return {
    version: raw.slice(0, separator).trim(),
    instructionPath: raw.slice(separator + 1).trim(),
  };
}

/** `name=installationVersion` pairs, comma separated; duplicates by name are a boot failure. */
function governedTools(env: Environment): ReadonlyArray<GovernedToolRef> {
  const raw = optional(env, ENV_KEYS.governedTools);
  if (raw === undefined) return [];
  const tools: GovernedToolRef[] = [];
  const seen = new Set<string>();
  for (const token of raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const separator = token.indexOf("=");
    if (separator <= 0 || separator === token.length - 1) {
      throw new Error(`${ENV_KEYS.governedTools} must be name=version pairs`);
    }
    const name = token.slice(0, separator);
    const installationVersion = token.slice(separator + 1);
    if (seen.has(name)) {
      throw new Error(`${ENV_KEYS.governedTools} names ${name} twice`);
    }
    seen.add(name);
    tools.push({ name, installationVersion });
  }
  return tools;
}

function currency(env: Environment): string {
  const value = optional(env, ENV_KEYS.budgetCurrency) ?? "USD";
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new Error(`${ENV_KEYS.budgetCurrency} must be a three-letter currency code`);
  }
  return value;
}

/**
 * Parse the runtime block. `undefined` means the candidate is disabled — no key was set at all.
 * Any key set without the full required set is INVALID_ENTERPRISE_RUNTIME_CONFIG, naming the
 * missing keys, so the operator reads one message instead of a 503 archaeology dig.
 */
export function enterpriseRuntimeConfig(env: Environment): EnterpriseRuntimeConfig | undefined {
  const anyKeySet = Object.values(ENV_KEYS).some((key) => optional(env, key) !== undefined);
  if (!anyKeySet) return undefined;

  const missing = (
    [
      ENV_KEYS.serviceCredential,
      ENV_KEYS.executionUrl,
      ENV_KEYS.cancelUrl,
      ENV_KEYS.runWriterDatabaseUrl,
      ENV_KEYS.runtimeWriterDatabaseUrl,
      ENV_KEYS.modelBaseUrl,
      ENV_KEYS.modelAlias,
      ENV_KEYS.modelRouteRef,
      ENV_KEYS.expert,
    ] as const
  ).filter((key) => optional(env, key) === undefined);
  if (missing.length > 0) {
    throw new Error(
      `INVALID_ENTERPRISE_RUNTIME_CONFIG: missing ${missing.join(", ")}`,
    );
  }

  return {
    serviceCredential: required(env, ENV_KEYS.serviceCredential),
    serviceId: optional(env, ENV_KEYS.serviceId) ?? "runtime-go-1",
    executionUrl: httpUrl(ENV_KEYS.executionUrl, required(env, ENV_KEYS.executionUrl)),
    cancelUrl: httpUrl(ENV_KEYS.cancelUrl, required(env, ENV_KEYS.cancelUrl)),
    runWriterDatabaseUrl: databaseUrl(
      ENV_KEYS.runWriterDatabaseUrl,
      required(env, ENV_KEYS.runWriterDatabaseUrl),
    ),
    runtimeWriterDatabaseUrl: databaseUrl(
      ENV_KEYS.runtimeWriterDatabaseUrl,
      required(env, ENV_KEYS.runtimeWriterDatabaseUrl),
    ),
    modelBaseUrl: httpUrl(ENV_KEYS.modelBaseUrl, required(env, ENV_KEYS.modelBaseUrl)),
    modelAlias: required(env, ENV_KEYS.modelAlias),
    modelCredential: optional(env, ENV_KEYS.modelCredential),
    modelRouteRef: required(env, ENV_KEYS.modelRouteRef),
    expertVersion: expert(env).version,
    expertInstructionPath: expert(env).instructionPath,
    governedTools: governedTools(env),
    budgetCapMicros: boundedInteger(env, ENV_KEYS.budgetCapMicros, 2_000_000, 1, 1e12),
    budgetCurrency: currency(env),
    leaseTtlMs: boundedInteger(env, ENV_KEYS.leaseTtlMs, 600_000, 60_000, 3_600_000),
    capabilityTtlMs: boundedInteger(
      env,
      ENV_KEYS.capabilityTtlMs,
      300_000,
      30_000,
      3_600_000,
    ),
  };
}
