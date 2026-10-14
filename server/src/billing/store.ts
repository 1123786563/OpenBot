import { and, count, eq, max, ne, notInArray } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
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
  const seen = new Set<DrizzleQueryError>();
  while (error instanceof DrizzleQueryError) {
    if (seen.has(error)) return false;
    seen.add(error);
    error = error.cause;
  }
  if (error instanceof Bun.SQL.PostgresError) {
    // Bun 1.4 reports SQLSTATE in errno; older versions put it directly in code.
    const sqlState =
      typeof error.errno === "string" && /^[0-9A-Z]{5}$/.test(error.errno)
        ? error.errno
        : error.code;
    return sqlState.startsWith("08") || RETRYABLE_POSTGRES_CODES.has(sqlState);
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
    if (error instanceof BillingPersistenceError) {
      // An inner store call has already graded its own failure. Re-wrapping would misname the
      // operation (an inner customer_upsert would leave as webhook_apply) and could demote a
      // grade that says retryable — the transaction boundary passes errors through unchanged.
      throw error;
    }
    // Every persistence failure becomes the typed sentinel, graded by retryability. The caller's
    // HTTP answer is 5xx either way: a non-retryable constraint violation is our data problem,
    // not the provider's delivery problem, and answering it 400 would stop the retry that a manual
    // fix later makes worthwhile (audit A8). A synchronous throw from query CONSTRUCTION never
    // reaches here — it happens while the argument is evaluated, before this try — and stays the
    // programming error it is.
    throw new BillingPersistenceError(
      operation,
      isRetryableDatabaseError(error),
      {
        cause: error,
      },
    );
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
  database: Pick<Database, "insert" | "select" | "update" | "transaction">,
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
            if (input.subscriptionsPresentFor !== undefined) {
              // A `subscriptionsPresentFor` delivery carries the provider's full list for that
              // customer, so a local row it does not name retires here, in the same transaction:
              // the delivery either fully applies or fully rolls back. An empty list with the
              // scope set is a real answer — the service's read throws on a malformed body, so an
              // empty list that reached here was a successful read of an empty truth — and
              // retires everything for that customer. No scope means the delivery says nothing
              // about subscriptions (a customer.* event, an unprojected type): nothing retires,
              // because there is no customer to guess at.
              await local.retireAbsentSubscriptions(
                input.subscriptionsPresentFor,
                (input.subscriptions ?? []).map(
                  (subscription) => subscription.externalSubscriptionId,
                ),
              );
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
        // The duplicate signal is control flow thrown from inside the transaction (to roll back
        // the staged projections), so the apply's own persistence wrapper catches it first and it
        // always arrives wrapped — the wrapper grades every failure, so only the sentinel-cause
        // spelling can match. Unwrapping that one layer is reading a business result, not a
        // persistence failure.
        if (
          error instanceof BillingPersistenceError &&
          error.cause === duplicate
        ) {
          return "duplicate";
        }
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
    async retireAbsentSubscriptions(
      externalCustomerId,
      presentExternalSubscriptionIds,
    ) {
      const now = new Date();
      // One UPDATE, guarded by the customer and by "not in the list the provider just returned".
      // `terminated` rather than a delete: the row is the record of what this deployment believed,
      // and a later delivery can still move it back through upsertSubscription. Rows already
      // `terminated` are skipped so the returned count means "rows this call moved".
      const conditions = [
        eq(billingSubscriptions.externalCustomerId, externalCustomerId),
        ne(billingSubscriptions.status, "terminated"),
      ];
      if (presentExternalSubscriptionIds.length > 0) {
        conditions.push(
          notInArray(billingSubscriptions.externalSubscriptionId, [
            ...presentExternalSubscriptionIds,
          ]),
        );
      }
      const rows = await withPersistenceError(
        "subscription_retire",
        database
          .update(billingSubscriptions)
          .set({ status: "terminated", updatedAt: now })
          .where(and(...conditions))
          .returning({ id: billingSubscriptions.externalSubscriptionId }),
      );
      return rows.length;
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
            bodyHash: input.bodyHash ?? null,
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
    async countDeliveriesOfBody(bodyHash) {
      const [row] = await withPersistenceError(
        "webhook_lookup",
        database
          .select({ value: count() })
          .from(billingWebhookEvents)
          .where(eq(billingWebhookEvents.bodyHash, bodyHash)),
      );
      return row?.value ?? 0;
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
