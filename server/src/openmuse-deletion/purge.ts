import type { FileByteStore } from "../openmuse-files/bytes";
import type { OpenMuseFileStore } from "../openmuse-files/store";
import { MODULE_GAP, MODULE_GAP_ERROR } from "./manifest";
import {
  type OpenMuseAccountDeletionStore,
  type OpenMuseDeletionResourceRows,
  OpenMusePurgeRefusedError,
  type StoredOpenMuseDeletionResource,
} from "./store";

/*
 * D06 (§9 cleanup): the manifest's file rows drive deletion of original AND
 * derived bytes BEFORE the file metadata rows are removed. A row's
 * externalKey is the byte-store key — F01's FileByteStore seam
 * (openmuse-files/bytes.ts) already exports the delete, so D06 adds no
 * export for it; the ONE new openmuse-files member is the store's
 * `hardDelete`. A byte-store refusal lands the row `retryable_error` with
 * the reason (F-PURGE-1: the manifest retains the external key, then marks
 * it deleted — the relational row is never removed first) and never takes
 * its file's metadata with it: the manifest is the arbiter, so a file's
 * rows are hard-deleted only once EVERY one of its manifest rows is
 * `deleted`. CHOICE RECORDED: F03's user delete tombstones the row so
 * bytes survive the restore window; D06, the post-restoreUntil pass,
 * removes the rows outright — there is nothing left to keep them for.
 * Repeat cleanup is idempotent: terminal rows are skipped, and re-running
 * the owner-scoped hard delete on already-removed rows deletes nothing.
 */

/** What one purge pass decided — the admin route's whole truth. */
export type OpenMuseFileBytePurgeReport = {
  userId: string;
  /** The external keys whose byte objects left the store this pass. */
  purged: string[];
  /** The file ids whose metadata rows were hard-deleted this pass. */
  hardDeleted: string[];
  /** The rows that stayed retryable, each with its recorded reason. */
  retryable: Array<{ id: string; externalKey: string; lastError: string }>;
};

/**
 * The durable metadata-debt row's kind (round 6 M20, module-level): a file
 * whose bytes are gone and whose manifest rows are terminal `deleted`, but
 * whose openmuse_files row (name, external key — personal data) survived
 * the hard delete. D08's finalize waits on it like the other externals —
 * SHARED with purge-relational.ts's EXTERNAL_KINDS, so the D06 writer and
 * the D08 gate cannot drift apart on a renamed literal.
 */
export const OPENMUSE_FILE_METADATA_KIND = "openmuse-file-metadata";

