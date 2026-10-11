import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createDatabase } from "../src/db/client";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The credit writer against a real PostgreSQL, gated on TEST_DATABASE_URL the way the rest of
 * the integration suite is. The two guarantees under test: a keyed grant happens exactly once
 * (the partial unique index is the authority, not a read-check), and the customer floor lets a
 * first-ever grant create its own customer row instead of failing on the foreign key.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const prefix = `cgtest-${randomUUID().slice(0, 8)}`;

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

test("a keyed grant inserts once; the retry answers the existing row", async () => {
  const key = `${prefix}-key-1`;
  const first = await writer.grantCredits({
    externalCustomerId: `${prefix}-customer`,
    source: "plan",
    totalCents: 900_000, // 9000 credits, ×100
    expiresAt: new Date("2026-11-01T00:00:00Z"),
    reason: "plan allowance · pro · order po-x",
    idempotencyKey: key,
  });
  expect(first.inserted).toBe(true);
  expect(first.grant.total).toBe(900_000);
  expect(first.grant.used).toBe(0);

  // The retried activation, the replayed callback, the sweep's next pass: same key, one row.
  const retry = await writer.grantCredits({
    externalCustomerId: `${prefix}-customer`,
    source: "plan",
    totalCents: 900_000,
    expiresAt: new Date("2026-11-01T00:00:00Z"),
    reason: "plan allowance · pro · order po-x",
    idempotencyKey: key,
  });
  expect(retry.inserted).toBe(false);
  expect(retry.grant.id).toBe(first.grant.id);

  const rows = await database
    .select({ id: creditGrants.id })
    .from(creditGrants)
    .where(eq(creditGrants.idempotencyKey, key));
  expect(rows).toHaveLength(1);
});

test("a keyless grant always inserts: two presses mean two grants", async () => {
  const customer = `${prefix}-promo`;
  const grant = (totalCents: number) =>
    writer.grantCredits({
      externalCustomerId: customer,
      source: "promo",
      totalCents,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      reason: "运营活动",
      idempotencyKey: null,
    });
  const first = await grant(1_000);
  const second = await grant(1_000);
  expect(first.inserted).toBe(true);
  expect(second.inserted).toBe(true);
  expect(second.grant.id).not.toBe(first.grant.id);
});

test("the customer floor: a first-ever grant creates its own customer row", async () => {
  const customer = `${prefix}-never-seen`;
  const { grant } = await writer.grantCredits({
    externalCustomerId: customer,
    source: "signin",
    totalCents: 500,
    expiresAt: new Date("2026-12-01T00:00:00Z"),
  });
  expect(grant.externalCustomerId).toBe(customer);
  const rows = await database.execute(
    sql`SELECT external_id FROM billing_customers WHERE external_id = ${customer}`,
  );
  expect(rows.length).toBe(1);
});

test("a fractional or negative amount is refused before any insert", async () => {
  await expect(
    writer.grantCredits({
      externalCustomerId: `${prefix}-bad`,
      source: "promo",
      totalCents: 10.5,
      expiresAt: new Date("2026-12-01T00:00:00Z"),
    }),
  ).rejects.toThrow(TypeError);
  await expect(
    writer.grantCredits({
      externalCustomerId: `${prefix}-bad`,
      source: "promo",
      totalCents: -1,
      expiresAt: new Date("2026-12-01T00:00:00Z"),
    }),
  ).rejects.toThrow(TypeError);
});


/*
 * The withdrawal half. The spec's four states, each pinned against real SQL: the split across
 * grants, the idempotent retry, the honest shortfall, and the concurrent draws. Grants are
 * seeded through grantCredits so each test owns exact balances on its own customer.
 */
