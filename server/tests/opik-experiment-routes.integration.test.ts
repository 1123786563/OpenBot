import { afterAll, afterEach, describe, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import type { TransactionSQL } from "../../tests/support/bun-compat";
import { and, eq, like } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { OBSERVATION_BOT_NOT_FOUND } from "../src/ai-observability/context";
import { createObservationDatasetStore } from "../src/ai-observability/datasets";
import { createExecutionBudgetPrecheck } from "../src/ai-observability/execution-billing";
import {
  createObservationExecutionStore,
  EXECUTION_WORK_KIND,
  type ExecutionBudgetPrecheck,
} from "../src/ai-observability/executions";
import { createObservationExperimentStore } from "../src/ai-observability/experiments";
import { createAiObservabilityRoutes } from "../src/ai-observability/routes";
import { resolveObservationScope } from "../src/ai-observability/scope";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createCreditWriter } from "../src/billing/credits-writer";
import { aiObservationExperimentExecutions } from "../src/db/schema/ai-observability-executions";
import { aiObservationExperiments } from "../src/db/schema/ai-observability-experiments";
import { aiObservationRetentionDeletions } from "../src/db/schema/ai-observability-retention";
import { billingCustomers } from "../src/db/schema/billing";
import { auditEvents } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { opikTestDatabase } from "./support/opik-test-db";

/**
 * The creator's experiment WRITE routes against a real, dedicated PostgreSQL database,
 * END TO END through the real mount table (T-routes closure ticket): the T30 page's two
 * URL faces — POST /bots/:botId/experiments (submit: freeze + start in one POST) and
 * POST .../experiments/:experimentId/executions/:executionId/cancel — answer behind the
 * same createAiObservabilityRoutes assembly the production boot mounts. The wire shapes
 * are the ones shared/ai-observability-experiments.ts pinned; the freeze idempotency is
 * T22's frozen-configuration key; the cancel settles a not-yet-terminal execution and
 * refuses a terminal one. Every row is written by the real T19/T22/T23 stores, and
 * scope isolation closes at the SQL layer. There is no skip and no fallback database.
 */

const database = opikTestDatabase();
const datasets = createObservationDatasetStore(database);
const experiments = createObservationExperimentStore(database);
const executions = createObservationExecutionStore(database);
const writer = createCreditWriter(database);
const prefix = `tr-${randomUUID().slice(0, 8)}`;

/**
 * The execution rows this suite actually started (every one comes out of a
 * submit answer's executionId). The cleanup narrows to exactly these (T-routes
 * review M1, the C-4 L-4 footing): a shared database must not lose other
 * suites' in-flight rows to this suite's afterEach.
 */
const startedExecutionIds: string[] = [];

// A file-unique scope: the suite runs concurrently with the other opik files on one
// dedicated database, and a scope no other file writes keeps this file's rows out of
// every other file's window (and theirs out of this one's).
const scopeA = resolveObservationScope({
  actorId: "user-tr-routes",
  botId: "agent-tr-routes",
  ownership: "owner",
  epoch: 1,
});

const CONFIG = {
  botConfig: { toolChoice: "auto" },
  prompt: "Answer the support question from the outage report.",
  modelName: "gateway-model",
  modelParameters: { temperature: 0, maxTokens: 1024 },
  toolFixtures: { search: { query: "outage", results: 0 } },
  judgeConfig: {
    rules: [{ id: "mentions-outage", kind: "contains", expected: "outage" }],
  },
  judgeVersion: "rules/1",
  readOnlyTools: ["search"],
};

const ALLOW_PRECHECK: ExecutionBudgetPrecheck = async () => ({ allowed: true });

/** The real route table: requireUser root, manage gate, live epoch, injected billing. */
function mountedApp(
  actor: { id: string; role: string } = {
    id: scopeA.actorId,
    role: "user",
  },
  precheck: ExecutionBudgetPrecheck | null = ALLOW_PRECHECK,
) {
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
      ...(precheck === null ? {} : { executionBilling: { precheck } }),
    }),
  );
  return app;
}

