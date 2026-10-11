import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createDatabase } from "../src/db/client";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * QA batch-2 probes (a)(b)(c): the credit engine's withdrawal under REAL concurrency against a
 * real PostgreSQL, at one grade harder than the author's own suite:
 *
 *   (a) EIGHT concurrent draws whose total exceeds the grant — the author tested 4×400 > 1000;
 *       this runs 8 × 300 > 1000 AND adds the boundary shape (total == capacity exactly), where
 *       the last winner's loop must terminate on `toApply === 0`, not on a phantom capacity.
 *   (b) the idempotency key under a RACE, not just a sequential retry — two concurrent reports
 *       of one key: one draws, one answers the first's facts; and the DB holds exactly one row.
 *   (c) the post-paid shortfall across MULTIPLE grants (split + shortfall in one draw).
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const prefix = `qa2-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await database.execute(
    sql`DELETE FROM credit_ledger WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_grants WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`${prefix}%`}`,
  );
  await database.$client.close();
});

async function seed(customer: string, total: number, tag: string, expiresAt = new Date(Date.now() + 24 * 3600_000)) {
  return writer.grantCredits({
    externalCustomerId: customer,
    source: "promo",
    totalCents: total,
    expiresAt,
    reason: tag,
    idempotencyKey: `${prefix}-seed-${tag}-${randomUUID().slice(0, 8)}`,
  });
}

test("probe a: eight concurrent draws of 300 on a 1000 grant — Σapplied == 1000, never more", async () => {
  const customer = `${prefix}-a`;
  await seed(customer, 1_000, "a");
  const draws = await Promise.all(
    Array.from({ length: 8 }, (_, n) =>
      writer.consumeCredits({
        externalCustomerId: customer,
        amountCents: 300, // 8 × 300 = 2400 > 1000
        idempotencyKey: `${prefix}-draw-a-${n}`,
        title: "模型调用",
      }),
    ),
  );
  // No draw threw; every draw answered.
  expect(draws).toHaveLength(8);

  const appliedSum = draws.reduce((sum, draw) => sum + draw.applied, 0);
  expect(appliedSum).toBe(1_000); // exactly the capacity — no overdraw, no underdraw

  // The database agrees: used == total, no negative anywhere, ledger rows all landed.
  const [grant] = await database
    .select({ used: creditGrants.used, total: creditGrants.total })
    .from(creditGrants)
    .where(eq(creditGrants.externalCustomerId, customer));
  expect(grant.used).toBe(grant.total);
  expect(grant.used).toBeLessThanOrEqual(grant.total);

  const ledgerRows = await database
    .select({ credits: creditLedger.credits, applied: creditLedger.applied })
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, customer));
  expect(ledgerRows).toHaveLength(8);
  // The ledger's full truth: every row records its whole 300 cost; Σapplied == the grant.
  expect(ledgerRows.every((row) => row.credits === 300)).toBe(true);
  expect(ledgerRows.reduce((sum, row) => sum + row.applied, 0)).toBe(1_000);
  // The overdraw is visible, not hidden: Σcredits - Σapplied == 1400 == the shortfall.
  expect(
    ledgerRows.reduce((sum, row) => sum + row.credits, 0) -
      ledgerRows.reduce((sum, row) => sum + row.applied, 0),
  ).toBe(8 * 300 - 1_000);
  expect(await writer.readBalance(customer)).toBe(0);
});

test("probe a-boundary: concurrent draws totalling EXACTLY the capacity — all applied in full", async () => {
  const customer = `${prefix}-ab`;
  await seed(customer, 1_200, "ab");
  // 8 × 150 = 1200 exactly: the last draw's loop must end on toApply === 0.
  const draws = await Promise.all(
    Array.from({ length: 8 }, (_, n) =>
      writer.consumeCredits({
        externalCustomerId: customer,
        amountCents: 150,
        idempotencyKey: `${prefix}-draw-ab-${n}`,
        title: "模型调用",
      }),
    ),
  );
  expect(draws.reduce((sum, draw) => sum + draw.applied, 0)).toBe(1_200);
  expect(draws.every((draw) => draw.applied === 150)).toBe(true);
  expect(await writer.readBalance(customer)).toBe(0);
});

test("probe b: two CONCURRENT reports of one idempotency key — exactly one ledger row, one draw", async () => {
  const customer = `${prefix}-b`;
  await seed(customer, 1_000, "b");
  const key = `${prefix}-draw-b-race`;
  const [first, second] = await Promise.all([
    writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: 400,
      idempotencyKey: key,
      title: "模型调用",
    }),
    writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: 400,
      idempotencyKey: key,
      title: "模型调用",
    }),
  ]);
  // Exactly one insert; the other answers the winner's applied — the balance moved once.
  expect([first.inserted, second.inserted].filter(Boolean)).toHaveLength(1);
  expect(first.applied).toBe(400);
  expect(second.applied).toBe(400);

  const rows = await database
    .select({ credits: creditLedger.credits, applied: creditLedger.applied })
    .from(creditLedger)
    .where(eq(creditLedger.idempotencyKey, key));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ credits: 400, applied: 400 });
  expect(await writer.readBalance(customer)).toBe(600);
});

test("probe c: a shortfall draw across two grants — split first, then the honest overdraw", async () => {
  const customer = `${prefix}-c`;
  await seed(customer, 300, "c-soon", new Date(Date.now() + 1 * 3600_000));
  await seed(customer, 500, "c-late", new Date(Date.now() + 24 * 3600_000));
  // Total live capacity 800; the call cost 1_000 — the grants draw to zero in expiry order,
  // the ledger keeps 1_000, applied == 800, the 200 shortfall is visible.
  const result = await writer.consumeCredits({
    externalCustomerId: customer,
    amountCents: 1_000,
    idempotencyKey: `${prefix}-draw-c`,
    title: "模型调用",
  });
  expect(result.inserted).toBe(true);
  expect(result.applied).toBe(800);
  expect(result.remaining).toBe(0);

  const [row] = await database
    .select({ credits: creditLedger.credits, applied: creditLedger.applied })
    .from(creditLedger)
    .where(eq(creditLedger.idempotencyKey, `${prefix}-draw-c`));
  expect(row).toEqual({ credits: 1_000, applied: 800 });

  // Both grants exhausted, in the right order: the soon one first.
  const grants = await database
    .select({ reason: creditGrants.reason, used: creditGrants.used, total: creditGrants.total })
    .from(creditGrants)
    .where(eq(creditGrants.externalCustomerId, customer));
  expect(grants.every((g) => g.used === g.total)).toBe(true);
  expect(await writer.readBalance(customer)).toBe(0);
});

test("probe c-negative: a negative or fractional cost is refused before any row moves", async () => {
  const customer = `${prefix}-cn`;
  await seed(customer, 500, "cn");
  await expect(
    writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: -100,
      idempotencyKey: `${prefix}-draw-cn-1`,
      title: "模型调用",
    }),
  ).rejects.toThrow(TypeError);
  await expect(
    writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: 10.5,
      idempotencyKey: `${prefix}-draw-cn-2`,
      title: "模型调用",
    }),
  ).rejects.toThrow(TypeError);
  expect(await writer.readBalance(customer)).toBe(500);
});
