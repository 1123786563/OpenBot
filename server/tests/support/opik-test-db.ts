import { createDatabase, type Database } from "../../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./database";

/**
 * The Opik binding suite's database entry point.
 *
 * `testDatabaseUrl` is the whole policy and is not worked around here: a missing
 * TEST_DATABASE_URL is a refused run, and so is one pointing at the live `openbot` database.
 * Nothing in this module may fall back to DATABASE_URL — a binding is authoritative ownership,
 * and a test that wrote bindings into a developer's application database is worse than a red test.
 */
export function opikTestDatabase(pool = TEST_POOL): Database {
  return createDatabase(testDatabaseUrl(), pool);
}

/**
 * Fail with instructions instead of `relation "ai_observation_bindings" does not exist`.
 *
 * The uniqueness constraints this suite proves idempotency with live in the migration, not in
 * TypeScript: a database without them is a database the migrations were never applied to, and
 * every test below would then be proving nothing while reporting green.
 */
export async function assertBindingsSchemaPresent(
  database: Database,
): Promise<void> {
  const indexes = await database.$client`
    SELECT indexname FROM pg_indexes WHERE tablename = 'ai_observation_bindings'
  `;
  const present = new Set(indexes.map((row) => row.indexname));
  for (const required of [
    "ai_observation_bindings_scope_run_attempt_uq",
    "ai_observation_bindings_scope_opik_trace_uq",
  ]) {
    if (!present.has(required)) {
      throw new Error(
        `The dedicated Opik test database lacks ${required}. Apply the migrations to the dedicated test database first (TEST_DATABASE_URL=... bun run db:migrate in server/); do not point these tests at the application database and do not record this as a pass.`,
      );
    }
  }
}
