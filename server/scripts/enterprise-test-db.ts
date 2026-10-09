import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  ENTERPRISE_TEST_DATABASE,
  enterpriseTestDatabaseUrlFrom,
} from "../tests/support/enterprise-database";
import {
  assertFreshSetupDatabaseIdentity,
  type SetupDatabaseIdentity,
} from "./enterprise-test-db-guard";

const requestedMode = process.argv[2] ?? "";
if (!new Set(["generate", "custom", "migrate"]).has(requestedMode)) {
  throw new Error("Use enterprise-test-db.ts generate, custom, or migrate.");
}
const mode = requestedMode as "generate" | "custom" | "migrate";

const databaseUrl = enterpriseTestDatabaseUrlFrom();
if (mode === "migrate") await assertFreshSetupDatabase(databaseUrl);

const drizzleCommand =
  mode === "custom"
    ? [
        "bun",
        "--no-env-file",
        "x",
        "--no-install",
        "drizzle-kit",
        "generate",
        "--custom",
        "--name=enterprise_tenancy_rls",
        "--config=drizzle.config.ts",
      ]
    : [
        "bun",
        "--no-env-file",
        "x",
        "--no-install",
        "drizzle-kit",
        mode,
        "--config=drizzle.config.ts",
      ];
const child = Bun.spawn(drizzleCommand, {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  env: {
    PATH: process.env.PATH ?? "",
    ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
    DATABASE_URL: databaseUrl,
  },
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);

async function assertFreshSetupDatabase(url: string) {
  const database = createDatabase(url, { max: 1 });
  try {
    const [identity] = (await database.execute(sql`
      SELECT current_database() AS database_name,
        current_user AS current_user,
        session_user AS session_user,
        actor.rolsuper OR actor.rolbypassrls AS setup_has_bypass,
        NOT EXISTS (
          SELECT 1
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        ) AS public_schema_is_empty
      FROM pg_roles actor
      WHERE actor.rolname = current_user
    `)) as unknown as Array<SetupDatabaseIdentity>;
    assertFreshSetupDatabaseIdentity(identity, ENTERPRISE_TEST_DATABASE);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Refusing migration:")
    )
      throw error;
    throw new Error(
      "Unable to verify the reserved empty enterprise test database.",
    );
  } finally {
    await database.$client.close();
  }
}