export function createOpenMuseFileBytePurger(deps: {
  /** The manifest: the whole truth of what this deletion still owes. */
  rows: Pick<
    OpenMuseDeletionResourceRows,
    "insertResources" | "listResources" | "markDeleted" | "markRetryable"
  >;
  /**
   * §9's phase gate: a restored (or missing) marker names a live account —
   * the walk refuses before it touches a byte, so D05's restore can never
   * be undone by a stray purge. A completed tombstone still walks: it is
   * the idempotent no-op over an emptied manifest.
   */
  marker: Pick<OpenMuseAccountDeletionStore, "get">;
  /** F01's seam: delete by the key the manifest's externalKey names. */
  byteStore: Pick<FileByteStore, "delete">;
  /** The one openmuse-files export D06 adds: owner-scoped hard row delete. */
  files: Pick<OpenMuseFileStore, "hardDelete">;
}) {
  /**
   * §9's phase gate, re-asked as the walk proceeds: D05's restore rides the
   * same admin route face with nothing serializing the two, and the walk can
   * take real time on a large manifest. Re-reading before each irreversible
   * step is what keeps this module's own promise — restore can never be
   * undone by a stray purge — true mid-walk, not only at its start.
   */
  const assertFenced = async (userId: string): Promise<void> => {
    const marker = await deps.marker.get(userId);
    if (!marker || marker.phase === "restored")
      throw new OpenMusePurgeRefusedError(userId);
  };

  /**
   * One walk. `attempt` picks which not-yet-deleted rows this pass touches;
   * the metadata phase always surveys every file row, so a completed retry
   * still collects its file's rows, and a pass interrupted between the two
   * phases converges on the next one.
   */
  async function walk(
    userId: string,
    attempt: (state: StoredOpenMuseDeletionResource["state"]) => boolean,
  ): Promise<OpenMuseFileBytePurgeReport> {
    await assertFenced(userId);
    const resources = (await deps.rows.listResources(userId)).filter(
      (row) => row.kind === "openmuse-file",
    );
    const report: OpenMuseFileBytePurgeReport = {
      userId,
      purged: [],
      hardDeleted: [],
      retryable: [],
    };
    /*
     * Phase 1 — bytes before metadata, the §9 ordering D04's manifest
     * guaranteed by enumerating every external key first: each row's key
     * leaves the byte store; the row lands deleted or retryable_error.
     */
    const purgedKeys = new Set<string>();
    for (const row of resources) {
      if (row.state === "deleted" || !attempt(row.state)) continue;
      await assertFenced(userId);
      // A gap row's externalKey is "" — deleting it would aim the byte
      // store at its root. A gap names no resource: it stays retryable and
      // operator-visible until a manifest rebuild re-enumerates the kind.
      // The empty key itself is the dangerous condition (any row that
      // carries one aims the byte store at the root), so it widens the
      // guard beyond the reserved gap id.
      if (row.id === MODULE_GAP || row.externalKey === "") {
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
        await deps.byteStore.delete(row.externalKey);
        await deps.rows.markDeleted(userId, row.kind, row.id, row.externalKey);
        purgedKeys.add(row.externalKey);
        report.purged.push(row.externalKey);
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
    // Phase 2 — metadata: a file's rows go only when EVERY one of its
    // manifest rows is deleted; one retryable key holds them all. One
    // file's failure never holds its neighbours hostage: its rows carry
    // the reason in the report and the next pass re-surveys them (the
    // gate re-reads every file row, deleted or not).
    const fileIds = [...new Set(resources.map((row) => row.id))];
    for (const fileId of fileIds) {
      const fileRows = resources.filter((row) => row.id === fileId);
      if (
        fileRows.every(
          (row) => row.state === "deleted" || purgedKeys.has(row.externalKey),
        )
      ) {
        await assertFenced(userId);
        try {
          await deps.files.hardDelete(userId, fileId);
          // A previous pass's metadata debt closes with the delete it owed
          // (markDeleted over an absent row is the idempotent no-op).
          await deps.rows.markDeleted(
            userId,
            OPENMUSE_FILE_METADATA_KIND,
            fileId,
          );
          report.hardDeleted.push(fileId);
        } catch (error) {
          const lastError =
            error instanceof Error ? error.message : String(error);
          /*
           * The rows' own obligation (their bytes) is terminal deleted —
           * markRetryable never reopens it — so the metadata debt rides the
           * report AND, durably, one dedicated manifest row per file: the
           * report dies with the response, and without the row the cleanup
           * view is blind to the debt and D08's finalize would empty the
           * manifest with the metadata still on disk (ocr-ob-certify #17).
           */
          await deps.rows.insertResources(userId, [
            {
              kind: OPENMUSE_FILE_METADATA_KIND,
              id: fileId,
              state: "retryable_error",
              lastError,
            },
          ]);
          await deps.rows.markRetryable(
            userId,
            OPENMUSE_FILE_METADATA_KIND,
            fileId,
            lastError,
          );
        }
      }
    }
    return report;
  }

  return {
    purgeFileBytes: (userId: string) => walk(userId, () => true),
    /** The §9 retry path: re-walks only the rows that landed retryable_error. */
    retryCleanup: (userId: string) =>
      walk(userId, (state) => state === "retryable_error"),
  };
}
