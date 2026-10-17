import { afterAll, expect, test } from "../../tests/support/e2e-compat";
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { createCredits } from "../src/billing/credits";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createDatabase } from "../src/db/client";
import { billingCustomers } from "../src/db/schema/billing";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The consumption read against a real database (audit D1): a settlement that cost more than
 * the grants could fund records the full cost in `credits` and only what was funded in
 * `applied` — the page's ledger line must carry BOTH numbers, so the shortfall survives the
 * scale-down and the wire instead of hiding behind hand-written SQL.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const prefix = `consumption-${randomUUID().slice(0, 8)}`;

// The same teardown discipline the other integration suites use: one customer delete cascades
// the credit side (grants, ledger, reservations, allocations, remainders all reference
// billing_customers ON DELETE CASCADE), then the pool closes.
afterAll(async () => {
  await database
    .delete(billingCustomers)
    .where(like(billingCustomers.externalId, `${prefix}%`));
  await database.$client.close();
});

test("a consumption entry carries what the grants absorbed beside what the call cost", async () => {
  const customer = `${prefix}-consumption`;
  await writer.grantCredits({
    externalCustomerId: customer,
    source: "promo",
    totalCents: 100,
    expiresAt: new Date(Date.now() + 86_400_000),
    idempotencyKey: `${customer}-g`,
  });
  const reserved = await writer.reserveCredits({
    externalCustomerId: customer,
    idempotencyKey: `${customer}-r`,
    maximumCents: 100,
    expiresAt: new Date(Date.now() + 60_000),
  });
  if (!reserved.reserved) throw new Error("test setup: the hold should fit");
  await writer.settleReservation({
    reservationId: reserved.reservationId,
    actual: { numerator: 250n, denominator: 1n },
    title: "over-bound settlement",
  });

  // The account key rides in the constructor now (02.4's convergence): the read no longer names
  // a customer.
  const credits = createCredits({
    database,
    externalCustomerKey: customer,
    catalog: new Map(),
  });
  const page = await credits.consumption({ from: null, to: null, page: 1 });
  expect(page.entries[0]).toMatchObject({ credits: 2.5, applied: 1 });
});
