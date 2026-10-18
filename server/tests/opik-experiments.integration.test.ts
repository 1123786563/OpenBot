import { afterAll, afterEach, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import type { TransactionSQL } from "../../tests/support/bun-compat";
import { SQL } from "../../tests/support/bun-compat";
import { eq } from "drizzle-orm";
import { REDACTION_POLICY_VERSION } from "../../shared/ai-observability";
import { ObservationScopeError } from "../src/ai-observability/contracts";
import { createObservationDatasetStore } from "../src/ai-observability/datasets";
import {
  countExperimentCanaryFindings,
  createExperimentSubmitService,
  createObservationExperimentStore,
  ExperimentStoreError,
  experimentConfigHash,
  freezeExperimentConfig,
} from "../src/ai-observability/experiments";
import { resolveObservationScope } from "../src/ai-observability/scope";
import { createAuditStore } from "../src/audit";
import { aiObservationExperiments } from "../src/db/schema/ai-observability-experiments";
import { aiObservationRetentionDeletions } from "../src/db/schema/ai-observability-retention";
import { testDatabaseUrl } from "./support/database";
import { opikTestDatabase } from "./support/opik-test-db";
import { rejectionOf } from "./support/pg-errors";

/**
 * Behavioral proof of the experiment configuration freeze against a real, dedicated
 * PostgreSQL database (Issue #28 / DAG T22): the frozen field set with its pinned dataset
 * version, immutability enforced by the database itself — on fresh connections too,
 * idempotent submits that cannot mint a second experiment, the guarded draft → frozen state
 * machine, scope isolation for identical names and configurations, the canary that keeps
 * credentials out of the frozen configuration and the audit trail, and the foreign key that
 * makes the dataset-version pin physical. There is no skip and no fallback database; a
 * missing test database fails the run.
 */

const database = opikTestDatabase();
const datasets = createObservationDatasetStore(database);
const store = createObservationExperimentStore(database);
const service = createExperimentSubmitService({
  experiments: store,
  audit: createAuditStore(database),
});
const prefix = `t22-${randomUUID()}`;

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

const caseInput = {
  input: "Summarize the outage report.",
  referenceOutput: "A one-paragraph summary of the outage.",
  toolFixtures: { search: { query: "outage", results: 0 } },
  sourceRunId: "run-1",
  sourceAttemptId: "attempt-1",
  sourceBindingId: "binding-1",
};

const config = {
  botConfig: { toolChoice: "auto" },
  prompt: "Answer the support question from the outage report.",
  modelName: "claude-sonnet-5",
  modelParameters: { temperature: 0, maxTokens: 1024 },
  toolFixtures: { search: { query: "outage", results: 0 } },
  judgeConfig: { type: "llm-judge", threshold: 0.8 },
  judgeVersion: "judge/1",
};

/** One frozen dataset version to pin, minted through the real T19 pipeline. */
async function pinnedVersion(
  scope: typeof scopeA,
  name = `${prefix}-dataset-${randomUUID().slice(0, 8)}`,
) {
  return datasets.saveVersion(scope, { datasetName: name, cases: [caseInput] });
}

const auditRows = (eventType: string, experimentId: string) =>
  database.$client`
    SELECT id, actor_user_id, payload FROM audit_events
    WHERE event_type = ${eventType} AND target_id = ${experimentId}
    ORDER BY created_at DESC
  `;

afterEach(async () => {
  // The guards refuse experiment rows and dataset versions leaving any way but their cleanup
  // paths, and that includes this suite's own cleanup: the transaction-local flags plus the
  // cascade from the subject row is the sanctioned route. Experiments first — their foreign
  // key pins the dataset versions underneath.
  await database.$client.begin(async (tx: TransactionSQL) => {
    await tx`select set_config('ai_observation.experiment_cleanup', 'on', true)`;
    await tx`select set_config('ai_observation.dataset_cleanup', 'on', true)`;
    await tx`DELETE FROM ai_observation_experiments WHERE name LIKE ${`${prefix}%`}`;
    await tx`DELETE FROM ai_observation_datasets WHERE name LIKE ${`${prefix}%`}`;
  });
  // Return the pooled connection to a known session state; residue here once masked the
  // dataset guard's fail-open hole, and the fresh-connection tests below pin the NULL side.
  await database.$client`RESET ai_observation.experiment_cleanup`;
  await database.$client`RESET ai_observation.dataset_cleanup`;
});

afterAll(async () => {
  await database.$client.close();
});

test("the byName replay channel is a reader too: a deletion-in-flight experiment stays gone (OCR R2-37)", async () => {
  const { version } = await pinnedVersion(scopeA);
  const input = {
    name: `${prefix}-r237-${randomUUID()}`,
    datasetVersionId: version.id,
    config,
  };
  const { experiment } = await store.submit(scopeA, input);
  // Retention found it: from the deletion record on, every reader answers
  // not-found for this experiment (OCR m138) — including the replay channels of
  // a submit whose INSERT still conflicts with the surviving (scope, name)
  // unique index entry. Handing the frozen row back as an idempotent answer
  // would resurrect a subject the deletion is mid-way through destroying.
  await database.insert(aiObservationRetentionDeletions).values({
    id: randomUUID(),
    scopeKey: scopeA.key,
    actorId: scopeA.actorId,
    botId: scopeA.botId,
    kind: "experiment",
    targetId: experiment.id,
    retentionDays: 30,
    state: "pending",
  });
  try {
    await expect(store.submit(scopeA, input)).rejects.toThrow();
  } finally {
    // The governance counts read every scope; leave no record behind.
    await database
      .delete(aiObservationRetentionDeletions)
      .where(eq(aiObservationRetentionDeletions.targetId, experiment.id));
  }
});

test("a submit whose only conflict is the deletion window answers the domain 409, never a bare 500 (OCR R3-26)", async () => {
  const { version } = await pinnedVersion(scopeA);
  const input = {
    name: `${prefix}-r326-${randomUUID()}`,
    datasetVersionId: version.id,
    config,
  };
  const { experiment } = await store.submit(scopeA, input);
  // Retention found it: both m138 readers (byName, byHash) now answer empty,
  // yet the surviving (scope, name) and (scope, hash) unique indexes still
  // refuse the insert. The honest answer is the domain conflict the routes
  // translate — not the bare Error this path fell into under R2-37's
  // predicates, which a retry would have ridden straight into a 500.
  await database.insert(aiObservationRetentionDeletions).values({
    id: randomUUID(),
    scopeKey: scopeA.key,
    actorId: scopeA.actorId,
    botId: scopeA.botId,
    kind: "experiment",
    targetId: experiment.id,
    retentionDays: 30,
    state: "pending",
  });
  try {
    const failure = await store.submit(scopeA, input).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ExperimentStoreError);
    expect((failure as ExperimentStoreError).code).toBe(
      "EXPERIMENT_STATE_INVALID",
    );
    expect((failure as ExperimentStoreError).status).toBe(409);
    // A different configuration under the same held name is the same answer:
    // one unfiltered read-back names the holder, whatever channel conflicted.
    const other = await store
      .submit(scopeA, {
        ...input,
        config: { ...config, prompt: "A different prompt entirely." },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(other).toBeInstanceOf(ExperimentStoreError);
    expect((other as ExperimentStoreError).code).toBe(
      "EXPERIMENT_STATE_INVALID",
    );
    expect((other as ExperimentStoreError).status).toBe(409);
  } finally {
    // The governance counts read every scope; leave no record behind.
    await database
      .delete(aiObservationRetentionDeletions)
      .where(eq(aiObservationRetentionDeletions.targetId, experiment.id));
  }
});

test("a draft held by the deletion window refuses saveDraft with the domain 409 (OCR R3-26)", async () => {
  // The m138 visibility rule makes a deletion-in-flight row unreadable; a
  // saveDraft whose name still collides with it must neither serve the row (an
  // UPDATE would rewrite a subject the store treats as gone) nor fall into a
  // bare 500 — one unfiltered read-back names the holder, and the answer is
  // the domain 409.
  const { version } = await pinnedVersion(scopeA);
  const name = `${prefix}-r326d-${randomUUID()}`;
  const input = { name, datasetVersionId: version.id, config };
  await store.saveDraft(scopeA, input);
  const drafted = (
    await database
      .select()
      .from(aiObservationExperiments)
      .where(eq(aiObservationExperiments.name, name))
  )[0];
  await database.insert(aiObservationRetentionDeletions).values({
    id: randomUUID(),
    scopeKey: scopeA.key,
    actorId: scopeA.actorId,
    botId: scopeA.botId,
    kind: "experiment",
    targetId: drafted.id,
    retentionDays: 30,
    state: "pending",
  });
  try {
    const failure = await store.saveDraft(scopeA, input).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ExperimentStoreError);
    expect((failure as ExperimentStoreError).code).toBe(
      "EXPERIMENT_STATE_INVALID",
    );
    expect((failure as ExperimentStoreError).status).toBe(409);
  } finally {
    await database
      .delete(aiObservationRetentionDeletions)
      .where(eq(aiObservationRetentionDeletions.targetId, drafted.id));
  }
});

test("the draft→frozen UPDATE channel answers the deletion window with the domain 409, never a bare 23505 (OCR R4-13)", async () => {
  // R3-26 taught the INSERT channel this answer; the UPDATE channel was left bare.
  // A frozen holder of the configuration key sits in the deletion window: the
  // filtered elsewhere-read cannot see it, but the partial unique index
  // (scope, config_hash) WHERE frozen still holds — so freezing the draft that
  // carries the same canonical configuration trips 23505 inside the UPDATE, which
  // classify() has no answer for and the caller would read as a bare 500.
  const { version } = await pinnedVersion(scopeA);
  const frozenName = `${prefix}-r413-f-${randomUUID()}`;
  const draftName = `${prefix}-r413-d-${randomUUID()}`;
  const { experiment: holder } = await store.submit(scopeA, {
    name: frozenName,
    datasetVersionId: version.id,
    config,
  });
  // The draft under another name, carrying the same canonical configuration.
  await store.saveDraft(scopeA, {
    name: draftName,
    datasetVersionId: version.id,
    config,
  });
  // Retention found the frozen holder: invisible to every m138 reader, still
  // holding the partial unique index.
  await database.insert(aiObservationRetentionDeletions).values({
    id: randomUUID(),
    scopeKey: scopeA.key,
    actorId: scopeA.actorId,
    botId: scopeA.botId,
    kind: "experiment",
    targetId: holder.id,
    retentionDays: 30,
    state: "pending",
  });
  try {
    const failure = await store
      .submit(scopeA, { name: draftName, datasetVersionId: version.id, config })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ExperimentStoreError);
    expect((failure as ExperimentStoreError).code).toBe(
      "EXPERIMENT_STATE_INVALID",
    );
    expect((failure as ExperimentStoreError).status).toBe(409);
  } finally {
    await database
      .delete(aiObservationRetentionDeletions)
      .where(eq(aiObservationRetentionDeletions.targetId, holder.id));
  }
});

