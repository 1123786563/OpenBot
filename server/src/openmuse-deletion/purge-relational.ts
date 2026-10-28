import type { AgentProfileStore } from "../agents/profile-store";
import type { ChannelStore } from "../channels/routes";
import { PROVIDER_BY_CONNECTION_KIND } from "../openmuse-connectors/google-oauth";
import type { OpenMuseNotificationStore } from "../openmuse-notifications/store";
import type { OpenMuseGoalStore } from "../openmuse-personal/goals";
import type { OpenMuseIdeaStore } from "../openmuse-personal/ideas";
import type { OpenMuseMemoryStore } from "../openmuse-personal/memories";
import type { OpenMuseReviewedActionService } from "../openmuse-reviewed-actions/service";
import type { OpenMuseTaskStore } from "../openmuse-tasks/store";
import {
  MODULE_GAP,
  MODULE_GAP_ERROR,
  OPENMUSE_ACCOUNT_DELETION_KIND,
} from "./manifest";
import { OPENMUSE_FILE_METADATA_KIND } from "./purge";
import { sanitizeLastError } from "./retention";
import type {
  OpenMuseAccountDeletionStore,
  OpenMuseDeletionResourceRows,
  StoredOpenMuseDeletionResource,
} from "./store";

/*
 * D08 (§9 final relational cleanup): the manifest's remaining kinds drive
 * removal of the relational rows once D06's bytes and D07's grants are
 * terminal. Precondition (the manifest is the arbiter at every step): every
 * file and connector row must already be `deleted` — else the outcome is a
 * 409 naming the rows that still owe, and nothing is touched. The walk then
 * takes one kind at a time, in the manifest's own stable kind order, and
 * hands each kind's not-yet-deleted ids to that module's removal seam as ONE
 * batch: every seam here is a single owner-scoped statement (or, for Bots,
 * one transaction), so a batch is atomic — CHOICE RECORDED, the batching
 * this ticket lands. A failure mid-walk lands that kind's unfinished rows
 * `retryable_error` with the reason and the walk CONTINUES, D06/D07's
 * convention: one module's DB failure never holds its neighbours hostage,
 * already-deleted kinds stay deleted, and the manifest retains everything
 * still owed for the retry. Completion is final: the marker's own row lands
 * `deleted`, the manifest empties, and the marker's phase flips `completed`.
 * Repeat cleanup is idempotent — terminal rows are skipped, the seams
 * delete nothing for ids that are gone, and the finalized state re-answers.
 */

/*
 * The externals D08 waits on: D06's byte kinds and D07's grant kinds, all
 * derived from their owners (round 6 M21) — the metadata debt from purge.ts's
 * exported constant (the D06 writer and this gate share one string), and the
 * connector kinds from the manifest's own PROVIDER_BY_CONNECTION_KIND keys,
 * so a provider added there joins this gate with no second literal to
 * update.
 */
const EXTERNAL_KINDS = new Set([
  "openmuse-file",
  // D06's durable metadata debt: the bytes are gone, the openmuse_files row
  // is not — finalize waits for the pass that completes the hard delete.
  OPENMUSE_FILE_METADATA_KIND,
  ...Object.keys(PROVIDER_BY_CONNECTION_KIND),
]);

/**
 * The manifest's own marker row — the one D08 resource no module seam owns.
 * It lands `deleted` at finalize, with the manifest, never before.
 */
const MARKER_KIND = OPENMUSE_ACCOUNT_DELETION_KIND;

/** What one purge pass decided — the admin route's whole truth. */
export type OpenMuseRelationalPurgeReport = {
  userId: string;
  /** The manifest rows whose module rows were removed and landed `deleted` this pass. */
  purged: Array<{ kind: string; id: string }>;
  /** The rows that stayed retryable, each with its recorded reason. */
  retryable: Array<{ kind: string; id: string; lastError: string }>;
  /** The finalize landed: the manifest emptied and the marker completed. */
  completed: boolean;
};

/** A row the precondition refused to walk past, named with its state. */
export type OpenMuseDeletionBlockedResource = {
  kind: string;
  id: string;
  state: StoredOpenMuseDeletionResource["state"];
  lastError?: string;
};

