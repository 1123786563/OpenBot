import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  creditReservations,
  realtimeSessions,
  realtimeUnits,
} from "../db/schema/credit-reservations";
import type { PayerRef } from "./payer";

/*
 * The realtime session consumption view (Bifrost 15.8, #321): the read the person's 套餐与积分
 * page renders under the ledger reads — one row per realtime session of ONE account, with the
 * three facts the ticket's AC3 names: what the session already consumed (its settled units'
 * charges), what still awaits settlement (its holding units' ceilings — the same amount the
 * pending-settlement summary counts at the account level, seen per session), and why the session
 * is abnormal when it is (15.5's stop, 15.6's close, the unknown tail — the closed codes the
 * doors themselves wrote, never a transport verdict).
 *
 * THE ACCOUNT IS NEVER A PARAMETER. The service takes the payer the route resolved server-side
 * from the authenticated session (02.6's rule) and filters every read on the sessions' own frozen
 * payer columns — the identity the establishment door copied at creation (15.1), which nothing
 * mid-session re-resolves. Another person's sessions are not "hidden" from this answer; they were
 * never in the question (AC4: 界面不泄露他人会话或账户数据).
 *
 * AMOUNTS ARE THE LEDGER'S OWN INTEGERS. Every figure is the ×100 scaled unit the credit tables
 * store — `consumedCents` sums the reservations' `charged` over the session's SETTLED units (the
 * same integer the ledger wrote, so the page and the ledger can never disagree), and
 * `pendingCents` sums the reservations' `maximum` over the session's holding units (reserved,
 * processing, unknown — the occupying set 06.12's summary counts, attributed here to the session
 * whose unit holds them). A refused unit holds nothing and is counted only as a row.
 */

/** How many sessions one answer itemizes. Ours, not the caller's — the view's bound. */
const REALTIME_SESSION_VIEW_LIMIT = 50;

/** The session's abnormal state as the page reads it: the closed door codes, or null while healthy. */
export type RealtimeSessionAbnormal = {
  /** Which verdict ended or degraded the session — 15.5's stop or 15.6's close. */
  kind: "stopped" | "closed";
  /** The door's own code (insufficient_credits, grant_invalid, …) — closed vocabulary. */
  reason: string;
  at: string;
};

/** One realtime session as the person's page sees it (15.8's AC3 contract view). */
export type RealtimeSessionUsage = {
  sessionId: string;
  provider: string;
  model: string;
  startedAt: string;
  state: "open" | "closed";
  stopped: boolean;
  closed: boolean;
  abnormal: RealtimeSessionAbnormal | null;
  units: {
    settled: number;
    /** Holding: reserved | processing — money occupied, outcome not yet known. */
    holding: number;
    unknown: number;
    refused: number;
  };
  /** Settled units' charges, ×100 scaled integers (0 when nothing settled yet). */
  consumedCents: number;
  /** Holding + unknown units' ceilings — the amount awaiting settlement or disposal. */
  pendingCents: number;
};

export type RealtimeUsageReader = {
  /** The account's realtime sessions, newest first, bounded — never a parameter's account. */
  realtimeSessionsForPayer(payer: PayerRef): Promise<RealtimeSessionUsage[]>;
};

export type RealtimeUsageDependencies = {
  database: Database;
};

/**
 * The one aggregate behind the view: sessions of the payer, each with its units counted by the
 * state machine's own positions and its money summed from the reservations the units hold. One
 * query over sessions joined to their units and the units' reservations keeps the per-session
 * figures and the unit counts from disagreeing about the same rows — the answer the recovery's
 * restore read and the page's row are both projections of.
 */
export function createRealtimeUsageService(
  dependencies: RealtimeUsageDependencies,
): RealtimeUsageReader {
  const { database } = dependencies;

  return {
    async realtimeSessionsForPayer(
      payer: PayerRef,
    ): Promise<RealtimeSessionUsage[]> {
      const rows = await database
        .select({
          sessionId: realtimeSessions.sessionId,
          provider: realtimeSessions.provider,
          model: realtimeSessions.model,
          startedAt: realtimeSessions.startedAt,
          state: realtimeSessions.state,
          stoppedAt: realtimeSessions.stoppedAt,
          stopReason: realtimeSessions.stopReason,
          closedAt: realtimeSessions.closedAt,
          closeReason: realtimeSessions.closeReason,
          settledCount: sql<number>`count(*) filter (where ${realtimeUnits.state} = 'settled')::int`,
          holdingCount: sql<number>`count(*) filter (where ${realtimeUnits.state} in ('reserved', 'processing'))::int`,
          unknownCount: sql<number>`count(*) filter (where ${realtimeUnits.state} = 'unknown')::int`,
          refusedCount: sql<number>`count(*) filter (where ${realtimeUnits.state} = 'refused')::int`,
          consumedCents: sql<number>`coalesce(sum(${creditReservations.charged}) filter (where ${realtimeUnits.state} = 'settled'), 0)::int`,
          pendingCents: sql<number>`coalesce(sum(${creditReservations.maximum}) filter (where ${realtimeUnits.state} in ('reserved', 'processing', 'unknown')), 0)::int`,
        })
        .from(realtimeSessions)
        .leftJoin(
          realtimeUnits,
          eq(realtimeUnits.sessionId, realtimeSessions.sessionId),
        )
        .leftJoin(
          creditReservations,
          eq(creditReservations.id, realtimeUnits.reservationId),
        )
        .where(
          sql`${realtimeSessions.payerKind} = ${payer.kind} and ${realtimeSessions.payerId} = ${payer.id}`,
        )
        .groupBy(realtimeSessions.sessionId)
        .orderBy(
          desc(realtimeSessions.startedAt),
          desc(realtimeSessions.sessionId),
        )
        .limit(REALTIME_SESSION_VIEW_LIMIT);
      return rows.map((row) => ({
        sessionId: row.sessionId,
        provider: row.provider,
        model: row.model,
        startedAt: row.startedAt.toISOString(),
        state: row.state,
        stopped: row.stoppedAt !== null,
        closed: row.state === "closed",
        abnormal:
          row.closeReason !== null && row.closedAt !== null
            ? {
                kind: "closed" as const,
                reason: row.closeReason,
                at: row.closedAt.toISOString(),
              }
            : row.stopReason !== null && row.stoppedAt !== null
              ? {
                  kind: "stopped" as const,
                  reason: row.stopReason,
                  at: row.stoppedAt.toISOString(),
                }
              : null,
        units: {
          settled: Number(row.settledCount ?? 0),
          holding: Number(row.holdingCount ?? 0),
          unknown: Number(row.unknownCount ?? 0),
          refused: Number(row.refusedCount ?? 0),
        },
        consumedCents: Number(row.consumedCents ?? 0),
        pendingCents: Number(row.pendingCents ?? 0),
      }));
    },
  };
}
