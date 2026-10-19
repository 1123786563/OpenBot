import { afterAll, afterEach, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createExperimentComparisonService } from "../src/ai-observability/comparison";
import { createObservationDatasetStore } from "../src/ai-observability/datasets";
import {
  createObservationExecutionStore,
  createObservationExecutionWorker,
  type EvaluationCaseContext,
  type EvaluationCaseOutcome,
  EXECUTION_WORK_KIND,
} from "../src/ai-observability/executions";
import { createObservationExperimentStore } from "../src/ai-observability/experiments";
import { createAiObservabilityRoutes } from "../src/ai-observability/routes";
import { resolveObservationScope } from "../src/ai-observability/scope";
import { createAuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { aiObservationExperimentExecutions } from "../src/db/schema/ai-observability-executions";
import { workItems } from "../src/db/schema/work";
import { opikTestDatabase } from "./support/opik-test-db";

/**
 * Behavioral proof of the experiment comparison against a real, dedicated PostgreSQL
 * database, END TO END through the real mount table (Issue #35 / DAG T29): the T28
 * result route and this ticket's comparison route answer behind the same
 * createAiObservabilityRoutes assembly, over executions the real worker settled, so the
 * wiring obligation the T28 review surfaced — "results.ts is not wired" — is proven
 * closed here and not asserted anywhere else. Compatibility is judged over rows the real
 * T19/T22 pipelines froze; regressions link the frozen case and both executions; scope
 * isolation and the manage gate close at the SQL layer. There is no skip and no fallback
 * database; a missing test database fails the run.
 */

const database = opikTestDatabase();
const datasets = createObservationDatasetStore(database);
const experiments = createObservationExperimentStore(database);
const executions = createObservationExecutionStore(database);
const audit = createAuditStore(database);
const service = createExperimentComparisonService({
  experiments,
  executions,
  datasets,
  ticket: async () => null,
});
const prefix = `t29-${randomUUID()}`;

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

const configFor = (modelName: string) => ({
  botConfig: { toolChoice: "auto" },
  prompt: "Answer the support question from the outage report.",
  modelName,
  modelParameters: { temperature: 0, maxTokens: 1024 },
  toolFixtures: { search: { query: "outage", results: 0 } },
  judgeConfig: RULES,
  judgeVersion: "rules/1",
  readOnlyTools: ["search"],
});

/** The real route table this ticket wires: requireUser root, manage gate, live epoch. */
function mountedApp(actor: { id: string; role: string }) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", (async (context, next) => {
    context.set("actor", actor as unknown as AuthenticatedActor);
    await next();
  }) satisfies MiddlewareHandler<{ Variables: AppVariables }>);
  app.route(
    "/api/ai-observability",
    createAiObservabilityRoutes({
      requireUser: (async (_context, next) => {
        await next();
      }) satisfies MiddlewareHandler<{ Variables: AppVariables }>,
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
      database,
    }),
  );
  return app;
}

/** One frozen dataset version over `cases` cases, through the real T19 pipeline. */
async function frozenVersion(
  cases: number,
  marker = "Summarize the outage report.",
) {
  const { version } = await datasets.saveVersion(scopeA, {
    datasetName: `${prefix}-dataset-${randomUUID().slice(0, 8)}`,
    cases: Array.from({ length: cases }, () => ({
      input: marker,
      referenceOutput: "A one-paragraph summary.",
      toolFixtures: { search: { query: "outage", results: 3 } },
      sourceRunId: "run-1",
      sourceAttemptId: "attempt-1",
      sourceBindingId: "binding-1",
    })),
  });
  return version;
}

