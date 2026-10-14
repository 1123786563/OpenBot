import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import postgres from "postgres";
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

const command =
  mode === "migrate"
    ? ["bun", "scripts/migrate.ts"]
    : mode === "custom"
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
const serverRoot = fileURLToPath(new URL("../", import.meta.url));
const child = Bun.spawn(command, {
  cwd: serverRoot,
  env: {
    PATH: process.env.PATH ?? "",
    ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
    DATABASE_URL: databaseUrl,
    ...(mode === "migrate" ? { OPENBOT_BOOTSTRAP_ENTERPRISE_ROLES: "on" } : {}),
  },
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await child.exited;
if (mode === "migrate" && exitCode === 0) {
  await provisionRuntimeTestLogins(databaseUrl);
}
process.exit(exitCode);

async function provisionRuntimeTestLogins(url: string) {
  const logins = [
    { name: "enterprise_directory_login", capability: "ob_ent_directory" },
    { name: "enterprise_data_login", capability: "ob_ent_data" },
    { name: "enterprise_operator_login", capability: "ob_ent_operator" },
  ] as const;
  const database = postgres(url, { max: 1 });
  try {
    for (const login of logins) {
      const [existing] = await database<{ rolname: string }[]>`
        SELECT rolname FROM pg_roles WHERE rolname = ${login.name}
      `;
      if (existing) {
        for (const capability of [
          "ob_ent_directory",
          "ob_ent_data",
          "ob_ent_operator",
          "ob_ent_identity_operator",
        ]) {
          await database.unsafe(`REVOKE ${capability} FROM ${login.name}`);
        }
        await database.unsafe(
          `ALTER ROLE ${login.name} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'enterprise-test-only'`,
        );
      } else {
        await database.unsafe(
          `CREATE ROLE ${login.name} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'enterprise-test-only'`,
        );
      }
      await database.unsafe(`GRANT ${login.capability} TO ${login.name}`);
    }
  } finally {
    await database.end({ timeout: 5 });
  }
}

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
