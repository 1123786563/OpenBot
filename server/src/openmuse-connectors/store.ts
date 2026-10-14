import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  type OpenMuseGoogleConnectionRow,
  type OpenMuseOauthPendingRow,
  openmuseGoogleConnections,
  openmuseOauthPending,
} from "../db/schema/openmuse";
import { openmuseAccountDeletions } from "../openmuse-deletion/store";
import type { OpenMuseGoogleProvider } from "./client";

/**
 * OpenMuse Google OAuth store (G01, contracts §4): the pending consents in
 * flight and the connections completed consents record. Row shapes as the
 * orchestration reads them; the seam below is injectable like F01/T01's, so
 * the state-machine tests run on data and no socket is ever opened.
 */
export type StoredOpenMusePending = {
  state: string;
  userId: string;
  provider: string;
  scopes: string[];
  returnUri: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  /** OpenBot's own one-time value, echoed back on the callback (G02). */
  nonce: string | null;
  /** What became of this consent: re-answered on replay, expired when swept. */
  outcome: "completed" | "expired" | null;
  /** The connection a completed consent recorded (G02 replay). */
  connectionId: string | null;
};

export type OpenMuseGoogleStatus =
  | "connected"
  | "refresh_required"
  | "disconnected"
  | "revoked";

export type StoredOpenMuseGoogleConnection = {
  id: string;
  userId: string;
  /** The Google service this consent granted — one row per provider per person (G03). */
  provider: OpenMuseGoogleProvider;
  accountEmail: string;
  status: OpenMuseGoogleStatus;
  grantedScopes: string[];
  generation: number;
  alias: string;
  connectedAt: Date;
  /**
   * G04: the sanitized sentence a failed refresh or an auth-expired provider
   * call leaves on the row — a FIXED string, never the vendor's own message,
   * because that message may quote the credential it failed on (§4: operator
   * signals carry no token). Null while the connection is healthy.
   */
  lastError: string | null;
};

/** The row seam the store runs on: drizzle in production, data in tests. */
export type OpenMuseGoogleRows = {
  insertPending(pending: StoredOpenMusePending): Promise<void>;
  getPending(state: string): Promise<StoredOpenMusePending | null>;
  /**
   * Spend a state exactly once: the update only lands when the row is still
   * unconsumed, so two racing callbacks produce one exchange and one refusal.
   */
  consumePending(state: string, consumedAt: Date): Promise<boolean>;
  /**
   * Pin a completed consent to the connection it recorded, so a replay of the
   * callback re-answers the recorded result instead of exchanging again (G02).
   */
  recordOutcome(
    state: string,
    outcome: { connectionId: string },
  ): Promise<void>;
  /**
   * Mark every unspent, unrecorded consent past its TTL expired. Returns the
   * rows swept, so a second sweep is observably a no-op.
   */
  sweepExpired(now: Date): Promise<number>;
  /** One connection by row id — the recorded outcome a replay re-answers. */
  getConnectionById(id: string): Promise<StoredOpenMuseGoogleConnection | null>;
  getConnection(
    userId: string,
    provider: OpenMuseGoogleProvider,
  ): Promise<StoredOpenMuseGoogleConnection | null>;
  /** Insert, or overwrite the person's one row for that provider with the generation bumped. */
  saveConnection(connection: StoredOpenMuseGoogleConnection): Promise<void>;
  /**
   * Write the person's one row for that provider EXACTLY as computed (G04) —
   * no generation bump, because the refresh path owns that arithmetic: the
   * same identity refreshes keep the generation, an identity change is the
   * only thing that increments it, and a failure only writes the status and
   * its sanitized sentence. `expectStatus` makes the write a
   * compare-and-set: it only lands while the row still holds that status,
   * so a writer racing a disconnect/refresh cannot silently roll the newer
   * state back to its own stale snapshot. `expectGeneration` tightens the
   * same CAS onto the SNAPSHOT the caller read (round 6 M14): a concurrent
   * refresh that healed the row in place — same status, new generation — is
   * not rolled back by a late downgrade.
   */
  overwriteConnection(
    connection: StoredOpenMuseGoogleConnection,
    expectStatus?: OpenMuseGoogleStatus,
    expectGeneration?: number,
  ): Promise<void>;
  /** This owner's connection ids, with the provider each belongs to. */
  listIdsByOwner(
    userId: string,
  ): Promise<Array<{ id: string; provider: OpenMuseGoogleProvider }>>;
  /**
   * D07 (§9): hard-delete the owner's connection row once the vendor's
   * connection under its alias is gone. Owner-scoped — a foreign id deletes
   * nothing; a repeat (the idempotent re-cleanup) deletes nothing either.
   */
  hardDeleteConnection(userId: string, connectionId: string): Promise<void>;
  /** §9 lifecycle seam; the deleted-owner fence (D01) wires the real marker. */
  ownerDisabled(userId: string): Promise<boolean>;
  disableOwner(userId: string): Promise<void>;
  restoreOwner(userId: string): Promise<void>;
};

