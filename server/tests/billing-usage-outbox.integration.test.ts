import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  createUsageOutbox,
  UsageOutboxConflictError,
  type UsageOutbox,
} from "../src/billing/usage-outbox";
import { createUsageDelivery } from "../src/billing/usage-delivery";
import { createDatabase } from "../src/db/client";
import { usageOutbox } from "../src/db/schema/usage-outbox";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const outbox = createUsageOutbox(database);
const prefix = `usage-${randomUUID()}`;

afterEach(async () => {
  await database
    .delete(usageOutbox)
    .where(sql`${usageOutbox.eventId} LIKE ${`${prefix}%`}`);
});

afterAll(async () => {
  await database.$client.close();
});

function usageEvent(eventId: string) {
  return {
    eventId,
    source: "llm" as const,
    externalCustomerId: `${prefix}-customer`,
    transactionId: `${eventId}-transaction`,
    inputTokens: 120,
    outputTokens: 45,
    model: "gpt-4.1",
    client: "web",
    occurredAt: new Date("2026-10-11T10:00:00.000Z"),
    reservationId: `res-${eventId}`,
    actualCostNumerator: "33",
    actualCostDenominator: "2",
  };
}

function codeRunUsageEvent(eventId: string) {
  return {
    eventId,
    source: "code_run" as const,
    externalCustomerId: `${prefix}-customer`,
    transactionId: `${eventId}-transaction`,
    inputTokens: 12,
    outputTokens: 7,
    model: "glm-4.6",
    client: "web",
    occurredAt: new Date("2026-10-11T10:30:00.000Z"),
    runId: `${eventId}-run`,
    botId: `${prefix}-bot`,
    ownerUserId: `${prefix}-owner`,
    sessionId: `${prefix}-session`,
    status: "completed",
  };
}

test("record inserts a usage event once and an identical replay is a no-op", async () => {
  const event = usageEvent(`${prefix}-event-1`);

  expect(await outbox.record(event)).toEqual({ inserted: true });
  expect(await outbox.record(event)).toEqual({ inserted: false });
  expect(
    await database
      .select()
      .from(usageOutbox)
      .where(eq(usageOutbox.eventId, event.eventId)),
  ).toMatchObject([
    {
      ...event,
      lagoStatus: "pending",
      creditsStatus: "pending",
    },
  ]);
});

test("a second store instance replays only the pending target under the original event id", async () => {
  // The audited failure shape: Lago accepted the event and the process died before the
  // credit target settled. A second store instance — a replica or a restart — picks the
  // committed row up and must execute ONLY the pending target, under the same event id,
  // and never repeat the delivered one.
  const event = usageEvent(`${prefix}-replay`);
  await outbox.record(event);
  await outbox.markLagoDelivered(event.eventId);

  const secondDatabase = createDatabase(testDatabaseUrl(), { max: 2 });
  try {
    const lagoCalls: string[] = [];
    const creditCalls: string[] = [];
    const delivery = createUsageDelivery({
      outbox: createUsageOutbox(secondDatabase),
      sendToLago: async (record) => {
        lagoCalls.push(record.eventId);
      },
      chargeCredits: async (record) => {
        creditCalls.push(record.eventId);
      },
      log: () => {},
    });

    expect(await delivery.runBatch(10)).toEqual({
      examined: 1,
      delivered: 1,
      failed: 0,
    });
    expect(lagoCalls).toEqual([]);
    expect(creditCalls).toEqual([event.eventId]);

    // The replay of the replay: both targets delivered, nothing executes, no duplicate effect.
    expect(await delivery.runBatch(10)).toEqual({
      examined: 0,
      delivered: 0,
      failed: 0,
    });
    expect(lagoCalls).toEqual([]);
    expect(creditCalls).toEqual([event.eventId]);
  } finally {
    await secondDatabase.$client.close();
  }
});

test("record rejects reuse of an event ID with any changed immutable fact", async () => {
  const event = usageEvent(`${prefix}-conflict`);
  await outbox.record(event);

  const conflictingEvents = [
    { ...event, source: "code_run" as const },
    { ...event, externalCustomerId: `${prefix}-other-customer` },
    { ...event, transactionId: `${event.transactionId}-other` },
    { ...event, inputTokens: event.inputTokens + 1 },
    { ...event, outputTokens: event.outputTokens + 1 },
    { ...event, model: "gpt-4.1-mini" },
    { ...event, client: "api" },
    { ...event, occurredAt: new Date(event.occurredAt.getTime() + 1) },
    { ...event, reservationId: `${event.reservationId}-other` },
    { ...event, actualCostNumerator: "34" },
    { ...event, actualCostDenominator: "3" },
  ];

  for (const conflictingEvent of conflictingEvents) {
    await expect(outbox.record(conflictingEvent)).rejects.toBeInstanceOf(
      UsageOutboxConflictError,
    );
  }
});

test("record persists source-specific code-run facts and rejects conflicting replays", async () => {
  const event = codeRunUsageEvent(`${prefix}-code-run`);
  expect(await outbox.record(event)).toEqual({ inserted: true });
  expect(await outbox.record(event)).toEqual({ inserted: false });

  expect(
    await database
      .select()
      .from(usageOutbox)
      .where(eq(usageOutbox.eventId, event.eventId)),
  ).toMatchObject([
    {
      ...event,
      lagoStatus: "pending",
      creditsStatus: "pending",
    },
  ]);

  const conflicts = [
    { ...event, runId: `${event.runId}-other` },
    { ...event, botId: `${event.botId}-other` },
    { ...event, ownerUserId: `${event.ownerUserId}-other` },
    { ...event, sessionId: `${event.sessionId}-other` },
    { ...event, status: "failed" },
  ];

  for (const conflictingEvent of conflicts) {
    await expect(outbox.record(conflictingEvent)).rejects.toBeInstanceOf(
      UsageOutboxConflictError,
    );
  }
});