export type OpenMuseRelationalPurgeOutcome =
  | {
      status: 409;
      blocked: OpenMuseDeletionBlockedResource[];
      /**
       * §9's phase gate: set when the walk refused before touching anything
       * because the marker is not still `fenced` — a restored (or missing)
       * marker names a live account no purge may destroy.
       */
      refused?: string;
    }
  | { status: 200; report: OpenMuseRelationalPurgeReport };

export function createOpenMuseRelationalPurger(deps: {
  /** The manifest: the whole truth of what this deletion still owes. */
  rows: Pick<
    OpenMuseDeletionResourceRows,
    "listResources" | "markDeleted" | "markRetryable" | "hardDeleteResources"
  >;
  /**
   * D08's terminal flip — the marker's phase lands `completed` — and the
   * phase gate the walk opens with: only a still-`fenced` marker may be
   * purged, so D05's restore (phase `restored`, manifest rows deliberately
   * retained) can never be followed by a purge that destroys the live
   * account's relational rows and finalizes it beyond restoring.
   */
  marker: Pick<OpenMuseAccountDeletionStore, "get" | "complete">;
  /** The removal seams D08 calls, one per manifested kind (each emit-only, cited in place). */
  agents: Pick<AgentProfileStore, "hardDelete">;
  channels: Pick<ChannelStore, "hardDelete">;
  tasks: Pick<OpenMuseTaskStore, "hardDelete">;
  reviewed: Pick<OpenMuseReviewedActionService, "hardDelete">;
  goals: Pick<OpenMuseGoalStore, "hardDelete">;
  ideas: Pick<OpenMuseIdeaStore, "hardDelete">;
  memories: Pick<OpenMuseMemoryStore, "hardDelete">;
  notifications: Pick<OpenMuseNotificationStore, "hardDelete">;
}) {
  /*
   * Kind → seam, in the manifest's own stable kind order (listResources
   * sorts by kind asc), so the walk is deterministic and a partial pass's
   * report reads the same order every time.
   */
  const RELATIONAL_KINDS: Array<
    [string, (userId: string, ids: string[]) => Promise<void>]
  > = [
    ["openmuse-bot", (userId, ids) => deps.agents.hardDelete(userId, ids)],
    [
      "openmuse-channel",
      (userId, ids) => deps.channels.hardDelete(userId, ids),
    ],
    ["openmuse-goal", (userId, ids) => deps.goals.hardDelete(userId, ids)],
    ["openmuse-idea", (userId, ids) => deps.ideas.hardDelete(userId, ids)],
    ["openmuse-memory", (userId, ids) => deps.memories.hardDelete(userId, ids)],
    [
      "openmuse-notification",
      (userId, ids) => deps.notifications.hardDelete(userId, ids),
    ],
    [
      "openmuse-reviewed-action",
      (userId, ids) => deps.reviewed.hardDelete(userId, ids),
    ],
    ["openmuse-task", (userId, ids) => deps.tasks.hardDelete(userId, ids)],
  ];

  /**
   * One walk. `attempt` picks which not-yet-deleted rows this pass touches;
   * a pass interrupted anywhere converges on the next one, because only the
   * manifest's `deleted` transitions ever gate a seam call.
   */
  async function walk(
    userId: string,
    attempt: (state: StoredOpenMuseDeletionResource["state"]) => boolean,
  ): Promise<OpenMuseRelationalPurgeOutcome> {
    // §9's phase gate, first: a `restored` (or missing) marker names a live
    // account — nothing is walked, nothing is finalized, and the refusal
    // names the phase so the operator sees a state problem, not an
    // unfinished cleanup. A `completed` tombstone still walks: the manifest
    // it emptied answers the idempotent no-op, never new destruction.
    const marker = await deps.marker.get(userId);
    if (!marker || marker.phase === "restored") {
      return {
        status: 409 as const,
        blocked: [],
        refused: `The deletion marker for ${userId} is ${marker ? marker.phase : "missing"}; the purge is refused.`,
      };
    }
    const resources = await deps.rows.listResources(userId);
    // §9 precondition: D06's bytes and D07's grants must be terminal first —
    // the externals are gone before the relational rows that name them.
    const blocked = resources.filter(
      (row) => EXTERNAL_KINDS.has(row.kind) && row.state !== "deleted",
    );
    if (blocked.length > 0) {
      return {
        status: 409 as const,
        // G06's display guard, the same one the 200 report and the cleanup
        // view run: these are exactly the retryable rows whose recorded
        // reason may quote the credential it failed on, and the 409 is an
        // admin-facing exit like they are.
        blocked: blocked.map((row) => ({
          kind: row.kind,
          id: row.id,
          state: row.state,
          ...(row.lastError
            ? {
                lastError: sanitizeLastError(row.lastError) ?? row.lastError,
              }
            : {}),
        })),
      };
    }
    const report: OpenMuseRelationalPurgeReport = {
      userId,
      purged: [],
      retryable: [],
      completed: false,
    };
    for (const [kind, remove] of RELATIONAL_KINDS) {
      const owing = resources.filter(
        (row) =>
          row.kind === kind && row.state !== "deleted" && attempt(row.state),
      );
      // A gap row is a module that never answered enumeration — it names no
      // resource, so no seam is dialed and it never lands deleted; it stays
      // retryable and operator-visible until a rebuild re-enumerates. That
      // promise is real: the rebuild retires the kind's gap row first
      // (rows.resolveGaps) and re-inserts either the real rows or a fresh
      // gap, so no gap is wedged in place beyond one re-enumeration.
      for (const gap of owing.filter((row) => row.id === MODULE_GAP)) {
        await deps.rows.markRetryable(userId, kind, gap.id, MODULE_GAP_ERROR);
        report.retryable.push({
          kind,
          id: gap.id,
          lastError: MODULE_GAP_ERROR,
        });
      }
      const ids = owing
        .filter((row) => row.id !== MODULE_GAP)
        .map((row) => row.id);
      if (ids.length === 0) continue;
      // Rows already marked deleted this pass are remembered so a later
      // failure (the mark itself, or the seam call) cannot re-mark them
      // retryable: that would name one row in both report arrays and put a
      // "delete failed" reason on bytes that are already gone.
      const marked = new Set<string>();
      try {
        await remove(userId, ids);
        for (const row of owing) {
          if (row.id === MODULE_GAP) continue;
          await deps.rows.markDeleted(
            userId,
            row.kind,
            row.id,
            row.externalKey,
          );
          marked.add(row.id);
          report.purged.push({ kind, id: row.id });
        }
      } catch (error) {
        const lastError =
          error instanceof Error ? error.message : String(error);
        for (const row of owing) {
          if (row.id === MODULE_GAP || marked.has(row.id)) continue;
          await deps.rows.markRetryable(
            userId,
            row.kind,
            row.id,
            lastError,
            row.externalKey,
          );
          report.retryable.push({ kind, id: row.id, lastError });
        }
      }
    }
    // Finalize, only once NOTHING is owed but the marker's own row: it
    // lands deleted with the manifest, the manifest empties, the marker
    // completes. The marker's kind exempts nothing by itself — an
    // unresolved marker GAP row (it names no resource, so nothing can
    // delete it) must block completion and stay operator-visible until a
    // rebuild re-enumerates. A crash between the steps converges on the
    // next pass — every step is idempotent over the same manifest.
    const after = await deps.rows.listResources(userId);
    if (
      after.every(
        (row) =>
          row.state === "deleted" ||
          (row.kind === MARKER_KIND && row.id !== MODULE_GAP),
      )
    ) {
      await deps.rows.markDeleted(userId, MARKER_KIND, userId, userId);
      await deps.rows.hardDeleteResources(userId);
      await deps.marker.complete(userId);
      report.completed = true;
    }
    return { status: 200 as const, report };
  }

  return {
    purgeRelationalData: (userId: string) => walk(userId, () => true),
    /** The §9 retry path: re-walks only the rows that landed retryable_error. */
    retryCleanup: (userId: string) =>
      walk(userId, (state) => state === "retryable_error"),
  };
}
