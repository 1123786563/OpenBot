import {
  enterpriseCapabilityName,
  type EnterpriseRuntimeRole,
} from "../../scripts/enterprise-test-db-guard";

const TEST_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const ROLE_DATABASE_VARIABLES: Record<EnterpriseRuntimeRole, string> = {
  directory: "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
  data: "ENTERPRISE_TEST_DATA_DATABASE_URL",
  operator: "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
};
export type { EnterpriseRuntimeRole };

// Runtime LOGIN roles are each granted exactly one NOLOGIN capability role. The PostgreSQL
// startup option switches current_user to that capability while session_user remains the login.
// The capability verifier rejects the login role if it has any second membership.

/*
 * The URLs come from the environment, never from constants: CI points them at its disposable
 * service container and a developer points them at the official enterprise test database (the
 * one-off `openbot-enterprise-test-pg` container on 127.0.0.1:5435 is the local one). What the
 * validator enforces is what makes the setup-only migration safe, not which instance it runs on:
 * loopback only, an enterprise test database name, and never the live application database.
 * Runtime role URLs may carry only the login; this helper pins the exact session-role startup
 * option because the capability verifier requires it.
 */

/**
 * Which env variable won the setup-URL lookup. Exported so scripts that need
 * the variable label for their own refusals (enterprise-test-db.ts) derive it
 * from the same rule as the URL itself instead of re-implementing the
 * precedence and drifting apart.
 */
export function enterpriseSetupDatabaseVariable(
  environment: Record<string, string | undefined> = process.env,
): "ENTERPRISE_TEST_SETUP_DATABASE_URL" | "TEST_DATABASE_URL" {
  return environment.ENTERPRISE_TEST_SETUP_DATABASE_URL?.trim()
    ? "ENTERPRISE_TEST_SETUP_DATABASE_URL"
    : "TEST_DATABASE_URL";
}

/**
 * The dedicated setup URL wins when CI pins a disposable database. A developer's official
 * `TEST_DATABASE_URL` (for example 127.0.0.1:5435/openbot_enterprise_test) is accepted as-is,
 * so the enterprise suite runs against the URL already present in `.env`.
 */
export function enterpriseTestDatabaseUrlFrom(
  environment: Record<string, string | undefined> = process.env,
): string {
  const variable = enterpriseSetupDatabaseVariable(environment);
  const raw =
    variable === "ENTERPRISE_TEST_SETUP_DATABASE_URL"
      ? environment.ENTERPRISE_TEST_SETUP_DATABASE_URL
      : environment.TEST_DATABASE_URL;
  if (!raw?.trim()) {
    throw new Error(
      "ENTERPRISE_TEST_SETUP_DATABASE_URL or TEST_DATABASE_URL is required for enterprise tests.",
    );
  }
  return validateEnterpriseUrl(raw, variable);
}

