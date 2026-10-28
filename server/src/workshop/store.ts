/**
 * Reads and writes for the workshop's four tables, in the same deliberately-boring register as
 * the code-run store: the orchestrator owns the decisions, this file owns the rows.
 *
 * One shape worth reading before extending: every turn-mutating method (`markRunning`,
 * `markSucceeded`, …) is a guarded update — it succeeds only when the row is still where the
 * caller believed it was — so two writers racing on one turn resolve by row state rather than by
 * whoever wrote last. `recoverStale` relies on the same guards to settle a dead runner's turn
 * exactly once even when two replicas notice the same heartbeat going quiet.
 */

import { randomBytes } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client";
import {
  workshopArtifacts,
  workshopScheduleRuns,
  workshopSchedules,
  workshopSessions,
  workshopTurnEvents,
  workshopTurns,
} from "../db/schema/workshop";

/** `ws-…`, distinguishable from the runs (`cr-…`) they may be joined to. */
export function newWorkshopId(prefix: "ws" | "wt" | "we" | "wa"): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

export type WorkshopTurnRow = typeof workshopTurns.$inferSelect;
export type WorkshopSessionRow = typeof workshopSessions.$inferSelect;
export type WorkshopTurnEventRow = typeof workshopTurnEvents.$inferSelect;
export type WorkshopArtifactRow = typeof workshopArtifacts.$inferSelect;

