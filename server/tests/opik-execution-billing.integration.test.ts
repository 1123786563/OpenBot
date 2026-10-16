import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TransactionSQL } from "bun";
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
import {
  createObservationExperimentStore,
  freezeExperimentConfig,
} from "../src/ai-observability/experiments";
import type { ModelSpanObservation } from "../src/ai-observability/model-span";
import { resolveObservationScope } from "../src/ai-observability/scope";
import { createAuditStore } from "../src/audit";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createCreditUsageTarget } from "../src/billing/usage-delivery";
import { createUsageOutbox } from "../src/billing/usage-outbox";
import type { BillingModelCreditPolicyEntry } from "../src/config";
import { createDatabase } from "../src/db/client";
import { aiObservationExperimentExecutions } from "../src/db/schema/ai-observability-executions";
import { billingCustomers } from "../src/db/schema/billing";
import { creditReservations } from "../src/db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { usageOutbox } from "../src/db/schema/usage-outbox";
import { workItems } from "../src/db/schema/work";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The billing wiring of evaluation calls against a real, dedicated PostgreSQL database
 * (Issue #31 / DAG T25): every evaluation model call rides the deployment's existing
 * credit machinery — reserve before the provider, exact-charge fact to the usage outbox,
 * settlement downstream through the same credits target the built-in path uses — and no
 * parallel billing exists. A balance that cannot cover the hold refuses BEFORE the gateway
 * is dialed; usage that never arrived is an unknown cost (hold retained, evidence row),
 * never a zero; a replayed or resumed settlement cannot double-charge. There is no skip
 * and no fallback database; a missing test database fails the run.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const outbox = createUsageOutbox(database);
const chargeCredits = createCreditUsageTarget(writer);
const prefix = `t25b-${randomUUID().slice(0, 8)}`;

const scope = resolveObservationScope({
  actorId: "user-a",
  botId: "agent-1",
  ownership: "owner",
  epoch: 1,
});

const configInput = {
  botConfig: {},
  prompt: "Answer the support question.",
  modelName: "gateway-model",
  modelParameters: { temperature: 0 },
  toolFixtures: {},
  judgeConfig: {},
  judgeVersion: "judge/1",
  readOnlyTools: [],
};

const frozen = freezeExperimentConfig(configInput);
const unpriced = freezeExperimentConfig({
  ...configInput,
  modelName: "unpriced-model",
});

const frozenCase: FrozenDatasetCase = {
  safeInput: { state: "projected", text: "Summarize the outage." },
  referenceOutput: { state: "projected", text: "A summary." },
  toolFixtures: { state: "projected", value: {} },
  sourceRunId: "run-1",
  sourceAttemptId: "attempt-1",
  sourceBindingId: null,
};

/**
 * The credit policy fixture: 1 scaled unit per input token, 2 per output token, a
 * 1000-unit worst-case hold. Ten input and twenty output tokens therefore charge
 * exactly 50 scaled units — a number every assertion below can name.
 */
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

const policy = new Map([["gateway-model", pricedModel]]);

/** One billed runner over a recording gateway; tests steer what the gateway answers. */
function billedRunner(input: {
  customer: string;
  answer?: { output: string };
  throws?: Error;
  policy?: ReadonlyMap<string, BillingModelCreditPolicyEntry>;
}) {
  const calls: Parameters<EvaluationModelCall>[0][] = [];
  const observations: ModelSpanObservation[] = [];
  const callModel = (async (request: Parameters<EvaluationModelCall>[0]) => {
    calls.push(request);
    if (input.throws) throw input.throws;
    if (input.answer) return input.answer;
    return { output: "the answer", inputTokens: 10, outputTokens: 20 };
  }) satisfies EvaluationModelCall;
  const runner = createBilledEvaluationCaseRunner({
    callModel,
    observe: (fact) => observations.push(fact),
    billing: {
      creditWriter: writer,
      outbox,
      policy: input.policy ?? policy,
      externalCustomerId: input.customer,
    },
  });
  return { runner, calls, observations };
}

function contextFor(
  executionId: string,
  caseIndex = 0,
  config = frozen,
): EvaluationCaseContext {
  return {
    executionId,
    experimentId: "experiment-1",
    caseIndex,
    frozenCase,
    config,
    scope,
    callTool: async () => ({ outcome: "refused", reason: "not_whitelisted" }),
  };
}

/** A live grant, so the customer exists and has spendable capacity. */
async function grant(customer: string, totalCents: number) {
  await writer.grantCredits({
    externalCustomerId: customer,
    source: "promo",
    totalCents,
    expiresAt: new Date(Date.now() + 86_400_000),
    idempotencyKey: `${customer}-g${totalCents}-${randomUUID().slice(0, 6)}`,
  });
}

const eventIdOf = (executionId: string, caseIndex: number) =>
  `opik-execution-case:${executionId}:${caseIndex}`;

const outboxRow = async (eventId: string) =>
  (
    await database
      .select()
      .from(usageOutbox)
      .where(eq(usageOutbox.eventId, eventId))
  )[0];

const reservationOf = async (eventId: string) =>
  (
    await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.idempotencyKey, `usage:${eventId}`))
  )[0];

