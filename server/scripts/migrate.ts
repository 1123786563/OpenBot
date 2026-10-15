/**
 * Apply the migrations, using only what a running deployment already has.
 *
 * NOT `drizzle-kit migrate`, and that is the whole point of this file. The CLI is a development
 * dependency: it reads `drizzle.config.ts`, which means compiling TypeScript, which means the esbuild
 * that `bun install --production` correctly leaves out of a runtime image. Asked to migrate there it
 * prints "Reading config file", exits 1, and says nothing at all, so a deployment looks like it
 * migrated and comes up against an empty database complaining that `users` does not exist.
 *
 * The migrator underneath it is part of `drizzle-orm`, which is a runtime dependency because the
 * server imports it anyway. It needs a connection and the folder of SQL files, both of which are in
 * the image, and it keeps the same `drizzle.__drizzle_migrations` journal the CLI does, so the two
 * are interchangeable and a database migrated by either is migrated.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  assertEnterpriseRolePreconditions,
  type EnterpriseRoleCatalogRow,
} from "./enterprise-role-preflight";
import { migrateWithValidationBoundary } from "./migration-runner";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL must be configured before running a database migration command",
  );
}

/*
 * One connection, and `max: 1`.
 *
 * Migrations are a single ordered conversation with the database, and a pool would let two
 * statements that must be ordered land on different connections.
 */
const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });

try {
  if (process.env.OPENBOT_BOOTSTRAP_ENTERPRISE_ROLES === "on") {
    const roleBootstrap = await readFile(
      join(import.meta.dir, "..", "ops", "enterprise", "roles.sql"),
      "utf8",
    );
    await client.unsafe(`BEGIN;\n${roleBootstrap}\nCOMMIT;`).simple();
  }

  const database = drizzle(client);
  const roles = (await database.execute(sql`
    SELECT rolname, rolcanlogin, rolsuper, rolbypassrls,
      rolcreatedb, rolcreaterole, rolreplication
    FROM pg_roles
    WHERE rolname IN (
      'ob_ent_directory', 'ob_ent_data',
      'ob_ent_operator', 'ob_ent_identity_operator'
    )
  `)) as unknown as EnterpriseRoleCatalogRow[];
  assertEnterpriseRolePreconditions(roles);

  await migrateWithValidationBoundary(
    client,
    join(import.meta.dir, "..", "drizzle"),
  );
  console.info(JSON.stringify({ type: "migrations-applied", status: "ok" }));
} finally {
  // Released whatever happened, so a failure exits rather than hanging on an open socket.
  // The runner's own unsafe-cleanup path may have ended the client already;
  // a second end() failure here must never mask the original error.
  await client.end({ timeout: 5 }).catch(() => undefined);
}
