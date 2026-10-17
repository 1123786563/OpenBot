import { expect, test } from "../../tests/support/e2e-compat";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { createBillingStore } from "../src/billing/store";
import { BillingPersistenceError } from "../src/billing/types";
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

test("Drizzle-wrapped transient PostgreSQL errno values are retryable", async () => {
  for (const errno of ["08006", "40001", "40P01", "55P03", "57P01", "53300"]) {
    const failure = new DrizzleQueryError(
      "select 1",
      [],
      new Bun.SQL.PostgresError("transient SQL failure", {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno,
      }),
    );
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
      retryable: true,
    });
  }
});

test("Drizzle-wrapped connection errors remain retryable", async () => {
  const failure = new DrizzleQueryError(
    "select 1",
    [],
    Object.assign(new Error("connection lost"), { code: "ECONNRESET" }),
  );
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
    retryable: true,
  });
});

test("a non-retryable failure becomes the typed sentinel, graded, with the cause preserved", async () => {
  const cyclic = new DrizzleQueryError("select 1", [], undefined);
  cyclic.cause = cyclic;
  const failures = [
    cyclic,
    new DrizzleQueryError(
      "select 1",
      [],
      new Bun.SQL.PostgresError("constraint violation", {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "23503",
      }),
    ),
    new DrizzleQueryError("select 1", [], new TypeError("programming failure")),
    new DrizzleQueryError(
      "select 1",
      [],
      Object.assign(new Error("not a PostgreSQL error"), { errno: "40001" }),
    ),
    new Error("unknown wrapper", {
      cause: new Bun.SQL.PostgresError("not a trusted database wrapper", {
        code: "08006",
      }),
    }),
    new DrizzleQueryError(
      "select 1",
      [],
      new Bun.SQL.PostgresError("unknown SQL failure", {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "XX000",
      }),
    ),
  ];
  for (const failure of failures) {
    const database = {
      transaction() {
        return Promise.reject(failure);
      },
    } as unknown as Database;
    const error = await createBillingStore(database)
      .applyWebhookProjection({
        event: {
          provider: "test",
          eventId: "event-1",
          webhookType: "invoice.created",
        },
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(BillingPersistenceError);
    expect(error).toMatchObject({
      operation: "webhook_apply",
      retryable: false,
    });
    expect((error as { cause?: unknown }).cause).toBe(failure);
  }
});

test("direct errno and nested Drizzle PostgreSQL failures are retryable", async () => {
  const postgres = new Bun.SQL.PostgresError("connection lost", {
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: "08006",
  });
  for (const failure of [
    postgres,
    new DrizzleQueryError(
      "select 1",
      [],
      new DrizzleQueryError("select 1", [], postgres),
    ),
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
    ).rejects.toMatchObject({
      name: "BillingPersistenceError",
      retryable: true,
    });
  }
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
    retryable: true,
  });
});

test("a PostgreSQL constraint violation is graded non-retryable and wrapped", async () => {
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

  const error = await createBillingStore(database)
    .upsertCustomer({
      externalId: "customer-1",
      name: null,
    })
    .then(
      () => null,
      (thrown: unknown) => thrown,
    );
  expect(error).toBeInstanceOf(BillingPersistenceError);
  expect(error).toMatchObject({
    operation: "customer_upsert",
    retryable: false,
  });
  expect((error as { cause?: unknown }).cause).toBe(failure);
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
    retryable: true,
  });
});

test("unknown and non-retryable transaction failures become the graded sentinel with the cause preserved", async () => {
  for (const failure of [
    new TypeError("invalid transaction construction"),
    new Bun.SQL.PostgresError("constraint violation", { code: "23503" }),
  ]) {
    const database = {
      transaction() {
        return Promise.reject(failure);
      },
    } as unknown as Database;
    const error = await createBillingStore(database)
      .applyWebhookProjection({
        event: {
          provider: "test",
          eventId: "event-1",
          webhookType: "invoice.created",
        },
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(BillingPersistenceError);
    expect(error).toMatchObject({
      operation: "webhook_apply",
      retryable: false,
    });
    expect((error as { cause?: unknown }).cause).toBe(failure);
  }
});
