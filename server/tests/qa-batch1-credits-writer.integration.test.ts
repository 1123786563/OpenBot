import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createDatabase } from "../src/db/client";
import { creditGrants } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * QA batch-1 probe (a): the credit writer's idempotency under CONCURRENCY, against a real
 * PostgreSQL. The author's own tests cover the sequential retry; the guarantee the ledger
 * actually needs is that N racing grants on one idempotency key land exactly one row — the
 * unique index is the authority, not a read-check. Also pinned here: the replay answer carries
 * the FIRST caller's facts, not the retried caller's arguments (a different amount on a retry
 * must not leak into the answer), which is the property that makes an activation retry safe.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const prefix = `qa1a-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await database.execute(
    sql`DELETE FROM credit_grants WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`${prefix}%`}`,
  );
  await database.$client.close();
});

function grantInput(overrides: Partial<Parameters<typeof writer.grantCredits>[0]> = {}) {
  return {
    externalCustomerId: `${prefix}-customer`,
    source: "plan" as const,
    totalCents: 900_000,
    expiresAt: new Date("2026-11-01T00:00:00Z"),
    reason: "plan allowance · pro",
    idempotencyKey: `${prefix}-key-${randomUUID().slice(0, 8)}`,
    ...overrides,
  };
}

test("probe a: six concurrent grants on one key land exactly one row, nobody throws", async () => {
  const input = grantInput();
  const results = await Promise.all(
    Array.from({ length: 6 }, () => writer.grantCredits({ ...input })),
  );

  const inserted = results.filter((result) => result.inserted);
  expect(inserted).toHaveLength(1);

  // Every loser answers the winner's row — the same grant id, no divergence.
  const ids = new Set(results.map((result) => result.grant.id));
  expect(ids.size).toBe(1);
  expect(results.map((r) => r.grant.id)).toEqual(
    Array.from({ length: 6 }, () => inserted[0].grant.id),
  );

  const rows = await database
    .select({ id: creditGrants.id, total: creditGrants.total })
    .from(creditGrants)
    .where(eq(creditGrants.idempotencyKey, input.idempotencyKey!));
  expect(rows).toHaveLength(1);
  expect(rows[0].total).toBe(900_000);
});

test("probe a: the replay answer carries the first grant's facts, not the retried arguments", async () => {
  const input = grantInput({ totalCents: 100_000 });
  const first = await writer.grantCredits({ ...input });
  expect(first.inserted).toBe(true);

  // The retried activation hands different arguments (an amount drift upstream, say): the row
  // that exists is the answer, and it still says what the FIRST caller wrote.
  const replay = await writer.grantCredits({
    ...input,
    totalCents: 999_999,
    reason: "a different reason on the retry",
  });
  expect(replay.inserted).toBe(false);
  expect(replay.grant.id).toBe(first.grant.id);
  expect(replay.grant.total).toBe(100_000);
  expect(replay.grant.reason).toBe("plan allowance · pro");

  const rows = await database
    .select({ total: creditGrants.total })
    .from(creditGrants)
    .where(eq(creditGrants.idempotencyKey, input.idempotencyKey!));
  expect(rows).toHaveLength(1);
  expect(rows[0].total).toBe(100_000);
});

test("probe a: different keys race independently — six keys, six rows", async () => {
  const inputs = Array.from(
    { length: 6 },
    () => grantInput(),
  );
  const results = await Promise.all(
    inputs.map((input) => writer.grantCredits({ ...input })),
  );
  expect(results.every((result) => result.inserted)).toBe(true);
  expect(new Set(results.map((result) => result.grant.id)).size).toBe(6);
});
