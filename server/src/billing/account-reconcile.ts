import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { payerAccounts } from "../db/schema/billing";
import {
  creditRecoveryItems,
  creditReservations,
} from "../db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../db/schema/credits";
import { paymentEvents, paymentOrders } from "../db/schema/payment";
import type { PayerKind } from "./payer";

/*
 * The per-account billing anomaly pass (Bifrost BP06, #374): 逐 Payer 核对 Grant、Ledger、
 * 未知预留与收款异常 — one account at a time, so nothing nets across accounts and a
 * mismatch that hides behind a balanced sum still surfaces.
 *
 * WHY A SECOND PASS WHEN T7's RECONCILER EXISTS. The whole-books reconciler
 * (billing/reconcile.ts) audits the SUM identities — Σ grants.used == Σ ledger.applied,
 * grouped by customer. A sum is a cancellation machine: one account's grant drawn too much
 * and another's drawn too little still sums clean PER GRANT-TABLE, and the finer break —
 * a single grant whose `used` disagrees with the ledger rows attributed TO IT while the
 * account's two sums agree exactly — is invisible to it. This pass goes one level down,
 * per payer account:
 *
 *   1. The account's own sum identity (re-derived here, so an account's report stands
 *      alone — the account view must not depend on the whole-books pass having run).
 *   2. The per-GRANT identity: for every grant of the account, Σ applied over the ledger
 *      rows attributed to that grant == the grant's `used`. A grant-level break with
 *      account-level agreement is exactly "汇总金额相等但个体交易错配仍报错" (AC1).
 *   3. Cross-account attribution: a ledger row on account A carrying the grantId of
 *      account B's grant is money moved between books — the row and the grant each sum
 *      fine inside their own account, and the account sums can still agree. 跨账户发放/
 *      消费不被相互抵消 (AC1) is this check: the misattribution is named, never netted.
 *   4. Unknown holds (AC2's anomaly-listing half): every `unknown` reservation of the
 *      account is listed with its occupied maximum and whether its technical deadline
 *      (`expires_at`) is long past — the deadline changes nothing about occupancy (Q12:
 *      the clock is not release evidence; 06.8/08.x own that discipline), but an operator
 *      reading the account's anomalies needs to SEE the hold and its age. A hold past
 *      deadline is flagged `pastTechnicalDeadline`; releasing it stays 08.9's evidenced
 *      decision — this pass reads, it never repairs (reconciliation that fixes what it
 *      finds is how a second bug erases the first one's evidence).
 *   5. Payment anomalies attributable to the account: paid orders owned by the account's
 *      payer mapping that carry open `anomaly` events (the BP02 vocabulary) — the
 *      collection-side half of 逐 Payer 核对收款. Orders with no owner mapping are listed
 *      unattributed (Q23: never guess an owner), under their own bucket.
 *
 * PAYER MAPPING, READ NEVER GUESSED. Accounts are joined to their payer mapping
 * (payer_accounts) by the customer key; an account with no mapping row reports
 * `payer: null` and nothing breaks. Payment orders carry ownerPayerKind/ownerPayerId —
 * attribution resolves through the mapping table in BOTH directions (the account whose
 * mapping matches the order's owner pair), so an order is attributed to the account the
 * mapping itself names, never to whoever's sums would fit.
 */

/** Why one account's books disagree. Closed vocabulary — greppable, displayable. */
export const ACCOUNT_ANOMALY_CODES = [
  /** The account's Σ grants.used ≠ Σ ledger.applied (the sum identity, per account). */
  "account_grants_ledger_divergence",
  /** One grant's used ≠ the ledger rows attributed to it — sums agree, the row does not. */
  "grant_ledger_row_mismatch",
  /** A ledger row of this account carries another account's grant — cross-book money. */
  "cross_account_ledger_attribution",
  /** An unknown hold is still occupying the account's capacity (listed, never released). */
  "unknown_hold_occupying",
  /** A paid order attributed to this account carries an open payment anomaly event. */
  "payment_anomaly_open",
] as const;

