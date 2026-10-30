/**
 * Test reset for the append-only `gateway_rate_versions` history (Bifrost 01.4).
 *
 * The table is immutable by triggers — UPDATE and DELETE refused by a row-level trigger, TRUNCATE
 * by a statement trigger (migration 0012's lesson about the one statement a row trigger cannot
 * see). Production code has no mutation path at all; that is the guarantee under test. A test
 * that needs a clean history goes through the owner-only DDL of disabling the named triggers and
 * truncating inside one transaction, so the disabled-trigger window is never visible to other
 * sessions and a failed truncate rolls the disable back instead of leaving the triggers off.
 *
 * Missing-table tolerance: before migration 0128 exists (the RED phase of a schema change) there
 * is nothing to reset, and Drizzle wraps the driver error, so the cause chain is where Postgres
 * names the missing relation.
 */
import { type SQL, sql } from "drizzle-orm";

export async function truncateRateVersions(database: {
  transaction: (
    body: (tx: { execute: (query: SQL) => Promise<unknown> }) => Promise<unknown>,
  ) => Promise<unknown>;
}) {
  try {
    // A transaction, not manual begin/commit: Bun's SQL client refuses raw `begin` on a pool
    // with max > 1 ("Only use sql.begin, sql.reserved or max: 1"), and TEST_POOL is max: 2.
    // An aborted transaction still rolls the DISABLE TRIGGER back, so the disabled window is
    // never committed either way.
    await database.transaction(async (tx) => {
      // ALTER TABLE ... DISABLE TRIGGER takes one name per statement.
      await tx.execute(
        sql`ALTER TABLE gateway_rate_versions DISABLE TRIGGER gateway_rate_versions_append_only`,
      );
      await tx.execute(
        sql`ALTER TABLE gateway_rate_versions DISABLE TRIGGER gateway_rate_versions_no_truncate`,
      );
      await tx.execute(sql`TRUNCATE gateway_rate_versions`);
      // Re-enable inside the same transaction: a committed reset must not leave the
      // append-only protection off for the tests that assert it fires.
      await tx.execute(
        sql`ALTER TABLE gateway_rate_versions ENABLE TRIGGER gateway_rate_versions_append_only`,
      );
      await tx.execute(
        sql`ALTER TABLE gateway_rate_versions ENABLE TRIGGER gateway_rate_versions_no_truncate`,
      );
    });
  } catch (error) {
    let message = String(error);
    let cause: unknown = error;
    while (cause && typeof cause === "object" && "cause" in cause) {
      cause = (cause as { cause?: unknown }).cause;
      message += ` ${String(cause)}`;
    }
    // Swallow only the missing TABLE (the RED-phase tolerance above): a
    // missing or renamed TRIGGER must still surface as a failure.
    if (!/relation "gateway_rate_versions" does not exist/i.test(message))
      throw error;
  }
}