export type WorkshopStore = {
  // ── shares (B14): the session row IS the share row — one live link per session ──
  /** Set or replace the session's live share (token hash + scope + window). */
  setShare(input: {
    channelId: string;
    tokenHash: string;
    scope: "preview" | "preview_download";
    expiresAt: Date | null;
    createdBy: string;
  }): Promise<void>;
  /** Revoke: shareRevokedAt set, the row kept (plan §3.7.2: auditable after it stops working). */
  revokeShare(channelId: string): Promise<void>;
  /** The live share BY TOKEN HASH — the one read that starts from a bearer secret. */
  findLiveShareByTokenHash(tokenHash: string): Promise<
    | {
        channelId: string;
        botId: string;
        scope: "preview" | "preview_download";
        expiresAt: Date | null;
        revokedAt: Date | null;
      }
    | undefined
  >;

  // ── schedules (B16/B17) ─────────────────────────────────────────────────────
  /** Every schedule for a session, newest first; the panel's list. */
  listSchedules(sessionId: string): Promise<
    Array<{
      id: string;
      prompt: string;
      rrule: string;
      timezone: string | null;
      status: string;
      preapproved: unknown;
      lastRunAt: Date | null;
      nextRunAt: Date | null;
      createdAt: Date;
    }>
  >;
  /** Insert a compiled, validated schedule with its first due moment. */
  createSchedule(input: {
    id: string;
    sessionId: string;
    createdBy: string;
    prompt: string;
    rrule: string;
    timezone: string;
    preapproved: unknown;
    nextRunAt: Date;
  }): Promise<void>;
  /** One schedule by id, scoped to its session (the routes' ownership check). */
  scheduleById(
    id: string,
    sessionId: string,
  ): Promise<
    | {
        id: string;
        prompt: string;
        rrule: string;
        timezone: string | null;
        status: string;
        preapproved: unknown;
        nextRunAt: Date | null;
      }
    | undefined
  >;
  /** Patch a schedule's editable fields (prompt/recurrence/status/preapproval/nextRunAt). */
  updateSchedule(
    id: string,
    patch: {
      prompt?: string;
      rrule?: string;
      timezone?: string;
      status?: string;
      preapproved?: unknown;
      nextRunAt?: Date | null;
      lastRunAt?: Date | null;
    },
  ): Promise<void>;
  /** Delete a schedule and (by cascade) its runs. */
  deleteSchedule(id: string): Promise<void>;
  /** The recent runs across a session's schedules, newest first; the panel's history. */
  listScheduleRuns(
    sessionId: string,
    limit?: number,
  ): Promise<
    Array<{
      id: string;
      scheduleId: string;
      scheduledFor: Date;
      turnId: string | null;
      status: string;
      note: string | null;
      startedAt: Date | null;
      finishedAt: Date | null;
    }>
  >;

  // ── sessions ────────────────────────────────────────────────────────────────
  /** The session for a channel, created on first use; idempotent for concurrent callers. */
  getOrCreateSession(input: {
    channelId: string;
    botId: string;
    ownerUserId: string;
  }): Promise<WorkshopSessionRow>;
  /** The session by its own id, for the paths that address sessions directly (files, uploads). */
  sessionById(sessionId: string): Promise<WorkshopSessionRow | undefined>;
  /** The session by its channel, for the paths that address channels (routes, SSE). */
  sessionByChannel(channelId: string): Promise<WorkshopSessionRow | undefined>;
  /** Bump `last_activity_at`; the idle sweep reads it. */
  touchSession(sessionId: string, at?: Date): Promise<void>;

  // ── artifacts ───────────────────────────────────────────────────────────────
  insertArtifact(
    input: Omit<typeof workshopArtifacts.$inferInsert, "id" | "createdAt"> & {
      id?: string;
    },
  ): Promise<WorkshopArtifactRow>;
  listArtifacts(sessionId: string): Promise<WorkshopArtifactRow[]>;

  // ── turns ───────────────────────────────────────────────────────────────────
  /** Create a queued turn at the next turn_index; the insert is the enqueue. */
  enqueueTurn(input: {
    sessionId: string;
    prompt: string;
    initiator?: WorkshopTurnRow["initiator"];
  }): Promise<WorkshopTurnRow>;
  /** queued → running, only from queued: two enqueues racing on one session, one wins. */
  markRunning(turnId: string, at?: Date): Promise<boolean>;
  /** The runner is alive; the stale sweep reads this column. */
  heartbeat(turnId: string, at?: Date): Promise<void>;
  markSucceeded(
    turnId: string,
    patch: { usage?: WorkshopTurnRow["usage"] },
    at?: Date,
  ): Promise<boolean>;
  markFailed(turnId: string, error: string, at?: Date): Promise<boolean>;
  markCancelled(turnId: string, at?: Date): Promise<boolean>;
  getTurn(turnId: string): Promise<WorkshopTurnRow | undefined>;
  listTurns(sessionId: string): Promise<WorkshopTurnRow[]>;
  /**
   * Settle running turns whose heartbeat went quiet, each exactly once: the update is guarded
   * on `status = 'running'`, so two replicas scanning the same rows settle disjoint sets.
   */
  recoverStale(
    nowMs: number,
    staleAfterMs: number,
  ): Promise<Array<{ turnId: string; error: string }>>;

  // ── turn events ─────────────────────────────────────────────────────────────
  /** Append one event, taking the next seq for the turn. */
  appendEvent(input: {
    turnId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<WorkshopTurnEventRow>;
  /** The replay path: everything after `seq` for a turn, in order. */
  readEventsSince(
    turnId: string,
    seq: number,
    limit?: number,
  ): Promise<WorkshopTurnEventRow[]>;
};

/** Postgres's unique-violation: the (session_id, turn_index) race this store retries. */
const UNIQUE_VIOLATION = "23505";

export function createWorkshopStore(db: Database): WorkshopStore {
  return {
    async getOrCreateSession(input) {
      const existing = await db
        .select()
        .from(workshopSessions)
        .where(eq(workshopSessions.channelId, input.channelId))
        .limit(1);
      if (existing[0]) return existing[0];

      // Insert-or-return: two tabs opening the same channel's workshop at once both land here,
      // and the channel's unique index makes one of them the creator. ON CONFLICT DO NOTHING
      // keeps the loser from erroring; the re-select below hands both callers the same row.
      await db
        .insert(workshopSessions)
        .values({
          id: newWorkshopId("ws"),
          channelId: input.channelId,
          botId: input.botId,
          ownerUserId: input.ownerUserId,
        })
        .onConflictDoNothing();
      const rows = await db
        .select()
        .from(workshopSessions)
        .where(eq(workshopSessions.channelId, input.channelId))
        .limit(1);
      if (!rows[0]) {
        throw new Error(
          `workshop session for channel ${input.channelId} vanished between insert and read`,
        );
      }
      return rows[0];
    },

    async sessionById(sessionId) {
      const rows = await db
        .select()
        .from(workshopSessions)
        .where(eq(workshopSessions.id, sessionId))
        .limit(1);
      return rows[0];
    },

    async sessionByChannel(channelId) {
      const rows = await db
        .select()
        .from(workshopSessions)
        .where(eq(workshopSessions.channelId, channelId))
        .limit(1);
      return rows[0];
    },

    async touchSession(sessionId, at) {
      await db
        .update(workshopSessions)
        .set({ lastActivityAt: at ?? new Date() })
        .where(eq(workshopSessions.id, sessionId));
    },

    async insertArtifact(input) {
      const rows = await db
        .insert(workshopArtifacts)
        .values({ ...input, id: input.id ?? newWorkshopId("wa") })
        .returning();
      return rows[0];
    },

    async listArtifacts(sessionId) {
      return db
        .select()
        .from(workshopArtifacts)
        .where(eq(workshopArtifacts.sessionId, sessionId))
        .orderBy(asc(workshopArtifacts.createdAt));
    },

    async enqueueTurn(input) {
      // nextval by max+1 inside the insert's own expression: concurrent enqueues on one
      // session each take a distinct index without a round trip, and the session's unique
      // (session_id, turn_index) turns a lost race into a retryable error rather than a gap.
      // The retry is real, not the comment's intention: two people submitting on one channel
      // is a normal minute, and the loser's subquery sees the winner's row on the second try.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const rows = await db
            .insert(workshopTurns)
            .values({
              id: newWorkshopId("wt"),
              sessionId: input.sessionId,
              prompt: input.prompt,
              initiator: input.initiator ?? "person",
              turnIndex: sql`(select coalesce(max(${workshopTurns.turnIndex}), -1) + 1 from ${workshopTurns} where ${workshopTurns.sessionId} = ${input.sessionId})`,
            })
            .returning();
          return rows[0];
        } catch (error) {
          const candidate = error as { code?: string; errno?: string };
          if (
            candidate?.code !== UNIQUE_VIOLATION &&
            candidate?.errno !== UNIQUE_VIOLATION
          ) {
            throw error;
          }
          if (attempt === 2) throw error;
        }
      }
      throw new Error("unreachable");
    },

    async markRunning(turnId, at) {
      const rows = await db
        .update(workshopTurns)
        .set({ status: "running", runnerHeartbeatAt: at ?? new Date() })
        .where(
          and(eq(workshopTurns.id, turnId), eq(workshopTurns.status, "queued")),
        )
        .returning({ id: workshopTurns.id });
      return rows.length > 0;
    },

    async heartbeat(turnId, at) {
      await db
        .update(workshopTurns)
        .set({ runnerHeartbeatAt: at ?? new Date() })
        .where(
          and(
            eq(workshopTurns.id, turnId),
            eq(workshopTurns.status, "running"),
          ),
        );
    },

    async markSucceeded(turnId, patch, at) {
      const rows = await db
        .update(workshopTurns)
        .set({
          status: "succeeded",
          usage: patch.usage ?? {},
          finishedAt: at ?? new Date(),
        })
        .where(
          and(
            eq(workshopTurns.id, turnId),
            eq(workshopTurns.status, "running"),
          ),
        )
        .returning({ id: workshopTurns.id });
      return rows.length > 0;
    },

    async markFailed(turnId, error, at) {
      const rows = await db
        .update(workshopTurns)
        .set({ status: "failed", error, finishedAt: at ?? new Date() })
        .where(
          and(
            eq(workshopTurns.id, turnId),
            sql`${workshopTurns.status} IN ('queued', 'running')`,
          ),
        )
        .returning({ id: workshopTurns.id });
      return rows.length > 0;
    },

    async markCancelled(turnId, at) {
      const rows = await db
        .update(workshopTurns)
        .set({ status: "cancelled", finishedAt: at ?? new Date() })
        .where(
          and(
            eq(workshopTurns.id, turnId),
            sql`${workshopTurns.status} IN ('queued', 'running')`,
          ),
        )
        .returning({ id: workshopTurns.id });
      return rows.length > 0;
    },

    async getTurn(turnId) {
      const rows = await db
        .select()
        .from(workshopTurns)
        .where(eq(workshopTurns.id, turnId))
        .limit(1);
      return rows[0];
    },

    async listTurns(sessionId) {
      return db
        .select()
        .from(workshopTurns)
        .where(eq(workshopTurns.sessionId, sessionId))
        .orderBy(asc(workshopTurns.turnIndex));
    },

    async recoverStale(nowMs, staleAfterMs) {
      const cutoff = new Date(nowMs - staleAfterMs);
      // Guarded on running AND a quiet heartbeat: the second replica to arrive finds the row
      // already failed and returns an empty update, which is the whole "exactly once" story.
      const rows = await db
        .update(workshopTurns)
        .set({
          status: "failed",
          error: `runner heartbeat timed out after ${staleAfterMs}ms`,
          finishedAt: new Date(nowMs),
        })
        .where(
          and(
            eq(workshopTurns.status, "running"),
            lt(workshopTurns.runnerHeartbeatAt, cutoff),
          ),
        )
        .returning({ id: workshopTurns.id });
      return rows.map((row) => ({
        turnId: row.id,
        error: `runner heartbeat timed out after ${staleAfterMs}ms`,
      }));
    },

    async appendEvent(input) {
      // Same max+1 shape — and the same bounded retry — as enqueueTurn's index: the unique
      // (turn_id, seq) turns a lost race (a runner and a cancel/recover path appending at
      // once) into a retry whose subquery sees the winner's row, not a missing event.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const rows = await db
            .insert(workshopTurnEvents)
            .values({
              id: newWorkshopId("we"),
              turnId: input.turnId,
              type: input.type,
              payload: input.payload,
              seq: sql`(select coalesce(max(${workshopTurnEvents.seq}), 0) + 1 from ${workshopTurnEvents} where ${workshopTurnEvents.turnId} = ${input.turnId})`,
            })
            .returning();
          return rows[0];
        } catch (error) {
          const candidate = error as { code?: string; errno?: string };
          if (
            candidate?.code !== UNIQUE_VIOLATION &&
            candidate?.errno !== UNIQUE_VIOLATION
          ) {
            throw error;
          }
          if (attempt === 2) throw error;
        }
      }
      throw new Error("unreachable");
    },

    async readEventsSince(turnId, seq, limit = 500) {
      return db
        .select()
        .from(workshopTurnEvents)
        .where(
          and(
            eq(workshopTurnEvents.turnId, turnId),
            gt(workshopTurnEvents.seq, seq),
          ),
        )
        .orderBy(asc(workshopTurnEvents.seq))
        .limit(limit);
    },

    // ── shares (B14): guarded updates, the turn methods' own register ────────────
    async setShare(input) {
      await db
        .update(workshopSessions)
        .set({
          shareTokenHash: input.tokenHash,
          shareScope: input.scope,
          shareExpiresAt: input.expiresAt,
          shareRevokedAt: null,
          shareCreatedBy: input.createdBy,
          shareCreatedAt: new Date(),
        })
        .where(eq(workshopSessions.channelId, input.channelId));
    },

    async revokeShare(channelId) {
      await db
        .update(workshopSessions)
        .set({ shareRevokedAt: new Date() })
        .where(
          and(
            eq(workshopSessions.channelId, channelId),
            isNotNull(workshopSessions.shareTokenHash),
          ),
        );
    },

    async findLiveShareByTokenHash(tokenHash) {
      const rows = await db
        .select({
          channelId: workshopSessions.channelId,
          botId: workshopSessions.botId,
          scope: workshopSessions.shareScope,
          expiresAt: workshopSessions.shareExpiresAt,
          revokedAt: workshopSessions.shareRevokedAt,
        })
        .from(workshopSessions)
        // LIVE means live here: a revoked or expired share is not found by its token at
        // all, so a future caller that skips its own revokedAt check cannot be leaked a
        // withdrawn link. resolveShareActor re-checks anyway; both gates agree.
        .where(
          and(
            eq(workshopSessions.shareTokenHash, tokenHash),
            isNull(workshopSessions.shareRevokedAt),
            or(
              isNull(workshopSessions.shareExpiresAt),
              gt(workshopSessions.shareExpiresAt, sql`now()`),
            ),
          ),
        )
        .limit(1);
      return rows[0];
    },

    // ── schedules (B16/B17): the store owns rows, the routes own invariants ─────
    async listSchedules(sessionId) {
      return db
        .select({
          id: workshopSchedules.id,
          prompt: workshopSchedules.prompt,
          rrule: workshopSchedules.rrule,
          timezone: workshopSchedules.timezone,
          status: workshopSchedules.status,
          preapproved: workshopSchedules.preapproved,
          lastRunAt: workshopSchedules.lastRunAt,
          nextRunAt: workshopSchedules.nextRunAt,
          createdAt: workshopSchedules.createdAt,
        })
        .from(workshopSchedules)
        .where(
          and(
            eq(workshopSchedules.sessionId, sessionId),
            ne(workshopSchedules.status, "deleted"),
          ),
        )
        .orderBy(desc(workshopSchedules.createdAt));
    },

    async createSchedule(input) {
      await db.insert(workshopSchedules).values({
        id: input.id,
        sessionId: input.sessionId,
        createdBy: input.createdBy,
        prompt: input.prompt,
        rrule: input.rrule,
        timezone: input.timezone,
        status: "enabled",
        // The jsonb column wants a shape, the route hands a validated one; the cast is the
        // store's promise that the writer normalized before this call (B17's parsePreapproval).
        preapproved: input.preapproved as {
          paths: string[];
          tools: string[];
          maxTurnsPerRun: number;
        } | null,
        nextRunAt: input.nextRunAt,
      });
    },

    async scheduleById(id, sessionId) {
      const rows = await db
        .select({
          id: workshopSchedules.id,
          prompt: workshopSchedules.prompt,
          rrule: workshopSchedules.rrule,
          timezone: workshopSchedules.timezone,
          status: workshopSchedules.status,
          preapproved: workshopSchedules.preapproved,
          nextRunAt: workshopSchedules.nextRunAt,
        })
        .from(workshopSchedules)
        .where(
          and(
            eq(workshopSchedules.id, id),
            eq(workshopSchedules.sessionId, sessionId),
          ),
        )
        .limit(1);
      return rows[0];
    },

    async updateSchedule(id, patch) {
      await db
        .update(workshopSchedules)
        .set(
          // The patch is route-validated (B17's compiler and clamps); the column's $type is
          // the same shape spelled for drizzle, and this is the one place the two meet.
          // updatedAt rides along (the column has no trigger; deleteSchedule writes its own),
          // so a pause/resume or rule change is visible on the row.
          {
            ...(patch as Partial<typeof workshopSchedules.$inferInsert>),
            updatedAt: new Date(),
          },
        )
        .where(eq(workshopSchedules.id, id));
    },

    async deleteSchedule(id) {
      // Soft: the row stays for audit under status=deleted; the cascade only ever takes the
      // runs when the row itself goes (which this store never does).
      await db
        .update(workshopSchedules)
        .set({ status: "deleted", nextRunAt: null, updatedAt: new Date() })
        .where(eq(workshopSchedules.id, id));
    },

    async listScheduleRuns(sessionId, limit = 50) {
      return db
        .select({
          id: workshopScheduleRuns.id,
          scheduleId: workshopScheduleRuns.scheduleId,
          scheduledFor: workshopScheduleRuns.scheduledFor,
          turnId: workshopScheduleRuns.turnId,
          status: workshopScheduleRuns.status,
          note: workshopScheduleRuns.note,
          startedAt: workshopScheduleRuns.startedAt,
          finishedAt: workshopScheduleRuns.finishedAt,
        })
        .from(workshopScheduleRuns)
        .innerJoin(
          workshopSchedules,
          eq(workshopScheduleRuns.scheduleId, workshopSchedules.id),
        )
        .where(eq(workshopSchedules.sessionId, sessionId))
        .orderBy(desc(workshopScheduleRuns.scheduledFor))
        .limit(limit);
    },
  };
}