export type AccountAnomalyCode = (typeof ACCOUNT_ANOMALY_CODES)[number];

export type AccountAnomaly = {
  code: AccountAnomalyCode;
  /** The row the anomaly is about: grant id, ledger row id, reservation id, order id. */
  subject: string;
  /** The human sentence — numbers included, because the report is the evidence. */
  detail: string;
};

/** One unknown hold on the account, as the anomaly list shows it. */
export type AccountUnknownHold = {
  reservationId: string;
  /** The hold's ceiling — what it occupies of the account's capacity, in scaled units. */
  maximumCredits: number;
  /** 06.8's recorded reason the result never arrived. */
  unknownReason: string | null;
  /** When the hold was marked unknown. */
  unknownAt: string | null;
  /** Whether the hold's own technical deadline (expires_at) has passed — occupancy is
   * unchanged either way; only 08.9's evidenced disposal may move the hold. */
  pastTechnicalDeadline: boolean;
  /** Whether the recovery scan has named this hold as a RecoveryItem yet. */
  namedForRecovery: boolean;
};

/** One account's slice of the pass. */
export type AccountReconcileEntry = {
  /** The credit account key (the external customer id). */
  accountKey: string;
  /** The payer mapping behind the account, when one resolves; null stays null. */
  payer: { kind: PayerKind; payerId: string } | null;
  anomalies: AccountAnomaly[];
  unknownHolds: AccountUnknownHold[];
};

/** The pass's answer: one entry per account with anything to say, plus the unattributed
 * payment-anomaly bucket (orders no mapping owns — listed, never guessed into an account). */
export type AccountReconcileReport = {
  ranAt: string;
  accounts: AccountReconcileEntry[];
  /** Paid orders with open anomalies that no payer mapping attributes to any account. */
  unattributedPaymentAnomalies: { orderId: string; code: string | null }[];
  /** How many accounts the pass examined (all with grants or ledger rows, anomalies or not). */
  accountsExamined: number;
};

export type AccountReconciler = {
  /** One read-only pass over every account. Safe to re-run; writes nothing, ever. */
  reconcileAccounts(): Promise<AccountReconcileReport>;
};

export type AccountReconcilerDependencies = {
  database: Database;
  /** Injectable clock; the app clock by default. */
  now?: () => Date;
};

