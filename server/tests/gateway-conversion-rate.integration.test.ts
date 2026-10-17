// Ticket #209 (Bifrost 01.3), admin-write path: the same pure parser that guards process start
// guards the admin save. Invalid input is refused before anything is written; valid input is
// stored as an exact rational that survives a "restart" (a fresh database handle) unchanged.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { enterpriseSettings } from "../src/db/schema";
import {
  CONVERSION_RATE_SETTING_KEY,
  readConversionRate,
  readStoredConversionRate,
  saveConversionRate,
} from "../src/gateway/conversion-rate-store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

async function clearConversionRateRow() {
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, CONVERSION_RATE_SETTING_KEY));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Wait until two sessions of `applicationName` are parked on a lock. That is the F1
 * interleaving made deterministic: both competing saves have finished their read and
 * are queued behind the row lock before either of them is allowed to write.
 */
async function waitForBlockedSaves(
  applicationName: string,
  aSettled: () => boolean,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await database.execute<{ blocked: number }>(sql`
      SELECT count(*)::int AS blocked
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
        AND cardinality(pg_blocking_pids(pid)) > 0
    `);
    if (([...rows][0]?.blocked ?? 0) >= 2) return;
    if (aSettled()) {
      throw new Error(
        "A competing save settled before both parked on the row lock; the F1 interleaving did not happen.",
      );
    }
    await new Promise((sleep) => setTimeout(sleep, 25));
  }
  throw new Error(
    `Timed out waiting for two blocked saves (${applicationName}).`,
  );
}

const INVALID_SAVES: { raw: string; reason: string }[] = [
  { raw: "", reason: "missing" },
  { raw: "0", reason: "zero" },
  { raw: "-3", reason: "negative" },
  { raw: "abc", reason: "invalid_format" },
  { raw: "1.1234567", reason: "precision_exceeded" },
  { raw: "1234567890", reason: "out_of_range" },
];

