import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { REDACTION_POLICY_VERSION } from "../../../shared/ai-observability";
import type { Database } from "../db/client";
import {
  aiObservationDatasets,
  aiObservationDatasetVersions,
} from "../db/schema/ai-observability-datasets";
import type { ObservationScope } from "./contracts";
import { denyReason, projectSafeFixture, projectSafeText } from "./redaction";
import { notPendingDeletion } from "./retention";
import { assertObservationScope, resolveStorageLocator } from "./scope";

/**
 * The dataset version freeze (Issue #25 / DAG T19).
 *
 * A version is an immutable snapshot: the case content arrives here already reviewed by the
 * case author (a saved candidate case is exactly what T05's `allowFreeText` licenses), and the
 * freeze projects it once more anyway — the deny patterns always win, so no path into this
 * store can freeze a credential into an evaluation dataset even if a caller claims it is safe.
 *
 * Identity is content, not chronology: the canonical JSON of the projected cases under the
 * current redaction policy hashes to the `content_hash` that, with the scope and dataset, is
 * the version's uniqueness key. Saving the same cases again is a replay that hits the same
 * row — idempotency decided by the database, exactly like T07's begins. Editing a candidate
 * afterwards produces different content, therefore a different hash, therefore a *new*
 * version; the frozen one cannot change because migration 0123's trigger refuses any UPDATE
 * on it. The upstream locator is derived from the scope (T06), never accepted from the caller.
 */

export type DatasetErrorCode =
  | "DATASET_INPUT_INVALID"
  | "DATASET_NOT_FOUND"
  | "DATASET_STATE_INVALID";

export class DatasetStoreError extends Error {
  constructor(
    public code: DatasetErrorCode,
    public status: 400 | 404 | 409,
  ) {
    super(code);
  }
}

/** One case as the caller submits it: reviewed content plus where it came from. */
export type DatasetCaseInput = {
  /** Reviewed case input. Free text is allowed; deny patterns still refuse it. */
  input: string;
  /** Reviewed reference output, the answer the evaluated run is scored against. */
  referenceOutput: string;
  /** Tool fixtures: the structured stand-ins evaluation replays instead of live tools. */
  toolFixtures: Record<string, unknown>;
  /** The observed run this case was distilled from. */
  sourceRunId: string;
  sourceAttemptId: string;
  /** The T07 binding that owns the source run, when it is known. */
  sourceBindingId?: string | null;
};

/**
 * One case as the version freezes it: projected content plus opaque provenance ids.
 * R2-56: this is the shared contract's own type, imported — not a second spelling —
 * so the "byte-for-byte mirror" rule holds by construction and no future edit here
 * can drift from what the browser renders. The shared file's header names this file
 * as one of the two sources it mirrors; the import is the mirror's enforcement half.
 */
import type { FrozenDatasetCase } from "../../../shared/ai-observability-datasets";

export type { FrozenDatasetCase };

export const MAX_DATASET_CASES = 200;
const MAX_DATASET_NAME_BYTES = 128;

export type ObservationDataset = typeof aiObservationDatasets.$inferSelect;
export type ObservationDatasetVersion =
  typeof aiObservationDatasetVersions.$inferSelect;

export type SaveDatasetVersionInput = {
  datasetName: string;
  cases: readonly DatasetCaseInput[];
};

