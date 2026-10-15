export type EnterpriseRoleCatalogRow = {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
};

const REQUIRED_ENTERPRISE_ROLES = [
  "ob_ent_directory",
  "ob_ent_data",
  "ob_ent_operator",
  "ob_ent_identity_operator",
] as const;

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
      role.rolreplication
    );
  });

  if (unsafe.length > 0) {
    throw new Error(
      `ENTERPRISE_ROLE_PREREQUISITES_UNSAFE: missing or unsafe roles ${unsafe.join(", ")}; run server/ops/enterprise/roles.sql as a direct PostgreSQL superuser before migrations.`,
    );
  }
}
