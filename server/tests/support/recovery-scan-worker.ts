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
if (
  operation !== "scan" &&
  operation !== "claim" &&
  operation !== "claim-id"
) {
  throw new Error(
    `usage: recovery-scan-worker.ts <scan|claim|claim-id> [arg] [arg] — got ${operation}`,
  );
}

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const scanner = createRecoveryScanner({ database });

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
await database.$client.close();
