import {
  afterAll,
  afterEach,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { eq, sql } from "drizzle-orm";
import { REDACTION_POLICY_VERSION } from "../../shared/ai-observability";
import {
  createRunBindingStore,
  type RunBinding,
} from "../src/ai-observability/bindings";
import {
  type CaseFragment,
  CaseReviewError,
  createCaseReviewService,
} from "../src/ai-observability/case-review";
import {
  contentHash,
  createObservationDatasetStore,
  DatasetStoreError,
  freezeCases,
} from "../src/ai-observability/datasets";
import { resolveObservationScope } from "../src/ai-observability/scope";
import { createAuditStore } from "../src/audit";
import { aiObservationBindings } from "../src/db/schema/ai-observability-bindings";
import {
  aiObservationDatasets,
  aiObservationDatasetVersions,
} from "../src/db/schema/ai-observability-datasets";
import { testDatabaseUrl } from "./support/database";
import { opikTestDatabase } from "./support/opik-test-db";
import { rejectionOf } from "./support/pg-errors";

/**
 * Behavioral proof of the case review + save surface (Issue #26 / DAG T20) against a real,
 * dedicated PostgreSQL database: the full select→review→save flow freezing through the T19
 * pipeline with binding-derived provenance, idempotent re-saves, the audit trail carrying
 * attribution and time, the canary guaranteeing no secret literal ever lands in a frozen
 * version, scope isolation consistent with T11/T19 — and the three T19 review findings this
 * ticket merges: guarded sync-state transitions that cannot downgrade a synced row, a
 * database trigger refusing direct version deletes while the explicit cleanup path passes,
 * and a deterministic listVersions order. There is no skip and no fallback database; a
 * missing test database fails the run.
 *
 * Audit rows are append-only by trigger, so this suite never cleans them up: assertions
 * always filter by the run's unique prefix.
 */

const database = opikTestDatabase();
const bindingsStore = createRunBindingStore(database);
const datasetsStore = createObservationDatasetStore(database);
const service = createCaseReviewService({
  bindings: bindingsStore,
  datasets: datasetsStore,
  audit: createAuditStore(database),
});
const prefix = `t20-${randomUUID()}`;

const scopeA = resolveObservationScope({
  actorId: "user-a",
  botId: `opik-case-review-integration-bot-a-${randomUUID()}`,
  ownership: "owner",
  epoch: 1,
});
const scopeB = resolveObservationScope({
  actorId: "user-b",
  botId: `opik-case-review-integration-bot-b-${randomUUID()}`,
  ownership: "admin",
  epoch: 1,
});

const fragment: CaseFragment = {
  input: "Summarize the outage report.",
  referenceOutput: "A one-paragraph summary of the outage.",
  toolFixtures: { search: { query: "outage", results: 0 } },
};

/** One observed run, bound under one scope — the ownership fact every test starts from. */
async function boundRun(
  scope: typeof scopeA,
  runId: string,
): Promise<RunBinding> {
  const begun = await bindingsStore.begin(scope, {
    runId,
    attemptId: `${runId}-attempt`,
    traceId: `${runId}-trace`,
    capability: "detailed",
    expiresAt: new Date("2026-10-23T00:00:00.000Z"),
  });
  return begun.binding;
}

const auditRows = (eventType: string, runId: string) =>
  database.$client`
    SELECT actor_user_id, initiator_kind, created_at, payload
    FROM audit_events
    WHERE event_type = ${eventType} AND payload->>'runId' = ${runId}
    ORDER BY created_at DESC
  `;

afterEach(async () => {
  // The delete guard allows version rows to leave only through dataset cleanup, and this
  // is that path: the transaction-local flag plus the cascade from the subject row.
  await database.$client.begin(async (tx) => {
    await tx`select set_config('ai_observation.dataset_cleanup', 'on', true)`;
    await tx`DELETE FROM ai_observation_datasets WHERE name LIKE ${`${prefix}%`}`;
  });
  // The flag above must not outlive the cleanup on the pooled connection it ran on:
  // residue there once masked the guard's fail-open hole (a fresh connection deleted
  // through, while the pool's connections refused by leftover state, not by logic).
  // DISCARD SETS would be the general reset, but it is a PostgreSQL 17 feature and this
  // server is 16 — the explicit RESET names the one setting this suite ever touches,
  // returning the connection to a known state (unset, which reads as NULL-or-empty) so
  // what a test proves about the guard is about the guard, never about the test before
  // it. The fresh-connection test below pins the NULL side of that state.
  await database.$client`RESET ai_observation.dataset_cleanup`;
  await database
    .delete(aiObservationBindings)
    .where(sql`${aiObservationBindings.runId} LIKE ${`${prefix}%`}`);
});

afterAll(async () => {
  await database.$client.close();
});

test("the dedicated test database carries the dataset schema and delete guard", async () => {
  const trigger = await database.$client`
    SELECT tgname FROM pg_trigger
    WHERE tgname = 'ai_observation_dataset_versions_cleanup_only' AND NOT tgisinternal
  `;
  expect(trigger).toHaveLength(1);
});

test("the full flow: select fragments, review, save as an immutable version (AC1+AC2)", async () => {
  const runId = `${prefix}-run-flow`;
  const binding = await boundRun(scopeA, runId);

  const reviewed = await service.review(scopeA, {
    runId,
    decision: "approved",
    cases: [fragment, { ...fragment, input: "A second reviewed fragment." }],
  });
  expect(reviewed.decision).toBe("approved");
  expect(reviewed.attemptId).toBe(binding.attemptId);
  expect(reviewed.preview).toHaveLength(2);

  const saved = await service.saveReviewed(scopeA, {
    datasetName: `${prefix}-flow`,
    runId,
    cases: [fragment, { ...fragment, input: "A second reviewed fragment." }],
  });
  // The freeze through the case-review path is the T19 freeze: the review's projection
  // preview and the saved version are the same content, therefore the same canonical
  // hash — provenance included, read from the binding rather than accepted from the caller.
  expect(saved.version.contentHash).toBe(contentHash(reviewed.preview));
  expect(saved.version.cases[0]).toMatchObject({
    sourceRunId: runId,
    sourceAttemptId: binding.attemptId,
    sourceBindingId: binding.id,
  });
  expect(await datasetsStore.getVersion(scopeA, saved.version.id)).toEqual(
    saved.version,
  );

  // AC3: the review action's record — attribution and time in the audit row's own columns.
  const reviewedRows = await auditRows("opik.case_reviewed", runId);
  expect(reviewedRows).toHaveLength(1);
  expect(reviewedRows[0]).toMatchObject({
    actor_user_id: "user-a",
    initiator_kind: "person",
  });
  expect(reviewedRows[0]?.created_at).not.toBeNull();

  const savedRows = await auditRows("opik.dataset_version_saved", runId);
  expect(savedRows).toHaveLength(1);
  expect(savedRows[0]?.payload).toMatchObject({
    datasetId: saved.dataset.id,
    versionId: saved.version.id,
    contentHash: saved.version.contentHash,
    replayed: false,
  });
});

test("saving the same reviewed content again hits the same version (idempotency)", async () => {
  const runId = `${prefix}-run-idem`;
  await boundRun(scopeA, runId);

  const first = await service.saveReviewed(scopeA, {
    datasetName: `${prefix}-idem`,
    runId,
    cases: [fragment],
  });
  const replay = await service.saveReviewed(scopeA, {
    datasetName: `${prefix}-idem`,
    runId,
    cases: [fragment],
  });

  expect(first.replayed).toBe(false);
  expect(replay.replayed).toBe(true);
  expect(replay.version.id).toBe(first.version.id);
  const rows = await database
    .select({ id: aiObservationDatasetVersions.id })
    .from(aiObservationDatasetVersions)
    .where(eq(aiObservationDatasetVersions.datasetId, first.dataset.id));
  expect(rows).toHaveLength(1);

  // Both saves left their trail, and the replay says so in its payload.
  const rowsAudit = await auditRows("opik.dataset_version_saved", runId);
  expect(rowsAudit).toHaveLength(2);
  expect(rowsAudit[0]?.payload).toMatchObject({ replayed: true });
});

test("the canary: a secret literal never lands in a frozen version, whatever the caller claims (AC4)", async () => {
  const runId = `${prefix}-run-canary`;
  await boundRun(scopeA, runId);
  const tainted = [
    {
      ...fragment,
      input: "sk-live-abc123def456ghi789jkl012 is not a case input",
    },
    {
      ...fragment,
      referenceOutput: "postgres://u:p@h/db is not a reference output",
    },
  ];

  const reviewed = await service.review(scopeA, {
    runId,
    decision: "approved",
    cases: tainted,
  });
  expect(reviewed.canaryFindings).toBe(2);

  const saved = await service.saveReviewed(scopeA, {
    datasetName: `${prefix}-canary`,
    runId,
    cases: tainted,
  });
  expect(saved.canaryFindings).toBe(2);
  expect(saved.version.cases[0]?.safeInput).toEqual({
    state: "omitted",
    reason: "credential",
  });
  expect(saved.version.cases[1]?.referenceOutput).toEqual({
    state: "omitted",
    reason: "connection_string",
  });

  // The stored row itself: neither literal appears anywhere in the frozen content.
  const stored = await database.$client`
    SELECT cases::text AS frozen FROM ai_observation_dataset_versions WHERE id = ${saved.version.id}
  `;
  expect(stored[0]?.frozen).not.toContain("sk-live-abc123def456ghi789jkl012");
  expect(stored[0]?.frozen).not.toContain("postgres://u:p@h/db");

  // And the trail carries the count, never the content.
  const rows = await auditRows("opik.case_reviewed", runId);
  expect(rows[0]?.payload).toMatchObject({ canaryFindings: 2 });
  expect(JSON.stringify(rows[0]?.payload)).not.toContain(
    "sk-live-abc123def456ghi789jkl012",
  );
});

test("two scopes stay isolated: another scope's run is not found, and identical names never merge (AC5)", async () => {
  const runId = `${prefix}-run-iso`;
  await boundRun(scopeA, runId);

  // A run only scopeA bound is invisible to scopeB — before any projection or freeze.
  await expect(
    service.review(scopeB, { runId, decision: "approved", cases: [fragment] }),
  ).rejects.toThrow(new CaseReviewError("CASE_REVIEW_RUN_NOT_FOUND", 404));
  await expect(
    service.saveReviewed(scopeB, {
      datasetName: `${prefix}-iso`,
      runId,
      cases: [fragment],
    }),
  ).rejects.toThrow(new CaseReviewError("CASE_REVIEW_RUN_NOT_FOUND", 404));
  expect(await auditRows("opik.case_reviewed", runId)).toHaveLength(0);

  // T07: the same run id under scopeB is a different binding, so scopeB curates its own.
  await boundRun(scopeB, runId);
  const a = await service.saveReviewed(scopeA, {
    datasetName: `${prefix}-iso`,
    runId,
    cases: [fragment],
  });
  const b = await service.saveReviewed(scopeB, {
    datasetName: `${prefix}-iso`,
    runId,
    cases: [fragment],
  });
  expect(a.dataset.id).not.toBe(b.dataset.id);
  // Same reviewed text, different content hash: the frozen content carries provenance,
  // and each scope's binding is its own observation — two scopes distilling the same
  // words are two versions, never one shared row.
  expect(a.version.contentHash).not.toBe(b.version.contentHash);
  expect(await datasetsStore.getDataset(scopeA, b.dataset.id)).toBeNull();
  expect(await datasetsStore.getVersion(scopeB, a.version.id)).toBeNull();
});

test("hardening (a): a synced row cannot be downgraded, and a drifted state is repaired", async () => {
  const runId = `${prefix}-run-guard`;
  await boundRun(scopeA, runId);
  const saved = await service.saveReviewed(scopeA, {
    datasetName: `${prefix}-guard`,
    runId,
    cases: [fragment],
  });
  const datasetId = saved.dataset.id;

  await datasetsStore.markSyncing(scopeA, datasetId);
  const synced = await datasetsStore.markSynced(scopeA, datasetId, "opik-ds-1");
  expect(synced.dataset.syncState).toBe("synced");

  // markFailed can only fail a syncing push: a synced row is refused and stays synced.
  await expect(datasetsStore.markFailed(scopeA, datasetId)).rejects.toThrow(
    new DatasetStoreError("DATASET_STATE_INVALID", 409),
  );
  expect((await datasetsStore.getDataset(scopeA, datasetId))?.syncState).toBe(
    "synced",
  );
  // markSyncing has nothing to push either: the guarded UPDATE does not match.
  expect((await datasetsStore.markSyncing(scopeA, datasetId)).syncState).toBe(
    "synced",
  );

  // The first-id branch of markSynced repairs drift instead of keeping it: the recorded
  // upstream id is the proof this dataset synced.
  await database
    .update(aiObservationDatasets)
    .set({ syncState: "failed" })
    .where(eq(aiObservationDatasets.id, datasetId));
  const restored = await datasetsStore.markSynced(
    scopeA,
    datasetId,
    "opik-ds-1",
  );
  expect(restored.adopted).toBe(false);
  expect(restored.dataset.syncState).toBe("synced");

  // The concurrency the guards exist for: a push beginning and its acknowledgment
  // landing at once. Either order converges on synced — never on a downgrade.
  const concurrent = await service.saveReviewed(scopeA, {
    datasetName: `${prefix}-guard-race`,
    runId,
    cases: [{ ...fragment, input: "A different reviewed case." }],
  });
  await Promise.all([
    datasetsStore.markSyncing(scopeA, concurrent.dataset.id),
    datasetsStore.markSynced(scopeA, concurrent.dataset.id, "opik-ds-race"),
  ]);
  const after = await datasetsStore.getDataset(scopeA, concurrent.dataset.id);
  expect(after).toMatchObject({
    syncState: "synced",
    opikDatasetId: "opik-ds-race",
  });
});

test("hardening (b): a direct version delete is refused by the database; cleanup still passes", async () => {
  const runId = `${prefix}-run-del`;
  await boundRun(scopeA, runId);
  const saved = await service.saveReviewed(scopeA, {
    datasetName: `${prefix}-del`,
    runId,
    cases: [fragment],
  });

  // Whoever asks, whatever path let them: PostgreSQL itself refuses.
  const refused = await rejectionOf(() =>
    database
      .delete(aiObservationDatasetVersions)
      .where(eq(aiObservationDatasetVersions.id, saved.version.id)),
  );
  expect(refused.code).toBe("23001"); // restrict_violation
  expect(refused.message).toContain("dataset cleanup");

  // The explicit API is the one sanctioned path, and it still works.
  await datasetsStore.deleteDataset(scopeA, saved.dataset.id);
  expect(await datasetsStore.getVersion(scopeA, saved.version.id)).toBeNull();
});

test("the delete guard holds on a connection with no session state at all (C-1)", async () => {
  const runId = `${prefix}-run-fresh`;
  await boundRun(scopeA, runId);
  const saved = await service.saveReviewed(scopeA, {
    datasetName: `${prefix}-fresh`,
    runId,
    cases: [fragment],
  });

  // The guard was once fail-open exactly here: on a connection that never carried the
  // cleanup flag, current_setting(..., true) is NULL, and NULL <> 'on' is NULL — which the
  // trigger's IF read as false, and the delete went through. The pool's own connections
  // could never prove that: earlier tests' cleanup leaves the flag set on them, so the
  // guard held there by residue, not by logic. This delete therefore runs on a brand-new
  // connection outside the shared pool, and it must be refused all the same.
  const fresh = new SQL(testDatabaseUrl(), { max: 1 });
  try {
    const refused = await rejectionOf(
      () =>
        fresh`DELETE FROM ai_observation_dataset_versions WHERE id = ${saved.version.id}`,
    );
    expect(refused.code).toBe("23001"); // restrict_violation
    expect(refused.message).toContain("dataset cleanup");
    const rows =
      await fresh`SELECT id FROM ai_observation_dataset_versions WHERE id = ${saved.version.id}`;
    expect(rows).toHaveLength(1);
  } finally {
    await fresh.close();
  }
});

test("hardening (c): listVersions is deterministic even on a shared clock tick", async () => {
  const runId = `${prefix}-run-order`;
  await boundRun(scopeA, runId);
  const saved = await service.saveReviewed(scopeA, {
    datasetName: `${prefix}-order`,
    runId,
    cases: [fragment],
  });

  // Two versions stamped on the very same tick (a direct insert is the honest way to
  // force what now() would only produce by luck): the id breaks the tie, always.
  // The tick is nudged past the saved row's because PostgreSQL keeps microseconds the
  // JS Date round-trip drops — the pair under test is the tie, not the clock.
  const tick = new Date(saved.version.createdAt.getTime() + 60_000);
  const ties = [`${prefix}-tie-a`, `${prefix}-tie-b`];
  for (const id of ties) {
    await database.insert(aiObservationDatasetVersions).values({
      id,
      scopeKey: scopeA.key,
      datasetId: saved.dataset.id,
      contentHash: `${prefix}-${id}`,
      redactionPolicyVersion: REDACTION_POLICY_VERSION,
      cases: freezeCases([{ ...fragment, input: id }]),
      locatorWorkspace: saved.version.locatorWorkspace,
      locatorProject: saved.version.locatorProject,
      createdAt: tick,
    });
  }

  const listed = await datasetsStore.listVersions(scopeA, saved.dataset.id);
  expect(listed.map((one) => one.id)).toEqual([
    `${prefix}-tie-b`,
    `${prefix}-tie-a`,
    saved.version.id,
  ]);
  // Same question twice, same answer: the order is a fact, not a coin flip.
  const again = await datasetsStore.listVersions(scopeA, saved.dataset.id);
  expect(again.map((one) => one.id)).toEqual(listed.map((one) => one.id));
});
