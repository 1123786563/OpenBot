/**
 * Hindsight 15 (#393): the company administrator's health view over the memory system.
 *
 * What an operator may see, exhaustively: the SERVICE state (the same four states
 * checkHindsightHealth answers with, passed in by the caller — the probe needs the service
 * configuration and belongs to health.ts), the BACKLOG (pending and failed sync work, oldest
 * pending age, unfinished remote deletions), and the BUDGET USAGE (the company's cap and
 * current-period units, plus each principal's units). What an operator may never see, also
 * exhaustively: memory content, candidate text, provenance, evidence, error text from the
 * work rows, or any subject id that names a person's memory. Those stay in the person's own
 * surfaces; the view here counts ROWS, never reads them.
 *
 * The shape is the guarantee: this module composes its answer out of counts and enum-ish
 * states only, so no serialization of it can leak content. The structural test pins that by
 * scanning the serialized snapshot for content strings seeded alongside the counts.
 */

import { and, count, eq, min, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { hindsightRevocations } from "../db/schema/hindsight-revocations";
import { hindsightSyncWork } from "../db/schema/hindsight-sync";
import type { HindsightBudgetGateService } from "./budget-gate";
import { loadHindsightConfig } from "./config";
import { checkHindsightHealth, type HindsightHealthState } from "./health";

/** The admin-visible backlog: counts and ages, nothing else. */
export type HindsightOpsBacklog = {
  /** Work waiting for its first or next drain attempt. */
  pendingWork: number;
  /** Pending rows with at least one failed attempt behind them (still retrying). */
  failedWork: number;
  /** The oldest pending row's enqueue time; null when nothing is pending. */
  oldestPendingAt: Date | null;
  /** Unfinished remote deletions behind blocks that already took effect (#390). */
  outstandingDeletions: number;
};

/** The admin-visible budget picture: caps as set, usage as counted. */
export type HindsightOpsBudgets = {
  companyMonthlyUnits: number | null;
  personalMonthlyUnits: number | null;
  period: string;
  companyUsedUnits: number;
  companyOverCap: boolean;
  /** Per-principal current-period units — counts only, ids are principal ids, not memory ids. */
  personalUsage: readonly { principalId: string; units: number }[];
};

/** The whole snapshot: service, backlog, budgets. Contains no memory or candidate text. */
export type HindsightAdminHealthSnapshot = {
  service: { state: HindsightHealthState | "unknown" };
  backlog: HindsightOpsBacklog;
  budgets: HindsightOpsBudgets;
  checkedAt: string;
};

/**
 * Read one company's operational picture. The service state is handed in (from
 * checkHindsightHealth, or "unknown" when the probe is not wired at the call site); the
 * backlog and the budgets are read here, tenant-pinned — an administrator of one company
 * sees that company's backlog and nothing of another's.
 */
export async function hindsightAdminHealthSnapshot(
  database: Database,
  budgetGate: HindsightBudgetGateService,
  tenantId: string,
  options: {
    serviceState?: HindsightHealthState;
    now?: () => Date;
  } = {},
): Promise<HindsightAdminHealthSnapshot> {
  const now = options.now ?? (() => new Date());
  const [pendingRow] = await database
    .select({
      pending: count(),
      oldest: min(hindsightSyncWork.createdAt),
    })
    .from(hindsightSyncWork)
    .where(
      and(
        eq(hindsightSyncWork.tenantId, tenantId),
        eq(hindsightSyncWork.state, "pending"),
      ),
    );
  const [failedRow] = await database
    .select({ failed: count() })
    .from(hindsightSyncWork)
    .where(
      and(
        eq(hindsightSyncWork.tenantId, tenantId),
        eq(hindsightSyncWork.state, "pending"),
        sql`${hindsightSyncWork.attempts} > 0`,
      ),
    );
  const [deletionsRow] = await database
    .select({ outstanding: count() })
    .from(hindsightRevocations)
    .where(
      and(
        eq(hindsightRevocations.tenantId, tenantId),
        sql`${hindsightRevocations.deletionState} <> 'confirmed'`,
      ),
    );
  const usage = await budgetGate.currentUsage(tenantId);
  const caps = await budgetGate.capsOf(tenantId);
  const backlog: HindsightOpsBacklog = {
    pendingWork: Number(pendingRow?.pending ?? 0),
    failedWork: Number(failedRow?.failed ?? 0),
    // The oldest pending row's enqueue moment, kept as the raw Date the scheduler ages from.
    oldestPendingAt: pendingRow?.oldest ? new Date(pendingRow.oldest) : null,
    outstandingDeletions: Number(deletionsRow?.outstanding ?? 0),
  };
  const budgets: HindsightOpsBudgets = {
    companyMonthlyUnits: caps.companyMonthlyUnits,
    personalMonthlyUnits: caps.personalMonthlyUnits,
    period: usage.period,
    companyUsedUnits: usage.companyUnits,
    companyOverCap:
      caps.companyMonthlyUnits !== null &&
      usage.companyUnits > caps.companyMonthlyUnits,
    personalUsage: usage.personalUnits,
  };
  return {
    service: { state: options.serviceState ?? "unknown" },
    backlog,
    budgets,
    checkedAt: now().toISOString(),
  };
}

/**
 * The production snapshot the admin route serves (FIX-W11 A-2, #393): the health probe runs
 * when the deployment's health configuration is declared, and a missing or malformed
 * declaration answers "unknown" — the honest state for a probe nobody wired — while the
 * backlog and budget blocks read the same database either way. Never throws: an unreachable
 * service is a `service_down` verdict, not an error on the operator's route.
 */
export async function hindsightAdminHealthSnapshotForRoute(
  database: Database,
  budgetGate: HindsightBudgetGateService,
  tenantId: string,
  options: {
    env?: Record<string, string | undefined>;
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    now?: () => Date;
  } = {},
): Promise<HindsightAdminHealthSnapshot> {
  let serviceState: HindsightHealthState | undefined;
  try {
    serviceState = (
      await checkHindsightHealth(
        loadHindsightConfig(options.env ?? process.env),
        { fetch: options.fetch, now: options.now },
      )
    ).state;
  } catch {
    serviceState = undefined;
  }
  return hindsightAdminHealthSnapshot(database, budgetGate, tenantId, {
    ...(serviceState === undefined ? {} : { serviceState }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