/** The drizzle-backed row seam. */
export function createOpenMuseGoogleRows(
  database: Database,
): OpenMuseGoogleRows {
  return {
    async insertPending(pending) {
      await database.insert(openmuseOauthPending).values({
        state: pending.state,
        userId: pending.userId,
        provider: pending.provider,
        scopes: pending.scopes,
        returnUri: pending.returnUri,
        createdAt: pending.createdAt,
        expiresAt: pending.expiresAt,
        nonce: pending.nonce,
      });
    },
    async getPending(state) {
      const [row] = await database
        .select()
        .from(openmuseOauthPending)
        .where(eq(openmuseOauthPending.state, state))
        .limit(1);
      return row ? pendingOf(row) : null;
    },
    async consumePending(state, consumedAt) {
      const spent = await database
        .update(openmuseOauthPending)
        .set({ consumedAt })
        .where(
          and(
            eq(openmuseOauthPending.state, state),
            isNull(openmuseOauthPending.consumedAt),
          ),
        )
        .returning({ state: openmuseOauthPending.state });
      return spent.length > 0;
    },
    async recordOutcome(state, outcome) {
      await database
        .update(openmuseOauthPending)
        .set({ outcome: "completed", connectionId: outcome.connectionId })
        .where(eq(openmuseOauthPending.state, state));
    },
    async sweepExpired(now) {
      const swept = await database
        .update(openmuseOauthPending)
        .set({ outcome: "expired" })
        .where(
          and(
            isNull(openmuseOauthPending.consumedAt),
            isNull(openmuseOauthPending.outcome),
            lt(openmuseOauthPending.expiresAt, now),
          ),
        )
        .returning({ state: openmuseOauthPending.state });
      return swept.length;
    },
    async getConnectionById(id) {
      const [row] = await database
        .select()
        .from(openmuseGoogleConnections)
        .where(eq(openmuseGoogleConnections.id, id))
        .limit(1);
      return row ? connectionOf(row) : null;
    },
    async getConnection(userId, provider) {
      const [row] = await database
        .select()
        .from(openmuseGoogleConnections)
        .where(
          and(
            eq(openmuseGoogleConnections.userId, userId),
            eq(openmuseGoogleConnections.provider, provider),
          ),
        )
        .limit(1);
      return row ? connectionOf(row) : null;
    },
    async saveConnection(connection) {
      await database
        .insert(openmuseGoogleConnections)
        .values({
          id: connection.id,
          userId: connection.userId,
          provider: connection.provider,
          accountEmail: connection.accountEmail,
          status: connection.status,
          grantedScopes: connection.grantedScopes,
          generation: connection.generation,
          alias: connection.alias,
          connectedAt: connection.connectedAt,
          lastError: connection.lastError,
        })
        .onConflictDoUpdate({
          target: [
            openmuseGoogleConnections.userId,
            openmuseGoogleConnections.provider,
          ],
          set: {
            accountEmail: connection.accountEmail,
            status: connection.status,
            grantedScopes: connection.grantedScopes,
            // A reconnect is a new generation of the same consent seat (§4).
            generation: sql`${openmuseGoogleConnections.generation} + 1`,
            alias: connection.alias,
            connectedAt: connection.connectedAt,
            lastError: connection.lastError,
          },
        });
    },
    async overwriteConnection(connection, expectStatus, expectGeneration) {
      await database
        .update(openmuseGoogleConnections)
        .set({
          accountEmail: connection.accountEmail,
          status: connection.status,
          grantedScopes: connection.grantedScopes,
          generation: connection.generation,
          alias: connection.alias,
          connectedAt: connection.connectedAt,
          lastError: connection.lastError,
        })
        .where(
          and(
            eq(openmuseGoogleConnections.userId, connection.userId),
            eq(openmuseGoogleConnections.provider, connection.provider),
            // The compare-and-set half: a row that moved off the status this
            // writer read is left to whoever moved it.
            ...(expectStatus
              ? [eq(openmuseGoogleConnections.status, expectStatus)]
              : []),
            // The snapshot half (M14): a row a concurrent refresh already
            // healed to a new generation is left to that refresh.
            ...(expectGeneration !== undefined
              ? [eq(openmuseGoogleConnections.generation, expectGeneration)]
              : []),
          ),
        );
    },
    async listIdsByOwner(userId) {
      const rows = await database
        .select({
          id: openmuseGoogleConnections.id,
          provider: openmuseGoogleConnections.provider,
        })
        .from(openmuseGoogleConnections)
        .where(eq(openmuseGoogleConnections.userId, userId));
      return rows;
    },
    async hardDeleteConnection(userId, connectionId) {
      await database
        .delete(openmuseGoogleConnections)
        .where(
          and(
            eq(openmuseGoogleConnections.userId, userId),
            eq(openmuseGoogleConnections.id, connectionId),
          ),
        );
    },
    /*
     * D01's marker table IS the deleted-owner fence, read directly the way
     * D02's task rows read it, phase-aware the same way (no assembly wiring
     * needed): the callback path is PUBLIC — outside the /api/mobile fence —
     * so this read is what refuses a deleted owner's late consent (D03),
     * while D05's restored marker re-admits the owner's fresh consent.
     */
    ownerDisabled: async (userId) => {
      const rows = await database
        .select({ userId: openmuseAccountDeletions.userId })
        .from(openmuseAccountDeletions)
        .where(
          and(
            eq(openmuseAccountDeletions.userId, userId),
            eq(openmuseAccountDeletions.phase, "fenced"),
          ),
        );
      return rows.length > 0;
    },
    async disableOwner() {},
    async restoreOwner() {},
  };
}

function pendingOf(row: OpenMuseOauthPendingRow): StoredOpenMusePending {
  return {
    state: row.state,
    userId: row.userId,
    provider: row.provider,
    scopes: row.scopes ?? [],
    returnUri: row.returnUri,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    nonce: row.nonce,
    outcome: row.outcome,
    connectionId: row.connectionId,
  };
}

function connectionOf(
  row: OpenMuseGoogleConnectionRow,
): StoredOpenMuseGoogleConnection {
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    accountEmail: row.accountEmail,
    status: row.status,
    grantedScopes: row.grantedScopes ?? [],
    generation: row.generation,
    alias: row.alias,
    connectedAt: row.connectedAt,
    lastError: row.lastError,
  };
}
