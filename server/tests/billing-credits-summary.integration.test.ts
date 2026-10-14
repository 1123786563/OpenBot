import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createCredits } from "../src/billing/credits";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The read side of the ledger against a real database (audit A1): the summary must show only
 * what admission would actually let you spend — expired grants excluded, active holds subtracted
 * — and `grantCount` must count exactly the grants behind `remaining`.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const credits = createCredits({
  database,
  externalCustomerKey: "",
  catalog: new Map(),
});
const prefix = `sumtest-${randomUUID().slice(0, 8)}`;

// The same teardown discipline the other integration suites use: delete by the run's own prefix,
// children first, then close the pool. No shared fixture, no cross-test coupling.
afterAll(async () => {
  const { sql } = await import("drizzle-orm");
  // Allocation ids are random `cra-…`, so they are reached by subquery through their reservation,
  // never by their own id prefix.
  await database.execute(
    sql`DELETE FROM credit_reservation_allocations WHERE reservation_id IN (SELECT id FROM credit_reservations WHERE external_customer_id LIKE ${`${prefix}%`})`,
  );
  await database.execute(
    sql`DELETE FROM credit_reservations WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_charge_remainders WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_ledger WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_grants WHERE idempotency_key LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`${prefix}%`}`,
  );
  await database.$client.close();
});

test("an expired grant is not part of the balance, and a live hold is", async () => {
  const customer = `${prefix}-a`;
  const live = `${prefix}-live`;
  const expired = `${prefix}-expired`;

  await writer.grantCredits({
    externalCustomerId: customer,
    source: "plan",
    totalCents: 10_000,
    expiresAt: new Date(Date.now() + 86_400_000),
    idempotencyKey: live,
  });
  await writer.grantCredits({
    externalCustomerId: customer,
    source: "promo",
    totalCents: 5_000,
    expiresAt: new Date(Date.now() - 1_000),
    idempotencyKey: expired,
  });

  const beforeHold = await credits.summary(customer);
  expect(beforeHold.plan).toEqual({ total: 100, used: 0, remaining: 100, held: 0 });
  expect(beforeHold.rewards.remaining).toBe(0);
  expect(beforeHold.rewards.grantCount).toBe(0);
  expect(beforeHold.rewards.total).toBe(0);

  const reserved = await writer.reserveCredits({
    externalCustomerId: customer,
    idempotencyKey: `${prefix}-hold`,
    maximumCents: 2_100,
    expiresAt: new Date(Date.now() + 60_000),
  });
  expect(reserved.reserved).toBe(true);

  const held = await credits.summary(customer);
  expect(held.plan.held).toBe(21);
  expect(held.plan.remaining).toBe(79);

  if (reserved.reserved) {
    await writer.releaseReservation(reserved.reservationId, "test");
  }
  const released = await credits.summary(customer);
  expect(released.plan.remaining).toBe(100);
  expect(released.plan.held).toBe(0);

  // The page and the gate agree, to within the one unit a carried remainder occupies.
  const spendable = await writer.availableBalance(customer);
  expect(released.plan.remaining * 100 + released.rewards.remaining * 100 - spendable).toBeLessThanOrEqual(1);
});
