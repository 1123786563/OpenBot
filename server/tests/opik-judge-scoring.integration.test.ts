import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import type { TransactionSQL } from "../../tests/support/bun-compat";
import { eq, like } from "drizzle-orm";
import type { FrozenDatasetCase } from "../src/ai-observability/datasets";
import { createObservationDatasetStore } from "../src/ai-observability/datasets";
import {
  createBilledEvaluationCaseRunner,
  createExecutionBudgetPrecheck,
} from "../src/ai-observability/execution-billing";
import type { EvaluationModelCall } from "../src/ai-observability/execution-runner";
import {
  createExperimentExecutionService,
  createObservationExecutionStore,
  createObservationExecutionWorker,
  EXECUTION_WORK_KIND,
} from "../src/ai-observability/executions";
import { createObservationExperimentStore } from "../src/ai-observability/experiments";
import { createExperimentResultService } from "../src/ai-observability/results";
import { resolveObservationScope } from "../src/ai-observability/scope";
import {
  createJudgeScorer,
  createJudgeScoringCaseRunner,
  JUDGE_SCORER_VERSION,
  judgeCaseUsageId,
} from "../src/ai-observability/scoring/judge";
import { createAuditStore } from "../src/audit";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createCreditUsageTarget } from "../src/billing/usage-delivery";
import { createUsageOutbox } from "../src/billing/usage-outbox";
import type { BillingModelCreditPolicyEntry } from "../src/config";
import { createDatabase } from "../src/db/client";
import { aiObservationExperimentExecutions } from "../src/db/schema/ai-observability-executions";
import { billingCustomers } from "../src/db/schema/billing";
import { creditReservations } from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { usageOutbox } from "../src/db/schema/usage-outbox";
import { workItems } from "../src/db/schema/work";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The judge over a real, dedicated PostgreSQL database (Issue #33 / DAG T27): one frozen
 * experiment with an enabled judge, the real worker pipeline, a controlled fake provider
 * standing in for the approved entrance — and the deployment's one credit machinery
 * answering for both the evaluated call and the judge call. The gates are proven with
 * counted provider calls and ledger rows, never with the score the provider returned.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const outbox = createUsageOutbox(database);
const chargeCredits = createCreditUsageTarget(writer);
const prefix = `t27j-${randomUUID().slice(0, 8)}`;

const scope = resolveObservationScope({
  actorId: "user-a",
  botId: "agent-1",
  ownership: "owner",
  epoch: 1,
});

const VERDICT = JSON.stringify({
  score: 0.9,
  rationale: "Covers the outage summary accurately.",
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

/** The judge model with a hold no thin balance can cover — the mid-run refusal fixture. */
const hugeJudgeHold: BillingModelCreditPolicyEntry = {
  ...pricedModel,
  maximumReservationUnits: 5000n,
};

const policy = new Map([
  ["gateway-model", pricedModel],
  ["judge-model", pricedModel],
]);

const entrances = new Map([["approved", { modelName: "judge-model" }]]);

/** One experiment configuration as the submitter composes it. */
const configInput = (
  entrance = "approved",
  rules: readonly unknown[] = [],
) => ({
  botConfig: {},
  prompt: "Answer the support question.",
  modelName: "gateway-model",
  modelParameters: { temperature: 0 },
  toolFixtures: {},
  judgeConfig: {
    judge: {
      entrance,
      rubric: "Score the answer's agreement with the reference, 0 to 1.",
    },
    ...(rules.length > 0 ? { rules } : {}),
  },
  judgeVersion: JUDGE_SCORER_VERSION,
  readOnlyTools: [],
});

const _frozenCase: FrozenDatasetCase = {
  safeInput: { state: "projected", text: "Summarize the outage." },
  referenceOutput: { state: "projected", text: "A summary." },
  toolFixtures: { state: "projected", value: {} },
  sourceRunId: "run-1",
  sourceAttemptId: "attempt-1",
  sourceBindingId: null,
};

/** The controlled fake providers: the evaluated gateway and the approved judge entrance. */
function fakeProviders(judgeAnswer: {
  output: string;
  inputTokens?: number;
  outputTokens?: number;
}) {
  const evalCalls: Parameters<EvaluationModelCall>[0][] = [];
  const judgeCalls: Parameters<EvaluationModelCall>[0][] = [];
  const callEval = async (request: Parameters<EvaluationModelCall>[0]) => {
    evalCalls.push(request);
    return { output: "the answer", inputTokens: 10, outputTokens: 20 };
  };
  const callJudge = async (request: Parameters<EvaluationModelCall>[0]) => {
    judgeCalls.push(request);
    return judgeAnswer;
  };
  return { evalCalls, judgeCalls, callEval, callJudge };
}

async function grant(customer: string, totalCents: number) {
  await writer.grantCredits({
    externalCustomerId: customer,
    source: "promo",
    totalCents,
    expiresAt: new Date(Date.now() + 86_400_000),
    idempotencyKey: `${customer}-g${totalCents}-${randomUUID().slice(0, 6)}`,
  });
}

const reservationOf = async (eventId: string) =>
  (
    await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.idempotencyKey, `usage:${eventId}`))
  )[0];

const outboxRow = async (eventId: string) =>
  (
    await database
      .select()
      .from(usageOutbox)
      .where(eq(usageOutbox.eventId, eventId))
  )[0];

/** The real downstream, for this test's own charge rows only (T25's discipline). */
async function deliverCharges(...eventIds: string[]) {
  for (const record of await outbox.pending(50)) {
    if (!record.reservationId || !eventIds.includes(record.eventId)) continue;
    await chargeCredits(record);
    await outbox.markCreditsDelivered(record.eventId);
  }
}

/**
 * The real pipeline with a judge in the case-runner chain: dataset version → frozen
 * experiment → service start behind the real precheck → the T24 worker whose runCase is
 * the T25 billed runner wrapped by the judge wrapper.
 */
async function sweepWithJudge(input: {
  customer: string;
  judgeAnswer: { output: string; inputTokens?: number; outputTokens?: number };
  entrance?: string;
  judgePolicy?: ReadonlyMap<string, BillingModelCreditPolicyEntry>;
  rules?: readonly unknown[];
}) {
  const providers = fakeProviders(input.judgeAnswer);
  const datasets = createObservationDatasetStore(database);
  const experiments = createObservationExperimentStore(database);
  const executionsStore = createObservationExecutionStore(database);
  const audit = createAuditStore(database);

  const { version } = await datasets.saveVersion(scope, {
    datasetName: `${prefix}-ds-${randomUUID().slice(0, 8)}`,
    cases: [
      {
        input: "Summarize the outage.",
        referenceOutput: "A summary.",
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
    config: configInput(input.entrance, input.rules),
  });

  const service = createExperimentExecutionService({
    executions: executionsStore,
    billing: {
      precheck: createExecutionBudgetPrecheck({
        creditWriter: writer,
        externalCustomerId: input.customer,
      }),
    },
  });
  const execution = await service.start(scope, experiment.id);

  const judge = createJudgeScorer({
    callModel: providers.callJudge,
    admission: {
      entrances,
      approvedVersions: new Set([JUDGE_SCORER_VERSION]),
      policy: input.judgePolicy ?? policy,
    },
    billing: {
      creditWriter: writer,
      outbox,
      externalCustomerId: input.customer,
    },
  });
  const billed = createBilledEvaluationCaseRunner({
    callModel: providers.callEval,
    billing: {
      creditWriter: writer,
      outbox,
      policy,
      externalCustomerId: input.customer,
    },
  });
  const worker = createObservationExecutionWorker({
    database,
    audit,
    classify: () => "read",
    runCase: createJudgeScoringCaseRunner({ inner: billed, judge }),
    reauthorize: async () => scope,
    owner: `t27-owner-${randomUUID().slice(0, 8)}`,
  });
  await worker.sweep();

  const settled = await executionsStore.get(scope, execution.id);
  const outcomes = await executionsStore.caseOutcomes(execution.id);
  return { execution, experiment, settled, outcomes, providers, datasets };
}

/**
 * One per-field envelope out of the case row's stored detail (T28's contract: output,
 * usage and judge each carry their own projection budget) — the projected form T28 reads.
 */
function fieldEnvelope(detail: unknown, key: string): unknown {
  return (detail as Record<string, unknown> | null)?.[key];
}

afterAll(async () => {
  // Both event vocabularies are this suite's; a row left pending on a reused database
  // would break the next run's delivery pass.
  for (const namespace of ["opik-judge-case:%", "opik-execution-case:%"]) {
    await database
      .delete(usageOutbox)
      .where(like(usageOutbox.eventId, namespace));
  }
  await database
    .delete(billingCustomers)
    .where(like(billingCustomers.externalId, `${prefix}%`));
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
  await database.$client.close();
});

test("a swept experiment judges each completed case and both charges settle through the real credits target", async () => {
  const customer = `${prefix}-sweep`;
  await grant(customer, 20_000);

  const { settled, outcomes, providers } = await sweepWithJudge({
    customer,
    judgeAnswer: { output: VERDICT, inputTokens: 12, outputTokens: 34 },
  });

  expect(settled?.state).toBe("completed");
  // Call counts: one evaluated call, one judge call — and never more, sweep again or not.
  expect(providers.evalCalls).toHaveLength(1);
  expect(providers.judgeCalls).toHaveLength(1);
  expect(providers.judgeCalls[0]?.modelName).toBe("judge-model");

  // The per-sample record survived storage: score, version, usage, rationale — the
  // projected detail envelope T28 reads.
  const judge = fieldEnvelope(outcomes[0]?.detail, "judge");
  expect(judge).toMatchObject({
    state: "projected",
    value: {
      status: { state: "projected", value: "scored" },
      score: { state: "projected", value: 0.9 },
      scorerVersion: { state: "projected", value: JUDGE_SCORER_VERSION },
      entranceId: { state: "projected", value: "approved" },
      usage: {
        state: "projected",
        value: {
          inputTokens: { state: "projected", value: 12 },
          outputTokens: { state: "projected", value: 34 },
        },
      },
    },
  });

  // Two facts, two holds, one ledger each: the evaluated call and the judge call are
  // separate reservations under the same credits machinery.
  const evalEvent = `opik-execution-case:${settled?.id}:0`;
  const judgeEvent = judgeCaseUsageId(settled?.id ?? "", 0);
  await deliverCharges(evalEvent, judgeEvent);
  expect(await reservationOf(evalEvent)).toMatchObject({
    status: "settled",
    charged: 50,
  });
  expect(await reservationOf(judgeEvent)).toMatchObject({
    status: "settled",
    charged: 80,
  });
  const judgeReservation = await reservationOf(judgeEvent);
  const ledger = await database
    .select()
    .from(creditLedger)
    .where(
      eq(creditLedger.idempotencyKey, `reservation:${judgeReservation?.id}`),
    );
  expect(ledger).toHaveLength(1);
});

test("an entrance the deployment never approved leaves the execution complete and the judge silent", async () => {
  const customer = `${prefix}-unapproved`;
  await grant(customer, 20_000);

  const { settled, outcomes, providers } = await sweepWithJudge({
    customer,
    judgeAnswer: { output: VERDICT, inputTokens: 12, outputTokens: 34 },
    entrance: "not-approved",
  });

  expect(settled?.state).toBe("completed");
  // Zero judge dials, zero judge reservations — the gate is upstream of everything.
  expect(providers.judgeCalls).toHaveLength(0);
  expect(providers.evalCalls).toHaveLength(1);
  expect(
    await reservationOf(judgeCaseUsageId(settled?.id ?? "", 0)),
  ).toBeUndefined();

  const judge = fieldEnvelope(outcomes[0]?.detail, "judge");
  expect(judge).toMatchObject({
    state: "projected",
    value: {
      status: { state: "projected", value: "failed" },
      code: {
        state: "projected",
        value: "JUDGE_ENTRANCE_NOT_APPROVED",
      },
    },
  });
});

test("a judge verdict without usage keeps the hold occupied with an evidence row, and the score alone settles nothing", async () => {
  const customer = `${prefix}-usageless`;
  await grant(customer, 20_000);

  const { settled, outcomes } = await sweepWithJudge({
    customer,
    judgeAnswer: { output: VERDICT }, // a score, but no usage report
  });

  const judgeEvent = judgeCaseUsageId(settled?.id ?? "", 0);
  const reservation = await reservationOf(judgeEvent);
  expect(reservation).toMatchObject({ status: "reserved" });

  const evidence = await outboxRow(judgeEvent);
  expect(evidence?.reservationId).toBeNull();
  expect(evidence?.status).toBe("usage_missing");

  const judge = fieldEnvelope(outcomes[0]?.detail, "judge");
  expect(judge).toMatchObject({
    state: "projected",
    value: {
      status: { state: "projected", value: "scored" },
      usage: {
        state: "projected",
        value: { usageUnknown: { state: "projected", value: true } },
      },
    },
  });
});

test("a judge hold the balance cannot cover refuses before the dial while the evaluated call still runs and settles", async () => {
  const customer = `${prefix}-thin`;
  await grant(customer, 1500); // covers the evaluated hold, never the 5000-unit judge hold

  const { settled, outcomes, providers } = await sweepWithJudge({
    customer,
    judgeAnswer: { output: VERDICT, inputTokens: 12, outputTokens: 34 },
    judgePolicy: new Map([["judge-model", hugeJudgeHold]]),
  });

  expect(settled?.state).toBe("completed");
  expect(providers.evalCalls).toHaveLength(1);
  expect(providers.judgeCalls).toHaveLength(0);

  const judge = fieldEnvelope(outcomes[0]?.detail, "judge");
  expect(judge).toMatchObject({
    state: "projected",
    value: {
      status: { state: "projected", value: "failed" },
      code: { state: "projected", value: "JUDGE_BUDGET_REFUSED" },
    },
  });

  // The evaluated call's own billing is untouched by the judge's refusal: it settles.
  const evalEvent = `opik-execution-case:${settled?.id}:0`;
  await deliverCharges(evalEvent);
  expect(await reservationOf(evalEvent)).toMatchObject({
    status: "settled",
    charged: 50,
  });
});

test("the judge record survives the whole landing channel: outcome row, settle contract, results read", async () => {
  const customer = `${prefix}-landing`;
  await grant(customer, 20_000);

  const { experiment, execution, settled, outcomes, datasets } =
    await sweepWithJudge({
      customer,
      judgeAnswer: { output: VERDICT, inputTokens: 12, outputTokens: 34 },
      // One rule the evaluated output passes, so the sample is scored — the judge
      // record rides beside the rule score on the same frozen set (A7).
      rules: [{ id: "mentions", kind: "contains", expected: "answer" }],
    });

  expect(settled?.state).toBe("completed");

  // 1. The write-ahead row: T28's per-field contract — the case's own output and
  //    usage beside the judge record, each with its own projection envelope.
  const detail = outcomes[0]?.detail as Record<string, unknown>;
  expect(detail?.output).toEqual({
    state: "projected",
    text: "the answer",
  });
  expect(detail?.usage).toEqual({
    state: "projected",
    value: {
      inputTokens: { state: "projected", value: 10 },
      outputTokens: { state: "projected", value: 20 },
    },
  });
  expect(detail?.judge).toMatchObject({
    state: "projected",
    value: {
      status: { state: "projected", value: "scored" },
      score: { state: "projected", value: 0.9 },
      scorerVersion: { state: "projected", value: JUDGE_SCORER_VERSION },
      entranceId: { state: "projected", value: "approved" },
      usage: {
        state: "projected",
        value: {
          inputTokens: { state: "projected", value: 12 },
          outputTokens: { state: "projected", value: 34 },
        },
      },
      // The rationale reaches the store as an already-projected SafeText riding the
      // fixture projection — its envelope wrapped as a value, one budget deep.
      rationale: {
        state: "projected",
        value: {
          state: { state: "projected", value: "projected" },
          text: {
            state: "projected",
            value: "Covers the outage summary accurately.",
          },
        },
      },
    },
  });

  // 2. The settle contract: settleCompletedFromOutcomes embeds the stored judge
  //    envelope as-is — the record is in the result the read side consumes, which
  //    is exactly the landing the old `{status, detail}` shape silently lost.
  const settledCases = ((settled?.result as { cases?: unknown[] } | null)
    ?.cases ?? []) as Record<string, unknown>[];
  expect(settledCases[0]?.judge).toEqual(detail?.judge);

  // 3. The results read (T28): plain JSON on the sample — the rule score and the
  //    judge's own score/rationale/usage are separate facts, both consumable.
  const results = createExperimentResultService({
    experiments: createObservationExperimentStore(database),
    executions: createObservationExecutionStore(database),
    datasets,
    ticket: async () => null,
  });
  const report = await results.query(scope, {
    experimentId: experiment.id,
    executionId: execution.id,
  });
  expect(report.samples).toHaveLength(1);
  const sample = report.samples[0];
  expect(sample.class).toBe("scored");
  expect(sample.score).toBe(1);
  expect(sample.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  expect(sample.judge).toEqual({
    status: "scored",
    score: 0.9,
    // The rationale's own envelope survives the deep unwrap — a projected SafeText
    // answers its {state, text}, exactly as the record minted it.
    rationale: {
      state: "projected",
      text: "Covers the outage summary accurately.",
    },
    scorerVersion: JUDGE_SCORER_VERSION,
    entranceId: "approved",
    usage: { inputTokens: 12, outputTokens: 34 },
  });
});
