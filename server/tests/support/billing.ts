import type {
  BillingStore,
  BillingSubscriptionRow,
} from "../../src/billing/types";

/** An in-memory `BillingStore` for unit tests, with its writes observable. */
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
    async upsertSubscription(input) {
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
