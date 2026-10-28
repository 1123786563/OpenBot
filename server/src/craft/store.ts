/**
 * Reads and writes for craft's three tables — the deliberate-boring store layer, workshop
 * store style: the manager owns decisions, this file owns rows.
 *
 * Method names map to onyx's db/build_session.py functions (`getOrCreateEmptySession` ←
 * get_empty_session_for_user + the create path, `reserveNextjsPort` ←
 * reserve_nextjs_port__no_commit, …). Guarded updates resolve races by row state: the
 * finalize-session-initialization CAS succeeds only while the row is still `initializing`, and
 * the port reservation retries on the partial unique index's violation.
 */

import { randomBytes } from "node:crypto";
import net from "node:net";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client";
import type { CraftMessageType, CraftSessionOrigin } from "../db/schema/craft";
import {
  craftMessages,
  craftSessions,
  craftSnapshots,
} from "../db/schema/craft";

/** Postgres unique-violation: a lost race on a guarded insert/update. */
const UNIQUE_VIOLATION = "23505";

/** `cs-` sessions, `cm-` messages, `csn-` snapshots, `cst-` tasks, `cstr-` runs. */
export function newCraftId(
  prefix: "cs" | "cm" | "csn" | "cst" | "cstr",
): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

export type CraftSessionRow = typeof craftSessions.$inferSelect;
export type CraftMessageRow = typeof craftMessages.$inferSelect;
export type CraftSnapshotRow = typeof craftSnapshots.$inferSelect;

