import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { expect, test } from "../../tests/support/e2e-compat";
import {
  enterprisePackageChanges,
  enterprisePackageGrants,
  enterprisePackageInstalls,
} from "../src/db/schema/enterprise-plugin-packages";

/**
 * OCR round 1, F1. The drizzle generator lists schemas explicitly, and its own
 * comment warns that a schema file missing from that list is invisible to
 * `generate` — the next generation would treat those tables as absent and could
 * emit destructive DDL. The enterprise package tables ride the MT-task track for
 * their DDL, but their typed schema is barrel-exported, so the generator must
 * still know the file exists. This pins that decision so a future edit cannot
 * silently drop it.
 */

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the enterprise package schema stays visible to the drizzle generator", () => {
  const barrel = readFileSync(
    join(serverRoot, "src/db/schema/index.ts"),
    "utf8",
  );
  expect(barrel).toContain('export * from "./enterprise-plugin-packages";');

  const config = readFileSync(join(serverRoot, "drizzle.config.ts"), "utf8");
  expect(config).toContain('"./src/db/schema/enterprise-plugin-packages.ts"');
});

/**
 * OCR round 4 (R4-1/R4-2/R4-6): the typed mirror must carry the same
 * constraints the authoritative migrate-test tasks applied — the scope-unique
 * install index the package compound FKs point at, the six-column grants PK
 * (tool_ref included) and the changes action CHECK widened to the full closed
 * action vocabulary. Typed introspection, not text matching: the projection
 * the store and service layers actually query is what is pinned here.
 */
test("the package mirror carries the authoritative R4 constraint alignments", () => {
  const dialect = new PgDialect();

  // R4-1: PKG03 `package_grant_table` added the (tenant, workspace, id)
  // unique index on enterprise_package_installs.
  const installs = getTableConfig(enterprisePackageInstalls);
  expect(
    installs.indexes.map((index) => index.config.name),
  ).toContain("enterprise_package_install_scope_id_uq");

  // R4-2: PKG03 `package_grant_pk_tool_ref` rebuilt the grants PK to six
  // columns — one connector resource holds one row per tool per cycle.
  const grants = getTableConfig(enterprisePackageGrants);
  const pk = grants.primaryKeys.find(
    (candidate) => candidate.getName() === "enterprise_package_grant_pk",
  );
  expect(pk?.columns.map((column) => column.name)).toEqual([
    "tenant_id",
    "install_id",
    "generation",
    "bot_id",
    "resource_id",
    "tool_ref",
  ]);

  // R4-6: the changes action CHECK mirrors the authority's widened
  // vocabulary (install/upgrade/rollback → grant/revoke → createExpert).
  const changes = getTableConfig(enterprisePackageChanges);
  const action = changes.checks.find(
    (candidate) => candidate.name === "enterprise_package_change_action",
  );
  expect(action).toBeDefined();
  const actionSql = dialect.sqlToQuery(action!.value).sql;
  for (const verb of [
    "'install'",
    "'upgrade'",
    "'rollback'",
    "'grant'",
    "'revoke'",
    "'createExpert'",
  ]) {
    expect(actionSql).toContain(verb);
  }
});
