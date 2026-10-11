import { expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Database } from "../../src/db/client";
import {
  assertOperatorDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";

type CatalogRow = {
  current_user_matches: boolean;
  capability_attributes_ok: boolean;
  login_attributes_ok: boolean;
  login_has_expected_capability: boolean;
  capability_has_no_escalation_membership: boolean;
  login_has_no_other_memberships: boolean;
  no_protected_ownership: boolean;
  login_has_no_enterprise_privileges: boolean;
};

function databaseWith(
  row: CatalogRow,
  onQuery?: (query: SQL) => void,
): Database {
  return {
    execute: async (query: SQL) => {
      onQuery?.(query);
      return [row];
    },
  } as unknown as Database;
}

const safeCatalog = (): CatalogRow => ({
  current_user_matches: true,
  capability_attributes_ok: true,
  login_attributes_ok: true,
  login_has_expected_capability: true,
  capability_has_no_escalation_membership: true,
  login_has_no_other_memberships: true,
  no_protected_ownership: true,
  login_has_no_enterprise_privileges: true,
});

test("brands only handles whose exact current_user is the required capability", async () => {
  const directory = await verifyDirectoryDatabase(databaseWith(safeCatalog()));
  const data = await verifyDataDatabase(databaseWith(safeCatalog()));
  const operator = await verifyOperatorDatabase(databaseWith(safeCatalog()));
  expect(directory).toBeDefined();
  expect(data).toBeDefined();
  expect(operator).toBeDefined();
});

test("refuses a different current_user, including another capability role", async () => {
  const row = safeCatalog();
  row.current_user_matches = false;
  await expect(verifyDataDatabase(databaseWith(row))).rejects.toThrow(
    "DATABASE_CAPABILITY_MISMATCH",
  );
});

test("refuses superuser, BYPASSRLS, and owner-capable sessions", async () => {
  for (const field of [
    "capability_attributes_ok",
    "login_attributes_ok",
    "no_protected_ownership",
  ] as const) {
    const row = safeCatalog();
    row[field] = false;
    await expect(verifyDataDatabase(databaseWith(row))).rejects.toThrow(
      "DATABASE_CAPABILITY_MISMATCH",
    );
  }
});

test("refuses replication-capable capability or login roles", async () => {
  for (const field of [
    "capability_attributes_ok",
    "login_attributes_ok",
  ] as const) {
    const row = safeCatalog();
    row[field] = false;
    await expect(verifyDataDatabase(databaseWith(row))).rejects.toThrow(
      "DATABASE_CAPABILITY_MISMATCH",
    );
  }
});

test("refuses missing capability membership and any capability escalation membership", async () => {
  for (const field of [
    "login_has_expected_capability",
    "capability_has_no_escalation_membership",
    "login_has_no_other_memberships",
    "login_has_no_enterprise_privileges",
  ] as const) {
    const row = safeCatalog();
    row[field] = false;
    await expect(verifyOperatorDatabase(databaseWith(row))).rejects.toThrow(
      "DATABASE_CAPABILITY_MISMATCH",
    );
  }
});

test("capability SQL rejects direct LOGIN grants and ownership authority", async () => {
  let queryText = "";
  const dialect = new PgDialect();
  const database = databaseWith(safeCatalog(), (query) => {
    queryText = dialect.sqlToQuery(query).sql;
  });

  await verifyDataDatabase(database);

  expect(queryText).toContain("aclexplode");
  expect(queryText).toContain("relation.relacl");
  expect(queryText).toContain("attribute.attacl");
  expect(queryText).toContain("namespace.nspacl");
  expect(queryText).toContain("pg_database target_database");
  expect(queryText).toContain("relation_acl.grantee = login.oid");
  expect(queryText).toContain("attribute_acl.grantee = login.oid");
  expect(queryText).toContain("relation_acl.grantee = 0");
  expect(queryText).toContain("attribute_acl.grantee = 0");
  expect(queryText).toContain("schema_acl.grantee = login.oid");
  expect(queryText).toContain("relation.relowner = login.oid");
  expect(queryText).toContain("namespace.nspowner = login.oid");
  expect(queryText).toContain("target_database.datdba = login.oid");
  expect(queryText).toContain(
    "pg_has_role(session_user, target_database.datdba, 'MEMBER')",
  );
  expect(queryText).toContain("session_user");
  expect(queryText).toContain("login_has_no_enterprise_privileges");
  expect(queryText).toContain("no_protected_ownership");
  expect(queryText).toContain("NOT capability.rolreplication");
  expect(queryText).toContain("NOT login.rolreplication");
});

test("login membership probe permits only its own role and expected capability", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../../src/enterprise/tenancy/connections.ts", import.meta.url),
    "utf8",
  );
  const probe = source.match(
    /NOT EXISTS \(\s*SELECT 1\s*FROM pg_roles inherited\s*WHERE([\s\S]*?)\) AS login_has_no_other_memberships/,
  )?.[1];
  expect(probe).toBeDefined();
  expect(probe).toContain("inherited.rolname <> capability.rolname");
  expect(probe).toContain("inherited.rolname <> login.rolname");

  const unexpectedMemberships = (roles: string[]) =>
    roles.filter(
      (role) => role !== "ephemeral_login" && role !== "ob_ent_data",
    );
  expect(unexpectedMemberships(["ephemeral_login", "ob_ent_data"])).toEqual([]);
  expect(
    unexpectedMemberships([
      "ephemeral_login",
      "ob_ent_data",
      "ob_ent_operator",
    ]),
  ).toEqual(["ob_ent_operator"]);
  expect(
    unexpectedMemberships(["ephemeral_login", "ob_ent_data", "table_owner"]),
  ).toEqual(["table_owner"]);
});