export type CraftStore = {
  // ── sessions ────────────────────────────────────────────────────────────────
  /** The session by id, ownership-checked; bumps lastActivityAt (onyx update_session_activity). */
  getSession(
    sessionId: string,
    userId: string,
  ): Promise<CraftSessionRow | undefined>;
  /**
   * The same row WITHOUT the activity bump — the reads that must not feed the idle clock
   * (the sandbox-status poll would otherwise keep every open session awake forever).
   */
  findSession(
    sessionId: string,
    userId: string,
  ): Promise<CraftSessionRow | undefined>;
  /**
   * The row by id alone, no owner check, no activity bump — for callers that
   * authenticate by something OTHER than a user session and then take the
   * owner from the row (the MCP relay's session-tag attribution: the tag is
   * validated against the row; ownership checks belong to the requireUser
   * surfaces, not here).
   */
  findSessionById(sessionId: string): Promise<CraftSessionRow | undefined>;
  /** Sessions for the sidebar: user's INTERACTIVE rows, newest first. */
  listUserSessions(
    userId: string,
    limit?: number,
  ): Promise<Array<Omit<CraftSessionRow, never>>>;
  /**
   * The rows for exactly these ids (empty for none). Paged join faces fetch
   * what their page names instead of the newest-N window `listUserSessions`
   * serves, so an old-but-pinned row is reachable the same as a fresh one.
   */
  findSessionsByIds(
    sessionIds: readonly string[],
  ): Promise<readonly CraftSessionRow[]>;
  /** The user's empty (pre-provisioned) INTERACTIVE session, if one exists. */
  getEmptySessionForUser(userId: string): Promise<CraftSessionRow | undefined>;
  /** Insert an INITIALIZING row (reservation phase). */
  createSession(input: {
    userId: string;
    name?: string | null;
    agentProvider?: string | null;
    agentModel?: string | null;
    /** "INTERACTIVE" by default; scheduled/slack origins keep the row off the sidebar. */
    origin?: CraftSessionOrigin;
  }): Promise<CraftSessionRow>;
  /** Update mutable display fields. */
  updateSession(
    sessionId: string,
    patch: {
      name?: string | null;
      sharingScope?: "private" | "public_org";
      agentProvider?: string | null;
      agentModel?: string | null;
      opencodeSessionId?: string | null;
      skillsHash?: string | null;
      mcpConfigHash?: string | null;
      status?: "initializing" | "active" | "idle" | "failed";
    },
  ): Promise<CraftSessionRow | undefined>;
  /**
   * The reaper's guarded flip: active → idle only while the row is STILL quiet past `before`.
   * One CAS standing in for onyx's second still-idle scan — activity that landed between the
   * sweep's list read and now refuses the flip. Unlike updateSession it does not stamp
   * lastActivityAt: the row keeps its honest last-activity time, not the sleep time.
   */
  markSessionIdleIfStillIdle(sessionId: string, before: Date): Promise<boolean>;
  /** Bump lastActivityAt — onyx did this with an ORM onupdate hook; here it's explicit. */
  updateSessionActivity(sessionId: string, at?: Date): Promise<void>;
  /** The CAS core: initializing → active|failed, with the resolved runtime ids. */
  finalizeSessionInitialization(input: {
    sessionId: string;
    toStatus: "active" | "failed";
    opencodeSessionId?: string | null;
    skillsHash?: string | null;
    mcpConfigHash?: string | null;
  }): Promise<boolean>;
  /**
   * The repair path's claim: failed → initializing, guarded the same way the
   * finalize CAS is (one row state, `.returning()`-length verdict) — exactly
   * one concurrent repair owns the rebuild, and the provisioning envelope's
   * finalize CAS can then match. False when the row is no longer `failed`.
   */
  resetFailedSessionForRepair(sessionId: string): Promise<boolean>;
  /** Write a freshly resolved opencode_session_id back (stale-404 remint). */
  persistOpencodeSessionId(
    sessionId: string,
    opencodeSessionId: string,
  ): Promise<void>;
  /** Reserve a webapp port on the row; retries on unique-index collision. */
  reserveNextjsPort(input: {
    userId: string;
    sessionId: string;
    portStart: number;
    portEnd: number;
  }): Promise<number>;
  /**
   * Deletes the session's snapshot rows FIRST, inside the ownership-verified call, and
   * returns them so the caller can free their blobs. The object store has no FK: if the
   * row delete's cascade dropped the snapshot rows first, the archives would be orphans
   * nothing could ever free again.
   */
  deleteSession(
    sessionId: string,
    userId: string,
  ): Promise<{ deleted: boolean; snapshots: CraftSnapshotRow[] }>;

  // ── messages ────────────────────────────────────────────────────────────────
  createMessage(input: {
    sessionId: string;
    type: CraftMessageType;
    turnIndex: number;
    messageMetadata: Record<string, unknown>;
  }): Promise<CraftMessageRow>;
  /** Count persisted user messages — the next turn's turnIndex. */
  countUserMessages(sessionId: string): Promise<number>;
  /** The transcript read: one session ordered by (turn, time). */
  getMessages(sessionId: string): Promise<CraftMessageRow[]>;
  /** Update one message's metadata (plan upserts), scoped to its session. */
  updateMessage(
    sessionId: string,
    messageId: string,
    messageMetadata: Record<string, unknown>,
  ): Promise<CraftMessageRow | undefined>;
  /** Upsert the turn's agent_plan_update row: latest plan only, one row per turn. */
  upsertAgentPlan(input: {
    sessionId: string;
    turnIndex: number;
    planMetadata: Record<string, unknown>;
    existingPlanId?: string | null;
  }): Promise<CraftMessageRow>;
  /** Whether the session has any messages (pre-provisioned check). */
  sessionHasMessages(sessionId: string): Promise<boolean>;

  // ── snapshots ───────────────────────────────────────────────────────────────
  /** Record one packed workspace backup (the archive bytes live at storagePath, not here). */
  createSnapshot(input: {
    sessionId: string;
    storagePath: string;
    sizeBytes: number;
  }): Promise<CraftSnapshotRow>;
  /** The newest snapshot for a session — the only read sleep/wake makes. */
  getLatestSnapshot(sessionId: string): Promise<CraftSnapshotRow | undefined>;
  /** Every snapshot row for a session (oldest first) — the delete path's walk. */
  listSnapshots(sessionId: string): Promise<CraftSnapshotRow[]>;
  /** Delete every snapshot row, returning the deleted rows so blobs can be freed. */
  deleteSnapshots(sessionId: string): Promise<CraftSnapshotRow[]>;

  // ── idle-reaper sweep ───────────────────────────────────────────────────────
  /** ACTIVE sessions quiet past `before` — the reaper's snapshot-and-sleep candidates. */
  listIdleSessions(before: Date, limit?: number): Promise<CraftSessionRow[]>;
};

