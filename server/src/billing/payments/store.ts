import { and, asc, count, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { paymentEvents, paymentOrders } from "../../db/schema/payment";
import type { PayerRef } from "../payer";
import { BillingError } from "../types";
import { generateOutTradeNo } from "./crypto";
import type {
  PaymentEventInput,
  PaymentOrderEventRecord,
  PaymentOrderReadScope,
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

/** The owner kinds an order may legally carry; `unknown_owner` is deliberately absent. */
const OWNABLE_PAYER_KINDS = new Set([
  "personal",
  "company",
  "legacy_deployment",
]);

/**
 * Validate the owner a caller binds to a NEW order, as a last line behind the service's
 * business refusal: present, well-formed, whitespace-strict (the payer layer's own rule —
 * a padded id would mint a second identity), and never the quarantined `unknown_owner` kind.
 * An order is attributed or it is not created; quarantine is a legacy-row verdict.
 */
function assertOwnablePayerRef(ref: PayerRef | undefined): ref is PayerRef {
  if (
    !ref ||
    typeof ref !== "object" ||
    typeof ref.id !== "string" ||
    ref.id.length === 0 ||
    ref.id.trim() !== ref.id ||
    typeof ref.kind !== "string" ||
    !OWNABLE_PAYER_KINDS.has(ref.kind)
  ) {
    throw new TypeError(
      "insertOrder needs a well-formed ownerPayerRef whose kind is personal, company or legacy_deployment: an order is attributed at creation, never ownerless and never quarantined.",
    );
  }
  return true;
}

/** The two columns one PayerRef rides on, as the row spells them. */
function ownerColumnsOf(ref: PayerRef) {
  return { ownerPayerKind: ref.kind, ownerPayerId: ref.id };
}

/** The owner a row names, or null — the pre-attribution state only legacy rows sit in. */
function ownerRefOf(row: {
  ownerPayerKind: string | null;
  ownerPayerId: string | null;
}): PayerRef | null {
  if (row.ownerPayerKind === null || row.ownerPayerId === null) return null;
  return { kind: row.ownerPayerKind as PayerRef["kind"], id: row.ownerPayerId };
}

function rowOf(order: typeof paymentOrders.$inferSelect): PaymentOrderRecord {
  return {
    id: order.id,
    planCode: order.planCode,
    provider: order.provider,
    amountCents: order.amountCents,
    currency: order.currency,
    status: order.status,
    activationState: order.activationState,
    activationFailureReason: order.activationFailureReason,
    activationNextRetryAt: order.activationNextRetryAt,
    channelTransactionId: order.channelTransactionId,
    checkoutPayload: order.checkoutPayload,
    expiresAt: order.expiresAt,
    periodStart: order.periodStart,
    periodEnd: order.periodEnd,
    paidAt: order.paidAt,
    terminalAt: order.terminalAt,
    createdBy: order.createdBy,
    ownerPayerRef: ownerRefOf(order),
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
  activationFailureReason: string | null;
  activationNextRetryAt: Date | null;
  channelTransactionId: string | null;
  checkoutPayload: string | null;
  expiresAt: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
  paidAt: Date | null;
  terminalAt: Date | null;
  createdBy: string | null;
  ownerPayerKind: string | null;
  ownerPayerId: string | null;
  createdAt: Date;
  version: number;
};

function lockedRowOf(row: PaymentOrderLockedRow): PaymentOrderRecord {
  return {
    id: row.id,
    planCode: row.planCode,
    provider: row.provider,
    amountCents: row.amountCents,
    currency: row.currency,
    status: row.status,
    activationState: row.activationState,
    activationFailureReason: row.activationFailureReason,
    activationNextRetryAt: row.activationNextRetryAt,
    channelTransactionId: row.channelTransactionId,
    checkoutPayload: row.checkoutPayload,
    expiresAt: row.expiresAt,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    paidAt: row.paidAt,
    terminalAt: row.terminalAt,
    createdBy: row.createdBy,
    ownerPayerRef: ownerRefOf(row),
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
 * The personal read scope's condition: the order's OWNER columns against the scope's PayerRef.
 * Converged from the historical created_by filter (10.1): the creator is an audit identity, the
 * owner is the payment subject — reads follow the owner, and a null or non-matching owner (a
 * quarantined or pre-attribution legacy row) never matches any personal scope.
 */
function ownerScopeCondition(scope: PaymentOrderReadScope | undefined) {
  if (!scope) return undefined;
  return and(
    eq(paymentOrders.ownerPayerKind, scope.actorPayerRef.kind),
    eq(paymentOrders.ownerPayerId, scope.actorPayerRef.id),
  );
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
  owner?: PayerRef,
): Promise<PaymentOrderRecord | null> {
  const conditions = [
    eq(paymentOrders.planCode, planCode),
    eq(paymentOrders.provider, provider),
    eq(paymentOrders.status, "pending"),
  ];
  if (owner) {
    conditions.push(eq(paymentOrders.ownerPayerKind, owner.kind));
    conditions.push(eq(paymentOrders.ownerPayerId, owner.id));
  }
  const [row] = await database
    .select()
    .from(paymentOrders)
    .where(and(...conditions))
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

function byOverlapWinner(a: PaymentOrderRecord, b: PaymentOrderRecord): number {
  const byStart =
    (a.periodStart?.getTime() ?? Number.MAX_SAFE_INTEGER) -
    (b.periodStart?.getTime() ?? Number.MAX_SAFE_INTEGER);
  if (byStart !== 0) return byStart;
  const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
  if (byCreated !== 0) return byCreated;
  return a.id.localeCompare(b.id);
}

function byClaimedOwner(a: PaymentOrderRecord, b: PaymentOrderRecord): number {
  const byApplied =
    Number(b.activationState === "applied") -
    Number(a.activationState === "applied");
  if (byApplied !== 0) return byApplied;
  const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
  if (byCreated !== 0) return byCreated;
  return a.id.localeCompare(b.id);
}

function isOrderIdConflict(error: unknown): boolean {
  return isUniqueViolationOn(error, "payment_orders_pkey");
}

/**
 * The paid-fact insert's own id collision (audit F3): a `pe-` primary-key conflict is an unknown
 * conflict — it must be redrawn, never classified as "this transaction is already known", which
 * is the channel-transaction index's verdict alone.
 */
function isPaymentEventIdConflict(error: unknown): boolean {
  return isUniqueViolationOn(error, "payment_events_pkey");
}

function isUniqueViolationOn(error: unknown, constraint: string): boolean {
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
      (postgresError.constraint ?? postgresError.constraint_name) === constraint
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
      assertOwnablePayerRef(input.ownerPayerRef);
      const owner = ownerColumnsOf(input.ownerPayerRef);
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
              ...owner,
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

    async readOrder(id, scope) {
      const conditions = [eq(paymentOrders.id, id)];
      const ownerScope = ownerScopeCondition(scope);
      if (ownerScope) conditions.push(ownerScope);
      const [row] = await database
        .select()
        .from(paymentOrders)
        .where(and(...conditions))
        .limit(1);
      return row ? rowOf(row) : null;
    },

    async readPendingPurchase() {
      return readPendingPurchaseRow(database);
    },

    async readPendingOrder(planCode, provider, owner) {
      return readPendingRow(database, planCode, provider, owner);
    },

    async readLatestLiveOrder(scope) {
      const conditions = [inArray(paymentOrders.status, ["pending", "paid"])];
      const ownerScope = ownerScopeCondition(scope);
      if (ownerScope) conditions.push(ownerScope);
      const [row] = await database
        .select()
        .from(paymentOrders)
        .where(and(...conditions))
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

      // A `pe-` id collision aborts the whole transaction (Postgres), so the retry re-runs the
      // CAS and the insert together with a fresh id — the same redraw loop insertOrder gives a
      // colliding `po-` id (audit F3: an unknown conflict is never the already-known verdict).
      for (let attempt = 0; attempt <= ID_COLLISION_RETRIES; attempt += 1) {
        let outcome: { claimed: boolean; alreadyKnown: boolean };
        try {
          outcome = await database.transaction(async (tx) => {
            const paidAt = new Date();
            const moved = await tx
              .update(paymentOrders)
              .set({
                status: "paid",
                channelTransactionId: input.channelTransactionId,
                periodStart: input.periodStart,
                periodEnd: input.periodEnd,
                paidAt,
                terminalAt: paidAt,
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
            // confirmation of the same transaction id loses here even if the CAS above somehow
            // let both through — it cannot, but the index does not rely on that. The conflict
            // target names the channel-transaction partial unique index exactly, so ONLY a
            // known-transaction conflict lands in the no-op branch; any other uniqueness the
            // insert trips (a colliding `pe-` id above all) surfaces as the 23505 it is.
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
              .onConflictDoNothing({
                target: paymentEvents.channelTransactionId,
                where: sql`${paymentEvents.kind} = 'fact' AND ${paymentEvents.state} = 'paid'`,
              })
              .returning({ id: paymentEvents.id });
            if (inserted.length === 0) {
              // Another order already holds this transaction's paid fact. Abort so the CAS above
              // rolls back — one transaction id, one paid order — and tell the caller through the
              // return value, not an exception across the seam: this is a verdict, not a fault.
              throw new TransactionAlreadyKnown();
            }
            return { claimed: true, alreadyKnown: false };
          });
        } catch (error) {
          if (isPaymentEventIdConflict(error)) continue;
          if (error instanceof TransactionAlreadyKnown) {
            return { claimed: false, alreadyKnown: true };
          }
          throw error;
        }
        return outcome;
      }
      // Five primary-key collisions is not a probability, it is a broken generator; say so rather
      // than loop.
      throw new BillingError("invalid_response");
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
      // Targeted DO NOTHING against the (order_id, code) anomaly key above all — that is
      // the uniqueness a channel redelivering a refused notification trips (P2-2: Alipay
      // retries a 409 up to eight times; each retry used to append a duplicate row). The
      // FIRST row's detail stands. Any OTHER uniqueness — a `pe-` id collision above all —
      // now throws instead of being silently swallowed as "already recorded".
      await database
        .insert(paymentEvents)
        .values(eventInput({ ...event, kind: "anomaly", state: undefined }))
        .onConflictDoNothing({
          target: [paymentEvents.orderId, paymentEvents.code],
          // The arbiter predicate must IMPLY the partial index's predicate (kind='anomaly'
          // AND code<>'amount_unreadable') or Postgres rejects the statement outright (42P10).
          where: sql`${paymentEvents.kind} = 'anomaly' AND ${paymentEvents.code} <> 'amount_unreadable'`,
        });
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
        // The conflict target names the channel-transaction partial unique index exactly, as
        // confirmPaid's insert does: ONLY a known-transaction conflict answers "already
        // recorded"; any other uniqueness (a colliding `pe-` id above all) surfaces instead
        // of being silently swallowed as one.
        .onConflictDoNothing({
          target: paymentEvents.channelTransactionId,
          where: sql`${paymentEvents.kind} = 'fact' AND ${paymentEvents.state} = 'paid'`,
        })
        .returning({ id: paymentEvents.id });
      return inserted.length > 0;
    },

    async readPaidOrderByTransaction(channelTransactionId) {
      const [row] = await database
        .select()
        .from(paymentOrders)
        .where(
          and(
            eq(paymentOrders.status, "paid"),
            eq(paymentOrders.channelTransactionId, channelTransactionId),
          ),
        )
        .orderBy(sql`${paymentOrders.createdAt} ASC`)
        .limit(1);
      return row ? rowOf(row) : null;
    },

    async recordActivation(id, activationState, period) {
      await database
        .update(paymentOrders)
        .set({
          activationState,
          // A landed activation has no outstanding failure: the retained reason and retry
          // schedule clear with the verdict that settles them (BP03/#371).
          ...(activationState === "applied"
            ? { activationFailureReason: null, activationNextRetryAt: null }
            : {}),
          ...(period
            ? { periodStart: period.start, periodEnd: period.end }
            : {}),
        })
        .where(eq(paymentOrders.id, id));
    },

    async recordActivationFailure(input) {
      await database
        .update(paymentOrders)
        .set({
          activationFailureReason: input.reason,
          activationNextRetryAt: input.nextRetryAt,
          ...(input.activationState
            ? { activationState: input.activationState }
            : {}),
        })
        .where(eq(paymentOrders.id, input.id));
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
            "activation_failure_reason" as "activationFailureReason",
            "activation_next_retry_at" as "activationNextRetryAt",
            "channel_transaction_id" as "channelTransactionId",
            "checkout_payload" as "checkoutPayload",
            "expires_at" as "expiresAt",
            "period_start" as "periodStart",
            "period_end" as "periodEnd",
            "paid_at" as "paidAt",
            "terminal_at" as "terminalAt",
            "created_by" as "createdBy",
            "owner_payer_kind" as "ownerPayerKind",
            "owner_payer_id" as "ownerPayerId",
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
        if (!current) return { outcome: "unknown" as const };

        const existingOwner = [...lockedOrders]
          .filter(
            // An owner is a row that CLAIMED the period (`failed` — claimed, landing — or
            // `applied` — landed). A `needs_resolution` row is a resolved DUPLICATE, never an
            // owner: counting it here would hand a second transaction the entitlement it was
            // refused (BP03/#371).
            (row) =>
              row.activationState === "applied" ||
              row.activationState === "failed",
          )
          .sort(byClaimedOwner)[0];
        if (existingOwner) {
          if (existingOwner.id === current.id) {
            return { outcome: "owner" as const, order: current };
          }
          return {
            outcome: "duplicate" as const,
            order: current,
            ownerOrder: existingOwner,
          };
        }

        const winner = [...lockedOrders].sort(byOverlapWinner)[0];
        if (!winner) return { outcome: "unknown" as const };
        if (winner.id !== current.id) {
          return {
            outcome: "duplicate" as const,
            order: current,
            ownerOrder: winner,
          };
        }
        if (current.activationState === "pending") {
          const [claimed] = await tx
            .update(paymentOrders)
            .set({ activationState: "failed" })
            .where(
              and(
                eq(paymentOrders.id, current.id),
                eq(paymentOrders.status, "paid"),
                eq(paymentOrders.activationState, "pending"),
              ),
            )
            .returning();
          if (claimed)
            return { outcome: "owner" as const, order: rowOf(claimed) };
        }
        const [fresh] = await tx
          .select()
          .from(paymentOrders)
          .where(eq(paymentOrders.id, current.id))
          .limit(1);
        if (fresh?.status !== "paid") {
          return { outcome: "unknown" as const };
        }
        // A needs_resolution row reading as the overlap winner is a stale-read artifact (another
        // pass already resolved this order as a duplicate): it is not an owner, and "unknown"
        // leaves it exactly where the verdict put it.
        if (fresh.activationState === "needs_resolution") {
          return { outcome: "unknown" as const };
        }
        return { outcome: "owner" as const, order: rowOf(fresh) };
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

    async listOrdersInWindow({ from, to, limit, offset, scope }) {
      // Flat condition construction: this drizzle version's `and()` takes its conditions as
      // direct arguments, and a spread array among them silently degrades the whole
      // predicate — an optional-end window must degrade to "no bound", not to a broken filter.
      const conditions = [];
      const ownerScope = ownerScopeCondition(scope);
      if (ownerScope) conditions.push(ownerScope);
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

    async countOrdersInWindow({ from, to, scope }) {
      // Same flat construction as listOrdersInWindow above; the two must filter identically
      // or the pager and the page disagree.
      const conditions = [];
      const ownerScope = ownerScopeCondition(scope);
      if (ownerScope) conditions.push(ownerScope);
      if (from) conditions.push(gte(paymentOrders.createdAt, from));
      if (to) conditions.push(lte(paymentOrders.createdAt, to));
      const [row] = await database
        .select({ value: count() })
        .from(paymentOrders)
        .where(and(...conditions));
      return row?.value ?? 0;
    },

    async listAnomalyEvents(orderIds) {
      // No ids, no query: `inArray` over an empty list is a syntax error in SQL, and an empty
      // page of orders owes the caller an empty event list, not a trip to the database.
      if (orderIds.length === 0) return [];
      const rows = await database
        .select()
        .from(paymentEvents)
        .where(
          and(
            eq(paymentEvents.kind, "anomaly"),
            inArray(paymentEvents.orderId, [...orderIds]),
          ),
        )
        // Oldest first: the record's progress reads chronologically — the first anomaly is the
        // one that opened the case, the last the freshest fact.
        .orderBy(asc(paymentEvents.createdAt));
      return rows.map(eventRowOf);
    },
  };
}

/**
 * One payment_events row as the read answers it: the columns verbatim — a reader that re-derived
 * or trimmed `detail` would be a second opinion the writer never wrote.
 */
function eventRowOf(
  row: typeof paymentEvents.$inferSelect,
): PaymentOrderEventRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    kind: row.kind,
    code: row.code,
    state: row.state,
    channelTransactionId: row.channelTransactionId,
    amountCents: row.amountCents,
    detail: row.detail,
    createdAt: row.createdAt,
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