export type ObservationDatasetStore = {
  /**
   * Freeze one version of a dataset: ensure the (scope, name) subject exists, project the
   * cases, hash them, and insert the version — or return the one the same content already
   * produced. Idempotency is decided by the (scope, dataset, content hash) unique index:
   * concurrent saves of the same content race in the database and every winner and loser
   * answers with the same version row.
   */
  saveVersion(
    scope: ObservationScope,
    input: SaveDatasetVersionInput,
  ): Promise<{
    dataset: ObservationDataset;
    version: ObservationDatasetVersion;
    replayed: boolean;
  }>;
  /** Read one dataset inside the caller's scope. Another scope's id is simply not found. */
  getDataset(
    scope: ObservationScope,
    id: string,
  ): Promise<ObservationDataset | null>;
  /**
   * The datasets of one scope with their version aggregates, newest first — the list
   * face of the dataset read API. The aggregate lives here, beside the tables it
   * joins, so the read routes never re-derive it: `versionCount` counts the frozen
   * versions and `latestVersionAt` is when the newest one froze (null when none).
   * The M1a visibility rule applies: a dataset under retention deletion is absent.
   */
  list(scope: ObservationScope): Promise<
    readonly {
      id: string;
      name: string;
      syncState: string;
      createdAt: Date;
      updatedAt: Date;
      versionCount: number;
      latestVersionAt: Date | null;
    }[]
  >;
  /**
   * The dataset an upstream id maps back to, inside the caller's scope — the reverse
   * direction of the dataset↔dataset mapping (Issue #23/T17's query seam). Another
   * scope's upstream id is simply not found.
   */
  byOpikDatasetId(
    scope: ObservationScope,
    opikDatasetId: string,
  ): Promise<ObservationDataset | null>;
  /** Read one frozen version inside the caller's scope. */
  getVersion(
    scope: ObservationScope,
    versionId: string,
  ): Promise<ObservationDatasetVersion | null>;
  /** The frozen versions of one dataset, newest first — the dataset read API of this ticket. */
  listVersions(
    scope: ObservationScope,
    datasetId: string,
  ): Promise<readonly ObservationDatasetVersion[]>;
  /**
   * Begin pushing the dataset upstream: pending/failed → syncing. A dataset that is already
   * synced has nothing to push, and one already syncing is answered as such — neither is an
   * error, the state is simply returned.
   */
  markSyncing(
    scope: ObservationScope,
    datasetId: string,
  ): Promise<ObservationDataset>;
  /**
   * Record that the push actually succeeded, together with the upstream dataset id. The first
   * recorded id stands (T07's reconcile precedent): a replay of the same acknowledgment is a
   * no-op, and a divergent later id signals upstream duplication and changes nothing.
   */
  markSynced(
    scope: ObservationScope,
    datasetId: string,
    opikDatasetId: string,
  ): Promise<{ dataset: ObservationDataset; adopted: boolean }>;
  /** Park a failed push in `failed`, from where it may retry (markSyncing) or be deleted. */
  markFailed(
    scope: ObservationScope,
    datasetId: string,
  ): Promise<ObservationDataset>;
  /** The cleanup half of partial success: remove the subject and its frozen versions. */
  deleteDataset(scope: ObservationScope, datasetId: string): Promise<void>;
};

/** A non-empty opaque reference. Values are stored as-is; only emptiness is refused. */
function reference(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DatasetStoreError("DATASET_INPUT_INVALID", 400);
  }
  return value;
}

/**
 * Canonical JSON: object keys sorted, arrays ordered, so two structs that differ only in key
 * order are the same content and hash the same. Everything else is JSON.stringify's own
 * spelling — a number is a number and a string is a string.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Project the caller's reviewed cases into the frozen form; the deny scan always wins. */
export function freezeCases(
  cases: readonly DatasetCaseInput[],
): readonly FrozenDatasetCase[] {
  return cases.map((one) => ({
    safeInput: projectSafeText(one.input, { allowFreeText: true }),
    referenceOutput: projectSafeText(one.referenceOutput, {
      allowFreeText: true,
    }),
    toolFixtures: projectSafeFixture(one.toolFixtures),
    sourceRunId: one.sourceRunId,
    sourceAttemptId: one.sourceAttemptId,
    sourceBindingId: one.sourceBindingId ?? null,
  }));
}

/** The version identity of frozen cases under one redaction policy. */
export function contentHash(
  frozen: readonly FrozenDatasetCase[],
  policyVersion: string = REDACTION_POLICY_VERSION,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({ policy: policyVersion, cases: frozen as unknown[] }),
    )
    .digest("hex");
}

function validateSaveInput(input: SaveDatasetVersionInput) {
  const name = reference(input.datasetName);
  if (new TextEncoder().encode(name).length > MAX_DATASET_NAME_BYTES) {
    throw new DatasetStoreError("DATASET_INPUT_INVALID", 400);
  }
  // The reviewer types this name; the subject row and the append-only audit row
  // that echoes it would both carry it forever (the versions are immutable, the
  // trail is append-only). A credential-class match is refused here — the id-links
  // precedent — so no stored or echoed dataset name can be a credential.
  if (denyReason(name) !== undefined) {
    throw new DatasetStoreError("DATASET_INPUT_INVALID", 400);
  }
  if (
    !Array.isArray(input.cases) ||
    input.cases.length === 0 ||
    input.cases.length > MAX_DATASET_CASES
  ) {
    throw new DatasetStoreError("DATASET_INPUT_INVALID", 400);
  }
  for (const one of input.cases) {
    reference(one.input);
    reference(one.referenceOutput);
    reference(one.sourceRunId);
    reference(one.sourceAttemptId);
    if (one.sourceBindingId !== undefined && one.sourceBindingId !== null) {
      reference(one.sourceBindingId);
    }
  }
  return name;
}

