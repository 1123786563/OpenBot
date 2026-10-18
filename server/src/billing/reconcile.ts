import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { billingSubscriptions } from "../db/schema/billing";
import {
  creditReservationAllocations,
  creditReservations,
} from "../db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../db/schema/credits";
import { paymentEvents, paymentOrders } from "../db/schema/payment";
import { payerKey, type PayerKind } from "./payer";
import type { PaymentOrderRecord } from "./payments/types";
import type { ReconcileFinding, ReconcileReport } from "./types";
import { USAGE_IDEMPOTENCY_KEY_PREFIX } from "./types";

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
 *    projection ATTRIBUTED TO THE ORDER'S OWN ACCOUNT (10.3, AC14): an applied order whose
 *    owner pair holds no live row means its entitlement was granted and then lost or taken
 *    over by another account's row — the exact drift a person experiences as "paid but shown
 *    as free". An order whose paid period has already ended is history, not drift (a later
 *    repurchase legitimately re-stamps the one subscription row to the new owner); orders
 *    written before ownership existed are matched the old deployment-wide way (Q23 forbids
 *    guessing their owner).
 *
 * 2. The credit identity, per customer:
 *
 *        Σ credit_grants.used  ==  Σ credit_ledger.applied
 *
 *    Both sides are the same coin seen from its two tables: `used` is what the grants were
 *    drawn for, `applied` is what the draws recorded absorbing. settleReservation moves them in
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
 *
 * `expectedPlanCredits`, when the assembly provides it, prices a plan code in scaled integer
 * credit units (whole credits × CREDIT_SCALE — the same arithmetic the payout's grantor uses),
 * answering `null` for plans with no credit component. Against it the pass audits the plan
 * allowance payout: every paid order must carry a grant keyed `plan:<orderId>` of exactly the
 * priced amount, and no paid order may sit with its activation pending or failed past the
 * documented age threshold (the sweep retries on a one-minute interval, so 15 minutes without
 * settlement means the retries are not converging — a young retry is not an incident).
 */
export type ExpectedPlanCredits = (planCode: string) => number | null;

/**
 * How many rows each keyset page of the four table walks reads (audit C3). The whole-table
 * shape is the point — a reconciliation that sampled would be an estimate wearing an audit's
 * clothes — so the walks read EVERY row, one bounded page at a time: a long-lived deployment
 * must be able to audit years of orders without the pass loading years of orders into one
 * statement's result. The size lands in the report as `checked.scanned.pageSize`, so a reader
 * can tell a complete scan from a truncated one.
 */
const RECONCILE_PAGE_SIZE = 500;

/**
 * The four walks' row shapes, named here so the keyset loops stay readable (the page's inferred
 * drizzle type would be an `Awaited<ReturnType<...>>` mouthful on every accumulator).
 */
type PaidOrderRow = {
  id: string;
  planCode: string;
  amountCents: number;
  channelTransactionId: string | null;
  activationState: PaymentOrderRecord["activationState"];
  paidAt: Date | null;
  terminalAt: Date | null;
  /** The account the order belongs to (10.3); null for rows written before ownership existed. */
  ownerPayerKind: PayerKind | null;
  ownerPayerId: string | null;
  /** The paid window's end: an order inside it is "paid-up", and its account must show it. */
  periodEnd: Date | null;
};
type PaidFactRow = {
  id: string;
  orderId: string;
  channelTransactionId: string | null;
  amountCents: number | null;
};
type DuplicateAnomalyRow = {
  id: string;
  orderId: string;
  amountCents: number | null;
  detail: string;
};
type ReservedRow = {
  reservationId: string;
  idempotencyKey: string;
  expiresAt: Date;
  maximum: number;
  expired: boolean;
  allocationId: string | null;
  allocationAmount: number | null;
};

export function createReconciler(
  database: Database,
  externalCustomerKey: string,
  expectedPlanCredits?: ExpectedPlanCredits,
  options?: {
    usageFindingLimit?: number;
    activationBacklogAgeMs?: number;
  },
): {
  reconcile(): Promise<ReconcileReport>;
} {
  const usageFindingLimit = options?.usageFindingLimit ?? 100;
  // The activation sweep runs every minute; fifteen missed passes without a settlement means
  // the retry is not converging (provider down, plan refused), not a callback still in flight.
  const activationBacklogAgeMs = options?.activationBacklogAgeMs ?? 15 * 60_000;
  const allocationSampleLimit = 3;
  if (!Number.isSafeInteger(usageFindingLimit) || usageFindingLimit <= 0) {
    throw new RangeError("Usage finding limit must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(activationBacklogAgeMs) ||
    activationBacklogAgeMs <= 0
  ) {
    throw new RangeError(
      "Activation backlog age must be a positive safe integer",
    );
  }

  function usageFailureCode(code: string | null): string {
    return code ?? "none";
  }

  function usageAgeSeconds(now: number, updatedAt: Date): number {
    return Math.max(0, Math.floor((now - updatedAt.getTime()) / 1000));
  }

  function sumUsageTargets(targets: {
    pending: { lago: number; credits: number };
    blocked: { lago: number; credits: number };
  }) {
    return (
      targets.pending.lago +
      targets.pending.credits +
      targets.blocked.lago +
      targets.blocked.credits
    );
  }

  return {
    async reconcile() {
      const findings: ReconcileFinding[] = [];
      const usageDeliveryTargets = {
        pending: { lago: 0, credits: 0 },
        blocked: { lago: 0, credits: 0 },
      };

      /*
       * ── Invariant 1, sides one and two: paid orders ↔ their paid facts. One walk each,
       *    every row, one bounded page at a time (audit C3 — the whole-table shape is the
       *    point, a reconciliation that sampled would be an estimate wearing an audit's
       *    clothes; the pages only bound the statement, never the scope) and the join in
       *    memory, where the mismatch's shape decides the finding's code.
       */
      const paidOrders: PaidOrderRow[] = [];
      for (;;) {
        const lastId = paidOrders.at(-1)?.id ?? "";
        const page = await database
          .select({
            id: paymentOrders.id,
            planCode: paymentOrders.planCode,
            amountCents: paymentOrders.amountCents,
            channelTransactionId: paymentOrders.channelTransactionId,
            activationState: paymentOrders.activationState,
            paidAt: paymentOrders.paidAt,
            terminalAt: paymentOrders.terminalAt,
            ownerPayerKind: paymentOrders.ownerPayerKind,
            ownerPayerId: paymentOrders.ownerPayerId,
            periodEnd: paymentOrders.periodEnd,
          })
          .from(paymentOrders)
          .where(
            and(
              eq(paymentOrders.status, "paid"),
              sql`${paymentOrders.id} > ${lastId}`,
            ),
          )
          .orderBy(asc(paymentOrders.id))
          .limit(RECONCILE_PAGE_SIZE);
        paidOrders.push(...page);
        if (page.length < RECONCILE_PAGE_SIZE) break;
      }
      const paidFacts: PaidFactRow[] = [];
      for (;;) {
        const lastId = paidFacts.at(-1)?.id ?? "";
        const page = await database
          .select({
            id: paymentEvents.id,
            orderId: paymentEvents.orderId,
            channelTransactionId: paymentEvents.channelTransactionId,
            amountCents: paymentEvents.amountCents,
          })
          .from(paymentEvents)
          .where(
            and(
              eq(paymentEvents.kind, "fact"),
              eq(paymentEvents.state, "paid"),
              sql`${paymentEvents.id} > ${lastId}`,
            ),
          )
          .orderBy(asc(paymentEvents.id))
          .limit(RECONCILE_PAGE_SIZE);
        paidFacts.push(...page);
        if (page.length < RECONCILE_PAGE_SIZE) break;
      }
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
        // The fact's amount is the channel's word on what landed; the order's amount_cents is
        // the catalog price snapshotted at order time. A fact may carry no amount (an
        // unreadable callback settles after an exhaustion threshold instead) — nothing to
        // compare then; but a READ amount that disagrees with the snapshot is drift the
        // callback handler deliberately never reconciles silently.
        if (
          fact.amountCents !== null &&
          fact.amountCents !== order.amountCents
        ) {
          findings.push({
            category: "payment",
            code: "fact_amount_mismatch",
            subject: order.id,
            detail: `the paid fact records order=${order.amountCents} fact=${fact.amountCents} — the channel settled a different sum than the order snapshot; keep both facts, needs an operator (the order's currency is database-enforced CNY; the channel's stated currency is compared at settlement and a disagreement is recorded as a \`currency_mismatch\` anomaly)`,
          });
        }
      }

      /*
       * ── Invariant 1, side four: the plan allowance payout. A paid order whose plan prices
       *    an allowance must carry exactly one grant keyed `plan:<orderId>` of exactly the
       *    priced amount, in scaled integer units. The grant's insert-or-nothing key makes a
       *    retried payout safe at write time; this is the after-the-fact audit that the
       *    payout landed at all and for the right sum. Plans the catalog prices at null (or
       *    zero) grant nothing by configuration — nothing to check.
       */
      if (expectedPlanCredits) {
        const planGrants = await database
          .select({
            idempotencyKey: creditGrants.idempotencyKey,
            total: creditGrants.total,
            externalCustomerId: creditGrants.externalCustomerId,
          })
          .from(creditGrants)
          .where(eq(creditGrants.source, "plan"));
        const planGrantByKey = new Map(
          planGrants.map((grant) => [grant.idempotencyKey, grant]),
        );
        for (const order of paidOrders) {
          const expected = expectedPlanCredits(order.planCode);
          if (expected === null || expected <= 0) continue;
          const key = `plan:${order.id}`;
          const grant = planGrantByKey.get(key);
          if (!grant) {
            findings.push({
              category: "payment",
              code: "plan_grant_missing",
              subject: order.id,
              detail: `the order is paid but no plan grant carries idempotency_key=${key} — the allowance payout never landed; expected=${expected} scaled units`,
            });
            continue;
          }
          // The payout's ACCOUNT is part of the invariant (10.3, AC14): the grant belongs in
          // the order owner's account, and a grant sitting in a stranger's account is drift
          // no aggregate can hide. Ownerless orders carry no account to compare against (Q23).
          if (order.ownerPayerKind && order.ownerPayerId) {
            let accountKey: string | null = null;
            try {
              accountKey = payerKey({
                kind: order.ownerPayerKind,
                id: order.ownerPayerId,
              });
            } catch {
              // A quarantined owner resolves to no billable account; the amount check below
              // still applies, the account check cannot.
            }
            if (
              accountKey !== null &&
              grant.externalCustomerId !== accountKey
            ) {
              findings.push({
                category: "payment",
                code: "plan_grant_owner_mismatch",
                subject: order.id,
                detail: `grant ${key} sits in account ${grant.externalCustomerId} but the order's owner resolves to ${accountKey} — the allowance payout landed cross-account; needs an operator`,
              });
            }
          }
          if (grant.total !== expected) {
            findings.push({
              category: "payment",
              code: "plan_grant_amount_mismatch",
              subject: order.id,
              detail: `grant ${key} totals actual=${grant.total} but the catalog prices plan ${order.planCode} at expected=${expected} scaled units — payout drift, needs an operator`,
            });
          }
        }
      }

      /*
       * ── Activation backlog: money that landed but entitlement that never settled. The
       *    sweep re-runs activation every minute, so a paid order still pending/failed once
       *    its paid time is older than the threshold is a retry that is not converging — the
       *    provider unreachable, the plan refused — not a callback in flight. The anchor is
       *    paid_at (terminal_at is the fallback for rows written before that column existed).
       */
      const nowMs = Date.now();
      for (const order of paidOrders) {
        if (
          order.activationState !== "pending" &&
          order.activationState !== "failed"
        ) {
          continue;
        }
        const anchor = order.paidAt ?? order.terminalAt;
        if (!anchor) continue;
        const ageMs = Math.max(0, nowMs - anchor.getTime());
        if (ageMs > activationBacklogAgeMs) {
          findings.push({
            category: "payment",
            code: "activation_backlog",
            subject: order.id,
            detail: `state=${order.activationState} paid_at=${anchor.toISOString()} age_ms=${ageMs} exceeds activation_backlog_age_ms=${activationBacklogAgeMs} — the sweep's retries are not settling this order; a provider outage or a refused plan is the usual suspect`,
          });
        }
      }

      /*
       * ── Duplicate paid collections, in the disposition the design records: keep every
       *    confirmed payment fact, resolve manually, never auto-refund, never pay the
       *    entitlement twice. The callback/activation path records the overlap as a
       *    `duplicate_paid` anomaly at write time (it wins the idempotency race against the
       *    owned order's fact); reconciliation surfaces that evidence row by row. Reading
       *    the anomaly — not counting paid orders per plan — keeps legitimate sequential
       *    repurchases (expire, then buy the same plan again) out of the findings.
       */
      const duplicateAnomalies: DuplicateAnomalyRow[] = [];
      for (;;) {
        const lastId = duplicateAnomalies.at(-1)?.id ?? "";
        const page = await database
          .select({
            id: paymentEvents.id,
            orderId: paymentEvents.orderId,
            amountCents: paymentEvents.amountCents,
            detail: paymentEvents.detail,
          })
          .from(paymentEvents)
          .where(
            and(
              eq(paymentEvents.kind, "anomaly"),
              eq(paymentEvents.code, "duplicate_paid"),
              sql`${paymentEvents.id} > ${lastId}`,
            ),
          )
          .orderBy(asc(paymentEvents.id))
          .limit(RECONCILE_PAGE_SIZE);
        duplicateAnomalies.push(...page);
        if (page.length < RECONCILE_PAGE_SIZE) break;
      }
      for (const anomaly of duplicateAnomalies) {
        findings.push({
          category: "payment",
          code: "duplicate_paid_order",
          subject: anomaly.orderId,
          detail: `a second paid collection overlaps an entitlement this order does not own amount_cents=${anomaly.amountCents ?? "unreadable"} evidence="${anomaly.detail}" remediation=manual_operator_resolution: keep the money, no auto-refund, no second payout`,
        });
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
        .select({
          externalCustomerId: billingSubscriptions.externalCustomerId,
          ownerPayerKind: billingSubscriptions.ownerPayerKind,
          ownerPayerId: billingSubscriptions.ownerPayerId,
        })
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
       * The projection ask is PER OWNER ACCOUNT (10.3, AC14): one account's live row must not
       * mask another account's lost entitlement, so an owned order is satisfied only by a live
 *    row carrying its own owner pair — and only while its paid window is still running (an
 *    expired order is history; a later repurchase legitimately re-stamps the one row to the
 *    new owner). Orders written before ownership existed have no account to compare against
 *    (Q23 forbids guessing one): they keep the deployment-wide membership the check was
 *    born with, reported once per order so the report can be worked row by row.
       */
      const liveOwnerPairs = new Set<string>();
      for (const row of liveSubscriptions) {
        if (row.ownerPayerKind && row.ownerPayerId) {
          liveOwnerPairs.add(`${row.ownerPayerKind}:${row.ownerPayerId}`);
        }
      }
      for (const order of appliedOrders) {
        if (order.ownerPayerKind && order.ownerPayerId) {
          const withinPaidPeriod =
            order.periodEnd !== null && order.periodEnd.getTime() > nowMs;
          if (!withinPaidPeriod) continue;
          if (
            !liveOwnerPairs.has(
              `${order.ownerPayerKind}:${order.ownerPayerId}`,
            )
          ) {
            findings.push({
              category: "payment",
              code: "applied_without_subscription",
              subject: order.id,
              detail: `the order's activation is applied for owner ${order.ownerPayerKind}:${order.ownerPayerId} but the projection holds no live subscription owned by that account — entitlement was granted and then lost or taken over by another account's row; the person is paid-up but shown as free`,
            });
          }
        } else if (liveSubscriptions.length === 0) {
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
       *    while auditing someone else's), grouped by the customer key. The sums are read
       *    as decimal STRINGS and compared as BigInt end to end: the columns are 32-bit, so
       *    a customer's history can sum past Number.MAX_SAFE_INTEGER, and a Number() in the
       *    middle would round two sums a single unit apart into equality (audit F1).
       */
      const usedByCustomer = await database
        .select({
          customer: creditGrants.externalCustomerId,
          total: sql<string>`COALESCE(SUM(${creditGrants.used}), 0)::bigint`,
        })
        .from(creditGrants)
        .groupBy(creditGrants.externalCustomerId);
      const appliedByCustomer = await database
        .select({
          customer: creditLedger.externalCustomerId,
          total: sql<string>`COALESCE(SUM(${creditLedger.applied}), 0)::bigint`,
        })
        .from(creditLedger)
        .groupBy(creditLedger.externalCustomerId);

      const usedMap = new Map(
        usedByCustomer.map((row) => [row.customer, BigInt(row.total)]),
      );
      const appliedMap = new Map(
        appliedByCustomer.map((row) => [row.customer, BigInt(row.total)]),
      );
      const customers = new Set([...usedMap.keys(), ...appliedMap.keys()]);
      for (const customer of customers) {
        const used = usedMap.get(customer) ?? 0n;
        const applied = appliedMap.get(customer) ?? 0n;
        if (used !== applied) {
          findings.push({
            category: "credits",
            code: "grants_ledger_divergence",
            subject: customer,
            detail: `Σ grants.used = ${used} but Σ ledger.applied = ${applied} (off by ${applied - used}) — the two tables of one coin disagree; a crashed migration or manual write is the usual suspect`,
          });
        }
      }

      /*
       * The shortfall the ledger already records per row (`credits - applied`): what the grants
       * could not fund. Exact decimal strings and BigInt, the same discipline as the identity sums
       * above — an overdraw total is a money figure and must not be rounded on the way into a
       * report that audits somebody else's arithmetic (audit D1).
       */
      const overdrawByCustomer = await database
        .select({
          customer: creditLedger.externalCustomerId,
          entries: sql<string>`COUNT(*)::bigint`,
          units: sql<string>`COALESCE(SUM(${creditLedger.credits} - ${creditLedger.applied}), 0)::bigint`,
        })
        .from(creditLedger)
        .where(sql`${creditLedger.credits} > ${creditLedger.applied}`)
        .groupBy(creditLedger.externalCustomerId);

      let overdrawEntries = 0n;
      let overdrawUnits = 0n;
      for (const row of overdrawByCustomer) {
        const entries = BigInt(row.entries);
        const units = BigInt(row.units);
        overdrawEntries += entries;
        overdrawUnits += units;
        findings.push({
          category: "credits",
          code: "credit_overdraw",
          subject: row.customer,
          detail: `entries=${entries} units=${units} — consumption the grants could not fund; the ledger recorded the full cost and applied what the balance allowed. Remediation is an operator decision (grant, invoice, or accept)`,
        });
      }
      // The total's entry count: a count of rows, not money, so it stays a number for the admin
      // route's shape — but guarded the way the usage-outbox counts are, because it too was read
      // as a ::bigint string: a total the report cannot represent exactly, it refuses.
      const overdrawEntryCount = Number(overdrawEntries);
      if (!Number.isSafeInteger(overdrawEntryCount)) {
        throw new RangeError(
          `credit_ledger overdraw entry count is not a safe integer (${overdrawEntries}); the report refuses to round a backlog it cannot represent`,
        );
      }

      /*
       * ── Hard-cap reservation evidence: active holds are intentionally OUTSIDE the
       *    grants.used ↔ ledger.applied identity until a settlement converts them into a
       *    ledger fact, so reconciliation inspects reserved rows on their own terms.
       *    Nothing is auto-released here: an expired hold is recovery evidence only, and an
       *    allocation sum that no longer equals the reservation's maximum is manual-surgery
       *    drift that needs an operator, not a writer hidden inside the audit.
       */
      /*
       * The join is walked with a keyset over its full (reservationId, allocationId) order —
       * not over the reservation id alone — so a reservation split across a page boundary
       * keeps its tail allocations: the grouping below accumulates in memory across pages, and
       * a lost tail would fabricate an allocation-imbalance finding. The empty-string cursor
       * after a null allocation (a reservation with no allocations) sorts before every id,
       * which is exactly "nothing more for this reservation".
       */
      const reservedRows: ReservedRow[] = [];
      let lastReservationId = "";
      let lastAllocationId = "";
      for (;;) {
        const page = await database
          .select({
            reservationId: creditReservations.id,
            idempotencyKey: creditReservations.idempotencyKey,
            expiresAt: creditReservations.expiresAt,
            maximum: creditReservations.maximum,
            expired: sql<boolean>`${creditReservations.expiresAt} <= now()`,
            allocationId: creditReservationAllocations.id,
            allocationAmount: creditReservationAllocations.amount,
          })
          .from(creditReservations)
          .leftJoin(
            creditReservationAllocations,
            eq(
              creditReservationAllocations.reservationId,
              creditReservations.id,
            ),
          )
          .where(
            and(
              eq(creditReservations.status, "reserved"),
              sql`(${creditReservations.id} > ${lastReservationId}
                   or (${creditReservations.id} = ${lastReservationId}
                       and ${creditReservationAllocations.id} > ${lastAllocationId}))`,
            ),
          )
          .orderBy(
            asc(creditReservations.id),
            asc(creditReservationAllocations.id),
          )
          .limit(RECONCILE_PAGE_SIZE);
        if (page.length === 0) break;
        reservedRows.push(...page);
        const last = page[page.length - 1];
        lastReservationId = last.reservationId;
        lastAllocationId = last.allocationId ?? "";
        if (page.length < RECONCILE_PAGE_SIZE) break;
      }

      const reservedById = new Map<
        string,
        {
          idempotencyKey: string;
          expiresAt: Date;
          maximum: number;
          expired: boolean;
          allocated: number;
          allocationIds: string[];
        }
      >();
      for (const row of reservedRows) {
        const entry = reservedById.get(row.reservationId) ?? {
          idempotencyKey: row.idempotencyKey,
          expiresAt: row.expiresAt,
          maximum: row.maximum,
          expired: row.expired,
          allocated: 0,
          allocationIds: [],
        };
        if (row.allocationId !== null) {
          entry.allocated += row.allocationAmount ?? 0;
          entry.allocationIds.push(row.allocationId);
        }
        reservedById.set(row.reservationId, entry);
      }
      for (const [reservationId, reservation] of reservedById) {
        const allocationIdsSample =
          reservation.allocationIds.length > 0
            ? reservation.allocationIds
                .slice(0, allocationSampleLimit)
                .join(",")
            : "none";
        const allocationIdsTruncated =
          reservation.allocationIds.length > allocationSampleLimit
            ? "yes"
            : "no";
        const allocationMetadata = `allocation_count=${reservation.allocationIds.length} allocation_ids_sample=${allocationIdsSample} allocation_ids_truncated=${allocationIdsTruncated}`;
        if (reservation.expired) {
          /*
           * The hold is named by BOTH ids it can prove: its own reservation id, and — when the
           * idempotency key is the usage seam's `usage:<eventId>` — the usage event whose
           * durable fact may never have committed (a failed finish write leaves exactly this
           * shape, with no outbox row to read). The detail records reservation facts and age
           * only: usage that was never durably recorded cannot be claimed here.
           */
          const expiredAgeMs = Math.max(
            0,
            nowMs - reservation.expiresAt.getTime(),
          );
          const usageEventId = reservation.idempotencyKey.startsWith(
            USAGE_IDEMPOTENCY_KEY_PREFIX,
          )
            ? reservation.idempotencyKey.slice(
                USAGE_IDEMPOTENCY_KEY_PREFIX.length,
              )
            : null;
          findings.push({
            category: "credits",
            code: "expired_reserved_reservation",
            subject: reservationId,
            detail:
              `state=reserved expires_at=${reservation.expiresAt.toISOString()} expired_age_ms=${expiredAgeMs} ` +
              `idempotency_key=${reservation.idempotencyKey}` +
              (usageEventId ? ` usage_event_id=${usageEventId}` : "") +
              ` maximum=${reservation.maximum} allocated=${reservation.allocated} ${allocationMetadata} remediation=operator_recovery_required`,
          });
        }

        if (reservation.allocated !== reservation.maximum) {
          findings.push({
            category: "credits",
            code: "reservation_allocation_imbalance",
            subject: reservationId,
            detail: `maximum=${reservation.maximum} allocated=${reservation.allocated} delta=${reservation.allocated - reservation.maximum} ${allocationMetadata} remediation=operator_recovery_required`,
          });
        }
      }

      /*
       * ── Usage delivery backlog evidence: the outbox is the durable truth of what was
       *    attempted, what is still pending retry, and what ended in manual-review blockade.
       *    The reconciler reads it as evidence only: no target replay, no status updates, no
       *    inference that anything but `delivered` succeeded.
       */
      const [usageCounts] = await database.execute(sql<{
        pendingLago: string;
        pendingCredits: string;
        blockedLago: string;
        blockedCredits: string;
      }>`
        SELECT
          (SELECT COUNT(*)::bigint FROM usage_outbox WHERE lago_status = 'pending') AS "pendingLago",
          (SELECT COUNT(*)::bigint FROM usage_outbox WHERE credits_status = 'pending') AS "pendingCredits",
          (SELECT COUNT(*)::bigint FROM usage_outbox WHERE lago_status = 'blocked') AS "blockedLago",
          (SELECT COUNT(*)::bigint FROM usage_outbox WHERE credits_status = 'blocked') AS "blockedCredits"
      `);
      // Exact COUNT reads (audit F2: ::int wraps at 2^31 rows). The report's checked counts stay
      // numbers for the admin route's shape, so the conversion carries a guard that refuses
      // rather than silently overflowing — a report that understates its own backlog by 2^32
      // rows is worse than one that fails loudly.
      const exactCount = (value: string | undefined, label: string): number => {
        const parsed = Number(value ?? "0");
        if (!Number.isSafeInteger(parsed)) {
          throw new RangeError(
            `usage_outbox ${label} count is not a safe integer (${value}); the report refuses to round a backlog it cannot represent`,
          );
        }
        return parsed;
      };
      usageDeliveryTargets.pending.lago = exactCount(
        usageCounts?.pendingLago,
        "pending lago",
      );
      usageDeliveryTargets.pending.credits = exactCount(
        usageCounts?.pendingCredits,
        "pending credits",
      );
      usageDeliveryTargets.blocked.lago = exactCount(
        usageCounts?.blockedLago,
        "blocked lago",
      );
      usageDeliveryTargets.blocked.credits = exactCount(
        usageCounts?.blockedCredits,
        "blocked credits",
      );

      const actionableUsageTargetCount = sumUsageTargets(usageDeliveryTargets);
      const usageRows =
        actionableUsageTargetCount === 0
          ? []
          : await database.execute(sql<{
              eventId: string;
              updatedAt: Date;
              target: "lago" | "credits";
              status: "pending" | "blocked";
              lastErrorCode: string | null;
              attempts: number;
            }>`
              SELECT
                usage_targets.event_id AS "eventId",
                usage_targets.updated_at AS "updatedAt",
                usage_targets.target AS "target",
                usage_targets.status AS "status",
                usage_targets.last_error_code AS "lastErrorCode",
                usage_targets.attempts AS "attempts"
              FROM (
                SELECT
                  event_id,
                  updated_at,
                  'lago'::text AS target,
                  lago_status::text AS status,
                  lago_last_error_code AS last_error_code,
                  lago_attempts AS attempts,
                  1 AS target_rank
                FROM usage_outbox
                WHERE lago_status IN ('pending', 'blocked')

                UNION ALL

                SELECT
                  event_id,
                  updated_at,
                  'credits'::text AS target,
                  credits_status::text AS status,
                  credits_last_error_code AS last_error_code,
                  credits_attempts AS attempts,
                  2 AS target_rank
                FROM usage_outbox
                WHERE credits_status IN ('pending', 'blocked')
              ) AS usage_targets
              ORDER BY
                usage_targets.updated_at ASC,
                usage_targets.event_id ASC,
                usage_targets.target_rank ASC
              LIMIT ${usageFindingLimit}
            `);
      const emittedUsageTargets = {
        pending: { lago: 0, credits: 0 },
        blocked: { lago: 0, credits: 0 },
      };
      const now = Date.now();
      for (const row of usageRows) {
        const status = row.status === "pending" ? "pending" : "blocked";
        const target = row.target === "lago" ? "lago" : "credits";
        emittedUsageTargets[status][target] += 1;
        const ageSeconds = usageAgeSeconds(now, row.updatedAt);
        const failureCode = usageFailureCode(row.lastErrorCode);
        findings.push({
          category: "usage",
          code:
            status === "pending"
              ? "usage_target_pending"
              : "usage_target_blocked",
          subject: row.eventId,
          detail: `target=${target} state=${status} attempts=${row.attempts} attempt_age_seconds=${ageSeconds} last_failure_code=${failureCode}`,
        });
      }
      const omittedUsageTargets = {
        pending: {
          lago:
            usageDeliveryTargets.pending.lago -
            emittedUsageTargets.pending.lago,
          credits:
            usageDeliveryTargets.pending.credits -
            emittedUsageTargets.pending.credits,
        },
        blocked: {
          lago:
            usageDeliveryTargets.blocked.lago -
            emittedUsageTargets.blocked.lago,
          credits:
            usageDeliveryTargets.blocked.credits -
            emittedUsageTargets.blocked.credits,
        },
      };
      const omittedUsageFindings = sumUsageTargets(omittedUsageTargets);
      if (omittedUsageFindings > 0) {
        findings.push({
          category: "usage",
          code: "usage_findings_omitted",
          subject: "usage_outbox",
          detail: `omitted=${omittedUsageFindings} pending_lago=${omittedUsageTargets.pending.lago} pending_credits=${omittedUsageTargets.pending.credits} blocked_lago=${omittedUsageTargets.blocked.lago} blocked_credits=${omittedUsageTargets.blocked.credits}`,
        });
      }

      /*
       * ── Replay evidence (audit A7): the delivery's identity rides in an unsigned header, so
       *    the body hash is what ties "same content, different event id" together. Read-only,
       *    like every block here — it counts and reports; what to do about a replayed delivery
       *    is an operator's decision.
       */
      const replayedBodies = await database.execute(sql<{
        bodyHash: string;
        deliveries: string;
        totalHashes: string;
      }>`
        SELECT body_hash AS "bodyHash", COUNT(*)::bigint AS deliveries, COUNT(*) OVER ()::bigint AS "totalHashes"
        FROM billing_webhook_events
        WHERE body_hash IS NOT NULL
        GROUP BY body_hash
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT ${usageFindingLimit}
      `);
      for (const row of replayedBodies) {
        findings.push({
          category: "payment",
          code: "webhook_body_replay",
          subject: row.bodyHash,
          detail: `deliveries=${row.deliveries} distinct event ids carried this exact body — either the provider retried with fresh identity or somebody is replaying a captured delivery`,
        });
      }
      // The evidence rows cap at the finding limit, so the window total (`COUNT(*) OVER ()`,
      // every qualifying group before the LIMIT) carries the "there were N more" clue the
      // usage block already reports via `usage_findings_omitted` — a replay-flooded deployment
      // must not silently lose its tail (audit C3, closing A7's deferred marker).
      const replayedHashCount = Number(replayedBodies[0]?.totalHashes ?? "0");
      if (!Number.isSafeInteger(replayedHashCount)) {
        throw new RangeError(
          `billing_webhook_events replayed-hash count is not a safe integer (${replayedBodies[0]?.totalHashes}); the report refuses to round a backlog it cannot represent`,
        );
      }
      const omittedReplayedHashes = replayedHashCount - replayedBodies.length;
      if (omittedReplayedHashes > 0) {
        findings.push({
          category: "payment",
          code: "webhook_replays_omitted",
          subject: "billing_webhook_events",
          detail: `omitted=${omittedReplayedHashes} replayed body hashes beyond the evidence limit=${usageFindingLimit} — a replay flood larger than the report's evidence window; widen the window or drain the inbox`,
        });
      }

      return {
        ranAt: new Date().toISOString(),
        checked: {
          paidOrders: paidOrders.length,
          appliedOrders: appliedOrders.length,
          creditCustomers: customers.size,
          overdraw: {
            entries: overdrawEntryCount,
            units: overdrawUnits.toString(),
          },
          usageDeliveryTargets,
          usageFindings: {
            limit: usageFindingLimit,
            emitted: usageRows.length,
            omitted: omittedUsageFindings,
          },
          scanned: {
            paidOrders: paidOrders.length,
            paidFacts: paidFacts.length,
            reservedRows: reservedRows.length,
            pageSize: RECONCILE_PAGE_SIZE,
          },
          webhookReplays: {
            limit: usageFindingLimit,
            emitted: replayedBodies.length,
            omitted: omittedReplayedHashes,
          },
        },
        findings,
      };
    },
  };
}
