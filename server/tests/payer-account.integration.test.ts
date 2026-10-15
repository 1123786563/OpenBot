import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const prefix = `payertest-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await database.execute(sql`DELETE FROM payer_accounts WHERE external_customer_id LIKE ${`${prefix}%`}`);
  await database.execute(sql`DELETE FROM credit_ledger WHERE external_customer_id LIKE ${`${prefix}%`}`);
  await database.execute(sql`DELETE FROM credit_grants WHERE external_customer_id LIKE ${`${prefix}%`}`);
  await database.execute(sql`DELETE FROM billing_customers WHERE external_id LIKE ${`${prefix}%`}`);
  await database.$client.close();
});

test("concurrent creation converges on one account and one mapping", async () => {
  const ref = { kind: "personal" as const, id: `${prefix}-user-1` };
  const [a, b] = await Promise.all([
    createPayerAccount(database, ref),
    createPayerAccount(database, ref),
  ]);
  expect(a.externalCustomerId).toBe(b.externalCustomerId);
  const rows = await database.execute(
    sql`SELECT external_customer_id FROM payer_accounts WHERE payer_kind = 'personal' AND external_ref = ${ref.id}`,
  );
  expect(rows).toHaveLength(1);
  expect(await payerKey(database, ref)).toBe(a.externalCustomerId);
});

test("one external_customer_id cannot be claimed by two payers", async () => {
  const r1 = await createPayerAccount(database, { kind: "personal", id: `${prefix}-user-2` });
  const second = await database.execute(
    sql`INSERT INTO payer_accounts (id, payer_kind, external_ref, external_customer_id) VALUES (${`${prefix}-dup`}, 'company', ${`${prefix}-tenant-2`}, ${r1.externalCustomerId}) ON CONFLICT DO NOTHING RETURNING id`,
  );
  expect(second).toHaveLength(0);
});

test("accounts are isolated: a grant to A never shows in B's balance", async () => {
  const a = await createPayerAccount(database, { kind: "personal", id: `${prefix}-user-3` });
  const b = await createPayerAccount(database, { kind: "personal", id: `${prefix}-user-4` });
  await writer.grantCredits({
    externalCustomerId: a.externalCustomerId,
    source: "promo",
    totalCents: 1_000,
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    idempotencyKey: `${prefix}-grant-3`,
  });
  expect(await writer.availableBalance(a.externalCustomerId)).toBeGreaterThan(0);
  expect(await writer.availableBalance(b.externalCustomerId)).toBe(0);
});

test("creating an account grants no balance", async () => {
  const c = await createPayerAccount(database, { kind: "personal", id: `${prefix}-user-5` });
  expect(await writer.availableBalance(c.externalCustomerId)).toBe(0);
});
