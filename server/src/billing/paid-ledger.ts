import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
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
  billingSuspensionHistory,
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
import {
  currentRouteLimit,
  eligibleSignoff,
  type PilotDeployment,
  readPilotRoutes,
  sharedPilotCostScope,
  signedSupplier,
} from "./pilot-signoffs";

const customerRefund = "customer";
const automaticFixtureRefund = "fixture-automatic";
const fixtureRefundActors = [customerRefund, automaticFixtureRefund];
type Refund = typeof paidRefunds.$inferSelect;
type OrderVerification = { order: typeof paidOrders.$inferSelect } & (
  | {
      replayed: true;
      claimed: boolean;
      refunded?: true;
      entitlement?: never;
      refund?: never;
    }
  | {
      replayed: false;
      claimed: true;
      entitlement: typeof paidEntitlements.$inferSelect;
      refunded?: never;
      refund?: never;
    }
  | {
      replayed: false;
      claimed: false;
      refunded: true;
      refund: Refund;
      entitlement?: never;
    }
);

const isDispute = or(
  isNotNull(paidRefunds.dispute),
  eq(paidRefunds.reason, "channel_dispute"),
);

const orderUsageFields = {
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
  ...orderUsageFields,
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

const paidPathFilter = isNotNull(billingApplications.approvedAt);

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
      | "channel_unavailable"
      | "ledger_restoring"
      | "not_restoring"
      | "correction_conflict",
    message: string,
  ) {
    super(message);
    this.name = "PaidLedgerError";
  }
}

type SaleChannel = {
  channel: CreditPackChannel;
  merchant?: string;
  fixture: boolean;
};