const ledgerRowsOf = async (reservationId: string) =>
  database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.idempotencyKey, `reservation:${reservationId}`));

/**
 * The real downstream: settle this test's own charge rows through the credits target.
 * Named event ids only — the sweep test's executions carry generated UUID ids, so the
 * pending list can name rows an earlier run left behind on a reused database.
 */
async function deliverCharges(...eventIds: string[]) {
  for (const record of await outbox.pending(50)) {
    if (!record.reservationId || !eventIds.includes(record.eventId)) continue;
    await chargeCredits(record);
    await outbox.markCreditsDelivered(record.eventId);
  }
}

afterAll(async () => {
  // The whole evaluation event vocabulary is this suite's: the sweep test's executions
  // carry generated UUID ids no prefix reaches, and a row left pending on a reused
  // database would break the next run's delivery pass.
  await database
    .delete(usageOutbox)
    .where(like(usageOutbox.eventId, "opik-execution-case:%"));
  await database
    .delete(billingCustomers)
    .where(like(billingCustomers.externalId, `${prefix}%`));
  // The sweep test's opik rows, via the sanctioned flagged-cleanup route (T23's pattern).
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

test("an admitted case reserves before the call, records the exact charge fact, and settles through the real credits target", async () => {
  const customer = `${prefix}-happy`;
  await grant(customer, 10_000);
  const { runner, calls, observations } = billedRunner({ customer });
  const executionId = `${prefix}-exec-happy`;

  const outcome = await runner(contextFor(executionId));

  expect(outcome.status).toBe("completed");
  expect(outcome.detail).toMatchObject({
    output: "the answer",
    inputTokens: 10,
    outputTokens: 20,
  });
  expect(calls.length).toBe(1);
  expect(observations[0]?.ending).toEqual({
    kind: "succeeded",
    inputTokens: 10,
    outputTokens: 20,
  });

  // The charge fact carries the gateway's own usage, the reservation identity, the exact
  // rational cost, and the evaluation surface — the ledger's authority starts here.
  const eventId = eventIdOf(executionId, 0);
  const row = await outboxRow(eventId);
  expect(row).toMatchObject({
    source: "llm",
    client: "opik_evaluation",
    model: "gateway-model",
    inputTokens: 10,
    outputTokens: 20,
    actualCostNumerator: "50",
    actualCostDenominator: "1",
    botId: "agent-1",
    ownerUserId: "user-a",
  });
  const reservation = await reservationOf(eventId);
  expect(reservation?.status).toBe("reserved");
  expect(row?.reservationId).toBe(reservation?.id);

  // Downstream, through the same target the built-in path settles with.
  await deliverCharges(eventId);
  const settled = await reservationOf(eventId);
  expect(settled).toMatchObject({
    status: "settled",
    charged: 50,
    applied: 50,
  });
  const ledger = await ledgerRowsOf(settled?.id ?? "");
  expect(ledger.length).toBe(1);
  expect(ledger[0]).toMatchObject({
    credits: 50,
    applied: 50,
    client: "opik_evaluation",
  });
  const [grantRow] = await database
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.externalCustomerId, customer));
  expect(grantRow.used).toBe(50);
});

