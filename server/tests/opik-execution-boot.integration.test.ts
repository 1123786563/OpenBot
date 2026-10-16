import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TransactionSQL } from "bun";
import { eq } from "drizzle-orm";
import { createObservationDatasetStore } from "../src/ai-observability/datasets";
import { createExecutionBudgetPrecheck } from "../src/ai-observability/execution-billing";
import { createExperimentExecutionWorkerBoot } from "../src/ai-observability/execution-boot";
import type { EvaluationModelCall } from "../src/ai-observability/execution-runner";
import {
  createExperimentExecutionService,
  createObservationExecutionStore,
  EXECUTION_WORK_KIND,
} from "../src/ai-observability/executions";
import { createObservationExperimentStore } from "../src/ai-observability/experiments";
import { createExperimentResultService } from "../src/ai-observability/results";
import { resolveObservationScope } from "../src/ai-observability/scope";
import { JUDGE_SCORER_VERSION } from "../src/ai-observability/scoring/judge";
import { createAuditStore } from "../src/audit";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createCreditUsageTarget } from "../src/billing/usage-delivery";
import { createUsageOutbox } from "../src/billing/usage-outbox";
import type { BillingModelCreditPolicyEntry } from "../src/config";
import { createDatabase } from "../src/db/client";
import { aiObservationExperimentExecutions } from "../src/db/schema/ai-observability-executions";
import { usageOutbox } from "../src/db/schema/usage-outbox";
import { workItems } from "../src/db/schema/work";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The PRODUCTION experiment execution path, end to end (T-routes closure ticket,
 * Scope B evidence): the worker this boot assembles is the one production starts, and
 * its case runner IS the billed runner with the judge wrapped outside it. One swept
 * execution therefore leaves one billing settlement trajectory — reserve before the
 * call, exact charge fact to the usage outbox, settlement through the real credits
 * target — while the judge, wired from the deployment's entrance env, records its own
 * honest failure when its gateway is unreachable. Everything below is the real
 * pipeline on a real dedicated database; only the two model calls are fakes.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const outbox = createUsageOutbox(database);
const chargeCredits = createCreditUsageTarget(writer);
const audit = createAuditStore(database);
const prefix = `boot-${randomUUID().slice(0, 8)}`;

// A file-unique scope: the suite runs concurrently with the other opik files on one
// dedicated database, and a scope no other file writes keeps this file's rows out of
// every other file's window (and theirs out of this one's).
const scope = resolveObservationScope({
  actorId: "user-tr-boot",
  botId: "agent-tr-boot",
  ownership: "owner",
  epoch: 1,
});

const pricedModel: BillingModelCreditPolicyEntry = {
  input: {
    rate: { numerator: 1n, denominator: 1n },
    maximumTokens: 1000n,
    maximumCostUnits: 1000n,
  },
  output: {
    rate: { numerator: 2n, denominator: 1n },
    maximumTokens: 1000n,
    maximumCostUnits: 2000n,
  },
  maximumReservationUnits: 1000n,
};

const policy = new Map([
  ["gateway-model", pricedModel],
  ["judge-model", pricedModel],
]);

const configInput = {
  botConfig: {},
  prompt: "Answer the support question.",
  modelName: "gateway-model",
  modelParameters: { temperature: 0 },
  toolFixtures: {},
  judgeConfig: {
    judge: {
      entrance: "judge-main",
      rubric: "Score the answer's agreement with the reference, 0 to 1.",
    },
    rules: [{ id: "mentions-outage", kind: "contains", expected: "outage" }],
  },
  judgeVersion: JUDGE_SCORER_VERSION,
  readOnlyTools: [],
};

/** The production assembly over a recording gateway; the judge dials a dead port. */
function boot(input: {
  customer: string;
  env?: Record<string, string | undefined>;
}) {
  const calls: Parameters<EvaluationModelCall>[0][] = [];
  const callModel = (async (request) => {
    calls.push(request);
    return {
      output: "the answer with outage",
      inputTokens: 10,
      outputTokens: 20,
    };
  }) satisfies EvaluationModelCall;
  const worker = createExperimentExecutionWorkerBoot({
    database,
    audit,
    billing: {
      creditWriter: writer,
      outbox,
      policy,
      externalCustomerId: input.customer,
    },
    canManageBot: async () =>
      ({
        id: scope.botId,
        ownerUserId: scope.actorId,
        systemOwned: false,
        deletedAt: null,
      }) as never,
    scopeEpoch: async () => scope.epoch,
    resolveActor: async (actorId) =>
      actorId === scope.actorId ? { id: actorId, role: "user" as const } : null,
    env: {
      OPIK_JUDGE_ENTRANCES: JSON.stringify({
        // A port nothing listens on: the judge's honest failure, without a dial.
        "judge-main": {
          modelName: "judge-model",
          baseURL: "http://127.0.0.1:9",
        },
      }),
      ...input.env,
    },
    callModel,
    owner: `boot-owner-${randomUUID().slice(0, 8)}`,
  });
  return { worker, calls };
}

