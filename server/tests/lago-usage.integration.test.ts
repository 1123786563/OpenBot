import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createLagoUsageExporter } from "../src/billing/lago-usage";
import { createDatabase } from "../src/db/client";
import { lagoUsageEvents, testCreditAccounts } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

test("Lago exporter replays a pending raw event idempotently and pauses on mismatched usage", async () => {
  const database = createDatabase(testDatabaseUrl(), TEST_POOL);
  const eventId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  await database.insert(testCreditAccounts).values({
    id: accountId,
    issuer: `lago-test-${eventId}`,
    subject: eventId,
  });
  await database.insert(lagoUsageEvents).values({
    eventId,
    accountId,
    operationId: "op-97",
    resource: "glm-4.6",
    inputTokens: 3n,
    outputTokens: 5n,
    amountMicrocredits: 17n,
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    state: "pending",
  });
  try {
    const sent: unknown[] = [];
    const outage = createLagoUsageExporter(database, {
      send: async () => {
        throw new Error("Lago unavailable");
      },
    });
    expect(await outage.flush()).toEqual({
      sent: 0,
      paused: 0,
      unavailable: true,
    });
    expect(
      (
        await database
          .select()
          .from(lagoUsageEvents)
          .where(eq(lagoUsageEvents.eventId, eventId))
      )[0]?.state,
    ).toBe("pending");
    const exporter = createLagoUsageExporter(database, {
      send: async (event) => {
        sent.push(event);
        return "matched";
      },
    });
    expect(await exporter.flush()).toEqual({
      sent: 1,
      paused: 0,
      unavailable: false,
    });
    expect(await exporter.flush()).toEqual({
      sent: 0,
      paused: 0,
      unavailable: false,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      eventId,
      operationId: "op-97",
      resource: "glm-4.6",
      inputTokens: 3n,
      outputTokens: 5n,
      amountMicrocredits: 17n,
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    });

    await database
      .update(lagoUsageEvents)
      .set({ state: "pending" })
      .where(eq(lagoUsageEvents.eventId, eventId));
    const mismatch = createLagoUsageExporter(database, {
      send: async () => "mismatch",
    });
    expect(await mismatch.flush()).toEqual({
      sent: 0,
      paused: 1,
      unavailable: false,
    });
    expect(
      (
        await database
          .select()
          .from(lagoUsageEvents)
          .where(eq(lagoUsageEvents.eventId, eventId))
      )[0]?.state,
    ).toBe("paused");
    expect(await mismatch.flush()).toEqual({
      sent: 0,
      paused: 0,
      unavailable: false,
    });
    expect(await exporter.reconcileEvent(eventId)).toMatchObject({
      result: "matched",
      previousState: "paused",
      previousFailure: "Lago stored usage mismatch",
    });
    expect(
      (
        await database
          .select()
          .from(lagoUsageEvents)
          .where(eq(lagoUsageEvents.eventId, eventId))
      )[0],
    ).toMatchObject({
      state: "accepted",
      failure: "Lago stored usage mismatch",
    });
    const notVisible = createLagoUsageExporter(database, {
      send: async () => "missing",
    });
    expect(await notVisible.reconcileEvent(eventId)).toMatchObject({
      previousState: "accepted",
      result: "missing",
    });
    expect(await exporter.flush()).toEqual({
      sent: 1,
      paused: 0,
      unavailable: false,
    });
  } finally {
    await database
      .delete(lagoUsageEvents)
      .where(eq(lagoUsageEvents.eventId, eventId));
    await database
      .delete(testCreditAccounts)
      .where(eq(testCreditAccounts.id, accountId));
    await database.$client.close();
  }
});