test("does not let an operator handle masquerade as an API data connection", async () => {
  const row = safeCatalog();
  row.current_user_matches = false;
  await expect(verifyDataDatabase(databaseWith(row))).rejects.toThrow(
    "DATABASE_CAPABILITY_MISMATCH",
  );
});

test("runtime service guard rejects a forged unverified handle", () => {
  expect(() => assertOperatorDatabase({} as OperatorDatabase)).toThrow(
    "UNVERIFIED_DATABASE_CAPABILITY",
  );
});

test("RLS migration revokes public access and assigns only explicit capability policies", async () => {
  const { readFileSync } = await import("node:fs");
  const migration = readFileSync(
    new URL("../../drizzle/0055_enterprise_tenancy_rls.sql", import.meta.url),
    "utf8",
  );
  expect(migration).toMatch(
    /REVOKE ALL PRIVILEGES ON TABLE[\s\S]+FROM PUBLIC,/,
  );
  expect(migration).toMatch(/REVOKE CREATE ON SCHEMA public FROM PUBLIC/);
  expect(migration).not.toMatch(/\bTO\s+public\b/i);
  expect(migration).toContain("TO ob_ent_directory");
  expect(migration).toContain("TO ob_ent_data");
  expect(migration).toContain("TO ob_ent_operator");
  expect(migration).not.toMatch(/GRANT [^;]+ TO ob_ent_identity_operator/i);
  expect(migration).not.toMatch(
    /GRANT SELECT [^;]*enterprise_security_events[^;]* TO ob_ent_data/i,
  );
});

test("capability bootstrap defines only safe NOLOGIN roles and stores no password", async () => {
  const { readFileSync } = await import("node:fs");
  const roleSql = readFileSync(
    new URL("../../ops/enterprise/roles.sql", import.meta.url),
    "utf8",
  );
  const definitions = [...roleSql.matchAll(/CREATE ROLE\s+(\w+)\s+([^;]+);/gi)];
  expect(definitions.map((definition) => definition[1]).sort()).toEqual([
    "ob_ent_data",
    "ob_ent_directory",
    "ob_ent_identity_operator",
    "ob_ent_operator",
  ]);
  for (const definition of definitions) {
    expect(definition[2]).toMatch(/\bNOLOGIN\b/);
    expect(definition[2]).toMatch(/\bNOSUPERUSER\b/);
    expect(definition[2]).toMatch(/\bNOBYPASSRLS\b/);
    expect(definition[2]).toMatch(/\bNOCREATEDB\b/);
    expect(definition[2]).toMatch(/\bNOCREATEROLE\b/);
    expect(definition[2]).toMatch(/\bNOREPLICATION\b/);
  }
  expect(roleSql).toContain("session_user <> current_user");
  expect(roleSql).toContain("rolsuper");
  expect(roleSql).toContain("NOT rolreplication");
  expect(roleSql).toContain("relkind IN ('r', 'p', 'v', 'm', 'S', 'f')");
  expect(roleSql).toContain("namespace.nspowner = capability_oid");
  expect(roleSql).toContain("target_database.datdba = capability_oid");
  expect(roleSql).not.toMatch(/\b(?:ENCRYPTED\s+)?PASSWORD\s*=/i);
});