test("delivery states are independent and pending returns unfinished events", async () => {
  const lagoEvent = usageEvent(`${prefix}-lago`);
  const creditsEvent = usageEvent(`${prefix}-credits`);
  await outbox.record(lagoEvent);
  await outbox.record(creditsEvent);

  await outbox.markLagoDelivered(lagoEvent.eventId);
  await outbox.markCreditsDelivered(creditsEvent.eventId);

  expect(await outbox.pending(10)).toMatchObject([
    {
      eventId: lagoEvent.eventId,
      lagoStatus: "delivered",
      creditsStatus: "pending",
    },
    {
      eventId: creditsEvent.eventId,
      lagoStatus: "pending",
      creditsStatus: "delivered",
    },
  ]);

  await outbox.markCreditsDelivered(lagoEvent.eventId);
  await outbox.markLagoDelivered(creditsEvent.eventId);
  expect(await outbox.pending(10)).toEqual([]);
});

test("delivery failures are target-specific and leave the target pending", async () => {
  const event = usageEvent(`${prefix}-failure`);
  await outbox.record(event);

  await outbox.recordDeliveryFailure(
    event.eventId,
    "lago",
    "provider_unavailable",
  );

  expect(await outbox.pending(10)).toMatchObject([
    {
      eventId: event.eventId,
      lagoStatus: "pending",
      creditsStatus: "pending",
      lagoLastErrorCode: "provider_unavailable",
      creditsLastErrorCode: null,
    },
  ]);
});

test("a blocked delivery target leaves durable manual-review evidence and no longer requeues", async () => {
  const event = usageEvent(`${prefix}-blocked`);
  await outbox.record(event);
  await outbox.markLagoDelivered(event.eventId);

  await (outbox as UsageOutbox & {
    blockDelivery(
      eventId: string,
      target: "lago" | "credits",
      failureCode: string,
    ): Promise<void>;
  }).blockDelivery(event.eventId, "credits", "missing_reservation");

  expect(await outbox.pending(10)).toEqual([]);
  expect(
    await database
      .select()
      .from(usageOutbox)
      .where(eq(usageOutbox.eventId, event.eventId)),
  ).toMatchObject([
    {
      eventId: event.eventId,
      lagoStatus: "delivered",
      creditsStatus: "blocked",
      creditsLastErrorCode: "missing_reservation",
    },
  ]);
});

test("a stale worker cannot mark a blocked target delivered", async () => {
  // `blocked` is a manual-review terminal state; a delivery that raced the block must not
  // be able to overwrite it, and an idempotent re-mark of a delivered target stays silent.
  const event = usageEvent(`${prefix}-blocked-guard`);
  await outbox.record(event);
  await (outbox as UsageOutbox & {
    blockDelivery(
      eventId: string,
      target: "lago" | "credits",
      failureCode: string,
    ): Promise<void>;
  }).blockDelivery(event.eventId, "lago", "missing_reservation");
  await outbox.markCreditsDelivered(event.eventId);

  // The stale worker arrives after the block and after delivery of the sibling.
  await outbox.markLagoDelivered(event.eventId);
  expect(
    await database
      .select()
      .from(usageOutbox)
      .where(eq(usageOutbox.eventId, event.eventId)),
  ).toMatchObject([
    {
      lagoStatus: "blocked",
      lagoLastErrorCode: "missing_reservation",
      creditsStatus: "delivered",
    },
  ]);

  // An idempotent re-mark of the already-delivered target is a silent no-op.
  await outbox.markCreditsDelivered(event.eventId);
  expect(
    await database
      .select()
      .from(usageOutbox)
      .where(eq(usageOutbox.eventId, event.eventId)),
  ).toMatchObject([{ creditsStatus: "delivered" }]);
});

test("pending retries move behind older unattempted events instead of starving the backlog", async () => {
  const retried = usageEvent(`${prefix}-retried-first`);
  const unattempted = usageEvent(`${prefix}-unattempted-second`);
  await outbox.record(retried);
  await outbox.record(unattempted);

  await database.execute(
    sql`UPDATE usage_outbox SET created_at = now() - interval '2 minutes', updated_at = now() - interval '2 minutes' WHERE event_id = ${retried.eventId}`,
  );
  await database.execute(
    sql`UPDATE usage_outbox SET created_at = now() - interval '1 minute', updated_at = now() - interval '1 minute' WHERE event_id = ${unattempted.eventId}`,
  );
  await outbox.recordDeliveryFailure(
    retried.eventId,
    "lago",
    "provider_unavailable",
  );

  expect((await outbox.pending(1))[0]?.eventId).toBe(unattempted.eventId);
});

for (const target of ["lago", "credits"] as const) {
  test(`a late ${target} failure preserves delivered state and does not reopen completed usage`, async () => {
    const event = usageEvent(`${prefix}-late-${target}-failure`);
    await outbox.record(event);
    await outbox.markLagoDelivered(event.eventId);
    await outbox.markCreditsDelivered(event.eventId);
    const [before] = await database
      .select()
      .from(usageOutbox)
      .where(eq(usageOutbox.eventId, event.eventId));

    await outbox.recordDeliveryFailure(event.eventId, target, "late_failure");

    const [after] = await database
      .select()
      .from(usageOutbox)
      .where(eq(usageOutbox.eventId, event.eventId));
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      lagoStatus: "delivered",
      creditsStatus: "delivered",
      lagoLastErrorCode: null,
      creditsLastErrorCode: null,
    });
    expect(
      (await outbox.pending(100)).some((row) => row.eventId === event.eventId),
    ).toBe(false);
  });
}
