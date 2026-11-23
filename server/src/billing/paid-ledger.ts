import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client";
import {
  billingApplications,
  billingRestore,
  paidCorrections,
  paidCreditAllocations,
  paidEntitlements,
  paidOrders,
  paidPilotClosure,
  paidProducts,
  paidRefunds,
  testCreditAccounts,
  testCreditEvidence,
  testCreditOperations,
} from "../db/schema";
import {
  advancePurchasePeriod,
  type BillingPeriod,
  firstBillingPeriod,
} from "./billing-period";

import type {
  CreditPackChannel,
  CreditPackTestRefundResult,
} from "./credit-pack-test-channel";
import { WEKNORA_APPLICATION_ID } from "./weknora-ingestion";

const customerRefund = "customer";
type Refund = typeof paidRefunds.$inferSelect;

const isDispute = or(
  isNotNull(paidRefunds.dispute),
  eq(paidRefunds.reason, "channel_dispute"),
);

const disputeUsageFields = {
  used: sql<string>`(select coalesce(sum(source.consumed_microcredits), 0)::text
    from paid_entitlements source where source.order_id = paid_orders.id)`,
  total: sql<string>`(select coalesce(sum(source.credits_microcredits), 0)::text
    from paid_entitlements source where source.order_id = paid_orders.id)`,
  hasHold: sql<boolean>`exists (select 1 from paid_credit_allocations allocation
    join paid_entitlements source on source.id = allocation.entitlement_id
    where source.order_id = paid_orders.id and allocation.state = 'held')`,
};

const disputeFields = {
  id: paidRefunds.id,
  reason: paidRefunds.reason,
  openedAt: paidRefunds.requestedAt,
  evidence: paidRefunds.dispute,
  reconciledUsage: paidRefunds.usedMicrocredits,
  reconciledCents: paidRefunds.manualReviewCents,
  ...disputeUsageFields,
};

function usedShareCents(priceCents: number, used: string, total: string) {
  const credits = BigInt(total);
  if (credits === 0n) return 0;
  return Number((BigInt(priceCents) * BigInt(used) + credits / 2n) / credits);
}

function disputeView(
  row: {
    id: string;
    reason: string;
    openedAt: Date;
    evidence: Refund["dispute"];
    reconciledUsage: bigint | null;
    reconciledCents: number | null;
    used: string;
    total: string;
    hasHold: boolean;
  } | null,
  priceCents: number,
) {
  if (!row || (!row.evidence && row.reason !== "channel_dispute")) return null;
  const { evidence, hasHold, used, total } = row;
  const reversal = evidence?.reversal;
  const reconciliation = evidence?.reconciliation;
  const awaitingSettlement = Boolean(reversal && hasHold);
  const finalized = Boolean(reversal && !hasHold);
  const usedCredits = reconciliation
    ? (row.reconciledUsage ?? BigInt(used))
    : BigInt(used);
  return {
    id: row.id,
    openedAt: evidence?.opened.at ?? row.openedAt.toISOString(),
    reversalAt: reversal?.at ?? null,
    reconciledAt: reconciliation?.at ?? null,
    progress: !reversal
      ? ("open" as const)
      : awaitingSettlement
        ? ("awaiting_settlement" as const)
        : reconciliation
          ? ("reconciled" as const)
          : usedCredits > 0n
            ? ("manual_reconciliation" as const)
            : ("reversed" as const),
    usedMicrocredits: usedCredits.toString(),
    revokedMicrocredits: finalized
      ? (BigInt(total) - usedCredits).toString()
      : null,
    manualReviewCents:
      finalized && usedCredits > 0n
        ? reconciliation
          ? row.reconciledCents
          : usedShareCents(priceCents, used, total)
        : null,
  };
}

const paidPathFilter = and(
  isNotNull(billingApplications.approvedAt),
  ne(billingApplications.id, WEKNORA_APPLICATION_ID),
);

/**
 * Paid credit ledger (#99–#101): orders that lock the purchased product
 * version and price, channel verification that grants exactly once, and the
 * entitlements a verified order opens — one Beijing-time billing period for
 * the subscription plan (at most one paid future period per account, claimed
 * atomically) or a long-lived Credit Pack.
 *
 * The channel itself stays an injected seam: verification consumes only what
 * a trusted callback or active query asserts (channel, its order reference,
 * and the paid amount), and, once the deployment names them, its merchant and
 * currency.
 */

export class PaidLedgerError extends Error {
  constructor(
    readonly code:
      | "product_unavailable"
      | "order_conflict"
      | "order_unknown"
      | "verification_mismatch"
      | "not_verified"
      | "refund_held"
      | "subscription_slot_taken"
      | "account_suspended"
      | "pilot_closed"
      | "no_paid_path"
      | "ledger_restoring"
      | "not_restoring",
    message: string,
  ) {
    super(message);
    this.name = "PaidLedgerError";
  }
}

