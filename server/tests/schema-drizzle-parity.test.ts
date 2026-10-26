import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { expect, test } from "../../tests/support/e2e-compat";
import {
  enterprisePackageChanges,
  enterprisePackageExperts,
  enterprisePackageGrants,
  enterprisePackageInstalls,
  enterprisePackagePlans,
  enterprisePackageResourceLinks,
  enterprisePackageRevisions,
  enterpriseRunPackagePins,
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
  expect(installs.indexes.map((index) => index.config.name)).toContain(
    "enterprise_package_install_scope_id_uq",
  );

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

/**
 * OCR round 5 (R5-4): the authoritative `package_hardening_case_insensitive`
 * step rebuilt the three recursive secret-carrier CHECKs with a
 * case-insensitive `like_regex` (`flag "i"`), closing the `"Token"` /
 * `"API_KEY"` spelling gap. The typed mirror shares one SQL constant for all
 * three CHECKs, so each rendered constraint must carry the flag.
 */
test("the mirror secret-carrier CHECKs stay case-insensitive (R5-4)", () => {
  const dialect = new PgDialect();
  for (const [table, constraintName] of [
    [enterprisePackageRevisions, "enterprise_package_revision_config_shape"],
    [enterprisePackagePlans, "enterprise_package_plan_input_shape"],
    [enterprisePackageChanges, "enterprise_package_change_diff_shape"],
  ] as const) {
    const config = getTableConfig(table);
    const constraint = config.checks.find(
      (candidate) => candidate.name === constraintName,
    );
    expect(constraint).toBeDefined();
    const rendered = dialect.sqlToQuery(constraint!.value).sql;
    expect(rendered).toContain("like_regex");
    expect(rendered).toContain('flag "i"');
  }
});

/**
 * OCRfix-1 (OCR-5 / OCR-6): the plugin-package primary keys must carry ONE name
 * across the four places that state it.
 *
 * The authority for these tables is the PKG02/PKG03/PKG04 task track in
 * `scripts/multitenancy/migrate-test.ts`; the typed mirror is
 * `src/db/schema/enterprise-plugin-packages.ts`; the fresh-chain DDL is
 * `drizzle/0210_enterprise_plugin_package_market_tables.sql`; and the repair for
 * databases that applied the earlier, unnamed revision is the conditional rename
 * map in `drizzle/0216_enterprise_package_primary_key_names.sql`. Before this fix
 * those four disagreed silently: 0210 declared six of the eight keys anonymously,
 * so PostgreSQL generated `<table>_pkey`, while the mirror and the authority named
 * them — and because drizzle's journal is a watermark that never hashes a file,
 * rewriting 0210 in place could not converge a database that had already run it.
 *
 * Nothing compared names, so the fork was invisible: a `<table>_pkey` anchor is a
 * constraint no `ALTER ... DROP CONSTRAINT "enterprise_package_grant_pk"` can
 * find. This pins the agreement as data rather than prose, in all four directions.
 */

const PACKAGE_TABLES = [
  "enterprise_package_plans",
  "enterprise_package_revisions",
  "enterprise_package_installs",
  "enterprise_package_grants",
  "enterprise_package_experts",
  "enterprise_package_resource_links",
  "enterprise_package_changes",
  "enterprise_run_package_pins",
];

/** SQL text without `--` comment lines, so a prose mention cannot be read as DDL. */
const statementsOnly = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

/**
 * The primary key each `CREATE TABLE` declares, as `table → constraint name`.
 *
 * Scans a statement region — everything from one `CREATE TABLE "x"` to the next —
 * and takes its FIRST `CONSTRAINT "…" PRIMARY KEY`, because the inline clause is
 * what names the key and a later `ALTER TABLE … ADD CONSTRAINT … PRIMARY KEY`
 * only rebuilds a key that already carries that name. Working on raw text rather
 * than a parsed AST is what lets the same pass read both the migration file and
 * the authority, whose statements are JS string literals in
 * `scripts/multitenancy/migrate-test.ts` and are only assembled at runtime.
 *
 * A table whose key is declared anonymously yields nothing, which is exactly the
 * OCR-6 shape this pins against: the caller's lookup misses and the failure names
 * the table.
 */
const declaredPrimaryKeys = (text: string): Map<string, string> => {
  const source = statementsOnly(text);
  const starts = [...source.matchAll(/CREATE TABLE "([^"]+)"/g)].map(
    (match) => ({ name: match[1]!, at: match.index! }),
  );
  const found = new Map<string, string>();
  for (const [position, table] of starts.entries()) {
    const region = source.slice(
      table.at,
      position + 1 < starts.length ? starts[position + 1]!.at : source.length,
    );
    const key = /CONSTRAINT\s+"([^"]+)"\s+PRIMARY KEY/.exec(region);
    if (key) found.set(table.name!, key[1]!);
  }
  return found;
};

test("the eight package primary keys carry one name across authority, migration, guard and mirror", () => {
  const packageMigration = readFileSync(
    join(
      serverRoot,
      "drizzle/0210_enterprise_plugin_package_market_tables.sql",
    ),
    "utf8",
  );
  const authority = declaredPrimaryKeys(
    readFileSync(
      join(serverRoot, "scripts/multitenancy/migrate-test.ts"),
      "utf8",
    ),
  );
  const migration = declaredPrimaryKeys(packageMigration);
  const guard = readFileSync(
    join(serverRoot, "drizzle/0216_enterprise_package_primary_key_names.sql"),
    "utf8",
  );

  const mirrorTables = [
    enterprisePackagePlans,
    enterprisePackageRevisions,
    enterprisePackageInstalls,
    enterprisePackageGrants,
    enterprisePackageExperts,
    enterprisePackageResourceLinks,
    enterprisePackageChanges,
    enterpriseRunPackagePins,
  ];
  const mirror = new Map(
    mirrorTables.map((table) => {
      const config = getTableConfig(table);
      const keys = config.primaryKeys.map((key) => key.getName());
      expect(keys.length).toBe(1);
      return [config.name, keys[0]!] as const;
    }),
  );

  for (const table of PACKAGE_TABLES) {
    const expected = authority.get(table);
    expect(expected, `the authority names no PK for ${table}`).toBeDefined();
    expect(
      migration.get(table),
      `0210 declares ${table} with a PK the authority does not name`,
    ).toBe(expected);
    expect(mirror.get(table), `the mirror names no PK for ${table}`).toBe(
      expected,
    );
    // 0216 renames this table's default onto exactly that name.
    expect(
      guard.includes(`('${table}', '${expected}')`),
      `0216 does not rename ${table} to ${expected}`,
    ).toBe(true);
  }
});
