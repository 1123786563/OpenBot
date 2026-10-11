export const ENTERPRISE_TEST_DATABASE = "openbot_enterprise_r2_codex_20261009";
const TEST_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const ROLE_DATABASE_VARIABLES = {
  directory: "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
  data: "ENTERPRISE_TEST_DATA_DATABASE_URL",
  operator: "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
} as const;

export type EnterpriseRuntimeRole = keyof typeof ROLE_DATABASE_VARIABLES;

// Runtime LOGIN roles are each granted exactly one NOLOGIN capability role. The PostgreSQL
// startup option switches current_user to that capability while session_user remains the login.
// The capability verifier rejects the login role if it has any second membership.

/** The setup URL is separate from TEST_DATABASE_URL and reserved for the isolated enterprise DB. */
export function enterpriseTestDatabaseUrlFrom(
  environment: Record<string, string | undefined> = process.env,
): string {
  return validateEnterpriseUrl(
    environment.ENTERPRISE_TEST_SETUP_DATABASE_URL,
    "ENTERPRISE_TEST_SETUP_DATABASE_URL",
  );
}

export function enterpriseRuntimeDatabaseUrlFrom(
  role: EnterpriseRuntimeRole,
  environment: Record<string, string | undefined> = process.env,
): string {
  const variable = ROLE_DATABASE_VARIABLES[role];
  const address = validateEnterpriseUrl(environment[variable], variable);
  const options = new URL(address).searchParams.get("options");
  const capability = `ob_ent_${role}`;
  if (options !== `-c role=${capability}`) {
    throw new Error(
      `${variable} must start PostgreSQL with current_user set to ${capability}.`,
    );
  }
  return address;
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
      `${variable} must be a PostgreSQL URL for the reserved isolated test database.`,
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const port = url.port === "" ? "5432" : url.port;
  if (
    !/^postgres(?:ql)?:$/.test(url.protocol) ||
    !TEST_HOSTS.has(url.hostname) ||
    port !== "5434" ||
    database !== ENTERPRISE_TEST_DATABASE
  ) {
    throw new Error(
      `${variable} must target the controller-reserved PostgreSQL test database on localhost:5434.`,
    );
  }
  return raw;
}
