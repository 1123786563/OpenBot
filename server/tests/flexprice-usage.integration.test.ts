import { expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createFlexpriceUsageExporter } from "../src/billing/flexprice-usage";
import { createDatabase } from "../src/db/client";
import {
  flexpriceUsageDeliveries,
  lagoUsageEvents,
  testCreditAccounts,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

test("Flexprice delivery survives outage and async ingest without changing Lago history or charging twice", async () => {
  const db = createDatabase(testDatabaseUrl(), TEST_POOL);
  const accountId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  await db.insert(testCreditAccounts).values({
    id: accountId,
    issuer: `flexprice-test-${eventId}`,
    subject: eventId,
  });
  await db.insert(lagoUsageEvents).values({
    eventId,
    accountId,
    operationId: "op-flexprice",
    resource: "glm-4.7",
    inputTokens: 3n,
    outputTokens: 5n,
    amountMicrocredits: 17n,
    occurredAt: new Date(),
    state: "accepted",
  });
  const historicalEvent = crypto.randomUUID();
  await db.insert(lagoUsageEvents).values({
    eventId: historicalEvent,
    accountId,
    operationId: "op-before-cutover",
    resource: "glm-4.7",
    inputTokens: 3n,
    outputTokens: 5n,
    amountMicrocredits: 17n,
    occurredAt: new Date("2020-01-01T00:00:00Z"),
    createdAt: new Date("2020-01-01T00:00:00Z"),
    state: "pending",
  });
  const cutover = new Date("2026-01-01T00:00:00Z");
  try {
    const outage = createFlexpriceUsageExporter(
      db,
      {
        send: async () => {
          throw new Error("Unavailable");
        },
      },
      cutover,
    );
    expect(await outage.flush()).toEqual({
      sent: 0,
      paused: 0,
      unavailable: true,
    });
    const pending = createFlexpriceUsageExporter(
      db,
      {
        send: async () => "pending",
      },
      cutover,
    );
    expect(await pending.flush()).toEqual({
      sent: 0,
      paused: 0,
      unavailable: false,
    });
    expect(
      (
        await db
          .select()
          .from(flexpriceUsageDeliveries)
          .where(eq(flexpriceUsageDeliveries.eventId, eventId))
      )[0]?.state,
    ).toBe("pending");
    let delivered = 0;
    const accepted = createFlexpriceUsageExporter(
      db,
      {
        send: async (event) => {
          delivered++;
          expect(event.eventId).toBe(eventId);
          expect("accountId" in event).toBe(false);
          expect(event.amountMicrocredits).toBe(17n);
          return "matched";
        },
      },
      cutover,
    );
    expect(await accepted.flush()).toEqual({
      sent: 1,
      paused: 0,
      unavailable: false,
    });
    expect(await accepted.flush()).toEqual({
      sent: 0,
      paused: 0,
      unavailable: false,
    });
    expect(delivered).toBe(1);
    expect(
      (
        await db
          .select()
          .from(lagoUsageEvents)
          .where(eq(lagoUsageEvents.eventId, eventId))
      )[0]?.state,
    ).toBe("accepted");
    await db
      .update(flexpriceUsageDeliveries)
      .set({ state: "pending" })
      .where(eq(flexpriceUsageDeliveries.eventId, eventId));
    const conflict = createFlexpriceUsageExporter(
      db,
      {
        send: async () => "mismatch",
      },
      cutover,
    );
    expect(await conflict.flush()).toEqual({
      sent: 0,
      paused: 1,
      unavailable: false,
    });
    expect(await conflict.flush()).toEqual({
      sent: 0,
      paused: 0,
      unavailable: false,
    });
    expect(
      (
        await db
          .select()
          .from(flexpriceUsageDeliveries)
          .where(eq(flexpriceUsageDeliveries.eventId, eventId))
      )[0]?.failure,
    ).toBe("Flexprice usage mismatch");
  } finally {
    await db
      .delete(flexpriceUsageDeliveries)
      .where(
        inArray(flexpriceUsageDeliveries.eventId, [eventId, historicalEvent]),
      );
    await db
      .delete(lagoUsageEvents)
      .where(eq(lagoUsageEvents.accountId, accountId));
    await db
      .delete(testCreditAccounts)
      .where(eq(testCreditAccounts.id, accountId));
    await db.$client.close();
  }
});