test("the byName replay channel answers the same frozen configuration (regression anchor)", async () => {
  const { version } = await pinnedVersion(scopeA);
  const input = {
    name: `${prefix}-r237b-${randomUUID()}`,
    datasetVersionId: version.id,
    config,
  };
  const first = await store.submit(scopeA, input);
  // No deletion record: the byName channel still replays idempotently — the
  // predicate added above must narrow the deletion-in-flight case only.
  const replay = await store.submit(scopeA, input);
  expect(replay.replayed).toBe(true);
  expect(replay.experiment.id).toBe(first.experiment.id);
});

test("the dedicated test database carries the experiment schema and both guards", async () => {
  const indexes = await database.$client`
    SELECT indexname FROM pg_indexes WHERE tablename = 'ai_observation_experiments'
  `;
  const present = new Set(indexes.map((row) => row.indexname));
  for (const required of [
    "ai_observation_experiments_scope_name_uq",
    "ai_observation_experiments_scope_config_hash_frozen_uq",
  ]) {
    if (!present.has(required)) {
      throw new Error(
        `The dedicated Opik test database lacks ${required}. Apply the migrations to the dedicated test database first (TEST_DATABASE_URL=... bun run db:migrate in server/); do not point these tests at the application database and do not record this as a pass.`,
      );
    }
  }
  const triggers = await database.$client`
    SELECT tgname FROM pg_trigger
    WHERE tgname IN ('ai_observation_experiments_immutable', 'ai_observation_experiments_cleanup_only')
      AND NOT tgisinternal
  `;
  expect(triggers).toHaveLength(2);
});

