import { and, asc, eq, gte, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { flexpriceUsageDeliveries, lagoUsageEvents } from "../db/schema";
import { createFlexpriceUsageClient } from "./flexprice-client";
export type SettledUsageProjection = Omit<
  typeof lagoUsageEvents.$inferSelect,
  "accountId" | "state" | "failure" | "createdAt"
>;

type FlexpriceUsageClient = {
  verifyDestination?(): Promise<void>;
  send(
    event: SettledUsageProjection,
  ): Promise<"matched" | "missing" | "pending" | "mismatch" | "rejected">;
};

const settings = z.object({
  FLEXPRICE_URL: z.url(),
  FLEXPRICE_API_KEY: z.string().min(1),
  FLEXPRICE_USAGE_CUSTOMER_ID: z.string().min(1),
  FLEXPRICE_USAGE_EXTERNAL_CUSTOMER_ID: z.string().min(1),
  FLEXPRICE_USAGE_METER_ID: z.string().min(1),
  FLEXPRICE_USAGE_SUBSCRIPTION_ID: z.string().min(1),
  FLEXPRICE_USAGE_START_AT: z.iso.datetime(),
});

export function loadFlexpriceUsageExporter(
  database: Database,
  environment: Record<string, string | undefined>,
) {
  if (
    !Object.keys(settings.shape).some(
      (key) => key.startsWith("FLEXPRICE_USAGE_") && environment[key]?.trim(),
    )
  )
    return undefined;
  const parsed = settings.safeParse(environment);
  if (!parsed.success)
    throw new Error("Invalid Flexprice usage exporter settings.");
  const values = parsed.data;
  return createFlexpriceUsageExporter(
    database,
    createFlexpriceUsageClient({
      baseUrl: values.FLEXPRICE_URL,
      apiKey: values.FLEXPRICE_API_KEY,
      customerId: values.FLEXPRICE_USAGE_CUSTOMER_ID,
      externalCustomerId: values.FLEXPRICE_USAGE_EXTERNAL_CUSTOMER_ID,
      meterId: values.FLEXPRICE_USAGE_METER_ID,
      subscriptionId: values.FLEXPRICE_USAGE_SUBSCRIPTION_ID,
    }),
    new Date(values.FLEXPRICE_USAGE_START_AT),
  );
}

export function createFlexpriceUsageExporter(
  database: Database,
  client: FlexpriceUsageClient,
  startAt: Date,
) {
  async function deliver(row: typeof lagoUsageEvents.$inferSelect) {
    await database
      .insert(flexpriceUsageDeliveries)
      .values({ eventId: row.eventId })
      .onConflictDoNothing();
    const {
      accountId: _accountId,
      state: _state,
      failure: _failure,
      createdAt: _createdAt,
      ...event
    } = row;
    const result = event.eventId.startsWith("lago:")
      ? "rejected"
      : await client.send(event);
    if (result === "missing" || result === "pending") return result;
    await database
      .update(flexpriceUsageDeliveries)
      .set({
        state: result === "matched" ? "accepted" : "paused",
        failure: result === "matched" ? null : `Flexprice usage ${result}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(flexpriceUsageDeliveries.eventId, event.eventId),
          eq(flexpriceUsageDeliveries.state, "pending"),
        ),
      );
    return result;
  }
  return {
    async reconcileEvent(eventId: string) {
      const [row] = await database
        .select({
          event: lagoUsageEvents,
          state: flexpriceUsageDeliveries.state,
        })
        .from(lagoUsageEvents)
        .leftJoin(
          flexpriceUsageDeliveries,
          eq(lagoUsageEvents.eventId, flexpriceUsageDeliveries.eventId),
        )
        .where(
          and(
            eq(lagoUsageEvents.eventId, eventId),
            gte(lagoUsageEvents.createdAt, startAt),
          ),
        );
      if (!row) return "missing";
      if (row.state === "accepted") return "matched";
      if (row.state === "paused") return "rejected";
      await client.verifyDestination?.();
      return deliver(row.event);
    },
    async flush() {
      const rows = await database
        .select({ event: lagoUsageEvents })
        .from(lagoUsageEvents)
        .leftJoin(
          flexpriceUsageDeliveries,
          eq(lagoUsageEvents.eventId, flexpriceUsageDeliveries.eventId),
        )
        .where(
          and(
            gte(lagoUsageEvents.createdAt, startAt),
            or(
              isNull(flexpriceUsageDeliveries.eventId),
              eq(flexpriceUsageDeliveries.state, "pending"),
            ),
          ),
        )
        .orderBy(asc(lagoUsageEvents.createdAt), asc(lagoUsageEvents.eventId))
        .limit(20);
      let sent = 0;
      let paused = 0;
      let unavailable = false;
      const start = performance.now();
      try {
        if (rows.length) await client.verifyDestination?.();
        for (const { event } of rows) {
          const result = await deliver(event);
          if (result === "matched") sent++;
          if (result === "mismatch" || result === "rejected") paused++;
          if (performance.now() - start >= 5_000) break;
        }
      } catch {
        unavailable = true;
      }
      return { sent, paused, unavailable };
    },
  };
}
