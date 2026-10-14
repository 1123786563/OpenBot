import type { AgentProfileStore } from "../agents/profile-store";
import type { ChannelStore } from "../channels/routes";
import {
  type OpenMuseGoogleOAuth,
  openmuseAlias,
  PROVIDER_BY_CONNECTION_KIND,
} from "../openmuse-connectors/google-oauth";
import type { OpenMuseFileStore } from "../openmuse-files/store";
import type { OpenMuseNotificationStore } from "../openmuse-notifications/store";
import type { OpenMuseGoalStore } from "../openmuse-personal/goals";
import type { OpenMuseIdeaStore } from "../openmuse-personal/ideas";
import type { OpenMuseMemoryStore } from "../openmuse-personal/memories";
import type { OpenMuseReviewedActionService } from "../openmuse-reviewed-actions/service";
import type { OpenMuseTaskStore } from "../openmuse-tasks/store";
import { sanitizeLastError } from "./retention";
import type {
  OpenMuseAccountDeletionStore,
  OpenMuseDeletionResourceInput,
  OpenMuseDeletionResourceRows,
} from "./store";

/*
 * D04 (§9 manifest): BEFORE any metadata removal, every owner resource is
 * enumerated through its module's §9 seam and written as one durable
 * {kind,id,externalKey?,state} row under the marker's manifestId. Cleanup
 * execution is D06/D07/D08's — this module records and never deletes. A
 * module whose seam is absent or throws is an explicit gap row, never a
 * silent omission, so the manifest is always the whole truth of what the
 * account deletion still owes.
 */

/** §9 resource states: `pending` until D06+ lands `deleted`, or records `retryable_error`. */
export type OpenMuseDeletionResourceState =
  | "pending"
  | "deleted"
  | "retryable_error";

/** The §9 manifest row as the delete route answers it. */
export type OpenMuseDeletionManifestResource = {
  kind: string;
  id: string;
  externalKey?: string;
  state: OpenMuseDeletionResourceState;
  lastError?: string;
};

/** The §9 manifest: the marker's identity and window, with its resource rows. */
export type OpenMuseDeletionManifest = {
  userId: string;
  disabledAt: string | null;
  restoreUntil: string | null;
  /**
   * The marker's own phase, answered truthfully: `fenced` while the
   * deletion stands, `restored`/`completed` re-answered from the marker
   * rather than asserted (the delete route's re-fence keeps the route path
   * `fenced`; a direct library call on a lifted marker must not lie).
   */
  phase: "fenced" | "restored" | "completed";
  resources: OpenMuseDeletionManifestResource[];
};

/**
 * The gap row's id — the one reserved id that is never a resource's own.
 * D08's walk exports it to refuse gap rows the way enumeration writes them.
 */
/**
 * The marker's own manifest kind — the one D08 resource no module seam owns.
 * Shared (round 6 M21): manifest.ts writes it, purge-relational.ts's
 * MARKER_KIND and finalize gate read it, one source instead of same-named
 * literals that can drift apart silently.
 */
export const OPENMUSE_ACCOUNT_DELETION_KIND = "openmuse-account-deletion";

export const MODULE_GAP = "<module-gap>";

/**
 * The reason D06/D07/D08's walks record on a gap row they leave retryable:
 * a gap names no resource, so only a manifest re-enumeration can close it.
 */
export const MODULE_GAP_ERROR =
  "module gap unresolved — re-enumerate the manifest";

/*
 * The connectors' enumerateOwner answers {kind,id} and drops the alias, and
 * its file is not this ticket's to widen — so the manifest re-derives the
 * alias from the kind through PROVIDER_BY_CONNECTION_KIND (google-oauth.ts,
 * the one source of the bijection), and the alias is deterministic in
 * (userId, provider), so the re-derivation is exact, not approximate.
 */

