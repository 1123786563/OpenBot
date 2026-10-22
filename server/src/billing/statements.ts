import {
  fulfillmentStateOfOrder,
  type PaymentOrderEventRecord,
  type PaymentOrderReadScope,
  type PaymentOrderRecord,
  type PaymentStore,
} from "./payments/types";
import type {
  BillingEntitlements,
  BillingInvoice,
  BillingInvoiceDetail,
  BillingInvoicePage,
  BillingPaymentAnomaly,
  BillingPlanUsage,
  BillingQuotaEntry,
  BillingService,
} from "./types";

/**
 * The two reads a person makes of their money: what they have used of the plan, and what they have
 * been billed.
 *
 * WHY A MODULE RATHER THAN TWO MORE METHODS ON THE SERVICE. Neither answer is the provider's. The
 * plan-usage answer is a JOIN across two sources the service already owns — the subscription's
 * period (entitlements) and the period's charges (usage) — plus a ceiling the DEPLOYMENT owns
 * (`LAGO_PLAN_QUOTAS`); the provider has no opinion about that ceiling, so asking it would be
 * asking the wrong system. The invoice answer is not the provider's at all: this deployment raises
 * its own orders and settles them through its own channels, so a bill is a local payment order read
 * as a statement, not a document fetched from anywhere.
 *
 * Both are read-only, and neither can fail into a half answer: no subscription is `active: false`
 * with an empty quota list, not an error, because "you have no plan" is a fact the page renders.
 */

/** How many bills a page holds. Ours, not the caller's — the same rule as the event log. */
const INVOICE_PAGE_SIZE = 20;

/** One configured ceiling, as `LAGO_PLAN_QUOTAS` spells it. */
type QuotaConfig = ReadonlyMap<string, readonly BillingQuotaEntry[]>;

function providerPeriodOf(entitlements: BillingEntitlements): {
  start: string | null;
  end: string | null;
} | null {
  if (!entitlements.active || !entitlements.subscription) return null;
  return {
    start: entitlements.subscription.currentPeriodStart,
    end: entitlements.subscription.currentPeriodEnd,
  };
}

/** The window a statement read is narrowed to. Both ends inclusive, either end optional. */
export type StatementWindow = {
  from: Date | null;
  to: Date | null;
  page: number;
};

export type BillingStatements = {
  planUsage(externalCustomerId?: string): Promise<BillingPlanUsage>;
  invoices(
    window: StatementWindow,
    scope?: PaymentOrderReadScope,
  ): Promise<BillingInvoicePage>;
  invoice(
    id: string,
    scope?: PaymentOrderReadScope,
  ): Promise<BillingInvoiceDetail | null>;
};

/**
 * The anomaly-event read the payment record's 异常进度 hangs on: the payment store's own
 * `listAnomalyEvents`, nothing wider. A seam type rather than the whole store so the statements
 * factory (and the company books below) can be doubled without dragging the money writes along.
 */
export type PaymentEventReader = {
  listAnomalyEvents(
    orderIds: readonly string[],
  ): Promise<readonly PaymentOrderEventRecord[]>;
};

/**
 * The anomaly progress of a set of orders, grouped per order id (BP07/#375): one batched read
 * through the seam, oldest first inside each order. Exported because the company books' payment
 * records answer through the same grouping — one progress shape wherever a reader meets a
 * payment record.
 */
export async function anomalyProgressOf(
  events: PaymentEventReader,
  orderIds: readonly string[],
): Promise<Map<string, readonly BillingPaymentAnomaly[]>> {
  const grouped = new Map<string, BillingPaymentAnomaly[]>();
  if (orderIds.length === 0) return grouped;
  for (const event of await events.listAnomalyEvents(orderIds)) {
    const list = grouped.get(event.orderId) ?? [];
    list.push(anomalyOf(event));
    grouped.set(event.orderId, list);
  }
  return grouped;
}

/**
 * A `units` string decimal to a whole number.
 *
 * The provider sends `"1234.0"`; the page draws a bar. Anything unparseable is zero rather than
 * `NaN`, because a bar drawn at NaN is a bar drawn at nothing and a reader cannot tell that apart
 * from a bar drawn at zero — and zero is the honest one of the two.
 */
