import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { personalSaasAccounts, workItems } from "../src/db/schema";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const queue = createWorkQueue(database);
afterAll(() => database.$client.end({ timeout: 5 }));

test("an old queued request cannot be claimed after the account recovers", async () => {
  const accountId = randomUUID();
  const kind = `test.${accountId}`;
  const confirmedAt = Date.now();
  const active = {
    source: "active" as const,
    observedAt: confirmedAt,
    confirmedAt,
    epoch: 0,
    disablements: [],
  };
  await database.insert(personalSaasAccounts).values({
    id: accountId,
    issuer: "test",
    subject: accountId,
    email: "test@example.com",
    status: active,
  });
  expect(await queue.offer({ kind, key: "old", accountId })).toBe("queued");
  await database
    .update(personalSaasAccounts)
    .set({
      status: { ...active, epoch: 1 },
    })
    .where(eq(personalSaasAccounts.id, accountId));
  const claim = { kind, owner: "test-worker", leaseMs: 30_000 };
  expect(await queue.claim(claim)).toEqual([]);
});

test("an expired personal lease never automatically replays a claimed request", async () => {
  const accountId = randomUUID();
  const kind = `test.${accountId}`;
  const confirmedAt = Date.now();
  await database.insert(personalSaasAccounts).values({
    id: accountId,
    issuer: "test",
    subject: accountId,
    email: "test@example.com",
    status: {
      source: "active",
      observedAt: confirmedAt,
      confirmedAt,
      epoch: 0,
      disablements: [],
    },
  });
  await queue.offer({
    kind,
    key: "old",
    accountId,
    payload: { instruction: "Send once" },
  });
  const claim = { kind, owner: "first", leaseMs: 30_000 };
  expect(await queue.claim(claim)).toHaveLength(1);
  await database
    .update(workItems)
    .set({ leaseUntil: new Date(0) })
    .where(eq(workItems.kind, kind));
  expect(await queue.renew({ ...claim, key: "old" })).toBe(false);
  expect(await queue.release({ ...claim, key: "old", delayMs: 0 })).toBe(false);
  expect(await queue.claim({ ...claim, owner: "replacement" })).toEqual([]);
  expect(await queue.interrupted(kind, accountId)).toMatchObject([
    {
      key: "old",
      payload: { instruction: "Send once" },
      interruption: { reason: "worker_lost", outcomeUnknown: true },
    },
  ]);
});
