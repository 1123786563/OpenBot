import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { REDACTION_POLICY_VERSION } from "../../shared/ai-observability";
import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { createRunBindingStore } from "../src/ai-observability/bindings";
import { createObservationDatasetStore } from "../src/ai-observability/datasets";
import {
  type ObservationScope,
  resolveObservationScope,
  resolveStorageLocator,
} from "../src/ai-observability/scope";
import { createDatabase, type Database } from "../src/db/client";
import { aiObservationBindings } from "../src/db/schema/ai-observability-bindings";
import { aiObservationDatasets } from "../src/db/schema/ai-observability-datasets";
import { aiObservationExperimentExecutions } from "../src/db/schema/ai-observability-executions";
import { aiObservationExperiments } from "../src/db/schema/ai-observability-experiments";
import { aiObservationExportJobs } from "../src/db/schema/ai-observability-exports";
import { aiObservationIdLinks } from "../src/db/schema/ai-observability-id-links";
import {
  aiObservationRetentionDeletions,
  aiObservationRetentionOverrides,
} from "../src/db/schema/ai-observability-retention";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 0219_opik_stable_resource_scope replay semantics (OCR R5 fix wave, ocrfix-b).
 *
 * The migration chain itself runs on every fresh database, so what no fresh
 * database exercises is 0219's CONVERGENCE semantics: a fresh database has no
 * legacy-key rows to converge. This suite re-applies the migration file (written
 * to be replayable — every statement re-derives its target state) against
 * deliberately legacy-shaped rows on a disposable database, and pins:
 *
 * 1. statement-breakpoint integrity — the file splits into single statements,
 *    the contract the drizzle migrator and drizzle-kit both rely on;
 * 2. the 9-table convergence, including the executions table the first cut forgot
 *    (legacy-key executions kept the experiment's foreign key raising 23503);
 * 3. the nested ranking — a subject winner whose trace was claimed by a NON-winner
 *    row still moves (the full-table secondary window stranded whole subjects);
 * 4. the stable-key preference — an already-stable row is never rewritten by an
 *    earlier legacy row (the unique-index collision that rolled migrations back);
 * 5. replay safety — applying the file a second time changes nothing.
 *
 * Disposable database: one uuid-suffixed child of the shared test container per
 * run, migrated with the repository's own scripts/migrate.ts, dropped in
 * afterAll. TEST_DATABASE_URL names any database on that container.
 */

const migrationPath = join(
  import.meta.dir,
  "../drizzle/0219_opik_stable_resource_scope.sql",
);
const migrationFile = await Bun.file(migrationPath).text();

/** The length-prefixed composite `joinKey(["wb", actor, bot, epoch])` produced pre-FREV-03. */
const legacyKey = (actorId: string, botId: string) =>
  `2:wb|${actorId.length}:${actorId}|${botId.length}:${botId}|1:1`;

const scopeFor = (actorId: string, botId: string): ObservationScope =>
  resolveObservationScope({ actorId, botId, ownership: "owner", epoch: 1 });

const oneCase = (runId: string) => ({
  input: "case input",
  referenceOutput: "reference",
  toolFixtures: {},
  sourceRunId: runId,
  sourceAttemptId: `attempt-${randomUUID()}`,
});

/**
 * Statement-per-chunk scanner: semicolons outside single quotes, line comments
 * and $$ bodies. A chunk carrying more than one is a statement the migrator
 * would execute as part of its neighbor — the regression the markers prevent.
 */
const topLevelSemicolons = (chunk: string): number => {
  let count = 0;
  let inSingleQuote = false;
  let inDollar = false;
  let inLineComment = false;
  for (let i = 0; i < chunk.length; i += 1) {
    const char = chunk[i];
    const next = chunk[i + 1];
    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }
    if (inSingleQuote) {
      if (char === "'") inSingleQuote = false;
      continue;
    }
    if (inDollar) {
      if (char === "$" && next === "$") {
        inDollar = false;
        i += 1;
      }
      continue;
    }
    if (char === "'") {
      inSingleQuote = true;
      continue;
    }
    if (char === "$" && next === "$") {
      inDollar = true;
      i += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      inLineComment = true;
      continue;
    }
    if (char === ";") count += 1;
  }
  return count;
};