export function createPaidCreditLedger(
  database: Database,
  clock?: () => Date,
  // What the deployment pays through. Named, a channel result must match it.
  channels?: {
    currency: string;
    merchants?: Partial<Record<"wechat" | "alipay", string>>;
  },
  pilot?: PilotDeployment,
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
    sale?: SaleChannel,
    priceCents?: number,
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
    if ((await pilotClosure(tx, accountId))?.salesStoppedAt)
      throw new PaidLedgerError(
        "pilot_closed",
        "Pilot sales are stopped; no new orders.",
      );
    const availablePaths =
      paths ?? (await readPaidPaths(tx, testApplicationIds).for("share"));
    if (pilot) {
      const catalog = await readPilotRoutes(tx, true);
      const shared = await currentRouteLimit(tx, sharedPilotCostScope);
      let qualified = false;
      path: for (const { id, pausedAt } of availablePaths) {
        if (pausedAt) continue;
        const record = await eligibleSignoff(
          tx,
          pilot,
          "application",
          id,
          accountId,
        );
        if (record?.kind !== "application") continue;
        for (const route of catalog?.options ?? []) {
          const routeLimit = await currentRouteLimit(tx, route.id);
          if (
            record.routes.some(({ resourceType }) =>
              signedSupplier(
                record,
                route,
                { route: routeLimit, shared },
                BigInt(route.maxChargeMicrocredits),
                resourceType,
              ),
            )
          ) {
            qualified = true;
            break path;
          }
        }
      }
      if (!qualified)
        throw new PaidLedgerError(
          "no_paid_path",
          "No signed paid application path is available.",
        );
      const channel =
        sale &&
        (await eligibleSignoff(tx, pilot, "channel", sale.channel, accountId));
      if (
        channel?.kind !== "channel" ||
        channel.merchant !== sale?.merchant ||
        sale.fixture !== (pilot.evidence === "fixture") ||
        (priceCents !== undefined && priceCents > channel.maxOrderCents)
      )
        throw new PaidLedgerError(
          "channel_unavailable",
          "The payment channel is unavailable for this order.",
        );
      if (testApplicationIds) await spendableSources(tx, accountId, now());
      return channel.maxOrderCents;
    }
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
    sale?: SaleChannel,
  ) {
    return database.transaction(async (tx) => {
      const product = await readProduct(tx, code);
      const paths = await readPaidPaths(tx, applicationIds);
      let blockedReason: string | null =
        product?.kind === "credit_pack"
          ? null
          : "The test Credit Pack is unavailable.";
      try {
        await checkSales(
          tx,
          accountId,
          applicationIds,
          paths,
          sale,
          product?.priceCents,
        );
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
    sale?: SaleChannel,
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
      let products = eligible
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
          const maxOrderCents = await checkSales(
            tx,
            accountId,
            applicationIds,
            paths,
            sale,
          );
          if (maxOrderCents !== undefined)
            products = products.filter(
              ({ priceCents }) => priceCents <= maxOrderCents,
            );
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
    const [account] = await tx
      .select({ id: testCreditAccounts.id })
      .from(testCreditAccounts)
      .where(eq(testCreditAccounts.id, accountId))
      .for("no key update");
    return account;
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
      await lockAccount(tx, input.accountId);
      let renewsOrderId: string | undefined;
      if (testPack?.kind === "subscription") {
        const concurrent = await replay();
        if (concurrent) return { ...concurrent, replayed: true };
        const at = now();
        const [period] = await subscriptionPeriods(tx, input.accountId, at);
        if (subscriptionSlotTaken(period, at))
          throw new PaidLedgerError(
            "subscription_slot_taken",
            subscriptionSlotMessage,
          );
        // Keep late payments attached to the renewal the buyer originally ordered.
        renewsOrderId = period?.id;
      }
      await checkSales(
        tx,
        input.accountId,
        testPack?.applicationIds,
        undefined,
        {
          channel: input.channel,
          merchant: testPack?.merchant ?? channels?.merchants?.[input.channel],
          fixture: testPack !== undefined,
        },
        product.priceCents,
      );
      const [order] = await tx
        .insert(paidOrders)
        .values({
          id: testPack?.id,
          accountId: input.accountId,
          productCode: product.code,
          productVersion: product.version,
          priceCents: product.priceCents,
          lockedKind: product.kind,
          renewsOrderId,
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

  async function checkTestCheckout(
    accountId: string,
    applicationIds: string[],
    sale?: SaleChannel,
    priceCents?: number,
  ) {
    await database.transaction((tx) =>
      checkSales(tx, accountId, applicationIds, undefined, sale, priceCents),
    );
  }

  async function switchOrder(input: {
    accountId: string;
    originalId: string;
    id: string;
    source: { channel: CreditPackChannel; merchant: string };
    target: {
      channel: CreditPackChannel;
      merchant: string;
      applicationIds: string[];
    };
    kind?: "subscription";
    reconcile: (id: string) => Promise<void>;
  }) {
    const { accountId, originalId, id, source, target } = input;
    const findSource = async (tx: Transaction) => {
      const [order] = await tx
        .select()
        .from(paidOrders)
        .where(
          and(
            eq(paidOrders.id, originalId),
            eq(paidOrders.accountId, accountId),
            eq(paidOrders.channel, source.channel),
            eq(paidOrders.testMerchant, source.merchant),
            eq(paidOrders.lockedKind, input.kind ?? "credit_pack"),
          ),
        );
      if (!order) throw new PaidLedgerError("order_unknown", "Unknown order.");
      return order;
    };
    const findSwitch = async (tx: Transaction) => {
      const [existing] = await tx
        .select()
        .from(paidOrders)
        .where(eq(paidOrders.switchedFromOrderId, originalId));
      if (!existing) return;
      if (
        existing.channel !== target.channel ||
        existing.testMerchant !== target.merchant
      )
        throw new PaidLedgerError(
          "order_conflict",
          "This order has already switched channels.",
        );
      return { ...existing, replayed: true };
    };
    const original = await database.transaction(async (tx) => {
      const order = await findSource(tx);
      const replay = await findSwitch(tx);
      if (replay) return replay;
      if (order.state !== "pending" && order.state !== "failed")
        throw new PaidLedgerError(
          "order_conflict",
          "The original order already received a payment.",
        );
      await checkSales(
        tx,
        accountId,
        target.applicationIds,
        undefined,
        {
          ...target,
          fixture: true,
        },
        order.priceCents,
      );
      return { ...order, replayed: false };
    });
    if (original.replayed) return original;

    // Channel I/O can itself discover and verify a payment. Re-read under
    // the account lock before creating the replacement.
    await input.reconcile(original.id);
    return database.transaction(async (tx) => {
      await lockAccount(tx, accountId);
      const order = await findSource(tx);
      const replay = await findSwitch(tx);
      if (replay) return replay;
      if (order.state !== "pending" && order.state !== "failed")
        throw new PaidLedgerError(
          "order_conflict",
          "The original order already received a payment.",
        );
      await checkSales(
        tx,
        accountId,
        target.applicationIds,
        undefined,
        {
          ...target,
          fixture: true,
        },
        order.priceCents,
      );
      const [replacement] = await tx
        .insert(paidOrders)
        .values({
          id,
          accountId,
          productCode: order.productCode,
          productVersion: order.productVersion,
          priceCents: order.priceCents,
          lockedKind: order.lockedKind,
          lockedMicrocredits: order.lockedMicrocredits,
          renewsOrderId: order.renewsOrderId,
          switchedFromOrderId: order.id,
          checkoutAttemptId: order.checkoutAttemptId ?? order.id,
          channel: target.channel,
          testMerchant: target.merchant,
        })
        .onConflictDoNothing({ target: paidOrders.id })
        .returning();
      if (!replacement)
        throw new PaidLedgerError(
          "order_conflict",
          "This order identifier is unavailable.",
        );
      return { ...replacement, replayed: false };
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
        switchedFromOrderId: paidOrders.switchedFromOrderId,
        switchOrderId: sql<
          string | null
        >`(select replacement.id from paid_orders replacement where replacement.switched_from_order_id = ${paidOrders.id})`,
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
          reason: paidRefunds.reason,
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
    const result = await database.transaction<OrderVerification>(async (tx) => {
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

      const refundPayment = async (
        reason:
          | "account_suspended"
          | "pilot_closure"
          | "duplicate_future_period"
          | "duplicate_checkout_attempt",
      ) => {
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
          reason,
          now(),
          order.testMerchant ? automaticFixtureRefund : "channel",
        );
        return {
          order: owed,
          replayed: false as const,
          claimed: false as const,
          refunded: true as const,
          refund,
        };
      };
      const [account] = await tx
        .select({ suspendedAt: testCreditAccounts.suspendedAt })
        .from(testCreditAccounts)
        .where(eq(testCreditAccounts.id, order.accountId));
      const [pastSuspension] = await tx
        .select({ startedAt: billingSuspensionHistory.startedAt })
        .from(billingSuspensionHistory)
        .where(
          and(
            eq(billingSuspensionHistory.accountId, order.accountId),
            lte(billingSuspensionHistory.startedAt, input.paidAt),
            gt(billingSuspensionHistory.endedAt, input.paidAt),
          ),
        )
        .limit(1);
      if (
        pastSuspension ||
        (account?.suspendedAt && input.paidAt >= account.suspendedAt)
      )
        return refundPayment("account_suspended");

      // A payment confirmed at or after the pilot's reserve cutoff never
      // grants: it refunds in full through its own channel (#109 截止时及
      // 之后原路全退且不授予权益; notifications may arrive late).
      const cutoff = await pilotReservesStoppedAt(tx, order.accountId);
      if (cutoff && input.paidAt >= cutoff)
        return refundPayment("pilot_closure");

      const attemptId = order.checkoutAttemptId ?? order.id;
      const [claimedAttempt] = await tx
        .select({ id: paidEntitlements.id })
        .from(paidEntitlements)
        .innerJoin(paidOrders, eq(paidOrders.id, paidEntitlements.orderId))
        .where(
          and(
            eq(paidOrders.accountId, order.accountId),
            or(
              eq(paidOrders.id, attemptId),
              eq(paidOrders.checkoutAttemptId, attemptId),
            ),
          ),
        )
        .limit(1);

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
      if (claimedAttempt)
        return refundPayment(
          kind === "subscription"
            ? "duplicate_future_period"
            : "duplicate_checkout_attempt",
        );

      if (kind === "subscription") {
        const [latest] = await subscriptionPeriods(
          tx,
          order.accountId,
          input.paidAt,
        );
        let previous:
          | Pick<typeof latest, "periodStart" | "periodEnd" | "anchorDay">
          | undefined = latest;
        if (order.renewsOrderId) {
          const [renewed] = await tx
            .select()
            .from(paidEntitlements)
            .where(eq(paidEntitlements.orderId, order.renewsOrderId));
          previous = renewed;
        } else if (subscriptionSlotTaken(latest, input.paidAt)) {
          return refundPayment("duplicate_future_period");
        }
        if (
          previous?.periodStart &&
          previous.periodEnd &&
          previous.anchorDay !== null
        ) {
          period = advancePurchasePeriod({
            start: previous.periodStart,
            end: previous.periodEnd,
            anchorDay: previous.anchorDay,
          });
          const [occupied] = await tx
            .select({ id: paidEntitlements.id })
            .from(paidEntitlements)
            .where(
              and(
                eq(paidEntitlements.accountId, order.accountId),
                eq(paidEntitlements.kind, "subscription"),
                eq(paidEntitlements.periodStart, period.start),
                ne(paidEntitlements.state, "revoked"),
              ),
            )
            .limit(1);
          if (occupied) return refundPayment("duplicate_future_period");

          const effectiveAt = new Date(Math.max(+input.paidAt, +now()));
          if (period.start > effectiveAt) {
            state = "future";
            await tx
              .update(paidEntitlements)
              .set({ state: "granted" })
              .where(
                and(
                  eq(paidEntitlements.accountId, order.accountId),
                  eq(paidEntitlements.kind, "subscription"),
                  eq(paidEntitlements.state, "future"),
                  lte(paidEntitlements.periodStart, effectiveAt),
                ),
              );
          }
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
        setWhere: sql`${paidRefunds.state} <> 'confirmed' AND ${paidRefunds.openedBy} not in (${customerRefund}, ${automaticFixtureRefund})`,
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
        .select(orderUsageFields)
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
        existing &&
        (existing.state === "confirmed" ||
          existing.dispute ||
          existing.reason === "pilot_closure" ||
          fixtureRefundActors.includes(existing.openedBy))
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
          inArray(paidRefunds.openedBy, fixtureRefundActors),
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
      if (
        !refund ||
        !fixtureRefundActors.includes(refund.openedBy) ||
        !order.testMerchant
      )
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
      if (
        refund.dispute ||
        fixtureRefundActors.includes(refund.openedBy) ||
        refund.state === "awaiting_settlement" ||
        (refund.reason === "pilot_closure" && refund.state === "manual_review")
      )
        return refund;
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
      if (
        !order.testMerchant ||
        !refund ||
        !fixtureRefundActors.includes(refund.openedBy)
      )
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
    if (refund.reason === "pilot_closure") {
      const [row] = await tx
        .update(paidRefunds)
        .set({ state: "manual_owed" })
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

  type CorrectionCase = {
    accountId: string;
    amountMicrocredits: bigint;
    reason: string;
    evidence: string;
    by: string;
  };

  async function bookCorrection(
    input: CorrectionCase &
      (
        | { kind: "overcharge_refund"; operationId: string }
        | { kind: "fault_compensation"; operationId?: string }
      ),
  ) {
    return database.transaction(async (tx) => {
      const operationId = input.operationId ?? null;
      const account = await lockAccount(tx, input.accountId);
      if (!account)
        throw new PaidLedgerError("order_unknown", "Unknown Billing Account.");

      const prior = await tx
        .select()
        .from(paidCorrections)
        .where(
          and(
            eq(paidCorrections.accountId, input.accountId),
            eq(paidCorrections.kind, input.kind),
            operationId === null
              ? isNull(paidCorrections.operationId)
              : eq(paidCorrections.operationId, operationId),
          ),
        );
      const existing = prior.find((entry) => entry.evidence === input.evidence);
      if (existing) {
        if (
          existing.amountMicrocredits !== input.amountMicrocredits ||
          existing.reason !== input.reason
        ) {
          throw new PaidLedgerError(
            "correction_conflict",
            "This verified case already has a different correction.",
          );
        }
        return existing;
      }

      if (await restoreHolds(tx, input.accountId))
        throw new PaidLedgerError(
          "ledger_restoring",
          "Credits cannot be issued during ledger recovery.",
        );

      const sources = await tx
        .select()
        .from(paidEntitlements)
        .where(eq(paidEntitlements.accountId, input.accountId))
        .orderBy(paidEntitlements.id)
        .for("update");
      const at = now();
      const available = async () =>
        (await spendableSources(tx, input.accountId, at)).reduce(
          (sum, row) => sum + row.remaining,
          0n,
        );
      const availableBefore = await available();
      let creditAmount = input.amountMicrocredits;
      let entitlementId: string | null = null;
      if (operationId !== null) {
        const allocations = await tx
          .select({
            entitlementId: paidCreditAllocations.entitlementId,
            consumed: paidCreditAllocations.consumedMicrocredits,
          })
          .from(paidCreditAllocations)
          .where(
            and(
              eq(paidCreditAllocations.accountId, input.accountId),
              eq(paidCreditAllocations.operationId, operationId),
              eq(paidCreditAllocations.state, "settled"),
            ),
          )
          .orderBy(paidCreditAllocations.position);
        if (input.kind === "fault_compensation" && allocations.length === 0) {
          const [operation] = await tx
            .select({ id: testCreditOperations.id })
            .from(testCreditOperations)
            .where(
              and(
                eq(testCreditOperations.accountId, input.accountId),
                eq(testCreditOperations.id, operationId),
              ),
            );
          if (!operation)
            throw new PaidLedgerError("order_unknown", "Unknown operation.");
        }
        if (input.kind === "overcharge_refund") {
          const total = allocations.reduce(
            (sum, row) => sum + (row.consumed ?? 0n),
            0n,
          );
          if (total === 0n) {
            throw new PaidLedgerError(
              "order_unknown",
              "No settled paid consumption to correct for this operation.",
            );
          }
          let corrected = prior.reduce(
            (sum, row) => sum + row.amountMicrocredits,
            0n,
          );
          if (input.amountMicrocredits > total - corrected) {
            throw new PaidLedgerError(
              "correction_conflict",
              "The amount exceeds the remaining settled charge.",
            );
          }
          let left = input.amountMicrocredits;
          for (const allocation of allocations) {
            if (left === 0n) break;
            const consumed = allocation.consumed ?? 0n;
            const skipped = corrected < consumed ? corrected : consumed;
            corrected -= skipped;
            const uncorrected = consumed - skipped;
            const amount = uncorrected < left ? uncorrected : left;
            left -= amount;
            const source = sources.find(
              ({ id }) => id === allocation.entitlementId,
            );
            if (
              !source ||
              amount === 0n ||
              effectiveEntitlement(source, at) !== "active"
            )
              continue;
            entitlementId ??= source.id;
            creditAmount -= amount;
            await tx
              .update(paidEntitlements)
              .set({
                consumedMicrocredits: sql`${paidEntitlements.consumedMicrocredits} - ${amount}`,
              })
              .where(eq(paidEntitlements.id, source.id));
          }
        }
      }

      if (creditAmount > 0n) {
        const credit = await grantCorrectionCredits(
          tx,
          input.accountId,
          creditAmount,
          at,
        );
        if (input.kind === "fault_compensation") entitlementId = credit.id;
      }
      const [row] = await tx
        .insert(paidCorrections)
        .values({
          accountId: input.accountId,
          operationId,
          entitlementId,
          kind: input.kind,
          amountMicrocredits: input.amountMicrocredits,
          reason: input.reason,
          evidence: input.evidence,
          by: input.by,
          availableBeforeMicrocredits: availableBefore,
          availableAfterMicrocredits: await available(),
          correctionCreditsMicrocredits: creditAmount,
          createdAt: at,
        })
        .returning();
      return row;
    });
  }

  function correctOvercharge(input: CorrectionCase & { operationId: string }) {
    return bookCorrection({ ...input, kind: "overcharge_refund" });
  }

  function applyCompensation(input: CorrectionCase & { operationId?: string }) {
    return bookCorrection({ ...input, kind: "fault_compensation" });
  }

  /**
   * Reflects the upstream identity state (Casdoor 停用): while suspended, new
   * purchases pause and payments that land anyway refund in full; in-flight
   * refunds and dispatched settlements continue.
   */
  async function suspendAccount(accountId: string, suspended: boolean) {
    return database.transaction(async (tx) => {
      await lockAccount(tx, accountId);
      const [account] = await tx
        .select({ suspendedAt: testCreditAccounts.suspendedAt })
        .from(testCreditAccounts)
        .where(eq(testCreditAccounts.id, accountId));
      if (!account)
        throw new PaidLedgerError("order_unknown", "Unknown account.");
      if (Boolean(account.suspendedAt) === suspended) return suspended;
      const at = now();
      if (account.suspendedAt)
        await tx
          .insert(billingSuspensionHistory)
          .values({
            accountId,
            startedAt: account.suspendedAt,
            endedAt: at,
          })
          .onConflictDoUpdate({
            target: [
              billingSuspensionHistory.accountId,
              billingSuspensionHistory.startedAt,
            ],
            set: { endedAt: at },
          });
      await tx
        .update(testCreditAccounts)
        .set({ suspendedAt: suspended ? at : null })
        .where(eq(testCreditAccounts.id, accountId));
      return suspended;
    });
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

  // ── Pilot wind-down (#109 shutdown) ──────────────────

  /**
   * The wind-down switch. Stopping sales refuses new orders; stopping
   * reserves refuses new reservations (both Credit types) — dispatched work
   * keeps settling under its original reservation and in-flight refunds
   * continue.
   */
  async function setPilotClosure(input: {
    accountId?: string;
    stopSales: boolean;
    stopReserves: boolean;
  }) {
    return database.transaction(async (tx) => {
      if (input.accountId && !(await lockAccount(tx, input.accountId)))
        throw new PaidLedgerError(
          "order_unknown",
          "Billing Account unavailable.",
        );
      const at = now();
      const [row] = await tx
        .insert(paidPilotClosure)
        .values({
          id: input.accountId ?? "pilot",
          salesStoppedAt: input.stopSales ? at : null,
          reservesStoppedAt: input.stopReserves ? at : null,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: paidPilotClosure.id,
          set: {
            salesStoppedAt: input.stopSales
              ? sql`coalesce(${paidPilotClosure.salesStoppedAt}, excluded.sales_stopped_at)`
              : null,
            reservesStoppedAt: input.stopReserves
              ? sql`coalesce(${paidPilotClosure.reservesStoppedAt}, excluded.reserves_stopped_at)`
              : null,
            updatedAt: at,
          },
        })
        .returning();
      return row;
    });
  }

  async function closureCutoff(accountId: string) {
    return pilotReservesStoppedAt(database, accountId);
  }

  async function closedPilotAccounts() {
    return database
      .select({ accountId: testCreditAccounts.id })
      .from(paidPilotClosure)
      .innerJoin(
        testCreditAccounts,
        sql`${testCreditAccounts.id}::text = ${paidPilotClosure.id}`,
      )
      .where(isNotNull(paidPilotClosure.reservesStoppedAt));
  }

  /** Recheck one order under the same account lock as reservations and settlement. */
  async function advanceClosureOrder(accountId: string, orderId: string) {
    return database.transaction(async (tx) => {
      await lockAccount(tx, accountId);
      if (!(await pilotReservesStoppedAt(tx, accountId))) return;
      if (await restoreHolds(tx, accountId)) return;
      const order = await lockRefundOrder(tx, orderId);
      if (order.accountId !== accountId || order.state !== "verified") return;
      const existing = await findRefund(tx, orderId);
      if (
        existing &&
        (existing.dispute ||
          (existing.state !== "awaiting_settlement" &&
            existing.state !== "failed"))
      )
        return existing;

      const sources = await tx
        .select({ id: paidEntitlements.id })
        .from(paidEntitlements)
        .where(eq(paidEntitlements.orderId, orderId))
        .for("update");
      if (!sources.length) return;
      const [usage] = await tx
        .select(orderUsageFields)
        .from(paidOrders)
        .where(eq(paidOrders.id, orderId));
      const used = BigInt(usage.used);
      // A channel that definitively rejected this refund ID cannot be retried
      // under a new ID without operator reconciliation.
      const hadFailed =
        existing?.state === "failed" || existing?.confirmedAt != null;
      const state = usage.hasHold
        ? "awaiting_settlement"
        : used > 0n
          ? "manual_review"
          : hadFailed
            ? "manual_owed"
            : "requested";
      if (existing && existing.state === state) return existing;
      const refund =
        existing ??
        (await recordRefundWithin(
          tx,
          order,
          "pilot_closure",
          now(),
          order.testMerchant ? automaticFixtureRefund : "operator",
          state,
        ));
      if (state === "awaiting_settlement" && !existing) return refund;
      if (state !== "awaiting_settlement") await freezeForRefund(tx, orderId);
      const [updated] = await tx
        .update(paidRefunds)
        .set({
          state,
          reason: "pilot_closure",
          openedBy: order.testMerchant ? automaticFixtureRefund : "operator",
          // Preserve failed channel evidence while waiting on newer holds.
          confirmedAt:
            state === "awaiting_settlement" ? existing?.confirmedAt : null,
          usedMicrocredits: used > 0n ? used : null,
          manualReviewCents:
            used > 0n
              ? usedShareCents(order.priceCents, usage.used, usage.total)
              : null,
        })
        .where(eq(paidRefunds.id, refund.id))
        .returning();
      return updated;
    });
  }

  async function closePilotOrders(accountId: string) {
    const orders = await database
      .select({ id: paidOrders.id })
      .from(paidOrders)
      .where(
        and(
          eq(paidOrders.accountId, accountId),
          eq(paidOrders.state, "verified"),
        ),
      );
    for (const order of orders) await advanceClosureOrder(accountId, order.id);
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
      .where(
        and(
          eq(paidCreditAllocations.accountId, accountId),
          eq(paidCreditAllocations.state, "held"),
        ),
      )
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
          kind:
            entitlement.orderId === null
              ? ("correction_credit" as const)
              : entitlement.kind,
          arrivedAt: entitlement.arrivedAt,
          remainingMicrocredits: remaining.toString(),
        }))
        .sort((a, b) =>
          (a.kind === "subscription") === (b.kind === "subscription")
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
    return database.transaction((tx) =>
      paidBalanceWithin(tx, accountId, now()),
    );
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
        orderId: paidEntitlements.orderId,
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
        id: paidCorrections.id,
        kind: paidCorrections.kind,
        evidence: paidCorrections.evidence,
        by: paidCorrections.by,
        availableBeforeMicrocredits:
          paidCorrections.availableBeforeMicrocredits,
        availableAfterMicrocredits: paidCorrections.availableAfterMicrocredits,
        correctionCreditsMicrocredits:
          paidCorrections.correctionCreditsMicrocredits,
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
    const periodByOperation = new Map(
      paidLines.flatMap((line) =>
        line.periodStart === null ? [] : [[line.operationId, line] as const],
      ),
    );
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
      ...paidLines.map(({ orderId, ...line }) => ({
        ...line,
        orderId,
        source: orderId === null ? ("correction_credit" as const) : line.source,
        amountMicrocredits: (line.amountMicrocredits ?? 0n).toString(),
        reason: null as string | null,
      })),
      ...correctionLines.map((line) => {
        const originalPeriod =
          line.operationId === null
            ? undefined
            : periodByOperation.get(line.operationId);
        return {
          operationId: line.operationId,
          applicationId: line.applicationId,
          reason: line.reason,
          at: line.at,
          amountMicrocredits: line.amountMicrocredits.toString(),
          source: "correction" as const,
          entitlementId: null,
          periodStart: originalPeriod?.periodStart ?? null,
          periodEnd: originalPeriod?.periodEnd ?? null,
          arrivedAt: null,
          correction: {
            id: line.id,
            kind: line.kind,
            evidence: line.evidence,
            operator: line.by,
            availableBeforeMicrocredits:
              line.availableBeforeMicrocredits?.toString() ?? null,
            availableAfterMicrocredits:
              line.availableAfterMicrocredits?.toString() ?? null,
            correctionCreditsMicrocredits:
              line.correctionCreditsMicrocredits?.toString() ?? null,
          },
        };
      }),
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
    switchOrder,
    checkTestCheckout,
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
    closureCutoff,
    closedPilotAccounts,
    advanceClosureOrder,
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
    .where(
      and(
        eq(paidCreditAllocations.accountId, accountId),
        eq(paidCreditAllocations.state, "held"),
      ),
    )
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

export async function paidBalanceWithin(
  tx: PaidTx,
  accountId: string,
  at: Date,
) {
  const sources = await spendableSourcesWithin(tx, accountId, at);
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
async function pilotClosure(tx: Database | PaidTx, accountId: string) {
  const [cutoffs] = await tx
    .select({
      salesStoppedAt:
        sql<Date | null>`min(${paidPilotClosure.salesStoppedAt})`.mapWith(
          paidPilotClosure.salesStoppedAt,
        ),
      reservesStoppedAt:
        sql<Date | null>`min(${paidPilotClosure.reservesStoppedAt})`.mapWith(
          paidPilotClosure.reservesStoppedAt,
        ),
    })
    .from(paidPilotClosure)
    .where(inArray(paidPilotClosure.id, ["pilot", accountId]));
  return cutoffs;
}

export async function pilotReservesStoppedAt(
  tx: Database | PaidTx,
  accountId: string,
) {
  return (await pilotClosure(tx, accountId))?.reservesStoppedAt ?? null;
}