/** One frozen experiment pinning `versionId`, through the real T22 pipeline. */
async function frozenExperiment(versionId: string, modelName: string) {
  const submitted = await experiments.submit(scopeA, {
    name: `${prefix}-experiment-${randomUUID().slice(0, 8)}`,
    datasetVersionId: versionId,
    config: configFor(modelName),
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
    classify: (toolName: string) => (toolName === "search" ? "read" : "write"),
    runCase,
    reauthorize: async ({ actorId }) =>
      actorId === scopeA.actorId ? scopeA : null,
    owner: `t29-owner-${randomUUID()}`,
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
  // the T23/T28 suites' cleanup.
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

test("the mounted route table answers both the T28 result read and the comparison, end to end", {
  timeout: 30_000,
}, async () => {
  // Two experiments over ONE frozen version, same scoring definition, different models:
  // the A7 shape — same frozen eval set, two configurations.
  const version = await frozenVersion(2);
  const baseline = await frozenExperiment(version.id, "claude-sonnet-5");
  const candidate = await frozenExperiment(version.id, "claude-haiku-4-5");

  const baselineRun = await executions.enqueue(scopeA, baseline.id);
  const candidateRun = await executions.enqueue(scopeA, candidate.id);
  await workerFor(async (context) => {
    if (context.experimentId === baseline.id) {
      return {
        status: "completed",
        output: "A one-paragraph outage summary.",
        usage: { tokens_input: 120, tokens_output: 45 },
      };
    }
    return {
      status: "completed",
      // The candidate: case 0 drops a rule, case 1 fails outright.
      output:
        context.caseIndex === 0
          ? "an outage summary"
          : "sk-live-abcdefghijklmnopqrst and a summary of the outage.",
      usage: { tokens_input: 90 },
    };
  }).sweep();
  await until(
    async () =>
      (await settledRow(baselineRun.id))?.state === "completed" &&
      (await settledRow(candidateRun.id))?.state === "completed",
  );

  const app = mountedApp({ id: scopeA.actorId, role: "user" });

  // The T28 wiring obligation, closed: the result route answers behind the real mount.
  const resultResponse = await app.request(
    `http://openbot.test/api/ai-observability/bots/agent-1/experiments/${baseline.id}/results/${baselineRun.id}`,
  );
  expect(resultResponse.status).toBe(200);
  const report = await resultResponse.json();
  expect(report).toMatchObject({
    experimentId: baseline.id,
    executionId: baselineRun.id,
    scorerVersion: "rules/1",
    summary: { sampleBase: 2, scored: 2, meanScore: 1 },
  });

  // The comparison route, same assembly.
  const response = await app.request(
    `http://openbot.test/api/ai-observability/bots/agent-1/experiment-comparisons` +
      `?baselineExperimentId=${baseline.id}&baselineExecutionId=${baselineRun.id}` +
      `&candidateExperimentId=${candidate.id}&candidateExecutionId=${candidateRun.id}`,
  );
  expect(response.status).toBe(200);
  const comparison = await response.json();

  expect(comparison.compatibility.compatible).toBe(true);
  expect(comparison.compatibility.fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: "datasetContentHash",
        baseline: version.contentHash,
        candidate: version.contentHash,
        equal: true,
        blocking: true,
      }),
      expect.objectContaining({
        field: "modelName",
        equal: false,
        blocking: false,
      }),
    ]),
  );

  // AC2: the ledgers over the really-settled rows. The candidate scored one of two
  // (case 1's secret-bearing output was withheld — metrics only — so scoring failed).
  expect(comparison.baseline.report.summary).toMatchObject({
    sampleBase: 2,
    scored: 2,
    executionFailed: 0,
    scoringFailed: 0,
    meanScore: 1,
  });
  expect(comparison.candidate.report.summary).toMatchObject({
    sampleBase: 2,
    scored: 1,
    scoringFailed: 1,
    meanScore: 0.5,
  });
  expect(completionRateOf(comparison, "baseline")).toBe(1);
  expect(completionRateOf(comparison, "candidate")).toBe(1);
  expect(comparison.baseline.usage).toEqual({ reported: 2, missing: 0 });
  expect(comparison.candidate.usage).toEqual({ reported: 2, missing: 0 });
  expect(comparison.baseline.timing.durationMs).not.toBeNull();
  expect(comparison.deltas.meanScore).toEqual({
    baseline: 1,
    candidate: 0.5,
    delta: -0.5,
  });

  // AC3: the regressed samples link the frozen case and both executions.
  expect(comparison.regressions).toHaveLength(2);
  const [dropped, withheld] = comparison.regressions;
  expect(dropped).toMatchObject({
    index: 0,
    case: { datasetVersionId: version.id, contentHash: version.contentHash },
    baseline: { class: "scored", score: 1, code: null },
    candidate: { class: "scored", score: 0.5, code: null },
  });
  expect(dropped.baseline.resultLink).toBe(
    `/api/ai-observability/bots/agent-1/experiments/${baseline.id}/results/${baselineRun.id}`,
  );
  expect(dropped.candidate.resultLink).toBe(
    `/api/ai-observability/bots/agent-1/experiments/${candidate.id}/results/${candidateRun.id}`,
  );
  // Metrics-only stays exactly that: a scoring failure the policy withheld, not a story.
  expect(withheld).toMatchObject({
    index: 1,
    baseline: { class: "scored", score: 1 },
    candidate: { class: "scoring_failed", score: null, code: "OUTPUT_MISSING" },
  });
});

