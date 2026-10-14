import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  openmuseFileOwnerDisables,
  openmuseFiles,
  openmuseFileVersions,
} from "../db/schema";
import { openmuseAccountDeletions } from "../openmuse-deletion/store";
import { type FileByteStore, openMuseFileByteKey } from "./bytes";

/**
 * The personal-file store: upload with owner-scoped idempotency, list newest
 * first, F03 rename (display metadata only) and tombstone (bytes survive for
 * D06's purge), F06's fill-derived version append, and the §9 lifecycle hook
 * (`disableOwner` / `enumerateOwner`). The
 * logic lives over a narrow row seam so the same store code runs against the
 * drizzle rows in a deployment and the in-memory rows in tests — metadata
 * durability across a restart is rows-not-memory, and the tests prove it by
 * building a second store over the same rows.
 */

/** What one uploaded file answers on upload and in the list. */
export type OpenMuseFileDto = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  versionId: string;
  createdAt: Date;
};

/**
 * A live file the named owner may still fetch: its DTO plus lazy bytes. The
 * bytes are read through the store so the server-derived key never leaves
 * this module (§5), and lazily so metadata answers never touch them.
 */
export type OwnedOpenMuseFile = {
  file: OpenMuseFileDto;
  /**
   * The sha256 of the version actually served (latest), which after a fill is
   * NOT the DTO's original-upload hash — the download's ETag is built from it
   * so it names the bytes on the wire.
   */
  versionSha256: string;
  read(): Promise<Uint8Array>;
};

/** §9: one piece of user-owned state this module can enumerate for cleanup. */
export type OpenMuseFileResourceRef = {
  kind: "openmuse-file";
  id: string;
  externalKey: string;
};

