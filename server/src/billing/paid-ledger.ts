import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  paidCreditAllocations,
  paidEntitlements,
  paidOrders,
  paidProducts,
  paidRefunds,
  testCreditAccounts,
  testCreditEvidence,
  testCreditOperations,
} from "../db/schema";
import {
  advancePurchasePeriod,
  firstBillingPeriod,
  type BillingPeriod,
} from "./billing-period";

/**
 * Paid credit ledger (#99–#101): orders that lock the purchased product
 * version and price, channel verification that grants exactly once, and the
 * entitlements a verified order opens — one Beijing-time billing period for
 * the subscription plan (at most one paid future period per account, claimed
 * atomically) or a long-lived Credit Pack.
 *
 * The channel itself stays an injected seam: verification consumes only what
 * a trusted callback or active query asserts (channel, its order reference,
 * and the paid amount).
 */

export class PaidLedgerError extends Error {
  constructor(
    readonly code:
      | "product_unavailable"
      | "order_unknown"
      | "verification_mismatch"
      | "not_verified"
      | "account_suspended",
    message: string,
  ) {
    super(message);
    this.name = "PaidLedgerError";
  }
}

export function createPaidCreditLedger(database: Database, clock?: () => Date) {
  const now = () => clock?.() ?? new Date();
  type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

  async function upsertProduct(input: {
    code: string;
    kind: "subscription" | "credit_pack";
    priceCents: number;
    creditsMicrocredits: bigint;
  }) {
    return database.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(paidProducts)
        .where(eq(paidProducts.code, input.code));
      // A price or amount change republishes the product as a new version;
      // placed orders keep the version they locked.
      const changed =
        existing &&
        (existing.priceCents !== input.priceCents ||
          existing.creditsMicrocredits !== input.creditsMicrocredits);
      const [row] = await tx
        .insert(paidProducts)
        .values({
          code: input.code,
          kind: input.kind,
          version: existing ? existing.version + (changed ? 1 : 0) : 1,
          priceCents: input.priceCents,
          creditsMicrocredits: input.creditsMicrocredits,
          active: true,
          updatedAt: now(),
        })
        .onConflictDoUpdate({
          target: paidProducts.code,
          set: {
            version: existing ? existing.version + (changed ? 1 : 0) : 1,
            priceCents: input.priceCents,
            creditsMicrocredits: input.creditsMicrocredits,
            active: true,
            updatedAt: now(),
          },
        })
        .returning();
      return row;
    });
  }

  async function createOrder(input: {
    accountId: string;
    productCode: string;
    channel: "wechat" | "alipay";
  }) {
    return database.transaction(async (tx) => {
      const [product] = await tx
        .select()
        .from(paidProducts)
        .where(eq(paidProducts.code, input.productCode));
      if (!product?.active)
        throw new PaidLedgerError(
          "product_unavailable",
          "The product is not available for purchase.",
        );
      // 停用期间收费入口维持暂停 (#103): a suspended account cannot start a
      // new purchase.
      const [account] = await tx
        .select({ suspendedAt: testCreditAccounts.suspendedAt })
        .from(testCreditAccounts)
        .where(eq(testCreditAccounts.id, input.accountId));
      if (account?.suspendedAt)
        throw new PaidLedgerError(
          "account_suspended",
          "The account is suspended; purchases are paused.",
        );
      const [order] = await tx
        .insert(paidOrders)
        .values({
          accountId: input.accountId,
          productCode: product.code,
          productVersion: product.version,
          priceCents: product.priceCents,
          channel: input.channel,
        })
        .returning();
      return order;
    });
  }

  async function activeSubscription(accountId: string) {
    // The latest grant or future claim decides where the next period lands.
    const [latest] = await database
      .select()
      .from(paidEntitlements)
      .where(
        and(
          eq(paidEntitlements.accountId, accountId),
          eq(paidEntitlements.kind, "subscription"),
          inArray(paidEntitlements.state, ["granted", "future"]),
        ),
      )
      .orderBy(desc(paidEntitlements.periodStart))
      .limit(1);
    return latest;
  }

  async function verifyOrder(input: {
    orderId: string;
    channel: "wechat" | "alipay";
    channelOrderRef: string;
    amountCents: number;
    paidAt: Date;
  }) {
    const result = await database.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(paidOrders)
        .where(eq(paidOrders.id, input.orderId))
        .for("update");
      if (!order) throw new PaidLedgerError("order_unknown", "Unknown order.");
      if (order.state === "verified" || order.state === "refund_pending") {
        // Idempotent callback replay: the same channel reference returns the
        // original result and never grants again — including an order already
        // headed for refund (suspension or a lost future-period claim).
        if (
          order.channel === input.channel &&
          order.channelOrderRef === input.channelOrderRef
        )
          return {
            order,
            replayed: true as const,
            claimed: order.state === "verified",
            refunded: order.state === "refund_pending" || undefined,
          };
        throw new PaidLedgerError(
          "verification_mismatch",
          "The order was already verified through another channel reference.",
        );
      }
      if (
        order.state !== "pending" ||
        order.channel !== input.channel ||
        order.priceCents !== input.amountCents
      ) {
        // Throwing inside the transaction would roll the marking back, so the
        // mismatch is committed first and surfaces after.
        const [failed] = await tx
          .update(paidOrders)
          .set({ state: "failed" })
          .where(eq(paidOrders.id, order.id))
          .returning();
        return {
          order: failed,
          replayed: false as const,
          claimed: false as const,
          mismatch: true as const,
        };
      }

      // A payment that lands while the account is suspended never grants:
      // it refunds in full through the channel that took it (#103).
      const [account] = await tx
        .select({ suspendedAt: testCreditAccounts.suspendedAt })
        .from(testCreditAccounts)
        .where(eq(testCreditAccounts.id, order.accountId));
      if (account?.suspendedAt) {
        const [owed] = await tx
          .update(paidOrders)
          .set({
            state: "refund_pending",
            channelOrderRef: input.channelOrderRef,
            verifiedAt: input.paidAt,
          })
          .where(eq(paidOrders.id, order.id))
          .returning();
        const refund = await recordRefundWithin(
          tx,
          owed,
          "account_suspended",
          now(),
        );
        return {
          order: owed,
          replayed: false as const,
          claimed: false as const,
          refunded: true as const,
          refund,
        };
      }

      const [product] = await tx
        .select()
        .from(paidProducts)
        .where(eq(paidProducts.code, order.productCode));
      const [latest] = await tx
        .select()
        .from(paidEntitlements)
        .where(
          and(
            eq(paidEntitlements.accountId, order.accountId),
            eq(paidEntitlements.kind, "subscription"),
            inArray(paidEntitlements.state, ["granted", "future"]),
          ),
        )
        .orderBy(desc(paidEntitlements.periodStart))
        .limit(1);

      let period: BillingPeriod | undefined;
      let state: "granted" | "future" = "granted";
      if (product?.kind === "subscription") {
        if (latest) {
          // Advance purchase: effective exactly when the current period ends.
          period = advancePurchasePeriod({
            start: latest.periodStart ?? input.paidAt,
            end: latest.periodEnd ?? input.paidAt,
            anchorDay: latest.anchorDay ?? 1,
          });
          state = "future";
        } else {
          period = firstBillingPeriod(input.paidAt);
        }
      }

      try {
        // A savepoint keeps a lost future-period claim recoverable: the
        // unique violation rolls back to here, leaving the transaction usable
        // for the refund-pending transition below.
        const [entitlement] = await tx.transaction(async (claim) =>
          claim
            .insert(paidEntitlements)
            .values({
              accountId: order.accountId,
              orderId: order.id,
              kind: product?.kind ?? "credit_pack",
              periodStart: period?.start,
              periodEnd: period?.end,
              anchorDay: period?.anchorDay,
              creditsMicrocredits: product?.creditsMicrocredits ?? 0n,
              state,
              arrivedAt: input.paidAt,
            })
            .returning(),
        );
        const [verified] = await tx
          .update(paidOrders)
          .set({
            state: "verified",
            channelOrderRef: input.channelOrderRef,
            verifiedAt: input.paidAt,
          })
          .where(eq(paidOrders.id, order.id))
          .returning();
        return {
          order: verified,
          entitlement,
          replayed: false as const,
          claimed: true as const,
        };
      } catch (error) {
        const violation = [
          (error as { constraint?: string }).constraint,
          (error as { cause?: { constraint?: string } }).cause?.constraint,
          error instanceof Error ? error.message : "",
        ].join(" ");
        if (
          state === "future" &&
          violation.includes("paid_entitlements_one_future")
        ) {
          // Another verified order already claimed the future period: this
          // payment is owed a refund, not a second claim.
          const [owed] = await tx
            .update(paidOrders)
            .set({ state: "refund_pending", verifiedAt: input.paidAt })
            .where(eq(paidOrders.id, order.id))
            .returning();
          const refund = await recordRefundWithin(
            tx,
            owed,
            "duplicate_future_period",
            now(),
          );
          return {
            order: owed,
            replayed: false as const,
            claimed: false as const,
            refunded: true as const,
            refund,
          };
        }
        throw error;
      }
    });
    if ("mismatch" in result && result.mismatch)
      throw new PaidLedgerError(
        "verification_mismatch",
        "The channel result does not match the placed order.",
      );
    return result;
  }

  function effective(entitlement: EntitlementRow, at: Date) {
    if (entitlement.state === "revoked") return "revoked" as const;
    if (entitlement.state === "frozen") return "frozen" as const;
    if (entitlement.kind !== "subscription") return "active" as const;
    const start = entitlement.periodStart ?? entitlement.arrivedAt;
    const end = entitlement.periodEnd ?? entitlement.arrivedAt;
    if (at < start) return "future" as const;
    if (at >= end) return "expired" as const;
    return "active" as const;
  }

  async function entitlements(accountId: string) {
    const rows = await database
      .select()
      .from(paidEntitlements)
      .where(eq(paidEntitlements.accountId, accountId))
      .orderBy(paidEntitlements.arrivedAt);
    const at = now();
    return rows.map((row) => ({ ...row, effective: effective(row, at) }));
  }

  /**
   * Refund seams (#100): freeze first — consumption from the entitlement
   * stops while the channel refund is in flight — then revoke once the money
   * is confirmed back, or unfreeze if the refund fails.
   */
  async function freezeEntitlements(orderId: string, frozen: boolean) {
    return database.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(paidOrders)
        .where(eq(paidOrders.id, orderId));
      if (!order) throw new PaidLedgerError("order_unknown", "Unknown order.");
      await tx
        .update(paidEntitlements)
        .set({ state: frozen ? "frozen" : "granted" })
        .where(
          and(
            eq(paidEntitlements.orderId, orderId),
            eq(paidEntitlements.state, frozen ? "granted" : "frozen"),
          ),
        );
      const [row] = await tx
        .update(paidOrders)
        .set({ state: frozen ? "refund_pending" : "verified" })
        .where(eq(paidOrders.id, orderId))
        .returning();
      return row;
    });
  }

  async function revokeEntitlements(orderId: string) {
    return database.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(paidOrders)
        .where(eq(paidOrders.id, orderId));
      if (order?.state !== "refund_pending")
        throw new PaidLedgerError(
          "not_verified",
          "Only an order with a refund in flight can be revoked.",
        );
      await tx
        .update(paidEntitlements)
        .set({ state: "revoked" })
        .where(eq(paidEntitlements.orderId, orderId));
      const [row] = await tx
        .update(paidOrders)
        .set({ state: "refunded" })
        .where(eq(paidOrders.id, orderId))
        .returning();
      return row;
    });
  }

  // ── Refund execution contract (#102/#103) ───────────────────────────────
  // Every refund, whatever its reason, converges on one per-order record
  // that carries the original channel and amount (原路退款), so replayed,
  // concurrent or out-of-order callbacks all see a single progress state.

  async function recordRefundWithin(
    tx: Transaction,
    order: typeof paidOrders.$inferSelect,
    reason: string,
    at: Date,
  ) {
    const [row] = await tx
      .insert(paidRefunds)
      .values({
        orderId: order.id,
        accountId: order.accountId,
        channel: order.channel,
        amountCents: order.priceCents,
        reason,
        requestedAt: at,
      })
      // A failed refund can be requested again; a confirmed one is final.
      .onConflictDoUpdate({
        target: paidRefunds.orderId,
        set: { state: "requested", reason, requestedAt: at },
        setWhere: sql`${paidRefunds.state} <> 'confirmed'`,
      })
      .returning();
    return row;
  }

  /**
   * Opens (or reopens) the original-route refund for one order and freezes
   * what it granted. Idempotent; replays return the single refund record.
   */
  async function requestRefund(orderId: string, reason = "user_request") {
    return database.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(paidOrders)
        .where(eq(paidOrders.id, orderId))
        .for("update");
      if (!order) throw new PaidLedgerError("order_unknown", "Unknown order.");
      if (order.state === "refunded") {
        // The money is already back; a replayed request returns the
        // completed record instead of refusing.
        const [done] = await tx
          .select()
          .from(paidRefunds)
          .where(eq(paidRefunds.orderId, orderId));
        if (done?.state === "confirmed") return done;
      }
      if (order.state !== "verified" && order.state !== "refund_pending")
        throw new PaidLedgerError(
          "not_verified",
          "Only a verified order, or one already owed a refund, can request one.",
        );
      const refund = await recordRefundWithin(tx, order, reason, now());
      // Consumption stops while the refund is in flight.
      await tx
        .update(paidEntitlements)
        .set({ state: "frozen" })
        .where(
          and(
            eq(paidEntitlements.orderId, orderId),
            inArray(paidEntitlements.state, ["granted", "future"]),
          ),
        );
      if (order.state !== "refund_pending")
        await tx
          .update(paidOrders)
          .set({ state: "refund_pending" })
          .where(eq(paidOrders.id, orderId));
      return refund;
    });
  }

  /**
   * Settles the refund: confirmed revokes the grant and books the money back
   * through the original channel; failed unfreezes and leaves the refund
   * retryable. Replaying either converges on the recorded outcome.
   */
  async function confirmRefund(orderId: string, succeeded: boolean) {
    return database.transaction(async (tx) => {
      const [refund] = await tx
        .select()
        .from(paidRefunds)
        .where(eq(paidRefunds.orderId, orderId))
        .for("update");
      if (!refund)
        throw new PaidLedgerError(
          "not_verified",
          "No refund has been requested for this order.",
        );
      if (refund.state === "confirmed") return refund;
      if (succeeded) {
        await tx
          .update(paidEntitlements)
          .set({ state: "revoked" })
          .where(eq(paidEntitlements.orderId, orderId));
        await tx
          .update(paidOrders)
          .set({ state: "refunded" })
          .where(eq(paidOrders.id, orderId));
        const [row] = await tx
          .update(paidRefunds)
          .set({ state: "confirmed", confirmedAt: now() })
          .where(eq(paidRefunds.id, refund.id))
          .returning();
        return row;
      }
      // A failed refund restores the grant. shortcut: a frozen future claim
      // comes back as granted (still not spendable before its period), so a
      // concurrent re-claim of that future slot is not re-checked here.
      await tx
        .update(paidEntitlements)
        .set({ state: "granted" })
        .where(
          and(
            eq(paidEntitlements.orderId, orderId),
            eq(paidEntitlements.state, "frozen"),
          ),
        );
      const [restored] = await tx
        .select({ id: paidEntitlements.id })
        .from(paidEntitlements)
        .where(eq(paidEntitlements.orderId, orderId))
        .limit(1);
      await tx
        .update(paidOrders)
        .set({ state: restored ? "verified" : "refund_pending" })
        .where(
          and(
            eq(paidOrders.id, orderId),
            eq(paidOrders.state, "refund_pending"),
          ),
        );
      const [row] = await tx
        .update(paidRefunds)
        .set({ state: "failed", confirmedAt: now() })
        .where(eq(paidRefunds.id, refund.id))
        .returning();
      return row;
    });
  }

  /** Refunds of one account, newest first — 逐单可查 (#103). */
  async function refunds(accountId: string) {
    return database
      .select()
      .from(paidRefunds)
      .where(eq(paidRefunds.accountId, accountId))
      .orderBy(desc(paidRefunds.requestedAt));
  }

  /**
   * Reflects the upstream identity state (Casdoor 停用): while suspended, new
   * purchases pause and payments that land anyway refund in full; in-flight
   * refunds and dispatched settlements continue.
   */
  async function suspendAccount(accountId: string, suspended: boolean) {
    const [row] = await database
      .update(testCreditAccounts)
      .set({ suspendedAt: suspended ? now() : null })
      .where(eq(testCreditAccounts.id, accountId))
      .returning({ id: testCreditAccounts.id });
    if (!row) throw new PaidLedgerError("order_unknown", "Unknown account.");
    return suspended;
  }

  // ── Consumption ordering (#101 AC3) ─────────────────────────────────────
  // Reservations spend the current Billing Period's subscription credits
  // first, then Credit Packs by arrival order. Expired or revoked sources
  // cannot fund new holds; settlement consumes the sources an operation
  // allocated, in that same order, so cross-period charges always bill the
  // original period.

  async function spendableSources(
    tx: Transaction,
    accountId: string,
    at: Date,
  ) {
    const rows = await tx
      .select()
      .from(paidEntitlements)
      .where(
        and(
          eq(paidEntitlements.accountId, accountId),
          inArray(paidEntitlements.state, ["granted", "future"]),
        ),
      )
      .orderBy(paidEntitlements.arrivedAt);
    const holds = await tx
      .select({
        entitlementId: paidCreditAllocations.entitlementId,
        held: sql<string>`sum(${paidCreditAllocations.amountMicrocredits})`,
      })
      .from(paidCreditAllocations)
      .where(eq(paidCreditAllocations.state, "held"))
      .groupBy(paidCreditAllocations.entitlementId);
    const heldBy = new Map(
      holds.flatMap(({ entitlementId, held }) =>
        entitlementId === null ? [] : [[entitlementId, BigInt(held)] as const],
      ),
    );
    return rows
      .map((row) => ({
        entitlement: row,
        // Future periods cannot fund today's reservations.
        spendableAt: effective(row, at) === "active",
        remaining:
          row.creditsMicrocredits -
          row.consumedMicrocredits -
          (heldBy.get(row.id) ?? 0n),
      }))
      .filter(({ spendableAt, remaining }) => spendableAt && remaining > 0n);
  }

  /** The account's spendable paid sources in consumption order. */
  async function paidSources(accountId: string) {
    const at = now();
    return database.transaction(async (tx) => {
      const sources = await spendableSources(tx, accountId, at);
      // Current-period subscription credits first, then packs by arrival.
      return sources
        .map(({ entitlement, remaining }) => ({
          entitlementId: entitlement.id,
          kind: entitlement.kind,
          arrivedAt: entitlement.arrivedAt,
          remainingMicrocredits: remaining.toString(),
        }))
        .sort((a, b) =>
          a.kind === b.kind
            ? a.arrivedAt.getTime() - b.arrivedAt.getTime()
            : a.kind === "subscription"
              ? -1
              : 1,
        );
    });
  }

  async function allocate(input: {
    accountId: string;
    operationId: string;
    amountMicrocredits: bigint;
  }) {
    return database.transaction((tx) => allocatePaidSources(tx, input, now()));
  }

  /** Settlement consumes the allocated sources in order, up to the charge. */
  async function settleAllocation(input: {
    accountId: string;
    operationId: string;
    chargeMicrocredits: bigint;
  }) {
    return database.transaction((tx) =>
      consumePaidAllocations(tx, input, now()),
    );
  }

  /** A released reservation returns its holds without consuming anything. */
  async function releaseAllocation(accountId: string, operationId: string) {
    return database.transaction(async (tx) => {
      const rows = await tx
        .update(paidCreditAllocations)
        .set({ state: "released", resolvedAt: now() })
        .where(
          and(
            eq(paidCreditAllocations.accountId, accountId),
            eq(paidCreditAllocations.operationId, operationId),
            eq(paidCreditAllocations.state, "held"),
          ),
        )
        .returning();
      return { released: rows.length };
    });
  }

  /**
   * The account's bill (#101): every booked charge as one line per source
   * that funded it, carrying that source's original Billing Period and
   * arrival time. Test Credit charges appear as their own source.
   */
  async function bill(accountId: string) {
    const paidLines = await database
      .select({
        operationId: paidCreditAllocations.operationId,
        source: paidEntitlements.kind,
        entitlementId: paidEntitlements.id,
        periodStart: paidEntitlements.periodStart,
        periodEnd: paidEntitlements.periodEnd,
        arrivedAt: paidEntitlements.arrivedAt,
        amountMicrocredits: paidCreditAllocations.consumedMicrocredits,
        at: paidCreditAllocations.resolvedAt,
      })
      .from(paidCreditAllocations)
      .innerJoin(
        paidEntitlements,
        eq(paidCreditAllocations.entitlementId, paidEntitlements.id),
      )
      .where(
        and(
          eq(paidCreditAllocations.accountId, accountId),
          eq(paidCreditAllocations.state, "settled"),
        ),
      )
      .orderBy(paidCreditAllocations.resolvedAt);
    const testLines = await database
      .select({
        operationId: testCreditOperations.id,
        amountMicrocredits: sql<string>`(${testCreditOperations.charged} - coalesce(${testCreditOperations.paidChargeMicrocredits}, 0))::text`,
        at: testCreditEvidence.recordedAt,
      })
      .from(testCreditOperations)
      .leftJoin(
        testCreditEvidence,
        and(
          eq(testCreditEvidence.accountId, testCreditOperations.accountId),
          eq(testCreditEvidence.operationId, testCreditOperations.id),
          eq(
            testCreditEvidence.evidenceId,
            testCreditOperations.eligibleEvidenceId,
          ),
        ),
      )
      .where(
        and(
          eq(testCreditOperations.accountId, accountId),
          sql`${testCreditOperations.charged} - coalesce(${testCreditOperations.paidChargeMicrocredits}, 0) > 0`,
        ),
      )
      .orderBy(testCreditEvidence.recordedAt);
    return [
      ...testLines.map((line) => ({
        ...line,
        source: "test" as const,
        entitlementId: null,
        periodStart: null,
        periodEnd: null,
        arrivedAt: null,
      })),
      ...paidLines.map((line) => ({
        ...line,
        amountMicrocredits: (line.amountMicrocredits ?? 0n).toString(),
      })),
    ].sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
  }

  return {
    upsertProduct,
    createOrder,
    verifyOrder,
    entitlements,
    freezeEntitlements,
    revokeEntitlements,
    requestRefund,
    confirmRefund,
    refunds,
    suspendAccount,
    activeSubscription,
    paidSources,
    bill,
    allocate,
    settleAllocation,
    releaseAllocation,
  };
}

