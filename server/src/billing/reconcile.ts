import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { billingSubscriptions } from "../db/schema/billing";
import { creditGrants, creditLedger } from "../db/schema/credits";
import { paymentEvents, paymentOrders } from "../db/schema/payment";
import type { ReconcileFinding, ReconcileReport } from "./types";

/**
 * The reconciliation skeleton (T7): a READ-ONLY pass that answers "do the books agree" in one
 * structured report. It never repairs, never writes a money row, never calls a mutating
 * provider endpoint — reconciliation that fixes what it finds is how a second bug erases the
 * first one's evidence. Its output is a list of findings, each naming its category, the row it
 * is about, and a human sentence; an empty list is the books agreeing.
 *
 * THE INVARIANTS UNDER AUDIT
 *
 * 1. Payment three-way agreement, per paid order:
 *    payment_orders(status='paid') ↔ payment_events(kind='fact', state='paid')
 *    ↔ the Lago subscription projection (billing_subscriptions, live).
 *    Every settled order must carry its paid fact (the confirm transaction writes both, and
 *    only a half-committed past or manual surgery breaks the pair); the fact's channel
 *    transaction must be the one the order names (a swapped id is double-payment evidence);
 *    and every order whose activation APPLIED must have a live subscription row in the
 *    projection (an applied order with no live row means entitlement was granted and then the
 *    projection lost it — the exact drift a person experiences as "paid but shown as free").
 *
 * 2. The credit identity, per customer:
 *
 *        Σ credit_grants.used  ==  Σ credit_ledger.applied
 *
 *    Both sides are the same coin seen from its two tables: `used` is what the grants were
 *    drawn for, `applied` is what the draws recorded absorbing. consumeCredits moves them in
 *    ONE transaction, so a live system cannot split them — but a crashed migration, a manual
 *    `UPDATE`, or a future writer that forgets the pair can. The grants' CHECK(used <= total)
 *    is the RUNTIME fence (an overdraw can never commit); this identity is the AFTER-THE-FACT
 *    audit fence (what did commit still has to add up). Expiry plays no part: `used` is
 *    cumulative history, and so is `applied`.
 *
 * The findings vocabulary is fixed here so a report is greppable and a dashboard can group it.
 */

/**
 * The reconciler over the real tables. Takes the `database` (the three schemas live in one
 * Postgres) and the deployment's customer key, and returns the pass — no other state, so any
 * moment may re-run it and get the books' current answer. The report's vocabulary (findings'
 * codes) lives in ./types.ts with the rest of the seam's words.
 *
 * The customer key scopes the Lago-projection side of the three-way (payment_orders carries
 * no customer column — v1's orders ARE this deployment's): the "live subscription" ask is the
 * same shape and the same key the purchase guard's uncached read uses, so the audit and the
 * gate can never disagree about what "live" means.
 */
