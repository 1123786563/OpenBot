import { afterAll, afterEach, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createObservationDatasetStore } from "../src/ai-observability/datasets";
import {
  createObservationExecutionStore,
  createObservationExecutionWorker,
  type EvaluationCaseContext,
  type EvaluationCaseOutcome,
  EXECUTION_WORK_KIND,
  ExecutionError,
} from "../src/ai-observability/executions";
import { createObservationExperimentStore } from "../src/ai-observability/experiments";
import {
  createExperimentResultService,
  createWorkTicketReader,
  ExperimentResultsError,
} from "../src/ai-observability/results";
import { createExperimentResultsRoutes } from "../src/ai-observability/routes/results";
import { resolveObservationScope } from "../src/ai-observability/scope";
import { createAuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { aiObservationExperimentExecutions } from "../src/db/schema/ai-observability-executions";
import { workItems } from "../src/db/schema/work";
import { opikTestDatabase } from "./support/opik-test-db";

/**
 * Behavioral proof of the experiment result query against a real, dedicated PostgreSQL
 * database (Issue #34 / DAG T28): the per-sample report over a really-settled execution
 * (score, reason, scorer version, usage, the execution link), the five failure classes
 * materialized in database facts rather than fakes (a failed settle, a cancellation, a
 * lease-orphaned claim ticket, a damaged result record), scope isolation and the
 * unfakeable execution back-link at the SQL layer, and the settle-side projection that
 * keeps withheld outputs out of the scoreable set. There is no skip and no fallback
 * database; a missing test database fails the run.
 *
 * The sweep-driven tests take an explicit timeout, exactly like the T23 suite: one worker
 * pass is a dozen-plus sequential round trips against a shared local Postgres.
 */

const database = opikTestDatabase();
const datasets = createObservationDatasetStore(database);
const experiments = createObservationExperimentStore(database);
const executions = createObservationExecutionStore(database);
const audit = createAuditStore(database);
const ticket = createWorkTicketReader(database);
const service = createExperimentResultService({
  experiments,
  executions,
  datasets,
  ticket,
});
const prefix = `t28-${randomUUID()}`;

const scopeA = resolveObservationScope({
  actorId: "user-a",
  botId: `opik-results-integration-bot-a-${randomUUID()}`,
  ownership: "owner",
  epoch: 1,
});
const scopeB = resolveObservationScope({
  actorId: "user-b",
  botId: `opik-results-integration-bot-b-${randomUUID()}`,
  ownership: "admin",
  epoch: 1,
});
const scopeANextEpoch = resolveObservationScope({
  actorId: "user-a",
  botId: scopeA.botId,
  ownership: "owner",
  epoch: 2,
});

const RULES = {
  rules: [
    {
      id: "greeting",
      kind: "exact_match",
      expected: "A one-paragraph outage summary.",
    },
    { id: "mentions-outage", kind: "contains", expected: "outage" },
  ],
};

const config = {
  botConfig: { toolChoice: "auto" },
  prompt: "Answer the support question from the outage report.",
  modelName: "claude-sonnet-5",
  modelParameters: { temperature: 0, maxTokens: 1024 },
  toolFixtures: { search: { query: "outage", results: 0 } },
  judgeConfig: RULES,
  judgeVersion: "rules/1",
  readOnlyTools: ["search"],
};

/** search reads; everything else is a production write. */
const classify = (toolName: string) =>
  toolName === "search" ? "read" : "write";

/** One frozen experiment over `cases` dataset cases, through the real T19+T22 pipelines. */
async function frozenExperiment(cases: number) {
  const { version } = await datasets.saveVersion(scopeA, {
    datasetName: `${prefix}-dataset-${randomUUID().slice(0, 8)}`,
    cases: Array.from({ length: cases }, () => ({
      input: "Summarize the outage report.",
      referenceOutput: "A one-paragraph summary.",
      toolFixtures: { search: { query: "outage", results: 3 } },
      sourceRunId: "run-1",
      sourceAttemptId: "attempt-1",
      sourceBindingId: "binding-1",
    })),
  });
  const submitted = await experiments.submit(scopeA, {
    name: `${prefix}-experiment-${randomUUID().slice(0, 8)}`,
    datasetVersionId: version.id,
    config,
  });
  return submitted.experiment;
}

/** The worker over an injected runner; the production runner is T24's work. */
function workerFor(
  runCase: (context: EvaluationCaseContext) => Promise<EvaluationCaseOutcome>,
) {
  return createObservationExecutionWorker({
    database,
    audit,
    classify,
    runCase,
    reauthorize: async ({ actorId }) =>
      actorId === scopeA.actorId ? scopeA : null,
    owner: `t28-owner-${randomUUID()}`,
  });
}

async function until(
  predicate: () => Promise<boolean> | boolean,
  what: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition not reached: ${what}`);
}

const settledRow = async (id: string) => {
  const rows = await database
    .select()
    .from(aiObservationExperimentExecutions)
    .where(eq(aiObservationExperimentExecutions.id, id));
  return rows[0];
};

afterEach(async () => {
  // Executions first: their foreign key pins the experiments underneath, exactly like
  // the T23 suite's cleanup.
  await database.delete(aiObservationExperimentExecutions);
  await database
    .delete(workItems)
    .where(eq(workItems.kind, EXECUTION_WORK_KIND));
  await database.$client.begin(async (tx: TransactionSQL) => {
    await tx`select set_config('ai_observation.experiment_cleanup', 'on', true)`;
    await tx`select set_config('ai_observation.dataset_cleanup', 'on', true)`;
    await tx`DELETE FROM ai_observation_experiments WHERE name LIKE ${`${prefix}%`}`;
    await tx`DELETE FROM ai_observation_datasets WHERE name LIKE ${`${prefix}%`}`;
  });
});

afterAll(async () => {
  await database.$client.close();
});

test("a settled execution answers the per-sample report end to end", {
  timeout: 30_000,
}, async () => {
  const experiment = await frozenExperiment(3);
  const enqueued = await executions.enqueue(scopeA, experiment.id);

  await workerFor(async (context) => {
    if (context.caseIndex === 0) {
      return {
        status: "completed",
        output: "A one-paragraph outage summary.",
        usage: { tokens_input: 120, tokens_output: 45 },
      };
    }
    if (context.caseIndex === 1) {
      return { status: "failed" };
    }
    // A secret in the model output: the settle projection withholds it, and the
    // read side classifies the sample as a scoring failure, never a pass.
    return {
      status: "completed",
      output: "sk-live-abcdefghijklmnopqrst and a summary of the outage.",
      usage: { tokens_input: 10 },
    };
  }).sweep();
  await until(
    async () => (await settledRow(enqueued.id))?.state === "completed",
  );

  const report = await service.query(scopeA, {
    experimentId: experiment.id,
    executionId: enqueued.id,
  });

  expect(report.state).toBe("completed");
  expect(report.scorerVersion).toBe("rules/1");
  expect(report.execution.id).toBe(enqueued.id);
  expect(report.execution.experimentConfigHash).toBe(experiment.configHash);
  expect(report.resultLink).toBe(
    `/api/ai-observability/bots/${scopeA.botId}/experiments/${experiment.id}/results/${enqueued.id}`,
  );

  // AC1: score, reason, scorer version, usage, result link — per sample.
  const [good, failedCase, withheld] = report.samples;
  expect(good).toMatchObject({
    index: 0,
    class: "scored",
    score: 1,
    usage: { tokens_input: 120, tokens_output: 45 },
    resultLink: report.resultLink,
  });
  expect(good.reason).toMatchObject({
    class: "scored",
    passed: 2,
    failed: 0,
  });
  expect(failedCase).toMatchObject({ index: 1, class: "execution_failed" });
  expect(failedCase.reason).toMatchObject({ code: "CASE_FAILED" });
  expect(withheld).toMatchObject({ index: 2, class: "scoring_failed" });
  expect(withheld.reason).toMatchObject({ code: "OUTPUT_MISSING" });
  expect(withheld.usage).toEqual({ tokens_input: 10 });

  // AC2: the mean covers the one scored sample over an explicit base of three.
  expect(report.summary).toEqual({
    sampleBase: 3,
    scored: 1,
    executionFailed: 1,
    scoringFailed: 1,
    cancelled: 0,
    pendingReconciliation: 0,
    syncFailure: 0,
    inProgress: 0,
    meanScore: 1,
  });
});

test("a failed execution carries its error code onto every base sample", async () => {
  const experiment = await frozenExperiment(2);
  const enqueued = await executions.enqueue(scopeA, experiment.id);
  await executions.markRunning(enqueued.id);
  await executions.settleFailed(enqueued.id, "CASE_EXECUTION_ERROR");

  const report = await service.query(scopeA, {
    experimentId: experiment.id,
    executionId: enqueued.id,
  });
  expect(report.state).toBe("failed");
  expect(report.samples.map((sample) => sample.class)).toEqual([
    "execution_failed",
    "execution_failed",
  ]);
  for (const sample of report.samples) {
    expect(sample.reason).toEqual({
      class: "execution_failed",
      code: "CASE_EXECUTION_ERROR",
    });
  }
  expect(report.summary.meanScore).toBeNull();
});

test("a cancelled execution classifies its samples as cancelled", async () => {
  const experiment = await frozenExperiment(1);
  const enqueued = await executions.enqueue(scopeA, experiment.id);
  await executions.cancelForActor(scopeA.actorId);

  const report = await service.query(scopeA, {
    experimentId: experiment.id,
    executionId: enqueued.id,
  });
  expect(report.state).toBe("cancelled");
  expect(report.samples.map((sample) => sample.class)).toEqual(["cancelled"]);
  expect(report.summary).toMatchObject({
    cancelled: 1,
    scored: 0,
    meanScore: null,
  });
});

test("an unsettled execution is in progress while its ticket is live, reconcilable when orphaned", async () => {
  const experiment = await frozenExperiment(1);
  const enqueued = await executions.enqueue(scopeA, experiment.id);

  // Freshly enqueued: the ticket is unclaimed and live — work is coming, not lost.
  const fresh = await service.query(scopeA, {
    experimentId: experiment.id,
    executionId: enqueued.id,
  });
  expect(fresh.state).toBe("pending");
  expect(fresh.samples[0].class).toBe("in_progress");
  expect(fresh.summary).toMatchObject({ inProgress: 1 });

  // The worker claims the ticket, then dies: the lease is in the past while the
  // execution still says running — lease-recovery territory, displayed as such.
  await database
    .update(workItems)
    .set({
      claimedBy: `t28-dead-${randomUUID()}`,
      leaseUntil: new Date(Date.now() - 60_000),
    })
    .where(
      and(
        eq(workItems.kind, EXECUTION_WORK_KIND),
        eq(workItems.key, enqueued.id),
      ),
    );
  await executions.markRunning(enqueued.id);

  const orphaned = await service.query(scopeA, {
    experimentId: experiment.id,
    executionId: enqueued.id,
  });
  expect(orphaned.state).toBe("running");
  expect(orphaned.samples[0].class).toBe("pending_reconciliation");
  expect(orphaned.samples[0].reason).toMatchObject({ code: "LEASE_EXPIRED" });
  expect(orphaned.summary).toMatchObject({
    pendingReconciliation: 1,
    inProgress: 0,
  });
});

test("a damaged settled result is a sync failure, never a guessed score", {
  timeout: 30_000,
}, async () => {
  const experiment = await frozenExperiment(2);
  const enqueued = await executions.enqueue(scopeA, experiment.id);
  await workerFor(async () => ({
    status: "completed",
    output: "A one-paragraph summary.",
  })).sweep();
  await until(
    async () => (await settledRow(enqueued.id))?.state === "completed",
  );

  // One case record vanished and the other was corrupted in storage: the read side
  // classifies both as sync failures instead of inventing outcomes for them.
  await database
    .update(aiObservationExperimentExecutions)
    .set({ result: { cases: [{ index: 0, broken: true }] } })
    .where(eq(aiObservationExperimentExecutions.id, enqueued.id));

  const report = await service.query(scopeA, {
    experimentId: experiment.id,
    executionId: enqueued.id,
  });
  expect(report.samples.map((sample) => sample.class)).toEqual([
    "sync_failure",
    "sync_failure",
  ]);
  expect(report.samples[0].reason).toMatchObject({
    code: "CASE_RECORD_DAMAGED",
  });
  expect(report.samples[1].reason).toMatchObject({
    code: "CASE_RECORD_MISSING",
  });
  expect(report.summary).toMatchObject({ syncFailure: 2, meanScore: null });
});

test("scope discipline: another scope or epoch learns nothing, and the back-link cannot be faked", async () => {
  const mine = await frozenExperiment(1);
  const other = await frozenExperiment(1);
  const myExecution = await executions.enqueue(scopeA, mine.id);
  const otherExecution = await executions.enqueue(scopeA, other.id);

  // Another actor's scope: both ids are simply not found.
  await expect(
    service.query(scopeB, {
      experimentId: mine.id,
      executionId: myExecution.id,
    }),
  ).rejects.toThrow(
    new ExperimentResultsError("RESULTS_EXPERIMENT_NOT_FOUND", 404),
  );

  // A bumped ownership epoch keeps the SAME data address (FREV-03 b): the new
  // generation reads the execution instead of losing it to a rotated key space.
  const bumped = await service.query(scopeANextEpoch, {
    experimentId: mine.id,
    executionId: myExecution.id,
  });
  expect(bumped.execution.id).toBe(myExecution.id);

  // A guessed execution id under a real experiment is not found.
  await expect(
    service.query(scopeA, {
      experimentId: mine.id,
      executionId: `guess-${randomUUID()}`,
    }),
  ).rejects.toThrow(
    new ExperimentResultsError("RESULTS_EXECUTION_NOT_FOUND", 404),
  );

  // A real execution of ANOTHER experiment does not link back to this one.
  await expect(
    service.query(scopeA, {
      experimentId: mine.id,
      executionId: otherExecution.id,
    }),
  ).rejects.toThrow(
    new ExperimentResultsError("RESULTS_EXECUTION_NOT_FOUND", 404),
  );

  // The owning scope still reads its own execution (sanity, not a tautology: the
  // reads above must have been refusals, not damage).
  const report = await service.query(scopeA, {
    experimentId: other.id,
    executionId: otherExecution.id,
  });
  expect(report.executionId).toBe(otherExecution.id);
});

test("the REST route serves the report over the real stores behind the manage gate", {
  timeout: 30_000,
}, async () => {
  const experiment = await frozenExperiment(1);
  const enqueued = await executions.enqueue(scopeA, experiment.id);
  await workerFor(async () => ({
    status: "completed",
    output: "A one-paragraph outage summary.",
    usage: { tokens_input: 12 },
  })).sweep();
  await until(
    async () => (await settledRow(enqueued.id))?.state === "completed",
  );

  const app = new Hono<{ Variables: AppVariables }>();
  const actor = { id: scopeA.actorId, role: "user" };
  app.use("*", (async (context, next) => {
    context.set("actor", actor as unknown as AuthenticatedActor);
    await next();
  }) satisfies MiddlewareHandler<{ Variables: AppVariables }>);
  app.route(
    "/bots/:botId/experiments/:experimentId/results",
    createExperimentResultsRoutes({
      canManageBot: async (requester, botId) =>
        requester.id === scopeA.actorId && botId === scopeA.botId
          ? ({
              id: botId,
              ownerUserId: scopeA.actorId,
              systemOwned: false,
              deletedAt: null,
            } as never)
          : null,
      scopeEpoch: async () => 1,
      experiments,
      executions,
      datasets,
      ticket,
    }),
  );

  const path = `/bots/${scopeA.botId}/experiments/${experiment.id}/results/${enqueued.id}`;
  const response = await app.request(`http://openbot.test${path}`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    experimentId: experiment.id,
    executionId: enqueued.id,
    scorerVersion: "rules/1",
    summary: { sampleBase: 1, scored: 1, meanScore: 1 },
  });
  expect(body.samples[0].resultLink).toBe(
    `/api/ai-observability/bots/${scopeA.botId}/experiments/${experiment.id}/results/${enqueued.id}`,
  );
  expect(JSON.stringify(body)).not.toContain("Infinity");

  // The manage gate closes before the scope: a stranger learns the 404.
  const strangerApp = new Hono<{ Variables: AppVariables }>();
  strangerApp.use("*", (async (context, next) => {
    context.set("actor", {
      id: "user-stranger",
      role: "user",
    } as unknown as AuthenticatedActor);
    await next();
  }) satisfies MiddlewareHandler<{ Variables: AppVariables }>);
  strangerApp.route(
    "/bots/:botId/experiments/:experimentId/results",
    createExperimentResultsRoutes({
      canManageBot: async () => null,
      scopeEpoch: async () => 1,
      experiments,
      executions,
      datasets,
      ticket,
    }),
  );
  const refused = await strangerApp.request(`http://openbot.test${path}`);
  expect(refused.status).toBe(404);
});

test("the settle projection withholds secrets from the scoreable output column", {
  timeout: 30_000,
}, async () => {
  const experiment = await frozenExperiment(1);
  const enqueued = await executions.enqueue(scopeA, experiment.id);
  await workerFor(async () => ({
    status: "completed",
    output: "Bearer abcdefghijklmnopqrst",
    usage: { tokens_input: 1 },
  })).sweep();
  await until(
    async () => (await settledRow(enqueued.id))?.state === "completed",
  );

  const settled = await settledRow(enqueued.id);
  expect(settled?.result).toEqual({
    cases: [
      {
        index: 0,
        status: "completed",
        output: { state: "omitted", reason: "credential" },
        usage: {
          state: "projected",
          value: { tokens_input: { state: "projected", value: 1 } },
        },
      },
    ],
  });
});

test("the store still refuses the executions vocabulary violations (adjacent sanity)", async () => {
  await expect(executions.get(scopeA, "   ")).rejects.toThrow(
    new ExecutionError("EXECUTION_INPUT_INVALID", 400),
  );
});