const submitUrl =
  "http://openbot.test/api/ai-observability/bots/agent-tr-routes/experiments";

async function submit(app: ReturnType<typeof mountedApp>, body: unknown) {
  const response = await app.request(submitUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  // Every execution this suite creates rides a successful submit answer; the
  // refusals (400/402/404) carry no executionId and track nothing.
  try {
    const answered = (await response.clone().json()) as {
      executionId?: unknown;
    };
    if (typeof answered.executionId === "string") {
      startedExecutionIds.push(answered.executionId);
    }
  } catch {
    // A non-JSON body carries no execution to track.
  }
  return response;
}

const cancelUrl = (experimentId: string, executionId: string) =>
  `http://openbot.test/api/ai-observability/bots/agent-tr-routes/experiments/${experimentId}/executions/${executionId}/cancel`;

/** One frozen dataset version, through the real T19 pipeline. */
async function frozenVersion() {
  const { version } = await datasets.saveVersion(scopeA, {
    datasetName: `${prefix}-dataset-${randomUUID().slice(0, 8)}`,
    cases: [
      {
        input: "Summarize the outage report.",
        referenceOutput: "A one-paragraph summary.",
        toolFixtures: { search: { query: "outage", results: 3 } },
        sourceRunId: "run-1",
        sourceAttemptId: "attempt-1",
        sourceBindingId: "binding-1",
      },
    ],
  });
  return version;
}

const executionRowsOf = async (experimentId: string) =>
  database
    .select()
    .from(aiObservationExperimentExecutions)
    .where(eq(aiObservationExperimentExecutions.experimentId, experimentId));

const auditRowsOf = async (eventType: string, targetId: string) =>
  database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, eventType),
        eq(auditEvents.targetId, targetId),
      ),
    );

afterEach(async () => {
  // This suite's own rows, by id — no full-table sweep, no other suite's rows
  // (T-routes review M1).
  for (const id of startedExecutionIds) {
    await database
      .delete(aiObservationExperimentExecutions)
      .where(eq(aiObservationExperimentExecutions.id, id));
    await database
      .delete(workItems)
      .where(
        and(eq(workItems.kind, EXECUTION_WORK_KIND), eq(workItems.key, id)),
      );
  }
  startedExecutionIds.length = 0;
  // Audit rows are append-only by trigger (and every assertion here addresses its
  // own experiment/execution id), so the trail accumulates on the dedicated database.
  await database.$client.begin(async (tx: TransactionSQL) => {
    await tx`select set_config('ai_observation.experiment_cleanup', 'on', true)`;
    await tx`select set_config('ai_observation.dataset_cleanup', 'on', true)`;
    await tx`DELETE FROM ai_observation_experiments WHERE name LIKE ${`${prefix}%`}`;
    await tx`DELETE FROM ai_observation_datasets WHERE name LIKE ${`${prefix}%`}`;
  });
});

afterAll(async () => {
  // The funding customers the real-precheck guard test granted; grant/ledger
  // rows stay, like every other billing side's dedicated database.
  await database
    .delete(billingCustomers)
    .where(like(billingCustomers.externalId, `${prefix}%`));
  await database.$client.close();
});

