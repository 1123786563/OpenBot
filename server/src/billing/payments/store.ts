import { and, asc, count, eq, gte, inArray, lte, sql } from "drizzle-orm";
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
 * The second idempotency is at insert time: the pending-pair partial unique index ((plan_code,
 * provider) WHERE status='pending') makes "one open order per pair" a fact the database holds,
 * and `insertOrder`'s ON CONFLICT DO NOTHING plus the conflict re-read turn a losing racer into
 * the winner's replay answer instead of a second payable QR.
 *
 * Short ids are generated here, not by callers: a `po-` collision (8 random bytes) retries with a
 * fresh draw up to five times, which keeps a database unique violation from becoming an HTTP 500
 * over a probability nobody needs to reason about.
 */

/** How many times an id collision is redrawn before it becomes a terminal failure. */
const ID_COLLISION_RETRIES = 5;

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

export function createPaymentStore(database: Database): PaymentStore {
  return {
    async insertOrder(input) {
      for (let attempt = 0; attempt <= ID_COLLISION_RETRIES; attempt += 1) {
        const id = generateOutTradeNo();
        const rows = await database
          .insert(paymentOrders)
          .values({
            id,
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
          // Two conflicts, both absorbed: the redrawable `po-` id collision, and the pending-pair
          // partial unique index ((plan, provider) WHERE status='pending') that makes "one open
          // order per pair" a database fact. No row back means one of the two fired — the caller
          // below re-reads, and for the pending pair that re-read is the answer (replay the
          // existing order), not a retry.
          .onConflictDoNothing()
          .returning();
        const row = rows[0];
        if (row) return { order: rowOf(row), conflict: null };
        // The pair conflict is not redrawable: an existing pending order for this (plan,
        // provider) is the replay answer, whatever fresh id we draw. Reading it here (rather
        // than only at the service layer) keeps the race closed inside one store call — the
        // read happens after the insert lost, so the winner is already committed.
        const existing = await readPendingRow(
          database,
          input.planCode,
          input.provider,
        );
        if (existing) return { order: existing, conflict: "pending-pair" };
        // No pending row and no inserted row: the loss was on the id alone — redraw.
      }
      // Five redraws colliding is not a probability, it is a broken generator; say so rather
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

    async readPendingOrder(planCode, provider) {
      return readPendingRow(database, planCode, provider);
    },

    async readLatestPaidOrder(planCode) {
      const [row] = await database
        .select()
        .from(paymentOrders)
        .where(
          and(
            eq(paymentOrders.planCode, planCode),
            eq(paymentOrders.status, "paid"),
          ),
        )
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
            eq(paymentOrders.activationState, "pending"),
          ),
        )
        .orderBy(asc(paymentOrders.createdAt))
        .limit(limit);
      return rows.map(rowOf);
    },

    async listOrdersInWindow({ from, to, limit, offset }) {
      const rows = await database
        .select()
        .from(paymentOrders)
        .where(
          and(
            ...(from ? [gte(paymentOrders.createdAt, from)] : []),
            ...(to ? [lte(paymentOrders.createdAt, to)] : []),
          ),
        )
        .orderBy(sql`${paymentOrders.createdAt} DESC`)
        .limit(limit)
        .offset(offset);
      return rows.map(rowOf);
    },

    async countOrdersInWindow({ from, to }) {
      const [row] = await database
        .select({ value: count() })
        .from(paymentOrders)
        .where(
          and(
            ...(from ? [gte(paymentOrders.createdAt, from)] : []),
            ...(to ? [lte(paymentOrders.createdAt, to)] : []),
          ),
        );
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
