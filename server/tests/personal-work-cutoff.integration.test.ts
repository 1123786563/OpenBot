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

test("a wake-up scheduled before an access cutoff cannot run after recovery", async () => {
  const { createWakeUpStore, WAKE_UP_KIND } = await import(
    "../src/agents/wake-up"
  );
  const accountId = randomUUID();
  const confirmedAt = Date.now();
  const status = {
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
    status,
  });
  const scheduled = await createWakeUpStore(database, {
    now: () => new Date(confirmedAt - 120_000),
  }).schedule({
    ownerUserId: accountId,
    agentId: "assistant",
    reason: "Check once",
    dueAt: new Date(confirmedAt - 1000),
  });
  await database
    .update(personalSaasAccounts)
    .set({ status: { ...status, epoch: 1 } })
    .where(eq(personalSaasAccounts.id, accountId));
  expect(
    await queue.claim({
      kind: WAKE_UP_KIND,
      owner: accountId,
      leaseMs: 30_000,
      limit: 100,
    }),
  ).not.toContainEqual(expect.objectContaining({ key: scheduled.id }));
  expect(await queue.interrupted(WAKE_UP_KIND, accountId)).toMatchObject([
    { key: scheduled.id, interruption: { outcomeUnknown: false } },
  ]);
});

test("the wake-up worker stops a running turn at local expiry and keeps partial output", async () => {
  const { createWakeUpRunner, createWakeUpStore, WAKE_UP_KIND } = await import(
    "../src/agents/wake-up"
  );
  const accountId = randomUUID();
  const confirmedAt = Date.now() - 59_000;
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
  const store = createWakeUpStore(database, {
    now: () => new Date(confirmedAt - 120_000),
  });
  const scheduled = await store.schedule({
    ownerUserId: accountId,
    agentId: "assistant",
    reason: "Check once",
    dueAt: new Date(confirmedAt - 1_000),
  });
  let abortedAt: number | undefined;
  const runner = createWakeUpRunner({
    queue,
    store,
    owner: accountId,
    actorFor: async () => ({ id: accountId, role: "user" }),
    channels: {
      get: async () => null,
      direct: async () => ({
        id: "test-channel",
        name: "Test channel",
        agentIds: ["assistant"],
        threadId: "test-thread",
        active: true,
        lastMessageAt: null,
      }),
      recordActivity: async () => {},
    },
    async runTurn({ signal, beforeDispatch, onText }) {
      if (!signal || !beforeDispatch || !onText)
        throw new Error("Wake-up ran without execution authorization");
      await beforeDispatch();
      onText("Partial reply");
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      abortedAt = Date.now();
      signal.throwIfAborted();
      return { replyText: "" };
    },
  });
  const report = await runner.sweep();
  expect(report).toEqual({ ran: [], skipped: [scheduled.id] });
  expect(abortedAt).toBeDefined();
  expect(abortedAt ?? Infinity).toBeLessThan(confirmedAt + 60_000 + 200);
  expect(await queue.interrupted(WAKE_UP_KIND, accountId)).toMatchObject([
    {
      key: scheduled.id,
      output: "Partial reply",
      interruption: {
        reason: "account_status_unconfirmed",
        cutoffAt: confirmedAt + 60_000,
        outcomeUnknown: true,
      },
    },
  ]);
});