describe("POST /bots/:botId/experiments — the submit face", () => {
  test("a submission freezes, starts an execution, and answers the pinned wire shape", async () => {
    const version = await frozenVersion();
    const app = mountedApp();

    const response = await submit(app, {
      name: `${prefix}-exp-1`,
      datasetVersionId: version.id,
      config: CONFIG,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // The whole pinned shape, field for field (shared/ai-observability-experiments.ts).
    expect(Object.keys(body).sort()).toEqual(
      [
        "canaryFindings",
        "configHash",
        "datasetContentHash",
        "datasetVersionId",
        "executionId",
        "experimentId",
        "name",
        "replayed",
      ].sort(),
    );
    expect(body.replayed).toBe(false);
    expect(body.canaryFindings).toBe(0);
    expect(body.name).toBe(`${prefix}-exp-1`);
    expect(body.datasetVersionId).toBe(version.id);
    expect(typeof body.configHash).toBe("string");
    expect((body.configHash as string).length).toBe(64);

    // The execution the submission started: one pending row and its claim ticket.
    const rows = await executionRowsOf(body.experimentId as string);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("pending");
    expect(rows[0]?.experimentConfigHash).toBe(body.configHash);
    const tickets = await database
      .select()
      .from(workItems)
      .where(eq(workItems.key, rows[0]?.id as string));
    expect(tickets).toHaveLength(1);

    // The audited freeze (T22's service layering).
    const trail = await auditRowsOf(
      "opik.experiment_submitted",
      body.experimentId as string,
    );
    expect(trail).toHaveLength(1);
  });

  test("a credential in the configuration is refused by the projection and the canary count rides the answer", async () => {
    const version = await frozenVersion();
    const app = mountedApp();

    const response = await submit(app, {
      name: `${prefix}-exp-canary`,
      datasetVersionId: version.id,
      config: {
        ...CONFIG,
        botConfig: { apiToken: "sk-live-abc123def456ghi789jkl012" },
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { canaryFindings: number };
    expect(body.canaryFindings).toBeGreaterThan(0);
  });

  test("a replayed submission hits the frozen experiment and starts a fresh execution", async () => {
    const version = await frozenVersion();
    const app = mountedApp();
    const first = await submit(app, {
      name: `${prefix}-exp-idem`,
      datasetVersionId: version.id,
      config: CONFIG,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      experimentId: string;
      executionId: string;
    };

    // Same canonical configuration, another name: the freeze is the same experiment.
    const second = await submit(app, {
      name: `${prefix}-exp-idem-2`,
      datasetVersionId: version.id,
      config: CONFIG,
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      experimentId: string;
      executionId: string;
      replayed: boolean;
    };
    expect(secondBody.replayed).toBe(true);
    expect(secondBody.experimentId).toBe(firstBody.experimentId);
    expect(secondBody.executionId).not.toBe(firstBody.executionId);
    expect(await executionRowsOf(firstBody.experimentId)).toHaveLength(2);
  });

  test("a malformed body is a 400 input refusal, never a freeze", async () => {
    const version = await frozenVersion();
    const app = mountedApp();

    const notAnObject = await submit(app, "just a string");
    expect(notAnObject.status).toBe(400);
    expect(await notAnObject.json()).toEqual({
      error: "EXPERIMENT_INPUT_INVALID",
    });

    const missingName = await submit(app, {
      datasetVersionId: version.id,
      config: CONFIG,
    });
    expect(missingName.status).toBe(400);

    const badConfig = await submit(app, {
      name: `${prefix}-exp-bad`,
      datasetVersionId: version.id,
      config: { ...CONFIG, botConfig: "not an object" },
    });
    expect(badConfig.status).toBe(400);

    const brokenJson = await submit(app, "{not json");
    expect(brokenJson.status).toBe(400);

    // The frozen table stays empty: a refused body froze nothing.
    const frozenRows = await database
      .select()
      .from(aiObservationExperiments)
      .where(eq(aiObservationExperiments.name, `${prefix}-exp-bad`));
    expect(frozenRows).toHaveLength(0);
  });

  test("an unknown dataset version is a 404, a frozen name with different content a 409", async () => {
    const version = await frozenVersion();
    const app = mountedApp();

    const unknownVersion = await submit(app, {
      name: `${prefix}-exp-404`,
      datasetVersionId: `version-${randomUUID()}`,
      config: CONFIG,
    });
    expect(unknownVersion.status).toBe(404);
    expect(await unknownVersion.json()).toEqual({
      error: "EXPERIMENT_DATASET_VERSION_NOT_FOUND",
    });

    const first = await experiments.submit(scopeA, {
      name: `${prefix}-exp-409`,
      datasetVersionId: version.id,
      config: CONFIG,
    });
    const different = await submit(app, {
      name: `${prefix}-exp-409`,
      datasetVersionId: version.id,
      config: { ...CONFIG, prompt: "A different prompt entirely." },
    });
    expect(different.status).toBe(409);
    expect(await different.json()).toEqual({
      error: "EXPERIMENT_STATE_INVALID",
    });
    expect(first.experiment.state).toBe("frozen");
  });

  test("a submit whose only conflict is the deletion window answers 409, never the bare 500 (OCR R3-26)", async () => {
    const version = await frozenVersion();
    const body = {
      name: `${prefix}-exp-r326`,
      datasetVersionId: version.id,
      config: CONFIG,
    };
    const app = mountedApp();
    const first = await submit(app, body);
    expect(first.status).toBe(200);
    const { experimentId } = (await first.json()) as { experimentId: string };
    // Retention finds the frozen experiment: the m138 readers answer empty but
    // the unique indexes still hold, so the retry must meet the domain 409
    // the page can render — the bare Error fall-through rode the classify
    // rethrow into a 500.
    await database.insert(aiObservationRetentionDeletions).values({
      id: randomUUID(),
      scopeKey: scopeA.key,
      actorId: scopeA.actorId,
      botId: scopeA.botId,
      kind: "experiment",
      targetId: experimentId,
      retentionDays: 30,
      state: "pending",
    });
    try {
      const retry = await submit(app, body);
      expect(retry.status).toBe(409);
      expect(((await retry.json()) as { error: string }).error).toBe(
        "EXPERIMENT_STATE_INVALID",
      );
    } finally {
      await database
        .delete(aiObservationRetentionDeletions)
        .where(eq(aiObservationRetentionDeletions.targetId, experimentId));
    }
  });

  test("a stranger is refused at the manage gate before anything else", async () => {
    const version = await frozenVersion();
    const app = mountedApp({ id: "user-stranger", role: "user" });

    const response = await submit(app, {
      name: `${prefix}-exp-stranger`,
      datasetVersionId: version.id,
      config: CONFIG,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: OBSERVATION_BOT_NOT_FOUND });
  });

  test("a budget-refused start answers 402, keeps the freeze, and a later funded retry replays it", async () => {
    const version = await frozenVersion();
    const refuse: ExecutionBudgetPrecheck = async () => ({
      allowed: false,
      reason: "no_spendable_credits",
    });
    const refusing = mountedApp({ id: scopeA.actorId, role: "user" }, refuse);

    const refused = await submit(refusing, {
      name: `${prefix}-exp-budget`,
      datasetVersionId: version.id,
      config: CONFIG,
    });
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({ error: "EXECUTION_BUDGET_REFUSED" });

    // The freeze is durable; the execution is not.
    const frozenRows = await database
      .select()
      .from(aiObservationExperiments)
      .where(eq(aiObservationExperiments.name, `${prefix}-exp-budget`));
    expect(frozenRows).toHaveLength(1);

    // The funded retry hits the same frozen experiment and starts what was refused.
    const funded = mountedApp();
    const retry = await submit(funded, {
      name: `${prefix}-exp-budget`,
      datasetVersionId: version.id,
      config: CONFIG,
    });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { replayed: boolean };
    expect(retryBody.replayed).toBe(true);
  });

  test("a deployment with no billing seam at all refuses the start fail-closed", async () => {
    const version = await frozenVersion();
    const app = mountedApp({ id: scopeA.actorId, role: "user" }, null);

    const response = await submit(app, {
      name: `${prefix}-exp-nobilling`,
      datasetVersionId: version.id,
      config: CONFIG,
    });
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({
      error: "EXECUTION_BUDGET_REFUSED",
    });
  });

  test("the production precheck seam: a funded deployment's submit starts, an unfunded one refuses 402", async () => {
    // The seam exactly as the production assembly builds it (the review-H1
    // guard's behavioral half): createExecutionBudgetPrecheck over the real
    // credit ledger, not a test stub. A funded deployment must get past the
    // gate; an unfunded one must refuse on the budget, not on a missing seam.
    const version = await frozenVersion();
    const funded = `${prefix}-funded`;
    await writer.grantCredits({
      externalCustomerId: funded,
      source: "promo",
      totalCents: 10_000,
      expiresAt: new Date(Date.now() + 86_400_000),
      idempotencyKey: `${funded}-g-${randomUUID().slice(0, 6)}`,
    });
    const app = mountedApp(
      { id: scopeA.actorId, role: "user" },
      createExecutionBudgetPrecheck({
        creditWriter: writer,
        externalCustomerId: funded,
      }),
    );

    const response = await submit(app, {
      name: `${prefix}-exp-funded`,
      datasetVersionId: version.id,
      config: CONFIG,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { executionId: string };
    expect(body.executionId).toBeTruthy();

    const unfunded = `${prefix}-unfunded`;
    const empty = mountedApp(
      { id: scopeA.actorId, role: "user" },
      createExecutionBudgetPrecheck({
        creditWriter: writer,
        externalCustomerId: unfunded,
      }),
    );
    const refused = await submit(empty, {
      name: `${prefix}-exp-unfunded`,
      datasetVersionId: version.id,
      config: CONFIG,
    });
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({
      error: "EXECUTION_BUDGET_REFUSED",
    });
  });
});

describe("POST .../experiments/:experimentId/executions/:executionId/cancel — the cancel face", () => {
  async function pendingExecution() {
    const version = await frozenVersion();
    const app = mountedApp();
    const response = await submit(app, {
      name: `${prefix}-exp-cancel-${randomUUID().slice(0, 8)}`,
      datasetVersionId: version.id,
      config: CONFIG,
    });
    const body = (await response.json()) as {
      experimentId: string;
      executionId: string;
    };
    return { app, ...body };
  }

  test("a pending execution cancels, settles cancelled, and leaves its trail", async () => {
    const { app, experimentId, executionId } = await pendingExecution();

    const response = await app.request(cancelUrl(experimentId, executionId), {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      executionId,
      state: "cancelled",
    });

    const rows = await executionRowsOf(experimentId);
    expect(rows[0]?.state).toBe("cancelled");
    expect(rows[0]?.settledAt).not.toBeNull();

    const trail = await auditRowsOf(
      "opik.experiment_execution_settled",
      executionId,
    );
    expect(trail).toHaveLength(1);
  });

  test("a terminal execution refuses the cancel with 409", async () => {
    const { app, experimentId, executionId } = await pendingExecution();
    // Settle it first (the store's own conditional cancel — terminal now).
    const settled = await executions.settleCancelled(executionId);
    expect(settled?.state).toBe("cancelled");

    const response = await app.request(cancelUrl(experimentId, executionId), {
      method: "POST",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "EXECUTION_STATE_INVALID" });
  });

  test("an execution that does not name the experiment is not found, so is a guessed id", async () => {
    const { app, experimentId, executionId } = await pendingExecution();

    const wrongExperiment = await app.request(
      cancelUrl(`experiment-${randomUUID()}`, executionId),
      { method: "POST" },
    );
    expect(wrongExperiment.status).toBe(404);
    expect(await wrongExperiment.json()).toEqual({
      error: "EXECUTION_EXPERIMENT_NOT_FOUND",
    });

    const guessed = await app.request(
      cancelUrl(experimentId, `execution-${randomUUID()}`),
      { method: "POST" },
    );
    expect(guessed.status).toBe(404);
  });

  test("a bumped ownership epoch makes the execution unreachable", async () => {
    const { experimentId, executionId } = await pendingExecution();
    // The epoch moved after the submission: the scope key differs, the row is gone.
    const scopeB = resolveObservationScope({
      actorId: scopeA.actorId,
      botId: scopeA.botId,
      ownership: "owner",
      epoch: 2,
    });
    const other = await executions.get(scopeB, executionId);
    expect(other).toBeNull();
    expect(experimentId).toBeTruthy();
  });
});
