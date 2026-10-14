export const ENTERPRISE_CAPABILITY_ROLES = new Set([
  "ob_ent_directory",
  "ob_ent_data",
  "ob_ent_operator",
  "ob_ent_identity_operator",
]);

export interface SetupDatabaseIdentity {
  database_name: string;
  current_user: string;
  session_user: string;
  setup_has_bypass: boolean;
  public_schema_is_empty: boolean;
}

/**
 * Validates the session identity and freshness before the setup-only migration.
 * PostgreSQL's reported listening port is intentionally not part of this check:
 * a container can expose host port 5434 while PostgreSQL listens on 5432 inside.
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
      "Refusing migration: TEST_DATABASE_URL is not the fresh setup-only database reserved for this enterprise test run.",
    );
  }
}
