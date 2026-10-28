/**
 * A real second process for the unacked-replay integration suite (Bifrost 08.2).
 *
 * The replay handler must be persistence-driven — every fact it converges lives in
 * PostgreSQL, none in module memory. This worker opens its own connection pool, claims
 * and processes RecoveryItems exactly ONCE, prints the JSON batch result and exits — so
 * the suite proves the replay's convergence from a process that never saw the seeding.
 *
 * Usage: bun tests/support/recovery-replay-worker.ts replay-unacked <workerId> [limit]
 *
 * Requires TEST_DATABASE_URL (testDatabaseUrl() refuses anything else); the environment is
 * inherited from the spawning test process.
 */
import { createRecoveryReplay } from "../../src/billing/recovery-replay";
import { createDatabase } from "../../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./database";

const [, , operation, workerId, limitArg] = process.argv;
if (operation !== "replay-unacked" || !workerId) {
  throw new Error(
    `usage: recovery-replay-worker.ts replay-unacked <workerId> [limit] — got ${operation}`,
  );
}
const limit = limitArg === undefined ? 10 : Number(limitArg);
if (!Number.isInteger(limit) || limit < 1) {
  throw new Error(
    `usage: recovery-replay-worker.ts replay-unacked <workerId> [limit] — limit must be a positive integer, got ${JSON.stringify(limitArg)}`,
  );
}

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const replay = createRecoveryReplay({ database });

try {
  const result = await replay.replayUnackedResults(workerId, limit);
  console.log(JSON.stringify(result));
} finally {
  // The pool must close on the throwing path too, or the worker process keeps
  // the parent test waiting on an open handle.
  await database.$client.close();
}