export type StoredOpenMuseFile = {
  id: string;
  ownerUserId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  idempotencyKey: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

export type StoredOpenMuseFileVersion = {
  versionId: string;
  fileId: string;
  bytePath: string;
  sha256: string;
  createdAt: Date;
  /**
   * F06 fill provenance, present only on a fill-derived version: the version
   * whose bytes were filled and the typed values applied. The drizzle rows
   * persist the five columns above — provenance columns are a later ticket's
   * migration, so the provenance rides the row seam for now (recorded, not
   * silent).
   */
  parentVersionId?: string;
  values?: Record<string, string | boolean>;
};

/** The owner's place in the list order, for cursor paging. */
export type OpenMuseFileCursor = {
  createdAt: Date;
  id: string;
};

/**
 * The row seam: drizzle in a deployment, arrays in tests. The partial unique
 * index on (owner, idempotency_key) is the concurrency backstop — a racing
 * duplicate insert throws here, and the store answers the surviving row.
 */
export type OpenMuseFileRows = {
  /**
   * Single-row insert, kept ONLY as the test fixtures' poison-row chisel
   * ("a file row without its version row"): production must always write
   * the pair through `insertFileWithVersion`. Removing it from the seam
   * waits on the out-of-module fakes that still build fixtures with it
   * (openmuse-deletion.test.ts) — recorded as a dependency.
   */
  insertFile(file: StoredOpenMuseFile): Promise<void>;
  findFileByIdempotencyKey(
    ownerUserId: string,
    key: string,
  ): Promise<StoredOpenMuseFile | null>;
  findOwnedFile(
    ownerUserId: string,
    id: string,
  ): Promise<StoredOpenMuseFile | null>;
  /** F03 rename: the name column only; null for foreign/missing/tombstoned. */
  renameFile(
    ownerUserId: string,
    id: string,
    name: string,
  ): Promise<StoredOpenMuseFile | null>;
  /** F03 delete: tombstones a live row; false for foreign/missing/tombstoned. */
  tombstoneFile(ownerUserId: string, id: string): Promise<boolean>;
  insertVersion(version: StoredOpenMuseFileVersion): Promise<void>;
  /**
   * Upload's file row and first version row, written as one unit: a file row
   * landing without its version row poisons every later read of it (the
   * versioned-file join throws "has no stored version"), so the seam offers
   * the pair atomically — a transaction in the drizzle rows.
   */
  insertFileWithVersion(
    file: StoredOpenMuseFile,
    version: StoredOpenMuseFileVersion,
  ): Promise<void>;
  /** The owner's total stored bytes over live rows, for the aggregate quota. */
  sumBytesByOwner(ownerUserId: string): Promise<number>;
  latestVersion(fileId: string): Promise<StoredOpenMuseFileVersion | null>;
  /**
   * The page's latest versions in one query (list's batch seam, so the main
   * list path does not run one latestVersion per row). Optional: an older
   * fake without it falls back to the per-file calls.
   */
  latestVersionsForFileIds?(
    fileIds: string[],
  ): Promise<StoredOpenMuseFileVersion[]>;
  /**
   * One file's versions, newest first (the prune seam's read half).
   * Optional: without it (or without `deleteVersions`) appendVersion keeps
   * every version, the pre-prune behaviour.
   */
  versionsByFile?(fileId: string): Promise<StoredOpenMuseFileVersion[]>;
  /** The prune seam's write half; best-effort, never throws for a miss. */
  deleteVersions?(versionIds: string[]): Promise<void>;
  listByOwner(
    ownerUserId: string,
    options: { limit: number; before?: OpenMuseFileCursor },
  ): Promise<StoredOpenMuseFile[]>;
  ownerDisabled(ownerUserId: string): Promise<boolean>;
  disableOwner(ownerUserId: string): Promise<void>;
  restoreOwner(ownerUserId: string): Promise<void>;
  versionsByOwner(ownerUserId: string): Promise<StoredOpenMuseFileVersion[]>;
  /**
   * D06 (§9): hard-delete the owner's file row and its version rows. A
   * foreign id deletes nothing; a repeat (the idempotent re-cleanup)
   * deletes nothing either.
   */
  hardDeleteFile(ownerUserId: string, fileId: string): Promise<void>;
};

/** The owner's file surface is turned off (§9 disable); rows survive. */
export class OpenMuseOwnerDisabledError extends Error {
  constructor() {
    super("This owner's files are unavailable.");
    this.name = "OpenMuseOwnerDisabledError";
  }
}

/**
 * The per-owner aggregate quota (round 3): the per-file ceilings bound one
 * upload, this bounds the owner's total stored bytes so an authenticated
 * caller cannot fill the deployment's byte root one 20 MiB file at a time.
 */
export class OpenMuseFileQuotaError extends Error {
  readonly code = "openmuse_file_quota_exceeded" as const;

  constructor(readonly capBytes: number) {
    super(`That upload would pass this owner's ${capBytes}-byte Files quota.`);
    this.name = "OpenMuseFileQuotaError";
  }
}

export type OpenMuseFileStore = {
  upload(input: {
    ownerUserId: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    idempotencyKey: string | null;
  }): Promise<{ file: OpenMuseFileDto; deduplicated: boolean }>;
  list(
    ownerUserId: string,
    options: { limit: number; before?: OpenMuseFileCursor },
  ): Promise<{ files: OpenMuseFileDto[] }>;
  getOwnedFile(
    ownerUserId: string,
    id: string,
  ): Promise<OwnedOpenMuseFile | null>;
  /**
   * T14: the converged import under this key, if any — the import route asks
   * BEFORE the connection guard and any vendor dial, so a same-importKey
   * retry makes zero Gmail calls (CHOICE RECORDED: the deterministic key
   * converges without re-fetch). The §9 disabled marker rides along, same
   * as every other read.
   */
  findByIdempotencyKey(
    ownerUserId: string,
    idempotencyKey: string,
  ): Promise<OpenMuseFileDto | null>;
  /** F03: display-name change; null answers 404 (foreign/missing/tombstoned). */
  rename(
    ownerUserId: string,
    id: string,
    name: string,
  ): Promise<OpenMuseFileDto | null>;
  /**
   * F03: tombstone now — the row survives with `deletedAt` set, the blob
   * survives untouched (physical purge is D06's deletion manifest).
   */
  tombstone(ownerUserId: string, id: string): Promise<boolean>;
  /**
   * D06 (§9): the deletion manifest's cleanup calls this once EVERY one of
   * the file's byte objects has left the byte store — F03's delete
   * tombstones the row for the restore window; this, the post-restoreUntil
   * pass, removes the rows outright. Owner-scoped and idempotent.
   */
  hardDelete(ownerUserId: string, fileId: string): Promise<void>;
  /**
   * F06: append a fill-derived version to a live owned file — the byte store
   * put plus version row the fill route writes through, with the fill's
   * provenance on the version row. Null answers 404 (foreign/missing/
   * tombstoned). "stale-parent" answers a lost race: the parentVersionId the
   * caller filled from is no longer the file's latest version, so appending
   * would fork the chain and silently drop the other fill's values — the
   * caller retries on the version it now reads (the transfer route's 409
   * pattern).
   */
  appendVersion(input: {
    ownerUserId: string;
    fileId: string;
    bytes: Uint8Array;
    parentVersionId: string;
    values: Record<string, string | boolean>;
  }): Promise<StoredOpenMuseFileVersion | "stale-parent" | null>;
  disableOwner(ownerUserId: string): Promise<void>;
  restoreOwner(ownerUserId: string): Promise<void>;
  enumerateOwner(ownerUserId: string): Promise<OpenMuseFileResourceRef[]>;
};

/**
 * M22's prune grace: how long a superseded version's blob stays readable
 * after its row is gone — the window an in-flight download (a read()
 * resolved against the old latest) needs to finish. ponytail: a fixed
 * minute; a per-file sweeper when durability or multi-process collection
 * matters.
 */
export const OPENMUSE_PRUNE_GRACE_MS = 60_000;

export function createOpenMuseFileStore(deps: {
  rows: OpenMuseFileRows;
  byteStore: FileByteStore;
  /** M22: prune blob-delete grace; 0 sweeps synchronously (tests). */
  pruneGraceMs?: number;
  /**
   * Per-owner aggregate byte quota. Defaults to OPENMUSE_FILE_QUOTA_MIB MiB
   * (1024): the deployment premise this store ships with — a local byte root
   * with no sweeper, so the cap is the availability bound. Fill-derived
   * versions are not summed against it (the files row keeps the original's
   * size by §5); their total is bounded instead by appendVersion's prune,
   * which keeps only the original and the latest version of each file.
   */
  quotaBytes?: number;
}): OpenMuseFileStore {
  const { rows, byteStore } = deps;
  const quotaBytes =
    deps.quotaBytes ??
    (() => {
      const raw = process.env.OPENMUSE_FILE_QUOTA_MIB;
      const value = raw === undefined ? Number.NaN : Number(raw);
      return Number.isFinite(value) && value > 0
        ? value * 1024 * 1024
        : 1024 * 1024 * 1024;
    })();

  /*
   * File + latest version together: the DTO the routes answer with, plus the
   * version whose bytePath names the bytes. Metadata answers need the DTO
   * only, downloads need the version too.
   */
  const dtoOfVersion = (
    file: StoredOpenMuseFile,
    version: StoredOpenMuseFileVersion,
  ): OpenMuseFileDto => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    sha256: file.sha256,
    versionId: version.versionId,
    createdAt: file.createdAt,
  });

  const versionedFileOf = async (file: StoredOpenMuseFile) => {
    const version = await rows.latestVersion(file.id);
    if (!version) {
      throw new Error(
        `File ${file.id} has no stored version; its upload did not finish.`,
      );
    }
    return { version, dto: dtoOfVersion(file, version) };
  };

  const dtoOf = async (file: StoredOpenMuseFile): Promise<OpenMuseFileDto> =>
    (await versionedFileOf(file)).dto;

  return {
    async upload(input) {
      if (await rows.ownerDisabled(input.ownerUserId)) {
        throw new OpenMuseOwnerDisabledError();
      }
      if (input.idempotencyKey !== null) {
        const existing = await rows.findFileByIdempotencyKey(
          input.ownerUserId,
          input.idempotencyKey,
        );
        if (existing) {
          return { file: await dtoOf(existing), deduplicated: true };
        }
      }
      /*
       * The aggregate quota: the per-file ceilings bound one upload, this
       * bounds the owner's total, so an authenticated caller cannot fill the
       * deployment's byte root a file at a time. Checked before anything is
       * written; tombstoned rows' bytes still on disk are not the owner's to
       * spend, D06 owns their purge.
       *
       * KNOWN RACE (accepted): the check-then-insert is not atomic — N
       * concurrent uploads with distinct idempotency keys can each pass the
       * check and land, overshooting the cap by a bounded ~N × 20 MiB. The
       * unique partial index stops same-key duplicates, not this; tightening
       * needs a transactional re-count, recorded as a dependency.
       */
      if (
        (await rows.sumBytesByOwner(input.ownerUserId)) +
          input.bytes.byteLength >
        quotaBytes
      ) {
        throw new OpenMuseFileQuotaError(quotaBytes);
      }
      const id = randomUUID();
      const versionId = randomUUID();
      const bytePath = openMuseFileByteKey(input.ownerUserId, id, versionId);
      const digest = createHash("sha256").update(input.bytes).digest("hex");
      const createdAt = new Date();
      /*
       * Bytes before rows: a failure between the two leaves an orphaned blob
       * (invisible — no row names it) rather than a row whose bytes are gone.
       * A crash the other way round is unrecoverable from the API's view.
       */
      await byteStore.put(bytePath, input.bytes);
      try {
        // The file row and its first version land as one unit: a file row
        // without its version row poisons every later read of it (the join
        // throws "has no stored version"), and the whole owner's file surface
        // with it.
        await rows.insertFileWithVersion(
          {
            id,
            ownerUserId: input.ownerUserId,
            name: input.name,
            mimeType: input.mimeType,
            size: input.bytes.byteLength,
            sha256: digest,
            idempotencyKey: input.idempotencyKey,
            createdAt,
            deletedAt: null,
          },
          {
            versionId,
            fileId: id,
            bytePath,
            sha256: digest,
            createdAt,
          },
        );
      } catch (error) {
        if (input.idempotencyKey !== null) {
          const raced = await rows.findFileByIdempotencyKey(
            input.ownerUserId,
            input.idempotencyKey,
          );
          if (raced) {
            return { file: await dtoOf(raced), deduplicated: true };
          }
        }
        throw error;
      }
      return {
        file: {
          id,
          name: input.name,
          mimeType: input.mimeType,
          size: input.bytes.byteLength,
          sha256: digest,
          versionId,
          createdAt,
        },
        deduplicated: false,
      };
    },

    async list(ownerUserId, options) {
      if (await rows.ownerDisabled(ownerUserId)) {
        throw new OpenMuseOwnerDisabledError();
      }
      const stored = await rows.listByOwner(ownerUserId, options);
      /*
       * The page's latest versions in ONE query when the seam offers the
       * batch member: this is the mobile BFF's main list path, and a
       * per-row latestVersion would scale the query count with the page
       * size (limit+1 round trips at the default 25). Without the member
       * (older fakes) the per-file seam answers exactly as before.
       */
      if (rows.latestVersionsForFileIds) {
        const latest = new Map(
          (
            await rows.latestVersionsForFileIds(stored.map((file) => file.id))
          ).map((version) => [version.fileId, version]),
        );
        return {
          files: stored.map((file) => {
            const version = latest.get(file.id);
            if (!version) {
              throw new Error(
                `File ${file.id} has no stored version; its upload did not finish.`,
              );
            }
            return dtoOfVersion(file, version);
          }),
        };
      }
      return { files: await Promise.all(stored.map(dtoOf)) };
    },

    /*
     * §5: one fetch checks owner and deletion state at once, and the answer
     * is null for a foreign id, a missing id, and a tombstoned file alike —
     * existence is not disclosed.
     */
    async getOwnedFile(ownerUserId, id) {
      if (await rows.ownerDisabled(ownerUserId)) {
        throw new OpenMuseOwnerDisabledError();
      }
      const file = await rows.findOwnedFile(ownerUserId, id);
      if (!file) {
        return null;
      }
      const { dto, version } = await versionedFileOf(file);
      return {
        file: dto,
        versionSha256: version.sha256,
        read: async () => {
          const bytes = await byteStore.get(version.bytePath);
          if (bytes === null) {
            throw new Error(
              `File ${file.id}'s bytes are missing at their stored key.`,
            );
          }
          return bytes;
        },
      };
    },

    /*
     * T14: the rows' own owner-scoped idempotency lookup, exposed so the
     * import route can answer a converged key without any vendor dial
     * (see the type note). The DTO answers like every metadata read.
     */
    async findByIdempotencyKey(ownerUserId, idempotencyKey) {
      if (await rows.ownerDisabled(ownerUserId)) {
        throw new OpenMuseOwnerDisabledError();
      }
      const file = await rows.findFileByIdempotencyKey(
        ownerUserId,
        idempotencyKey,
      );
      return file === null ? null : dtoOf(file);
    },

    /*
     * F03: one write touches the name column only — sha/version/bytePath are
     * immutable display-independent identity, so a rename never reaches the
     * version rows or the byte store.
     */
    async rename(ownerUserId, id, name) {
      if (await rows.ownerDisabled(ownerUserId)) {
        throw new OpenMuseOwnerDisabledError();
      }
      const file = await rows.renameFile(ownerUserId, id, name);
      return file ? dtoOf(file) : null;
    },

    /*
     * F03: compare-and-swap null → now on deletedAt. The byte blob stays —
     * D06's deletion manifest owns the physical purge — and every owner- and
     * liveness-scoped read (get, list, idempotency lookup) already refuses
     * tombstoned rows.
     */
    async tombstone(ownerUserId, id) {
      if (await rows.ownerDisabled(ownerUserId)) {
        throw new OpenMuseOwnerDisabledError();
      }
      return rows.tombstoneFile(ownerUserId, id);
    },

    /*
     * D06: no ownerDisabled guard — the purge runs ON a fenced owner; the
     * manifest, not this seam, is what says the rows may go.
     */
    hardDelete: (ownerUserId, fileId) =>
      rows.hardDeleteFile(ownerUserId, fileId),

    /*
     * F06: the fill flow's version append — the same bytes-before-rows order
     * as upload (cite: upload's orphaned-blob rationale) over the same
     * server-derived key scheme. The file row is untouched on purpose: its
     * sha256 is the original's by contract (§5), and the derived version's
     * hash rides its own row.
     */
    async appendVersion(input) {
      if (await rows.ownerDisabled(input.ownerUserId)) {
        throw new OpenMuseOwnerDisabledError();
      }
      const file = await rows.findOwnedFile(input.ownerUserId, input.fileId);
      if (!file) {
        return null;
      }
      /*
       * The optimistic-concurrency check the fill's parentVersionId exists
       * for: two concurrent fills off one source must not both land — the
       * loser is told to re-read and retry rather than silently forking the
       * version chain. KNOWN LIMIT: this check-then-insert is not atomic and
       * the schema carries no (file_id, parent_version_id) unique index, so
       * two appends overlapping in flight can both land; persisting the
       * provenance columns with that index (a migration, recorded as a
       * dependency) is what would let the loser fail at the insert.
       */
      const latest = await rows.latestVersion(input.fileId);
      if (latest === null || latest.versionId !== input.parentVersionId) {
        return "stale-parent";
      }
      const versionId = randomUUID();
      const bytePath = openMuseFileByteKey(
        input.ownerUserId,
        input.fileId,
        versionId,
      );
      const digest = createHash("sha256").update(input.bytes).digest("hex");
      await byteStore.put(bytePath, input.bytes);
      /*
       * The pre-insert snapshot names the superseded MIDDLE versions this
       * append can prune (see the quota note below): read BEFORE our row
       * lands, so a concurrent append's row can never be in the doomed set.
       */
      const preExisting = rows.versionsByFile
        ? await rows.versionsByFile(input.fileId)
        : null;
      /*
       * Strictly-monotonic stamp: the prune below spares the original by
       * `createdAt` equality with the file row (upload writes the pair with
       * one timestamp), so an append landing in the upload's own millisecond
       * would masquerade as the original and survive the prune. Force the
       * new row strictly past every pre-existing version (max guards a
       * clock that jumped backwards, not just a same-millisecond collision).
       */
      const stampedAt = new Date(
        preExisting && preExisting.length > 0
          ? Math.max(
              Date.now(),
              ...preExisting.map((row) => row.createdAt.getTime() + 1),
            )
          : Date.now(),
      );
      const version: StoredOpenMuseFileVersion = {
        versionId,
        fileId: input.fileId,
        bytePath,
        sha256: digest,
        createdAt: stampedAt,
        parentVersionId: input.parentVersionId,
        values: input.values,
      };
      try {
        await rows.insertVersion(version);
      } catch (error) {
        /*
         * M23: the (file_id, parent_version_id) partial unique index makes
         * the stale-parent check enforceable at the INSERT — two fills
         * overlapping in flight both pass the read above, and the loser
         * lands here on the fork it must lose. Mapped to the same
         * "stale-parent" answer the read-side check gives, so the route's
         * 409 finally tells the truth for the concurrent case too.
         */
        if (isParentForkViolation(error)) return "stale-parent";
        throw error;
      }
      /*
       * Quota honesty (the aggregate cap sums the files rows' original
       * sizes, so version bytes would otherwise be unbounded): superseded
       * MIDDLE versions are pruned once the new one lands. The file keeps
       * its original — the version whose createdAt is the file row's own
       * (upload writes the pair with one timestamp; appends are stamped
       * strictly newer above, so equality names the original alone), which
       * §5's pinned sha256/size and F06's "the original stays as uploaded"
       * claim name — and its latest (the only version any flow reads:
       * content, transfer and the next fill all resolve to latest). Rows go
       * before bytes (a blob delete that fails leaves an invisible orphan,
       * never a row without bytes).
       */
      if (preExisting !== null && rows.deleteVersions) {
        const doomed = preExisting.filter(
          (row) => row.createdAt.getTime() !== file.createdAt.getTime(),
        );
        if (doomed.length > 0) {
          await rows.deleteVersions(doomed.map((row) => row.versionId));
          /*
           * Rows before bytes, but the BYTES on a grace delay (round 6 M22):
           * a download that resolved the old latest through getOwnedFile
           * holds a read() closure over this bytePath — deleting the blob
           * synchronously turned that fill-completion instant into a 503 for
           * the concurrent reader ("bytes are missing"). The grace window
           * (overridable so tests can shrink it to zero) lets in-flight
           * reads finish; the deferred sweep keeps the quota bound.
           * ponytail: setTimeout sweep, per-file sweeper if durability or
           * multi-process collection ever matters.
           */
          const graceMs = deps.pruneGraceMs ?? OPENMUSE_PRUNE_GRACE_MS;
          const sweepDoomed = () => {
            for (const row of doomed) {
              byteStore.delete(row.bytePath).catch(() => {});
            }
          };
          if (graceMs <= 0) {
            await Promise.all(
              doomed.map((row) =>
                byteStore.delete(row.bytePath).catch(() => {}),
              ),
            );
          } else {
            setTimeout(sweepDoomed, graceMs).unref?.();
          }
        }
      }
      return version;
    },

    disableOwner: (ownerUserId) => rows.disableOwner(ownerUserId),

    /*
     * The inverse of disable: clear the marker. Files and bytes survive a
     * disable, so there is nothing else to put back — the §9 restore of
     * deleted content is the deletion tickets' manifest, not this hook.
     */
    restoreOwner: (ownerUserId) => rows.restoreOwner(ownerUserId),

    async enumerateOwner(ownerUserId) {
      const versions = await rows.versionsByOwner(ownerUserId);
      return versions.map((version) => ({
        kind: "openmuse-file" as const,
        id: version.fileId,
        externalKey: version.bytePath,
      }));
    },
  };
}

