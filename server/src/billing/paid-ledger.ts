import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  paidCreditAllocations,
  paidEntitlements,
  paidOrders,
  paidProducts,
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
      | "not_verified",
    message: string,
  ) {
    super(message);
    this.name = "PaidLedgerError";
  }
}

type EntitlementRow = typeof paidEntitlements.$inferSelect;

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
      if (order.state === "verified") {
        // Idempotent callback replay: the same channel reference returns the
        // original result and never grants again.
        if (
          order.channel === input.channel &&
          order.channelOrderRef === input.channelOrderRef
        )
          return { order, replayed: true as const, claimed: true as const };
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
          return {
            order: owed,
            replayed: false as const,
            claimed: false as const,
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
    return database.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(paidCreditAllocations)
        .where(
          and(
            eq(paidCreditAllocations.accountId, input.accountId),
            eq(paidCreditAllocations.operationId, input.operationId),
          ),
        )
        .limit(1);
      if (existing) return { state: "existing" as const };

      // Lock the account's entitlement rows so concurrent allocations
      // serialize on the same sources.
      await tx
        .select({ id: paidEntitlements.id })
        .from(paidEntitlements)
        .where(eq(paidEntitlements.accountId, input.accountId))
        .for("update");

      const at = now();
      const sources = (await spendableSources(tx, input.accountId, at)).sort(
        (a, b) =>
          a.entitlement.kind === b.entitlement.kind
            ? a.entitlement.arrivedAt.getTime() -
              b.entitlement.arrivedAt.getTime()
            : a.entitlement.kind === "subscription"
              ? -1
              : 1,
      );
      const total = sources.reduce((sum, { remaining }) => sum + remaining, 0n);
      if (total < input.amountMicrocredits)
        return {
          state: "denied" as const,
          reason: "insufficient_credits" as const,
        };

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
      return { state: "allocated" as const, amount: input.amountMicrocredits };
    });
  }

  /** Settlement consumes the allocated sources in order, up to the charge. */
  async function settleAllocation(input: {
    accountId: string;
    operationId: string;
    chargeMicrocredits: bigint;
  }) {
    return database.transaction(async (tx) => {
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
      if (rows.length === 0) return { state: "absent" as const };
      let left = input.chargeMicrocredits;
      const at = now();
      for (const row of rows) {
        if (left <= 0n) break;
        const draw =
          row.amountMicrocredits < left ? row.amountMicrocredits : left;
        left -= draw;
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
          .set({ state: "settled", resolvedAt: at })
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
      return { state: "settled" as const, charge: input.chargeMicrocredits };
    });
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

  return {
    upsertProduct,
    createOrder,
    verifyOrder,
    entitlements,
    freezeEntitlements,
    revokeEntitlements,
    activeSubscription,
    paidSources,
    allocate,
    settleAllocation,
    releaseAllocation,
  };
}

export type PaidCreditLedger = ReturnType<typeof createPaidCreditLedger>;