test("a different frozen sample set refuses the verdict and explains the difference", {
  timeout: 30_000,
}, async () => {
  const baselineVersion = await frozenVersion(2);
  const candidateVersion = await frozenVersion(
    2,
    "Summarize a DIFFERENT report.",
  );
  const baseline = await frozenExperiment(
    baselineVersion.id,
    "claude-sonnet-5",
  );
  const candidate = await frozenExperiment(
    candidateVersion.id,
    "claude-haiku-4-5",
  );

  const baselineRun = await executions.enqueue(scopeA, baseline.id);
  const candidateRun = await executions.enqueue(scopeA, candidate.id);
  await workerFor(async () => ({
    status: "completed",
    output: "A one-paragraph outage summary.",
  })).sweep();
  await until(
    async () =>
      (await settledRow(baselineRun.id))?.state === "completed" &&
      (await settledRow(candidateRun.id))?.state === "completed",
  );

  const comparison = await service.compare(scopeA, {
    baseline: {
      experimentId: baseline.id,
      executionId: baselineRun.id,
    },
    candidate: {
      experimentId: candidate.id,
      executionId: candidateRun.id,
    },
  });

  expect(comparison.compatibility.compatible).toBe(false);
  const hash = comparison.compatibility.fields.find(
    (one) => one.field === "datasetContentHash",
  );
  expect(hash?.baseline).toBe(baselineVersion.contentHash);
  expect(hash?.candidate).toBe(candidateVersion.contentHash);
  expect(hash?.baseline).not.toBe(hash?.candidate);
  // No deltas, no regressions: no winner across different sample sets.
  expect(comparison.deltas).toBeNull();
  expect(comparison.regressions).toBeNull();
});

