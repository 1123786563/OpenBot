import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createBillingStore } from "../src/billing/store";
import { BillingPersistenceError } from "../src/billing/types";
import { createDatabase } from "../src/db/client";
import { billingCustomers } from "../src/db/schema/billing";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The three billing tables against a real PostgreSQL, gated on TEST_DATABASE_URL the way the rest
 * of the integration suite is (tests/support/database.ts refuses the live `openbot` database).
 * Every statement is parameter-bound through drizzle's `sql` template.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createBillingStore(database);
const prefix = `billing-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await database.execute(
    sql`DELETE FROM billing_subscriptions WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(sql`DELETE FROM billing_webhook_events WHERE provider = 'test'`);
  await database.$client.close();
});

test("customer upserts are keyed on the external id, not accumulated", async () => {
  const externalId = `${prefix}-customer`;
  await store.upsertCustomer({ externalId, name: "First Name" });
  await store.upsertCustomer({ externalId, name: "Second Name" });
  const rows = await database.execute(
    sql`SELECT name FROM billing_customers WHERE external_id = ${externalId}`,
  );
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ name: "Second Name" });
});

test("subscription upserts converge and the status check holds", async () => {
  const externalId = `${prefix}-status`;
  await store.upsertCustomer({ externalId, name: null });
  const row = {
    externalCustomerId: externalId,
    externalSubscriptionId: `${prefix}-subscription`,
    planCode: "pro",
    status: "active" as const,
  };
  await store.upsertSubscription(row);
  await store.upsertSubscription({ ...row, status: "terminated" });

  expect(await store.readSubscriptions(externalId)).toEqual([
    { ...row, status: "terminated", updatedAt: expect.any(Date) },
  ]);

  // A status outside the four the sync reads is the database's problem to refuse. The check fires
  // on execute, so the statement is awaited by hand rather than handed to `rejects` (drizzle's
  // execute returns a lazy query object).
  let refused = false;
  try {
    await database.execute(sql`
      INSERT INTO billing_subscriptions
        (external_customer_id, external_subscription_id, plan_code, status)
      VALUES (${externalId}, ${`${prefix}-bad`}, 'pro', 'pending')
    `);
  } catch {
    refused = true;
  }
  expect(refused).toBe(true);
});

test("ensureCustomerRow inserts only: a placeholder never overwrites a landed name", async () => {
  const externalId = `${prefix}-floor`;
  await store.upsertCustomer({ externalId, name: "The Real Name" });
  await store.ensureCustomerRow({ externalId });
  await store.ensureCustomerRow({ externalId });
  const named = await database
    .select({ name: billingCustomers.name })
    .from(billingCustomers)
    .where(eq(billingCustomers.externalId, externalId));
  expect(named.length).toBe(1);
  expect(named[0]).toMatchObject({ name: "The Real Name" });

  // Absent, it lands the nameless row a subscription projection's foreign key needs.
  const placeholderId = `${prefix}-floor-absent`;
  await store.ensureCustomerRow({ externalId: placeholderId });
  const placeholder = await database
    .select({ name: billingCustomers.name })
    .from(billingCustomers)
    .where(eq(billingCustomers.externalId, placeholderId));
  expect(placeholder.length).toBe(1);
  expect(placeholder[0]).toMatchObject({ name: null });

  // And the foreign key the floor exists for is real: a subscription for a customer with no row
  // is refused by the database, not absorbed.
  let failure: unknown;
  try {
    await store.upsertSubscription({
      externalCustomerId: `${prefix}-no-such-customer`,
      externalSubscriptionId: `${prefix}-floor-sub`,
      planCode: "pro",
      status: "active",
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(BillingPersistenceError);
  expect(failure).toMatchObject({
    code: "persistence_failure",
    retryable: true,
    operation: "subscription_upsert",
  });
});

test("deleting a customer cascades to its subscriptions", async () => {
  const externalId = `${prefix}-cascade`;
  await store.upsertCustomer({ externalId, name: null });
  await store.upsertSubscription({
    externalCustomerId: externalId,
    externalSubscriptionId: `${prefix}-cascade-sub`,
    planCode: "pro",
    status: "active" as const,
  });
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id = ${externalId}`,
  );
  expect(await store.readSubscriptions(externalId)).toEqual([]);
});

test("the webhook inbox deduplicates on provider + event_id", async () => {
  const first = await store.recordWebhookEvent({
    provider: "test",
    eventId: `${prefix}-event`,
    uniqueKey: `${prefix}-unique-key`,
    webhookType: "subscription.created",
    objectId: "object-1",
  });
  expect(first).toBe(true);
  const second = await store.recordWebhookEvent({
    provider: "test",
    eventId: `${prefix}-event`,
    webhookType: "subscription.created",
  });
  expect(second).toBe(false);

  expect(await store.hasWebhookEvent("test", `${prefix}-event`)).toBe(true);
  expect(await store.hasWebhookEvent("test", `${prefix}-missing`)).toBe(false);
  expect(await store.hasWebhookEvent("other", `${prefix}-event`)).toBe(false);
});

test("snapshot counts customers, subscriptions and the latest sync", async () => {
  const counted = await database.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM billing_customers)::int AS customers,
      (SELECT COUNT(*) FROM billing_subscriptions)::int AS subscriptions
  `);
  const beforeCustomers = counted[0]?.customers ?? 0;
  const beforeSubscriptions = counted[0]?.subscriptions ?? 0;

  const externalId = `${prefix}-snapshot`;
  await store.upsertCustomer({ externalId, name: null });
  await store.upsertSubscription({
    externalCustomerId: externalId,
    externalSubscriptionId: `${prefix}-snapshot-sub`,
    planCode: "pro",
    status: "active" as const,
  });
  const snapshot = await store.snapshot();
  expect(snapshot.customers).toBe(beforeCustomers + 1);
  expect(snapshot.subscriptions).toBe(beforeSubscriptions + 1);
  expect(snapshot.lastSyncedAt).toBeInstanceOf(Date);
});
