import { and, count, eq, max } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  billingCustomers,
  billingSubscriptions,
  billingWebhookEvents,
} from "../db/schema/billing";
import {
  BillingPersistenceError,
  type BillingPersistenceOperation,
  type BillingStore,
} from "./types";

async function withPersistenceError<T>(
  operation: BillingPersistenceOperation,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch {
    throw new BillingPersistenceError(operation);
  }
}

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
      await withPersistenceError("customer_upsert", async () => {
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
      });
    },
    async ensureCustomerRow(input) {
      // Insert-only: a row that already exists — with the name an earlier refresh wrote — is left
      // exactly as it is. This is the webhook path's floor under the subscription foreign key, not
      // a refresh; the placeholder it may insert is nameless and waits for a real read.
      await withPersistenceError("customer_ensure", async () => {
        await database
          .insert(billingCustomers)
          .values({ externalId: input.externalId, name: null })
          .onConflictDoNothing({ target: billingCustomers.externalId });
      });
    },
    async upsertSubscription(input) {
      await withPersistenceError("subscription_upsert", async () => {
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
      });
    },
    async readSubscriptions(externalCustomerId) {
      return withPersistenceError("subscription_read", async () => {
        const rows = await database
          .select()
          .from(billingSubscriptions)
          .where(
            eq(billingSubscriptions.externalCustomerId, externalCustomerId),
          );
        return rows;
      });
    },
    async hasWebhookEvent(provider, eventId) {
      return withPersistenceError("webhook_lookup", async () => {
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
      });
    },
    async recordWebhookEvent(input) {
      return withPersistenceError("webhook_record", async () => {
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
            target: [
              billingWebhookEvents.provider,
              billingWebhookEvents.eventId,
            ],
          })
          .returning({ eventId: billingWebhookEvents.eventId });
        return rows.length > 0;
      });
    },
    async snapshot() {
      return withPersistenceError("snapshot", async () => {
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
      });
    },
  };
}