/** Whether an insert failure is the version-parent fork's unique refusal (M23). */
function isParentForkViolation(error: unknown): boolean {
  for (
    let cause: unknown = error;
    cause !== undefined && cause !== null;
    cause = (cause as { cause?: unknown }).cause
  ) {
    const named = cause as { code?: unknown; constraint?: unknown };
    if (
      named.code === "23505" &&
      String(named.constraint ?? (cause as Error).message ?? "").includes(
        "openmuse_file_versions_parent_uq",
      )
    ) {
      return true;
    }
  }
  return false;
}

// ── drizzle rows ────────────────────────────────────────────────────────────

/**
 * The deployment's rows. Untested directly (the house convention: unit tests
 * fake the row seam, like `openmuse-bot.test.ts` fakes the template store) —
 * the migration and the store tests over the fake pin the same contract.
 */
/**
 * The schema row → the seam's stored shape (round 6 M23): the persisted
 * parent is nullable in the column (the original's own parent is none) but
 * absent on the seam's type — null maps to undefined exactly once, here.
 */
function versionRowToStored(
  row: typeof openmuseFileVersions.$inferSelect,
): StoredOpenMuseFileVersion {
  return {
    versionId: row.versionId,
    fileId: row.fileId,
    bytePath: row.bytePath,
    sha256: row.sha256,
    createdAt: row.createdAt,
    ...(row.parentVersionId !== null
      ? { parentVersionId: row.parentVersionId }
      : {}),
  };
}

