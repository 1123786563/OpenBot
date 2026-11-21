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
    expect(await outage.flush()).toEqual({ sent: 0, paused: 0 });
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
        return {
          eventId,
          inputTokens: 3n,
          outputTokens: 5n,
          amountMicrocredits: 17n,
        };
      },
    });
    expect(await exporter.flush()).toEqual({ sent: 1, paused: 0 });
    expect(await exporter.flush()).toEqual({ sent: 0, paused: 0 });
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
      send: async () => ({
        eventId,
        inputTokens: 4n,
        outputTokens: 5n,
        amountMicrocredits: 17n,
      }),
    });
    expect(await mismatch.flush()).toEqual({ sent: 0, paused: 1 });
    expect(
      (
        await database
          .select()
          .from(lagoUsageEvents)
          .where(eq(lagoUsageEvents.eventId, eventId))
      )[0]?.state,
    ).toBe("paused");
  } finally {
    await database
      .delete(lagoUsageEvents)
      .where(eq(lagoUsageEvents.eventId, eventId));
    await database.$client.close();
  }
});
