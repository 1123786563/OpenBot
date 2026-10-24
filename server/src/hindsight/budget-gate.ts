/**
 * Hindsight 15 (#393): the budget gate background memory processing is admitted through.
 *
 * The spec's sentence has three parts, and each lands somewhere specific:
 *
 *   - "按公司和个人设预算上限" — the caps are platform-set rows in hindsight_budget_caps
 *     (one per company: a whole-company monthly ceiling and the per-person ceiling applied to
 *     every principal). No row = no cap expressed: background processing runs, and the ops
 *     view reports the cap as unset rather than inventing a default limit.
 *   - "额度耗尽时新处理排队，不改动已确认内容的授权读取" — admission happens on every
 *     path that sends content for processing: the sync queue's retains (#384) and the eager
 *     retains behind a person's confirm/edit/correction (the judgment review's since
 *     FIX-W11, the preference and source-bound seams' since FIX-F23). Exhaustion defers the
 *     work — it stays pending, retried on the next drain — and no recall path ever consults
 *     this gate: reads of confirmed content are not spend and are unaffected by exhaustion.
 *   - "重试不重复扣费或跨公司计入" — admission is idempotent per (tenant, work_key): the
 *     queue keys admission on the work row's id plus its attempt count, so a budget-deferred
 *     retry (which deliberately does not bump attempts) re-admits the SAME reservation and is
 *     charged once, while a genuinely new processing attempt (a failed retain bumped
 *     attempts) is a fresh, honestly separate admission. Every ledger row is pinned to its
 *     tenant, so cross-company accounting is impossible at the storage layer.
 *
 * The reservation lifecycle mirrors the platform's credit holds in miniature (reserve, settle
 * or release) without dragging the Bifrost admission stack in: this is the platform-side
 * control over whether its own background work RUNS, not a model-call billing path — the
 * Hindsight service's model calls already run through the deployment's approved gateway.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  hindsightBudgetCaps,
  hindsightBudgetReservations,
} from "../db/schema/hindsight-budget";
import { isUniqueViolation } from "./sync-queue";

/** What one admission asks for, and what its answer means. */
export type BackgroundWorkAdmission =
  | { ok: true; reservationId: string }
  | {
      ok: false;
      reason: "company-cap" | "personal-cap";
    };

/** The gate the sync queue (and any later background processor) consults. */
export interface HindsightBudgetGate {
  admitBackgroundWork(input: {
    tenantId: string;
    principalId: string;
    /** Idempotency key: the sync work row's id plus its attempt count. */
    workKey: string;
    units?: number;
  }): Promise<BackgroundWorkAdmission>;
  /** The work ran: its reservation counts toward usage, finally. Idempotent per reservation. */
  settleBackgroundWork(reservationId: string, units?: number): Promise<void>;
  /** The work did not run after all (transport failure): the hold stops counting. */
  releaseBackgroundWork(reservationId: string, reason: string): Promise<void>;
  /** The usage the ops view reports: this company's and one principal's current period. */
  currentUsage(tenantId: string): Promise<{
    companyUnits: number;
    personalUnits: readonly { principalId: string; units: number }[];
    period: string;
  }>;
}

