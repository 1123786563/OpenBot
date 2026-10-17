import { and, asc, count, desc, eq, gte, lte, ne } from "drizzle-orm";
import type { Database } from "../db/client";
import { creditGrants, creditLedger } from "../db/schema/credits";
import {
  type GrantCapacity,
  liveGrants,
} from "./capacity";
import { type PayerRef, payerKey } from "./payer";
import type {
  CreditConsumptionPage,
  CreditGrantEntry,
  CreditGrantStatus,
  CreditSummary,
  PlanCatalogEntry,
} from "./types";

/**
 * The local credit ledger — the "套餐与积分" page's whole answer.
 *
 * Credits are the deployment's own currency, kept entirely in this deployment's database (the
 * confirmed split: Lago owns the subscription and the metered raw events, the credit ledger is
 * local). One credit is stored as `CREDIT_SCALE` whole units, the same "never store money as a
 * float" rule the payment orders keep, so a grant of "23.63" is the integer `2363` and never a
 * binary float that drifts.
 *
 * All three reads are scoped to one account key, and the caller cannot spell one: the account
 * rides in as a `PayerRef` — the payer resolution module's output, never a caller-supplied
 * externalCustomerId (ticket 02.4's parameter convergence). Omitting the ref reads the
 * deployment's own key, the reads the 套餐与积分 page answers today; ticket 02.6 switches the
 * person-facing routes to the signed-in user's resolved personal ref. `status` and `expiringSoon`
 * are derived here, not stored, because "used up" and "expired" are functions of the clock and
 * the balance, not facts a writer must remember to flip; the page never shows a stale pill.
 */

/** One credit = this many stored units, so the two-place decimals stay exact. */
export const CREDIT_SCALE = 100;

/** How many ledger rows a page holds. Ours, not the caller's — the same rule as the event log. */
const CONSUMPTION_PAGE_SIZE = 20;

/** The window a consumption read is narrowed to. Both ends inclusive, either end optional. */
export type CreditConsumptionWindow = {
  from: Date | null;
  to: Date | null;
  page: number;
};

export type Credits = {
  /** The plan catalog this deployment configured, for the upgrade dialog. */
  catalog: ReadonlyMap<string, PlanCatalogEntry>;
  summary(payer?: PayerRef): Promise<CreditSummary>;
  grants(payer?: PayerRef): Promise<readonly CreditGrantEntry[]>;
  consumption(
    window: CreditConsumptionWindow,
    payer?: PayerRef,
  ): Promise<CreditConsumptionPage>;
};

export function createCredits(deps: {
  database: Database;
  /** The deployment's own customer key, so the read needs no explicit caller. */
  externalCustomerKey: string;
  /** The plan catalog from deployment config, passed through for the upgrade dialog. */
  catalog: ReadonlyMap<string, PlanCatalogEntry>;
}): Credits {
  const { database, externalCustomerKey, catalog } = deps;
  // The one place a read's account key is decided: from the resolved payer ref, or the
  // deployment's own key when no ref was resolved. A bare externalCustomerId cannot reach here
  // — the parameter is a PayerRef or nothing (02.4's convergence).
  const keyOf = (payer?: PayerRef) =>
    payer ? payerKey(payer) : externalCustomerKey;

  return {
    catalog,
    async summary(payer) {
      // The same live-grant read admission uses, unlocked: expired grants drop out and active
      // holds are subtracted, so this answer and the gate's answer cannot disagree (audit A1).
      const grants = await liveGrants(
        database,
        keyOf(payer),
        new Date(),
        false,
      );
      return summarizeCapacity(grants);
    },

    async grants(payer) {
      const rows = await database
        .select()
        .from(creditGrants)
        .where(
          and(
            eq(creditGrants.externalCustomerId, keyOf(payer)),
            ne(creditGrants.source, "plan"),
          ),
        )
        // Soonest-to-lapse first, so the red "24小时内过期" cue leads the list.
        .orderBy(asc(creditGrants.expiresAt));

      const now = Date.now();
      const soon = now + 24 * 60 * 60 * 1000;
      return rows.map((row) => grantOf(row, now, soon));
    },

    async consumption(window, payer) {
      const conditions = [
        eq(creditLedger.externalCustomerId, keyOf(payer)),
      ];
      if (window.from) conditions.push(gte(creditLedger.createdAt, window.from));
      if (window.to) conditions.push(lte(creditLedger.createdAt, window.to));
      const where = and(...conditions);

      const totalCount = await database
        .select({ value: count() })
        .from(creditLedger)
        .where(where)
        .then((rows) => rows[0]?.value ?? 0);

      const rows = await database
        .select()
        .from(creditLedger)
        .where(where)
        .orderBy(desc(creditLedger.createdAt))
        .limit(CONSUMPTION_PAGE_SIZE)
        .offset((window.page - 1) * CONSUMPTION_PAGE_SIZE);

      const totalPages = Math.max(
        Math.ceil(totalCount / CONSUMPTION_PAGE_SIZE),
        1,
      );
      return {
        entries: rows.map((row) => ({
          id: row.id,
          title: row.title,
          requestId: row.requestId,
          credits: scaleDown(row.credits),
          applied: scaleDown(row.applied),
          model: row.model,
          client: row.client,
          timestamp: row.createdAt.toISOString(),
        })),
        pagination: {
          totalCount,
          totalPages,
          currentPage: window.page,
          nextPage:
            window.page * CONSUMPTION_PAGE_SIZE < totalCount
              ? window.page + 1
              : null,
        },
      };
    },
  };
}