test("a submitted experiment freezes the whole acceptance field set (Issue #28 AC1)", async () => {
  const { version } = await pinnedVersion(scopeA);
  const submitted = await service.submit(scopeA, {
    name: `${prefix}-freeze`,
    datasetVersionId: version.id,
    config,
  });

  const frozen = submitted.experiment;
  expect(frozen).toMatchObject({
    scopeKey: scopeA.key,
    actorId: "user-a",
    botId: "agent-1",
    state: "frozen",
    datasetVersionId: version.id,
    datasetContentHash: version.contentHash,
  });
  expect(frozen.frozenAt).toBeInstanceOf(Date);
  expect(frozen.configHash).toBe(
    experimentConfigHash(
      version.id,
      freezeExperimentConfig(config),
      REDACTION_POLICY_VERSION,
    ),
  );
  // The configuration is stored in its projected form, and the pinned version's content is
  // what the T19 freeze produced for these cases.
  expect(frozen.config.prompt).toEqual({
    state: "projected",
    text: config.prompt,
  });
  expect(frozen.datasetContentHash).toBe(version.contentHash);

  // The read side of the freeze: the same frozen row answers by id.
  expect(await store.getExperiment(scopeA, frozen.id)).toEqual(frozen);
});

test("a submitted experiment leaves exactly one audit row with references and counts", async () => {
  const { version } = await pinnedVersion(scopeA);
  const submitted = await service.submit(scopeA, {
    name: `${prefix}-audit`,
    datasetVersionId: version.id,
    config,
  });

  const rows = await auditRows(
    "opik.experiment_submitted",
    submitted.experiment.id,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.actor_user_id).toBe(scopeA.actorId);
  expect(rows[0]?.payload).toEqual({
    experimentId: submitted.experiment.id,
    name: submitted.experiment.name,
    datasetVersionId: version.id,
    datasetContentHash: version.contentHash,
    configHash: submitted.experiment.configHash,
    canaryFindings: 0,
    replayed: false,
  });
  // References and counts, never configuration content.
  expect(JSON.stringify(rows[0]?.payload)).not.toContain(config.prompt);

  // The replay writes its own row, marked as the replay it was.
  const replay = await service.submit(scopeA, {
    name: `${prefix}-audit`,
    datasetVersionId: version.id,
    config,
  });
  expect(replay.replayed).toBe(true);
  const afterReplay = await auditRows(
    "opik.experiment_submitted",
    submitted.experiment.id,
  );
  expect(afterReplay).toHaveLength(2);
  // Newest first: the replay's row is the one carrying the flag.
  expect(afterReplay[0]?.payload).toMatchObject({ replayed: true });
});

