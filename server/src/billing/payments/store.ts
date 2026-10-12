import { and, asc, count, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { paymentEvents, paymentOrders } from "../../db/schema/payment";
import { BillingError } from "../types";
import { generateOutTradeNo } from "./crypto";
import type {
  PaymentEventInput,
  PaymentOrderRecord,
  PaymentOrderStatus,
  PaymentProviderId,
  PaymentStore,
} from "./types";

/**
 * The local money ledger, over the two payment tables (../db/schema/payment.ts).
 *
 * The one transaction in the module is `confirmPaid`: the CAS on the order row and the paid-fact
 * insert commit together or not at all, so the two answers a redelivery can get — "someone else
 * confirmed it" (claimed: false) and "this transaction was already recorded" (alreadyKnown:
 * true) — are both read from committed state, never from a read that can race. The paid fact's
 * partial unique index is the cross-order idempotency key; the insert-or-nothing against it is
 * what turns a replay into data, not into a second payment.
 *
 * The second idempotency is at insert time: the pending-scope partial unique index
 * (deployment_scope WHERE status='pending') makes "one open purchase per deployment" a fact the
 * database holds, and `insertOrder`'s targeted ON CONFLICT plus the conflict re-read turns a
 * losing racer into the winner's order instead of a second payable QR.
 *
 * Short ids are generated here, not by callers: a `po-` collision (8 random bytes) retries with a
 * fresh draw up to five times, which keeps a database unique violation from becoming an HTTP 500
 * over a probability nobody needs to reason about.
 */

/** How many times an id collision is redrawn before it becomes a terminal failure. */
const ID_COLLISION_RETRIES = 5;
const DEPLOYMENT_SCOPE = "default";

function rowOf(order: typeof paymentOrders.$inferSelect): PaymentOrderRecord {
  return {
    id: order.id,
    planCode: order.planCode,
    provider: order.provider,
    amountCents: order.amountCents,
    currency: "CNY",
    status: order.status,
    activationState: order.activationState,
    channelTransactionId: order.channelTransactionId,
    checkoutPayload: order.checkoutPayload,
    expiresAt: order.expiresAt,
    periodStart: order.periodStart,
    periodEnd: order.periodEnd,
    terminalAt: order.terminalAt,
    createdBy: order.createdBy,
    createdAt: order.createdAt,
    version: order.version,
  };
}

type PaymentOrderLockedRow = {
  id: string;
  deploymentScope: string;
  planCode: string;
  provider: PaymentProviderId;
  amountCents: number;
  currency: string;
  status: PaymentOrderStatus;
  activationState: PaymentOrderRecord["activationState"];
  channelTransactionId: string | null;
  checkoutPayload: string | null;
  expiresAt: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
  terminalAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  version: number;
};

function lockedRowOf(row: PaymentOrderLockedRow): PaymentOrderRecord {
  return {
    id: row.id,
    planCode: row.planCode,
    provider: row.provider,
    amountCents: row.amountCents,
    currency: "CNY",
    status: row.status,
    activationState: row.activationState,
    channelTransactionId: row.channelTransactionId,
    checkoutPayload: row.checkoutPayload,
    expiresAt: row.expiresAt,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    terminalAt: row.terminalAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    version: row.version,
  };
}

function eventInput(input: PaymentEventInput & { state?: string }) {
  return {
    id: generateOutTradeNo().replace("po-", "pe-"),
    orderId: input.orderId,
    kind: input.kind,
    code: input.code,
    state: input.state,
    channelTransactionId: input.channelTransactionId,
    amountCents: input.amountCents,
    detail: input.detail,
  };
}

/**
 * The newest still-pending order for one (plan, provider) pair — the replay lookup, shared by
 * the store's own read path and `insertOrder`'s conflict resolution. Newest wins, because with
 * the pending-pair partial unique index there is at most one row to find anyway; the ordering
 * is kept for the memory-doubled tests and for any pre-index database that still holds two.
 */
async function readPendingRow(
  database: Database,
  planCode: string,
  provider: PaymentProviderId,
): Promise<PaymentOrderRecord | null> {
  const [row] = await database
    .select()
    .from(paymentOrders)
    .where(
      and(
        eq(paymentOrders.planCode, planCode),
        eq(paymentOrders.provider, provider),
        eq(paymentOrders.status, "pending"),
      ),
    )
    .orderBy(sql`${paymentOrders.createdAt} DESC`)
    .limit(1);
  return row ? rowOf(row) : null;
}

async function readPendingPurchaseRow(
  database: Database,
): Promise<PaymentOrderRecord | null> {
  const [row] = await database
    .select()
    .from(paymentOrders)
    .where(
      and(
        eq(paymentOrders.deploymentScope, DEPLOYMENT_SCOPE),
        eq(paymentOrders.status, "pending"),
      ),
    )
    .orderBy(sql`${paymentOrders.createdAt} DESC`)
    .limit(1);
  return row ? rowOf(row) : null;
}

function isOrderIdConflict(error: unknown): boolean {
  const visited = new Set<object>();
  while (error && typeof error === "object" && !visited.has(error)) {
    visited.add(error);
    const postgresError = error as {
      code?: unknown;
      errno?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (
      (postgresError.errno ?? postgresError.code) === "23505" &&
      (postgresError.constraint ?? postgresError.constraint_name) ===
        "payment_orders_pkey"
    ) {
      return true;
    }
    error = postgresError.cause;
  }
  return false;
}

export function createPaymentStore(database: Database): PaymentStore {
  return {
    async insertOrder(input) {
      for (let attempt = 0; attempt <= ID_COLLISION_RETRIES; attempt += 1) {
        const id = generateOutTradeNo();
        let rows: (typeof paymentOrders.$inferSelect)[];
        try {
          rows = await database
            .insert(paymentOrders)
            .values({
              id,
              deploymentScope: DEPLOYMENT_SCOPE,
              planCode: input.planCode,
              provider: input.provider,
              amountCents: input.amountCents,
              currency: input.currency,
              status: "pending",
              activationState: "pending",
              checkoutPayload: input.checkoutPayload,
              expiresAt: input.expiresAt,
              createdBy: input.createdBy,
            })
            // This conflict target names the deployment-scope partial unique index exactly. Other
            // unique violations, notably the primary-key id collision below, are not swallowed.
            .onConflictDoNothing({
              target: paymentOrders.deploymentScope,
              where: sql`${paymentOrders.status} = 'pending'`,
            })
            .returning();
        } catch (error) {
          if (isOrderIdConflict(error)) continue;
          throw error;
        }
        const row = rows[0];
        if (row) return { order: rowOf(row), conflict: null };
        // A targeted pending-scope conflict is resolved from committed state. Its owner may be
        // the same plan/provider (a replay) or any other purchase on this deployment.
        const existing = await readPendingPurchaseRow(database);
        if (existing) {
          const conflict =
            existing.planCode === input.planCode &&
            existing.provider === input.provider
              ? "pending-pair"
              : "pending-purchase";
          return { order: existing, conflict };
        }
        // The winner may have become terminal before this read; try again in the now-free slot.
      }
      // Five primary-key collisions is not a probability, it is a broken generator; say so rather
      // than loop.
      throw new BillingError("invalid_response");
    },

    async readOrder(id) {
      const [row] = await database
        .select()
        .from(paymentOrders)
        .where(eq(paymentOrders.id, id))
        .limit(1);
      return row ? rowOf(row) : null;
    },

    async readPendingPurchase() {
      return readPendingPurchaseRow(database);
    },

    async readPendingOrder(planCode, provider) {
      return readPendingRow(database, planCode, provider);
    },

    async readLatestPaidOrder(planCode, excludeOrderId) {
      // The conditions are built FLAT, not spread from an array inside and(): this drizzle
      // version's `and()` takes its conditions as direct arguments, and a spread array among
      // them silently degrades the whole predicate (the exclusion vanished exactly that way
      // once — the caller's own confirm kept answering itself and duplicate_paid never fired).
      const conditions = [
        eq(paymentOrders.planCode, planCode),
        eq(paymentOrders.status, "paid"),
      ];
      // The duplicate check runs AFTER the caller's own confirm, and that confirm stamps
      // the caller's terminalAt with now() — without the exclusion the newest paid row is
      // always the caller itself, and the anomaly can never fire (the sequential
      // cross-provider double payment, where exactly this happened, is pinned by
      // qa-batch1-duplicate-paid.integration.test.ts).
      if (excludeOrderId !== undefined) {
        conditions.push(ne(paymentOrders.id, excludeOrderId));
      }
      const [row] = await database
        .select()
        .from(paymentOrders)
        .where(and(...conditions))
        .orderBy(sql`${paymentOrders.terminalAt} DESC NULLS LAST`)
        .limit(1);
      return row ? rowOf(row) : null;
    },

    async readLatestLiveOrder() {
      const [row] = await database
        .select()
        .from(paymentOrders)
        .where(inArray(paymentOrders.status, ["pending", "paid"]))
        .orderBy(sql`${paymentOrders.createdAt} DESC`)
        .limit(1);
      return row ? rowOf(row) : null;
    },

    async setCheckoutPayload(id, payload) {
      await database
        .update(paymentOrders)
        .set({ checkoutPayload: payload })
        .where(eq(paymentOrders.id, id));
    },

    async cancelOrder(id, expectedVersion) {
      const rows = await database
        .update(paymentOrders)
        .set({
          status: "canceled",
          terminalAt: new Date(),
          version: expectedVersion + 1,
        })
        .where(
          and(
            eq(paymentOrders.id, id),
            eq(paymentOrders.version, expectedVersion),
            eq(paymentOrders.status, "pending"),
          ),
        )
        .returning({ id: paymentOrders.id });
      return rows.length > 0;
    },

    async confirmPaid(input) {
      // The replay check first, outside the transaction: a known transaction is answered from the
      // unique index's contents, and the insert inside still re-checks it, so this read is a fast
      // path, not the guarantee.
      const [known] = await database
        .select({ id: paymentEvents.id })
        .from(paymentEvents)
        .where(
          and(
            eq(paymentEvents.channelTransactionId, input.channelTransactionId),
            eq(paymentEvents.kind, "fact"),
            eq(paymentEvents.state, "paid"),
          ),
        )
        .limit(1);
      if (known) return { claimed: false, alreadyKnown: true };

      return database
        .transaction(async (tx) => {
          const moved = await tx
            .update(paymentOrders)
            .set({
              status: "paid",
              channelTransactionId: input.channelTransactionId,
              periodStart: input.periodStart,
              periodEnd: input.periodEnd,
              terminalAt: new Date(),
              version: input.expectedVersion + 1,
            })
            .where(
              and(
                eq(paymentOrders.id, input.id),
                eq(paymentOrders.version, input.expectedVersion),
                inArray(paymentOrders.status, [...input.fromStatuses]),
              ),
            )
            .returning({ id: paymentOrders.id });
          if (moved.length === 0)
            return { claimed: false, alreadyKnown: false };

          // The insert carries the idempotency: inside the same transaction, a concurrent
          // confirmation of the same transaction id loses here even if the CAS above somehow let
          // both through — it cannot, but the index does not rely on that.
          const inserted = await tx
            .insert(paymentEvents)
            .values(
              eventInput({
                orderId: input.id,
                kind: "fact",
                code: "paid",
                state: "paid",
                channelTransactionId: input.channelTransactionId,
                amountCents: input.amountCents,
                detail: "",
              }),
            )
            .onConflictDoNothing()
            .returning({ id: paymentEvents.id });
          if (inserted.length === 0) {
            // Another order already holds this transaction's paid fact. Abort so the CAS above
            // rolls back — one transaction id, one paid order — and tell the caller through the
            // return value, not an exception across the seam: this is a verdict, not a fault.
            throw new TransactionAlreadyKnown();
          }
          return { claimed: true, alreadyKnown: false };
        })
        .catch((error: unknown) => {
          if (error instanceof TransactionAlreadyKnown) {
            return { claimed: false, alreadyKnown: true };
          }
          throw error;
        });
    },

    async blockOrder(input) {
      return database.transaction(async (tx) => {
        const moved = await tx
          .update(paymentOrders)
          .set({
            status: "blocked",
            terminalAt: new Date(),
            version: input.expectedVersion + 1,
          })
          .where(
            and(
              eq(paymentOrders.id, input.id),
              eq(paymentOrders.version, input.expectedVersion),
              eq(paymentOrders.status, "pending"),
            ),
          )
          .returning({ id: paymentOrders.id });
        if (moved.length === 0) return false;
        await tx.insert(paymentEvents).values(
          eventInput({
            orderId: input.id,
            kind: "anomaly",
            code: "amount_mismatch",
            channelTransactionId: input.channelTransactionId,
            amountCents: input.amountCents,
            detail: input.detail,
          }),
        );
        return true;
      });
    },

    async expireOrder(id, expectedVersion) {
      const rows = await database
        .update(paymentOrders)
        .set({
          status: "expired",
          terminalAt: new Date(),
          version: expectedVersion + 1,
        })
        .where(
          and(
            eq(paymentOrders.id, id),
            eq(paymentOrders.version, expectedVersion),
            eq(paymentOrders.status, "pending"),
          ),
        )
        .returning({ id: paymentOrders.id });
      return rows.length > 0;
    },

    async recordAnomaly(event) {
      // Targetless DO NOTHING: any uniqueness this insert trips — the (order_id, code) anomaly
      // key above all — answers "already recorded", which is exactly what a channel
      // redelivering a refused notification deserves (P2-2: Alipay retries a 409 up to eight
      // times; each retry used to append a duplicate row). The FIRST row's detail stands.
      await database
        .insert(paymentEvents)
        .values(eventInput({ ...event, kind: "anomaly", state: undefined }))
        .onConflictDoNothing();
    },

    async countAnomalies(orderId, code) {
      const [row] = await database
        .select({ value: count() })
        .from(paymentEvents)
        .where(
          and(
            eq(paymentEvents.orderId, orderId),
            eq(paymentEvents.kind, "anomaly"),
            eq(paymentEvents.code, code),
          ),
        );
      return row?.value ?? 0;
    },

    async recordPaidFact(event) {
      const inserted = await database
        .insert(paymentEvents)
        .values(
          eventInput({
            orderId: event.orderId,
            kind: "fact",
            code: "paid",
            state: "paid",
            channelTransactionId: event.channelTransactionId,
            amountCents: event.amountCents,
            detail: "",
          }),
        )
        .onConflictDoNothing()
        .returning({ id: paymentEvents.id });
      return inserted.length > 0;
    },

    async recordActivation(id, activationState) {
      await database
        .update(paymentOrders)
        .set({ activationState })
        .where(eq(paymentOrders.id, id));
    },

    async resolveActivationOwnership(orderId) {
      return database.transaction(async (tx) => {
        const [anchor] = await tx
          .select()
          .from(paymentOrders)
          .where(eq(paymentOrders.id, orderId))
          .limit(1);
        if (!anchor) return { outcome: "unknown" as const };
        if (anchor.status !== "paid") return { outcome: "not-paid" as const };
        if (!anchor.periodStart || !anchor.periodEnd) {
          return { outcome: "not-paid" as const };
        }

        const locked = await tx.execute(sql`
          select
            "id",
            "deployment_scope" as "deploymentScope",
            "plan_code" as "planCode",
            "provider",
            "amount_cents" as "amountCents",
            "currency",
            "status",
            "activation_state" as "activationState",
            "channel_transaction_id" as "channelTransactionId",
            "checkout_payload" as "checkoutPayload",
            "expires_at" as "expiresAt",
            "period_start" as "periodStart",
            "period_end" as "periodEnd",
            "terminal_at" as "terminalAt",
            "created_by" as "createdBy",
            "created_at" as "createdAt",
            "version"
          from "payment_orders"
          where "deployment_scope" = ${anchor.deploymentScope}
            and "plan_code" = ${anchor.planCode}
            and "status" = 'paid'
            and "period_start" is not null
            and "period_end" is not null
            and "period_start" < ${anchor.periodEnd}
            and "period_end" > ${anchor.periodStart}
          order by "period_start" asc, "created_at" asc, "id" asc
          for update
        `);
        const rows = (
          Array.isArray(locked)
            ? locked
            : ((locked as { rows?: unknown[] }).rows ?? [])
        ) as PaymentOrderLockedRow[];
        const lockedOrders = rows.map(lockedRowOf);
        const current = lockedOrders.find((row) => row.id === orderId);
        const owner = lockedOrders[0];
        if (!current || !owner) return { outcome: "unknown" as const };
        if (owner.id === current.id) {
          return { outcome: "owner" as const, order: current };
        }
        return {
          outcome: "duplicate" as const,
          order: current,
          ownerOrder: owner,
        };
      });
    },

    async listExpiredPendingOrders(now, limit) {
      const rows = await database
        .select()
        .from(paymentOrders)
        .where(
          and(
            eq(paymentOrders.status, "pending"),
            lte(paymentOrders.expiresAt, now),
          ),
        )
        .orderBy(asc(paymentOrders.expiresAt))
        .limit(limit);
      return rows.map(rowOf);
    },

    async listPaidPendingActivationOrders(limit) {
      const rows = await database
        .select()
        .from(paymentOrders)
        .where(
          and(
            eq(paymentOrders.status, "paid"),
            // `failed` beside `pending`: the sweep retries both (P1-4 — a rule-refused
            // activation is the provider's fact, and it can change). See the seam's docblock
            // for why the name keeps its historical spelling.
            inArray(paymentOrders.activationState, ["pending", "failed"]),
          ),
        )
        .orderBy(asc(paymentOrders.createdAt))
        .limit(limit);
      return rows.map(rowOf);
    },

    async listOrdersInWindow({ from, to, limit, offset }) {
      // Flat condition construction (see readLatestPaidOrder's note): this drizzle version's
      // `and()` takes conditions as direct arguments, and a spread array among them silently
      // degrades the whole predicate — an optional-end window must degrade to "no bound", not
      // to a broken filter.
      const conditions = [];
      if (from) conditions.push(gte(paymentOrders.createdAt, from));
      if (to) conditions.push(lte(paymentOrders.createdAt, to));
      const rows = await database
        .select()
        .from(paymentOrders)
        .where(and(...conditions))
        .orderBy(sql`${paymentOrders.createdAt} DESC`)
        .limit(limit)
        .offset(offset);
      return rows.map(rowOf);
    },

    async countOrdersInWindow({ from, to }) {
      // Same flat construction as listOrdersInWindow above; the two must filter identically
      // or the pager and the page disagree.
      const conditions = [];
      if (from) conditions.push(gte(paymentOrders.createdAt, from));
      if (to) conditions.push(lte(paymentOrders.createdAt, to));
      const [row] = await database
        .select({ value: count() })
        .from(paymentOrders)
        .where(and(...conditions));
      return row?.value ?? 0;
    },
  };
}

/** Internal signal: the paid fact was claimed by another order; the caller records the anomaly. */
class TransactionAlreadyKnown extends Error {
  override name = "TransactionAlreadyKnown";
}

/** The statuses a paid confirmation may legally move from, as the service passes them. */
export const PAYABLE_FROM: readonly PaymentOrderStatus[] = [
  "pending",
  "expired",
  "canceled",
];
