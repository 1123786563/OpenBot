import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { flexpriceUsageDeliveries, lagoUsageEvents } from "../db/schema";
import { createFlexpriceUsageClient } from "./flexprice-client";
import type { LagoUsageClient } from "./lago-usage";

const settings = z.object({
  FLEXPRICE_URL: z.url(),
  FLEXPRICE_API_KEY: z.string().min(1),
  FLEXPRICE_USAGE_CUSTOMER_ID: z.string().min(1),
  FLEXPRICE_USAGE_EXTERNAL_CUSTOMER_ID: z.string().min(1),
  FLEXPRICE_USAGE_METER_ID: z.string().min(1),
  FLEXPRICE_USAGE_SUBSCRIPTION_ID: z.string().min(1),
});

export function loadFlexpriceUsageExporter(
  database: Database,
  environment: Record<string, string | undefined>,
) {
  if (!Object.keys(settings.shape).some((key) => environment[key]))
    return undefined;
  const values = settings.parse(environment);
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
  );
}

export function createFlexpriceUsageExporter(
  database: Database,
  client: LagoUsageClient,
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
    if (result === "missing") return result;
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
    async flush() {
      const rows = await database
        .select({ event: lagoUsageEvents })
        .from(lagoUsageEvents)
        .leftJoin(
          flexpriceUsageDeliveries,
          eq(lagoUsageEvents.eventId, flexpriceUsageDeliveries.eventId),
        )
        .where(
          or(
            isNull(flexpriceUsageDeliveries.eventId),
            eq(flexpriceUsageDeliveries.state, "pending"),
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
