import { expect, test } from "bun:test";
import { createBillingStore } from "../src/billing/store";
import type { Database } from "../src/db/client";

test("a synchronous programming error from query construction is not retryable", async () => {
  const failure = new TypeError("invalid query construction");
  const database = {
    insert() {
      throw failure;
    },
  } as unknown as Database;

  await expect(
    createBillingStore(database).upsertCustomer({
      externalId: "customer-1",
      name: null,
    }),
  ).rejects.toBe(failure);
});

test("a transient PostgreSQL connection failure is marked retryable", async () => {
  const failure = new Bun.SQL.PostgresError("connection lost", {
    code: "08006",
  });
  const database = {
    insert() {
      return {
        values() {
          return {
            onConflictDoUpdate() {
              return Promise.reject(failure);
            },
          };
        },
      };
    },
  } as unknown as Database;

  await expect(
    createBillingStore(database).upsertCustomer({
      externalId: "customer-1",
      name: null,
    }),
  ).rejects.toMatchObject({
    name: "BillingPersistenceError",
    operation: "customer_upsert",
  });
});

test("a PostgreSQL constraint violation is not classified as retryable", async () => {
  const failure = new Bun.SQL.PostgresError("foreign key violation", {
    code: "23503",
  });
  const database = {
    insert() {
      return {
        values() {
          return {
            onConflictDoUpdate() {
              return Promise.reject(failure);
            },
          };
        },
      };
    },
  } as unknown as Database;

  await expect(
    createBillingStore(database).upsertCustomer({
      externalId: "customer-1",
      name: null,
    }),
  ).rejects.toBe(failure);
});

test("a transient transaction boundary failure is marked retryable", async () => {
  const failure = new Bun.SQL.PostgresError("transaction connection lost", {
    code: "08006",
  });
  const database = {
    transaction() {
      return Promise.reject(failure);
    },
  } as unknown as Database;
  await expect(
    createBillingStore(database).applyWebhookProjection({
      event: {
        provider: "test",
        eventId: "event-1",
        webhookType: "invoice.created",
      },
    }),
  ).rejects.toMatchObject({
    name: "BillingPersistenceError",
    operation: "webhook_apply",
  });
});

test("unknown and non-retryable transaction failures are rethrown unchanged", async () => {
  for (const failure of [
    new TypeError("invalid transaction construction"),
    new Bun.SQL.PostgresError("constraint violation", { code: "23503" }),
  ]) {
    const database = {
      transaction() {
        return Promise.reject(failure);
      },
    } as unknown as Database;
    await expect(
      createBillingStore(database).applyWebhookProjection({
        event: {
          provider: "test",
          eventId: "event-1",
          webhookType: "invoice.created",
        },
      }),
    ).rejects.toBe(failure);
  }
});