export function createOpenMuseDeletionManifest(deps: {
  rows: OpenMuseDeletionResourceRows;
  /** The marker every row hangs from; required — the route wrote it first. */
  marker: Pick<OpenMuseAccountDeletionStore, "get" | "enumerateOwner">;
  files?: Pick<OpenMuseFileStore, "enumerateOwner">;
  tasks?: Pick<OpenMuseTaskStore, "enumerateOwner">;
  reviewed?: Pick<OpenMuseReviewedActionService, "enumerateOwner">;
  goals?: Pick<OpenMuseGoalStore, "enumerateOwner">;
  ideas?: Pick<OpenMuseIdeaStore, "enumerateOwner">;
  memories?: Pick<OpenMuseMemoryStore, "enumerateOwner">;
  notifications?: Pick<OpenMuseNotificationStore, "enumerateOwner">;
  connectors?: Pick<OpenMuseGoogleOAuth, "enumerateOwner">;
  /**
   * Bots (and, keyed by the same id, their computers — no separate computer
   * profile row exists): enumerated through the profile store's
   * owner-scoped enumerateOwner seam — exactly what its owner-scoped
   * hardDelete removes, soft-deleted Bots included. `list` cannot answer
   * this: its visibility filter admits foreign public/shared Bots and hides
   * the owner's soft-deleted ones, deviating from the removal scope in both
   * directions.
   */
  agents?: Pick<AgentProfileStore, "enumerateOwner">;
  /**
   * Channels (their threads ride the channel row): enumerated through the
   * store's own §9 seam — owner-scoped by membership exactly as `hardDelete`
   * deletes, soft-deleted channels included, so a conversation the roster's
   * `list` hides in both partitions still owes its rows to the deletion.
   */
  channels?: Pick<ChannelStore, "enumerateOwner">;
}) {
  /** One seam's rows, or its explicit gap rows when it cannot answer. */
  async function collect(
    kinds: string[],
    enumerate: () => Promise<OpenMuseDeletionResourceInput[]>,
  ): Promise<OpenMuseDeletionResourceInput[]> {
    try {
      return await enumerate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return kinds.map((kind) => ({
        kind,
        id: MODULE_GAP,
        state: "retryable_error" as const,
        lastError: `enumeration failed: ${message}`,
      }));
    }
  }

  /** The gap rows a seam that is not wired owes — recorded, never skipped. */
  function gapRows(kinds: string[]): OpenMuseDeletionResourceInput[] {
    return kinds.map((kind) => ({
      kind,
      id: MODULE_GAP,
      state: "pending" as const,
      lastError: "enumeration seam missing — D04",
    }));
  }

  /*
   * The kinds this build actually enumerated (through collect — success or
   * throw). A rebuild retires these kinds' stale gap rows before the
   * insert-once below: a recovered enumeration replaces its gap with the
   * real rows, a still-failing one re-records it with a fresh reason —
   * otherwise insert-once would leave the stale gap wedged in place forever
   * and D08's finalize could never complete.
   */
  const attemptedKinds: string[] = [];
  function attempt(
    kinds: string[],
    enumerate: () => Promise<OpenMuseDeletionResourceInput[]>,
  ): Promise<OpenMuseDeletionResourceInput[]> {
    attemptedKinds.push(...kinds);
    return collect(kinds, enumerate);
  }

  async function agentResources(
    userId: string,
  ): Promise<OpenMuseDeletionResourceInput[]> {
    // The §9 seam: owner-scoped exactly as hardDelete removes — the
    // owner's soft-deleted Bots owed like any other, foreign public or
    // shared Bots never (they are their owner's deletion's rows).
    return (
      (await deps.agents?.enumerateOwner(userId))?.map((bot) => ({
        kind: bot.kind,
        id: bot.id,
      })) ?? []
    );
  }

  async function channelResources(
    userId: string,
  ): Promise<OpenMuseDeletionResourceInput[]> {
    return ((await deps.channels?.enumerateOwner(userId)) ?? []).map(
      (channel) => ({
        kind: "openmuse-channel" as const,
        id: channel.id,
      }),
    );
  }

  return {
    /**
     * §9 ordering: enumerate EVERY external key and owner resource first,
     * write the rows, then answer the whole manifest. Nothing here deletes —
     * D06/D07/D08 read these rows and transition them. A completed marker
     * (D08 emptied its manifest) re-answers the tombstone: the enumerations
     * run for nothing and no row is re-inserted, so a repeat delete cannot
     * resurrect what the purge removed.
     */
    async buildManifest(userId: string): Promise<OpenMuseDeletionManifest> {
      const existing = await deps.marker.get(userId);
      // A lifted marker is answered, never re-enumerated: `completed` emptied
      // its manifest, and `restored` (D05) deliberately keeps its rows — a
      // rebuild over either would assert a fence the marker no longer
      // carries. Both re-answer the marker's own phase with no rows named.
      if (existing && existing.phase !== "fenced") {
        return {
          userId,
          disabledAt: existing.disabledAt.toISOString(),
          restoreUntil: existing.restoreUntil?.toISOString() ?? null,
          phase: existing.phase,
          resources: [],
        };
      }
      /*
       * Round 6 (M19): the eleven enumerations are mutually independent (each
       * depends only on userId), so they fan out concurrently — the manifest
       * sits on the delete route's critical path (D04), and the serial chain
       * paid every query's latency as a sum. `attempt` pushes
       * attemptedKinds synchronously at invocation, so the Promise.all
       * elements below register their kinds in the same stable order and
       * resolveGaps/insertResources see the same attempted set as before.
       */
      const [
        markerRefs,
        fileRefs,
        taskRefs,
        reviewedRefs,
        goalRefs,
        ideaRefs,
        memoryRefs,
        notificationRefs,
        connectorRefs,
        agentRefs,
        channelRefs,
      ] = await Promise.all([
        deps.marker
          ? attempt(
              [OPENMUSE_ACCOUNT_DELETION_KIND],
              () => deps.marker.enumerateOwner(userId),
            )
          : gapRows([OPENMUSE_ACCOUNT_DELETION_KIND]),
        deps.files
          ? attempt(["openmuse-file"], async () => {
              const refs = await deps.files?.enumerateOwner(userId);
              return refs ?? [];
            })
          : gapRows(["openmuse-file"]),
        deps.tasks
          ? attempt(["openmuse-task"], async () => {
              const refs = await deps.tasks?.enumerateOwner(userId);
              return refs ?? [];
            })
          : gapRows(["openmuse-task"]),
        deps.reviewed
          ? attempt(["openmuse-reviewed-action"], async () => {
              const refs = await deps.reviewed?.enumerateOwner(userId);
              return refs ?? [];
            })
          : gapRows(["openmuse-reviewed-action"]),
        deps.goals
          ? attempt(["openmuse-goal"], async () => {
              const refs = await deps.goals?.enumerateOwner(userId);
              return refs ?? [];
            })
          : gapRows(["openmuse-goal"]),
        deps.ideas
          ? attempt(["openmuse-idea"], async () => {
              const refs = await deps.ideas?.enumerateOwner(userId);
              return refs ?? [];
            })
          : gapRows(["openmuse-idea"]),
        deps.memories
          ? attempt(["openmuse-memory"], async () => {
              const refs = await deps.memories?.enumerateOwner(userId);
              return refs ?? [];
            })
          : gapRows(["openmuse-memory"]),
        deps.notifications
          ? attempt(["openmuse-notification"], async () => {
              const refs = await deps.notifications?.enumerateOwner(userId);
              return refs ?? [];
            })
          : gapRows(["openmuse-notification"]),
        deps.connectors
          ? attempt(Object.keys(PROVIDER_BY_CONNECTION_KIND), async () => {
              const refs = await deps.connectors?.enumerateOwner(userId);
              return (refs ?? []).map((ref) => ({
                kind: ref.kind,
                id: ref.id,
                externalKey: openmuseAlias(
                  userId,
                  PROVIDER_BY_CONNECTION_KIND[ref.kind],
                ),
              }));
            })
          : gapRows(Object.keys(PROVIDER_BY_CONNECTION_KIND)),
        deps.agents
          ? attempt(["openmuse-bot"], () => agentResources(userId))
          : gapRows(["openmuse-bot"]),
        deps.channels
          ? attempt(["openmuse-channel"], () => channelResources(userId))
          : gapRows(["openmuse-channel"]),
      ]);

      const resources: OpenMuseDeletionResourceInput[] = [
        ...markerRefs,
        ...fileRefs,
        ...taskRefs,
        ...reviewedRefs,
        ...goalRefs,
        ...ideaRefs,
        ...memoryRefs,
        ...notificationRefs,
        ...connectorRefs,
        ...agentRefs,
        ...channelRefs,
      ];

      // The rebuild's recovery first: the kinds enumerated this pass retire
      // their stale gap rows (attempt's note above). Insert-once then adds
      // only what is missing and preserves every existing state — the
      // repeat delete's idempotency.
      await deps.rows.resolveGaps(userId, attemptedKinds);
      await deps.rows.insertResources(userId, resources);
      const [marker, stored] = await Promise.all([
        deps.marker.get(userId),
        deps.rows.listResources(userId),
      ]);
      return {
        userId,
        disabledAt: marker?.disabledAt.toISOString() ?? null,
        restoreUntil: marker?.restoreUntil?.toISOString() ?? null,
        phase: "fenced",
        resources: stored.map((row) => {
          // G06's display guard: a recorded reason may quote the credential
          // it failed on, and this answer leaves the server — the same
          // guard the cleanup view already runs on the same column.
          const lastError = sanitizeLastError(row.lastError);
          return {
            kind: row.kind,
            id: row.id,
            ...(row.externalKey ? { externalKey: row.externalKey } : {}),
            state: row.state,
            ...(lastError !== undefined ? { lastError } : {}),
          };
        }),
      };
    },
  };
}