function wholeUnits(units: string): number {
  const value = Number(units);
  return Number.isFinite(value) ? value : 0;
}

export function createBillingStatements(deps: {
  service: BillingService;
  quotas: QuotaConfig;
  /** Absent on a deployment that configured no payment channels: no bills, no error. */
  orders?: PaymentStore;
  /**
   * The anomaly events behind each payment record (BP07/#375). Absent reads as "no anomalies
   * recorded" — the same honest-empty discipline as an absent orders store, never an error: a
   * projection that cannot read events still answers the money facts it holds.
   */
  events?: PaymentEventReader;
}): BillingStatements {
  const { service, quotas, orders } = deps;
  /*
   * The event reader behind the record's 异常进度: the seam when a deployment hands one over,
   * and otherwise the ORDERS STORE ITSELF — the store's interface carries `listAnomalyEvents`
   * beside its window reads (they are one table family), so the production wiring that already
   * passes the payment store as `orders` needs no second wire to answer anomaly progress.
   */
  const events = deps.events ?? orders;

  /*
   * The anomalies of a page of orders, grouped per order: one call for the whole page (the
   * store's read takes the ids in one query). An absent event reader reads as "no anomalies
   * recorded" — the same honest-empty discipline as an absent orders store.
   */
  async function anomaliesByOrderId(
    rows: readonly PaymentOrderRecord[],
  ): Promise<Map<string, readonly BillingPaymentAnomaly[]>> {
    if (!events) return new Map();
    return anomalyProgressOf(
      events,
      rows.map((row) => row.id),
    );
  }

  return {
    async planUsage(externalCustomerId) {
      const [entitlements, usage] = await Promise.all([
        service.entitlements(externalCustomerId),
        service.usage(externalCustomerId),
      ]);
      if (!entitlements.active || usage === null) {
        return {
          active: false,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          resetsAt: null,
          quotas: [],
        };
      }

      const subscription = providerPeriodOf(entitlements);
      const ceilings =
        entitlements.planCode === undefined
          ? []
          : (quotas.get(entitlements.planCode) ?? []);

      /*
       * The configured ceilings lead, because they are the ones a person can act on: they are the
       * rows with a bar and a remainder. A metric this deployment measures but never configured a
       * ceiling for still appears — dropped, it would look like the meter is off, when the truth is
       * that it is running and uncapped. `limit: null` says exactly that.
       */
      const byCode = new Map(
        ceilings.map((entry) => [entry.metricCode, entry]),
      );
      const rows: BillingQuotaEntry[] = [];
      for (const [metricCode, ceiling] of byCode) {
        const charge = usage.charges.find((c) => c.metricCode === metricCode);
        const used = charge ? wholeUnits(charge.units) : 0;
        rows.push({
          ...ceiling,
          used,
          remaining: Math.max(
            ceiling.limit === null ? 0 : ceiling.limit - used,
            0,
          ),
          usedCents: charge?.amountCents ?? 0,
        });
      }
      for (const charge of usage.charges) {
        if (byCode.has(charge.metricCode)) continue;
        const used = wholeUnits(charge.units);
        rows.push({
          metricCode: charge.metricCode,
          metricName: charge.metricName,
          unit: charge.metricCode,
          used,
          limit: null,
          remaining: null,
          usedCents: charge.amountCents,
        });
      }

      return {
        active: true,
        ...(entitlements.planCode !== undefined
          ? { planCode: entitlements.planCode }
          : {}),
        ...(entitlements.subscription
          ? { status: entitlements.subscription.status }
          : {}),
        ...(usage.currency !== undefined ? { currency: usage.currency } : {}),
        currentPeriodStart: subscription?.start ?? null,
        currentPeriodEnd: subscription?.end ?? null,
        resetsAt: subscription?.end ?? null,
        ...(usage.totalAmountCents !== undefined
          ? { totalCents: usage.totalAmountCents }
          : {}),
        quotas: rows,
      };
    },

    async invoices(window, scope) {
      const empty: BillingInvoicePage = {
        invoices: [],
        pagination: {
          totalCount: 0,
          totalPages: 0,
          currentPage: window.page,
          nextPage: null,
        },
      };
      if (!orders) return empty;

      const totalCount = await orders.countOrdersInWindow({
        from: window.from,
        to: window.to,
        scope,
      });
      const rows = await orders.listOrdersInWindow({
        from: window.from,
        to: window.to,
        limit: INVOICE_PAGE_SIZE,
        offset: (window.page - 1) * INVOICE_PAGE_SIZE,
        scope,
      });
      // One batched anomaly read for the whole page: a payment record without its 异常进度 is a
      // list read that stopped halfway, and a per-row read is a page that pays twenty queries.
      const anomalies = await anomaliesByOrderId(rows);
      /*
       * The page count answers 1, not 0, for an empty window. A pager reading "第 1 / 0 页" is a
       * pager that has lost its place; "第 1 / 1 页 · 共 0 条" is a pager sitting on an empty page,
       * which is what a filter that matched nothing means.
       */
      const totalPages = Math.max(Math.ceil(totalCount / INVOICE_PAGE_SIZE), 1);
      return {
        invoices: rows.map((order) =>
          paymentRecordOf(order, anomalies.get(order.id) ?? []),
        ),
        pagination: {
          totalCount,
          totalPages,
          currentPage: window.page,
          nextPage:
            window.page * INVOICE_PAGE_SIZE < totalCount
              ? window.page + 1
              : null,
        },
      };
    },

    async invoice(id, scope) {
      if (!orders) return null;
      const order = await orders.readOrder(id, scope);
      if (!order) return null;
      const anomalies = await anomaliesByOrderId([order]);
      const invoice = paymentRecordOf(order, anomalies.get(order.id) ?? []);
      return {
        ...invoice,
        /*
         * One line, because v1 sells one thing at a time: a plan for the period the order bought.
         * Written out rather than left to the client so the download and the detail can never
         * disagree about what a bill is made of.
         */
        lines: [
          {
            label: order.planCode,
            quantity: 1,
            amountCents: order.amountCents,
          },
        ],
      };
    },
  };
}

