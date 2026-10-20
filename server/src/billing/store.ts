import { and, count, eq, max, ne, notInArray, sql } from "drizzle-orm";
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
  type OwnedSubscriptionRow,
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
      // Buffered by the retirement inside the transaction, flushed only once it committed: a
      // rolled-back apply — the duplicate loser — moved nothing durable, so it must not have
      // already told the world a retirement happened (audit B6 review r1).
      let retired: { externalCustomerId: string; count: number } | undefined;
      try {
        const status = await withPersistenceError(
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
              // because there is no customer to guess at. The moved count is buffered for
              // `onRetired`, which the commit path below flushes.
              const moved = await local.retireAbsentSubscriptions(
                input.subscriptionsPresentFor,
                (input.subscriptions ?? []).map(
                  (subscription) => subscription.externalSubscriptionId,
                ),
              );
              if (moved > 0) {
                retired = {
                  externalCustomerId: input.subscriptionsPresentFor,
                  count: moved,
                };
              }
            }
            if (!(await local.recordWebhookEvent(input.event))) {
              // ON CONFLICT waits for the winner to commit. Roll back this delivery's staged
              // projections too, so a stale concurrent duplicate cannot overwrite the winner.
              throw duplicate;
            }
            return "processed" as const;
          }),
        );
        // The transaction committed: the buffered count is durable evidence, never a phantom.
        if (retired !== undefined && input.onRetired !== undefined) {
          input.onRetired(retired);
        }
        return status;
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
            // BP05 (#373): the row's identity is the (customer, subscription) pair — the
            // provider's own namespace. A subscription never moves between customers: the
            // customer is identity here exactly as the owner pair is, and a delivery scoped
            // to one customer can never adopt (or re-home) another customer's row.
            target: [
              billingSubscriptions.externalCustomerId,
              billingSubscriptions.externalSubscriptionId,
            ],
            set: {
              planCode: input.planCode,
              status: input.status,
              updatedAt: now,
            },
          }),
      );
    },
    async stampSubscriptionOwnership(input) {
      const now = new Date();
      const rows = await withPersistenceError(
        "subscription_stamp",
        database
          .update(billingSubscriptions)
          .set({
            ownerPayerKind: input.ownerPayerKind,
            ownerPayerId: input.ownerPayerId,
            allowancePeriodStart: input.allowancePeriodStart,
            allowancePeriodEnd: input.allowancePeriodEnd,
            updatedAt: now,
          })
          .where(
            and(
              eq(
                billingSubscriptions.externalCustomerId,
                input.externalCustomerId,
              ),
              eq(
                billingSubscriptions.externalSubscriptionId,
                input.externalSubscriptionId,
              ),
            ),
          )
          .returning({ id: billingSubscriptions.externalSubscriptionId }),
      );
      // `false` is the activation retry's answer, not an error: the row this stamp names was
      // created through ensureSubscription moments ago, so absence means the fold has not
      // committed yet (or the provider answered a different external id) — the next pass
      // re-runs the whole idempotent sequence.
      return rows.length > 0;
    },
    async advanceSubscriptionAllowance(input) {
      const now = new Date();
      const rows = await withPersistenceError(
        "subscription_allowance",
        database
          .update(billingSubscriptions)
          .set({
            allowancePeriodStart: input.allowancePeriodStart,
            allowancePeriodEnd: input.allowancePeriodEnd,
            updatedAt: now,
          })
          .where(
            and(
              eq(
                billingSubscriptions.externalCustomerId,
                input.externalCustomerId,
              ),
              eq(
                billingSubscriptions.externalSubscriptionId,
                input.externalSubscriptionId,
              ),
              // Forward-only: a marker already at — or past — this period is the answer
              // "covered", and an out-of-order delivery must not walk it backwards.
              sql`(${billingSubscriptions.allowancePeriodStart} IS NULL OR ${billingSubscriptions.allowancePeriodStart} < ${input.allowancePeriodStart.toISOString()}::timestamptz)`,
            ),
          )
          .returning({ id: billingSubscriptions.externalSubscriptionId }),
      );
      return rows.length > 0;
    },
    async readLiveOwnedSubscriptions(externalCustomerId) {
      const conditions = [
        sql`${billingSubscriptions.status} IN ('active', 'incomplete')`,
        sql`${billingSubscriptions.ownerPayerId} IS NOT NULL`,
      ];
      if (externalCustomerId !== undefined) {
        conditions.push(
          eq(billingSubscriptions.externalCustomerId, externalCustomerId),
        );
      }
      const rows = await withPersistenceError(
        "subscription_read",
        database
          .select({
            externalCustomerId: billingSubscriptions.externalCustomerId,
            externalSubscriptionId: billingSubscriptions.externalSubscriptionId,
            planCode: billingSubscriptions.planCode,
            status: billingSubscriptions.status,
            ownerPayerKind: billingSubscriptions.ownerPayerKind,
            ownerPayerId: billingSubscriptions.ownerPayerId,
            allowancePeriodStart: billingSubscriptions.allowancePeriodStart,
            allowancePeriodEnd: billingSubscriptions.allowancePeriodEnd,
          })
          .from(billingSubscriptions)
          .where(and(...conditions)),
      );
      // The owner-pair CHECK makes a half-written row impossible; the filter narrows the
      // nullable columns into the owned shape without lying about it.
      const owned: OwnedSubscriptionRow[] = [];
      for (const row of rows) {
        if (row.ownerPayerKind && row.ownerPayerId) {
          owned.push({
            ...row,
            ownerPayerKind: row.ownerPayerKind,
            ownerPayerId: row.ownerPayerId,
          });
        }
      }
      return owned;
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
