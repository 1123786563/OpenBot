import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  openmuseAccountDeletions,
  openmuseDeletionResources,
} from "../db/schema/openmuse-deletion";
import { MODULE_GAP } from "./manifest";

/*
 * The table definitions moved to db/schema/openmuse-deletion.ts (round 6 M7)
 * so drizzle-kit's bundled import graph no longer executes this module's
 * value-level graph (manifest → google-oauth → a load-time pino logger;
 * retention → restore → this file, a cycle). Re-exported here so every
 * existing import path keeps working unchanged.
 */
export { openmuseAccountDeletions, openmuseDeletionResources };

/*
 * The §9 account deletion marker (D01): ONE row per user is the fence. It is
 * written BEFORE any revocation work — the insert is the first act of
 * deletion — and every new authenticated request under the seams D01 owns
 * consults it and refuses while it exists. Cleanup (D02/D03) and the deletion
 * manifest (D04) run after and around it; the fence is not cleanup-dependent.
 */

/**
 * The marker itself, in the §9 shape. `phase` is "fenced" from the moment the
 * row exists; D02/D03 widen it as revocation progresses; D05's restore flips
 * it "restored" (the fence consults the phase — a restored row no longer
 * fences); D08's completed purge flips it "completed" — the terminal tombstone
 * D09's operator visibility reads. `restoreUntil` is D05's restore window,
 * null until the restore pins it. `resources` is D04's deletion manifest,
 * empty until D04 enumerates into it.
 */
export type StoredOpenMuseAccountDeletion = {
  userId: string;
  disabledAt: Date;
  phase: "fenced" | "restored" | "completed";
  restoreUntil: Date | null;
  resources: string[];
};

/**
 * §9's phase gate: D06/D07's walks refuse an account whose marker is
 * restored by D05 (or missing) — a lifted marker names a live account, and
 * no purge may destroy a live account's bytes or grants. A completed
 * tombstone is not refused: its emptied manifest walks as the idempotent
 * no-op.
 */
export class OpenMusePurgeRefusedError extends Error {
  constructor(userId: string) {
    super(
      `The deletion marker for ${userId} is not fenced; the purge is refused.`,
    );
    this.name = "OpenMusePurgeRefusedError";
  }
}

/** §9: the marker is the hook root every later enumeration hangs from. */
export type OpenMuseAccountDeletionResourceRef = {
  kind: "openmuse-account-deletion";
  id: string;
  externalKey: string;
};

export type OpenMuseAccountDeletionStore = {
  /**
   * §9: insert-once, atomically. The first call writes the marker and the
   * fence is live; a repeat over a still-fenced row returns it unchanged
   * (disabledAt included), and a repeat over a lifted one (restored,
   * completed) re-fences it — so however often the delete is replayed there
   * is exactly one marker, one first instant, and a live fence after every
   * ask.
   */
  delete(userId: string): Promise<StoredOpenMuseAccountDeletion>;
  get(userId: string): Promise<StoredOpenMuseAccountDeletion | null>;
  /**
   * D09 (§9): every marker there is — the deployment-wide roster the admin
   * cleanup visibility walks. Ordered stably (disabledAt, userId).
   */
  list(): Promise<StoredOpenMuseAccountDeletion[]>;
  /** What the fence consults: does this user carry a still-fencing marker. */
  isDisabled(userId: string): Promise<boolean>;
  /**
   * D05 (§9): the phase flip — `fenced` → `restored` with the window pinned,
   * one compare-and-swap. A repeat loses the CAS and answers the existing
   * row (the first deadline wins); a missing marker answers null.
   */
  restore(
    userId: string,
    restoreUntil: Date,
  ): Promise<StoredOpenMuseAccountDeletion | null>;
  /**
   * D08 (§9): the terminal flip — whatever the marker's phase, it lands
   * `completed`, the tombstone that outlives the emptied manifest. Idempotent:
   * a repeat re-answers the completed row; a missing marker answers null.
   */
  complete(userId: string): Promise<StoredOpenMuseAccountDeletion | null>;
  /** The §9 hook root: the marker ref itself, trivially, until D04 replaces it. */
  enumerateOwner(userId: string): Promise<OpenMuseAccountDeletionResourceRef[]>;
};

