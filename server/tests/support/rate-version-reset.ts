/**
 * Test reset for the append-only `gateway_rate_versions` history (Bifrost 01.4).
 *
 * The table is immutable by triggers — UPDATE and DELETE refused by a row-level trigger, TRUNCATE
 * by a statement trigger (migration 0012's lesson about the one statement a row trigger cannot
 * see). Production code has no mutation path at all; that is the guarantee under test. A test
 * that needs a clean history goes through the owner-only DDL of disabling the named triggers,
 * truncating, and re-enabling in a `finally`, so a failed truncate cannot leave the triggers off.
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
    // ALTER TABLE ... DISABLE TRIGGER takes one name per statement.
    await database.execute(
      sql`ALTER TABLE gateway_rate_versions DISABLE TRIGGER gateway_rate_versions_append_only`,
    );
    await database.execute(
      sql`ALTER TABLE gateway_rate_versions DISABLE TRIGGER gateway_rate_versions_no_truncate`,
    );
    try {
      await database.execute(sql`TRUNCATE gateway_rate_versions`);
    } finally {
      await database.execute(
        sql`ALTER TABLE gateway_rate_versions ENABLE TRIGGER gateway_rate_versions_append_only`,
      );
      await database.execute(
        sql`ALTER TABLE gateway_rate_versions ENABLE TRIGGER gateway_rate_versions_no_truncate`,
      );
    }
  } catch (error) {
    let message = String(error);
    let cause: unknown = error;
    while (cause && typeof cause === "object" && "cause" in cause) {
      cause = (cause as { cause?: unknown }).cause;
      message += ` ${String(cause)}`;
    }
    if (!/does not exist/i.test(message)) throw error;
  }
}
