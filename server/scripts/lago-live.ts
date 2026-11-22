/**
 * Live acceptance for the Lago usage outbox (#97): seeds pending events, drives
 * the exporter against a real self-hosted Lago, and reports the aggregation.
 *
 *   DATABASE_URL=… LAGO_URL=http://127.0.0.1:32832 LAGO_API_KEY=… \
 *     bun scripts/billing-pilot/lago-live.ts seed|flush|usage
 *
 * `seed` also creates the Lago customer with the account id as its external id.
 * Drive an outage by stopping the Lago API between `seed` and `flush`.
 */
import { eq } from "drizzle-orm";
import { createLagoHttpUsageClient } from "../../server/src/billing/lago-client";
import { createLagoUsageExporter } from "../../server/src/billing/lago-usage";
import { createDatabase } from "../../server/src/db/client";
import { lagoUsageEvents, testCreditAccounts } from "../../server/src/db/schema";

const mode = process.argv[2] ?? "flush";
const accountId = process.argv[3] ?? crypto.randomUUID();
const database = createDatabase(process.env.DATABASE_URL ?? "");
const client = createLagoHttpUsageClient({
  baseUrl: process.env.LAGO_URL ?? "",
  apiKey: process.env.LAGO_API_KEY ?? "",
  metricCode: "model-usage",
  externalSubscriptionId: (accountId) => `openbot-sub-${accountId}`,
});
const exporter = createLagoUsageExporter(database, client);

async function lago(path: string, init?: RequestInit) {
  const response = await fetch(`${process.env.LAGO_URL}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.LAGO_API_KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

if (mode === "seed") {
  const created = await lago("/customers", {
    method: "POST",
    body: JSON.stringify({
      customer: { external_id: accountId, name: `OpenBot ${accountId.slice(0, 8)}` },
    }),
  });
  await lago("/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      subscription: {
        external_customer_id: accountId,
        external_id: `openbot-sub-${accountId}`,
        plan_code: process.env.LAGO_PLAN_CODE ?? "openbot-usage-v2",
      },
    }),
  });
  await database.insert(testCreditAccounts).values({
    id: accountId,
    issuer: "lago-live-97",
    subject: `lago-live-${accountId}`,
  });
  const events = [0, 1, 2].map((index) => ({
    eventId: crypto.randomUUID(),
    accountId,
    operationId: `lago-live-op-${index}`,
    resource: index === 2 ? "glm-5.3" : "glm-5.3-flash",
    inputTokens: BigInt(19 + index),
    outputTokens: BigInt(31 - index),
    amountMicrocredits: BigInt(50 + index * 7),
    occurredAt: new Date(Date.now() - 60_000 + index * 1000),
    state: "pending" as const,
  }));
  await database.insert(lagoUsageEvents).values(events);
  console.log(
    JSON.stringify({
      mode,
      accountId,
      lagoCustomer: created.status,
      events: events.map((event) => ({
        eventId: event.eventId,
        microcredits: Number(event.amountMicrocredits),
      })),
    }),
  );
} else if (mode === "flush") {
  const result = await exporter.flush();
  const rows = await database.select().from(lagoUsageEvents).where(eq(lagoUsageEvents.accountId, accountId));
  console.log(
    JSON.stringify({
      mode,
      accountId,
      flush: result,
      rows: rows.map((row) => ({ eventId: row.eventId, state: row.state })),
    }),
  );
} else if (mode === "usage") {
  const usage = await lago(`/customers/${accountId}/current_usage`);
  const subscriptions = await lago(`/subscriptions?external_customer_id=${accountId}`);
  console.log(
    JSON.stringify({
      mode,
      accountId,
      usageStatus: usage.status,
      usage: usage.body,
      subscriptions: subscriptions.status,
      subscriptionParam: `openbot-sub-${accountId}`,
    }),
  );
} else {
  throw new Error(`unknown mode ${mode}`);
}
await database.$client.close();
