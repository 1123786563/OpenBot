import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const source = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("all supported migration commands use the guarded runtime migrator", () => {
  const packageJson = JSON.parse(source("../../package.json")) as {
    scripts: Record<string, string>;
  };
  const compose = source("../../../docker-compose.yml");
  const embedded = source("../../../docker/s6/scripts/migrate.sh");
  const enterpriseTest = source("../../scripts/enterprise-test-db.ts");
  const ci = source("../../../.github/workflows/ci.yml");
  const migration = source("../../scripts/migrate.ts");
  const runner = source("../../scripts/migration-runner.ts");

  expect(packageJson.scripts["db:migrate"]).toContain("scripts/migrate.ts");
  expect(packageJson.scripts["db:migrate"]).not.toContain(
    "drizzle-kit migrate",
  );
  expect(compose).toContain('command: ["bun", "scripts/migrate.ts"]');
  expect(compose).toContain('OPENBOT_BOOTSTRAP_ENTERPRISE_ROLES: "on"');
  expect(embedded).toContain("export OPENBOT_BOOTSTRAP_ENTERPRISE_ROLES=on");
  expect(enterpriseTest).toContain('"scripts/migrate.ts"');
  expect(enterpriseTest).toContain('OPENBOT_BOOTSTRAP_ENTERPRISE_ROLES: "on"');
  expect(ci).toContain("bun scripts/migrate.ts");
  expect(ci).not.toContain("bunx drizzle-kit migrate");
  expect(migration).toContain(
    'process.env.OPENBOT_BOOTSTRAP_ENTERPRISE_ROLES === "on"',
  );
  expect(migration).toContain("migrateWithValidationBoundary");
  expect(migration).toContain("migrateWithValidationBoundary(\n    client,");
  expect(migration).not.toContain("await migrate(database");
  expect(runner).toContain(
    "export async function migrateWithValidationBoundary",
  );
  expect(runner).toContain("const reserved = await client.reserve()");
  expect(runner).toContain("options: client.options");
  expect(runner).toContain('reserved.unsafe("BEGIN")');
  expect(runner).toContain('reserved.unsafe("COMMIT")');
  expect(runner).toContain('reserved.unsafe("ROLLBACK")');
  expect(runner).not.toContain("client.begin(");
  expect(runner).not.toContain("drizzle(reserved)");
  expect(runner).toContain("AS unlocked");
  expect(runner).toContain("reserved.release()");
  expect(runner).toContain("client.end({ timeout: 0 })");
});

test("drizzle schema list covers every schema file that declares a table", () => {
  const config = source("../../drizzle.config.ts");
  // index.ts is the barrel and json.ts is a customType helper; neither declares
  // a table, and the config convention lists only table-bearing schema files.
  const schemaDir = new URL("../../src/db/schema/", import.meta.url);
  const declaring = readdirSync(schemaDir)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) =>
      readFileSync(new URL(name, schemaDir), "utf8").includes("pgTable("),
    )
    .sort();
  expect(declaring.length).toBeGreaterThan(0);
  for (const file of declaring) {
    expect(config).toContain(`"./src/db/schema/${file}"`);
  }
});

test("CI keeps the regular test database separate from loopback enterprise PostgreSQL", () => {
  const ci = source("../../../.github/workflows/ci.yml");
  expect(ci).toContain('"127.0.0.1:5434:5432"');
  expect(ci).toContain("ENTERPRISE_TEST_SETUP_DATABASE_URL:");
  expect(ci).toContain("ENTERPRISE_TEST_DIRECTORY_DATABASE_URL:");
  expect(ci).toContain(
    "TEST_DATABASE_URL: postgres://openbot:openbot@localhost:5432/",
  );
});
