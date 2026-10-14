/**
 * The runtime LOGIN roles, single-sourced here so the provisioning script and
 * the test support module cannot drift: ROLE_DATABASE_VARIABLES in
 * tests/support is a Record over this union, and the capability names below
 * follow it one-to-one (plus the identity operator, which has no login URL).
 */
export type EnterpriseRuntimeRole = "directory" | "data" | "operator";

export const ENTERPRISE_CAPABILITY_ROLES = new Set([
  "ob_ent_directory",
  "ob_ent_data",
  "ob_ent_operator",
  "ob_ent_identity_operator",
]);

/**
 * The single spelling of the runtime LOGIN capability convention: the
 * provisioning script grants it and the runtime URL validator demands it,
 * so both derive the name here rather than re-splicing the prefix.
 */
export function enterpriseCapabilityName(role: EnterpriseRuntimeRole): string {
  return `ob_ent_${role}`;
}

const LOGIN_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const LOGIN_PASSWORD = /^[\x21-\x5b\x5d-\x7e]+$/;

export interface ParsedRuntimeTestLogin {
  role: EnterpriseRuntimeRole;
  capability: string;
  name: string;
  password: string;
}

/**
 * Environment validation for one runtime test login URL: existence, URL
 * shape, identifier and ent* prefix, cross-role login-name dedup (each
 * accepted name is recorded into the caller's seenLoginNames set), and
 * password charset. Environment-injected so tests can lock the rules that
 * gate cluster-wide ALTER ROLE.
 */
/** One row of pg_roles privilege flags, shared by the migrate-mode precheck and
 * the provisioning transaction so their rejection criteria cannot drift apart. */
export interface PgRolePrivilegeFlags {
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
}

export function parseRuntimeTestLogin(
  role: EnterpriseRuntimeRole,
  variable: string,
  environment: Record<string, string | undefined>,
  seenLoginNames: Set<string>,
): ParsedRuntimeTestLogin {
  const raw = environment[variable]?.trim();
  if (!raw) {
    throw new Error(
      `${variable} must name the restricted test login this sub-command provisions`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${variable} must be a valid PostgreSQL URL`);
  }
  let name: string;
  let password: string;
  try {
    name = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    throw new Error(
      `${variable} carries invalid percent-encoding in its userinfo`,
    );
  }
  if (!LOGIN_IDENTIFIER.test(name)) {
    throw new Error(
      `${variable} must carry a plain lowercase role name as its userinfo`,
    );
  }
  // PostgreSQL roles are cluster-wide: an ALTER on an ordinary shared
  // name would reset that login everywhere, so only test-scoped ent*
  // logins (CI's enterprise_*_login, a developer's ent_*) may pass.
  if (!/^ent/.test(name)) {
    throw new Error(
      `${variable} must name an ent*-prefixed test login, not the ordinary role "${name}" (an existing role would be reset cluster-wide).`,
    );
  }
  // Two role URLs naming the same login would GRANT that login two
  // capabilities; reject it here instead of deferring to the runtime
  // capability verifier, whose error would not point at the env duplicate.
  if (seenLoginNames.has(name)) {
    throw new Error(
      `${variable} reuses login "${name}" already provisioned for another role; each role must use a distinct test login.`,
    );
  }
  seenLoginNames.add(name);
  if (!password) {
    throw new Error(
      `${variable} must carry the test login's password in its userinfo`,
    );
  }
  if (!LOGIN_PASSWORD.test(password)) {
    throw new Error(
      `${variable} must carry a printable ASCII password without a space or backslash`,
    );
  }
  return { role, capability: enterpriseCapabilityName(role), name, password };
}

export interface SetupDatabaseIdentity {
  database_name: string;
  current_user: string;
  session_user: string;
  setup_has_bypass: boolean;
  setup_is_superuser: boolean;
  public_schema_is_empty: boolean;
}

/**
 * Validates the session identity and freshness before the setup-only migration.
 * PostgreSQL's reported listening port is intentionally not part of this check:
 * a container can expose one host port while PostgreSQL listens on 5432 inside.
 *
 * The superuser requirement is deliberately NOT enforced here: it lives on
 * the migrate/provision caller, which MUST inspect `setup_is_superuser` on
 * the returned identity before consuming the one-shot migration.
 */
export function assertFreshSetupDatabaseIdentity(
  identity: SetupDatabaseIdentity | undefined,
  expectedDatabase: string,
): asserts identity is SetupDatabaseIdentity {
  if (
    !identity ||
    identity.database_name !== expectedDatabase ||
    identity.session_user !== identity.current_user ||
    ENTERPRISE_CAPABILITY_ROLES.has(identity.current_user) ||
    !identity.setup_has_bypass ||
    !identity.public_schema_is_empty
  ) {
    throw new Error(
      "Refusing migration: the enterprise setup URL is not the fresh setup-only database reserved for this enterprise test run.",
    );
  }
}
