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

const RETRYABLE_POSTGRES_CODES = new Set([
  "40001",
  "40P01",
  "55P03",
  "57P01",
  "57P02",
  "57P03",
  "53300",
]);

const RETRYABLE_CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EPIPE",
]);

function isRetryableDatabaseError(error: unknown): boolean {
  if (error instanceof Bun.SQL.PostgresError) {
    return (
      error.code.startsWith("08") || RETRYABLE_POSTGRES_CODES.has(error.code)
    );
  }
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    RETRYABLE_CONNECTION_CODES.has(error.code)
  );
}

async function withPersistenceError<T>(
  operation: BillingPersistenceOperation,
  query: PromiseLike<T>,
): Promise<T> {
  try {
    return await query;
  } catch (error) {
    if (!isRetryableDatabaseError(error)) throw error;
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
export function createBillingStore(
  database: Pick<Database, "insert" | "select" | "transaction">,
): BillingStore {
  return {
    async applyWebhookProjection(input) {
      const duplicate = new Error("Duplicate billing webhook.");
      try {
        return await withPersistenceError(
          "webhook_apply",
          database.transaction(async (transaction) => {
            const local = createBillingStore(transaction);
            if (input.customer) {
              if (input.customer.name === undefined) {
                await local.ensureCustomerRow(input.customer);
              } else {
                await local.upsertCustomer({
                  externalId: input.customer.externalId,
                  name: input.customer.name,
                });
              }
            }
            for (const subscription of input.subscriptions ?? []) {
              await local.upsertSubscription(subscription);
            }
            if (!(await local.recordWebhookEvent(input.event))) {
              // ON CONFLICT waits for the winner to commit. Roll back this delivery's staged
              // projections too, so a stale concurrent duplicate cannot overwrite the winner.
              throw duplicate;
            }
            return "processed" as const;
          }),
        );
      } catch (error) {
        if (error === duplicate) return "duplicate";
        throw error;
      }
    },
    async upsertCustomer(input) {
      const now = new Date();
      await withPersistenceError(
        "customer_upsert",
        database
          .insert(billingCustomers)
          .values({
            externalId: input.externalId,
            name: input.name,
            lastSyncedAt: now,
          })
          .onConflictDoUpdate({
            target: billingCustomers.externalId,
            set: { name: input.name, lastSyncedAt: now },
          }),
      );
    },
    async ensureCustomerRow(input) {
      // Insert-only: a row that already exists — with the name an earlier refresh wrote — is left
      // exactly as it is. This is the webhook path's floor under the subscription foreign key, not
      // a refresh; the placeholder it may insert is nameless and waits for a real read.
      await withPersistenceError(
        "customer_ensure",
        database
          .insert(billingCustomers)
          .values({ externalId: input.externalId, name: null })
          .onConflictDoNothing({ target: billingCustomers.externalId }),
      );
    },
    async upsertSubscription(input) {
      const now = new Date();
      await withPersistenceError(
        "subscription_upsert",
        database
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
          }),
      );
    },
    async readSubscriptions(externalCustomerId) {
      return withPersistenceError(
        "subscription_read",
        database
          .select()
          .from(billingSubscriptions)
          .where(
            eq(billingSubscriptions.externalCustomerId, externalCustomerId),
          ),
      );
    },
    async hasWebhookEvent(provider, eventId) {
      const rows = await withPersistenceError(
        "webhook_lookup",
        database
          .select({ one: billingWebhookEvents.eventId })
          .from(billingWebhookEvents)
          .where(
            and(
              eq(billingWebhookEvents.provider, provider),
              eq(billingWebhookEvents.eventId, eventId),
            ),
          )
          .limit(1),
      );
      return rows[0] !== undefined;
    },
    async recordWebhookEvent(input) {
      const rows = await withPersistenceError(
        "webhook_record",
        database
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
          .returning({ eventId: billingWebhookEvents.eventId }),
      );
      return rows.length > 0;
    },
    async snapshot() {
      const [customers] = await withPersistenceError(
        "snapshot",
        database.select({ value: count() }).from(billingCustomers),
      );
      const [subscriptions] = await withPersistenceError(
        "snapshot",
        database.select({ value: count() }).from(billingSubscriptions),
      );
      const [latest] = await withPersistenceError(
        "snapshot",
        database
          .select({ value: max(billingCustomers.lastSyncedAt) })
          .from(billingCustomers),
      );
      return {
        customers: customers?.value ?? 0,
        subscriptions: subscriptions?.value ?? 0,
        ...(latest?.value ? { lastSyncedAt: latest.value } : {}),
      };
    },
  };
}