/** The calendar month a moment falls in, 'YYYY-MM' — the period caps are counted over. */
export function budgetPeriodOf(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The SQL-backed gate. Usage is aggregated from the ledger (reserved+settled rows of the
 * current period; released rows never count), so there is no second counter to drift from
 * the reservations themselves.
 */
export function createDrizzleBudgetGate(
  database: Database,
  options: { now?: () => Date } = {},
): HindsightBudgetGate & {
  /** The platform's control surface: set (or replace) one company's caps. */
  setCaps(
    tenantId: string,
    caps: { companyMonthlyUnits: number; personalMonthlyUnits: number },
  ): Promise<void>;
  capsOf(tenantId: string): Promise<{
    companyMonthlyUnits: number | null;
    personalMonthlyUnits: number | null;
  }>;
} {
  const now = options.now ?? (() => new Date());
  return {
    async admitBackgroundWork(input) {
      const period = budgetPeriodOf(now());
      const units = input.units ?? 1;
      // One transaction for the whole admission (FR-3, FIX-F23): the dedup read, the caps row
      // lock, the usage read under it and the insert all commit together, so a `SELECT … FOR
      // UPDATE` that used to expire at the end of its single statement now holds until the
      // reservation row is durable. Concurrent admissions of the same company serialize on
      // their caps row and each sees the charges the earlier one committed; the one thing a
      // transaction cannot fold is two admissions of the SAME work key racing past the dedup
      // read — the (tenant_id, work_key) unique index decides that race, and the loser returns
      // the winner's reservation below instead of erroring.
      //
      // Idempotency first (RG6-3): the same work key returns its existing reservation whatever
      // its state — a deferred retry re-admits without a second charge. A RELEASED row never
      // counted, so re-admitting it is a fresh admission in budget terms: the caps are
      // re-checked inside the caps row lock and the flip back to reserved happens only within
      // them — a released row cannot stand in as a bypass around a cap tightened since its
      // release. The queue normally makes this unreachable (a release bumps attempts, so the
      // next drain uses a fresh work key); it is the crash window between release and that
      // bump where the same work key comes back.
      try {
        return await database.transaction(async (tx) => {
          const [existing] = await tx
            .select()
            .from(hindsightBudgetReservations)
            .where(
              and(
                eq(hindsightBudgetReservations.tenantId, input.tenantId),
                eq(hindsightBudgetReservations.workKey, input.workKey),
              ),
            )
            .limit(1);
          if (existing) {
            if (existing.state === "released") {
              const verdict = await capsVerdict(
                tx,
                input.tenantId,
                input.principalId,
                period,
                units,
              );
              if (!verdict.ok) return verdict;
              await tx
                .update(hindsightBudgetReservations)
                .set({
                  state: "reserved",
                  period,
                  units,
                  releasedAt: null,
                  releaseReason: null,
                  updatedAt: now(),
                })
                .where(
                  and(
                    eq(hindsightBudgetReservations.id, existing.id),
                    eq(hindsightBudgetReservations.state, "released"),
                  ),
                );
            }
            return { ok: true as const, reservationId: existing.id };
          }
          const verdict = await capsVerdict(
            tx,
            input.tenantId,
            input.principalId,
            period,
            units,
          );
          if (!verdict.ok) return { ok: false as const, reason: verdict.reason };
          const id = randomUUID();
          await tx.insert(hindsightBudgetReservations).values({
            id,
            tenantId: input.tenantId,
            principalId: input.principalId,
            workKey: input.workKey,
            period,
            units,
            state: "reserved",
            createdAt: now(),
            updatedAt: now(),
          });
          return { ok: true as const, reservationId: id };
        });
      } catch (error) {
        // A same-key concurrent admission committed its reservation first (the unique index
        // is the authority the dedup read could not be under concurrency): fold into it —
        // the caller gets the SAME reservation id and its settle/release stays idempotent,
        // so the work is charged once, not once per racer.
        if (isUniqueViolation(error)) {
          const [existing] = await database
            .select()
            .from(hindsightBudgetReservations)
            .where(
              and(
                eq(hindsightBudgetReservations.tenantId, input.tenantId),
                eq(hindsightBudgetReservations.workKey, input.workKey),
              ),
            )
            .limit(1);
          if (existing) {
            return { ok: true as const, reservationId: existing.id };
          }
        }
        throw error;
      }
    },

    async settleBackgroundWork(reservationId, units) {
      const settled = units ?? null;
      await database
        .update(hindsightBudgetReservations)
        .set({
          state: "settled",
          ...(settled !== null ? { units: settled } : {}),
          settledAt: now(),
          updatedAt: now(),
        })
        .where(
          and(
            eq(hindsightBudgetReservations.id, reservationId),
            eq(hindsightBudgetReservations.state, "reserved"),
          ),
        );
    },

    async releaseBackgroundWork(reservationId, reason) {
      await database
        .update(hindsightBudgetReservations)
        .set({
          state: "released",
          releasedAt: now(),
          releaseReason: reason,
          updatedAt: now(),
        })
        .where(
          and(
            eq(hindsightBudgetReservations.id, reservationId),
            eq(hindsightBudgetReservations.state, "reserved"),
          ),
        );
    },

    async currentUsage(tenantId) {
      const period = budgetPeriodOf(now());
      const rows = await database
        .select({
          principalId: hindsightBudgetReservations.principalId,
          units: sql<number>`coalesce(sum(${hindsightBudgetReservations.units}), 0)::int`,
        })
        .from(hindsightBudgetReservations)
        .where(
          and(
            eq(hindsightBudgetReservations.tenantId, tenantId),
            eq(hindsightBudgetReservations.period, period),
            inArray(hindsightBudgetReservations.state, ["reserved", "settled"]),
          ),
        )
        .groupBy(hindsightBudgetReservations.principalId);
      return {
        companyUnits: rows.reduce((total, row) => total + row.units, 0),
        personalUnits: rows.map((row) => ({
          principalId: row.principalId,
          units: row.units,
        })),
        period,
      };
    },

    async setCaps(tenantId, caps) {
      await database
        .insert(hindsightBudgetCaps)
        .values({
          tenantId,
          companyMonthlyUnits: caps.companyMonthlyUnits,
          personalMonthlyUnits: caps.personalMonthlyUnits,
          updatedAt: now(),
        })
        .onConflictDoUpdate({
          target: hindsightBudgetCaps.tenantId,
          set: {
            companyMonthlyUnits: caps.companyMonthlyUnits,
            personalMonthlyUnits: caps.personalMonthlyUnits,
            updatedAt: now(),
          },
        });
    },

    async capsOf(tenantId) {
      const [caps] = await database
        .select()
        .from(hindsightBudgetCaps)
        .where(eq(hindsightBudgetCaps.tenantId, tenantId))
        .limit(1);
      return {
        companyMonthlyUnits: caps?.companyMonthlyUnits ?? null,
        personalMonthlyUnits: caps?.personalMonthlyUnits ?? null,
      };
    },
  };

  /**
   * Whether one admission fits the caps the platform has expressed — the same computation
   * for a fresh reservation and the re-admission of a released one. Always called inside
   * `admitBackgroundWork`'s transaction (FR-3, FIX-F23): the caps row lock the `FOR UPDATE`
   * takes holds across the verdict AND the insert or update that acts on it, until the
   * transaction commits — concurrent admissions of the same company serialize on their
   * caps row, and each sees the charges the earlier one committed (READ COMMITTED re-reads
   * the aggregate under the lock). No caps row = no cap expressed: admission runs. A cap of
   * 0 is the platform's "no background processing" — an expressed limit, not an unset one.
   */
  async function capsVerdict(
    db: Pick<Database, "select">,
    tenantId: string,
    principalId: string,
    period: string,
    units: number,
  ): Promise<
    { ok: true } | { ok: false; reason: "company-cap" | "personal-cap" }
  > {
    const [caps] = await db
      .select()
      .from(hindsightBudgetCaps)
      .where(eq(hindsightBudgetCaps.tenantId, tenantId))
      .for("update")
      .limit(1);
    if (!caps) return { ok: true };
    const [companyUsed, personalUsed] = await usageOf(
      db,
      tenantId,
      principalId,
      period,
    );
    if (companyUsed + units > caps.companyMonthlyUnits) {
      return { ok: false, reason: "company-cap" };
    }
    if (personalUsed + units > caps.personalMonthlyUnits) {
      return { ok: false, reason: "personal-cap" };
    }
    return { ok: true };
  }

  /** Company total and one principal's usage for a period, in one read each. */
  async function usageOf(
    db: Pick<Database, "select">,
    tenantId: string,
    principalId: string,
    period: string,
  ): Promise<[number, number]> {
    const rows = await db
      .select({
        principalId: hindsightBudgetReservations.principalId,
        units: sql<number>`coalesce(sum(${hindsightBudgetReservations.units}), 0)::int`,
      })
      .from(hindsightBudgetReservations)
      .where(
        and(
          eq(hindsightBudgetReservations.tenantId, tenantId),
          eq(hindsightBudgetReservations.period, period),
          inArray(hindsightBudgetReservations.state, ["reserved", "settled"]),
        ),
      )
      .groupBy(hindsightBudgetReservations.principalId);
    return [
      rows.reduce((total, row) => total + row.units, 0),
      rows.find((row) => row.principalId === principalId)?.units ?? 0,
    ];
  }
}

export type HindsightBudgetGateService = ReturnType<
  typeof createDrizzleBudgetGate
>;