test("a retried submit hits the same experiment, whatever name it arrives under (AC2)", async () => {
  const { version } = await pinnedVersion(scopeA);
  const first = await store.submit(scopeA, {
    name: `${prefix}-idempotent`,
    datasetVersionId: version.id,
    config,
  });
  const replay = await store.submit(scopeA, {
    name: `${prefix}-idempotent`,
    datasetVersionId: version.id,
    config,
  });
  expect(first.replayed).toBe(false);
  expect(replay.replayed).toBe(true);
  expect(replay.experiment.id).toBe(first.experiment.id);

  // The canonical hash, not the name, is the key: the same configuration under a second
  // name is still the same experiment — a retry does not mint a second one.
  const renamed = await store.submit(scopeA, {
    name: `${prefix}-idempotent-copy`,
    datasetVersionId: version.id,
    config,
  });
  expect(renamed.replayed).toBe(true);
  expect(renamed.experiment.id).toBe(first.experiment.id);

  // The second name never became a row of its own: one row for the whole replay sequence.
  const rows = await database
    .select({ name: aiObservationExperiments.name })
    .from(aiObservationExperiments)
    .where(eq(aiObservationExperiments.scopeKey, scopeA.key));
  expect(
    rows.filter((row) => row.name.startsWith(`${prefix}-idempotent`)),
  ).toEqual([{ name: `${prefix}-idempotent` }]);

  // Different configuration content is a different experiment.
  const other = await store.submit(scopeA, {
    name: `${prefix}-idempotent-other`,
    datasetVersionId: version.id,
    config: { ...config, judgeConfig: { type: "llm-judge", threshold: 0.9 } },
  });
  expect(other.replayed).toBe(false);
  expect(other.experiment.id).not.toBe(first.experiment.id);
});