export type PaidCreditLedger = ReturnType<typeof createPaidCreditLedger>;

type PaidTx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type EntitlementRow = typeof paidEntitlements.$inferSelect;

function effectiveEntitlement(entitlement: EntitlementRow, at: Date) {
  if (entitlement.state === "revoked") return "revoked" as const;
  if (entitlement.state === "frozen") return "frozen" as const;
  if (entitlement.kind !== "subscription") return "active" as const;
  const start = entitlement.periodStart ?? entitlement.arrivedAt;
  const end = entitlement.periodEnd ?? entitlement.arrivedAt;
  if (at < start) return "future" as const;
  if (at >= end) return "expired" as const;
  return "active" as const;
}

async function spendableSourcesWithin(tx: PaidTx, accountId: string, at: Date) {
  const rows = await tx
    .select()
    .from(paidEntitlements)
    .where(
      and(
        eq(paidEntitlements.accountId, accountId),
        inArray(paidEntitlements.state, ["granted", "future"]),
      ),
    )
    .orderBy(paidEntitlements.arrivedAt);
  const holds = await tx
    .select({
      entitlementId: paidCreditAllocations.entitlementId,
      held: sql<string>`sum(${paidCreditAllocations.amountMicrocredits})`,
    })
    .from(paidCreditAllocations)
    .where(eq(paidCreditAllocations.state, "held"))
    .groupBy(paidCreditAllocations.entitlementId);
  const heldBy = new Map(
    holds.flatMap(({ entitlementId, held }) =>
      entitlementId === null ? [] : [[entitlementId, BigInt(held)] as const],
    ),
  );
  return rows
    .map((row) => ({
      entitlement: row,
      spendableAt: effectiveEntitlement(row, at) === "active",
      remaining:
        row.creditsMicrocredits -
        row.consumedMicrocredits -
        (heldBy.get(row.id) ?? 0n),
    }))
    .filter(({ spendableAt, remaining }) => spendableAt && remaining > 0n);
}

