/**
 * The standalone enterprise entry's configuration, per plan 02 §7 T3-B step 4.
 *
 * The legacy `loadConfig` builds a whole deployment — Intelligence runtime, transcription, managed
 * agent and all — because the legacy server is one process. The enterprise entry is not: it
 * authenticates people, resolves their tenancy scope and reads authorized resource metadata, and
 * it must boot with NOTHING else configured. So this loader reads only identity + its own
 * enterprise settings, reuses the identity parsing (`loadIdentityConfig`) and the key format
 * validation (`keyEncryptionKey`) from server/src/config.ts rather than growing a second copy of
 * either, and refuses everything the plan refuses:
 *
 *   - development identities (OPENBOT_SINGLE_USER, OPENBOT_DEV_NO_AUTH) — there is no single-user
 *     back door into a multi-tenant API;
 *   - sign-in missing entirely — authentication is not optional here, so it stops the boot;
 *   - three database URLs that do not name ONE database through THREE different login roles —
 *     same database is the deployment boundary, different roles are the least privilege;
 *   - an auth-route selection outside the compiled profile in auth-route-profile.ts, or missing
 *     its required routes — the allowlist cannot be widened from the environment;
 *   - allowedOrigins that are not exact origins — no wildcard CORS;
 *   - a port or shutdown window that is not a bounded whole number.
 *
 * The loader parses only. No connection is opened and no URL is ever logged: the database URLs
 * carry credentials, and an error message that repeated one would put them in a log an operator
 * reads. Role attributes themselves (NOSUPERUSER, no owner membership…) are live questions the
 * bootstrap answers against the database before listening; here the usernames merely have to be
 * three distinct non-empty roles, matching the DBA contract in server/ops/enterprise/roles.sql.
 */
import {
  type AuthConfig,
  loadIdentityConfig,
  keyEncryptionKey as readKeyEncryptionKey,
} from "../config";
import {
  APPROVED_AUTH_ROUTES,
  canonicalAuthRoute,
  REQUIRED_AUTH_ROUTES,
} from "./auth-route-profile";

/** What a redacted security log line carries; assembled by the bootstrap, never from a request. */
export type RedactedSecurityError = {
  requestId: string;
  status: number;
  code: string;
};

type EnterpriseEnvironment = Record<string, string | undefined>;

/**
 * Refuse the deployment-wide development identities on the enterprise entry.
 *
 * `OPENBOT_SINGLE_USER` admits every request as one administrator with no sign-in, and a
 * development no-auth flag does the same job under a plainer name; either one turns a multi-tenant
 * boundary into a single back door. An explicit off ("0"/"false", any case) is accepted so an
 * environment file shared with the legacy deployment does not have to be forked.
 */
export function assertNoDevelopmentIdentity(
  env: Record<string, string | undefined>,
): void {
  for (const key of ["OPENBOT_SINGLE_USER", "OPENBOT_DEV_NO_AUTH"]) {
    const value = env[key]?.trim().toLowerCase();
    if (value && value !== "0" && value !== "false") {
      throw new Error(`${key} forbidden in enterprise entry`);
    }
  }
}

/**
 * Choose the forwarded auth routes from the compiled profile only.
 *
 * `selected` is deliberately `unknown`: it arrives from the environment (ENTERPRISE_AUTH_ROUTES,
 * a JSON array), and this function is the one place that decides it is an array of canonical
 * strings inside `compiled`. Anything else — not an array, empty, a non-string, a route the
 * profile never approved, or a route in non-canonical form — is INVALID_AUTH_ROUTE_SELECTION, so
 * the failure is at boot where somebody is looking rather than at somebody's first sign-in.
 */
export function selectAuthRoutes(
  selected: unknown,
  compiled: ReadonlySet<string>,
): ReadonlySet<string> {
  if (
    !Array.isArray(selected) ||
    selected.length === 0 ||
    selected.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("INVALID_AUTH_ROUTE_SELECTION");
  }

  const chosen = new Set<string>();
  for (const entry of selected as string[]) {
    const canonical = canonicalAuthRoute(entry);
    if (canonical === null || !compiled.has(canonical)) {
      throw new Error("INVALID_AUTH_ROUTE_SELECTION");
    }
    chosen.add(canonical);
  }
  return chosen;
}

export type EnterpriseConfig = {
  /** The port the enterprise API listens on. */
  port: number;
  /** The address it binds; loopback unless an operator says otherwise. */
  hostname: string;
  /** Sign-in, resolved by the same rules as the legacy deployment (loadIdentityConfig). */
  auth: AuthConfig;
  /** The existing format-validated key, reused from config.ts — not a second algorithm. */
  keyEncryptionKey: string;
  /** The restricted identity login (Better Auth tables only). */
  authDatabaseUrl: string;
  /** The restricted directory login (principal/membership/tenant reads). */
  directoryDatabaseUrl: string;
  /** The restricted business-data login (workspace/resource/grant reads). */
  dataDatabaseUrl: string;
  /** Exact origins allowed to issue write requests; no wildcard CORS, ever. */
  allowedOrigins: ReadonlySet<string>;
  /** Exact `METHOD pathname` forwards into the auth handler; a subset of the compiled profile. */
  authRoutes: ReadonlySet<string>;
  /** How long shutdown waits for in-flight requests before the hard stop. */
  shutdownGraceMs: number;
};