/** One frozen dataset version + experiment, and the execution the service started. */
async function submittedExecution(customer: string) {
  const datasets = createObservationDatasetStore(database);
  const experiments = createObservationExperimentStore(database);
  const executions = createObservationExecutionStore(database);
  const { version } = await datasets.saveVersion(scope, {
    datasetName: `${prefix}-ds-${randomUUID().slice(0, 8)}`,
    cases: [
      {
        input: "Summarize the outage.",
        referenceOutput: "A summary mentioning outage.",
        toolFixtures: {},
        sourceRunId: "run-1",
        sourceAttemptId: "attempt-1",
        sourceBindingId: null,
      },
    ],
  });
  const { experiment } = await experiments.submit(scope, {
    name: `${prefix}-exp-${randomUUID().slice(0, 8)}`,
    datasetVersionId: version.id,
    config: configInput,
  });
  const service = createExperimentExecutionService({
    executions,
    billing: {
      precheck: createExecutionBudgetPrecheck({
        creditWriter: writer,
        externalCustomerId: customer,
      }),
    },
  });
  return service.start(scope, experiment.id);
}

const eventIdOf = (executionId: string, caseIndex: number) =>
  `opik-execution-case:${executionId}:${caseIndex}`;

async function grant(customer: string, totalCents: number) {
  await writer.grantCredits({
    externalCustomerId: customer,
    source: "promo",
    totalCents,
    expiresAt: new Date(Date.now() + 86_400_000),
    idempotencyKey: `${customer}-g-${randomUUID().slice(0, 6)}`,
  });
}

afterEach(async () => {
  await database.delete(aiObservationExperimentExecutions);
  await database
    .delete(workItems)
    .where(eq(workItems.kind, EXECUTION_WORK_KIND));
  await database
    .delete(usageOutbox)
    .where(eq(usageOutbox.eventId, "opik-execution-case:%"));
  await database.$client.begin(async (tx: TransactionSQL) => {
    await tx`select set_config('ai_observation.experiment_cleanup', 'on', true)`;
    await tx`select set_config('ai_observation.dataset_cleanup', 'on', true)`;
    await tx`DELETE FROM ai_observation_experiments WHERE name LIKE ${`${prefix}%`}`;
    await tx`DELETE FROM ai_observation_datasets WHERE name LIKE ${`${prefix}%`}`;
  });
});

afterAll(async () => {
  await database
    .delete(usageOutbox)
    .where(eq(usageOutbox.client, "opik_evaluation"));
  await database.$client.close();
});

test("the production boot's sweep runs the billed runner: one reserve, one exact charge, one settled hold", {
  timeout: 30_000,
}, async () => {
  const customer = `${prefix}-billed`;
  await grant(customer, 10_000);
  const execution = await submittedExecution(customer);
  const { worker, calls } = boot({ customer });

  await worker.sweep();

  const rows = await database
    .select()
    .from(aiObservationExperimentExecutions)
    .where(eq(aiObservationExperimentExecutions.id, execution.id));
  expect(rows[0]?.state).toBe("completed");
  expect(calls).toHaveLength(1);

  // The billing trajectory: the reservation the admission took, and the exact charge
  // fact (10 input × 1 + 20 output × 2 = 50 scaled units) under the evaluation client.
  const eventId = eventIdOf(execution.id, 0);
  const [fact] = await database
    .select()
    .from(usageOutbox)
    .where(eq(usageOutbox.eventId, eventId));
  expect(fact).toMatchObject({
    client: "opik_evaluation",
    model: "gateway-model",
    inputTokens: 10,
    outputTokens: 20,
    reservationId: expect.any(String),
  });

  // Settlement downstream through the real credits target, like the built-in path.
  const pending = await outbox.pending(50);
  const record = pending.find((one) => one.eventId === eventId);
  expect(record).toBeDefined();
  if (record) {
    await chargeCredits(record);
    await outbox.markCreditsDelivered(record.eventId);
  }
  const reservations = await database
    .select()
    .from(
      (await import("../src/db/schema/credit-reservations")).creditReservations,
    )
    .where(
      eq(
        (await import("../src/db/schema/credit-reservations"))
          .creditReservations.idempotencyKey,
        `usage:${eventId}`,
      ),
    );
  expect(reservations[0]).toMatchObject({ status: "settled", charged: 50 });
});

test("the production boot's judge wiring loads from env and records its honest failure on the sample", {
  timeout: 30_000,
}, async () => {
  const customer = `${prefix}-judged`;
  await grant(customer, 10_000);
  const execution = await submittedExecution(customer);
  const { worker } = boot({ customer });

  await worker.sweep();

  const rows = await database
    .select()
    .from(aiObservationExperimentExecutions)
    .where(eq(aiObservationExperimentExecutions.id, execution.id));
  expect(rows[0]?.state).toBe("completed");

  // Through the T28 read side — the face a consumer actually sees: the judge record
  // rode the landing channel from the entrance env the boot loaded, and its failure
  // is a recorded fact beside the rule score.
  const experiments = createObservationExperimentStore(database);
  const report = await createExperimentResultService({
    experiments,
    executions: createObservationExecutionStore(database),
    datasets: createObservationDatasetStore(database),
    ticket: async () => null,
  }).query(scope, {
    experimentId: execution.experimentId,
    executionId: execution.id,
  });
  expect(report.samples[0]?.class).toBe("scored");
  const judge = report.samples[0]?.judge as {
    status?: string;
    code?: string;
  } | null;
  expect(judge).toBeDefined();
  expect(judge?.status).toBe("failed");
  expect(judge?.code).toBe("JUDGE_CALL_FAILED");
});