test("a frozen experiment cannot change or leave, at the database, whoever asks (AC: 不可变)", async () => {
  const { version } = await pinnedVersion(scopeA);
  const submitted = await store.submit(scopeA, {
    name: `${prefix}-immutable`,
    datasetVersionId: version.id,
    config,
  });

  const refusedUpdate = await rejectionOf(() =>
    database
      .update(aiObservationExperiments)
      .set({ configHash: `${submitted.experiment.configHash}-tampered` })
      .where(eq(aiObservationExperiments.id, submitted.experiment.id)),
  );
  expect(refusedUpdate.code).toBe("23001"); // restrict_violation

  // The state machine's one illegal direction, attempted directly: frozen -> draft.
  const refusedRegression = await rejectionOf(() =>
    database
      .update(aiObservationExperiments)
      .set({ state: "draft", frozenAt: null, configHash: "" })
      .where(eq(aiObservationExperiments.id, submitted.experiment.id)),
  );
  expect(refusedRegression.code).toBe("23001");

  const refusedDelete = await rejectionOf(() =>
    database
      .delete(aiObservationExperiments)
      .where(eq(aiObservationExperiments.id, submitted.experiment.id)),
  );
  expect(refusedDelete.code).toBe("23001");
  expect(refusedDelete.message).toContain("experiment cleanup");
  expect(await store.getExperiment(scopeA, submitted.experiment.id)).toEqual(
    submitted.experiment,
  );

  // And on a connection with no session state at all — the 0124 lesson: a guard that held
  // only on connections carrying residue is a guard that does not hold.
  const fresh = new SQL(testDatabaseUrl(), { max: 1 });
  try {
    const freshUpdate = await rejectionOf(
      () =>
        fresh`UPDATE ai_observation_experiments SET config_hash = 'tampered' WHERE id = ${submitted.experiment.id}`,
    );
    expect(freshUpdate.code).toBe("23001");
    const freshDelete = await rejectionOf(
      () =>
        fresh`DELETE FROM ai_observation_experiments WHERE id = ${submitted.experiment.id}`,
    );
    expect(freshDelete.code).toBe("23001");
    const rows =
      await fresh`SELECT config_hash, state FROM ai_observation_experiments WHERE id = ${submitted.experiment.id}`;
    expect(rows[0]).toEqual({
      config_hash: submitted.experiment.configHash,
      state: "frozen",
    });
  } finally {
    await fresh.close();
  }
});