/**
 * One stored order as a payment record, from its own snapshotted period and paid timestamp —
 * plus, since BP07/#375, the delivery progress and anomaly events the record's reader is owed:
 * the states are independent on purpose (spec: 收款状态与交付状态独立), so a paid order that has
 * not delivered says so instead of dressing up as complete.
 *
 * Exported because the record is ONE shape wherever a reader meets it: the personal bill list
 * and the company books' payment records answer through this same projection, so the two
 * surfaces can never disagree about what a payment record is (the unified-display decision
 * #375 made instead of a second accounting face).
 */
export function paymentRecordOf(
  order: PaymentOrderRecord,
  anomalies: readonly BillingPaymentAnomaly[] = [],
): BillingInvoice {
  const fulfillmentState = fulfillmentStateOfOrder(order);
  return {
    invoiceId: order.id,
    planCode: order.planCode,
    periodStart: order.periodStart?.toISOString() ?? null,
    periodEnd: order.periodEnd?.toISOString() ?? null,
    amountCents: order.amountCents,
    currency: order.currency,
    status: order.status,
    method: order.provider,
    issuedAt: order.createdAt.toISOString(),
    settledAt: order.paidAt?.toISOString() ?? null,
    channelTransactionId: order.channelTransactionId,
    // The payer label the record carries: the owner ref's own kind, and only a displayable one —
    // the scope this row reached already matched the owner exactly, so kind is the owner's word.
    payerKind: order.ownerPayerRef?.kind === "company" ? "company" : "personal",
    fulfillment:
      fulfillmentState === null
        ? null
        : {
            state: fulfillmentState,
            // The retained failure facts (BP03): why the last pass did not land and when the
            // next one runs — quoted from the row, never guessed from the state alone.
            failureReason: order.activationFailureReason ?? null,
            nextRetryAt: order.activationNextRetryAt?.toISOString() ?? null,
          },
    anomalies,
  };
}

/** One anomaly event row as the record's progress answers it: the writer's words, verbatim. */
function anomalyOf(event: PaymentOrderEventRecord): BillingPaymentAnomaly {
  return {
    code: event.code,
    detail: event.detail,
    channelTransactionId: event.channelTransactionId,
    amountCents: event.amountCents,
    occurredAt: event.createdAt.toISOString(),
  };
}
