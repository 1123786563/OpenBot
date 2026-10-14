import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
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
  await database.execute(
    sql`DELETE FROM billing_webhook_events WHERE provider = 'test' AND event_id LIKE ${`${prefix}%`}`,
  );
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
  expect(failure).toMatchObject({ retryable: false });
  // The driver's own error survives under `cause`, through whatever wrapped it on the way out.
  let driver = (failure as { cause?: unknown }).cause;
  while (
    driver instanceof BillingPersistenceError ||
    driver instanceof DrizzleQueryError
  ) {
    driver = (driver as { cause?: unknown }).cause;
  }
  expect(driver).toBeInstanceOf(Bun.SQL.PostgresError);
  expect(driver).toMatchObject({ errno: "23503" });
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

test("a final inbox failure rolls back staged customer and subscription projections", async () => {
  const externalId = `${prefix}-atomic`;
  const subscription = {
    externalCustomerId: externalId,
    externalSubscriptionId: `${prefix}-atomic-sub`,
    planCode: "pro",
    status: "active" as const,
  };
  const event = {
    provider: "test",
    eventId: `${prefix}-atomic-event`,
    // Force PostgreSQL's NOT NULL constraint at the final inbox write, not an earlier projection.
    webhookType: null as unknown as string,
  };
  let failure: unknown;
  try {
    await database.transaction(async (transaction) => {
      const local = createBillingStore(transaction);
      try {
        await local.applyWebhookProjection({
          customer: { externalId, name: "Authoritative Name" },
          subscriptions: [subscription],
          event,
        });
      } catch (error) {
        failure = error;
      }
      // The nested operation must roll back to its savepoint, leaving the parent usable.
      expect(await local.readSubscriptions(externalId)).toEqual([]);
      expect(await local.hasWebhookEvent(event.provider, event.eventId)).toBe(
        false,
      );
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(BillingPersistenceError);
  expect(failure).toMatchObject({ retryable: false });
  // The graded sentinel nests: the failing inner operation is wrapped by the apply, with the
  // driver's own error preserved at the bottom of the `cause` chain.
  let driver = (failure as { cause?: unknown }).cause;
  while (
    driver instanceof BillingPersistenceError ||
    driver instanceof DrizzleQueryError
  ) {
    driver = (driver as { cause?: unknown }).cause;
  }
  expect(driver).toBeInstanceOf(Bun.SQL.PostgresError);
  expect(driver).toMatchObject({ errno: "23502" });
  expect(await store.hasWebhookEvent(event.provider, event.eventId)).toBe(
    false,
  );
  expect(await store.readSubscriptions(externalId)).toEqual([]);
  const customers = await database
    .select()
    .from(billingCustomers)
    .where(eq(billingCustomers.externalId, externalId));
  expect(customers).toEqual([]);
  const input = {
    customer: { externalId, name: "Authoritative Name" },
    subscriptions: [subscription],
    event: { ...event, webhookType: "subscription.created" },
  };
  expect(await store.applyWebhookProjection(input)).toBe("processed");
  expect(await store.applyWebhookProjection(input)).toBe("duplicate");
  expect(await store.readSubscriptions(externalId)).toEqual([
    { ...subscription, updatedAt: expect.any(Date) },
  ]);
  expect(await store.hasWebhookEvent(event.provider, event.eventId)).toBe(true);
});

test("an atomic webhook rolls back existing projection updates on inbox failure", async () => {
  const externalId = `${prefix}-atomic-existing`;
  const subscription = {
    externalCustomerId: externalId,
    externalSubscriptionId: `${prefix}-atomic-existing-sub`,
    planCode: "pro",
    status: "active" as const,
  };
  await store.upsertCustomer({ externalId, name: "Original Name" });
  await store.upsertSubscription(subscription);
  const before = await store.readSubscriptions(externalId);
  const input = {
    customer: { externalId, name: "New Name" },
    subscriptions: [
      { ...subscription, status: "terminated" as const },
      { ...subscription, externalSubscriptionId: `${prefix}-atomic-new-sub` },
    ],
    event: {
      provider: "test",
      eventId: `${prefix}-atomic-existing-event`,
      webhookType: null as unknown as string,
    },
  };
  const rejection = await store.applyWebhookProjection(input).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(rejection).toBeInstanceOf(BillingPersistenceError);
  expect(rejection).toMatchObject({ retryable: false });
  expect(await store.readSubscriptions(externalId)).toEqual(before);
  const rows = await database
    .select({ name: billingCustomers.name })
    .from(billingCustomers)
    .where(eq(billingCustomers.externalId, externalId));
  expect(rows).toEqual([{ name: "Original Name" }]);
  expect(await store.hasWebhookEvent("test", input.event.eventId)).toBe(false);
  expect(
    await store.applyWebhookProjection({
      ...input,
      customer: { externalId },
      event: { ...input.event, webhookType: "subscription.terminated" },
    }),
  ).toBe("processed");
  const refreshed = await database
    .select({ name: billingCustomers.name })
    .from(billingCustomers)
    .where(eq(billingCustomers.externalId, externalId));
  expect(refreshed).toEqual([{ name: "Original Name" }]);
  expect(await store.readSubscriptions(externalId)).toHaveLength(2);
});

test("concurrent duplicate deliveries retain only the durable winner's projection", async () => {
  const event = {
    provider: "test",
    eventId: `${prefix}-atomic-race`,
    uniqueKey: `${prefix}-atomic-unique`,
    webhookType: "subscription.created",
    objectId: `${prefix}-atomic-object`,
  };
  const externalId = `${prefix}-atomic-race-customer`;
  const deliveries = ["First Name", "Second Name"].map((name, index) => ({
    customer: { externalId, name },
    subscriptions: [
      {
        externalCustomerId: externalId,
        externalSubscriptionId: `${prefix}-atomic-race-sub-${index}`,
        planCode: "pro",
        status: "active" as const,
      },
    ],
    event,
  }));
  const results = await Promise.all(
    deliveries.map((input) => store.applyWebhookProjection(input)),
  );
  expect([...results].sort()).toEqual(["duplicate", "processed"]);
  const winner = deliveries[results.indexOf("processed")]!;
  expect(await store.readSubscriptions(externalId)).toEqual([
    { ...winner.subscriptions[0], updatedAt: expect.any(Date) },
  ]);
  const customers = await database
    .select({ name: billingCustomers.name })
    .from(billingCustomers)
    .where(eq(billingCustomers.externalId, externalId));
  expect(customers).toEqual([{ name: winner.customer.name }]);
  expect(await store.applyWebhookProjection(deliveries[0]!)).toBe("duplicate");
  expect(await store.readSubscriptions(externalId)).toHaveLength(1);
});

test("an event without local projections commits and deduplicates atomically", async () => {
  const event = {
    provider: "test",
    eventId: `${prefix}-atomic-invoice`,
    webhookType: "invoice.created",
  };
  expect(await store.applyWebhookProjection({ event })).toBe("processed");
  expect(await store.applyWebhookProjection({ event })).toBe("duplicate");
  expect(await store.hasWebhookEvent("test", event.eventId)).toBe(true);
});

test("a real transaction-scoped lock timeout is retryable and leaves the delivery replayable", async () => {
  const externalId = `${prefix}-lock-timeout`;
  await store.upsertCustomer({ externalId, name: "Original Name" });
  const input = {
    customer: { externalId, name: "Refreshed Name" },
    subscriptions: [
      {
        externalCustomerId: externalId,
        externalSubscriptionId: `${prefix}-lock-sub`,
        planCode: "pro",
        status: "active" as const,
      },
    ],
    event: {
      provider: "test",
      eventId: `${prefix}-lock-event`,
      webhookType: "subscription.created",
    },
  };
  let failure: unknown;
  await database.transaction(async (holder) => {
    await holder.execute(
      sql`SELECT external_id FROM billing_customers WHERE external_id = ${externalId} FOR UPDATE`,
    );
    await database.transaction(async (contender) => {
      await contender.execute(sql`SET LOCAL lock_timeout = '50ms'`);
      try {
        await createBillingStore(contender).applyWebhookProjection(input);
      } catch (error) {
        failure = error;
      }
      expect(
        await createBillingStore(contender).readSubscriptions(externalId),
      ).toEqual([]);
    });
  });
  expect(failure).toBeInstanceOf(BillingPersistenceError);
  expect(failure).toMatchObject({
    operation: "customer_upsert",
    retryable: true,
  });
  expect(await store.hasWebhookEvent("test", input.event.eventId)).toBe(false);
  expect(await store.readSubscriptions(externalId)).toEqual([]);
  const customers = await database
    .select({ name: billingCustomers.name })
    .from(billingCustomers)
    .where(eq(billingCustomers.externalId, externalId));
  expect(customers).toEqual([{ name: "Original Name" }]);
  expect(await store.applyWebhookProjection(input)).toBe("processed");
  expect(await store.applyWebhookProjection(input)).toBe("duplicate");
  expect(await store.hasWebhookEvent("test", input.event.eventId)).toBe(true);
  expect(await store.readSubscriptions(externalId)).toHaveLength(1);
});

test("a subscription the provider no longer lists is retired, not left active", async () => {
  const customer = `${prefix}-retire`;
  await store.upsertCustomer({ externalId: customer, name: null });
  await store.upsertSubscription({
    externalCustomerId: customer,
    externalSubscriptionId: `${prefix}-s-old`,
    planCode: "standard",
    status: "active",
  });
  await store.upsertSubscription({
    externalCustomerId: customer,
    externalSubscriptionId: `${prefix}-s-new`,
    planCode: "pro",
    status: "active",
  });

  const retired = await store.retireAbsentSubscriptions(customer, [
    `${prefix}-s-new`,
  ]);

  expect(retired).toBe(1);
  const rows = await store.readSubscriptions(customer);
  expect(
    rows.find((row) => row.externalSubscriptionId === `${prefix}-s-old`)
      ?.status,
  ).toBe("terminated");
  expect(
    rows.find((row) => row.externalSubscriptionId === `${prefix}-s-new`)
      ?.status,
  ).toBe("active");
});

test("retiring is idempotent and never touches another customer", async () => {
  const customer = `${prefix}-retire-a`;
  const other = `${prefix}-retire-b`;
  await store.upsertCustomer({ externalId: customer, name: null });
  await store.upsertCustomer({ externalId: other, name: null });
  await store.upsertSubscription({
    externalCustomerId: customer,
    externalSubscriptionId: `${prefix}-s-a`,
    planCode: "standard",
    status: "active",
  });
  await store.upsertSubscription({
    externalCustomerId: other,
    externalSubscriptionId: `${prefix}-s-b`,
    planCode: "standard",
    status: "active",
  });

  expect(await store.retireAbsentSubscriptions(customer, [])).toBe(1);
  expect(await store.retireAbsentSubscriptions(customer, [])).toBe(0);
  expect((await store.readSubscriptions(other))[0]?.status).toBe("active");
});

test("onRetired reports only what a committed transaction moved (audit B6 review r1)", async () => {
  const externalId = `${prefix}-onretired`;
  await store.upsertCustomer({ externalId, name: null });
  await store.upsertSubscription({
    externalCustomerId: externalId,
    externalSubscriptionId: `${prefix}-onretired-a`,
    planCode: "pro",
    status: "active" as const,
  });
  await store.upsertSubscription({
    externalCustomerId: externalId,
    externalSubscriptionId: `${prefix}-onretired-b`,
    planCode: "base",
    status: "active" as const,
  });
  const retired: { externalCustomerId: string; count: number }[] = [];

  // A rolled-back apply: the retirement stages inside the transaction, then the inbox write
  // fails (the null webhook_type violates its constraint) and everything rolls back — the
  // buffered notification must go with it, never escape a delivery that moved nothing durable.
  const rejection = await store
    .applyWebhookProjection({
      customer: { externalId, name: null },
      subscriptionsPresentFor: externalId,
      onRetired: (info) => retired.push(info),
      event: {
        provider: "test",
        eventId: `${prefix}-onretired-rollback`,
        webhookType: null as unknown as string,
      },
    })
    .then(
      () => null,
      (thrown: unknown) => thrown,
    );
  expect(rejection).toBeInstanceOf(BillingPersistenceError);
  expect(rejection).toMatchObject({ retryable: false });
  expect(retired).toEqual([]);
  expect(
    (await store.readSubscriptions(externalId)).every(
      (row) => row.status === "active",
    ),
  ).toBe(true);

  // A committed apply: the count is what the transaction itself moved, from the transaction.
  expect(
    await store.applyWebhookProjection({
      customer: { externalId },
      subscriptions: [
        {
          externalCustomerId: externalId,
          externalSubscriptionId: `${prefix}-onretired-b`,
          planCode: "base",
          status: "active" as const,
        },
      ],
      subscriptionsPresentFor: externalId,
      onRetired: (info) => retired.push(info),
      event: {
        provider: "test",
        eventId: `${prefix}-onretired-commit`,
        webhookType: "subscription.updated",
      },
    }),
  ).toBe("processed");
  expect(retired).toEqual([{ externalCustomerId: externalId, count: 1 }]);
  expect(
    (await store.readSubscriptions(externalId)).find(
      (row) => row.externalSubscriptionId === `${prefix}-onretired-a`,
    )?.status,
  ).toBe("terminated");
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