export function enterpriseRuntimeDatabaseUrlFrom(
  role: EnterpriseRuntimeRole,
  environment: Record<string, string | undefined> = process.env,
): string {
  const variable = ROLE_DATABASE_VARIABLES[role];
  const address = validateEnterpriseUrl(environment[variable], variable);
  const url = new URL(address);
  const setupUrl = new URL(enterpriseTestDatabaseUrlFrom(environment));
  // Compare decoded database names, not raw pathnames: an escaped
  // spelling ("%5F") of the same database passes validateEnterpriseUrl but
  // would not match a raw pathname comparison.
  const databaseOf = (candidate: URL) =>
    enterpriseTestDatabaseNameFrom(candidate.href);
  if (
    endpointOf(url) !== endpointOf(setupUrl) ||
    databaseOf(url) !== databaseOf(setupUrl)
  ) {
    throw new Error(
      `${variable} must point at the same PostgreSQL instance and database as the setup URL.`,
    );
  }
  const capability = enterpriseCapabilityName(role);
  const option = `-c role=${capability}`;
  const options = url.searchParams.getAll("options");
  if (options.length > 0) {
    if (options.length !== 1 || options[0] !== option) {
      throw new Error(
        `${variable} must start PostgreSQL with current_user set to ${capability}.`,
      );
    }
    // searchParams decodes "+" as a space, so the comparison above passes for
    // a "+":spelled option that libpq would read literally and reject late.
    // Every repeated options segment is scanned: a "+" in a later segment must
    // refuse the URL exactly like one in the first.
    const rawOptions = [...url.search.matchAll(/[?&]options=([^&]*)/g)]
      .map((match) => match[1])
      .join("&");
    if (rawOptions.includes("+")) {
      throw new Error(
        `${variable} spells its options with a literal "+", which libpq reads literally; percent-encode the space as %20.`,
      );
    }
    return address;
  }
  // Not URL.searchParams: it form-encodes the space as "+", which libpq reads
  // literally. Hand-concatenation with percent-encoding is the correct wire
  // format; the if/else chain keeps a trailing empty query from producing "?&".
  let separator = "?";
  if (/[?&]$/.test(address)) separator = "";
  else if (address.includes("?")) separator = "&";
  return `${address}${separator}options=${encodeURIComponent(option)}`;
}

/**
 * The database name an enterprise test URL points at. `variable` names the
 * environment variable the URL came from, when known, so refusals carry the
 * same context as every other validation error in this file.
 */
export function enterpriseTestDatabaseNameFrom(
  address: string,
  variable?: string,
): string {
  const pathname = new URL(address).pathname
    .replace(/^\//, "")
    .replace(/\/+$/, "");
  // Decode before the single-segment check: an encoded slash ("%2F") passes a raw
  // pathname check but still names a multi-segment database.
  const refuse = (reason: string): never => {
    const sanitizedUrl = new URL(address);
    sanitizedUrl.username = "";
    sanitizedUrl.password = "";
    throw new Error(
      `${variable ? `${variable}: ` : ""}Enterprise test URL "${sanitizedUrl.href}" ${reason}`,
    );
  };
  let database: string;
  try {
    database = decodeURIComponent(pathname);
  } catch {
    return refuse("has invalid percent-encoding in its database name.");
  }
  if (database.includes("/")) {
    return refuse("must name the database as a single path segment.");
  }
  return database;
}

// Derived from TEST_HOSTS so a future host alias normalizes the moment the
// validator accepts it, instead of the two sets drifting apart.
const LOOPBACK_ALIASES = new Set(
  [...TEST_HOSTS].filter((host) => host !== "127.0.0.1"),
);

function endpointOf(candidate: URL): string {
  // The TEST_HOSTS spellings MAY name different sockets (a dual-stack machine
  // can run separate instances on 127.0.0.1 and [::1]), but legitimate configs
  // mix them for the same instance, so they are treated as aliases: the rare
  // false-same is traded for not rejecting valid localhost/127.0.0.1 mixes.
  const host = LOOPBACK_ALIASES.has(candidate.hostname)
    ? "127.0.0.1"
    : candidate.hostname;
  return `${host}:${candidate.port || "5432"}`;
}

function validateEnterpriseUrl(
  raw: string | undefined,
  variable: string,
): string {
  if (!raw?.trim())
    throw new Error(`${variable} is required for isolated enterprise tests.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `${variable} must be a PostgreSQL URL for an enterprise test database.`,
    );
  }
  const database = enterpriseTestDatabaseNameFrom(raw, variable);
  if (
    !/^postgres(?:ql)?:$/.test(url.protocol) ||
    !TEST_HOSTS.has(url.hostname) ||
    !database
  ) {
    throw new Error(
      `${variable} must be a loopback PostgreSQL URL naming an enterprise test database.`,
    );
  }
  if (!/^openbot_enterprise_/.test(database)) {
    throw new Error(
      `${variable} must name an openbot_enterprise_* test database, not "${database}".`,
    );
  }
  if (url.hash) {
    throw new Error(`${variable} must not include a URL fragment.`);
  }
  return raw.trim();
}