test("the state vocabulary is fail-closed at the database: no word but draft and frozen", async () => {
  const { version } = await pinnedVersion(scopeA);

  const refusedWord = await rejectionOf(() =>
    database.insert(aiObservationExperiments).values({
      id: randomUUID(),
      scopeKey: scopeA.key,
      actorId: scopeA.actorId,
      botId: scopeA.botId,
      name: `${prefix}-running`,
      datasetVersionId: version.id,
      datasetContentHash: version.contentHash,
      config: freezeExperimentConfig(config),
      state: "running" as never,
    }),
  );
  expect(refusedWord.code).toBe("23514"); // check_violation

  // A frozen row without its hash and freeze time is a state machine lie; a draft carrying
  // them is the same lie in the other direction.
  const refusedIncoherent = await rejectionOf(() =>
    database.insert(aiObservationExperiments).values({
      id: randomUUID(),
      scopeKey: scopeA.key,
      actorId: scopeA.actorId,
      botId: scopeA.botId,
      name: `${prefix}-half-frozen`,
      datasetVersionId: version.id,
      datasetContentHash: version.contentHash,
      config: freezeExperimentConfig(config),
      state: "frozen",
      configHash: "",
    }),
  );
  expect(refusedIncoherent.code).toBe("23514");

  // The same lie in the other direction: a draft row carrying a config hash already claims
  // the identity only a freeze may mint (L-2).
  const refusedPrematureHash = await rejectionOf(() =>
    database.insert(aiObservationExperiments).values({
      id: randomUUID(),
      scopeKey: scopeA.key,
      actorId: scopeA.actorId,
      botId: scopeA.botId,
      name: `${prefix}-premature-hash`,
      datasetVersionId: version.id,
      datasetContentHash: version.contentHash,
      config: freezeExperimentConfig(config),
      state: "draft",
      configHash: "premature",
    }),
  );
  expect(refusedPrematureHash.code).toBe("23514");

  // And the guard holds on UPDATE too: a live draft cannot quietly mint its identity.
  const draft = await store.saveDraft(scopeA, {
    name: `${prefix}-draft-hash`,
    datasetVersionId: version.id,
    config,
  });
  const refusedDraftUpdate = await rejectionOf(() =>
    database
      .update(aiObservationExperiments)
      .set({ configHash: "premature" })
      .where(eq(aiObservationExperiments.id, draft.id)),
  );
  expect(refusedDraftUpdate.code).toBe("23514");
});

