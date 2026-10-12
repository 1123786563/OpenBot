import type { PaymentOrderRecord, PaymentStore } from "./payments/types";
import type {
  BillingEntitlements,
  BillingInvoice,
  BillingInvoiceDetail,
  BillingInvoicePage,
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
  invoices(window: StatementWindow): Promise<BillingInvoicePage>;
  invoice(id: string): Promise<BillingInvoiceDetail | null>;
};

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
}): BillingStatements {
  const { service, quotas, orders } = deps;

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
      const byCode = new Map(ceilings.map((entry) => [entry.metricCode, entry]));
      const rows: BillingQuotaEntry[] = [];
      for (const [metricCode, ceiling] of byCode) {
        const charge = usage.charges.find((c) => c.metricCode === metricCode);
        const used = charge ? wholeUnits(charge.units) : 0;
        rows.push({
          ...ceiling,
          used,
          remaining: Math.max(ceiling.limit === null ? 0 : ceiling.limit - used, 0),
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
        ...(entitlements.subscription ? { status: entitlements.subscription.status } : {}),
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

    async invoices(window) {
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
      });
      const rows = await orders.listOrdersInWindow({
        from: window.from,
        to: window.to,
        limit: INVOICE_PAGE_SIZE,
        offset: (window.page - 1) * INVOICE_PAGE_SIZE,
      });
      /*
       * The page count answers 1, not 0, for an empty window. A pager reading "第 1 / 0 页" is a
       * pager that has lost its place; "第 1 / 1 页 · 共 0 条" is a pager sitting on an empty page,
       * which is what a filter that matched nothing means.
       */
      const totalPages = Math.max(Math.ceil(totalCount / INVOICE_PAGE_SIZE), 1);
      return {
        invoices: rows.map((order) => invoiceOf(order)),
        pagination: {
          totalCount,
          totalPages,
          currentPage: window.page,
          nextPage:
            window.page * INVOICE_PAGE_SIZE < totalCount ? window.page + 1 : null,
        },
      };
    },

    async invoice(id) {
      if (!orders) return null;
      const order = await orders.readOrder(id);
      if (!order) return null;
      const invoice = invoiceOf(order);
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

/** One stored order as a bill, from its own snapshotted period and paid timestamp. */
function invoiceOf(order: PaymentOrderRecord): BillingInvoice {
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
  };
}