export function createOpenMuseAccountDeletionStore(
  database: Database,
): OpenMuseAccountDeletionStore {
  return {
    delete: async (userId) => {
      // One statement: the insert-once IS the atomicity. A concurrent repeat
      // loses the conflict and falls through to the read below, which sees
      // the row the winner wrote.
      const inserted = await database
        .insert(openmuseAccountDeletions)
        .values({ userId })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) return inserted[0];
      // A repeat over a lifted marker (restored by D05, or completed by D08)
      // re-engages the fence: the CAS flips the phase back to `fenced` and
      // clears the window, keeping the first disabledAt — the owner asked to
      // delete again, so the marker must fence again, not answer a lift.
      const reFenced = await database
        .update(openmuseAccountDeletions)
        .set({ phase: "fenced", restoreUntil: null })
        .where(
          and(
            eq(openmuseAccountDeletions.userId, userId),
            ne(openmuseAccountDeletions.phase, "fenced"),
          ),
        )
        .returning();
      if (reFenced[0]) return reFenced[0];
      const existing = await database
        .select()
        .from(openmuseAccountDeletions)
        .where(eq(openmuseAccountDeletions.userId, userId));
      if (!existing[0]) {
        throw new Error(
          `Account deletion marker for ${userId} vanished between insert and read.`,
        );
      }
      return existing[0];
    },
    get: async (userId) => {
      const rows = await database
        .select()
        .from(openmuseAccountDeletions)
        .where(eq(openmuseAccountDeletions.userId, userId));
      return rows[0] ?? null;
    },
    list: async () =>
      await database
        .select()
        .from(openmuseAccountDeletions)
        .orderBy(
          asc(openmuseAccountDeletions.disabledAt),
          asc(openmuseAccountDeletions.userId),
        ),
    /*
     * CHOICE RECORDED: a cache-free primary-key read on every request. A TTL
     * cache would delay the fence behind its window and "immediately" is the
     * contract; one indexed single-row SELECT per mobile request is the
     * cheapest correct answer, and the day it is not, the seam is this one
     * function with a write-through on delete. D05: only a still-`fenced`
     * row fences — a restored marker re-admits.
     */
    isDisabled: async (userId) => {
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
    // One statement: the phase flip IS the fence lift. A concurrent repeat
    // loses the CAS (phase no longer "fenced") and reads the winner's row.
    restore: async (userId, restoreUntil) => {
      const updated = await database
        .update(openmuseAccountDeletions)
        .set({ phase: "restored", restoreUntil })
        .where(
          and(
            eq(openmuseAccountDeletions.userId, userId),
            eq(openmuseAccountDeletions.phase, "fenced"),
          ),
        )
        .returning();
      if (updated[0]) return updated[0];
      const existing = await database
        .select()
        .from(openmuseAccountDeletions)
        .where(eq(openmuseAccountDeletions.userId, userId));
      return existing[0] ?? null;
    },
    // D08's terminal flip: completed is final, so the CAS excludes it alone
    // and a repeat re-reads the row the first call wrote.
    complete: async (userId) => {
      const updated = await database
        .update(openmuseAccountDeletions)
        .set({ phase: "completed" })
        .where(
          and(
            eq(openmuseAccountDeletions.userId, userId),
            ne(openmuseAccountDeletions.phase, "completed"),
          ),
        )
        .returning();
      if (updated[0]) return updated[0];
      const existing = await database
        .select()
        .from(openmuseAccountDeletions)
        .where(eq(openmuseAccountDeletions.userId, userId));
      return existing[0] ?? null;
    },
    enumerateOwner: async (userId) => {
      const marker = await database
        .select({ userId: openmuseAccountDeletions.userId })
        .from(openmuseAccountDeletions)
        .where(eq(openmuseAccountDeletions.userId, userId));
      return marker.map((row) => ({
        kind: "openmuse-account-deletion" as const,
        id: row.userId,
        externalKey: row.userId,
      }));
    },
  };
}

/**
 * The drizzle bookkeeping D02 and D03 share: append a revocation pass's
 * evidence entries to the marker's `resources` array. D04's manifest later
 * enumerates from it; the passes only record what landed.
 */
export function recordDeletionResources(
  database: Database,
): (userId: string, entries: string[]) => Promise<void> {
  // A literal, not a param: bun-sql types a bound string by the jsonb column
  // and the `::jsonb` cast then no-ops on the already-typed scalar, landing
  // the whole JSON text as ONE element. The quoted literal parses as the
  // array itself, so `||` concatenates entry by entry.
  const jsonbArrayLiteral = (entries: string[]) =>
    sql.raw(`'${JSON.stringify(entries).replaceAll("'", "''")}'::jsonb`);
  return async (userId, entries) => {
    await database
      .update(openmuseAccountDeletions)
      .set({
        resources: sql`${openmuseAccountDeletions.resources} || ${jsonbArrayLiteral(entries)}`,
      })
      .where(eq(openmuseAccountDeletions.userId, userId));
  };
}

/*
 * D04 (§9 manifest): one durable row per owner resource, hanging from the
 * marker by `manifestId` (the marker's userId — one marker, one manifest).
 * `externalKey` is part of the key because a File enumerates one row per
 * version and the byte-store path is the thing D06 purges; the empty string
 * is "no external key" so the composite PRIMARY KEY stays non-null.
 */
/** The §9 resource row as it is stored. */
export type StoredOpenMuseDeletionResource = {
  manifestId: string;
  kind: string;
  id: string;
  externalKey: string;
  state: "pending" | "deleted" | "retryable_error";
  lastError: string | null;
  updatedAt: Date;
};

/**
 * What D04's manifest writes and D06/D07/D08's cleanup transitions. A gap row
 * (a module without an enumerable seam) may arrive with its state and error
 * already decided; a normal resource arrives bare and lands `pending`.
 */