test("a draft is mutable, then freezes once — and the frozen name refuses different content", async () => {
  const { version } = await pinnedVersion(scopeA);
  const name = `${prefix}-draft`;

  const draft = await store.saveDraft(scopeA, {
    name,
    datasetVersionId: version.id,
    config,
  });
  expect(draft.state).toBe("draft");
  expect(draft.frozenAt).toBeNull();
  expect(draft.configHash).toBe("");

  // Drafts are editable: a different judge threshold replaces the configuration.
  const edited = await store.saveDraft(scopeA, {
    name,
    datasetVersionId: version.id,
    config: { ...config, judgeConfig: { type: "llm-judge", threshold: 0.9 } },
  });
  expect(edited.id).toBe(draft.id);
  expect(edited.config.judgeConfig).toEqual(
    freezeExperimentConfig({
      ...config,
      judgeConfig: { type: "llm-judge", threshold: 0.9 },
    }).judgeConfig,
  );

  // The submit freezes the draft that exists; submitting again is the replay.
  const submitted = await store.submit(scopeA, {
    name,
    datasetVersionId: version.id,
    config: { ...config, judgeConfig: { type: "llm-judge", threshold: 0.9 } },
  });
  expect(submitted.replayed).toBe(false);
  expect(submitted.experiment.id).toBe(draft.id);
  expect(submitted.experiment.state).toBe("frozen");
  expect(submitted.experiment.frozenAt).toBeInstanceOf(Date);

  const replay = await store.submit(scopeA, {
    name,
    datasetVersionId: version.id,
    config: { ...config, judgeConfig: { type: "llm-judge", threshold: 0.9 } },
  });
  expect(replay.replayed).toBe(true);

  // A frozen name will not carry different content, and a draft cannot be saved over it.
  await expect(
    store.submit(scopeA, {
      name,
      datasetVersionId: version.id,
      config,
    }),
  ).rejects.toThrow(new ExperimentStoreError("EXPERIMENT_STATE_INVALID", 409));
  await expect(
    store.saveDraft(scopeA, { name, datasetVersionId: version.id, config }),
  ).rejects.toThrow(new ExperimentStoreError("EXPERIMENT_STATE_INVALID", 409));

  // A draft holding configuration X, submitted after X froze elsewhere, hits that frozen
  // experiment and leaves the draft a draft: one canonical configuration, one experiment.
  const other = await pinnedVersion(scopeA);
  const frozenElsewhere = await store.submit(scopeA, {
    name: `${prefix}-draft-elsewhere`,
    datasetVersionId: other.version.id,
    config,
  });
  expect(frozenElsewhere.replayed).toBe(false);
  const strayDraft = await store.saveDraft(scopeA, {
    name: `${prefix}-draft-stray`,
    datasetVersionId: other.version.id,
    config,
  });
  expect(strayDraft.state).toBe("draft");
  const hit = await store.submit(scopeA, {
    name: `${prefix}-draft-stray`,
    datasetVersionId: other.version.id,
    config,
  });
  expect(hit.replayed).toBe(true);
  expect(hit.experiment.id).toBe(frozenElsewhere.experiment.id);
  expect((await store.getExperiment(scopeA, strayDraft.id))?.state).toBe(
    "draft",
  );
});

test("the same name and configuration under two scopes stay two experiments (AC3)", async () => {
  const a = await pinnedVersion(scopeA);
  const b = await pinnedVersion(scopeB);
  expect(a.version.contentHash).toBe(b.version.contentHash);

  const one = await store.submit(scopeA, {
    name: `${prefix}-isolated`,
    datasetVersionId: a.version.id,
    config,
  });
  const two = await store.submit(scopeB, {
    name: `${prefix}-isolated`,
    datasetVersionId: b.version.id,
    config,
  });

  // Identical submitted content, and still two experiments: the scope participates in the
  // key, and so does the pinned version — a scope-B version is a different row even when its
  // content hash matches, which is exactly why the configuration hashes differ too.
  expect(a.version.contentHash).toBe(b.version.contentHash);
  expect(one.experiment.configHash).not.toBe(two.experiment.configHash);
  expect(one.experiment.id).not.toBe(two.experiment.id);
  expect(await store.getExperiment(scopeA, two.experiment.id)).toBeNull();
  expect(await store.getExperiment(scopeB, one.experiment.id)).toBeNull();

  const rows = await database
    .select({ scopeKey: aiObservationExperiments.scopeKey })
    .from(aiObservationExperiments)
    .where(eq(aiObservationExperiments.name, `${prefix}-isolated`));
  expect(rows.map((row) => row.scopeKey).sort()).toEqual(
    [scopeA.key, scopeB.key].sort(),
  );
});

