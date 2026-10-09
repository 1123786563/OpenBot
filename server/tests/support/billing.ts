import type {
  BillingStore,
  BillingSubscriptionRow,
} from "../../src/billing/types";

/**
 * An in-memory `BillingStore` for unit tests, with its writes observable — and with the customer
 * foreign key the real database enforces: a subscription row whose customer row is missing is
 * refused here the way PostgreSQL refuses it there, so a code path that would drop a webhook on a
 * 23503 in production drops it in a unit test too. The thrown error is deliberately a plain Error,
 * not a `BillingError`: the store layer has no sentinel for a constraint the caller was supposed
 * to keep, and a plain throw is what the service's catch actually sees from the driver.
 */
export function memoryBillingStore(): BillingStore & {
  customers: Map<string, { name: string | null }>;
  subscriptions: Map<string, BillingSubscriptionRow>;
  inbox: Map<string, { uniqueKey?: string; webhookType: string; objectId?: string }>;
} {
  const customers = new Map<string, { name: string | null }>();
  const subscriptions = new Map<string, BillingSubscriptionRow>();
  const inbox = new Map<
    string,
    { uniqueKey?: string; webhookType: string; objectId?: string }
  >();
  return {
    customers,
    subscriptions,
    inbox,
    async upsertCustomer(input) {
      customers.set(input.externalId, { name: input.name });
    },
    async ensureCustomerRow(input) {
      if (!customers.has(input.externalId)) {
        customers.set(input.externalId, { name: null });
      }
    },
    async upsertSubscription(input) {
      if (!customers.has(input.externalCustomerId)) {
        throw new Error(
          `billing_subscriptions_external_customer_id_fkey: customer row is missing for ${input.externalCustomerId}`,
        );
      }
      subscriptions.set(input.externalSubscriptionId, { ...input });
    },
    async readSubscriptions(externalCustomerId) {
      return [...subscriptions.values()].filter(
        (row) => row.externalCustomerId === externalCustomerId,
      );
    },
    async hasWebhookEvent(provider, eventId) {
      return inbox.has(`${provider}:${eventId}`);
    },
    async recordWebhookEvent(input) {
      const key = `${input.provider}:${input.eventId}`;
      if (inbox.has(key)) return false;
      inbox.set(key, {
        ...(input.uniqueKey ? { uniqueKey: input.uniqueKey } : {}),
        webhookType: input.webhookType,
        ...(input.objectId ? { objectId: input.objectId } : {}),
      });
      return true;
    },
    async snapshot() {
      const times = [...customers.keys()];
      return {
        customers: customers.size,
        subscriptions: subscriptions.size,
        ...(times.length > 0 ? { lastSyncedAt: new Date(0) } : {}),
      };
    },
  };
}
