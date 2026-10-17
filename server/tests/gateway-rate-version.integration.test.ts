import { afterAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { enterpriseSettings } from "../src/db/schema";
import { createConversionRateStore } from "../src/gateway/conversion-rate-store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { rejectionOf } from "./support/pg-errors";
import { truncateRateVersions } from "./support/rate-version-reset";

/*
 * Bifrost 01.4 — the conversion rate becomes immutable version records.
 *
 * Every administrator change creates a new version; no version is ever rewritten. This file owns
 * the guarantees the ticket names: the database itself refuses to rewrite history (an UPDATE, a
 * DELETE — and a TRUNCATE, the one statement a row-level trigger cannot see, per migration 0012's
 * lesson), requests resolve to the version that was in effect at their time, and a request that
 * locked a version settles with it even after later changes. The store wiring lives further down;
 * the table's own immutability is proven here against raw SQL, because the application is not the
 * only thing that can reach this table.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);

/**
 * Test reset. Production code has no path here: the table is append-only, and that is the point.
 * Disabling the named triggers needs the table owner — an application role never runs DDL — so
 * the cleanup is deliberate test tooling, not a production mutation path.
 */
async function resetRateVersions() {
  await truncateRateVersions(database);
}

afterAll(async () => {
  await resetRateVersions();
  await database.$client.close();
});

describe("gateway_rate_versions — append-only by the database, not by discipline", () => {
  test("a recorded version cannot be rewritten, removed or truncated", async () => {
    await resetRateVersions();
    // Seeded the way save() will record it (Task 2 wires the store; the table's own guarantee is
    // what is under test, and raw SQL is the adversary it must answer).
    await database.execute(sql`
      INSERT INTO gateway_rate_versions (rate_version, numerator, denominator, recorded_by)
      VALUES (1, '1', '3', 'admin@openbot.test')
    `);

    // An UPDATE rewriting the exact value is refused by the database itself. Asserted through
    // the driver's SQLSTATE, because Drizzle's wrapper message is only "Failed query: …" — the
    // refusal's identity lives in the cause chain (P0001, raise_exception).
    const update = await rejectionOf(() =>
      database.execute(
        sql`UPDATE gateway_rate_versions SET numerator = '9' WHERE rate_version = 1`,
      ),
    );
    expect(update.code).toBe("P0001");
    expect(update.message).toMatch(/append-only/i);

    // A DELETE is refused too: history is not anybody's to retract.
    const del = await rejectionOf(() =>
      database.execute(
        sql`DELETE FROM gateway_rate_versions WHERE rate_version = 1`,
      ),
    );
    expect(del.code).toBe("P0001");
    expect(del.message).toMatch(/append-only/i);

    // TRUNCATE removes every row without firing a row-level trigger — migration 0012 closed this
    // exact hole for the audit trail, so the statement trigger exists from day one here.
    const truncate = await rejectionOf(() =>
      database.execute(sql`TRUNCATE gateway_rate_versions`),
    );
    expect(truncate.code).toBe("P0001");
    expect(truncate.message).toMatch(/append-only/i);

    // After all three refusals the recorded version is exactly what was recorded.
    const rows = await database.execute(
      sql`SELECT rate_version, numerator, denominator, recorded_by
          FROM gateway_rate_versions WHERE rate_version = 1`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      rate_version: 1,
      numerator: "1",
      denominator: "3",
      recorded_by: "admin@openbot.test",
    });
  });

  test("a version carries its effective time without anyone supplying it", async () => {
    await resetRateVersions();
    const before = new Date();
    await database.execute(sql`
      INSERT INTO gateway_rate_versions (rate_version, numerator, denominator, recorded_by)
      VALUES (2, '5', '2', 'other@openbot.test')
    `);
    const rows = await database.execute(
      sql`SELECT effective_at, recorded_at FROM gateway_rate_versions WHERE rate_version = 2`,
    );
    expect(rows.length).toBe(1);
    const effectiveAt = new Date(rows[0].effective_at);
    const recordedAt = new Date(rows[0].recorded_at);
    // now()-based defaults, so the audit trail does not depend on the writer's clock being honest.
    expect(effectiveAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 5_000,
    );
    expect(effectiveAt.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(recordedAt.getTime()).toBe(effectiveAt.getTime());
  });
});

/*
 * The store wiring. `save()` appends an immutable version and moves the current-version marker;
 * `rateVersionAt(t)` is the one resolution admission and settlement share, so a request locked
 * before a change still settles with the version that was in effect when it was admitted
 * (Q14/ADR 0003), and a request admitted after it gets the new one (Q19: a change only affects
 * new requests). Version 0 is the deployment's environment rate — static by definition, so it is
 * a fact about configuration, not a recorded event, and belongs to no table.
 */
const GATEWAY_CONVERSION_RATE_KEY = "gateway_conversion_rate";

/** Removes the pointer row and the recorded history (trigger-disable is the test-only path). */
async function resetRateState() {
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, GATEWAY_CONVERSION_RATE_KEY));
  await resetRateVersions();
}