export function createOpenMuseFileRows(database: Database): OpenMuseFileRows {
  return {
    insertFile: async (file) => {
      await database.insert(openmuseFiles).values(file);
    },
    findFileByIdempotencyKey: async (ownerUserId, key) => {
      const [row] = await database
        .select()
        .from(openmuseFiles)
        .where(
          and(
            eq(openmuseFiles.ownerUserId, ownerUserId),
            eq(openmuseFiles.idempotencyKey, key),
            isNull(openmuseFiles.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    findOwnedFile: async (ownerUserId, id) => {
      const [row] = await database
        .select()
        .from(openmuseFiles)
        .where(
          and(
            eq(openmuseFiles.ownerUserId, ownerUserId),
            eq(openmuseFiles.id, id),
            isNull(openmuseFiles.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    insertVersion: async (version) => {
      /*
       * F06: provenance rides the seam, and since round 6 (M23) the column
       * and its partial unique index are durable: two fills overlapping in
       * flight both pass appendVersion's read-side stale-parent check, and
       * the loser now fails HERE on openmuse_file_versions_parent_uq — the
       * fork the route's 409 always promised to prevent. Same-named values
       * insertions still name the six columns they own.
       */
      await database.insert(openmuseFileVersions).values({
        versionId: version.versionId,
        fileId: version.fileId,
        bytePath: version.bytePath,
        sha256: version.sha256,
        createdAt: version.createdAt,
        parentVersionId: version.parentVersionId,
      });
    },
    insertFileWithVersion: async (file, version) => {
      // One transaction: a file row committed without its version row is a
      // poisoned read for the owner's whole file surface (see the seam note).
      await database.transaction(async (tx) => {
        await tx.insert(openmuseFiles).values(file);
        await tx.insert(openmuseFileVersions).values({
          versionId: version.versionId,
          fileId: version.fileId,
          bytePath: version.bytePath,
          sha256: version.sha256,
          createdAt: version.createdAt,
          // The original's own parent is none: null sits OUTSIDE the partial
          // unique index, so it never collides with a fill's derived row.
          parentVersionId: null,
        });
      });
    },
    sumBytesByOwner: async (ownerUserId) => {
      const [row] = await database
        .select({ total: sql<string>`coalesce(sum(${openmuseFiles.size}), 0)` })
        .from(openmuseFiles)
        .where(
          and(
            eq(openmuseFiles.ownerUserId, ownerUserId),
            isNull(openmuseFiles.deletedAt),
          ),
        );
      return Number(row?.total ?? 0);
    },
    renameFile: async (ownerUserId, id, name) => {
      const [row] = await database
        .update(openmuseFiles)
        .set({ name })
        .where(
          and(
            eq(openmuseFiles.ownerUserId, ownerUserId),
            eq(openmuseFiles.id, id),
            isNull(openmuseFiles.deletedAt),
          ),
        )
        .returning();
      return row ?? null;
    },
    tombstoneFile: async (ownerUserId, id) => {
      const tombstoned = await database
        .update(openmuseFiles)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(openmuseFiles.ownerUserId, ownerUserId),
            eq(openmuseFiles.id, id),
            isNull(openmuseFiles.deletedAt),
          ),
        )
        .returning({ id: openmuseFiles.id });
      return tombstoned.length > 0;
    },
    latestVersion: async (fileId) => {
      const [row] = await database
        .select()
        .from(openmuseFileVersions)
        .where(eq(openmuseFileVersions.fileId, fileId))
        .orderBy(desc(openmuseFileVersions.createdAt))
        .limit(1);
      return row ? versionRowToStored(row) : null;
    },
    latestVersionsForFileIds: async (fileIds) => {
      if (fileIds.length === 0) return [];
      const rows = await database
        .select()
        .from(openmuseFileVersions)
        .where(inArray(openmuseFileVersions.fileId, fileIds))
        .orderBy(desc(openmuseFileVersions.createdAt));
      // Newest first, so the FIRST row seen per file is its latest — one
      // query for the page instead of one per row.
      const latest = new Map<string, StoredOpenMuseFileVersion>();
      for (const row of rows) {
        if (!latest.has(row.fileId))
          latest.set(row.fileId, versionRowToStored(row));
      }
      return [...latest.values()];
    },
    versionsByFile: async (fileId) =>
      (
        await database
          .select()
          .from(openmuseFileVersions)
          .where(eq(openmuseFileVersions.fileId, fileId))
          .orderBy(desc(openmuseFileVersions.createdAt))
      ).map(versionRowToStored),
    deleteVersions: async (versionIds) => {
      if (versionIds.length === 0) return;
      await database
        .delete(openmuseFileVersions)
        .where(inArray(openmuseFileVersions.versionId, versionIds));
    },
    listByOwner: async (ownerUserId, { limit, before }) => {
      const younger = before
        ? or(
            lt(openmuseFiles.createdAt, before.createdAt),
            and(
              eq(openmuseFiles.createdAt, before.createdAt),
              lt(openmuseFiles.id, before.id),
            ),
          )
        : undefined;
      return database
        .select()
        .from(openmuseFiles)
        .where(
          and(
            eq(openmuseFiles.ownerUserId, ownerUserId),
            isNull(openmuseFiles.deletedAt),
            younger,
          ),
        )
        .orderBy(desc(openmuseFiles.createdAt), desc(openmuseFiles.id))
        .limit(limit);
    },
    ownerDisabled: async (ownerUserId) => {
      // §9 D03: the deletion marker refuses on its own — read directly the
      // way D02's task rows read it, phase-aware the same way (a restored
      // marker is a live account again; the disable TABLE below is
      // restoreOwner's to clear, the marker half lifts with the phase),
      // defense in depth under the /api/mobile fence for the byte path
      // (`getOwnedFile`) and every other read.
      const [deleted] = await database
        .select({ userId: openmuseAccountDeletions.userId })
        .from(openmuseAccountDeletions)
        .where(
          and(
            eq(openmuseAccountDeletions.userId, ownerUserId),
            eq(openmuseAccountDeletions.phase, "fenced"),
          ),
        )
        .limit(1);
      if (deleted !== undefined) return true;
      const [row] = await database
        .select({ ownerUserId: openmuseFileOwnerDisables.ownerUserId })
        .from(openmuseFileOwnerDisables)
        .where(eq(openmuseFileOwnerDisables.ownerUserId, ownerUserId))
        .limit(1);
      return row !== undefined;
    },
    disableOwner: async (ownerUserId) => {
      await database
        .insert(openmuseFileOwnerDisables)
        .values({ ownerUserId })
        .onConflictDoNothing();
    },
    restoreOwner: async (ownerUserId) => {
      await database
        .delete(openmuseFileOwnerDisables)
        .where(eq(openmuseFileOwnerDisables.ownerUserId, ownerUserId));
    },
    versionsByOwner: async (ownerUserId) => {
      /*
       * NO deletedAt filter, deliberately: this seam's only consumer is
       * enumerateOwner, the deletion manifest's source. A tombstoned file's
       * bytes are D06's to purge exactly like a live file's — filtering
       * tombstones here would leave their blobs and metadata rows behind
       * forever once the account itself is deleted (the manifest is the
       * only sweeper there is).
       */
      const rows = await database
        .select({
          versionId: openmuseFileVersions.versionId,
          fileId: openmuseFileVersions.fileId,
          bytePath: openmuseFileVersions.bytePath,
          sha256: openmuseFileVersions.sha256,
          createdAt: openmuseFileVersions.createdAt,
        })
        .from(openmuseFileVersions)
        .innerJoin(
          openmuseFiles,
          eq(openmuseFileVersions.fileId, openmuseFiles.id),
        )
        .where(eq(openmuseFiles.ownerUserId, ownerUserId))
        .orderBy(desc(openmuseFileVersions.createdAt));
      return rows;
    },
    hardDeleteFile: async (ownerUserId, fileId) => {
      /*
       * One transaction, the same atomicity insertFileWithVersion pins: a
       * version-less file row committed by a failure between the two
       * deletes is a poison row enumerateOwner's join can no longer see,
       * and the purge's manifest walk would then never remove it.
       */
      await database.transaction(async (tx) => {
        // Versions first, then the file row: no version outlives its file,
        // and the owner scope means a foreign id matches nothing twice.
        await tx.delete(openmuseFileVersions).where(
          inArray(
            openmuseFileVersions.fileId,
            tx
              .select({ id: openmuseFiles.id })
              .from(openmuseFiles)
              .where(
                and(
                  eq(openmuseFiles.ownerUserId, ownerUserId),
                  eq(openmuseFiles.id, fileId),
                ),
              ),
          ),
        );
        await tx
          .delete(openmuseFiles)
          .where(
            and(
              eq(openmuseFiles.ownerUserId, ownerUserId),
              eq(openmuseFiles.id, fileId),
            ),
          );
      });
    },
  };
}
