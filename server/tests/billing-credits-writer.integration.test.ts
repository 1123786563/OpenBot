import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createDatabase } from "../src/db/client";
import { creditGrants } from "../src/db/schema/credits";
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
