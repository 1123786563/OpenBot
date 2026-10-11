import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  createUsageOutbox,
  UsageOutboxConflictError,
} from "../src/billing/usage-outbox";
import { createDatabase } from "../src/db/client";
import { usageOutbox } from "../src/db/schema/usage-outbox";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const outbox = createUsageOutbox(database);
const prefix = `usage-${randomUUID()}`;

afterAll(async () => {
  await database
    .delete(usageOutbox)
    .where(sql`${usageOutbox.eventId} LIKE ${`${prefix}%`}`);
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
  ];

  for (const conflictingEvent of conflictingEvents) {
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
