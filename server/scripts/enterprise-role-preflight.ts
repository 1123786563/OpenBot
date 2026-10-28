export type EnterpriseRoleCatalogRow = {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  /** pg_auth_members: the role inherits another role's privileges. */
  member_of_other_role?: boolean;
};

export const REQUIRED_ENTERPRISE_ROLES = [
  "ob_ent_directory",
  "ob_ent_data",
  "ob_ent_operator",
  "ob_ent_identity_operator",
] as const;

/**
 * The catalog query's rows, proven at runtime before any privilege decision is
 * read off them: `execute()` returns unknown, and a malformed row (NULL
 * rolname, a flag the driver handed back as a string) would otherwise silently
 * decide "safe" or "unsafe" for production RLS preconditions.
 */
export function assertEnterpriseRoleCatalogRows(
  value: unknown,
): EnterpriseRoleCatalogRow[] {
  if (!Array.isArray(value)) {
    throw new Error(
      "Enterprise role catalog query did not return a row array.",
    );
  }
  const privilegeFlags = [
    "rolcanlogin",
    "rolsuper",
    "rolbypassrls",
    "rolcreatedb",
    "rolcreaterole",
    "rolreplication",
  ] as const;
  return value.map((row, index) => {
    if (typeof row !== "object" || row === null) {
      throw new Error(`Enterprise role catalog row ${index} is not an object.`);
    }
    const record = row as Record<string, unknown>;
    if (typeof record.rolname !== "string") {
      throw new Error(
        `Enterprise role catalog row ${index} has no string rolname.`,
      );
    }
    for (const flag of privilegeFlags) {
      if (typeof record[flag] !== "boolean") {
        throw new Error(
          `Enterprise role catalog row "${record.rolname}" has a non-boolean ${flag}.`,
        );
      }
    }
    if (
      record.member_of_other_role !== undefined &&
      typeof record.member_of_other_role !== "boolean"
    ) {
      throw new Error(
        `Enterprise role catalog row "${record.rolname}" has a non-boolean member_of_other_role.`,
      );
    }
    return row as EnterpriseRoleCatalogRow;
  });
}

/** Distinguishing code so callers can branch without parsing the message. */
export class EnterpriseRolePrerequisiteError extends Error {
  readonly code = "ENTERPRISE_ROLE_PREREQUISITES_UNSAFE";
  readonly unsafeRoles: readonly string[];

  constructor(unsafeRoles: readonly string[]) {
    super(
      `ENTERPRISE_ROLE_PREREQUISITES_UNSAFE: missing or unsafe roles ${unsafeRoles.join(", ")}; run server/ops/enterprise/roles.sql as a direct PostgreSQL superuser before migrations.`,
    );
    this.name = "EnterpriseRolePrerequisiteError";
    this.unsafeRoles = unsafeRoles;
  }
}

export function assertEnterpriseRolePreconditions(
  rows: readonly EnterpriseRoleCatalogRow[],
): void {
  const byName = new Map(rows.map((row) => [row.rolname, row]));
  const unsafe = REQUIRED_ENTERPRISE_ROLES.filter((name) => {
    const role = byName.get(name);
    return (
      !role ||
      role.rolcanlogin ||
      role.rolsuper ||
      role.rolbypassrls ||
      role.rolcreatedb ||
      role.rolcreaterole ||
      role.rolreplication ||
      // Same invariant roles.sql enforces: a capability role must not inherit
      // another role, or a later GRANT silently hands it superuser reach.
      role.member_of_other_role === true
    );
  });

  if (unsafe.length > 0) {
    throw new EnterpriseRolePrerequisiteError(unsafe);
  }
}