export function createObservationDatasetStore(
  db: Database,
): ObservationDatasetStore {
  const scopeDataset = (scope: ObservationScope, id: string) =>
    and(
      eq(aiObservationDatasets.id, id),
      eq(aiObservationDatasets.scopeKey, scope.key),
    );

  return {
    async saveVersion(scope, input) {
      assertObservationScope(scope);
      const name = validateSaveInput(input);

      const frozen = freezeCases(input.cases);
      const hash = contentHash(frozen);
      const locator = resolveStorageLocator(scope);

      return db.transaction(async (tx) => {
        const subject = await tx
          .insert(aiObservationDatasets)
          .values({
            id: randomUUID(),
            scopeKey: scope.key,
            actorId: scope.actorId,
            botId: scope.botId,
            name,
            locatorWorkspace: locator.workspace,
            locatorProject: locator.project,
            syncState: "pending",
          })
          .onConflictDoNothing({
            target: [
              aiObservationDatasets.scopeKey,
              aiObservationDatasets.name,
            ],
          })
          .returning();
        const dataset =
          subject[0] ??
          (
            await tx
              .select()
              .from(aiObservationDatasets)
              .where(
                and(
                  eq(aiObservationDatasets.scopeKey, scope.key),
                  eq(aiObservationDatasets.name, name),
                  // The conflict-reuse path is a reader too (OCR m120): a subject
                  // under retention deletion is gone to readers, so it cannot be
                  // silently reused as the freeze target — the answer is the same
                  // not-found every read gives, before an immutable version lands
                  // on a subject the cascade is about to destroy.
                  notPendingDeletion("dataset", aiObservationDatasets.id),
                ),
              )
          )[0];
        if (!dataset) {
          // A genuine conflict absence is a bug; a deletion-in-flight subject is
          // the M1a refusal, and both answer loudly rather than guessing.
          const ghost = await tx
            .select({ id: aiObservationDatasets.id })
            .from(aiObservationDatasets)
            .where(
              and(
                eq(aiObservationDatasets.scopeKey, scope.key),
                eq(aiObservationDatasets.name, name),
              ),
            );
          if (ghost[0]) {
            throw new DatasetStoreError("DATASET_NOT_FOUND", 404);
          }
          throw new Error(
            "saveVersion conflicted but the dataset subject is absent",
          );
        }

        const inserted = await tx
          .insert(aiObservationDatasetVersions)
          .values({
            id: randomUUID(),
            scopeKey: scope.key,
            datasetId: dataset.id,
            contentHash: hash,
            redactionPolicyVersion: REDACTION_POLICY_VERSION,
            cases: frozen,
            locatorWorkspace: locator.workspace,
            locatorProject: locator.project,
          })
          .onConflictDoNothing({
            target: [
              aiObservationDatasetVersions.scopeKey,
              aiObservationDatasetVersions.datasetId,
              aiObservationDatasetVersions.contentHash,
            ],
          })
          .returning();
        if (inserted[0]) {
          return { dataset, version: inserted[0], replayed: false };
        }

        // The same frozen content already made this version: hand back the existing row.
        const existing = await tx
          .select()
          .from(aiObservationDatasetVersions)
          .where(
            and(
              eq(aiObservationDatasetVersions.scopeKey, scope.key),
              eq(aiObservationDatasetVersions.datasetId, dataset.id),
              eq(aiObservationDatasetVersions.contentHash, hash),
            ),
          );
        const replay = existing[0];
        if (!replay) {
          throw new Error(
            "saveVersion conflicted but the conflicting version is absent",
          );
        }
        return { dataset, version: replay, replayed: true };
      });
    },

    async list(scope) {
      assertObservationScope(scope);
      return db
        .select({
          id: aiObservationDatasets.id,
          name: aiObservationDatasets.name,
          syncState: aiObservationDatasets.syncState,
          createdAt: aiObservationDatasets.createdAt,
          updatedAt: aiObservationDatasets.updatedAt,
          versionCount:
            sql<number>`count(${aiObservationDatasetVersions.id})`.mapWith(
              Number,
            ),
          latestVersionAt: sql<Date | null>`max(${aiObservationDatasetVersions.createdAt})`,
        })
        .from(aiObservationDatasets)
        .leftJoin(
          aiObservationDatasetVersions,
          and(
            eq(
              aiObservationDatasetVersions.scopeKey,
              aiObservationDatasets.scopeKey,
            ),
            eq(
              aiObservationDatasetVersions.datasetId,
              aiObservationDatasets.id,
            ),
          ),
        )
        .where(
          and(
            eq(aiObservationDatasets.scopeKey, scope.key),
            // The M1a visibility rule, list-shaped: a dataset under retention
            // deletion is gone to readers from discovery on.
            notPendingDeletion("dataset", aiObservationDatasets.id),
          ),
        )
        .groupBy(aiObservationDatasets.id)
        .orderBy(
          desc(aiObservationDatasets.createdAt),
          desc(aiObservationDatasets.id),
        );
    },

    async getDataset(scope, id) {
      assertObservationScope(scope);
      reference(id);
      const rows = await db
        .select()
        .from(aiObservationDatasets)
        .where(
          and(
            scopeDataset(scope, id),
            // The M1a visibility rule: a dataset under retention deletion is gone
            // to readers from discovery on, versions and all.
            notPendingDeletion("dataset", aiObservationDatasets.id),
          ),
        );
      return rows[0] ?? null;
    },

    async byOpikDatasetId(scope, opikDatasetId) {
      assertObservationScope(scope);
      reference(opikDatasetId);
      const rows = await db
        .select()
        .from(aiObservationDatasets)
        .where(
          and(
            eq(aiObservationDatasets.scopeKey, scope.key),
            eq(aiObservationDatasets.opikDatasetId, opikDatasetId),
            // The M1a visibility rule, reverse-lookup-shaped (OCR m119): a dataset
            // in retention deletion cannot be fetched back through the private API
            // any more than through the reads — deletion is discovery-to-gone.
            notPendingDeletion("dataset", aiObservationDatasets.id),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async getVersion(scope, versionId) {
      assertObservationScope(scope);
      reference(versionId);
      const rows = await db
        .select()
        .from(aiObservationDatasetVersions)
        .where(
          and(
            eq(aiObservationDatasetVersions.id, versionId),
            eq(aiObservationDatasetVersions.scopeKey, scope.key),
            // A version hides with its dataset: the deletion record targets the
            // subject, the cascade will take the versions.
            notPendingDeletion(
              "dataset",
              aiObservationDatasetVersions.datasetId,
            ),
          ),
        );
      return rows[0] ?? null;
    },

    async listVersions(scope, datasetId) {
      assertObservationScope(scope);
      reference(datasetId);
      // The scope key is filtered here, not trusted from the dataset row: a version of this
      // dataset minted under another scope key would be a bug worth refusing loudly, and the
      // unique index guarantees such a row cannot exist anyway. The id rides along as the
      // deterministic tiebreaker: createdAt alone orders versions only until two land on the
      // same clock tick, and "newest first" must not become a coin flip for those two.
      return db
        .select()
        .from(aiObservationDatasetVersions)
        .where(
          and(
            eq(aiObservationDatasetVersions.scopeKey, scope.key),
            eq(aiObservationDatasetVersions.datasetId, datasetId),
            // The M1a visibility rule, version-shaped: an in-flight dataset
            // deletion answers an empty version list.
            notPendingDeletion(
              "dataset",
              aiObservationDatasetVersions.datasetId,
            ),
          ),
        )
        .orderBy(
          desc(aiObservationDatasetVersions.createdAt),
          desc(aiObservationDatasetVersions.id),
        );
    },

    async markSyncing(scope, datasetId) {
      assertObservationScope(scope);
      reference(datasetId);
      // The state guard rides the UPDATE itself, never a read that races it (T19 review
      // finding): only pending/syncing/failed rows may enter syncing, so a synced row —
      // the one whose upstream copy exists — cannot be downgraded, however concurrent the
      // callers. A lost read-decide-write window is a missed update, not a corrupt state.
      const updated = await db
        .update(aiObservationDatasets)
        .set({ syncState: "syncing", updatedAt: new Date() })
        .where(
          and(
            scopeDataset(scope, datasetId),
            inArray(aiObservationDatasets.syncState, [
              "pending",
              "syncing",
              "failed",
            ]),
            // The sync machine is a writer, not an exemption (OCR m121): pushing
            // a dataset that is in retention deletion would re-arm a target the
            // discovery has already judged gone.
            notPendingDeletion("dataset", aiObservationDatasets.id),
          ),
        )
        .returning();
      if (updated[0]) return updated[0];
      // The guard refused. Either the dataset is absent, or it is synced and has nothing
      // to push through this state machine — read the row once more to say which.
      const dataset = await this.getDataset(scope, datasetId);
      if (!dataset) throw new DatasetStoreError("DATASET_NOT_FOUND", 404);
      return dataset;
    },

    async markSynced(scope, datasetId, opikDatasetId) {
      assertObservationScope(scope);
      reference(datasetId);
      reference(opikDatasetId);

      return db.transaction(async (tx) => {
        const found = await tx
          .select()
          .from(aiObservationDatasets)
          .where(
            and(
              scopeDataset(scope, datasetId),
              // Same writer discipline as markSyncing (OCR m121): recording an
              // upstream id onto a deletion-in-flight row would strand an orphan
              // upstream copy retention can no longer see.
              notPendingDeletion("dataset", aiObservationDatasets.id),
            ),
          )
          .for("update");
        const current = found[0];
        if (!current) throw new DatasetStoreError("DATASET_NOT_FOUND", 404);
        if (current.opikDatasetId !== null) {
          // First recorded id wins: a replay, or a divergent id signalling upstream
          // duplication, changes nothing here. A drifted non-synced state is repaired
          // rather than kept — the recorded upstream id is the proof this dataset
          // synced, so the row answers synced again (T19 review finding).
          if (current.syncState === "synced") {
            return { dataset: current, adopted: false };
          }
          const restored = await tx
            .update(aiObservationDatasets)
            .set({ syncState: "synced", updatedAt: new Date() })
            .where(eq(aiObservationDatasets.id, current.id))
            .returning();
          return { dataset: restored[0], adopted: false };
        }
        // Both updates target the id this transaction holds a FOR UPDATE lock on, so the
        // RETURNING row is a fact, not a hope — no absent-row branch to defend here.
        const updated = await tx
          .update(aiObservationDatasets)
          .set({
            syncState: "synced",
            opikDatasetId,
            updatedAt: new Date(),
          })
          .where(eq(aiObservationDatasets.id, current.id))
          .returning();
        return { dataset: updated[0], adopted: true };
      });
    },

    async markFailed(scope, datasetId) {
      assertObservationScope(scope);
      reference(datasetId);
      // Only a syncing push can fail, and the database enforces it: the conditional UPDATE
      // cannot downgrade a synced or pending row (T19 review finding), so a markFailed that
      // races a markSynced either loses the row or never matches it — never corrupts it.
      const updated = await db
        .update(aiObservationDatasets)
        .set({ syncState: "failed", updatedAt: new Date() })
        .where(
          and(
            scopeDataset(scope, datasetId),
            eq(aiObservationDatasets.syncState, "syncing"),
          ),
        )
        .returning();
      if (updated[0]) return updated[0];
      const dataset = await this.getDataset(scope, datasetId);
      if (!dataset) throw new DatasetStoreError("DATASET_NOT_FOUND", 404);
      throw new DatasetStoreError("DATASET_STATE_INVALID", 409);
    },

    async deleteDataset(scope, datasetId) {
      assertObservationScope(scope);
      reference(datasetId);
      // This is the cleanup half of partial success, not a bypass of the sync
      // state machine (OCR m125): a synced row is the only place the upstream
      // dataset id lives, and deleting it here would orphan that upstream copy
      // forever — retention's discovery scans this same table. Only a subject
      // that has nothing pushed (pending) or a failed push may be cleaned.
      const subject = await db
        .select({ syncState: aiObservationDatasets.syncState })
        .from(aiObservationDatasets)
        .where(scopeDataset(scope, datasetId));
      if (!subject[0]) throw new DatasetStoreError("DATASET_NOT_FOUND", 404);
      if (subject[0].syncState === "synced") {
        throw new DatasetStoreError("DATASET_STATE_INVALID", 409);
      }
      // The one sanctioned way past the versions' delete guard (migration 0124): the
      // transaction-local flag says "this is dataset cleanup", so a direct DELETE of a
      // frozen version is refused by the database while the cascade from here passes.
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('ai_observation.dataset_cleanup', 'on', true)`,
        );
        const removed = await tx
          .delete(aiObservationDatasets)
          .where(scopeDataset(scope, datasetId))
          .returning({ id: aiObservationDatasets.id });
        if (!removed[0]) throw new DatasetStoreError("DATASET_NOT_FOUND", 404);
      });
    },
  };
}
