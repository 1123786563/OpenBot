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