function rate(numerator: bigint | number, denominator: bigint | number) {
  return { numerator: BigInt(numerator), denominator: BigInt(denominator) };
}

describe("conversion rate store — immutable versions and the time-point lock", () => {
  test("each save appends one immutable version and marks it current", async () => {
    await resetRateState();
    const store = createConversionRateStore({ database });

    const first = await store.save(
      { numerator: "1", denominator: "3" },
      "admin@openbot.test",
    );
    expect(first).toEqual({
      ok: true,
      numerator: 1n,
      denominator: 3n,
      rateVersion: 1,
    });
    const second = await store.save(
      { numerator: "10", denominator: "4" },
      "other@openbot.test",
    );
    expect(second).toEqual({
      ok: true,
      numerator: 5n, // canonical: reduced to lowest terms before being recorded
      denominator: 2n,
      rateVersion: 2,
    });

    // The version record: exact value, who recorded it, and when it took effect.
    const v1 = await store.readRateVersion(1);
    expect(v1).toMatchObject({
      found: true,
      source: "admin",
      rateVersion: 1,
      numerator: 1n,
      denominator: 3n,
      recordedBy: "admin@openbot.test",
    });
    const v2 = await store.readRateVersion(2);
    expect(v2).toMatchObject({
      found: true,
      source: "admin",
      rateVersion: 2,
      numerator: 5n,
      denominator: 2n,
      recordedBy: "other@openbot.test",
    });
    if (
      v1.found &&
      v2.found &&
      v1.source === "admin" &&
      v2.source === "admin"
    ) {
      // The audit trail does not depend on the writer's clock: effective time is the database's.
      expect(v1.effectiveAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(v1.effectiveAt.getTime()).toBeLessThan(v2.effectiveAt.getTime());
    }

    // The separately-marked current version is the newest one.
    expect(await store.readConversionRate()).toEqual({
      configured: true,
      numerator: 5n,
      denominator: 2n,
      rateVersion: 2,
      source: "admin",
    });
  });

  test("a request admitted before a change settles with the old version; a new request gets the new one", async () => {
    await resetRateState();
    const store = createConversionRateStore({
      database,
      environmentRate: rate(900n, 1n),
    });

    await store.save(
      { numerator: "1", denominator: "3" },
      "admin@openbot.test",
    );
    const v1 = await store.readRateVersion(1);
    if (!v1.found || v1.source !== "admin")
      throw new Error("version 1 missing");

    // A real gap between the two saves, because a Date's resolution is one millisecond while
    // the database's is one microsecond: the boundary times below must land strictly between
    // the two effective moments. The ordering itself is asserted in SQL further down.
    await Bun.sleep(15);
    await store.save(
      { numerator: "5", denominator: "2" },
      "other@openbot.test",
    );
    const v2 = await store.readRateVersion(2);
    if (!v2.found || v2.source !== "admin")
      throw new Error("version 2 missing");

    // The moments that matter: before the first version existed, between the versions (a
    // request admitted there — "the locked request"), and after the second took effect.
    const beforeFirst = new Date(v1.effectiveAt.getTime() - 1);
    const lockedAdmission = new Date(v1.effectiveAt.getTime() + 1);
    const afterSecond = new Date(v2.effectiveAt.getTime() + 1);

    // Settlement of the request admitted between the versions still resolves to version 1 —
    // even though version 2 has existed for a while by now. This is the lock contract: the
    // version is determined at admission and the same one is used for settlement.
    const settled = await store.rateVersionAt(lockedAdmission);
    expect(settled).toMatchObject({
      resolved: true,
      source: "admin",
      rateVersion: 1,
      numerator: 1n,
      denominator: 3n,
      recordedBy: "admin@openbot.test",
    });

    // A request admitted after the change resolves to the new version: changes reach only new
    // requests, never retroactively the ones already admitted.
    expect(await store.rateVersionAt(afterSecond)).toMatchObject({
      resolved: true,
      source: "admin",
      rateVersion: 2,
      numerator: 5n,
      denominator: 2n,
    });

    // And before the first version existed, the deployment's environment rate (version 0) was
    // what a request would have been priced with.
    expect(await store.rateVersionAt(beforeFirst)).toEqual({
      resolved: true,
      source: "environment",
      rateVersion: 0,
      numerator: 900n,
      denominator: 1n,
    });

    // Version ordering matches effective-time ordering in the database's own microseconds, not
    // just the test's millisecond assumptions.
    const ordered = await database.execute(sql`
      SELECT a.effective_at < b.effective_at AS strictly_ordered
      FROM gateway_rate_versions a, gateway_rate_versions b
      WHERE a.rate_version = 1 AND b.rate_version = 2
    `);
    expect(ordered[0].strictly_ordered).toBe(true);
  });

  test("two concurrent saves never share a version number, and both versions remain readable", async () => {
    await resetRateState();
    const store = createConversionRateStore({ database });
    const other = createConversionRateStore({ database });

    const [a, b] = await Promise.all([
      store.save({ numerator: "1", denominator: "3" }, "admin@openbot.test"),
      other.save({ numerator: "2", denominator: "3" }, "other@openbot.test"),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // Distinct, adjacent, no duplicate: the advisory lock serializes and the primary key is the
    // backstop no writer can negotiate with.
    expect([a.rateVersion, b.rateVersion].sort()).toEqual([1, 2]);

    // Each operator's exact value is preserved under its own version — a loser of the race
    // must not have overwritten the winner's history.
    expect(await store.readRateVersion(1)).toMatchObject({
      found: true,
      rateVersion: 1,
    });
    expect(await store.readRateVersion(2)).toMatchObject({
      found: true,
      rateVersion: 2,
    });
    const rows = await database.execute(sql`
      SELECT rate_version, numerator, denominator, recorded_by FROM gateway_rate_versions ORDER BY rate_version
    `);
    expect(rows.length).toBe(2);
    expect([rows[0].recorded_by, rows[1].recorded_by].sort()).toEqual([
      "admin@openbot.test",
      "other@openbot.test",
    ]);
    // Current marker sits at the greater version, whichever write that was.
    const current = await store.readConversionRate();
    expect(current.configured === true ? current.rateVersion : 0).toBe(2);
  });

  test("before any version exists the truth is the environment rate at version 0 — or an honest not-configured", async () => {
    await resetRateState();
    const unconfigured = createConversionRateStore({ database });
    expect(await unconfigured.rateVersionAt(new Date())).toEqual({
      resolved: false,
      reason: "not_configured",
      explanation: expect.stringContaining("conversion rate") as unknown,
    });
    // Version 0 is only a fact when an environment rate was actually configured.
    expect(await unconfigured.readRateVersion(0)).toEqual({
      found: false,
      reason: "not_configured",
    });

    const configured = createConversionRateStore({
      database,
      environmentRate: rate(900n, 1n),
    });
    const resolution = await configured.rateVersionAt(new Date());
    expect(resolution).toEqual({
      resolved: true,
      source: "environment",
      rateVersion: 0,
      numerator: 900n,
      denominator: 1n,
    });
    expect(await configured.readRateVersion(0)).toEqual({
      found: true,
      source: "environment",
      rateVersion: 0,
      numerator: 900n,
      denominator: 1n,
    });
  });

  test("a version number nobody recorded resolves to not-found, never to a neighbor's value", async () => {
    await resetRateState();
    const store = createConversionRateStore({ database });
    await store.save(
      { numerator: "1", denominator: "3" },
      "admin@openbot.test",
    );
    expect(await store.readRateVersion(99)).toEqual({
      found: false,
      reason: "not_found",
    });
  });

  test("the next save continues from the greatest recorded version even if the pointer row is gone", async () => {
    await resetRateState();
    const store = createConversionRateStore({ database });
    await store.save(
      { numerator: "1", denominator: "3" },
      "admin@openbot.test",
    );

    // The pointer is mutable configuration; a database administrator may remove it. The history
    // is not rewound by that: the next version must be 2, not a collision-prone 1.
    await database
      .delete(enterpriseSettings)
      .where(eq(enterpriseSettings.key, GATEWAY_CONVERSION_RATE_KEY));

    const next = await store.save(
      { numerator: "5", denominator: "2" },
      "other@openbot.test",
    );
    expect(next).toEqual({
      ok: true,
      numerator: 5n,
      denominator: 2n,
      rateVersion: 2,
    });
    // The marker is restored, and both versions remain exactly where history left them.
    expect(await store.readConversionRate()).toMatchObject({
      configured: true,
      rateVersion: 2,
      source: "admin",
    });
    expect(await store.readRateVersion(1)).toMatchObject({ found: true });
    expect(await store.readRateVersion(2)).toMatchObject({ found: true });
  });
});
