import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { lagoUsageEvents } from "../db/schema";
import { createLagoHttpUsageClient } from "./lago-client";

type LagoUsageEvent = typeof lagoUsageEvents.$inferSelect;
export type LagoUsageProjection = Omit<
  LagoUsageEvent,
  "accountId" | "state" | "failure" | "createdAt"
>;

export type LagoUsageClient = {
  verifyDestination?(): Promise<void>;
  send(
    event: LagoUsageProjection,
  ): Promise<"matched" | "missing" | "mismatch" | "rejected">;
};

const settings = z.object({
  LAGO_URL: z.url().refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.href === `${url.origin}/`
    );
  }),
  LAGO_API_KEY: z.string().regex(/^[A-Za-z0-9._~-]+$/),
  LAGO_USAGE_SUBSCRIPTION_ID: z.string().trim().min(1),
});

export function loadLagoUsageExporter(
  database: Database,
  environment: Record<string, string | undefined>,
) {
  const values = {
    LAGO_URL: environment.LAGO_URL?.trim(),
    LAGO_API_KEY: environment.LAGO_API_KEY?.trim(),
    LAGO_USAGE_SUBSCRIPTION_ID: environment.LAGO_USAGE_SUBSCRIPTION_ID?.trim(),
  };
  if (!Object.values(values).some(Boolean)) return undefined;
  const parsed = settings.safeParse(values);
  if (!parsed.success) throw new Error("Invalid Lago usage exporter settings.");
  return createLagoUsageExporter(
    database,
    createLagoHttpUsageClient({
      baseUrl: parsed.data.LAGO_URL,
      apiKey: parsed.data.LAGO_API_KEY,
      externalSubscriptionId: parsed.data.LAGO_USAGE_SUBSCRIPTION_ID,
      metricCode: "model-usage",
    }),
  );
}

export function createLagoUsageExporter(
  database: Database,
  client: LagoUsageClient,
) {
  async function reconcile(row: LagoUsageEvent) {
    const {
      state,
      failure,
      accountId: _accountId,
      createdAt: _createdAt,
      ...event
    } = row;
    // Previous builds embedded the Billing Account ID in locally generated IDs.
    const legacy = event.eventId.startsWith("lago:");
    const result = legacy ? "mismatch" : await client.send(event);
    if (result === "missing" && state !== "accepted") return result;

    let nextFailure = failure;
    if (legacy)
      nextFailure = "Legacy Lago event ID contains Billing Account ID";
    else if (result === "mismatch") nextFailure = "Lago stored usage mismatch";
    else if (result === "rejected")
      nextFailure = "Lago rejected original usage event";
    else if (result === "missing")
      nextFailure ??= "Lago accepted event missing";
    const nextState =
      result === "matched"
        ? "accepted"
        : result === "missing"
          ? "pending"
          : "paused";
    const [updated] = await database
      .update(lagoUsageEvents)
      .set({ state: nextState, failure: nextFailure })
      .where(
        and(
          eq(lagoUsageEvents.eventId, event.eventId),
          eq(lagoUsageEvents.state, state),
        ),
      )
      .returning({ eventId: lagoUsageEvents.eventId });
    return updated ? result : "unchanged";
  }

  return {
    async flush() {
      const rows = await database
        .select()
        .from(lagoUsageEvents)
        .where(eq(lagoUsageEvents.state, "pending"))
        .orderBy(asc(lagoUsageEvents.createdAt), asc(lagoUsageEvents.eventId))
        .limit(20);
      let sent = 0;
      let paused = 0;
      let unavailable = false;
      const startedAt = performance.now();
      try {
        if (rows.length > 0) await client.verifyDestination?.();
        for (const row of rows) {
          const result = await reconcile(row);
          if (result === "matched") sent++;
          if (result === "mismatch" || result === "rejected") paused++;
          if (performance.now() - startedAt >= 5_000) break;
        }
      } catch {
        // Pending rows survive both an outage and a lost response to a successful write.
        unavailable = true;
      }
      return { sent, paused, unavailable };
    },

    async reconcileEvent(eventId: string) {
      const [row] = await database
        .select()
        .from(lagoUsageEvents)
        .where(eq(lagoUsageEvents.eventId, eventId));
      if (!row) return { eventId, result: "unknown" };
      await client.verifyDestination?.();
      const result = await reconcile(row);
      return {
        eventId,
        operationId: row.operationId,
        previousState: row.state,
        previousFailure: row.failure,
        resource: row.resource,
        inputTokens: row.inputTokens.toString(),
        outputTokens: row.outputTokens.toString(),
        amountMicrocredits: row.amountMicrocredits.toString(),
        usageOccurredAt: row.occurredAt.toISOString(),
        result,
      };
    },
  };
}