export function createCraftStore(db: Database): CraftStore {
  return {
    async findSession(sessionId, userId) {
      const rows = await db
        .select()
        .from(craftSessions)
        .where(
          and(
            eq(craftSessions.id, sessionId),
            eq(craftSessions.userId, userId),
          ),
        )
        .limit(1);
      return rows[0];
    },

    async findSessionById(sessionId) {
      const rows = await db
        .select()
        .from(craftSessions)
        .where(eq(craftSessions.id, sessionId))
        .limit(1);
      return rows[0];
    },

    async getSession(sessionId, userId) {
      const session = await this.findSession(sessionId, userId);
      if (!session) return undefined;
      const bumpedAt = new Date();
      await this.updateSessionActivity(sessionId, bumpedAt);
      // The answered row carries the bump: lastActivityAt just moved, and idle
      // decisions read it off this row.
      return { ...session, lastActivityAt: bumpedAt };
    },

    async listUserSessions(userId, limit = 100) {
      return db
        .select()
        .from(craftSessions)
        .where(
          and(
            eq(craftSessions.userId, userId),
            eq(craftSessions.origin, "INTERACTIVE"),
          ),
        )
        .orderBy(desc(craftSessions.createdAt))
        .limit(limit);
    },

    async findSessionsByIds(sessionIds) {
      if (sessionIds.length === 0) return [];
      return db
        .select()
        .from(craftSessions)
        .where(inArray(craftSessions.id, [...sessionIds]));
    },

    async getEmptySessionForUser(userId) {
      // "Empty" = no messages yet. Only INTERACTIVE sessions — non-interactive
      // origins skip port allocation and must not be handed to the craft UI.
      const rows = await db
        .select({ session: craftSessions })
        .from(craftSessions)
        .where(
          and(
            eq(craftSessions.userId, userId),
            eq(craftSessions.origin, "INTERACTIVE"),
            sql`NOT EXISTS (${db
              .select({ one: sql`1` })
              .from(craftMessages)
              .where(eq(craftMessages.sessionId, craftSessions.id))
              .limit(1)})`,
          ),
        )
        .limit(1);
      return rows[0]?.session;
    },

    async createSession(input) {
      const id = newCraftId("cs");
      const rows = await db
        .insert(craftSessions)
        .values({
          id,
          userId: input.userId,
          name: input.name ?? null,
          // Born initializing: only the reconcile that builds the workspace CASes to active.
          status: "initializing",
          origin: input.origin ?? "INTERACTIVE",
          agentProvider: input.agentProvider ?? null,
          agentModel: input.agentModel ?? null,
        })
        .returning();
      return rows[0];
    },

    async updateSession(sessionId, patch) {
      const rows = await db
        .update(craftSessions)
        .set({ ...patch, lastActivityAt: new Date() })
        .where(eq(craftSessions.id, sessionId))
        .returning();
      return rows[0];
    },

    async markSessionIdleIfStillIdle(sessionId, before) {
      const rows = await db
        .update(craftSessions)
        .set({ status: "idle" })
        .where(
          and(
            eq(craftSessions.id, sessionId),
            eq(craftSessions.status, "active"),
            lt(craftSessions.lastActivityAt, before),
          ),
        )
        .returning({ id: craftSessions.id });
      return rows.length === 1;
    },

    async updateSessionActivity(sessionId, at = new Date()) {
      await db
        .update(craftSessions)
        .set({ lastActivityAt: at })
        .where(eq(craftSessions.id, sessionId));
    },

    async finalizeSessionInitialization(input) {
      const rows = await db
        .update(craftSessions)
        .set({
          status: input.toStatus,
          ...(input.opencodeSessionId !== undefined &&
          input.opencodeSessionId !== null
            ? { opencodeSessionId: input.opencodeSessionId }
            : {}),
          ...(input.skillsHash !== undefined && input.skillsHash !== null
            ? { skillsHash: input.skillsHash }
            : {}),
          ...(input.mcpConfigHash !== undefined && input.mcpConfigHash !== null
            ? { mcpConfigHash: input.mcpConfigHash }
            : {}),
        })
        .where(
          and(
            eq(craftSessions.id, input.sessionId),
            eq(craftSessions.status, "initializing"),
          ),
        )
        .returning({ id: craftSessions.id });
      // False when the session already left initializing (a concurrent repair
      // finished first) — the caller's runtime state must not be recorded.
      return rows.length === 1;
    },

    async resetFailedSessionForRepair(sessionId) {
      const rows = await db
        .update(craftSessions)
        .set({ status: "initializing" })
        .where(
          and(
            eq(craftSessions.id, sessionId),
            eq(craftSessions.status, "failed"),
          ),
        )
        .returning({ id: craftSessions.id });
      // False when the row is no longer failed — another repair already
      // claimed the rebuild (or the row moved on); this attempt must not
      // provision over it.
      return rows.length === 1;
    },

    async persistOpencodeSessionId(sessionId, opencodeSessionId) {
      await db
        .update(craftSessions)
        .set({ opencodeSessionId, lastActivityAt: new Date() })
        .where(
          and(
            eq(craftSessions.id, sessionId),
            sql`${craftSessions.opencodeSessionId} IS DISTINCT FROM ${opencodeSessionId}`,
          ),
        );
    },

    async reserveNextjsPort(input) {
      // Ports only collide within one user's sandbox, so both the scan and the
      // partial unique index are per-user. The OS bind probe filters ports in use
      // outside the database; the index is the durable half under concurrency.
      const allocated = new Set(
        (
          await db
            .select({ port: craftSessions.nextjsPort })
            .from(craftSessions)
            .where(
              and(
                eq(craftSessions.userId, input.userId),
                isNotNull(craftSessions.nextjsPort),
              ),
            )
        )
          .map((row) => row.port)
          .filter((port): port is number => port !== null),
      );

      for (let port = input.portStart; port < input.portEnd; port += 1) {
        if (allocated.has(port) || !(await isPortAvailable(port))) continue;
        try {
          const rows = await db
            .update(craftSessions)
            .set({ nextjsPort: port })
            .where(eq(craftSessions.id, input.sessionId))
            .returning({ port: craftSessions.nextjsPort });
          if (rows.length === 1) return port;
          // Zero rows is not "this port is gone": the update only fails to land
          // when the session row itself is gone (a concurrent delete). Naming it
          // keeps "range exhausted" (retryable) apart from "no such session" (not).
          throw new Error(
            `Session ${input.sessionId} no longer exists; no port to reserve.`,
          );
        } catch (error) {
          if (
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            (error as { code?: unknown }).code === UNIQUE_VIOLATION
          ) {
            continue; // concurrent reservation won this port — next
          }
          throw error;
        }
      }
      throw new Error(
        `No available ports in range [${input.portStart}, ${input.portEnd})`,
      );
    },

    async deleteSession(sessionId, userId) {
      // The ownership verdict comes FIRST: snapshot rows are keyed by session alone, so
      // deleting them before knowing the caller owns the session would let a non-owner
      // name another person's session and strip its archives.
      const [owned] = await db
        .select({ id: craftSessions.id })
        .from(craftSessions)
        .where(
          and(
            eq(craftSessions.id, sessionId),
            eq(craftSessions.userId, userId),
          ),
        )
        .limit(1);
      if (!owned) return { deleted: false, snapshots: [] };
      const snapshots = await db
        .delete(craftSnapshots)
        .where(eq(craftSnapshots.sessionId, sessionId))
        .returning();
      const rows = await db
        .delete(craftSessions)
        .where(
          and(
            eq(craftSessions.id, sessionId),
            eq(craftSessions.userId, userId),
          ),
        )
        .returning({ id: craftSessions.id });
      return { deleted: rows.length === 1, snapshots };
    },

    async createMessage(input) {
      const rows = await db
        .insert(craftMessages)
        .values({
          id: newCraftId("cm"),
          sessionId: input.sessionId,
          turnIndex: input.turnIndex,
          type: input.type,
          messageMetadata: input.messageMetadata,
        })
        .returning();
      return rows[0];
    },

    async countUserMessages(sessionId) {
      const rows = await db
        .select({ value: count() })
        .from(craftMessages)
        .where(
          and(
            eq(craftMessages.sessionId, sessionId),
            eq(craftMessages.type, "user"),
          ),
        );
      return Number(rows[0]?.value ?? 0);
    },

    async getMessages(sessionId) {
      return db
        .select()
        .from(craftMessages)
        .where(eq(craftMessages.sessionId, sessionId))
        .orderBy(asc(craftMessages.turnIndex), asc(craftMessages.createdAt));
    },

    async updateMessage(sessionId, messageId, messageMetadata) {
      const rows = await db
        .update(craftMessages)
        .set({ messageMetadata })
        // Scoped: a stale/polluted plan id must never rewrite another session's row.
        .where(
          and(
            eq(craftMessages.id, messageId),
            eq(craftMessages.sessionId, sessionId),
          ),
        )
        .returning();
      return rows[0];
    },

    async upsertAgentPlan(input) {
      if (input.existingPlanId) {
        const updated = await this.updateMessage(
          input.sessionId,
          input.existingPlanId,
          input.planMetadata,
        );
        if (updated) return updated;
      }
      // Find this turn's existing plan row by packet type (the custom jsonb
      // keeps `->>` working — the reason that column type was chosen).
      const existing = await db
        .select({ id: craftMessages.id })
        .from(craftMessages)
        .where(
          and(
            eq(craftMessages.sessionId, input.sessionId),
            eq(craftMessages.turnIndex, input.turnIndex),
            sql`${craftMessages.messageMetadata}->>'type' = 'agent_plan_update'`,
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        const updated = await this.updateMessage(
          input.sessionId,
          existing[0].id,
          input.planMetadata,
        );
        if (updated) return updated;
      }
      return this.createMessage({
        sessionId: input.sessionId,
        type: "assistant",
        turnIndex: input.turnIndex,
        messageMetadata: input.planMetadata,
      });
    },

    async sessionHasMessages(sessionId) {
      const rows = await db
        .select({ one: sql<number>`1` })
        .from(craftMessages)
        .where(eq(craftMessages.sessionId, sessionId))
        .limit(1);
      return rows.length > 0;
    },

    // ── snapshots ─────────────────────────────────────────────────────────────
    async createSnapshot(input) {
      const rows = await db
        .insert(craftSnapshots)
        .values({
          id: newCraftId("csn"),
          sessionId: input.sessionId,
          storagePath: input.storagePath,
          sizeBytes: input.sizeBytes,
        })
        .returning();
      return rows[0];
    },

    async getLatestSnapshot(sessionId) {
      const rows = await db
        .select()
        .from(craftSnapshots)
        .where(eq(craftSnapshots.sessionId, sessionId))
        .orderBy(desc(craftSnapshots.createdAt))
        .limit(1);
      return rows[0];
    },

    async listSnapshots(sessionId) {
      return db
        .select()
        .from(craftSnapshots)
        .where(eq(craftSnapshots.sessionId, sessionId))
        .orderBy(asc(craftSnapshots.createdAt));
    },

    async deleteSnapshots(sessionId) {
      return db
        .delete(craftSnapshots)
        .where(eq(craftSnapshots.sessionId, sessionId))
        .returning();
    },

    async listIdleSessions(before, limit = 100) {
      return db
        .select()
        .from(craftSessions)
        .where(
          and(
            eq(craftSessions.status, "active"),
            lt(craftSessions.lastActivityAt, before),
          ),
        )
        .orderBy(asc(craftSessions.lastActivityAt))
        .limit(limit);
    },
  };
}

/**
 * OS bind probe for the port reservation. Checks IPv4 and IPv6 wildcards so any listener on
 * the port is detected regardless of family — the dev server binds one or the other.
 */
function isPortAvailable(port: number): Promise<boolean> {
  const probe = (host: string) =>
    new Promise<boolean>((resolveProbe) => {
      const server = net.createServer();
      server.unref();
      server.once("error", () => resolveProbe(false));
      server.listen(port, host, () => {
        server.close(() => resolveProbe(true));
      });
    });
  return probe("0.0.0.0").then((ipv4Open) =>
    ipv4Open ? probe("::") : Promise.resolve(false),
  );
}