export function createPaidCreditLedger(
  database: Database,
  clock?: () => Date,
  // What the deployment pays through. Named, a channel result must match it.
  channels?: {
    currency: string;
    merchants?: Partial<Record<"wechat" | "alipay", string>>;
  },
) {
  const now = () => clock?.() ?? new Date();

  // Whether a channel result paid the right merchant in the right currency
  // (#99 服务端核对商户、订单、币种和金额). Without a named expectation there
  // is nothing to compare; the deployment's settings supply it.
  function paysTheRightMerchant(input: {
    channel: "wechat" | "alipay";
    merchantId?: string;
    currency?: string;
  }) {
    if (!channels) return true;
    const merchant = channels.merchants?.[input.channel];
    return (
      (input.currency === undefined || input.currency === channels.currency) &&
      (merchant === undefined || input.merchantId === merchant)
    );
  }
  type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

  async function upsertProduct(input: {
    code: string;
    kind: "subscription" | "credit_pack";
    priceCents: number;
    creditsMicrocredits: bigint;
  }) {
    return database.transaction(async (tx) => {
      const [row] = await tx
        .insert(paidProducts)
        .values({
          code: input.code,
          kind: input.kind,
          version: 1,
          priceCents: input.priceCents,
          creditsMicrocredits: input.creditsMicrocredits,
          active: true,
          updatedAt: now(),
        })
        .onConflictDoUpdate({
          target: paidProducts.code,
          set: {
            version: sql`${paidProducts.version} + CASE WHEN
              ${paidProducts.priceCents} <> excluded."priceCents"
              OR ${paidProducts.creditsMicrocredits} <> excluded.credits_microcredits
              THEN 1 ELSE 0 END`,
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

  async function checkSales(
    tx: Transaction,
    accountId: string,
    testApplicationIds?: string[],
    paths?: Awaited<ReturnType<typeof readPaidPaths>>,
  ) {
    const [account] = await tx
      .select({ suspendedAt: testCreditAccounts.suspendedAt })
      .from(testCreditAccounts)
      .where(eq(testCreditAccounts.id, accountId));
    if (!account)
      throw new PaidLedgerError(
        "order_unknown",
        "Billing Account unavailable.",
      );
    if (account.suspendedAt)
      throw new PaidLedgerError(
        "account_suspended",
        "The account is suspended; purchases are paused.",
      );
    if (await restoreHolds(tx, accountId))
      throw new PaidLedgerError(
        "ledger_restoring",
        "The ledger is being restored; new orders are paused.",
      );
    const [closure] = await tx
      .select({ salesStoppedAt: paidPilotClosure.salesStoppedAt })
      .from(paidPilotClosure)
      .where(eq(paidPilotClosure.id, "pilot"));
    if (closure?.salesStoppedAt)
      throw new PaidLedgerError(
        "pilot_closed",
        "Pilot sales are stopped; no new orders.",
      );
    const availablePaths =
      paths ?? (await readPaidPaths(tx, testApplicationIds));
    if (
      (testApplicationIds || availablePaths.length > 0) &&
      availablePaths.every(({ pausedAt }) => pausedAt !== null)
    )
      throw new PaidLedgerError(
        "no_paid_path",
        "No paid application path is available.",
      );
    if (testApplicationIds) await spendableSources(tx, accountId, now());
  }

  async function readProduct(tx: Transaction, code: string) {
    const [product] = await tx
      .select()
      .from(paidProducts)
      .where(eq(paidProducts.code, code));
    return product?.active ? product : undefined;
  }

  async function creditPackOffer(
    accountId: string,
    code: string,
    applicationIds: string[],
  ) {
    return database.transaction(async (tx) => {
      const product = await readProduct(tx, code);
      const paths = await readPaidPaths(tx, applicationIds);
      let blockedReason: string | null =
        product?.kind === "credit_pack"
          ? null
          : "The test Credit Pack is unavailable.";
      try {
        await checkSales(tx, accountId, applicationIds, paths);
      } catch (error) {
        if (!(error instanceof PaidLedgerError)) throw error;
        blockedReason = error.message;
      }
      return {
        product:
          product?.kind === "credit_pack"
            ? {
                version: product.version,
                priceCents: product.priceCents,
                creditsMicrocredits: product.creditsMicrocredits.toString(),
                currency: "CNY" as const,
              }
            : null,
        available: blockedReason === null,
        blockedReason,
        pausedApplications: paths
          .filter(({ pausedAt }) => pausedAt !== null)
          .map(({ name }) => name),
      };
    });
  }

  function subscriptionPeriods(tx: Transaction, accountId: string, at: Date) {
    return tx
      .select({
        id: paidOrders.id,
        productCode: paidOrders.productCode,
        priceCents: paidOrders.priceCents,
        creditsMicrocredits: sql<string>`${paidEntitlements.creditsMicrocredits}::text`,
        periodStart: paidEntitlements.periodStart,
        periodEnd: paidEntitlements.periodEnd,
        anchorDay: paidEntitlements.anchorDay,
        state: paidEntitlements.state,
        arrivedAt: paidEntitlements.arrivedAt,
      })
      .from(paidEntitlements)
      .innerJoin(paidOrders, eq(paidOrders.id, paidEntitlements.orderId))
      .where(
        and(
          eq(paidEntitlements.accountId, accountId),
          eq(paidEntitlements.kind, "subscription"),
          ne(paidEntitlements.state, "revoked"),
          gt(paidEntitlements.periodEnd, at),
        ),
      )
      .orderBy(desc(paidEntitlements.periodStart));
  }

  function subscriptionSlotTaken(
    period: Awaited<ReturnType<typeof subscriptionPeriods>>[number] | undefined,
    at: Date,
  ) {
    return (
      period?.state === "frozen" ||
      Boolean(period?.periodStart && period.periodStart > at)
    );
  }

  const subscriptionSlotMessage =
    "A paid subscription period is already scheduled or awaiting a refund. Complete its refund before replacing it.";

  async function subscriptionOffer(
    accountId: string,
    applicationIds: string[],
    eligible: boolean,
  ) {
    return database.transaction(async (tx) => {
      const at = now();
      const periods = await subscriptionPeriods(tx, accountId, at);
      const current =
        periods.find(({ periodStart }) => periodStart && periodStart <= at) ??
        null;
      const next =
        periods.find(({ periodStart }) => periodStart && periodStart > at) ??
        null;
      const products = eligible
        ? await tx
            .select({
              code: paidProducts.code,
              version: paidProducts.version,
              priceCents: paidProducts.priceCents,
              creditsMicrocredits: sql<string>`${paidProducts.creditsMicrocredits}::text`,
              currency: sql<"CNY">`'CNY'`,
            })
            .from(paidProducts)
            .where(
              and(
                eq(paidProducts.kind, "subscription"),
                eq(paidProducts.active, true),
              ),
            )
            .orderBy(paidProducts.priceCents, paidProducts.code)
        : [];
      let blockedReason = subscriptionSlotTaken(periods[0], at)
        ? subscriptionSlotMessage
        : null;
      const paths = eligible ? await readPaidPaths(tx, applicationIds) : [];
      if (!eligible) {
        blockedReason = "New test orders are unavailable for this account.";
      } else {
        try {
          await checkSales(tx, accountId, applicationIds, paths);
        } catch (error) {
          if (!(error instanceof PaidLedgerError)) throw error;
          blockedReason = error.message;
        }
      }
      return {
        products,
        current,
        next,
        available: blockedReason === null && products.length > 0,
        blockedReason,
        pausedApplications: paths
          .filter(({ pausedAt }) => pausedAt !== null)
          .map(({ name }) => name),
      };
    });
  }

  async function lockAccount(tx: Transaction, accountId: string) {
    await tx
      .select({ id: testCreditAccounts.id })
      .from(testCreditAccounts)
      .where(eq(testCreditAccounts.id, accountId))
      .for("no key update");
  }

  async function createOrder(input: {
    accountId: string;
    productCode: string;
    channel: "wechat" | "alipay";
    testPack?: {
      id: string;
      merchant: string;
      version: number;
      applicationIds: string[];
      kind?: "subscription";
    };
  }) {
    const { testPack } = input;
    return database.transaction(async (tx) => {
      const replay = async () => {
        if (!testPack) return undefined;
        const [existing] = await tx
          .select()
          .from(paidOrders)
          .where(eq(paidOrders.id, testPack.id));
        if (!existing) return undefined;
        if (
          existing.accountId !== input.accountId ||
          existing.testMerchant !== testPack.merchant ||
          existing.channel !== input.channel ||
          existing.lockedKind !== (testPack.kind ?? "credit_pack") ||
          existing.productCode !== input.productCode ||
          existing.productVersion !== testPack.version
        )
          throw new PaidLedgerError(
            "order_conflict",
            "This order identifier is unavailable.",
          );
        return existing;
      };
      const existing = await replay();
      if (existing) return { ...existing, replayed: true };
      const product = await readProduct(tx, input.productCode);
      if (
        !product ||
        (testPack &&
          (product.kind !== (testPack.kind ?? "credit_pack") ||
            product.version !== testPack.version))
      )
        throw new PaidLedgerError(
          "product_unavailable",
          testPack?.kind === "subscription"
            ? "The offer changed. Review the current Subscription Plan before placing an order."
            : "The offer changed. Review the current Credit Pack before placing an order.",
        );
      if (testPack?.kind === "subscription") {
        await lockAccount(tx, input.accountId);
        const concurrent = await replay();
        if (concurrent) return { ...concurrent, replayed: true };
        const at = now();
        const [period] = await subscriptionPeriods(tx, input.accountId, at);
        if (subscriptionSlotTaken(period, at))
          throw new PaidLedgerError(
            "subscription_slot_taken",
            subscriptionSlotMessage,
          );
      }
      await checkSales(tx, input.accountId, testPack?.applicationIds);
      const [order] = await tx
        .insert(paidOrders)
        .values({
          id: testPack?.id,
          accountId: input.accountId,
          productCode: product.code,
          productVersion: product.version,
          priceCents: product.priceCents,
          lockedKind: product.kind,
          lockedMicrocredits: product.creditsMicrocredits,
          testMerchant: testPack?.merchant,
          channel: input.channel,
        })
        .onConflictDoNothing({ target: paidOrders.id })
        .returning();
      if (order) return { ...order, replayed: false };
      const concurrent = await replay();
      if (concurrent) return { ...concurrent, replayed: true };
      throw new PaidLedgerError(
        "order_conflict",
        "This order identifier is unavailable.",
      );
    });
  }

  async function testPackOrders(input: {
    merchant: string;
    channel: CreditPackChannel;
    accountId: string;
    id?: string;
    kind?: "subscription";
  }) {
    const rows = await database
      .select({
        id: paidOrders.id,
        productCode: paidOrders.productCode,
        productVersion: paidOrders.productVersion,
        priceCents: paidOrders.priceCents,
        creditsMicrocredits: sql<string>`${paidOrders.lockedMicrocredits}::text`,
        state: paidOrders.state,
        createdAt: paidOrders.createdAt,
        verifiedAt: paidOrders.verifiedAt,
        entitlementId: paidEntitlements.id,
        periodStart: paidEntitlements.periodStart,
        canRefundFuture: sql<boolean>`coalesce(${paidEntitlements.state} in ('granted', 'future') and ${paidEntitlements.periodStart} > ${now().toISOString()}::timestamptz, false)`,
        creditsFrozen: sql<boolean>`coalesce(${paidEntitlements.state} = 'frozen', false)`,
        hasDispute: sql<boolean>`coalesce(${isDispute}, false)`,
        refund: {
          id: paidRefunds.id,
          state: paidRefunds.state,
          amountCents: paidRefunds.amountCents,
          confirmedAt: paidRefunds.confirmedAt,
        },
      })
      .from(paidOrders)
      .leftJoin(paidEntitlements, eq(paidEntitlements.orderId, paidOrders.id))
      .leftJoin(paidRefunds, eq(paidRefunds.orderId, paidOrders.id))
      .where(
        and(
          eq(paidOrders.testMerchant, input.merchant),
          eq(paidOrders.channel, input.channel),
          eq(paidOrders.lockedKind, input.kind ?? "credit_pack"),
          eq(paidOrders.accountId, input.accountId),
          input.id ? eq(paidOrders.id, input.id) : undefined,
        ),
      )
      .orderBy(desc(paidOrders.createdAt), paidOrders.id);
    const disputedIds = rows
      .filter(({ hasDispute }) => hasDispute)
      .map(({ id }) => id);
    const disputes = disputedIds.length
      ? await readDisputes(
          and(
            eq(paidOrders.accountId, input.accountId),
            inArray(paidOrders.id, disputedIds),
          ),
        )
      : [];
    const byOrder = new Map(
      disputes.map(({ orderId, priceCents, disputeRecord }) => [
        orderId,
        disputeView(disputeRecord, priceCents),
      ]),
    );
    return rows.map(({ hasDispute: _, ...order }) => ({
      ...order,
      dispute: byOrder.get(order.id) ?? null,
    }));
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
    // What the channel says it paid to: its merchant and currency.
    merchantId?: string;
    currency?: string;
    testChannel?: true;
  }) {
    const result = await database.transaction(async (tx) => {
      // Serialize period claims with order placement and account consumption.
      await tx
        .select({ id: testCreditAccounts.id })
        .from(testCreditAccounts)
        .innerJoin(paidOrders, eq(paidOrders.accountId, testCreditAccounts.id))
        .where(eq(paidOrders.id, input.orderId))
        .for("no key update", { of: testCreditAccounts });
      const [order] = await tx
        .select()
        .from(paidOrders)
        .where(eq(paidOrders.id, input.orderId))
        .for("update");
      if (!order) throw new PaidLedgerError("order_unknown", "Unknown order.");
      if (Boolean(order.testMerchant) !== Boolean(input.testChannel))
        throw new PaidLedgerError("order_unknown", "Unknown order.");
      if (
        order.channel !== input.channel ||
        order.priceCents !== input.amountCents ||
        !paysTheRightMerchant(input) ||
        (order.testMerchant !== null &&
          (input.merchantId !== order.testMerchant || input.currency !== "CNY"))
      )
        throw new PaidLedgerError(
          "verification_mismatch",
          "The channel result does not match the placed order.",
        );
      if (
        order.state === "verified" ||
        order.state === "refund_pending" ||
        order.state === "refunded"
      ) {
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
            refunded: order.state !== "verified" || undefined,
          };
        throw new PaidLedgerError(
          "verification_mismatch",
          "The order was already verified through another channel reference.",
        );
      }
      // An order the channel closed stays verifiable: a payment it confirms
      // later is money that arrived (#109 通知可以迟到). Any result other
      // than the placed order's own channel and amount, merchant or currency
      // is refused and changes nothing. The order stays as it was, so a
      // forged or misrouted callback cannot spoil the payment it imitates.
      if (order.state !== "pending" && order.state !== "failed")
        throw new PaidLedgerError(
          "verification_mismatch",
          "The channel result does not match the placed order.",
        );
      // Until the account is reconciled after a restore, nothing is granted
      // (#108 恢复阶段暂停…发放); the channel retries.
      if (await restoreHolds(tx, order.accountId))
        throw new PaidLedgerError(
          "ledger_restoring",
          "The ledger is being restored; verification is paused.",
        );

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

      // A payment confirmed at or after the pilot's reserve cutoff never
      // grants: it refunds in full through its own channel (#109 截止时及
      // 之后原路全退且不授予权益; notifications may arrive late).
      const [closure] = await tx
        .select({ reservesStoppedAt: paidPilotClosure.reservesStoppedAt })
        .from(paidPilotClosure)
        .where(eq(paidPilotClosure.id, "pilot"));
      if (
        closure?.reservesStoppedAt &&
        input.paidAt >= closure.reservesStoppedAt
      ) {
        const [owed] = await tx
          .update(paidOrders)
          .set({
            state: "refund_pending",
            channelOrderRef: input.channelOrderRef,
            verifiedAt: input.paidAt,
          })
          .where(eq(paidOrders.id, order.id))
          .returning();
        const cutoffRefund = await recordRefundWithin(
          tx,
          owed,
          "pilot_closure",
          now(),
        );
        return {
          order: owed,
          replayed: false as const,
          claimed: false as const,
          refunded: true as const,
          refund: cutoffRefund,
        };
      }

      // Legacy orders predate snapshots and retain their original lookup behavior.
      const [product] =
        order.lockedKind === null || order.lockedMicrocredits === null
          ? await tx
              .select()
              .from(paidProducts)
              .where(eq(paidProducts.code, order.productCode))
          : [];
      let period: BillingPeriod | undefined;
      let state: "granted" | "future" = "granted";
      const kind = order.lockedKind ?? product?.kind;
      if (kind === "subscription") {
        const [latest] = await subscriptionPeriods(
          tx,
          order.accountId,
          input.paidAt,
        );
        if (subscriptionSlotTaken(latest, input.paidAt)) {
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
        if (
          latest?.periodStart &&
          latest.periodEnd &&
          latest.anchorDay !== null
        ) {
          period = advancePurchasePeriod({
            start: latest.periodStart,
            end: latest.periodEnd,
            anchorDay: latest.anchorDay,
          });
          state = "future";
          // Release the unique future slot once its previous period starts.
          await tx
            .update(paidEntitlements)
            .set({ state: "granted" })
            .where(
              and(
                eq(paidEntitlements.accountId, order.accountId),
                eq(paidEntitlements.kind, "subscription"),
                eq(paidEntitlements.state, "future"),
                lte(paidEntitlements.periodStart, input.paidAt),
              ),
            );
        }
        period ??= firstBillingPeriod(input.paidAt);
      }

      const [entitlement] = await tx
        .insert(paidEntitlements)
        .values({
          accountId: order.accountId,
          orderId: order.id,
          kind: kind ?? "credit_pack",
          periodStart: period?.start,
          periodEnd: period?.end,
          anchorDay: period?.anchorDay,
          creditsMicrocredits:
            order.lockedMicrocredits ?? product?.creditsMicrocredits ?? 0n,
          state,
          arrivedAt: input.paidAt,
        })
        .returning();
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
    });
    return result;
  }

  /**
   * The orders still awaiting a channel result (#99 结果未知时订单可查询).
   * At the pilot cutoff they are what the operator queries and, where the
   * channel allows, closes (#109 截点查单、关闭可关订单).
   */
  async function pendingOrders(accountId?: string) {
    return database
      .select()
      .from(paidOrders)
      .where(
        accountId
          ? and(
              eq(paidOrders.state, "pending"),
              eq(paidOrders.accountId, accountId),
            )
          : eq(paidOrders.state, "pending"),
      )
      .orderBy(paidOrders.createdAt);
  }

  /**
   * Closes an order the channel confirmed nobody paid. Nothing is granted
   * and nothing is owed; a payment the channel confirms anyway still
   * verifies.
   */
  async function closeOrder(orderId: string, by: string) {
    return (
      await database
        .update(paidOrders)
        .set({ state: "failed", closedAt: now(), closedBy: by })
        .where(and(eq(paidOrders.id, orderId), eq(paidOrders.state, "pending")))
        .returning()
    )[0];
  }

  async function closeTestPackOrder(input: {
    id: string;
    channel: CreditPackChannel;
    merchant: string;
    currency: string;
    amountCents: number;
  }) {
    // Order terms are immutable. closeOrder only changes pending orders, so a
    // concurrent or earlier successful verification always wins.
    const [order] = await database
      .select()
      .from(paidOrders)
      .where(eq(paidOrders.id, input.id));
    if (!order) throw new PaidLedgerError("order_unknown", "Unknown order.");
    if (
      input.currency !== "CNY" ||
      order.testMerchant !== input.merchant ||
      order.channel !== input.channel ||
      order.priceCents !== input.amountCents
    )
      throw new PaidLedgerError(
        "verification_mismatch",
        "The channel result does not match the placed order.",
      );
    await closeOrder(order.id, `fixture:${input.merchant}`);
  }

  /** The application paths paid credits can be spent on, and which are paused. */
  function paidPaths() {
    return readPaidPaths(database);
  }

  function readPaidPaths(
    connection: Database | Transaction,
    applicationIds?: string[],
  ) {
    return connection
      .select({
        id: billingApplications.id,
        name: billingApplications.name,
        pausedAt: billingApplications.pausedAt,
      })
      .from(billingApplications)
      .where(
        and(
          paidPathFilter,
          applicationIds
            ? inArray(billingApplications.id, applicationIds)
            : undefined,
        ),
      )
      .orderBy(billingApplications.name);
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
    by = "channel",
    state: Refund["state"] = "requested",
    amountCents = order.priceCents,
  ) {
    const [row] = await tx
      .insert(paidRefunds)
      .values({
        orderId: order.id,
        accountId: order.accountId,
        channel: order.channel,
        amountCents,
        state,
        reason,
        openedBy: by,
        requestedAt: at,
      })
      // A failed refund can be requested again; a confirmed one is final.
      .onConflictDoUpdate({
        target: paidRefunds.orderId,
        set: { state: "requested", reason, openedBy: by, requestedAt: at },
        setWhere: sql`${paidRefunds.state} <> 'confirmed' AND ${paidRefunds.openedBy} <> ${customerRefund}`,
      })
      .returning();
    return row;
  }

  async function lockRefundOrder(tx: Transaction, orderId: string) {
    const [order] = await tx
      .select()
      .from(paidOrders)
      .where(eq(paidOrders.id, orderId))
      .for("update");
    if (!order) throw new PaidLedgerError("order_unknown", "Unknown order.");
    return order;
  }

  async function handleDispute(input: {
    orderId: string;
    action: "open" | "confirm-reversal" | "reconcile";
    by: string;
    reference: string;
  }) {
    return database.transaction(async (tx) => {
      // Match payment verification and dispatch: account before order.
      await tx
        .select({ id: testCreditAccounts.id })
        .from(testCreditAccounts)
        .innerJoin(paidOrders, eq(paidOrders.accountId, testCreditAccounts.id))
        .where(eq(paidOrders.id, input.orderId))
        .for("no key update", { of: testCreditAccounts });
      const order = await lockRefundOrder(tx, input.orderId);
      const existing = await findRefund(tx, order.id);
      if (await restoreHolds(tx, order.accountId))
        throw new PaidLedgerError(
          "ledger_restoring",
          "Disputes are paused during ledger recovery.",
        );
      const evidence = {
        at: now().toISOString(),
        by: input.by,
        reference: input.reference,
      };
      const dispute = existing?.dispute;
      if (input.action === "open") {
        if (dispute) return existing;
        if (
          !order.channelOrderRef ||
          (existing &&
            !(
              existing.state === "manual_review" &&
              existing.reason === "channel_dispute"
            )) ||
          (order.state !== "verified" && order.state !== "refund_pending")
        )
          throw new PaidLedgerError(
            "not_verified",
            "A verified payment without another refund in progress is required.",
          );
        const refund =
          existing ??
          (await recordRefundWithin(
            tx,
            order,
            "channel_dispute",
            now(),
            input.by,
            "manual_review",
          ));
        await freezeForRefund(tx, order.id);
        const [row] = await tx
          .update(paidRefunds)
          .set({ dispute: { opened: evidence } })
          .where(eq(paidRefunds.id, refund.id))
          .returning();
        return row;
      }
      if (!existing || !dispute)
        throw new PaidLedgerError(
          "not_verified",
          "Open the dispute for this payment first.",
        );
      if (input.action === "confirm-reversal") {
        if (dispute.reversal) return existing;
        const confirmed = await settleRefundWithin(tx, existing, true);
        const [row] = await tx
          .update(paidRefunds)
          .set({ dispute: { ...dispute, reversal: evidence } })
          .where(eq(paidRefunds.id, confirmed.id))
          .returning();
        return row;
      }
      if (dispute.reconciliation) return existing;
      if (!dispute.reversal)
        throw new PaidLedgerError(
          "not_verified",
          "Confirm the payment reversal first.",
        );
      const [usage] = await tx
        .select(disputeUsageFields)
        .from(paidOrders)
        .where(eq(paidOrders.id, order.id));
      if (usage.hasHold)
        throw new PaidLedgerError(
          "refund_held",
          "Wait for original allocations to settle or release.",
        );
      if (BigInt(usage.used) === 0n)
        throw new PaidLedgerError(
          "not_verified",
          "There is no settled usage to reconcile.",
        );
      const [row] = await tx
        .update(paidRefunds)
        .set({
          dispute: { ...dispute, reconciliation: evidence },
          usedMicrocredits: BigInt(usage.used),
          manualReviewCents: usedShareCents(
            order.priceCents,
            usage.used,
            usage.total,
          ),
        })
        .where(eq(paidRefunds.id, existing.id))
        .returning();
      return row;
    });
  }

  function readDisputes(scope: SQL | undefined) {
    return database
      .select({
        orderId: paidOrders.id,
        priceCents: paidOrders.priceCents,
        disputeRecord: disputeFields,
      })
      .from(paidOrders)
      .innerJoin(paidRefunds, eq(paidRefunds.orderId, paidOrders.id))
      .where(and(scope, isDispute));
  }

  async function disputeStatus(orderId: string) {
    const [row] = await database
      .select({
        payment: {
          orderId: paidOrders.id,
          channel: paidOrders.channel,
          channelOrderRef: paidOrders.channelOrderRef,
          priceCents: paidOrders.priceCents,
          verifiedAt: paidOrders.verifiedAt,
        },
        disputeRecord: disputeFields,
      })
      .from(paidOrders)
      .innerJoin(paidRefunds, eq(paidRefunds.orderId, paidOrders.id))
      .where(and(eq(paidOrders.id, orderId), isDispute));
    if (!row)
      throw new PaidLedgerError(
        "order_unknown",
        "No dispute found for this order.",
      );
    return {
      payment: row.payment,
      progress: disputeView(row.disputeRecord, row.payment.priceCents),
      evidence: row.disputeRecord.evidence,
    };
  }

  async function findRefund(tx: Transaction, orderId: string) {
    const [refund] = await tx
      .select()
      .from(paidRefunds)
      .where(eq(paidRefunds.orderId, orderId));
    return refund;
  }

  async function freezeForRefund(tx: Transaction, orderId: string) {
    await tx
      .update(paidEntitlements)
      .set({ state: "frozen" })
      .where(
        and(
          eq(paidEntitlements.orderId, orderId),
          inArray(paidEntitlements.state, ["granted", "future"]),
        ),
      );
    await tx
      .update(paidOrders)
      .set({ state: "refund_pending" })
      .where(eq(paidOrders.id, orderId));
  }

  /** Operator/channel path, retaining the existing retry behavior. */
  async function requestRefund(
    orderId: string,
    reason = "user_request",
    by = "channel",
  ) {
    return database.transaction(async (tx) => {
      const order = await lockRefundOrder(tx, orderId);
      const existing = await findRefund(tx, orderId);
      if (
        existing?.state === "confirmed" ||
        existing?.dispute ||
        existing?.openedBy === customerRefund
      )
        return existing;
      if (order.state !== "verified" && order.state !== "refund_pending")
        throw new PaidLedgerError(
          "not_verified",
          "Only a verified order, or one already owed a refund, can request one.",
        );
      const refund = await recordRefundWithin(tx, order, reason, now(), by);
      await freezeForRefund(tx, order.id);
      return refund;
    });
  }

  /** Customer eligibility and the freeze share the allocator's source locks. */
  async function requestTestPackRefund(input: {
    orderId: string;
    accountId: string;
    merchant: string;
    channel: CreditPackChannel;
    amountCents?: number;
    kind?: "subscription";
  }) {
    return database.transaction(async (tx) => {
      await lockAccount(tx, input.accountId);
      const order = await lockRefundOrder(tx, input.orderId);
      if (
        order.accountId !== input.accountId ||
        order.testMerchant !== input.merchant ||
        order.channel !== input.channel ||
        order.lockedKind !== (input.kind ?? "credit_pack")
      )
        throw new PaidLedgerError("order_unknown", "Unknown order.");
      const existing = await findRefund(tx, order.id);
      if (existing) return existing;
      if (order.state !== "verified" || !order.channelOrderRef)
        throw new PaidLedgerError(
          "not_verified",
          "Only a verified payment can be refunded.",
        );
      if (await restoreHolds(tx, order.accountId))
        throw new PaidLedgerError(
          "ledger_restoring",
          "Refund requests are paused during ledger recovery.",
        );
      const amount = input.amountCents ?? order.priceCents;
      if (amount > order.priceCents)
        throw new PaidLedgerError(
          "verification_mismatch",
          "The refund exceeds the order total.",
        );
      const sources = await tx
        .select()
        .from(paidEntitlements)
        .where(eq(paidEntitlements.orderId, order.id))
        .for("update");
      if (input.kind === "subscription") {
        const [source] = sources;
        if (
          !source?.periodStart ||
          source.periodStart <= now() ||
          amount !== order.priceCents
        )
          throw new PaidLedgerError(
            "not_verified",
            "Only a paid future period can be refunded in full for replacement.",
          );
        const refund = await recordRefundWithin(
          tx,
          order,
          "replace_future_subscription",
          now(),
          customerRefund,
        );
        await freezeForRefund(tx, order.id);
        return refund;
      }
      if (!sources.length || sources.some(({ state }) => state !== "granted"))
        throw new PaidLedgerError(
          "not_verified",
          "No refundable credits are attached to this payment.",
        );
      // Corrections can restore the balance without erasing the original
      // usage. A previously used pack still requires review.
      const [usage] = await tx
        .select({
          hasHold: sql<boolean>`coalesce(bool_or(${paidCreditAllocations.state} = 'held'), false)`,
          wasUsed: sql<boolean>`coalesce(bool_or(${paidCreditAllocations.consumedMicrocredits} > 0), false)`,
        })
        .from(paidCreditAllocations)
        .where(
          inArray(
            paidCreditAllocations.entitlementId,
            sources.map(({ id }) => id),
          ),
        );
      const wasUsed =
        usage?.wasUsed ||
        sources.some(({ consumedMicrocredits }) => consumedMicrocredits > 0n);
      if (wasUsed || amount < order.priceCents)
        return recordRefundWithin(
          tx,
          order,
          wasUsed ? "used_credits" : "partial_refund",
          now(),
          customerRefund,
          "manual_review",
          amount,
        );
      if (usage?.hasHold)
        throw new PaidLedgerError(
          "refund_held",
          "Wait for the reserved credits to settle or release, then try again.",
        );
      const refund = await recordRefundWithin(
        tx,
        order,
        "user_request",
        now(),
        customerRefund,
      );
      await freezeForRefund(tx, order.id);
      return refund;
    });
  }

  async function testPackRefundDispatch(input: {
    orderId: string;
    merchant: string;
    channel: CreditPackChannel;
  }) {
    const [row] = await database
      .select({
        id: paidRefunds.id,
        state: paidRefunds.state,
        orderId: paidOrders.id,
        channelOrderRef: paidOrders.channelOrderRef,
        amountCents: paidRefunds.amountCents,
      })
      .from(paidRefunds)
      .innerJoin(paidOrders, eq(paidOrders.id, paidRefunds.orderId))
      .where(
        and(
          eq(paidOrders.id, input.orderId),
          eq(paidOrders.testMerchant, input.merchant),
          eq(paidOrders.channel, input.channel),
          eq(paidRefunds.openedBy, customerRefund),
        ),
      );
    if (row?.channelOrderRef)
      return { ...row, channelOrderRef: row.channelOrderRef };
  }

  async function applyTestPackRefundResult(
    input: CreditPackTestRefundResult & { channel: CreditPackChannel },
  ) {
    return database.transaction(async (tx) => {
      const order = await lockRefundOrder(tx, input.orderId);
      const refund = await findRefund(tx, order.id);
      if (!refund || refund.openedBy !== customerRefund || !order.testMerchant)
        throw new PaidLedgerError("order_unknown", "Unknown test refund.");
      if (
        refund.id !== input.refundId ||
        order.testMerchant !== input.merchantId ||
        order.channel !== input.channel ||
        order.channelOrderRef !== input.channelOrderRef ||
        refund.amountCents !== input.amountCents
      )
        throw new PaidLedgerError(
          "verification_mismatch",
          "The result does not match this test refund.",
        );
      if (refund.state !== "requested" && refund.state !== "processing")
        return refund;
      if (await restoreHolds(tx, order.accountId))
        throw new PaidLedgerError(
          "ledger_restoring",
          "Refund verification is paused during ledger recovery.",
        );
      switch (input.state) {
        case "confirmed":
        case "failed":
          return settleRefundWithin(tx, refund, input.state === "confirmed");
        case "processing":
        case "manual_owed":
        case "disputed":
        case "partial": {
          const [updated] = await tx
            .update(paidRefunds)
            .set(
              input.state === "disputed"
                ? { state: "manual_review", reason: "channel_dispute" }
                : input.state === "partial"
                  ? {
                      state: "manual_review",
                      reason: "channel_partial_refund",
                      manualReviewCents:
                        refund.amountCents - input.returnedCents,
                    }
                  : { state: input.state },
            )
            .where(eq(paidRefunds.id, refund.id))
            .returning();
          return updated;
        }
      }
    });
  }

  /**
   * Settles the refund: confirmed revokes the grant and books the money back
   * through the original channel; failed unfreezes and leaves the refund
   * retryable. Replaying either converges on the recorded outcome.
   */
  async function confirmRefund(orderId: string, succeeded: boolean) {
    return database.transaction(async (tx) => {
      await lockRefundOrder(tx, orderId);
      const refund = await findRefund(tx, orderId);
      if (!refund)
        throw new PaidLedgerError(
          "not_verified",
          "No refund has been requested for this order.",
        );
      if (refund.dispute || refund.openedBy === customerRefund) return refund;
      return settleRefundWithin(tx, refund, succeeded);
    });
  }

  /** Records the operator's confirmation after reconciling a manual payout. */
  async function confirmTestPackManualRefund(input: {
    orderId: string;
    returnedCents: number;
  }) {
    return database.transaction(async (tx) => {
      const order = await lockRefundOrder(tx, input.orderId);
      const refund = await findRefund(tx, order.id);
      if (!order.testMerchant || !refund || refund.openedBy !== customerRefund)
        throw new PaidLedgerError("order_unknown", "Unknown test refund.");
      if (input.returnedCents !== refund.amountCents)
        throw new PaidLedgerError(
          "verification_mismatch",
          "The returned amount does not match the test refund.",
        );
      if (refund.state === "confirmed") return refund;
      if (refund.state !== "manual_owed")
        throw new PaidLedgerError(
          "not_verified",
          "The test refund is not awaiting a manual payout.",
        );
      if (await restoreHolds(tx, refund.accountId))
        throw new PaidLedgerError(
          "ledger_restoring",
          "Refund verification is paused during ledger recovery.",
        );
      return settleRefundWithin(tx, refund, true);
    });
  }

  async function settleRefundWithin(
    tx: Transaction,
    refund: Refund,
    succeeded: boolean,
  ) {
    const { orderId } = refund;
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
      // A dispute can reverse before its original allocations settle.
      // Its live case shows the final amount after the remaining holds clear.
      const granted = refund.dispute
        ? []
        : await tx
            .select({
              consumed: paidEntitlements.consumedMicrocredits,
              credits: paidEntitlements.creditsMicrocredits,
            })
            .from(paidEntitlements)
            .where(eq(paidEntitlements.orderId, orderId));
      const used = granted.reduce((sum, row) => sum + row.consumed, 0n);
      const credits = granted.reduce((sum, row) => sum + row.credits, 0n);
      const manualReviewCents =
        used > 0n && credits > 0n
          ? Number((BigInt(refund.amountCents) * used + credits / 2n) / credits)
          : null;
      const [row] = await tx
        .update(paidRefunds)
        .set({
          state: "confirmed",
          confirmedAt: now(),
          usedMicrocredits: used > 0n ? used : null,
          manualReviewCents,
        })
        .where(eq(paidRefunds.id, refund.id))
        .returning();
      return row;
    }
    // A failed refund restores the grant. Period bounds also protect a
    // restored subscription claim and control when its credits can be spent.
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
        and(eq(paidOrders.id, orderId), eq(paidOrders.state, "refund_pending")),
      );
    const [row] = await tx
      .update(paidRefunds)
      .set({ state: "failed", confirmedAt: now() })
      .where(eq(paidRefunds.id, refund.id))
      .returning();
    return row;
  }

  /** Refunds of one account, newest first — 逐单可查 (#103). */
  async function refunds(accountId: string) {
    return database
      .select()
      .from(paidRefunds)
      .where(eq(paidRefunds.accountId, accountId))
      .orderBy(desc(paidRefunds.requestedAt));
  }

  // ── Verified corrections (#105) ─────────────────────────────────────
  // Original records are never rewritten: a proved overcharge returns
  // credits to the source that paid them while that source is still valid,
  // and anything that cannot return (or platform-fault compensation) lands
  // as non-expiring Correction Credits with its own audit row.

  async function grantCorrectionCredits(
    tx: Transaction,
    accountId: string,
    amountMicrocredits: bigint,
    at: Date,
  ) {
    const [row] = await tx
      .insert(paidEntitlements)
      .values({
        accountId,
        orderId: null,
        kind: "credit_pack",
        creditsMicrocredits: amountMicrocredits,
        state: "granted",
        arrivedAt: at,
      })
      .returning();
    return row;
  }

  /**
   * Corrects one case-verified overcharge of a settled operation. Credits go
   * back to the sources that paid while those are still valid; the rest (all
   * of it, when the source expired) becomes Correction Credits. Works at any
   * time — the reconciliation cutoff does not gate verified corrections.
   */
  async function correctOvercharge(input: {
    accountId: string;
    operationId: string;
    amountMicrocredits: bigint;
    reason: string;
    evidence: string;
    by: string;
  }) {
    return database.transaction(async (tx) => {
      const funded = await tx
        .select({
          entitlementId: paidCreditAllocations.entitlementId,
          consumed: paidCreditAllocations.consumedMicrocredits,
        })
        .from(paidCreditAllocations)
        .where(
          and(
            eq(paidCreditAllocations.accountId, input.accountId),
            eq(paidCreditAllocations.operationId, input.operationId),
            eq(paidCreditAllocations.state, "settled"),
          ),
        );
      const settled = funded.filter(
        (row): row is { entitlementId: string; consumed: bigint } =>
          row.entitlementId !== null && (row.consumed ?? 0n) > 0n,
      );
      if (settled.length === 0)
        throw new PaidLedgerError(
          "order_unknown",
          "No settled paid consumption to correct for this operation.",
        );
      const at = now();
      const sources = await tx
        .select()
        .from(paidEntitlements)
        .where(
          inArray(
            paidEntitlements.id,
            settled.map(({ entitlementId }) => entitlementId),
          ),
        );
      // Refund-to-source only while every paying source is still valid.
      const canReturn = settled.every(({ entitlementId }) =>
        sources.some(
          (source) =>
            source.id === entitlementId &&
            source.state === "granted" &&
            effectiveEntitlement(source, at) === "active",
        ),
      );
      let left = input.amountMicrocredits;
      let refundedSource: string | null = null;
      if (canReturn) {
        for (const { entitlementId, consumed } of settled) {
          if (left <= 0n) break;
          const giveBack = consumed < left ? consumed : left;
          left -= giveBack;
          refundedSource ??= entitlementId;
          await tx
            .update(paidEntitlements)
            .set({
              consumedMicrocredits: sql`${paidEntitlements.consumedMicrocredits} - ${giveBack}`,
            })
            .where(eq(paidEntitlements.id, entitlementId));
        }
      }
      if (left > 0n)
        await grantCorrectionCredits(tx, input.accountId, left, at);
      const [row] = await tx
        .insert(paidCorrections)
        .values({
          accountId: input.accountId,
          operationId: input.operationId,
          entitlementId: canReturn ? refundedSource : null,
          kind: "overcharge_refund",
          amountMicrocredits: input.amountMicrocredits,
          reason: input.reason,
          evidence: input.evidence,
          by: input.by,
          createdAt: at,
        })
        .returning();
      return row;
    });
  }

  /**
   * Books individually verified platform-fault compensation as its own
   * non-expiring credit; periods, anchors and every existing record stay
   * exactly as they were.
   */
  async function applyCompensation(input: {
    accountId: string;
    amountMicrocredits: bigint;
    reason: string;
    evidence: string;
    by: string;
  }) {
    return database.transaction(async (tx) => {
      const at = now();
      const credit = await grantCorrectionCredits(
        tx,
        input.accountId,
        input.amountMicrocredits,
        at,
      );
      const [row] = await tx
        .insert(paidCorrections)
        .values({
          accountId: input.accountId,
          operationId: null,
          entitlementId: credit.id,
          kind: "fault_compensation",
          amountMicrocredits: input.amountMicrocredits,
          reason: input.reason,
          evidence: input.evidence,
          by: input.by,
          createdAt: at,
        })
        .returning();
      return row;
    });
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

  // ── Restore from backup (#108) ───────────────────────────────────────

  /**
   * Restore mode: from a restore from backup until each account has been
   * reconciled and resumed on its own, new charges and entitlement grants
   * stay paused for the accounts still held. Calling it again while a restore
   * is under way keeps the earlier start, so accounts already reconciled
   * stay resumed.
   */
  async function beginRestore(by: string) {
    const [row] = await database
      .insert(billingRestore)
      .values({ id: "ledger", restoringSince: now(), updatedBy: by })
      .onConflictDoUpdate({
        target: billingRestore.id,
        set: {
          restoringSince: sql`coalesce(${billingRestore.restoringSince}, excluded.restoring_since)`,
          updatedBy: by,
          updatedAt: now(),
        },
      })
      .returning({ since: billingRestore.restoringSince });
    return row?.since ?? null;
  }

  /**
   * Puts back an order the backup predates, by the ID the channel knows it
   * by (#108 按原 ID…重建), so its payment can then be verified as any
   * other. Only while a restore is under way, and only once.
   */
  async function restoreOrder(input: {
    id: string;
    accountId: string;
    productCode: string;
    // What the channel's record says the order was placed for.
    priceCents: number;
    channel: "wechat" | "alipay";
  }) {
    return database.transaction(async (tx) => {
      const restoring = await restoreInProgress(tx);
      if (!restoring)
        throw new PaidLedgerError(
          "not_restoring",
          "The ledger is not being restored.",
        );
      const [product] = await tx
        .select({ version: paidProducts.version })
        .from(paidProducts)
        .where(eq(paidProducts.code, input.productCode));
      if (!product)
        throw new PaidLedgerError("product_unavailable", "Unknown product.");
      return (
        await tx
          .insert(paidOrders)
          .values({
            id: input.id,
            accountId: input.accountId,
            productCode: input.productCode,
            productVersion: product.version,
            priceCents: input.priceCents,
            channel: input.channel,
          })
          .onConflictDoNothing()
          .returning()
      )[0];
    });
  }

  /**
   * An account whose records were reconciled against the channel and the
   * trusted usage evidence resumes on its own. One with an unresolved
   * difference is simply not resumed, and stays paused.
   */
  async function resumeAccount(accountId: string) {
    const [restore] = await database
      .select({ since: billingRestore.restoringSince })
      .from(billingRestore)
      .where(eq(billingRestore.id, "ledger"));
    if (!restore?.since) return undefined;
    const [account] = await database
      .update(testCreditAccounts)
      .set({ reconciledAt: now() })
      .where(eq(testCreditAccounts.id, accountId))
      .returning({ reconciledAt: testCreditAccounts.reconciledAt });
    return account?.reconciledAt;
  }

  async function endRestore() {
    await database
      .update(billingRestore)
      .set({ restoringSince: null, updatedBy: null, updatedAt: now() })
      .where(eq(billingRestore.id, "ledger"));
  }

  // ── Pilot wind-down (#107 trial end, #109 shutdown) ──────────────────

  /**
   * The wind-down switch. Stopping sales refuses new orders; stopping
   * reserves refuses new reservations (both Credit types) — dispatched work
   * keeps settling under its original reservation and in-flight refunds
   * continue.
   */
  async function setPilotClosure(input: {
    stopSales: boolean;
    stopReserves: boolean;
  }) {
    const at = now();
    const [row] = await database
      .insert(paidPilotClosure)
      .values({
        id: "pilot",
        salesStoppedAt: input.stopSales ? at : null,
        reservesStoppedAt: input.stopReserves ? at : null,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: paidPilotClosure.id,
        set: {
          salesStoppedAt: input.stopSales ? at : null,
          reservesStoppedAt: input.stopReserves ? at : null,
          updatedAt: at,
        },
      })
      .returning();
    return row;
  }

  /**
   * Wind-down disposition (#109): verified orders whose sources no longer
   * fund a live reservation refund now — in full when nothing was consumed,
   * with the used part booked to manual reconciliation otherwise (#104).
   * Orders still funding held reservations wait for their settlement or
   * release, and a rerun after that picks them up.
   */
  async function closePilotOrders(accountId?: string) {
    const held = await database
      .select({ entitlementId: paidCreditAllocations.entitlementId })
      .from(paidCreditAllocations)
      .where(eq(paidCreditAllocations.state, "held"));
    const heldIds = new Set(
      held.flatMap(({ entitlementId }) =>
        entitlementId === null ? [] : [entitlementId],
      ),
    );
    const orders = await database
      .select({ id: paidOrders.id })
      .from(paidOrders)
      .where(
        accountId
          ? and(
              eq(paidOrders.state, "verified"),
              eq(paidOrders.accountId, accountId),
            )
          : eq(paidOrders.state, "verified"),
      );
    let refunded = 0;
    let waiting = 0;
    for (const order of orders) {
      const grants = await database
        .select({ id: paidEntitlements.id })
        .from(paidEntitlements)
        .where(eq(paidEntitlements.orderId, order.id));
      if (grants.length === 0) continue;
      if (grants.some(({ id }) => heldIds.has(id))) {
        waiting += 1;
        continue;
      }
      const refund = await requestRefund(order.id, "pilot_closure", "operator");
      if (refund.openedBy === customerRefund) {
        waiting += 1;
        continue;
      }
      await confirmRefund(order.id, true);
      refunded += 1;
    }
    return { refunded, waiting };
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
          orderId: entitlement.orderId,
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

  /**
   * The paid side of a person's balance (#107), beside the Test Credit one:
   * what can be spent now, what running steps hold, and what finished steps
   * charged.
   */
  async function paidBalance(accountId: string) {
    return database.transaction(async (tx) => {
      const sources = await spendableSources(tx, accountId, now());
      const [held] = await tx
        .select({
          amount: sql<string>`coalesce(sum(${paidCreditAllocations.amountMicrocredits}), 0)::text`,
        })
        .from(paidCreditAllocations)
        .where(
          and(
            eq(paidCreditAllocations.accountId, accountId),
            eq(paidCreditAllocations.state, "held"),
          ),
        );
      const [consumed] = await tx
        .select({
          amount: sql<string>`coalesce(sum(${paidEntitlements.consumedMicrocredits}), 0)::text`,
        })
        .from(paidEntitlements)
        .where(eq(paidEntitlements.accountId, accountId));
      return {
        availableMicrocredits: sources
          .reduce((sum, { remaining }) => sum + remaining, 0n)
          .toString(),
        reservedMicrocredits: held?.amount ?? "0",
        chargedMicrocredits: consumed?.amount ?? "0",
      };
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
    // Every line names the app its step ran for (#107 按应用筛选), where
    // the caller named one.
    const application = () =>
      and(
        eq(testCreditOperations.accountId, paidCreditAllocations.accountId),
        eq(testCreditOperations.id, paidCreditAllocations.operationId),
      );
    const paidLines = await database
      .select({
        operationId: paidCreditAllocations.operationId,
        applicationId: testCreditOperations.applicationId,
        source: paidEntitlements.kind,
        entitlementId: paidEntitlements.id,
        orderId: paidEntitlements.orderId,
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
      .leftJoin(testCreditOperations, application())
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
        applicationId: testCreditOperations.applicationId,
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
    // Corrections keep the original charge lines and appear beside them,
    // linked to the operation they correct (#105 账单保留原扣费并链接更正).
    const correctionLines = await database
      .select({
        operationId: paidCorrections.operationId,
        applicationId: testCreditOperations.applicationId,
        amountMicrocredits: paidCorrections.amountMicrocredits,
        reason: paidCorrections.reason,
        at: paidCorrections.createdAt,
      })
      .from(paidCorrections)
      .leftJoin(
        testCreditOperations,
        and(
          eq(testCreditOperations.accountId, paidCorrections.accountId),
          eq(testCreditOperations.id, paidCorrections.operationId),
        ),
      )
      .where(eq(paidCorrections.accountId, accountId))
      .orderBy(paidCorrections.createdAt);
    const disputeLines = await readDisputes(
      eq(paidOrders.accountId, accountId),
    );
    return [
      ...testLines.map((line) => ({
        ...line,
        amountMicrocredits: line.amountMicrocredits,
        source: "test" as const,
        entitlementId: null,
        orderId: null,
        periodStart: null,
        periodEnd: null,
        arrivedAt: null,
        reason: null as string | null,
      })),
      ...paidLines.map((line) => ({
        ...line,
        amountMicrocredits: (line.amountMicrocredits ?? 0n).toString(),
        reason: null as string | null,
      })),
      ...correctionLines.map((line) => ({
        ...line,
        amountMicrocredits: line.amountMicrocredits.toString(),
        source: "correction" as const,
        entitlementId: null,
        orderId: null,
        periodStart: null,
        periodEnd: null,
        arrivedAt: null,
      })),
      ...disputeLines.map(({ orderId, priceCents, disputeRecord }) => ({
        source: "dispute" as const,
        orderId,
        operationId: null,
        applicationId: null,
        entitlementId: null,
        periodStart: null,
        periodEnd: null,
        arrivedAt: null,
        reason: null,
        amountMicrocredits: "0",
        at: disputeRecord.openedAt,
        dispute: disputeView(disputeRecord, priceCents),
      })),
    ].sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
  }

  return {
    upsertProduct,
    createOrder,
    creditPackOffer,
    subscriptionOffer,
    testPackOrders,
    closeTestPackOrder,
    verifyOrder,
    entitlements,
    freezeEntitlements,
    revokeEntitlements,
    requestRefund,
    handleDispute,
    disputeStatus,
    requestTestPackRefund,
    testPackRefundDispatch,
    applyTestPackRefundResult,
    confirmRefund,
    confirmTestPackManualRefund,
    refunds,
    correctOvercharge,
    applyCompensation,
    suspendAccount,
    setPilotClosure,
    closePilotOrders,
    pendingOrders,
    closeOrder,
    paidPaths,
    beginRestore,
    restoreOrder,
    resumeAccount,
    endRestore,
    activeSubscription,
    paidSources,
    paidBalance,
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

/** A reservation made before a dispute may only settle if it already dispatched. */
export async function hasDisputedPaidHold(
  tx: PaidTx,
  accountId: string,
  operationId: string,
) {
  const [row] = await tx
    .select({ id: paidCreditAllocations.id })
    .from(paidCreditAllocations)
    .innerJoin(
      paidEntitlements,
      eq(paidCreditAllocations.entitlementId, paidEntitlements.id),
    )
    .innerJoin(paidRefunds, eq(paidEntitlements.orderId, paidRefunds.orderId))
    .where(
      and(
        eq(paidCreditAllocations.accountId, accountId),
        eq(paidCreditAllocations.operationId, operationId),
        eq(paidCreditAllocations.state, "held"),
        inArray(paidEntitlements.state, ["frozen", "revoked"]),
        isDispute,
      ),
    )
    .limit(1);
  return Boolean(row);
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

/**
 * Whether a restore from backup still holds an account (#108): new charges
 * and grants stay paused for it until it has been reconciled and resumed.
 */
async function restoreInProgress(tx: PaidTx) {
  const [restore] = await tx
    .select({ since: billingRestore.restoringSince })
    .from(billingRestore)
    .where(eq(billingRestore.id, "ledger"));
  return restore?.since;
}

export async function restoreHolds(tx: PaidTx, accountId: string) {
  const since = await restoreInProgress(tx);
  if (!since) return false;
  const [account] = await tx
    .select({ reconciledAt: testCreditAccounts.reconciledAt })
    .from(testCreditAccounts)
    .where(eq(testCreditAccounts.id, accountId));
  return !(account?.reconciledAt && account.reconciledAt >= since);
}

/**
 * The pilot's reserve cutoff, when wind-down has begun (#107/#109). New
 * reservations of either Credit type stop at this instant; dispatched work
 * keeps settling under its original reservation.
 */
export async function pilotReservesStoppedAt(tx: PaidTx) {
  const [row] = await tx
    .select({ stoppedAt: paidPilotClosure.reservesStoppedAt })
    .from(paidPilotClosure)
    .where(eq(paidPilotClosure.id, "pilot"));
  return row?.stoppedAt ?? null;
}