/**
 * The page's balance answer, from the same per-grant capacity facts admission uses. Pure, so the
 * aggregation is testable without a database (audit A1: the previous version was reachable only
 * through a live query and had no test at all).
 */
export function summarizeCapacity(
  grants: readonly GrantCapacity[],
): CreditSummary {
  const plan = { total: 0, used: 0, remaining: 0, held: 0 };
  const rewards = { total: 0, used: 0, remaining: 0, held: 0, grantCount: 0 };
  for (const grant of grants) {
    const bucket = grant.source === "plan" ? plan : rewards;
    bucket.total += grant.total;
    bucket.used += grant.used;
    bucket.held += grant.held;
    bucket.remaining += grant.free;
    if (grant.source !== "plan" && grant.free > 0) rewards.grantCount += 1;
  }
  return {
    plan: {
      total: scaleDown(plan.total),
      used: scaleDown(plan.used),
      remaining: scaleDown(plan.remaining),
      held: scaleDown(plan.held),
    },
    rewards: {
      total: scaleDown(rewards.total),
      used: scaleDown(rewards.used),
      remaining: scaleDown(rewards.remaining),
      held: scaleDown(rewards.held),
      grantCount: rewards.grantCount,
    },
  };
}

/**
 * A grant's life, derived from its balance and its expiry — never stored, because "used up" and
 * "expired" are functions of the clock and the balance, not facts a writer must remember to flip.
 * Exported for the tests that pin the three-way state machine.
 */
export function deriveGrantStatus(
  grant: { total: number; used: number; expiresAt: Date },
  now: number,
): CreditGrantStatus {
  const remaining = Math.max(grant.total - grant.used, 0);
  return grant.expiresAt.getTime() <= now
    ? "expired"
    : remaining <= 0
      ? "exhausted"
      : "active";
}

/** The stored row → the page's entry, the two-place decimal restored and the life derived. */
function grantOf(
  row: typeof creditGrants.$inferSelect,
  now: number,
  soon: number,
): CreditGrantEntry {
  const remaining = Math.max(row.total - row.used, 0);
  const status = deriveGrantStatus(row, now);
  return {
    id: row.id,
    source: row.source,
    reason: row.reason,
    total: scaleDown(row.total),
    used: scaleDown(row.used),
    remaining: scaleDown(remaining),
    grantedAt: row.grantedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status,
    expiringSoon: status === "active" && row.expiresAt.getTime() <= soon,
  };
}

/** Stored units → credits, a decimal with two places. */
function scaleDown(units: number): number {
  return units / CREDIT_SCALE;
}
