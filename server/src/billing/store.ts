import { and, count, eq, max } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  billingCustomers,
  billingSubscriptions,
  billingWebhookEvents,
} from "../db/schema/billing";
import type { BillingStore } from "./types";

/**
 * The projections the sync keeps, and the webhook inbox.
 *
 * A plain factory over the shared database, the way the approvals store is (../approvals/store.ts),
 * so tests can hold a real one against a throwaway database and the service never talks to drizzle
 * directly. Upserts are keyed on the local external IDs, which are deterministic, so replaying a
 * sync or a webhook converges rather than accumulating rows.
 */
export function createBillingStore(database: Database): BillingStore {
  return {
    async upsertCustomer(input) {
      const now = new Date();
      await database
        .insert(billingCustomers)
        .values({
          externalId: input.externalId,
          name: input.name,
          lastSyncedAt: now,
        })
        .onConflictDoUpdate({
          target: billingCustomers.externalId,
          set: { name: input.name, lastSyncedAt: now },
        });
    },
    async upsertSubscription(input) {
      const now = new Date();
      await database
        .insert(billingSubscriptions)
        .values({ ...input, updatedAt: now })
        .onConflictDoUpdate({
          target: billingSubscriptions.externalSubscriptionId,
          set: {
            externalCustomerId: input.externalCustomerId,
            planCode: input.planCode,
            status: input.status,
            updatedAt: now,
          },
        });
    },
    async readSubscriptions(externalCustomerId) {
      const rows = await database
        .select()
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.externalCustomerId, externalCustomerId));
      return rows;
    },
    async hasWebhookEvent(provider, eventId) {
      const [row] = await database
        .select({ one: billingWebhookEvents.eventId })
        .from(billingWebhookEvents)
        .where(
          and(
            eq(billingWebhookEvents.provider, provider),
            eq(billingWebhookEvents.eventId, eventId),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
    async recordWebhookEvent(input) {
      const rows = await database
        .insert(billingWebhookEvents)
        .values({
          provider: input.provider,
          eventId: input.eventId,
          lagoUniqueKey: input.uniqueKey,
          webhookType: input.webhookType,
          objectId: input.objectId,
        })
        .onConflictDoNothing({
          target: [billingWebhookEvents.provider, billingWebhookEvents.eventId],
        })
        .returning({ eventId: billingWebhookEvents.eventId });
      return rows.length > 0;
    },
    async snapshot() {
      const [customers] = await database
        .select({ value: count() })
        .from(billingCustomers);
      const [subscriptions] = await database
        .select({ value: count() })
        .from(billingSubscriptions);
      const [latest] = await database
        .select({ value: max(billingCustomers.lastSyncedAt) })
        .from(billingCustomers);
      return {
        customers: customers?.value ?? 0,
        subscriptions: subscriptions?.value ?? 0,
        ...(latest?.value ? { lastSyncedAt: latest.value } : {}),
      };
    },
  };
}