test("a balance that cannot cover the hold refuses before the gateway is dialed", async () => {
  const customer = `${prefix}-refused`;
  await grant(customer, 10); // live, but smaller than one call's 1000-unit worst case
  const { runner, calls, observations } = billedRunner({ customer });
  const executionId = `${prefix}-exec-refused`;

  const outcome = await runner(contextFor(executionId));

  expect(outcome.status).toBe("failed");
  expect(outcome.detail).toMatchObject({ reason: "budget_refused" });
  // The adversarial core: the gateway was never called, and nothing was held.
  expect(calls.length).toBe(0);
  expect(observations[0]?.ending).toEqual({
    kind: "refused",
    code: "budget_refused",
  });
  const eventId = eventIdOf(executionId, 0);
  expect(await reservationOf(eventId)).toBeUndefined();
  expect(await outboxRow(eventId)).toBeUndefined();
});

test("a case whose usage never arrived is an unknown cost, not a free one", async () => {
  const customer = `${prefix}-nomusage`;
  await grant(customer, 10_000);
  const { runner } = billedRunner({
    customer,
    answer: { output: "the answer" },
  });
  const executionId = `${prefix}-exec-nousage`;

  const outcome = await runner(contextFor(executionId));

  // The answer stands; the cost does not become zero.
  expect(outcome.status).toBe("completed");
  const eventId = eventIdOf(executionId, 0);
  const row = await outboxRow(eventId);
  expect(row).toMatchObject({
    status: "usage_missing",
    reservationId: null,
    inputTokens: 0,
    outputTokens: 0,
  });
  // The hold stays occupied: settlement is pending, not free.
  expect((await reservationOf(eventId))?.status).toBe("reserved");
  await deliverCharges(eventId);
  const [grantRow] = await database
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.externalCustomerId, customer));
  expect(grantRow.used).toBe(0);
});

test("a thrown gateway call is an unknown outcome, not a confirmed no-cost: the hold is retained", async () => {
  const customer = `${prefix}-error`;
  await grant(customer, 10_000);
  const { runner, calls } = billedRunner({
    customer,
    throws: new Error("gateway down"),
  });
  const executionId = `${prefix}-exec-error`;

  const outcome = await runner(contextFor(executionId));

  expect(outcome.status).toBe("failed");
  expect(calls.length).toBe(1);
  const eventId = eventIdOf(executionId, 0);
  const row = await outboxRow(eventId);
  expect(row).toMatchObject({ status: "provider_error", reservationId: null });
  // Retained, never released: a refusal the runner cannot observe is not a zero charge.
  expect((await reservationOf(eventId))?.status).toBe("reserved");
});

test("replaying a settled case cannot charge twice: re-admission refuses and settlement replays answer the first result", async () => {
  const customer = `${prefix}-replay`;
  await grant(customer, 10_000);
  const { runner, calls } = billedRunner({ customer });
  const executionId = `${prefix}-exec-replay`;
  const eventId = eventIdOf(executionId, 0);

  await runner(contextFor(executionId));
  await deliverCharges(eventId);
  const settled = await reservationOf(eventId);
  expect(settled?.status).toBe("settled");

  // A takeover-shaped re-run of the same case: the terminal reservation refuses admission,
  // the gateway is not dialed again, and nothing new is written.
  const replay = await runner(contextFor(executionId));
  expect(replay.status).toBe("failed");
  expect(calls.length).toBe(1);
  expect(await outboxRow(eventId)).toMatchObject({ actualCostNumerator: "50" });

  // A settlement replay through the real target answers the first result, not a second charge.
  const [record] = await database
    .select()
    .from(usageOutbox)
    .where(eq(usageOutbox.eventId, eventId));
  await chargeCredits(record);
  await chargeCredits(record);
  expect(await ledgerRowsOf(settled?.id ?? "")).toHaveLength(1);
  const still = await reservationOf(eventId);
  expect(still?.charged).toBe(50);
});

