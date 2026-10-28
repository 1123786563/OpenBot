import {
  afterAll,
  afterEach,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { REDACTION_POLICY_VERSION } from "../../shared/ai-observability";
import { ObservationScopeError } from "../src/ai-observability/contracts";
import {
  contentHash,
  createObservationDatasetStore,
  DatasetStoreError,
  freezeCases,
} from "../src/ai-observability/datasets";
import {
  resolveObservationScope,
  resolveStorageLocator,
} from "../src/ai-observability/scope";
import {
  aiObservationDatasets,
  aiObservationDatasetVersions,
} from "../src/db/schema/ai-observability-datasets";
import { aiObservationRetentionDeletions } from "../src/db/schema/ai-observability-retention";
import { opikTestDatabase } from "./support/opik-test-db";
import { rejectionOf } from "./support/pg-errors";

/**
 * Behavioral proof of the dataset version freeze against a real, dedicated PostgreSQL database:
 * the frozen field set, immutability enforced by the database itself, idempotent re-saves,
 * scope isolation for identical names and content, and the sync state machine where pending and
 * syncing never masquerade as success and a partial push is recovered or cleaned up — never
 * silently upgraded. There is no skip and no fallback database; a missing test database fails
 * the run.
 */

const database = opikTestDatabase();
const store = createObservationDatasetStore(database);
const prefix = `t19-${randomUUID()}`;

const scopeA = resolveObservationScope({
  actorId: "user-a",
  botId: `opik-datasets-integration-bot-a-${randomUUID()}`,
  ownership: "owner",
  epoch: 1,
});
const scopeB = resolveObservationScope({
  actorId: "user-b",
  botId: `opik-datasets-integration-bot-b-${randomUUID()}`,
  ownership: "admin",
  epoch: 1,
});

const caseA = {
  input: "Summarize the outage report.",
  referenceOutput: "A one-paragraph summary of the outage.",
  toolFixtures: { search: { query: "outage", results: 0 } },
  sourceRunId: "run-1",
  sourceAttemptId: "attempt-1",
  sourceBindingId: "binding-1",
};

afterEach(async () => {
  // The delete guard (migration 0124) refuses version rows leaving any way but dataset
  // cleanup, and that includes this suite's own cleanup: the transaction-local flag plus
  // the cascade from the subject row is the one sanctioned path. Before the guard's
  // fail-open hole was fixed, this DELETE went through unflagged — proof the hole was
  // real, not hygiene theater.
  await database.$client.begin(async (tx) => {
    await tx`select set_config('ai_observation.dataset_cleanup', 'on', true)`;
    await tx`DELETE FROM ai_observation_datasets WHERE name LIKE ${`${prefix}%`}`;
  });
  // Return the pooled connection to a known session state; see the case-review suite's
  // afterEach for why residue here once masked the guard's fail-open hole.
  await database.$client`RESET ai_observation.dataset_cleanup`;
  // The m119/m125 tests plant deletion records in this scope; the retention
  // suite's governance counts read every scope, so leave none behind.
  await database
    .delete(aiObservationRetentionDeletions)
    .where(eq(aiObservationRetentionDeletions.scopeKey, scopeA.key));
});

afterAll(async () => {
  await database.$client.close();
});

test("the dedicated test database carries the dataset schema and immutability trigger", async () => {
  const indexes = await database.$client`
    SELECT indexname FROM pg_indexes
    WHERE tablename IN ('ai_observation_datasets', 'ai_observation_dataset_versions')
  `;
  const present = new Set(indexes.map((row) => row.indexname));
  for (const required of [
    "ai_observation_datasets_scope_name_uq",
    "ai_observation_datasets_scope_opik_dataset_uq",
    "ai_observation_dataset_versions_scope_dataset_hash_uq",
  ]) {
    if (!present.has(required)) {
      throw new Error(
        `The dedicated Opik test database lacks ${required}. Apply the migrations to the dedicated test database first (TEST_DATABASE_URL=... bun run db:migrate in server/); do not point these tests at the application database and do not record this as a pass.`,
      );
    }
  }
  const trigger = await database.$client`
    SELECT tgname FROM pg_trigger
    WHERE tgname = 'ai_observation_dataset_versions_immutable' AND NOT tgisinternal
  `;
  expect(trigger).toHaveLength(1);
});

test("a saved version freezes the whole acceptance field set (Issue #25 AC1)", async () => {
  const name = `${prefix}-freeze`;
  const { dataset, version } = await store.saveVersion(scopeA, {
    datasetName: name,
    cases: [caseA],
  });

  const locator = resolveStorageLocator(scopeA);
  expect(version.contentHash).toBe(
    contentHash(freezeCases([caseA]), REDACTION_POLICY_VERSION),
  );
  expect(version.redactionPolicyVersion).toBe(REDACTION_POLICY_VERSION);
  expect(version.cases).toHaveLength(1);
  expect(version.cases[0]).toMatchObject({
    safeInput: { state: "projected", text: caseA.input },
    referenceOutput: { state: "projected", text: caseA.referenceOutput },
    sourceRunId: "run-1",
    sourceAttemptId: "attempt-1",
    sourceBindingId: "binding-1",
  });
  // The upstream locator is derived from the scope, frozen into the version, and matches the
  // subject's locator: the version can always name where its upstream copy belongs.
  expect(version.locatorWorkspace).toBe(locator.workspace);
  expect(version.locatorProject).toBe(locator.project);
  expect(dataset).toMatchObject({
    scopeKey: scopeA.key,
    actorId: "user-a",
    botId: scopeA.botId,
    name,
    syncState: "pending",
    opikDatasetId: null,
  });

  // The read side of the freeze: the version read API answers the same frozen row.
  expect(await store.getVersion(scopeA, version.id)).toEqual(version);
  expect(
    (await store.listVersions(scopeA, dataset.id)).map((v) => v.id),
  ).toEqual([version.id]);
});

test("saving the same frozen content again hits the same version (idempotency)", async () => {
  const name = `${prefix}-idempotent`;
  const first = await store.saveVersion(scopeA, {
    datasetName: name,
    cases: [caseA],
  });
  const replay = await store.saveVersion(scopeA, {
    datasetName: name,
    cases: [caseA],
  });

  expect(first.replayed).toBe(false);
  expect(replay.replayed).toBe(true);
  expect(replay.version.id).toBe(first.version.id);
  expect(replay.version.contentHash).toBe(first.version.contentHash);
  expect(replay.dataset.id).toBe(first.dataset.id);

  const rows = await database
    .select({ id: aiObservationDatasetVersions.id })
    .from(aiObservationDatasetVersions)
    .where(eq(aiObservationDatasetVersions.datasetId, first.dataset.id));
  expect(rows).toHaveLength(1);
});

test("a frozen version cannot change, at the database, whoever asks (Issue #25 AC2)", async () => {
  const name = `${prefix}-immutable`;
  const saved = await store.saveVersion(scopeA, {
    datasetName: name,
    cases: [caseA],
  });

  // The immutability guarantee is the trigger, not a discipline: an UPDATE on the frozen row
  // is refused by PostgreSQL itself.
  const refused = await rejectionOf(() =>
    database
      .update(aiObservationDatasetVersions)
      .set({ contentHash: `${saved.version.contentHash}-tampered` })
      .where(eq(aiObservationDatasetVersions.id, saved.version.id)),
  );
  expect(refused.code).toBe("23001"); // restrict_violation

  // Editing the candidate afterwards mints a different content hash, therefore a different
  // version; the frozen one still reads back byte-for-byte identical.
  const edited = await store.saveVersion(scopeA, {
    datasetName: name,
    cases: [{ ...caseA, input: "A different reviewed case." }],
  });
  expect(edited.replayed).toBe(false);
  expect(edited.version.id).not.toBe(saved.version.id);
  expect(edited.version.contentHash).not.toBe(saved.version.contentHash);
  expect(await store.getVersion(scopeA, saved.version.id)).toEqual(
    saved.version,
  );
  expect(await store.listVersions(scopeA, saved.dataset.id)).toHaveLength(2);
});

test("the same name and content under two scopes stay two subjects and two versions (AC4)", async () => {
  const name = `${prefix}-isolated`;
  const a = await store.saveVersion(scopeA, {
    datasetName: name,
    cases: [caseA],
  });
  const b = await store.saveVersion(scopeB, {
    datasetName: name,
    cases: [caseA],
  });

  expect(a.dataset.id).not.toBe(b.dataset.id);
  // Identical content hashes, but the scope participates in the version key: two rows, each
  // visible only inside its own scope.
  expect(a.version.contentHash).toBe(b.version.contentHash);
  expect(a.version.id).not.toBe(b.version.id);
  expect(await store.getDataset(scopeA, b.dataset.id)).toBeNull();
  expect(await store.getDataset(scopeB, a.dataset.id)).toBeNull();
  expect(await store.getVersion(scopeA, b.version.id)).toBeNull();
  expect(await store.getVersion(scopeB, a.version.id)).toBeNull();
  // Locators differ because they derive from the scope, not from the dataset id.
  expect(a.dataset.locatorWorkspace).not.toBe(b.dataset.locatorWorkspace);

  const rows = await database
    .select({ scopeKey: aiObservationDatasets.scopeKey })
    .from(aiObservationDatasets)
    .where(eq(aiObservationDatasets.name, name));
  expect(rows.map((row) => row.scopeKey).sort()).toEqual(
    [scopeA.key, scopeB.key].sort(),
  );
});

test("pending and syncing never masquerade as success, and sync records the upstream id", async () => {
  const name = `${prefix}-sync`;
  const saved = await store.saveVersion(scopeA, {
    datasetName: name,
    cases: [caseA],
  });

  // A fresh dataset is pending, without an upstream id: not success, by construction.
  expect(saved.dataset).toMatchObject({
    syncState: "pending",
    opikDatasetId: null,
  });

  // The database itself refuses a synced state without the upstream id.
  const check = await rejectionOf(() =>
    database
      .update(aiObservationDatasets)
      .set({ syncState: "synced" })
      .where(eq(aiObservationDatasets.id, saved.dataset.id)),
  );
  expect(check.code).toBe("23514"); // check_violation

  // The push begins, fails, and is retried to success — partial success recovers.
  const syncing = await store.markSyncing(scopeA, saved.dataset.id);
  expect(syncing.syncState).toBe("syncing");
  expect(syncing.opikDatasetId).toBeNull();
  const failed = await store.markFailed(scopeA, saved.dataset.id);
  expect(failed.syncState).toBe("failed");
  const retried = await store.markSyncing(scopeA, saved.dataset.id);
  expect(retried.syncState).toBe("syncing");

  const synced = await store.markSynced(scopeA, saved.dataset.id, "opik-ds-1");
  expect(synced.adopted).toBe(true);
  expect(synced.dataset).toMatchObject({
    syncState: "synced",
    opikDatasetId: "opik-ds-1",
  });

  // First recorded id stands: a replay, or a divergent id signalling upstream duplication,
  // changes nothing here.
  const again = await store.markSynced(scopeA, saved.dataset.id, "opik-ds-1");
  expect(again.adopted).toBe(false);
  const divergent = await store.markSynced(
    scopeA,
    saved.dataset.id,
    "opik-ds-1-duplicate",
  );
  expect(divergent.adopted).toBe(false);
  expect(divergent.dataset.opikDatasetId).toBe("opik-ds-1");

  // A synced dataset has nothing to re-push through this state machine.
  expect((await store.markSyncing(scopeA, saved.dataset.id)).syncState).toBe(
    "synced",
  );
});

test("the database holds the second uniqueness authority for upstream ids", async () => {
  const one = await store.saveVersion(scopeA, {
    datasetName: `${prefix}-upstream-1`,
    cases: [caseA],
  });
  const two = await store.saveVersion(scopeA, {
    datasetName: `${prefix}-upstream-2`,
    cases: [caseA],
  });
  await store.markSynced(scopeA, one.dataset.id, `${prefix}-opik-ds`);

  const clash = await rejectionOf(() =>
    store.markSynced(scopeA, two.dataset.id, `${prefix}-opik-ds`),
  );
  expect(clash.code).toBe("23505");
});

test("an abandoned dataset is cleaned up, subject and frozen versions together", async () => {
  const name = `${prefix}-cleanup`;
  const saved = await store.saveVersion(scopeA, {
    datasetName: name,
    cases: [caseA],
  });
  await store.markSyncing(scopeA, saved.dataset.id);
  await store.markFailed(scopeA, saved.dataset.id);

  await store.deleteDataset(scopeA, saved.dataset.id);

  expect(await store.getDataset(scopeA, saved.dataset.id)).toBeNull();
  expect(await store.getVersion(scopeA, saved.version.id)).toBeNull();
  const rows = await database
    .select({ id: aiObservationDatasetVersions.id })
    .from(aiObservationDatasetVersions)
    .where(eq(aiObservationDatasetVersions.datasetId, saved.dataset.id));
  expect(rows).toHaveLength(0);

  await expect(store.deleteDataset(scopeA, saved.dataset.id)).rejects.toThrow(
    new DatasetStoreError("DATASET_NOT_FOUND", 404),
  );
});

test("a forged scope is refused even against the real database", async () => {
  const forged = { ...scopeA };
  expect(() =>
    store.saveVersion(forged, {
      datasetName: `${prefix}-forged`,
      cases: [caseA],
    }),
  ).toThrow(new ObservationScopeError("OWNERSHIP_REQUIRED", 403));

  const rows = await database
    .select({ id: aiObservationDatasets.id })
    .from(aiObservationDatasets)
    .where(eq(aiObservationDatasets.name, `${prefix}-forged`));
  expect(rows).toHaveLength(0);
});

test("rolling the datasets migration back drops only the dataset objects", async () => {
  const client = database.$client;
  const tablesBefore = await client`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `;
  const namesBefore = tablesBefore.map((row) => row.tablename);

  class Rollback extends Error {}
  try {
    await client.begin(async (transaction: TransactionSQL) => {
      await transaction`DROP TRIGGER IF EXISTS "ai_observation_dataset_versions_immutable" ON "ai_observation_dataset_versions"`;
      await transaction`DROP FUNCTION IF EXISTS "ai_observation_dataset_versions_reject_update"`;
      // CASCADE because T22's experiments pin the versions with a foreign key:
      // a real rollback drops that constraint with the table, and the
      // referencing experiments table survives (asserted below).
      await transaction`DROP TABLE IF EXISTS "ai_observation_dataset_versions" CASCADE`;
      await transaction`DROP TABLE IF EXISTS "ai_observation_datasets"`;
      const tablesAfter = await transaction`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
      `;
      // Exactly the two dataset tables left, every neighbour — including the T07 bindings
      // table and the journal — still there.
      expect(tablesAfter.map((row) => row.tablename)).toEqual(
        namesBefore.filter(
          (name) =>
            name !== "ai_observation_datasets" &&
            name !== "ai_observation_dataset_versions",
        ),
      );
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }

  // The rollback was itself rolled back: the suite's own tables are still there for cleanup.
  const restored = await client`
    SELECT to_regclass('ai_observation_dataset_versions')::text AS present
  `;
  expect(restored[0]?.present).toBe("ai_observation_dataset_versions");
});

// --- OCR round-1 fix: m119/m120/m121/m125 — the M1a rule covers every writer too ---

async function deletingDataset(scope: typeof scopeA, datasetId: string) {
  await database.insert(aiObservationRetentionDeletions).values({
    id: randomUUID(),
    scopeKey: scope.key,
    actorId: scope.actorId,
    botId: scope.botId,
    kind: "dataset",
    targetId: datasetId,
    retentionDays: 30,
    state: "pending",
  });
}

test("a deletion-in-flight dataset is gone to the reverse lookup, the freeze target and the sync writers (OCR m119/m120/m121)", async () => {
  const datasetName = `t19-m119-${randomUUID()}`;
  const { dataset } = await store.saveVersion(scopeA, {
    datasetName,
    cases: [caseA],
  });
  const opikId = `opik-m119-${randomUUID()}`;
  await store.markSynced(scopeA, dataset.id, opikId);
  await deletingDataset(scopeA, dataset.id);

  expect(await store.byOpikDatasetId(scopeA, opikId)).toBeNull();
  // The subject is invisible to readers, so a save under the same name must not
  // silently reuse it as the freeze target — the M1a refusal, before an immutable
  // version lands on a row the cascade is about to destroy.
  await expect(
    store.saveVersion(scopeA, { datasetName, cases: [caseA] }),
  ).rejects.toThrow(new DatasetStoreError("DATASET_NOT_FOUND", 404));
  await expect(store.markSyncing(scopeA, dataset.id)).rejects.toThrow(
    new DatasetStoreError("DATASET_NOT_FOUND", 404),
  );
  await expect(
    store.markSynced(scopeA, dataset.id, `opik-m119b-${randomUUID()}`),
  ).rejects.toThrow(new DatasetStoreError("DATASET_NOT_FOUND", 404));
});

/**
 * The sub-statement window no external caller can otherwise reach: the store's own
 * transaction runs its Nth `select` only after `armed` has committed. The conflicting
 * row vanishes between the INSERT that saw it and the read-back that must explain
 * it — exactly the retention-cascade race the "conflicted but absent" branches exist
 * for (OCR R2-35).
 */
function storeWithArmedSelect(
  arm: (selectIndex: number) => Promise<void> | undefined,
) {
  const hooked = {
    ...database,
    transaction: (callback: (tx: never) => unknown) =>
      database.transaction(async (tx) => {
        let selects = 0;
        const originalSelect = tx.select.bind(tx);
        (tx as { select: unknown }).select = (...args: unknown[]) => {
          const builder = originalSelect(
            ...(args as Parameters<typeof originalSelect>),
          );
          const originalFrom = builder.from.bind(builder);
          builder.from = (table: Parameters<typeof originalFrom>[0]) => {
            // The object `.from()` hands back is the awaited query; `.where()`
            // returns it unchanged, so a then-wrap here sees the execution.
            const query = originalFrom(table);
            selects += 1;
            const armed = arm(selects);
            if (!armed) return query;
            const then = query.then.bind(query);
            // Intentional thenable wrap (biome-ignore in the next line): this IS a
            // then property — the hook point that lets the armed commit run inside
            // the store's sub-statement window before the query executes.
            // biome-ignore lint/suspicious/noThenProperty: intentional test hook, see above.
            query.then = (
              resolve: (value: never) => unknown,
              reject: (reason?: unknown) => unknown,
            ) => armed.then(() => then(resolve, reject), reject);
            return query;
          };
          return builder;
        };
        return callback(tx as never);
      }),
  };
  return createObservationDatasetStore(hooked as unknown as typeof database);
}

/**
 * The same sub-statement window, armed on the store's Nth UPDATE: the write runs
 * only after `armed` has committed — the moment a concurrent writer's commit
 * (retention's deletion record) lands between the locked read and the UPDATE
 * that must re-decide (OCR R5-24). A row-level lock covers the datasets table,
 * never the deletions table, so this window is otherwise unreachable.
 */
function storeWithArmedUpdate(
  arm: (updateIndex: number) => Promise<void> | undefined,
) {
  const hooked = {
    ...database,
    transaction: (callback: (tx: never) => unknown) =>
      database.transaction(async (tx) => {
        let updates = 0;
        const originalUpdate = tx.update.bind(tx);
        (tx as { update: unknown }).update = (...args: unknown[]) => {
          const builder = originalUpdate(
            ...(args as Parameters<typeof originalUpdate>),
          );
          const originalSet = builder.set.bind(builder);
          builder.set = (...setArgs: unknown[]) => {
            const setBuilder = originalSet(
              ...(setArgs as Parameters<typeof originalSet>),
            );
            const originalWhere = setBuilder.where.bind(setBuilder);
            setBuilder.where = (...whereArgs: unknown[]) => {
              const query = originalWhere(
                ...(whereArgs as Parameters<typeof originalWhere>),
              );
              const originalReturning = query.returning.bind(query);
              query.returning = (...returningArgs: unknown[]) => {
                const awaited = originalReturning(
                  ...(returningArgs as Parameters<typeof originalReturning>),
                );
                updates += 1;
                const armed = arm(updates);
                if (!armed) return awaited;
                const then = awaited.then.bind(awaited);
                // Intentional thenable wrap (see storeWithArmedSelect): the hook
                // point that lets the armed commit run before the UPDATE executes.
                // biome-ignore lint/suspicious/noThenProperty: intentional test hook, see above.
                awaited.then = (
                  resolve: (value: never) => unknown,
                  reject: (reason?: unknown) => unknown,
                ) => armed.then(() => then(resolve, reject), reject);
                return awaited;
              };
              return query;
            };
            return setBuilder;
          };
          return builder;
        };
        return callback(tx as never);
      }),
  };
  return createObservationDatasetStore(hooked as unknown as typeof database);
}

/**
 * The window armed on the store's Nth INSERT: the insert runs only after `armed`
 * has settled — the moment a concurrent deleteDataset lands between the
 * conflict-reuse read-back and the version INSERT that must not find its subject
 * cascaded away (OCR R5-19).
 */
function storeWithArmedInsert(
  arm: (insertIndex: number) => Promise<void> | undefined,
) {
  const hooked = {
    ...database,
    transaction: (callback: (tx: never) => unknown) =>
      database.transaction(async (tx) => {
        let inserts = 0;
        const originalInsert = tx.insert.bind(tx);
        (tx as { insert: unknown }).insert = (...args: unknown[]) => {
          const builder = originalInsert(
            ...(args as Parameters<typeof originalInsert>),
          );
          const originalValues = builder.values.bind(builder);
          builder.values = (...valuesArgs: unknown[]) => {
            const valueBuilder = originalValues(
              ...(valuesArgs as Parameters<typeof originalValues>),
            );
            const originalConflict =
              valueBuilder.onConflictDoNothing.bind(valueBuilder);
            valueBuilder.onConflictDoNothing = (...conflictArgs: unknown[]) => {
              const conflictBuilder = originalConflict(
                ...(conflictArgs as Parameters<typeof originalConflict>),
              );
              const originalReturning =
                conflictBuilder.returning.bind(conflictBuilder);
              conflictBuilder.returning = (...returningArgs: unknown[]) => {
                const awaited = originalReturning(
                  ...(returningArgs as Parameters<typeof originalReturning>),
                );
                inserts += 1;
                const armed = arm(inserts);
                if (!armed) return awaited;
                const then = awaited.then.bind(awaited);
                // Intentional thenable wrap (see storeWithArmedSelect).
                // biome-ignore lint/suspicious/noThenProperty: intentional test hook, see above.
                awaited.then = (
                  resolve: (value: never) => unknown,
                  reject: (reason?: unknown) => unknown,
                ) => armed.then(() => then(resolve, reject), reject);
                return awaited;
              };
              return conflictBuilder;
            };
            return valueBuilder;
          };
          return builder;
        };
        return callback(tx as never);
      }),
  };
  return createObservationDatasetStore(hooked as unknown as typeof database);
}

/** Deletes a dataset subject the only sanctioned way: under the cleanup flag. */
const cleanupDataset = (id: string) =>
  database.$client.begin(async (tx: TransactionSQL) => {
    await tx`select set_config('ai_observation.dataset_cleanup', 'on', true)`;
    await tx`delete from ai_observation_datasets where id = ${id}`;
  });

test("deleteDataset refuses a syncing subject: only pending or failed may be cleaned (OCR R2-34)", async () => {
  const { dataset } = await store.saveVersion(scopeA, {
    datasetName: `t19-r234-${randomUUID()}`,
    cases: [caseA],
  });
  await store.markSyncing(scopeA, dataset.id);

  // The old guard pre-checked only `synced`, so a syncing subject — a push in
  // flight, the exact state the cleanup comment says must not be raced — sailed
  // through and was deleted under the push.
  await expect(store.deleteDataset(scopeA, dataset.id)).rejects.toThrow(
    new DatasetStoreError("DATASET_STATE_INVALID", 409),
  );
  // The refusal is real: subject and frozen versions survive.
  expect(await store.getDataset(scopeA, dataset.id)).not.toBeNull();
  const versions = await database
    .select({ id: aiObservationDatasetVersions.id })
    .from(aiObservationDatasetVersions)
    .where(eq(aiObservationDatasetVersions.datasetId, dataset.id));
  expect(versions).toHaveLength(1);
});

test("the delete decision rides the DELETE: a markSynced committing under a racing delete wins (OCR R2-34)", async () => {
  const { dataset } = await store.saveVersion(scopeA, {
    datasetName: `t19-r234b-${randomUUID()}`,
    cases: [caseA],
  });
  // Hold the row's write lock the way a concurrent push holds it between the
  // victim's precheck and its DELETE: the precheck reads the still-pending
  // committed row, the DELETE blocks, then the push commits synced. A decision
  // made outside the deleting statement is a decision about a row that no
  // longer exists by the time the statement runs. The assertion waits outside
  // the holding transaction: the DELETE can only unblock at COMMIT, which bun's
  // begin() issues after the callback resolves.
  let racing: Promise<unknown> | undefined;
  await database.$client.begin(async (tx: TransactionSQL) => {
    await tx`select sync_state from ai_observation_datasets where id = ${dataset.id} for update`;
    racing = store.deleteDataset(scopeA, dataset.id);
    // Let the victim's precheck run against the locked-but-pending row and its
    // transaction reach the blocked DELETE.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await tx`update ai_observation_datasets
             set sync_state = 'synced', opik_dataset_id = ${`opik-r234-${randomUUID()}`}
             where id = ${dataset.id}`;
    // Pre-fix the unblocked DELETE wipes the synced row; post-fix it matches
    // nothing and the read-back classifies the survivor as 409.
  });
  await expect(racing).rejects.toThrow(
    new DatasetStoreError("DATASET_STATE_INVALID", 409),
  );
  const rows = await database
    .select({ syncState: aiObservationDatasets.syncState })
    .from(aiObservationDatasets)
    .where(eq(aiObservationDatasets.id, dataset.id));
  expect(rows).toEqual([{ syncState: "synced" }]);
});

test("a conflict whose subject vanished mid-transaction answers 404, never a bare error (OCR R2-35)", async () => {
  const name = `t19-r235-${randomUUID()}`;
  const saved = await store.saveVersion(scopeA, {
    datasetName: name,
    cases: [caseA],
  });
  // The conflicting INSERT sees the committed subject; the read-back must not.
  // Arm the read-back (the tx's first select): the subject is deleted inside the
  // window between the conflict and the explanation, the retention-cascade shape.
  const armed = storeWithArmedSelect((index) =>
    index === 1 ? cleanupDataset(saved.dataset.id) : undefined,
  );
  await expect(
    armed.saveVersion(scopeA, { datasetName: name, cases: [caseA] }),
  ).rejects.toThrow(new DatasetStoreError("DATASET_NOT_FOUND", 404));
});

test("a conflict whose version vanished mid-transaction answers 404, never a bare error (OCR R2-35)", async () => {
  const name = `t19-r235b-${randomUUID()}`;
  const { dataset, version } = await store.saveVersion(scopeA, {
    datasetName: name,
    cases: [caseA],
  });
  // The same name and hash re-saved: the dataset conflict resolves to the
  // subject, the version INSERT conflicts, and the version read-back (the tx's
  // second select) is armed so the conflicting version is gone by the time the
  // store must explain the conflict.
  const armed = storeWithArmedSelect((index) =>
    index === 2
      ? database.$client.begin(async (tx: TransactionSQL) => {
          await tx`select set_config('ai_observation.dataset_cleanup', 'on', true)`;
          await tx`delete from ai_observation_dataset_versions where id = ${version.id}`;
        })
      : undefined,
  );
  await expect(
    armed.saveVersion(scopeA, { datasetName: name, cases: [caseA] }),
  ).rejects.toThrow(new DatasetStoreError("DATASET_NOT_FOUND", 404));
  expect(await store.getDataset(scopeA, dataset.id)).not.toBeNull();
});

test("the sync write re-checks deletion: a deletion record committing in the markSynced window wins the row (OCR R5-24)", async () => {
  const { dataset } = await store.saveVersion(scopeA, {
    datasetName: `${prefix}-r524-${randomUUID()}`,
    cases: [caseA],
  });
  // The SELECT's FOR UPDATE lock covers the datasets row, never the deletions
  // table: retention's offer commits a deletion record in the window between
  // the locked read and the UPDATE, and an UPDATE whose WHERE carries only the
  // id would record an upstream id onto a row retention has already judged
  // gone — the orphaned upstream copy the m121 discipline forbids. The write
  // must carry the same notPendingDeletion filter the read did, and a row the
  // filter excludes answers the same 404 every reader now gets.
  const armed = storeWithArmedUpdate(() => deletingDataset(scopeA, dataset.id));
  await expect(
    armed.markSynced(scopeA, dataset.id, `opik-r524-${randomUUID()}`),
  ).rejects.toThrow(new DatasetStoreError("DATASET_NOT_FOUND", 404));
  const rows = await database
    .select({
      syncState: aiObservationDatasets.syncState,
      opikDatasetId: aiObservationDatasets.opikDatasetId,
    })
    .from(aiObservationDatasets)
    .where(eq(aiObservationDatasets.id, dataset.id));
  expect(rows).toEqual([{ syncState: "pending", opikDatasetId: null }]);
});

test("the conflict-reuse read-back holds the row's lock: the racing cleanup cannot slip between it and the version INSERT (OCR R5-19)", async () => {
  const datasetName = `${prefix}-r519-${randomUUID()}`;
  const saved = await store.saveVersion(scopeA, {
    datasetName,
    cases: [caseA],
  });
  // The reuse SELECT reads the committed subject; a deleteDataset committing in
  // the window before the version INSERT cascades the subject away and the
  // INSERT dies as a bare FK violation — the raw 500 R2-35 promised never to
  // answer. With the read-back taken FOR UPDATE (markSynced's lock discipline),
  // the cleanup blocks until the freeze commits: the save wins the window, the
  // delete lands after — and the subject is still cleanable then.
  let racing = "unrun";
  const armed = storeWithArmedInsert(async (index) => {
    if (index !== 2) return; // the version INSERT, after the reuse read-back
    try {
      await database.$client.begin(async (tx: TransactionSQL) => {
        await tx`select set_config('ai_observation.dataset_cleanup', 'on', true)`;
        await tx`set local lock_timeout = '300ms'`;
        await tx`delete from ai_observation_datasets where id = ${saved.dataset.id}`;
      });
      racing = "deleted";
    } catch (error) {
      const state = error as { errno?: string; code?: string };
      if (state.errno === "55P03" || state.code === "55P03") {
        racing = "blocked"; // the freeze's lock held the window: save wins
        return;
      }
      throw error;
    }
  });
  const outcome = await armed.saveVersion(scopeA, {
    datasetName,
    cases: [{ ...caseA, input: "A different reviewed input." }],
  });
  expect(outcome.replayed).toBe(false);
  expect(racing).toBe("blocked");
  expect(await store.getDataset(scopeA, saved.dataset.id)).not.toBeNull();
  await store.deleteDataset(scopeA, saved.dataset.id);
  expect(await store.getDataset(scopeA, saved.dataset.id)).toBeNull();
});

test("deleteDataset refuses a synced subject: the upstream mapping must not be orphaned (OCR m125)", async () => {
  const { dataset } = await store.saveVersion(scopeA, {
    datasetName: `t19-m125-${randomUUID()}`,
    cases: [caseA],
  });
  await store.markSynced(scopeA, dataset.id, `opik-m125-${randomUUID()}`);
  await expect(store.deleteDataset(scopeA, dataset.id)).rejects.toThrow(
    new DatasetStoreError("DATASET_STATE_INVALID", 409),
  );
  // A pending subject — nothing pushed — is still cleanable.
  const pending = await store.saveVersion(scopeA, {
    datasetName: `t19-m125b-${randomUUID()}`,
    cases: [caseA],
  });
  await store.deleteDataset(scopeA, pending.dataset.id);
  expect(await store.getDataset(scopeA, pending.dataset.id)).toBeNull();
});