function required(env: EnterpriseEnvironment, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

function optional(
  env: EnterpriseEnvironment,
  name: string,
): string | undefined {
  return env[name]?.trim() || undefined;
}

/**
 * A whole number between `min` and `max`, refused rather than coerced.
 *
 * A shutdown window of `soon` or a port of `30o1` is a typo somebody has to see at boot, not a
 * value to round; and "bounded" is part of the contract, so the grace period cannot be configured
 * past every deployment's termination budget either.
 */
function boundedInteger(
  env: EnterpriseEnvironment,
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

type ParsedDatabaseUrl = {
  url: string;
  username: string;
  database: string;
};

/** Parse one database URL, keeping the raw string for later use and nothing else out of it. */
function parseDatabaseUrl(name: string, raw: string): ParsedDatabaseUrl {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${name} must be a PostgreSQL URL`);
  }
  if (!parsed.username) {
    throw new Error(`${name} must name the login role in its userinfo`);
  }
  const database = parsed.pathname.replace(/^\//, "");
  if (!database) {
    throw new Error(`${name} must name a database`);
  }
  // The port default is normalized away by URL parsing, so :5432 and no port agree.
  return {
    url: raw,
    username: decodeURIComponent(parsed.username),
    database: `${parsed.protocol}//${parsed.host}/${database}`,
  };
}

function databaseUrls(env: EnterpriseEnvironment): {
  authDatabaseUrl: string;
  directoryDatabaseUrl: string;
  dataDatabaseUrl: string;
} {
  const auth = parseDatabaseUrl(
    "ENTERPRISE_AUTH_DATABASE_URL",
    required(env, "ENTERPRISE_AUTH_DATABASE_URL"),
  );
  const directory = parseDatabaseUrl(
    "ENTERPRISE_DIRECTORY_DATABASE_URL",
    required(env, "ENTERPRISE_DIRECTORY_DATABASE_URL"),
  );
  const data = parseDatabaseUrl(
    "ENTERPRISE_DATA_DATABASE_URL",
    required(env, "ENTERPRISE_DATA_DATABASE_URL"),
  );

  const targets = [auth, directory, data];
  const databases = new Set(targets.map((target) => target.database));
  if (databases.size !== 1) {
    throw new Error(
      "ENTERPRISE_AUTH_DATABASE_URL, ENTERPRISE_DIRECTORY_DATABASE_URL and ENTERPRISE_DATA_DATABASE_URL must point at one approved database",
    );
  }

  const roles = new Set(targets.map((target) => target.username));
  if (roles.size !== targets.length) {
    throw new Error(
      "the three enterprise database URLs must use distinct login roles (auth, directory, data)",
    );
  }

  return {
    authDatabaseUrl: auth.url,
    directoryDatabaseUrl: directory.url,
    dataDatabaseUrl: data.url,
  };
}

/**
 * Exact origins only. A URL whose string does not equal its own origin — one carrying a path, a
 * query, a trailing slash, a wildcard host or a bare host with no scheme — is refused, because
 * `allowedOrigins` is compared against the browser's Origin header verbatim and anything looser
 * here is a CORS wildcard wearing punctuation.
 */
function allowedOrigins(env: EnterpriseEnvironment): ReadonlySet<string> {
  const raw = optional(env, "ENTERPRISE_ALLOWED_ORIGINS");
  if (!raw) {
    throw new Error(
      "ENTERPRISE_ALLOWED_ORIGINS must name at least one exact origin the web app is served from",
    );
  }

  const origins = new Set<string>();
  for (const candidate of raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (candidate.includes("*")) {
      throw new Error(
        `ENTERPRISE_ALLOWED_ORIGINS must be exact origins, not ${candidate}`,
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error(
        `ENTERPRISE_ALLOWED_ORIGINS must be exact origins, not ${candidate}`,
      );
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      candidate !== parsed.origin ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(
        `ENTERPRISE_ALLOWED_ORIGINS must be exact origins, not ${candidate}`,
      );
    }
    origins.add(parsed.origin);
  }
  if (origins.size === 0) {
    throw new Error(
      "ENTERPRISE_ALLOWED_ORIGINS must name at least one exact origin the web app is served from",
    );
  }
  return origins;
}

function authRoutes(env: EnterpriseEnvironment): ReadonlySet<string> {
  const raw = required(env, "ENTERPRISE_AUTH_ROUTES");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "ENTERPRISE_AUTH_ROUTES must be a JSON array of approved `METHOD pathname` strings",
    );
  }

  const chosen = selectAuthRoutes(parsed, APPROVED_AUTH_ROUTES);
  const missing = [...REQUIRED_AUTH_ROUTES].filter(
    (route) => !chosen.has(route),
  );
  if (missing.length > 0) {
    throw new Error(
      `ENTERPRISE_AUTH_ROUTES must include the required routes: ${missing.join(", ")}`,
    );
  }
  return chosen;
}

export function loadEnterpriseConfig(
  env: EnterpriseEnvironment,
): EnterpriseConfig {
  assertNoDevelopmentIdentity(env);

  const auth = loadIdentityConfig(env);
  if (!auth) {
    throw new Error(
      "The enterprise entry requires an identity provider: configure GOOGLE_OAUTH_* (or MICROSOFT_/OKTA_/CASDOOR_OAUTH_*) with BETTER_AUTH_SECRET and BETTER_AUTH_URL, per loadIdentityConfig",
    );
  }

  return {
    port: boundedInteger(env, "ENTERPRISE_PORT", 3101, 1, 65535),
    hostname: optional(env, "ENTERPRISE_HOSTNAME") ?? "127.0.0.1",
    auth,
    keyEncryptionKey: readKeyEncryptionKey(env),
    ...databaseUrls(env),
    allowedOrigins: allowedOrigins(env),
    authRoutes: authRoutes(env),
    shutdownGraceMs: boundedInteger(
      env,
      "ENTERPRISE_SHUTDOWN_GRACE_MS",
      15000,
      1000,
      300000,
    ),
  };
}