test("the start precheck refuses a deployment with nothing spendable and admits a live balance, fail-closed on gate failure", async () => {
  const broke = `${prefix}-broke`;
  const funded = `${prefix}-funded`;
  await grant(funded, 1_000);

  const precheck = createExecutionBudgetPrecheck({
    creditWriter: writer,
    externalCustomerId: broke,
  });
  expect(
    await precheck({
      actorId: scope.actorId,
      botId: scope.botId,
      experimentId: "e",
    }),
  ).toMatchObject({ allowed: false, reason: "no_spendable_credits" });

  const fundedCheck = createExecutionBudgetPrecheck({
    creditWriter: writer,
    externalCustomerId: funded,
  });
  expect(
    await fundedCheck({
      actorId: scope.actorId,
      botId: scope.botId,
      experimentId: "e",
    }),
  ).toEqual({ allowed: true });

  // A gate that cannot read the ledger refuses rather than admits.
  const broken = createExecutionBudgetPrecheck({
    creditWriter: {
      availableBalance: async () => {
        throw new Error("db down");
      },
    },
    externalCustomerId: funded,
  });
  expect(
    await broken({
      actorId: scope.actorId,
      botId: scope.botId,
      experimentId: "e",
    }),
  ).toMatchObject({ allowed: false, reason: "credit_gate_failed" });
});

test("a model with no configured price refuses before the call", async () => {
  const customer = `${prefix}-unpriced`;
  await grant(customer, 10_000);
  const { runner, calls } = billedRunner({ customer });
  const executionId = `${prefix}-exec-unpriced`;

  const outcome = await runner(contextFor(executionId, 0, unpriced));

  expect(outcome.status).toBe("failed");
  expect(calls.length).toBe(0);
  const eventId = eventIdOf(executionId, 0);
  expect(await reservationOf(eventId)).toBeUndefined();
  expect(await outboxRow(eventId)).toBeUndefined();
});

test("a swept execution runs its cases through the billed runner and a resume sweep charges nothing new", async () => {
  const customer = `${prefix}-sweep`;
  await grant(customer, 10_000);

  // The real pipeline: dataset version → frozen experiment → service start behind the
  // real precheck → the T24 worker with the billed runner as its case runner.
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
    config: configInput,
  });

  const service = createExperimentExecutionService({
    executions: executionsStore,
    billing: {
      precheck: createExecutionBudgetPrecheck({
        creditWriter: writer,
        externalCustomerId: customer,
      }),
    },
  });
  const execution = await service.start(scope, experiment.id);

  const { runner: runCase, calls } = billedRunner({ customer });
  const worker = createObservationExecutionWorker({
    database,
    audit,
    classify: () => "read",
    runCase,
    reauthorize: async () => scope,
    owner: `t25-owner-${randomUUID().slice(0, 8)}`,
  });
  await worker.sweep();

  const settled = await executionsStore.get(scope, execution.id);
  expect(settled?.state).toBe("completed");
  expect(calls.length).toBe(1);

  const eventId = eventIdOf(execution.id, 0);
  await deliverCharges(eventId);
  const reservation = await reservationOf(eventId);
  expect(reservation).toMatchObject({ status: "settled", charged: 50 });

  // A resume-shaped second sweep finds a settled execution and invents no new work.
  await worker.sweep();
  expect(calls.length).toBe(1);
  expect(await ledgerRowsOf(reservation?.id ?? "")).toHaveLength(1);
});
