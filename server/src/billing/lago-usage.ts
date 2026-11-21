import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { lagoUsageEvents } from "../db/schema";

type LagoUsageEvent = typeof lagoUsageEvents.$inferSelect;
export type LagoUsageProjection = Pick<
  LagoUsageEvent,
  | "eventId"
  | "operationId"
  | "resource"
  | "inputTokens"
  | "outputTokens"
  | "amountMicrocredits"
  | "occurredAt"
>;
export type LagoUsageClient = {
  send(event: LagoUsageProjection): Promise<{
    eventId: string;
    inputTokens: bigint;
    outputTokens: bigint;
    amountMicrocredits: bigint;
  }>;
};

export function createLagoUsageExporter(
  database: Database,
  client: LagoUsageClient,
) {
  return {
    async flush() {
      const rows = await database
        .select()
        .from(lagoUsageEvents)
        .where(eq(lagoUsageEvents.state, "pending"));
      let sent = 0;
      let paused = 0;
      for (const row of rows) {
        try {
          const result = await client.send(project(row));
          const matches =
            result.eventId === row.eventId &&
            result.inputTokens === row.inputTokens &&
            result.outputTokens === row.outputTokens &&
            result.amountMicrocredits === row.amountMicrocredits;
          if (!matches) {
            await database
              .update(lagoUsageEvents)
              .set({ state: "paused", failure: "Lago usage mismatch" })
              .where(
                and(
                  eq(lagoUsageEvents.eventId, row.eventId),
                  eq(lagoUsageEvents.state, "pending"),
                ),
              );
            paused++;
            continue;
          }
          await database
            .update(lagoUsageEvents)
            .set({ state: "accepted", failure: null })
            .where(
              and(
                eq(lagoUsageEvents.eventId, row.eventId),
                eq(lagoUsageEvents.state, "pending"),
              ),
            );
          sent++;
        } catch {
          // Keep raw events pending for replay after Lago recovers.
        }
      }
      return { sent, paused };
    },
  };
}

function project(row: LagoUsageEvent): LagoUsageProjection {
  return {
    eventId: row.eventId,
    operationId: row.operationId,
    resource: row.resource,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    amountMicrocredits: row.amountMicrocredits,
    occurredAt: row.occurredAt,
  };
}
