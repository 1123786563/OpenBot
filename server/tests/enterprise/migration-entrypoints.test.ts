import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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
  expect(
    migration.indexOf("assertEnterpriseRolePreconditions(roles)"),
  ).toBeLessThan(migration.indexOf("await migrate(database"));
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