test("a still-in-flight candidate answers no verdict, not a premature regression (T29-rev L-1)", {
  timeout: 30_000,
}, async () => {
  const version = await frozenVersion(1);
  const baseline = await frozenExperiment(version.id, "claude-sonnet-5");
  const candidate = await frozenExperiment(version.id, "claude-haiku-4-5");

  // The baseline settles through the real worker; the candidate is enqueued only
  // after the sweep, so it stays in flight with a live claim ticket — the honest
  // open state a comparison must refuse to rank.
  const baselineRun = await executions.enqueue(scopeA, baseline.id);
  await workerFor(async () => ({
    status: "completed",
    output: "A one-paragraph outage summary.",
    usage: { tokens_input: 120, tokens_output: 45 },
  })).sweep();
  await until(
    async () => (await settledRow(baselineRun.id))?.state === "completed",
  );
  const candidateRun = await executions.enqueue(scopeA, candidate.id);

  const app = mountedApp({ id: scopeA.actorId, role: "user" });
  const response = await app.request(
    `http://openbot.test/api/ai-observability/bots/agent-1/experiment-comparisons` +
      `?baselineExperimentId=${baseline.id}&baselineExecutionId=${baselineRun.id}` +
      `&candidateExperimentId=${candidate.id}&candidateExecutionId=${candidateRun.id}`,
  );
  expect(response.status).toBe(200);
  const comparison = await response.json();

  expect(comparison.compatibility.compatible).toBe(true);
  // The candidate's own facts stay honest: nothing settled, no mean, no completion.
  expect(comparison.candidate.report.summary).toMatchObject({
    sampleBase: 1,
    scored: 0,
    inProgress: 1,
    meanScore: null,
  });
  expect(comparison.candidate.completionRate).toBe(0);
  expect(comparison.deltas.meanScore).toEqual({
    baseline: 1,
    candidate: null,
    delta: null,
  });
  // The open sample keeps the fail-closed verdict and rides no regression list.
  expect(comparison.deltas.perSample).toEqual([
    expect.objectContaining({
      index: 0,
      baseline: { class: "scored", score: 1 },
      candidate: { class: "in_progress", score: null },
      scoreDelta: null,
      direction: "incomparable",
    }),
  ]);
  expect(comparison.regressions).toEqual([]);
});

test("the mounted gate: a stranger or another scope learns nothing (AC4)", {
  timeout: 30_000,
}, async () => {
  const version = await frozenVersion(1);
  const baseline = await frozenExperiment(version.id, "claude-sonnet-5");
  const candidate = await frozenExperiment(version.id, "claude-haiku-4-5");
  const baselineRun = await executions.enqueue(scopeA, baseline.id);
  const candidateRun = await executions.enqueue(scopeA, candidate.id);

  const query =
    `?baselineExperimentId=${baseline.id}&baselineExecutionId=${baselineRun.id}` +
    `&candidateExperimentId=${candidate.id}&candidateExecutionId=${candidateRun.id}`;

  // The manage gate closes before the scope: a stranger learns the bot 404.
  const stranger = await mountedApp({
    id: "user-stranger",
    role: "user",
  }).request(
    `http://openbot.test/api/ai-observability/bots/agent-1/experiment-comparisons${query}`,
  );
  expect(stranger.status).toBe(404);

  // Another scope's ids are simply not found — the service layer, SQL-filtered.
  await expect(
    service.compare(scopeB, {
      baseline: { experimentId: baseline.id, executionId: baselineRun.id },
      candidate: { experimentId: candidate.id, executionId: candidateRun.id },
    }),
  ).rejects.toMatchObject({ code: "RESULTS_EXPERIMENT_NOT_FOUND" });

  // A guessed execution id under a real experiment is not found, not an empty side.
  await expect(
    service.compare(scopeA, {
      baseline: {
        experimentId: baseline.id,
        executionId: `guess-${randomUUID()}`,
      },
      candidate: { experimentId: candidate.id, executionId: candidateRun.id },
    }),
  ).rejects.toMatchObject({ code: "RESULTS_EXECUTION_NOT_FOUND" });

  // A missing query parameter is an input refusal over HTTP.
  const incomplete = await mountedApp({
    id: scopeA.actorId,
    role: "user",
  }).request(
    "http://openbot.test/api/ai-observability/bots/agent-1/experiment-comparisons?baselineExperimentId=x",
  );
  expect(incomplete.status).toBe(400);
  expect((await incomplete.json()).error).toBe("COMPARISON_INPUT_INVALID");
});

/** JSON round-trips numbers; a tiny reader keeps the expectations honest about shape. */
function completionRateOf(
  comparison: Awaited<ReturnType<typeof service.compare>>,
  side: "baseline" | "candidate",
): number {
  return comparison[side].completionRate;
}
