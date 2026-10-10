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
import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Database } from "../db/client";
import {
  workshopArtifacts,
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
  // ── sessions ────────────────────────────────────────────────────────────────
  /** The session for a channel, created on first use; idempotent for concurrent callers. */
  getOrCreateSession(input: {
    channelId: string;
    botId: string;
    ownerUserId: string;
  }): Promise<WorkshopSessionRow>;
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
    },

    async markRunning(turnId, at) {
      const rows = await db
        .update(workshopTurns)
        .set({ status: "running", runnerHeartbeatAt: at ?? new Date() })
        .where(and(eq(workshopTurns.id, turnId), eq(workshopTurns.status, "queued")))
        .returning({ id: workshopTurns.id });
      return rows.length > 0;
    },

    async heartbeat(turnId, at) {
      await db
        .update(workshopTurns)
        .set({ runnerHeartbeatAt: at ?? new Date() })
        .where(and(eq(workshopTurns.id, turnId), eq(workshopTurns.status, "running")));
    },

    async markSucceeded(turnId, patch, at) {
      const rows = await db
        .update(workshopTurns)
        .set({
          status: "succeeded",
          usage: patch.usage ?? {},
          finishedAt: at ?? new Date(),
        })
        .where(and(eq(workshopTurns.id, turnId), eq(workshopTurns.status, "running")))
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
      // Same max+1 shape as enqueueTurn's index: seq is per-turn, dense, and the unique
      // (turn_id, seq) keeps two appenders from inventing the same position.
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
    },

    async readEventsSince(turnId, seq, limit = 500) {
      return db
        .select()
        .from(workshopTurnEvents)
        .where(and(eq(workshopTurnEvents.turnId, turnId), gt(workshopTurnEvents.seq, seq)))
        .orderBy(asc(workshopTurnEvents.seq))
        .limit(limit);
    },
  };
}
