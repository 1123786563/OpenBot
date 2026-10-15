import { expect, test } from "bun:test";
import {
  assertEnterpriseRolePreconditions,
  type EnterpriseRoleCatalogRow,
} from "../../scripts/enterprise-role-preflight";

const roleNames = [
  "ob_ent_directory",
  "ob_ent_data",
  "ob_ent_operator",
  "ob_ent_identity_operator",
];

function safeRows(): EnterpriseRoleCatalogRow[] {
  return roleNames.map((rolname) => ({
    rolname,
    rolcanlogin: false,
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
  }));
}

test("accepts all four present and safe capability roles", () => {
  expect(() => assertEnterpriseRolePreconditions(safeRows())).not.toThrow();
});

test("rejects a missing capability role with the DBA bootstrap action", () => {
  expect(() => assertEnterpriseRolePreconditions(safeRows().slice(1))).toThrow(
    "ENTERPRISE_ROLE_PREREQUISITES_UNSAFE",
  );
  expect(() => assertEnterpriseRolePreconditions(safeRows().slice(1))).toThrow(
    "server/ops/enterprise/roles.sql",
  );
});

test("rejects every unsafe capability-role attribute", () => {
  for (const field of [
    "rolcanlogin",
    "rolsuper",
    "rolbypassrls",
    "rolcreatedb",
    "rolcreaterole",
    "rolreplication",
  ] as const) {
    const rows = safeRows();
    rows[0]![field] = true;
    expect(() => assertEnterpriseRolePreconditions(rows)).toThrow(
      "ENTERPRISE_ROLE_PREREQUISITES_UNSAFE",
    );
  }
});
