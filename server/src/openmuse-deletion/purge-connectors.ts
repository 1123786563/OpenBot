import type { OpenConnectorOAuthClient } from "../openmuse-connectors/client";
import { PROVIDER_BY_CONNECTION_KIND } from "../openmuse-connectors/google-oauth";
import type { OpenMuseGoogleRows } from "../openmuse-connectors/store";
import { MODULE_GAP, MODULE_GAP_ERROR } from "./manifest";
import {
  OpenMusePurgeRefusedError,
  type OpenMuseAccountDeletionStore,
  type OpenMuseDeletionResourceRows,
  type StoredOpenMuseDeletionResource,
} from "./store";

/*
 * D07 (§9 cleanup): the manifest's connector rows drive vendor connection
 * deletion BEFORE the local connection row is removed. Each row walks the
 * D03-established delete-by-alias seam — but HERE a refusal blocks THIS row
 * only: the row lands `retryable_error` with the reason, its local
 * connection row survives, and the alias stays enumerated (the row is what
 * enumerateOwner lists) and blocked (D03's revocation pass already closed
 * the seat, so no provider call serves it) until a successful purge —
 * F-PURGE-2. The manifest is the arbiter: a row goes `deleted` only after
 * BOTH the vendor connection and the local row are gone, so a crash between
 * them leaves a revoked-but-listed seat, never a live grant whose record
 * vanished. CHOICE RECORDED (the plan's export note): the connectors store
 * had no removal seam, so D07 adds exactly one openmuse-connectors member —
 * the rows seam's `hardDeleteConnection` — the same shape D06's `hardDelete`
 * took on the files store. Repeat cleanup is idempotent: terminal rows are
 * skipped, and re-running the owner-scoped hard delete on an
 * already-removed row deletes nothing. The D01 fence stands independently:
 * however clean the seats, a deleted owner's start-authorize is refused
 * before any dial — the purge opens no reconnect path.
 */

/*
 * The kind↔provider mapping is the one bijection google-oauth.ts exports
 * (PROVIDER_BY_CONNECTION_KIND, shared with manifest.ts) — the manifest
 * row's kind is the purge's only provider information, the alias being a
 * one-way hash.
 */

/** What one purge pass decided — the admin route's whole truth. */
export type OpenMuseConnectorGrantPurgeReport = {
  userId: string;
  /** The aliases whose vendor connections were deleted this pass. */
  purged: string[];
  /** The connection ids whose local rows were hard-deleted this pass. */
  hardDeleted: string[];
  /** The rows that stayed retryable, each with its recorded reason. */
  retryable: Array<{ id: string; externalKey: string; lastError: string }>;
};

export function createOpenMuseConnectorGrantPurger(deps: {
  /** The manifest: the whole truth of what this deletion still owes. */
  rows: Pick<
    OpenMuseDeletionResourceRows,
    "listResources" | "markDeleted" | "markRetryable"
  >;
  /**
   * §9's phase gate: a restored (or missing) marker names a live account —
   * the walk refuses before it dials the vendor, so D05's restore can never
   * be undone by a stray purge. A completed tombstone still walks: it is
   * the idempotent no-op over an emptied manifest.
   */
  marker: Pick<OpenMuseAccountDeletionStore, "get">;
  /** G05/D03's delete-by-alias seam: the vendor connection withdrawal. */
  client: Pick<OpenConnectorOAuthClient, "deleteConnection">;
  /** The one openmuse-connectors member D07 adds: owner-scoped hard row delete. */
  connections: Pick<OpenMuseGoogleRows, "hardDeleteConnection">;
}) {
  /**
   * One walk. `attempt` picks which not-yet-deleted rows this pass touches;
   * each row's vendor deletion, row removal and manifest transition run in
   * that order, so a pass interrupted anywhere converges on the next one.
   */
  async function walk(
    userId: string,
    attempt: (state: StoredOpenMuseDeletionResource["state"]) => boolean,
  ): Promise<OpenMuseConnectorGrantPurgeReport> {
    const marker = await deps.marker.get(userId);
    if (!marker || marker.phase === "restored")
      throw new OpenMusePurgeRefusedError(userId);
    const resources = (await deps.rows.listResources(userId)).filter(
      (row) => row.kind in PROVIDER_BY_CONNECTION_KIND,
    );
    const report: OpenMuseConnectorGrantPurgeReport = {
      userId,
      purged: [],
      hardDeleted: [],
      retryable: [],
    };
    for (const row of resources) {
      if (row.state === "deleted" || !attempt(row.state)) continue;
      // A gap row's externalKey is "" and its id names no connection row —
      // a tolerated no-op must never close it. It stays retryable and
      // operator-visible until a manifest rebuild re-enumerates the kind.
      if (row.id === MODULE_GAP) {
        await deps.rows.markRetryable(
          userId,
          row.kind,
          row.id,
          MODULE_GAP_ERROR,
          row.externalKey,
        );
        report.retryable.push({
          id: row.id,
          externalKey: row.externalKey,
          lastError: MODULE_GAP_ERROR,
        });
        continue;
      }
      try {
        // Vendor first: the withdrawal must precede the row's removal.
        await deps.client.deleteConnection(
          PROVIDER_BY_CONNECTION_KIND[row.kind],
          row.externalKey,
        );
        await deps.connections.hardDeleteConnection(userId, row.id);
        await deps.rows.markDeleted(userId, row.kind, row.id, row.externalKey);
        report.purged.push(row.externalKey);
        report.hardDeleted.push(row.id);
      } catch (error) {
        const lastError =
          error instanceof Error ? error.message : String(error);
        await deps.rows.markRetryable(
          userId,
          row.kind,
          row.id,
          lastError,
          row.externalKey,
        );
        report.retryable.push({
          id: row.id,
          externalKey: row.externalKey,
          lastError,
        });
      }
    }
    return report;
  }

  return {
    purgeConnectorGrants: (userId: string) => walk(userId, () => true),
    /** The §9 retry path: re-walks only the rows that landed retryable_error. */
    retryCleanup: (userId: string) =>
      walk(userId, (state) => state === "retryable_error"),
  };
}
