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
  execute: (query: SQL) => Promise<unknown>;
}) {
  try {
    await database.execute(sql`begin`);
    try {
      // ALTER TABLE ... DISABLE TRIGGER takes one name per statement.
      await database.execute(
        sql`ALTER TABLE gateway_rate_versions DISABLE TRIGGER gateway_rate_versions_append_only`,
      );
      await database.execute(
        sql`ALTER TABLE gateway_rate_versions DISABLE TRIGGER gateway_rate_versions_no_truncate`,
      );
      await database.execute(sql`TRUNCATE gateway_rate_versions`);
    } catch (error) {
      // ROLLBACK re-enables the triggers: no manual ENABLE choreography, and the
      // disabled window never committed.
      await database.execute(sql`rollback`);
      throw error;
    }
    await database.execute(sql`commit`);
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