/**
 * Holds `amountMicrocredits` of paid sources for one operation, inside the
 * caller's transaction — the seam the Test Credit reservation path uses when
 * trial credits alone cannot cover a hold (#101). Sources lock and allocate
 * atomically with the reservation.
 */
export async function allocatePaidSources(
  tx: PaidTx,
  input: {
    accountId: string;
    operationId: string;
    amountMicrocredits: bigint;
  },
  at: Date,
): Promise<
  | { state: "existing" }
  | { state: "denied"; reason: "insufficient_credits" }
  | { state: "allocated"; amount: bigint }
> {
  const [existing] = await tx
    .select({ id: paidCreditAllocations.id })
    .from(paidCreditAllocations)
    .where(
      and(
        eq(paidCreditAllocations.accountId, input.accountId),
        eq(paidCreditAllocations.operationId, input.operationId),
      ),
    )
    .limit(1);
  if (existing) return { state: "existing" };

  // Lock the account's entitlement rows so concurrent allocations serialize
  // on the same sources.
  await tx
    .select({ id: paidEntitlements.id })
    .from(paidEntitlements)
    .where(eq(paidEntitlements.accountId, input.accountId))
    .for("update");

  const sources = (await spendableSourcesWithin(tx, input.accountId, at)).sort(
    (a, b) =>
      a.entitlement.kind === b.entitlement.kind
        ? a.entitlement.arrivedAt.getTime() - b.entitlement.arrivedAt.getTime()
        : a.entitlement.kind === "subscription"
          ? -1
          : 1,
  );
  const total = sources.reduce((sum, { remaining }) => sum + remaining, 0n);
  if (total < input.amountMicrocredits)
    return { state: "denied", reason: "insufficient_credits" };

  let left = input.amountMicrocredits;
  let position = 0;
  for (const { entitlement, remaining } of sources) {
    if (left <= 0n) break;
    const draw = remaining < left ? remaining : left;
    left -= draw;
    await tx.insert(paidCreditAllocations).values({
      accountId: input.accountId,
      operationId: input.operationId,
      entitlementId: entitlement.id,
      position: position++,
      amountMicrocredits: draw,
      state: "held",
    });
  }
  return { state: "allocated", amount: input.amountMicrocredits };
}