const chunks = migrationFile
  .split("--> statement-breakpoint")
  .map((chunk) => chunk.trim())
  .filter((chunk) => chunk.length > 0);

const migrationDbName = `opik4_ocrfix_b_m_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const adminBase = new URL(testDatabaseUrl());
adminBase.pathname = "/postgres";
const adminUrl = adminBase.toString();
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
const migrationUrl = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${migrationDbName}`;
  return url.toString();
})();
const db: Database = createDatabase(migrationUrl, TEST_POOL);
const bindingStore = createRunBindingStore(db);
const datasetStore = createObservationDatasetStore(db);
const migSql = postgres(migrationUrl, { max: 1, onnotice: () => {} });

const replay = async () => {
  await migSql.begin(async (tx) => {
    for (const chunk of chunks) await tx.unsafe(chunk);
  });
};

const backdate = (days: number) => new Date(Date.now() - days * 86_400_000);

// --- fixtures and scenarios ---

afterAll(async () => {
  await db.$client.close();
  await migSql.end({ timeout: 5 });
  await admin.unsafe(
    `DROP DATABASE IF EXISTS "${migrationDbName}" WITH (FORCE)`,
  );
  await admin.end({ timeout: 5 });
});

describe("0219 stable resource scope (OCR R5)", () => {
  test("the file splits into single statements at every marker (drizzle migrator contract)", () => {
    expect(chunks.length).toBe(15);
    for (const [, chunk] of chunks.entries()) {
      expect(topLevelSemicolons(chunk)).toBe(1);
    }
  });

  // --- the seeded convergence scenario ---

  let seeded = false;

  /**
   * Seed the pre-migration world on the disposable database: production-shaped
   * rows through the stores, then rewritten into the legacy composite key spaces
   * the migration must converge. Created once; the replay in each test re-applies
   * 0219 over the same seed (its own replay-safety evidence).
   */
  const ensureScenario = async () => {
    if (seeded) return;
    seeded = true;
    await admin.unsafe(`CREATE DATABASE "${migrationDbName}"`);
    const serverRoot = join(import.meta.dir, "..");
    const migrated = Bun.spawn(["bun", "--no-env-file", "scripts/migrate.ts"], {
      cwd: serverRoot,
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
        DATABASE_URL: migrationUrl,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = new Response(migrated.stderr).text();
    const exit = await migrated.exited;
    if (exit !== 0) {
      throw new Error(
        `0219 fixture migration failed (exit ${exit}): ${(await stderr).slice(-2000)}`,
      );
    }

    // S1 bindings — the HIGH nested-rank scenario on one Bot, two legacy actors:
    // w2 is subject S2's winner (oldest row); ghost shares S2's (run, attempt)
    // across the OTHER legacy key with a trace of its own; w1 is subject S1's
    // winner whose trace equals the GHOST's (not any winner's). The old
    // full-table secondary window let the ghost claim the trace and strand the
    // whole S1 subject; nested ranking moves w1.
    const botX = `mig-bot-x-${randomUUID()}`;
    const scopeX = scopeFor("mig-actor-x", botX);
    const legacyX1 = legacyKey("actor-1", botX);
    const legacyX2 = legacyKey("actor-2", botX);
    const legacyX3 = legacyKey("actor-3", botX);
    const begin = (runId: string, attemptId: string, traceId: string) =>
      bindingStore.begin(scopeX, {
        runId,
        attemptId,
        traceId,
        capability: "basic",
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    const { binding: w2 } = await begin(
      "mig-run-2",
      "mig-att-2",
      "mig-trace-2",
    );
    const { binding: ghost } = await begin(
      "mig-run-g",
      "mig-att-g",
      "mig-trace-9",
    );
    const { binding: w1 } = await begin(
      "mig-run-1",
      "mig-att-1",
      "mig-trace-9",
    );
    for (const binding of [w2, ghost, w1]) {
      await bindingStore.finish(
        scopeX,
        binding.runId,
        binding.attemptId,
        "completed",
      );
    }
    // The legacy rewrite first — ghost's subject alignment below would collide
    // with w2 on (scope_key, run_id, attempt_id) while both still sit at the
    // stable key. Three composites across two actors, legacy locator strings;
    // ghost and w1 share trace T9, so they sit on different keys — the
    // (scope_key, opik_trace_id) index forbids them on one. begin/finish never
    // write opik_trace_id (bindings.ts), so the rewrite carries it too:
    // without it the migration's nested trace window short-circuits on NULL
    // and the secondary ranking this scenario exists to pin never executes
    // (OCR 终审 #52).
    await db.execute(sql`update ai_observation_bindings set
      scope_key = case id when ${w2.id} then ${legacyX2} when ${ghost.id} then ${legacyX1} else ${legacyX3} end,
      actor_id = case id when ${w2.id} then 'actor-2' else 'actor-1' end,
      opik_trace_id = case id when ${w2.id} then 'mig-trace-2' else 'mig-trace-9' end,
      locator_workspace = 'legacy-ws', locator_project = 'legacy-proj'
      where id in (${w2.id}, ${ghost.id}, ${w1.id})`);
    await db
      .update(aiObservationBindings)
      .set({ createdAt: backdate(30) })
      .where(eq(aiObservationBindings.id, w2.id));
    await db
      .update(aiObservationBindings)
      // ghost joins S2's subject (same run/attempt across the other legacy key)
      .set({
        createdAt: backdate(20),
        runId: "mig-run-2",
        attemptId: "mig-att-2",
      })
      .where(eq(aiObservationBindings.id, ghost.id));
    await db
      .update(aiObservationBindings)
      .set({ createdAt: backdate(10) })
      .where(eq(aiObservationBindings.id, w1.id));

    // S2 datasets — the rollback shape: an already-stable row and an EARLIER
    // legacy twin sharing (bot, name). Without the stable-key preference the
    // twin wins the rank and collides on the unique index.
    const botY = `mig-bot-y-${randomUUID()}`;
    const scopeY = scopeFor("mig-actor-y", botY);
    const { dataset: dStable } = await datasetStore.saveVersion(scopeY, {
      datasetName: `mig-ds-y-${randomUUID()}`,
      cases: [oneCase("mig-run-y")],
    });
    dStableId = dStable.id;
    await db.insert(aiObservationDatasets).values({
      id: randomUUID(),
      scopeKey: legacyKey("actor-y", botY),
      actorId: "actor-y",
      botId: botY,
      name: dStable.name,
      locatorWorkspace: "legacy-ws",
      locatorProject: "legacy-proj",
      syncState: "pending",
      createdAt: backdate(40),
      updatedAt: backdate(40),
    });

    // S3–S7 on one more Bot: an experiment whose settled execution sits at a
    // legacy key (the CRITICAL the first cut missed), an id link, an export
    // job, a deletion record with FROZEN locators, and a composite-key
    // override. All converge; the execution becomes deletable at the stable
    // key, which is what used to 23503-pin its experiment.
    const botZ = `mig-bot-z-${randomUUID()}`;
    const scopeZ = scopeFor("mig-actor-z", botZ);
    const legacyZ = legacyKey("actor-z", botZ);
    const { version: vZ } = await datasetStore.saveVersion(scopeZ, {
      datasetName: `mig-ds-z-${randomUUID()}`,
      cases: [oneCase("mig-run-z")],
    });
    const experimentId = randomUUID();
    experimentIdShared = experimentId;
    await db.insert(aiObservationExperiments).values({
      id: experimentId,
      scopeKey: scopeZ.key,
      actorId: scopeZ.actorId,
      botId: botZ,
      name: `mig-exp-z-${randomUUID()}`,
      datasetVersionId: vZ.id,
      datasetContentHash: vZ.contentHash,
      config: {},
      state: "draft",
      createdAt: backdate(40),
    });
    executionId = randomUUID();
    await db.insert(aiObservationExperimentExecutions).values({
      id: executionId,
      scopeKey: legacyZ,
      actorId: "actor-z",
      botId: botZ,
      experimentId,
      experimentConfigHash: "mig-hash-z",
      state: "completed",
      caseCount: 1,
      result: { summary: "1 case, 1 passed" },
      startedAt: backdate(39),
      settledAt: backdate(39),
    });
    idLinkId = randomUUID();
    await db.insert(aiObservationIdLinks).values({
      id: idLinkId,
      scopeKey: legacyZ,
      actorId: "actor-z",
      botId: botZ,
      localKind: "tool_step",
      localId: `mig-step-${randomUUID()}`,
      upstreamKind: "span",
      upstreamId: `mig-span-${randomUUID()}`,
      observedTraceId: "mig-trace-z",
    });
    exportJobId = randomUUID();
    await db.insert(aiObservationExportJobs).values({
      id: exportJobId,
      scopeKey: legacyZ,
      actorId: "actor-z",
      botId: botZ,
      state: "failed",
      rowLimit: 10,
      redactionPolicyVersion: REDACTION_POLICY_VERSION,
      locatorWorkspace: "legacy-ws",
      locatorProject: "legacy-proj",
      settledAt: backdate(8),
      createdAt: backdate(9),
      updatedAt: backdate(8),
    });
    deletionRecordId = randomUUID();
    await db.insert(aiObservationRetentionDeletions).values({
      id: deletionRecordId,
      scopeKey: legacyZ,
      actorId: "actor-z",
      botId: botZ,
      kind: "dataset",
      targetId: randomUUID(),
      retentionDays: 7,
      state: "failed",
      lastError: "OPIK_TIMEOUT",
      locatorWorkspace: "frozen-ws",
      locatorProject: "frozen-proj",
      upstreamKind: "dataset",
      upstreamId: "mig-upstream-ds",
    });
    await db.insert(aiObservationRetentionOverrides).values({
      scopeKey: legacyZ,
      runsDays: 9,
    });
    scenario = {
      botX,
      scopeX,
      legacyX1,
      legacyX2,
      legacyX3,
      w1,
      w2Id: w2.id,
      ghost,
      scopeY,
      scopeZ,
    };
  };

  type Scenario = {
    botX: string;
    scopeX: ObservationScope;
    legacyX1: string;
    legacyX2: string;
    legacyX3: string;
    w1: { id: string };
    w2Id: string;
    ghost: { id: string };
    scopeY: ObservationScope;
    scopeZ: ObservationScope;
  };
  let scenario: Scenario;
  let dStableId: string;
  let experimentIdShared: string;
  let executionId: string;
  let idLinkId: string;
  let exportJobId: string;
  let deletionRecordId: string;

  test("the replay converges all nine tables, rescues ghost-blocked subjects, and never rewrites stable rows", async () => {
    await ensureScenario();
    await replay();

    // bindings: both subject winners moved; the ghost lost the subject race
    // and keeps its legacy composite. The traces are pinned with the keys
    // (OCR 终审 #52): the nested secondary window ranks trace T9 across the
    // SUBJECT WINNERS only — the ghost never enters it, so w1 claims T9 at
    // the stable key — while the full-table window it replaced ranked the
    // ghost (older) first and stranded w1's subject at its legacy key. The
    // trace pins are the seed's own anchor: with opik_trace_id left NULL in
    // the rewrite, these fail.
    const rows = await migSql`
        select id, scope_key, opik_trace_id from ai_observation_bindings
        where id in (${scenario.w1.id}, ${scenario.ghost.id}, ${scenario.w2Id})`;
    expect(rows.find((r) => r.id === scenario.w1.id)).toMatchObject({
      scope_key: scenario.scopeX.key,
      opik_trace_id: "mig-trace-9",
    });
    expect(rows.find((r) => r.id === scenario.ghost.id)).toMatchObject({
      scope_key: scenario.legacyX1,
      opik_trace_id: "mig-trace-9",
    });
    expect(rows.find((r) => r.id === scenario.w2Id)).toMatchObject({
      scope_key: scenario.scopeX.key,
      opik_trace_id: "mig-trace-2",
    });
    const locators = await migSql`
        select locator_workspace, locator_project from ai_observation_bindings where id = ${scenario.w1.id}`;
    expect(locators[0].locator_workspace).toBe(
      resolveStorageLocator(scenario.scopeX).workspace,
    );
    expect(locators[0].locator_project).toBe(
      resolveStorageLocator(scenario.scopeX).project,
    );

    // datasets: the earlier legacy twin stayed put beside the already-stable
    // row — the collision that used to roll the whole migration back.
    const datasets = await migSql`
        select d.scope_key, d.name from ai_observation_datasets d
        where d.bot_id = ${scenario.scopeY.botId} and d.name = (
          select name from ai_observation_datasets where id = ${dStableId}
        )`;
    expect(datasets.map((d) => d.scope_key).sort()).toEqual(
      [scenario.scopeY.key, legacyKey("actor-y", scenario.scopeY.botId)].sort(),
    );

    // executions: the forgotten table converges, and the experiment delete
    // branch's subdelete now reaches it at the stable key (no more 23503 pin).
    expect(
      await migSql`
          select scope_key from ai_observation_experiment_executions where id = ${executionId}`,
    ).toEqual([{ scope_key: scenario.scopeZ.key }]);
    const reachable = await migSql`
        delete from ai_observation_experiment_executions
        where experiment_id = ${experimentIdShared}
          and scope_key = ${scenario.scopeZ.key}
          and state in ('completed', 'failed', 'cancelled')
        returning id`;
    expect(reachable).toHaveLength(1);

    // id links, export jobs: converge; the export's locators re-derive.
    expect(
      await migSql`
          select scope_key from ai_observation_id_links where id = ${idLinkId}`,
    ).toEqual([{ scope_key: scenario.scopeZ.key }]);
    const exportRow = await migSql`
        select scope_key, locator_workspace from ai_observation_export_jobs where id = ${exportJobId}`;
    expect(exportRow[0].scope_key).toBe(scenario.scopeZ.key);
    expect(exportRow[0].locator_workspace).toBe(
      resolveStorageLocator(scenario.scopeZ).workspace,
    );

    // deletion records: the key converges (governance range), the locators
    // stay frozen — they are the address the record exists to delete.
    const record = await migSql`
        select scope_key, locator_workspace from ai_observation_retention_deletions where id = ${deletionRecordId}`;
    expect(record[0].scope_key).toBe(scenario.scopeZ.key);
    expect(record[0].locator_workspace).toBe("frozen-ws");

    // overrides: the composite parses to the stable key.
    expect(
      await migSql`
          select scope_key, runs_days from ai_observation_retention_overrides
          where scope_key = ${scenario.scopeZ.key}`,
    ).toEqual([{ scope_key: scenario.scopeZ.key, runs_days: 9 }]);
    expect(
      await migSql`
          select count(*)::int as n from ai_observation_retention_overrides
          where scope_key = ${legacyKey("actor-z", scenario.scopeZ.botId)}`,
    ).toEqual([{ n: 0 }]);
  }, 300_000);

  test("replaying the file is a no-op: stable rows are skipped, losers stay put", async () => {
    await ensureScenario();
    await replay();
    await replay();

    expect(
      await migSql`
          select scope_key, opik_trace_id from ai_observation_bindings where id = ${scenario.w1.id}`,
    ).toEqual([
      { scope_key: scenario.scopeX.key, opik_trace_id: "mig-trace-9" },
    ]);
    expect(
      await migSql`
          select scope_key, opik_trace_id from ai_observation_bindings where id = ${scenario.ghost.id}`,
    ).toEqual([{ scope_key: scenario.legacyX1, opik_trace_id: "mig-trace-9" }]);
    expect(
      await migSql`
          select count(*)::int as n from ai_observation_retention_overrides
          where scope_key = ${scenario.scopeZ.key}`,
    ).toEqual([{ n: 1 }]);
    expect(
      await migSql`
          select locator_workspace from ai_observation_retention_deletions
          where id = ${deletionRecordId}`,
    ).toEqual([{ locator_workspace: "frozen-ws" }]);
  }, 300_000);
});