export type OpenMuseDeletionResourceInput = {
  kind: string;
  id: string;
  externalKey?: string;
  state?: "pending" | "retryable_error";
  lastError?: string;
};

export type OpenMuseDeletionResourceRows = {
  /**
   * §9 idempotency: insert-once. A rebuild (repeat delete) adds only the
   * rows that are missing and never touches the state of one that exists.
   */
  insertResources(
    manifestId: string,
    resources: OpenMuseDeletionResourceInput[],
  ): Promise<void>;
  /** The manifest's rows, ordered stably (kind, id, external key). */
  listResources(manifestId: string): Promise<StoredOpenMuseDeletionResource[]>;
  /** `pending`/`retryable_error` → `deleted`. A repeat is a no-op; deleted is terminal. */
  markDeleted(
    manifestId: string,
    kind: string,
    id: string,
    externalKey?: string,
  ): Promise<void>;
  /** → `retryable_error` with the reason. Never reopens a deleted row; a repeat overwrites the reason. */
  markRetryable(
    manifestId: string,
    kind: string,
    id: string,
    lastError: string,
    externalKey?: string,
  ): Promise<void>;
  /**
   * D04's recovery: a rebuild that re-enumerates a kind retires that kind's
   * gap rows — the fresh enumeration's rows (or a fresh gap, when it throws
   * again) replace the stale one. Insert-once alone never could, and an
   * unresolved gap would otherwise wedge D08's finalize forever.
   */
  resolveGaps(manifestId: string, kinds: string[]): Promise<void>;
  /**
   * D08 (§9): the completed purge empties the manifest — every row of this
   * manifestId removed in one statement. Called only once nothing is owed,
   * so the rows it drops are all terminal `deleted`.
   */
  hardDeleteResources(manifestId: string): Promise<void>;
};

export function createOpenMuseDeletionResourceRows(
  database: Database,
): OpenMuseDeletionResourceRows {
  return {
    insertResources: async (manifestId, resources) => {
      if (resources.length === 0) return;
      // PG's wire protocol caps one statement at 65535 bound parameters and
      // each row binds six, so a large owner's manifest (a File enumerates
      // one row per version) would overflow a single multi-row INSERT.
      // Fixed batches keep every statement far under the ceiling.
      const BATCH = 1_000;
      for (let start = 0; start < resources.length; start += BATCH) {
        await database
          .insert(openmuseDeletionResources)
          .values(
            resources.slice(start, start + BATCH).map((resource) => ({
              manifestId,
              kind: resource.kind,
              id: resource.id,
              externalKey: resource.externalKey ?? "",
              state: resource.state ?? "pending",
              lastError: resource.lastError ?? null,
            })),
          )
          .onConflictDoNothing();
      }
    },
    listResources: async (manifestId) =>
      await database
        .select()
        .from(openmuseDeletionResources)
        .where(eq(openmuseDeletionResources.manifestId, manifestId))
        .orderBy(
          asc(openmuseDeletionResources.kind),
          asc(openmuseDeletionResources.id),
          asc(openmuseDeletionResources.externalKey),
        ),
    markDeleted: async (manifestId, kind, id, externalKey) => {
      await database
        .update(openmuseDeletionResources)
        .set({ state: "deleted", lastError: null, updatedAt: new Date() })
        .where(
          and(
            eq(openmuseDeletionResources.manifestId, manifestId),
            eq(openmuseDeletionResources.kind, kind),
            eq(openmuseDeletionResources.id, id),
            eq(openmuseDeletionResources.externalKey, externalKey ?? ""),
            // Terminal: a repeat is a no-op and never churns updatedAt.
            ne(openmuseDeletionResources.state, "deleted"),
          ),
        );
    },
    markRetryable: async (manifestId, kind, id, lastError, externalKey) => {
      await database
        .update(openmuseDeletionResources)
        .set({ state: "retryable_error", lastError, updatedAt: new Date() })
        .where(
          and(
            eq(openmuseDeletionResources.manifestId, manifestId),
            eq(openmuseDeletionResources.kind, kind),
            eq(openmuseDeletionResources.id, id),
            eq(openmuseDeletionResources.externalKey, externalKey ?? ""),
            // Deleted stays closed; only not-yet-deleted rows go retryable.
            ne(openmuseDeletionResources.state, "deleted"),
          ),
        );
    },
    resolveGaps: async (manifestId, kinds) => {
      if (kinds.length === 0) return;
      await database
        .delete(openmuseDeletionResources)
        .where(
          and(
            eq(openmuseDeletionResources.manifestId, manifestId),
            eq(openmuseDeletionResources.id, MODULE_GAP),
            inArray(openmuseDeletionResources.kind, kinds),
          ),
        );
    },
    hardDeleteResources: async (manifestId) => {
      await database
        .delete(openmuseDeletionResources)
        .where(eq(openmuseDeletionResources.manifestId, manifestId));
    },
  };
}