/**
 * Consumes up to `chargeMicrocredits` from an operation's paid allocations,
 * inside the caller's transaction, and releases any unspent hold.
 */
export async function consumePaidAllocations(
  tx: PaidTx,
  input: {
    accountId: string;
    operationId: string;
    chargeMicrocredits: bigint;
  },
  at: Date,
): Promise<
  { state: "absent" } | { state: "settled"; charge: bigint; consumed: bigint }
> {
  const rows = await tx
    .select()
    .from(paidCreditAllocations)
    .where(
      and(
        eq(paidCreditAllocations.accountId, input.accountId),
        eq(paidCreditAllocations.operationId, input.operationId),
        eq(paidCreditAllocations.state, "held"),
      ),
    )
    .orderBy(paidCreditAllocations.position)
    .for("update");
  if (rows.length === 0) return { state: "absent" };
  let left = input.chargeMicrocredits;
  let consumed = 0n;
  for (const row of rows) {
    if (left <= 0n) break;
    const draw = row.amountMicrocredits < left ? row.amountMicrocredits : left;
    left -= draw;
    consumed += draw;
    if (row.entitlementId) {
      await tx
        .update(paidEntitlements)
        .set({
          consumedMicrocredits: sql`${paidEntitlements.consumedMicrocredits} + ${draw}`,
        })
        .where(eq(paidEntitlements.id, row.entitlementId));
    }
    await tx
      .update(paidCreditAllocations)
      .set({
        state: "settled",
        resolvedAt: at,
        consumedMicrocredits: draw,
      })
      .where(eq(paidCreditAllocations.id, row.id));
  }
  // Any unspent hold releases with the settlement.
  for (const row of rows) {
    await tx
      .update(paidCreditAllocations)
      .set({ state: "released", resolvedAt: at })
      .where(
        and(
          eq(paidCreditAllocations.id, row.id),
          eq(paidCreditAllocations.state, "held"),
        ),
      );
  }
  return { state: "settled", charge: input.chargeMicrocredits, consumed };
}

/** Releases every held allocation of one operation without consuming. */
export async function releasePaidAllocations(
  tx: PaidTx,
  accountId: string,
  operationId: string,
  at: Date,
) {
  const rows = await tx
    .update(paidCreditAllocations)
    .set({ state: "released", resolvedAt: at })
    .where(
      and(
        eq(paidCreditAllocations.accountId, accountId),
        eq(paidCreditAllocations.operationId, operationId),
        eq(paidCreditAllocations.state, "held"),
      ),
    )
    .returning({ id: paidCreditAllocations.id });
  return rows.length;
}
