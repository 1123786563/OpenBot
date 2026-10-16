import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TransactionSQL } from "bun";
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
  botId: "agent-1",
  ownership: "owner",
  epoch: 1,
});
const scopeB = resolveObservationScope({
  actorId: "user-b",
  botId: "agent-1",
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
    botId: "agent-1",
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