test("a guessed or foreign dataset version id is simply not found, before any trail (AC3/AC4)", async () => {
  await expect(
    store.submit(scopeA, {
      name: `${prefix}-guessed`,
      datasetVersionId: `${prefix}-no-such-version`,
      config,
    }),
  ).rejects.toThrow(
    new ExperimentStoreError("EXPERIMENT_DATASET_VERSION_NOT_FOUND", 404),
  );

  // A real version under another scope: the same refusal, because the scope participates in
  // the read — a foreign id teaches the caller nothing.
  const foreign = await pinnedVersion(scopeB);
  await expect(
    store.submit(scopeA, {
      name: `${prefix}-foreign`,
      datasetVersionId: foreign.version.id,
      config,
    }),
  ).rejects.toThrow(
    new ExperimentStoreError("EXPERIMENT_DATASET_VERSION_NOT_FOUND", 404),
  );

  // Nothing was minted and nothing was recorded: no experiment rows, no audit rows.
  const rows = await database
    .select({ id: aiObservationExperiments.id })
    .from(aiObservationExperiments)
    .where(eq(aiObservationExperiments.scopeKey, scopeA.key));
  expect(rows).toHaveLength(0);
  const audited = await database.$client`
    SELECT id FROM audit_events
    WHERE event_type = 'opik.experiment_submitted'
      AND (payload->>'name' LIKE ${`${prefix}-guessed`} OR payload->>'name' LIKE ${`${prefix}-foreign`})
  `;
  expect(audited).toHaveLength(0);

  // A forged scope is refused the same way, before any query.
  const forged = { ...scopeA };
  await expect(
    store.submit(forged, {
      name: `${prefix}-forged`,
      datasetVersionId: "version-1",
      config,
    }),
  ).rejects.toThrow(new ObservationScopeError("OWNERSHIP_REQUIRED", 403));
});

test("the canary: a denied configuration is refused, never echoed — row, count and trail agree", async () => {
  const { version } = await pinnedVersion(scopeA);
  const hostile = {
    ...config,
    prompt: "sk-live-abc123def456ghi789jkl012 is not a prompt",
    judgeConfig: { threshold: 0.8, apiKey: "Bearer abcdefghijklmnop" },
  };

  const submitted = await service.submit(scopeA, {
    name: `${prefix}-canary`,
    datasetVersionId: version.id,
    config: hostile,
  });

  expect(submitted.canaryFindings).toBe(
    countExperimentCanaryFindings(freezeExperimentConfig(hostile)),
  );
  expect(submitted.canaryFindings).toBe(2);

  // The frozen row holds the omissions, and the credential literal appears nowhere in it.
  const stored = await store.getExperiment(scopeA, submitted.experiment.id);
  if (!stored) throw new Error("the frozen experiment vanished");
  expect(stored.config.prompt).toEqual({
    state: "omitted",
    reason: "credential",
  });
  expect(
    (
      (stored.config.judgeConfig as { value: Record<string, unknown> }).value
        .apiKey as { state: string }
    ).state,
  ).toBe("omitted");
  expect(JSON.stringify(stored.config)).not.toContain("sk-live-abc123");

  // The trail carries the count that says it happened, never the content.
  const rows = await auditRows(
    "opik.experiment_submitted",
    submitted.experiment.id,
  );
  expect(rows[0]?.payload).toMatchObject({ canaryFindings: 2 });
  expect(JSON.stringify(rows[0]?.payload)).not.toContain("sk-live-abc123");
});

test("the dataset-version pin is physical: pinned content cannot be cleaned from underneath (AC4)", async () => {
  const { dataset, version } = await pinnedVersion(scopeA);
  const submitted = await store.submit(scopeA, {
    name: `${prefix}-pinned`,
    datasetVersionId: version.id,
    config,
  });

  // Dataset cleanup cascades to the version row, and the foreign key stops it: an experiment
  // that pinned a version must not find its content vanished under it — not even through
  // the sanctioned cleanup path.
  const refused = await rejectionOf(() =>
    datasets.deleteDataset(scopeA, dataset.id),
  );
  expect(refused.code).toBe("23503"); // foreign_key_violation

  expect(await datasets.getDataset(scopeA, dataset.id)).not.toBeNull();
  expect(await datasets.getVersion(scopeA, version.id)).not.toBeNull();
  expect(await store.getExperiment(scopeA, submitted.experiment.id)).toEqual(
    submitted.experiment,
  );
});