describe("consumeCredits", () => {
  async function seedGrant(
    customer: string,
    total: number,
    tag: string,
    expiresAt = new Date(Date.now() + 24 * 3600_000),
  ) {
    const { grant } = await writer.grantCredits({
      externalCustomerId: customer,
      source: "promo",
      totalCents: total,
      expiresAt,
      reason: tag,
      idempotencyKey: `${prefix}-seed-${tag}-${randomUUID().slice(0, 8)}`,
    });
    return grant.id;
  }

  test("a draw within one grant applies in full and reports the remainder", async () => {
    const customer = `${prefix}-c1`;
    await seedGrant(customer, 1_000, "one");
    const result = await writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: 300,
      idempotencyKey: `${prefix}-draw-1`,
      title: "模型调用",
    });
    expect(result.inserted).toBe(true);
    expect(result.applied).toBe(300);
    expect(result.remaining).toBe(700);
    expect(await writer.readBalance(customer)).toBe(700);
  });

  test("a draw spanning two grants splits soonest-expiry-first", async () => {
    const customer = `${prefix}-c2`;
    // The LATER-expiring grant is bigger; the draw must eat the SOONER one dry first.
    await seedGrant(customer, 400, "soon", new Date(Date.now() + 1 * 3600_000));
    await seedGrant(customer, 2_000, "late", new Date(Date.now() + 24 * 3600_000));
    const result = await writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: 600,
      idempotencyKey: `${prefix}-draw-2`,
      title: "模型调用",
    });
    expect(result.applied).toBe(600);
    expect(result.remaining).toBe(1_800);
    const [row] = await database
      .select({ grantId: creditLedger.grantId, credits: creditLedger.credits })
      .from(creditLedger)
      .where(eq(creditLedger.idempotencyKey, `${prefix}-draw-2`));
    expect(row?.credits).toBe(600);
    expect(row?.grantId).not.toBeNull();
  });

  test("a retried report of the same key is the first answer, never a second draw", async () => {
    const customer = `${prefix}-c3`;
    await seedGrant(customer, 1_000, "idem");
    const first = await writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: 200,
      idempotencyKey: `${prefix}-draw-3`,
      title: "模型调用",
    });
    expect(first.inserted).toBe(true);
    const retry = await writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: 200,
      idempotencyKey: `${prefix}-draw-3`,
      title: "模型调用",
    });
    expect(retry.inserted).toBe(false);
    expect(retry.applied).toBe(200);
    expect(await writer.readBalance(customer)).toBe(800);
  });

  test("a cost beyond the balance: the ledger keeps the whole truth, grants draw to zero", async () => {
    const customer = `${prefix}-c4`;
    await seedGrant(customer, 250, "short");
    const result = await writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: 1_000,
      idempotencyKey: `${prefix}-draw-4`,
      title: "模型调用",
    });
    expect(result.inserted).toBe(true);
    expect(result.applied).toBe(250);
    expect(result.remaining).toBe(0);
    const [row] = await database
      .select({ credits: creditLedger.credits, applied: creditLedger.applied })
      .from(creditLedger)
      .where(eq(creditLedger.idempotencyKey, `${prefix}-draw-4`));
    expect(row).toEqual({ credits: 1_000, applied: 250 });
  });

  test("a zero-balance draw is still recorded — consumption facts stand without funding", async () => {
    const customer = `${prefix}-c5`;
    const result = await writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: 500,
      idempotencyKey: `${prefix}-draw-5`,
      title: "模型调用",
    });
    expect(result.inserted).toBe(true);
    expect(result.applied).toBe(0);
    const [row] = await database
      .select({ credits: creditLedger.credits, applied: creditLedger.applied })
      .from(creditLedger)
      .where(eq(creditLedger.idempotencyKey, `${prefix}-draw-5`));
    expect(row).toEqual({ credits: 500, applied: 0 });
  });

  test("an expired grant funds nothing", async () => {
    const customer = `${prefix}-c6`;
    await seedGrant(customer, 1_000, "expired", new Date(Date.now() - 1_000));
    const result = await writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: 100,
      idempotencyKey: `${prefix}-draw-6`,
      title: "模型调用",
    });
    expect(result.applied).toBe(0);
    expect(await writer.readBalance(customer)).toBe(0);
  });

  test("concurrent draws never overdraw: racing draws absorb at most the grant's total", async () => {
    const customer = `${prefix}-c7`;
    await seedGrant(customer, 1_000, "race");
    const draws = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        writer.consumeCredits({
          externalCustomerId: customer,
          amountCents: 400, // 4 × 400 = 1600 > 1000: the row lock must hold.
          idempotencyKey: `${prefix}-draw-7-${n}`,
          title: "模型调用",
        }),
      ),
    );
    const applied = draws.reduce((sum, draw) => sum + draw.applied, 0);
    expect(applied).toBe(1_000);
    expect(await writer.readBalance(customer)).toBe(0);
  });
});