export function createReconciler(
  database: Database,
  externalCustomerKey: string,
): {
  reconcile(): Promise<ReconcileReport>;
} {
  return {
    async reconcile() {
      const findings: ReconcileFinding[] = [];

      /*
       * ── Invariant 1, sides one and two: paid orders ↔ their paid facts. One query each
       *    (the whole-table shape is the point — a reconciliation that sampled would be an
       *    estimate wearing an audit's clothes) and the join in memory, where the mismatch's
       *    shape decides the finding's code.
       */
      const paidOrders = await database
        .select({
          id: paymentOrders.id,
          channelTransactionId: paymentOrders.channelTransactionId,
          activationState: paymentOrders.activationState,
        })
        .from(paymentOrders)
        .where(eq(paymentOrders.status, "paid"));
      const paidFacts = await database
        .select({
          orderId: paymentEvents.orderId,
          channelTransactionId: paymentEvents.channelTransactionId,
        })
        .from(paymentEvents)
        .where(
          and(
            eq(paymentEvents.kind, "fact"),
            eq(paymentEvents.state, "paid"),
          ),
        );
      const factByOrder = new Map(
        paidFacts.map((fact) => [fact.orderId, fact]),
      );

      for (const order of paidOrders) {
        const fact = factByOrder.get(order.id);
        if (!fact) {
          findings.push({
            category: "payment",
            code: "paid_without_fact",
            subject: order.id,
            detail:
              "the order is settled paid but carries no paid fact row — the confirm pair was broken (half-committed write or manual surgery)",
          });
          continue;
        }
        // The fact's transaction must be the one the order names; either side may hold null
        // (the order's fallback is its own id, the fact's is the delivery's), so the check is
        // equality-when-both-named.
        if (
          order.channelTransactionId !== null &&
          fact.channelTransactionId !== null &&
          order.channelTransactionId !== fact.channelTransactionId
        ) {
          findings.push({
            category: "payment",
            code: "fact_transaction_mismatch",
            subject: order.id,
            detail: `the order names transaction ${order.channelTransactionId} but its paid fact names ${fact.channelTransactionId} — double-payment evidence, needs an operator`,
          });
        }
      }

      /*
       * ── Invariant 1, side three: applied orders ↔ a live subscription in the Lago
       *    projection. The projection is local (billing_subscriptions), written by the sync
       *    and the webhooks — reading the provider live here would make reconciliation depend
       *    on the thing it audits. One live row per customer is the deployment's shape (v1:
       *    one subscription at a time), so "has a live row" is a set membership per customer
       *    key.
       */
      const liveSubscriptions = await database
        .select({ externalCustomerId: billingSubscriptions.externalCustomerId })
        .from(billingSubscriptions)
        // "Live" matches the guard's own definition (active/incomplete): a canceled or
        // expired row is not the entitlement an applied order bought. Scoped to THIS
        // deployment's customer — the key the guard's uncached read uses, so the audit and
        // the gate cannot disagree about what "live" means.
        .where(
          and(
            eq(billingSubscriptions.externalCustomerId, externalCustomerKey),
            sql`${billingSubscriptions.status} IN ('active', 'incomplete')`,
          ),
        );
      const appliedOrders = paidOrders.filter(
        (order) => order.activationState === "applied",
      );
      /*
       * v1's single-customer membership: payment_orders carries no customer column (one
       * deployment, one customer key — the orders ARE that customer's), so the projection
       * ask is scoped to the reconciler's key above. No live row for THIS customer while
       * applied orders exist is the drift this finding names, reported once per applied
       * order so the report can be worked row by row.
       */
      if (appliedOrders.length > 0 && liveSubscriptions.length === 0) {
        for (const order of appliedOrders) {
          findings.push({
            category: "payment",
            code: "applied_without_subscription",
            subject: order.id,
            detail:
              "the order's activation is applied but the projection holds no live subscription — entitlement was granted and then lost; the person is paid-up but shown as free",
          });
        }
      }

      /*
       * ── Invariant 2: the credit identity, per customer. Both sums come from SQL (one
       *    round trip each, exact integers — the report must not introduce its own rounding
       *    while auditing someone else's), grouped by the customer key.
       */
      const usedByCustomer = await database
        .select({
          customer: creditGrants.externalCustomerId,
          total: sql<number>`COALESCE(SUM(${creditGrants.used}), 0)::bigint`,
        })
        .from(creditGrants)
        .groupBy(creditGrants.externalCustomerId);
      const appliedByCustomer = await database
        .select({
          customer: creditLedger.externalCustomerId,
          total: sql<number>`COALESCE(SUM(${creditLedger.applied}), 0)::bigint`,
        })
        .from(creditLedger)
        .groupBy(creditLedger.externalCustomerId);

      const usedMap = new Map(
        usedByCustomer.map((row) => [row.customer, Number(row.total)]),
      );
      const appliedMap = new Map(
        appliedByCustomer.map((row) => [row.customer, Number(row.total)]),
      );
      const customers = new Set([
        ...usedMap.keys(),
        ...appliedMap.keys(),
      ]);
      for (const customer of customers) {
        const used = usedMap.get(customer) ?? 0;
        const applied = appliedMap.get(customer) ?? 0;
        if (used !== applied) {
          findings.push({
            category: "credits",
            code: "grants_ledger_divergence",
            subject: customer,
            detail: `Σ grants.used = ${used} but Σ ledger.applied = ${applied} (off by ${applied - used}) — the two tables of one coin disagree; a crashed migration or manual write is the usual suspect`,
          });
        }
      }

      return {
        ranAt: new Date().toISOString(),
        checked: {
          paidOrders: paidOrders.length,
          appliedOrders: appliedOrders.length,
          creditCustomers: customers.size,
        },
        findings,
      };
    },
  };
}