export function createAccountReconciler(
  dependencies: AccountReconcilerDependencies,
): AccountReconciler {
  const { database } = dependencies;
  const now = () => dependencies.now?.() ?? new Date();

  return {
    async reconcileAccounts() {
      const at = now();

      // --- The payer mappings, once: the account → payer join and the (kind,id) →
      // account reverse join the payment attribution walks.
      const mappings = await database
        .select({
          externalCustomerId: payerAccounts.externalCustomerId,
          kind: payerAccounts.kind,
          payerId: payerAccounts.payerId,
        })
        .from(payerAccounts);
      const payerOfAccount = new Map(
        mappings.map((row) => [
          row.externalCustomerId,
          { kind: row.kind, payerId: row.payerId },
        ]),
      );
      const accountOfPayer = new Map(
        mappings.map((row) => [
          `${row.kind}:${row.payerId}`,
          row.externalCustomerId,
        ]),
      );

      const entries = new Map<string, AccountReconcileEntry>();
      const entryOf = (accountKey: string): AccountReconcileEntry => {
        let entry = entries.get(accountKey);
        if (!entry) {
          entry = {
            accountKey,
            payer: payerOfAccount.get(accountKey) ?? null,
            anomalies: [],
            unknownHolds: [],
          };
          entries.set(accountKey, entry);
        }
        return entry;
      };

      /*
       * --- 1: the account sum identity, per account. Exact integers as decimal strings
       *     compared as BigInt, the same discipline as T7's pass (a customer's history
       *     can sum past Number.MAX_SAFE_INTEGER).
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
      for (const customer of new Set([
        ...usedMap.keys(),
        ...appliedMap.keys(),
      ])) {
        const entry = entryOf(customer);
        const used = usedMap.get(customer) ?? 0n;
        const applied = appliedMap.get(customer) ?? 0n;
        if (used !== applied) {
          entry.anomalies.push({
            code: "account_grants_ledger_divergence",
            subject: customer,
            detail: `Σ grants.used = ${used} but Σ ledger.applied = ${applied} (off by ${applied - used}) on this account's own books`,
          });
        }
      }

      /*
       * --- 2 + 3: the per-grant identity and the cross-account attribution, from ONE
       *     join each side. The grant side: every grant with its used. The ledger side:
       *     applied summed per (row-account, grant-id) over attributed rows, plus the
       *     grant's own account for the cross check.
       */
      const grants = await database
        .select({
          id: creditGrants.id,
          customer: creditGrants.externalCustomerId,
          used: creditGrants.used,
        })
        .from(creditGrants);
      const grantCustomer = new Map(
        grants.map((grant) => [grant.id, grant.customer]),
      );

      const attributedApplied = await database
        .select({
          rowCustomer: creditLedger.externalCustomerId,
          grantId: creditLedger.grantId,
          total: sql<string>`COALESCE(SUM(${creditLedger.applied}), 0)::bigint`,
        })
        .from(creditLedger)
        .where(sql`${creditLedger.grantId} IS NOT NULL`)
        .groupBy(creditLedger.externalCustomerId, creditLedger.grantId);

      const appliedOnGrant = new Map<string, bigint>();
      for (const row of attributedApplied) {
        // The WHERE clause keeps NULLs out; the guard keeps the compiler's truth honest.
        if (row.grantId === null) continue;
        // The grouping above is per (row-account, grant-id): a grant attributed from two
        // accounts arrives as two rows, and the per-grant identity below reads the grant's
        // TOTAL attributed applied — accumulate, never overwrite.
        appliedOnGrant.set(
          row.grantId,
          (appliedOnGrant.get(row.grantId) ?? 0n) + BigInt(row.total),
        );
        // 3: a row on one account attributed to another account's grant is cross-book
        // money. BOTH books get the finding — the row's account (money consumed here,
        // drawn there) and the grant's account (its `used` says drawn, the rows say
        // elsewhere) — so neither side's report can miss it.
        const grantOwner = grantCustomer.get(row.grantId);
        if (grantOwner !== undefined && grantOwner !== row.rowCustomer) {
          entryOf(row.rowCustomer).anomalies.push({
            code: "cross_account_ledger_attribution",
            subject: row.rowCustomer,
            detail: `ledger draws on this account are attributed to grant ${row.grantId}, which belongs to ${grantOwner} — cross-book money, named on both accounts, never netted`,
          });
          entryOf(grantOwner).anomalies.push({
            code: "cross_account_ledger_attribution",
            subject: row.grantId,
            detail: `this grant's attributed ledger rows sit on account ${row.rowCustomer}, not on this account — cross-book money, named on both accounts, never netted`,
          });
        }
      }

      // 2: the per-grant identity. A grant whose attributed rows do not sum to its
      // `used` is the individual mismatch the account sums can hide (AC1).
      for (const grant of grants) {
        const attributed = appliedOnGrant.get(grant.id) ?? 0n;
        if (attributed !== BigInt(grant.used)) {
          entryOf(grant.customer).anomalies.push({
            code: "grant_ledger_row_mismatch",
            subject: grant.id,
            detail: `grant used = ${grant.used} but its attributed ledger rows sum to ${attributed} — the account's totals can still agree; this row-level break is the one the sums hide`,
          });
        }
      }

      /*
       * --- 4: the unknown holds, per account, with age and recovery status. Listed only:
       *     nothing here releases, holds down, or marks anything; the past-deadline flag
       *     is information for the operator who will (through 08.9, on evidence).
       */
      const unknownHolds = await database
        .select({
          id: creditReservations.id,
          customer: creditReservations.externalCustomerId,
          maximum: creditReservations.maximum,
          unknownReason: creditReservations.unknownReason,
          unknownAt: creditReservations.unknownAt,
          expiresAt: creditReservations.expiresAt,
        })
        .from(creditReservations)
        .where(eq(creditReservations.status, "unknown"));
      const namedReservations = new Set(
        // Only the candidates this scan can name — the recovery-items table grows with
        // history, and the scan needs membership for these holds alone.
        (
          await database
            .select({ reservationId: creditRecoveryItems.reservationId })
            .from(creditRecoveryItems)
            .where(
              inArray(
                creditRecoveryItems.reservationId,
                unknownHolds.map((hold) => hold.id),
              ),
            )
        ).map((row) => row.reservationId),
      );
      for (const hold of unknownHolds) {
        entryOf(hold.customer).unknownHolds.push({
          reservationId: hold.id,
          maximumCredits: hold.maximum,
          unknownReason: hold.unknownReason,
          unknownAt: hold.unknownAt?.toISOString() ?? null,
          pastTechnicalDeadline: hold.expiresAt.getTime() <= at.getTime(),
          namedForRecovery: namedReservations.has(hold.id),
        });
      }

      /*
       * --- 5: the payment anomalies, attributed through the payer mappings the orders
       *     themselves name. An order with no owner pair (or one no mapping resolves)
       *     lands in the unattributed bucket — listed for the operator, attributed to
       *     nobody (Q23: an unowned order is not anyone's by elimination).
       */
      const anomalousOrders = await database
        .select({
          orderId: paymentOrders.id,
          ownerPayerKind: paymentOrders.ownerPayerKind,
          ownerPayerId: paymentOrders.ownerPayerId,
        })
        .from(paymentOrders)
        .where(eq(paymentOrders.status, "paid"));
      const openAnomalies = await database
        .select({
          orderId: paymentEvents.orderId,
          code: paymentEvents.code,
        })
        .from(paymentEvents)
        // Anomaly rows carry no lifecycle state (facts move pending→paid; anomalies are
        // recorded as-seen, state NULL) — every anomaly row is an open anomaly.
        .where(eq(paymentEvents.kind, "anomaly"))
        .groupBy(paymentEvents.orderId, paymentEvents.code);
      const anomaliesByOrder = new Map<string, string[]>();
      for (const row of openAnomalies) {
        const list = anomaliesByOrder.get(row.orderId) ?? [];
        list.push(row.code);
        anomaliesByOrder.set(row.orderId, list);
      }
      const unattributedPaymentAnomalies: {
        orderId: string;
        code: string | null;
      }[] = [];
      for (const order of anomalousOrders) {
        const codes = anomaliesByOrder.get(order.orderId);
        if (!codes || codes.length === 0) continue;
        const accountKey =
          order.ownerPayerKind !== null && order.ownerPayerId !== null
            ? accountOfPayer.get(
                `${order.ownerPayerKind}:${order.ownerPayerId}`,
              )
            : undefined;
        if (accountKey === undefined) {
          unattributedPaymentAnomalies.push({
            orderId: order.orderId,
            code: codes.join(","),
          });
          continue;
        }
        entryOf(accountKey).anomalies.push({
          code: "payment_anomaly_open",
          subject: order.orderId,
          detail: `the paid order carries open payment anomalies (${codes.join(", ")}) — the collection-side half of this account's books`,
        });
      }

      // Every account with grants, ledger rows, or even only unknown-hold entries appears,
      // anomalous or not, so an empty anomalies list is a checked answer, not an
      // overlooked account.
      for (const customer of new Set([
        ...usedMap.keys(),
        ...appliedMap.keys(),
      ])) {
        entryOf(customer);
      }

      return {
        ranAt: at.toISOString(),
        accounts: [...entries.values()].sort((a, b) =>
          a.accountKey.localeCompare(b.accountKey),
        ),
        unattributedPaymentAnomalies,
        accountsExamined: entries.size,
      };
    },
  };
}
