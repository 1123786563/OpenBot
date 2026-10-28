/**
 * A real second process for the recovery-scan integration suite (Bifrost 08.1).
 *
 * The restart and multi-worker acceptance criteria are facts about SEPARATE processes
 * against the same PostgreSQL: a scan that only ever ran inside the test process could be
 * quietly running on module-level memory. This worker opens its own connection pool, does
 * exactly ONE operation, prints the JSON result and exits — so the suite proves discovery
 * and claim survive a process boundary.
 *
 * Usage: bun tests/support/recovery-scan-worker.ts <operation> [arg] [arg]
 *   scan                        → one scanOnce() pass
 *   claim <workerId> [limit]    → one batch claim
 *   claim-id <itemId> <workerId> → one single-item claim
 *
 * Requires TEST_DATABASE_URL (testDatabaseUrl() refuses anything else); the environment is
 * inherited from the spawning test process.
 */
import { createRecoveryScanner } from "../../src/billing/recovery-scan";
import { createDatabase } from "../../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./database";

const [, , operation, primary, secondary] = process.argv;
if (operation !== "scan" && operation !== "claim" && operation !== "claim-id") {
  throw new Error(
    `usage: recovery-scan-worker.ts <scan|claim|claim-id> [arg] [arg] — got ${operation}`,
  );
}
// Validate before touching the database, so a malformed invocation fails with
// usage context instead of a bare domain error from deep inside the scanner.
if (operation !== "scan" && !primary) {
  throw new Error(
    `usage: recovery-scan-worker.ts ${operation} ${operation === "claim-id" ? "<itemId> <workerId>" : "<workerId> [limit]"}`,
  );
}
if (operation === "claim" && secondary !== undefined) {
  const limit = Number(secondary);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `usage: recovery-scan-worker.ts claim <workerId> [limit] — limit must be a positive integer, got ${JSON.stringify(secondary)}`,
    );
  }
}

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const scanner = createRecoveryScanner({ database });

// Contract with the parent test process: the result JSON is the ONLY stdout
// line (diagnostics go to stderr) and the exit code is 0 only after printing it.
try {
  let result: unknown;
  if (operation === "scan") {
    result = await scanner.scanOnce();
  } else if (operation === "claim") {
    result = await scanner.claimRecoveryItems(
      primary,
      secondary === undefined ? 10 : Number(secondary),
    );
  } else {
    result = await scanner.claimRecoveryItem(primary, secondary);
  }

  console.log(JSON.stringify(result));
} finally {
  // The pool must close on the throwing path too, or the worker process
  // keeps the parent test waiting on an open handle.
  await database.$client.close();
}