describe("conversion rate store (admin write path)", () => {
  beforeEach(clearConversionRateRow);
  afterEach(clearConversionRateRow);

  test("a deployment that never saved a rate reports billing unconfigured", async () => {
    const stored = await readStoredConversionRate(database);
    expect(stored.configured).toBe(false);
    if (!stored.configured) {
      expect(stored.reason).toBe("not_configured");
    }
    const effective = await readConversionRate(database);
    expect(effective.configured).toBe(false);
  });

  test.each(INVALID_SAVES)(
    "saving %s is refused with reason %s and persists nothing",
    async ({ raw, reason }) => {
      const saved = await saveConversionRate(database, raw, "admin-1");
      expect(saved.ok).toBe(false);
      if (!saved.ok) {
        expect(saved.reason).toBe(reason);
        expect(saved.message.length).toBeGreaterThan(0);
      }
      const stored = await readStoredConversionRate(database);
      expect(stored.configured).toBe(false);
    },
  );

  test("a valid rate saves as rateVersion 1 and reads back exactly", async () => {
    const saved = await saveConversionRate(database, "7.5", "admin-1");
    expect(saved).toEqual({
      ok: true,
      config: { numerator: 75n, denominator: 10n, rateVersion: 1 },
    });
    const stored = await readStoredConversionRate(database);
    expect(stored.configured && stored.config).toEqual({
      numerator: 75n,
      denominator: 10n,
      rateVersion: 1,
    });
    if (stored.configured) {
      expect(stored.savedBy).toBe("admin-1");
      expect(typeof stored.savedAt).toBe("string");
    }
  });

  test("a second save replaces the value and strictly increments the version", async () => {
    await saveConversionRate(database, "7.5", "admin-1");
    const second = await saveConversionRate(database, "12.34", "admin-2");
    expect(second).toEqual({
      ok: true,
      config: { numerator: 1234n, denominator: 100n, rateVersion: 2 },
    });
    const effective = await readConversionRate(database);
    expect(effective.configured && effective.config).toEqual({
      numerator: 1234n,
      denominator: 100n,
      rateVersion: 2,
    });
  });

  test("a fresh database handle (restart) reads the same exact value and version", async () => {
    await saveConversionRate(database, "0.000001", "admin-1");
    const restarted = createDatabase(testDatabaseUrl(), TEST_POOL);
    try {
      const stored = await readStoredConversionRate(restarted);
      expect(stored.configured && stored.config).toEqual({
        numerator: 1n,
        denominator: 1000000n,
        rateVersion: 1,
      });
    } finally {
      await restarted.$client.close();
    }
  });

  test("precision extremes round-trip without any float error", async () => {
    await clearConversionRateRow();
    await saveConversionRate(database, "999999999.123456", "admin-1");
    const stored = await readStoredConversionRate(database);
    expect(stored.configured && stored.config).toEqual({
      numerator: 999999999123456n,
      denominator: 1000000n,
      rateVersion: 1,
    });
  });

  test("a tampered stored row disables billing instead of falling back to a rate", async () => {
    // Write a non-positive numerator directly, bypassing the admin path.
    await database.insert(enterpriseSettings).values({
      key: CONVERSION_RATE_SETTING_KEY,
      value: {
        value: { numerator: "0", denominator: "1", rateVersion: 1 },
      },
      updatedBy: "db-tamper",
      updatedAt: new Date(),
    });
    const stored = await readStoredConversionRate(database);
    expect(stored.configured).toBe(false);
    if (!stored.configured) {
      expect(stored.reason).toBe("invalid");
    }
    const effective = await readConversionRate(database);
    expect(effective.configured).toBe(false);
  });

  test("competing concurrent saves commit distinct, strictly increasing versions", async () => {
    // Version 1 exists so both competitors race on an existing row, the exact shape
    // of review finding F1: two admins save at once and must not both be told v2.
    await saveConversionRate(database, "7.5", "admin-seed");

    const saversUrl = new URL(testDatabaseUrl());
    saversUrl.searchParams.set("application_name", "conversion_rate_f1_savers");
    const savers = createDatabase(saversUrl.toString(), TEST_POOL);
    const holderUrl = new URL(testDatabaseUrl());
    holderUrl.searchParams.set("application_name", "conversion_rate_f1_holder");
    const holderDatabase = createDatabase(holderUrl.toString(), TEST_POOL);

    const rowLocked = deferred();
    const releaseRow = deferred();
    let held: Promise<unknown> = Promise.resolve();
    try {
      // Park another writer on the target row, exactly like an in-flight save:
      // both competing saves must finish their read and then queue behind it.
      held = holderDatabase.transaction(async (tx) => {
        await tx
          .select()
          .from(enterpriseSettings)
          .where(eq(enterpriseSettings.key, CONVERSION_RATE_SETTING_KEY))
          .for("update");
        rowLocked.resolve();
        await releaseRow.promise;
      });
      await rowLocked.promise;

      const first = saveConversionRate(savers, "12.34", "admin-first");
      const second = saveConversionRate(savers, "0.5", "admin-second");
      const settled = { a: false, b: false };
      void first.then(
        () => {
          settled.a = true;
        },
        () => {
          settled.a = true;
        },
      );
      void second.then(
        () => {
          settled.b = true;
        },
        () => {
          settled.b = true;
        },
      );

      await waitForBlockedSaves(
        "conversion_rate_f1_savers",
        () => settled.a || settled.b,
      );
      releaseRow.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      await held;

      expect(firstResult.ok).toBe(true);
      expect(secondResult.ok).toBe(true);
      if (firstResult.ok && secondResult.ok) {
        expect(
          [
            firstResult.config.rateVersion,
            secondResult.config.rateVersion,
          ].sort((a, b) => a - b),
        ).toEqual([2, 3]);
        const winner =
          firstResult.config.rateVersion === 3 ? firstResult : secondResult;
        const stored = await readStoredConversionRate(database);
        expect(stored.configured).toBe(true);
        if (stored.configured) {
          expect(stored.config.rateVersion).toBe(3);
          expect(stored.config.numerator).toBe(winner.config.numerator);
          expect(stored.config.denominator).toBe(winner.config.denominator);
          expect(stored.savedBy).toBe(
            winner === firstResult ? "admin-first" : "admin-second",
          );
        }
      }
    } finally {
      releaseRow.resolve();
      await held.catch(() => undefined);
      await holderDatabase.$client.close();
      await savers.$client.close();
    }
  }, 10_000);
});
