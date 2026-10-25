import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import type { FrozenDatasetCase } from "../src/ai-observability/datasets";
import { createObservationDatasetStore } from "../src/ai-observability/datasets";
import {
  createBilledEvaluationCaseRunner,
  createExecutionBudgetPrecheck,
  evaluationCaseStepUsageId,
} from "../src/ai-observability/execution-billing";
import {
  createGatewayModelCall,
  type EvaluationModelCall,
} from "../src/ai-observability/execution-runner";
import { createPublicExecutionSeamModelCall } from "../src/ai-observability/execution-seam";
import {
  createEvaluationToolGate,
  createExperimentExecutionService,
  createObservationExecutionStore,
  createObservationExecutionWorker,
  type EvaluationCaseContext,
  type EvaluationToolSurface,
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

/**
 * The execution rows this suite actually enqueues (the sweep test); every other test
 * drives a runner directly over a synthetic execution id and writes no row. The
 * cleanup narrows to exactly these (T25-rev L-4) — a shared database would no longer
 * lose other suites' rows to this suite's afterAll.
 */
const sweepExecutionIds: string[] = [];

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
  // The sweep test's own rows, by id — no full-table sweep, no other suite's rows.
  for (const id of sweepExecutionIds) {
    await database
      .delete(aiObservationExperimentExecutions)
      .where(eq(aiObservationExperimentExecutions.id, id));
    await database
      .delete(workItems)
      .where(
        and(eq(workItems.kind, EXECUTION_WORK_KIND), eq(workItems.key, id)),
      );
  }
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
  expect(outcome.output).toBe("the answer");
  expect(outcome.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
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
  // The adversarial core: the gateway was never called, and nothing was held.
  expect(calls.length).toBe(0);
  // T25-rev L-1: the admission's own reason rides the span, not a collapsed word.
  expect(observations[0]?.ending).toEqual({
    kind: "refused",
    code: "credits_exhausted",
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

test("the usage fact's occurredAt is the call's start, not the settlement moment (T25-rev L-3)", async () => {
  const customer = `${prefix}-clock`;
  await grant(customer, 10_000);
  const callStarts: number[] = [];
  const callModel = (async () => {
    callStarts.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { output: "the answer", inputTokens: 10, outputTokens: 20 };
  }) satisfies EvaluationModelCall;
  const occurredAts: number[] = [];
  const runner = createBilledEvaluationCaseRunner({
    callModel,
    billing: {
      creditWriter: writer,
      // A recording wrapper around the real outbox: the fact's timestamp is the
      // assertion target, the row still lands for real.
      outbox: {
        record: async (fact) => {
          occurredAts.push(fact.occurredAt.getTime());
          return outbox.record(fact);
        },
      },
      policy,
      externalCustomerId: customer,
    },
  });

  await runner(contextFor(`${prefix}-exec-clock`));

  expect(callStarts).toHaveLength(1);
  expect(occurredAts).toHaveLength(1);
  // The built-in gate meters from the call's start; the evaluation wiring says the
  // same thing: the timestamp names when the call happened, not when it settled.
  expect(occurredAts[0]).toBeLessThanOrEqual((callStarts[0] ?? 0) + 5);
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
  sweepExecutionIds.push(execution.id);

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

/*
 * FREV-R2-01: one case with a tool surface is up to
 * `EVALUATION_TOOL_LOOP_MAX_STEPS` provider calls, and a case-level hold priced for a
 * single call cannot bound that spend. These tests drive the REAL gateway adapter
 * against a scripted OpenAI-compatible upstream (no mocked fetch, no paid request) and
 * the REAL credit writer and outbox: every step is admitted before it is dialed, a
 * step nobody can fund never reaches the wire, and every step that ran settles against
 * the hold that admitted it.
 */

/** One scripted upstream round: prompt/completion counts the wire will report. */
const roundUsage = (usage: { input: number; output: number }) => ({
  prompt_tokens: usage.input,
  completion_tokens: usage.output,
  total_tokens: usage.input + usage.output,
});

function completion(
  message: Record<string, unknown>,
  finish: string,
  usage: { input: number; output: number },
) {
  return Response.json({
    id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
    object: "chat.completion",
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: roundUsage(usage),
  });
}

/** One round that answers with a tool call the model "made". */
const toolCallRound =
  (usage: { input: number; output: number }) => (): Response =>
    completion(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "search", arguments: '{"q":"outage"}' },
          },
        ],
      },
      "tool_calls",
      usage,
    );

/** One round that answers with plain text. */
const answerRound =
  (text: string, usage: { input: number; output: number }) => (): Response =>
    completion({ role: "assistant", content: text }, "stop", usage);

/**
 * A scripted upstream: rounds are consumed in order (the last repeats), every request
 * body is kept, and `when(n)` resolves once n requests have arrived.
 */
function scriptedGateway(rounds: (() => Response | Promise<Response>)[]) {
  const bodies: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      bodies.push(body);
      for (const wake of waiters.splice(0)) wake();
      const round = rounds[Math.min(bodies.length - 1, rounds.length - 1)];
      return round === undefined
        ? new Response(null, { status: 500 })
        : round();
    },
  });
  const when = (count: number) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (bodies.length >= count) resolve();
        else waiters.push(check);
      };
      check();
    });
  return { port: server.port, bodies, when, stop: () => server.stop(true) };
}

/**
 * The single-call ceiling the finding's counterexample is written against: N = 1000
 * output tokens at 2 units each, 1000 input tokens at 1, so one call's worst-case hold
 * (`maximumReservationUnits`) is 3000 units. Two steps of 0.6N output each (600) are
 * EACH inside the single call's own ceiling and together are not — exactly the shape
 * the old one-hold settlement discovered only after both calls had been paid for.
 */
const stepPolicy: BillingModelCreditPolicyEntry = {
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
  maximumReservationUnits: 3000n,
};
const stepPolicies = new Map([["gateway-model", stepPolicy]]);

/** The same frozen case, with one whitelisted read tool the model can reach for. */
const toolConfig = freezeExperimentConfig({
  ...configInput,
  readOnlyTools: ["search"],
  toolFixtures: { search: { summary: "three regions of impact" } },
});

/**
 * One tool-declaring case context, wired through the real gate so the loop's tool call
 * answers with the replayed frozen fixture — the same chain the runner suite proves.
 */
const toolContextFor = (
  executionId: string,
  signal?: AbortSignal,
): EvaluationCaseContext => {
  const gate = createEvaluationToolGate(toolConfig, () => "read");
  return {
    ...contextFor(executionId, 0, toolConfig),
    callTool: async (name) =>
      gate.call(name, [frozenCase.toolFixtures, toolConfig.toolFixtures]),
    resolveToolSurface: (name): EvaluationToolSurface | undefined =>
      name === "search"
        ? {
            description: "Search the support knowledge base.",
            parameters: {
              type: "object",
              properties: { q: { type: "string" } },
              required: ["q"],
            },
            effect: "read",
          }
        : undefined,
    ...(signal === undefined ? {} : { signal }),
  };
};

/** A billed runner over the real gateway adapter pointed at the script. */
function gatewayRunner(input: {
  customer: string;
  baseURL: string;
  observations?: ModelSpanObservation[];
  timeoutMs?: number;
}) {
  return createBilledEvaluationCaseRunner({
    callModel: createGatewayModelCall({
      apiKey: "test-key",
      baseURL: input.baseURL,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    }),
    ...(input.observations === undefined
      ? {}
      : {
          observe: (fact: ModelSpanObservation) =>
            input.observations?.push(fact),
        }),
    billing: {
      creditWriter: writer,
      outbox,
      policy: stepPolicies,
      externalCustomerId: input.customer,
    },
  });
}

test("the loop's next step is refused BEFORE its request when its hold is not spendable (FREV-R2-01)", async () => {
  const customer = `${prefix}-loop-refused`;
  // Exactly ONE call's worst-case hold: the case may start, and the loop's second
  // provider call cannot be covered. The old wiring found this out at settlement —
  // `usage_over_token_max` after both calls had already been paid for.
  await grant(customer, 3_000);
  const gateway = scriptedGateway([
    toolCallRound({ input: 100, output: 600 }),
    answerRound("the outage reached three regions", {
      input: 150,
      output: 600,
    }),
  ]);
  try {
    const executionId = `${prefix}-exec-loop-refused`;
    const observations: ModelSpanObservation[] = [];
    const runner = gatewayRunner({
      customer,
      baseURL: `http://127.0.0.1:${gateway.port}/v1`,
      observations,
    });

    const outcome = await runner(toolContextFor(executionId));

    // The adversarial core: the second provider request never reached the wire, and
    // the case says why instead of throwing after the spend.
    expect(gateway.bodies.length).toBe(1);
    expect(outcome).toEqual({ status: "failed", reason: "credits_exhausted" });
    expect(observations[0]?.ending).toEqual({
      kind: "refused",
      code: "credits_exhausted",
    });

    // The step that DID run is settled exactly against the hold that admitted it.
    const eventId = eventIdOf(executionId, 0);
    const row = await outboxRow(eventId);
    expect(row).toMatchObject({
      inputTokens: 100,
      outputTokens: 600,
      actualCostNumerator: "1300",
      actualCostDenominator: "1",
    });
    expect(row?.reservationId).toBe((await reservationOf(eventId))?.id);

    // The refused step left no hold and no fact behind — nothing was spent for it.
    const refusedStepEvent = evaluationCaseStepUsageId(executionId, 0, 1);
    expect(await outboxRow(refusedStepEvent)).toBeUndefined();
    expect(
      (
        await database
          .select()
          .from(creditReservations)
          .where(
            eq(creditReservations.idempotencyKey, `usage:${refusedStepEvent}`),
          )
      )[0],
    ).toBeUndefined();

    // The step's request carried the policy's own output ceiling — the bound the
    // step's hold prices, applied on the wire before the provider can exceed it.
    expect(gateway.bodies[0]).toMatchObject({ max_tokens: 1000 });
  } finally {
    gateway.stop();
  }
});

test("a two-step loop admits each step, settles each against its own hold, and charges exactly what it spent (FREV-R2-01)", async () => {
  const customer = `${prefix}-loop-two`;
  await grant(customer, 10_000);
  const gateway = scriptedGateway([
    toolCallRound({ input: 100, output: 600 }),
    answerRound("the outage reached three regions", {
      input: 150,
      output: 300,
    }),
  ]);
  try {
    const executionId = `${prefix}-exec-loop-two`;
    const runner = gatewayRunner({
      customer,
      baseURL: `http://127.0.0.1:${gateway.port}/v1`,
    });

    const outcome = await runner(toolContextFor(executionId));

    // Both steps were dialed, and the loop's answer is the case's answer.
    expect(gateway.bodies.length).toBe(2);
    expect(outcome.status).toBe("completed");
    expect(outcome.output).toBe("the outage reached three regions");
    expect(outcome.usage).toEqual({ inputTokens: 250, outputTokens: 900 });
    // The second request carries the replayed frozen fixture as the tool result.
    expect(JSON.stringify(gateway.bodies[1])).toContain(
      "three regions of impact",
    );

    // One immutable fact per step, each under its own natural key and its own hold.
    const eventId = eventIdOf(executionId, 0);
    const secondEventId = evaluationCaseStepUsageId(executionId, 0, 1);
    const firstFact = await outboxRow(eventId);
    const secondFact = await outboxRow(secondEventId);
    expect(firstFact).toMatchObject({
      inputTokens: 100,
      outputTokens: 600,
      actualCostNumerator: "1300",
    });
    expect(secondFact).toMatchObject({
      inputTokens: 150,
      outputTokens: 300,
      actualCostNumerator: "750",
    });
    const firstHold = await reservationOf(eventId);
    const secondHold = await reservationOf(secondEventId);
    expect(firstFact?.reservationId).toBe(firstHold?.id);
    expect(secondFact?.reservationId).toBe(secondHold?.id);
    expect(firstHold?.id).not.toBe(secondHold?.id);

    // Downstream through the same credits target the built-in path settles with:
    // each hold settles its own step, and the grant pays exactly the sum.
    await deliverCharges(eventId, secondEventId);
    expect(await reservationOf(eventId)).toMatchObject({
      status: "settled",
      charged: 1300,
      applied: 1300,
    });
    expect(await reservationOf(secondEventId)).toMatchObject({
      status: "settled",
      charged: 750,
      applied: 750,
    });
    const [grantRow] = await database
      .select()
      .from(creditGrants)
      .where(eq(creditGrants.externalCustomerId, customer));
    expect(grantRow.used).toBe(2050);
  } finally {
    gateway.stop();
  }
});

test("a loop cancelled between steps charges what ran and keeps the interrupted step's hold (FREV-R2-01)", async () => {
  const customer = `${prefix}-loop-cancel`;
  await grant(customer, 10_000);
  const hanging = () => new Promise<Response>(() => {});
  const gateway = scriptedGateway([
    toolCallRound({ input: 100, output: 600 }),
    hanging,
  ]);
  try {
    const executionId = `${prefix}-exec-loop-cancel`;
    const controller = new AbortController();
    const runner = gatewayRunner({
      customer,
      baseURL: `http://127.0.0.1:${gateway.port}/v1`,
      timeoutMs: 5_000,
    });

    const run = runner(toolContextFor(executionId, controller.signal));
    await gateway.when(2);
    controller.abort();
    const outcome = await run;

    expect(outcome).toEqual({ status: "failed", reason: "cancelled" });
    expect(gateway.bodies.length).toBe(2);

    // The step that finished is charged against its own hold.
    const eventId = eventIdOf(executionId, 0);
    expect(await outboxRow(eventId)).toMatchObject({
      inputTokens: 100,
      outputTokens: 600,
      actualCostNumerator: "1300",
    });

    // The step that was away when the task was cancelled is an UNKNOWN outcome, never
    // a zero: evidence row, hold retained — the existing ledger rule, per step.
    const interruptedEventId = evaluationCaseStepUsageId(executionId, 0, 1);
    expect(await outboxRow(interruptedEventId)).toMatchObject({
      status: "provider_error",
      reservationId: null,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect((await reservationOf(interruptedEventId))?.status).toBe("reserved");
  } finally {
    gateway.stop();
  }
});

/*
 * R3-01: the budget covers the BLANK tool surface too, on the production seam. These
 * tests drive the same public execution seam (`createPublicExecutionSeamModelCall`)
 * through the real billed runner, credit writer and outbox, with a case that declares
 * NO business tools — the engine's own AG-UI state tools still make it a two-request
 * run — plus the policy's own input bound, refused before the wire.
 */

/** One round in the wire shape the public seam's streaming dial speaks (SSE). */
function seamSseRound(chunks: readonly Record<string, unknown>[]): Response {
  const body =
    chunks.map((one) => `data: ${JSON.stringify(one)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

function seamChunk(
  delta: Record<string, unknown>,
  finish: string | null,
  usage?: { input: number; output: number },
): Record<string, unknown> {
  return {
    id: "chatcmpl-f7a",
    object: "chat.completion.chunk",
    created: 0,
    model: "gateway-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage === undefined ? {} : { usage: roundUsage(usage) }),
  };
}

/** One round that calls the engine's own state tool — no business whitelist gates it. */
const seamStateToolRound =
  (usage: { input: number; output: number }) => (): Response =>
    seamSseRound([
      seamChunk(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_state",
              type: "function",
              function: {
                name: "AGUISendStateSnapshot",
                arguments: '{"snapshot":{"region":"eu"}}',
              },
            },
          ],
        },
        null,
      ),
      seamChunk({}, "tool_calls", usage),
    ]);

/** One round that calls a declared business tool, in the seam's streaming shape. */
const seamToolCallRound =
  (name: string, usage: { input: number; output: number }) => (): Response =>
    seamSseRound([
      seamChunk(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name, arguments: '{"q":"outage"}' },
            },
          ],
        },
        null,
      ),
      seamChunk({}, "tool_calls", usage),
    ]);

/** One round that answers with plain text. */
const seamAnswerRound =
  (text: string, usage: { input: number; output: number }) => (): Response =>
    seamSseRound([
      seamChunk({ role: "assistant", content: text }, null),
      seamChunk({}, "stop", usage),
    ]);

/**
 * The seam fixture policy: the same rates and step economics as the loop tests, with
 * the input ceiling raised to the production assembly's own prompt scale — the seam
 * sends the composed builtin prompt and the state tools' schemas, which the
 * conservative counter prices far above a bare case — and the hold covering both
 * maxima, as the invariant requires. The input bound's REFUSAL is exercised below on
 * the existing 1000-token policy, where the oversized case input cannot fit.
 */
const seamPolicy: BillingModelCreditPolicyEntry = {
  input: {
    rate: { numerator: 1n, denominator: 1n },
    maximumTokens: 200_000n,
    maximumCostUnits: 200_000n,
  },
  output: {
    rate: { numerator: 2n, denominator: 1n },
    maximumTokens: 1000n,
    maximumCostUnits: 2000n,
  },
  maximumReservationUnits: 202_000n,
};
const seamPolicies = new Map([["gateway-model", seamPolicy]]);

/** A billed runner over the PRODUCTION public seam, pointed at the script. */
function seamRunner(input: {
  customer: string;
  baseURL: string;
  observations?: ModelSpanObservation[];
  policy?: ReadonlyMap<string, BillingModelCreditPolicyEntry>;
}) {
  return createBilledEvaluationCaseRunner({
    callModel: createPublicExecutionSeamModelCall({
      apiKey: "test-key",
      baseURL: input.baseURL,
    }),
    ...(input.observations === undefined
      ? {}
      : {
          observe: (fact: ModelSpanObservation) =>
            input.observations?.push(fact),
        }),
    billing: {
      creditWriter: writer,
      outbox,
      policy: input.policy ?? seamPolicies,
      externalCustomerId: input.customer,
    },
  });
}

test("the public seam's second loop step is refused before the wire and each step settles against its own hold (R3-01)", async () => {
  const customer = `${prefix}-seam-loop-refused`;
  // Exactly ONE call's worst-case hold: the case may start; the loop's second
  // provider request may not. The same-production-seam ledger evidence R3-01 asks
  // for — the pre-existing runner-dial suite proved this shape on
  // `createGatewayModelCall`; here the SAME economics run through the seam.
  await grant(customer, 202_000);
  const gateway = scriptedGateway([
    seamToolCallRound("search", { input: 100, output: 600 }),
    seamAnswerRound("the outage reached three regions", {
      input: 150,
      output: 300,
    }),
  ]);
  try {
    const executionId = `${prefix}-exec-seam-loop-refused`;
    const observations: ModelSpanObservation[] = [];
    const runner = seamRunner({
      customer,
      baseURL: `http://127.0.0.1:${gateway.port}/v1`,
      observations,
    });

    const outcome = await runner(toolContextFor(executionId));

    // The adversarial core: the second provider request never reached the wire, and
    // the case says why instead of discovering it at settlement.
    expect(gateway.bodies.length).toBe(1);
    expect(outcome).toEqual({ status: "failed", reason: "credits_exhausted" });
    expect(observations[0]?.ending).toEqual({
      kind: "refused",
      code: "credits_exhausted",
    });

    // The step that DID run settles exactly against the hold that admitted it.
    const eventId = eventIdOf(executionId, 0);
    const row = await outboxRow(eventId);
    expect(row).toMatchObject({
      inputTokens: 100,
      outputTokens: 600,
      actualCostNumerator: "1300",
      actualCostDenominator: "1",
    });
    expect(row?.reservationId).toBe((await reservationOf(eventId))?.id);
    const refusedStepEvent = evaluationCaseStepUsageId(executionId, 0, 1);
    expect(await outboxRow(refusedStepEvent)).toBeUndefined();
    expect(await reservationOf(refusedStepEvent)).toBeUndefined();

    // The step's request carried the policy's own output ceiling — applied on the
    // wire before the provider can exceed it, even though the frozen configuration
    // names no cap of its own.
    expect(gateway.bodies[0]).toMatchObject({ max_tokens: 1000 });
  } finally {
    gateway.stop();
  }
});

test("a blank-whitelist case on the public seam is budgeted, capped and settled — its state-tool request and no other (R3-01)", async () => {
  const customer = `${prefix}-seam-blank`;
  await grant(customer, 202_000);
  const gateway = scriptedGateway([
    seamStateToolRound({ input: 100, output: 600 }),
    seamAnswerRound("never reached", { input: 150, output: 300 }),
  ]);
  try {
    const executionId = `${prefix}-exec-seam-blank`;
    const runner = seamRunner({
      customer,
      baseURL: `http://127.0.0.1:${gateway.port}/v1`,
    });

    const outcome = await runner(contextFor(executionId));

    // No business tool is declared, and the engine's own AG-UI state tools still
    // ride the wire (the runtime installs them unconditionally). Today's assembly
    // grants a toolless run no step loop — one provider request — but the budget no
    // longer asks the business whitelist whether the case may multi-step (R3-01):
    // the one request there is is admitted, capped by the policy and settled.
    expect(gateway.bodies.length).toBe(1);
    const wireTools = (
      (gateway.bodies[0]?.tools ?? []) as {
        function?: { name?: string };
      }[]
    )
      .map((one) => one.function?.name)
      .filter((name): name is string => typeof name === "string")
      .sort();
    expect(wireTools).toEqual(["AGUISendStateDelta", "AGUISendStateSnapshot"]);
    // The policy's own output ceiling rides the toolless request — not only the
    // frozen configuration's optional cap.
    expect(gateway.bodies[0]).toMatchObject({ max_tokens: 1000 });
    expect(outcome.status).toBe("completed");

    // The single request's exact charge settles against the case's own hold.
    const eventId = eventIdOf(executionId, 0);
    expect(await outboxRow(eventId)).toMatchObject({
      inputTokens: 100,
      outputTokens: 600,
      actualCostNumerator: "1300",
      actualCostDenominator: "1",
    });
    expect(await reservationOf(eventId)).toBeDefined();
    const noSecondStep = evaluationCaseStepUsageId(executionId, 0, 1);
    expect(await outboxRow(noSecondStep)).toBeUndefined();
    expect(await reservationOf(noSecondStep)).toBeUndefined();
  } finally {
    gateway.stop();
  }
});

test("an input the conservative count places over the policy's input ceiling is refused before the provider is dialed (R3-01)", async () => {
  const customer = `${prefix}-seam-oversize`;
  await grant(customer, 10_000);
  const gateway = scriptedGateway([
    seamAnswerRound("never reached", { input: 5, output: 3 }),
  ]);
  try {
    const executionId = `${prefix}-exec-seam-oversize`;
    const observations: ModelSpanObservation[] = [];
    const runner = seamRunner({
      customer,
      baseURL: `http://127.0.0.1:${gateway.port}/v1`,
      observations,
      // The 1000-token input ceiling: 20,000 ASCII bytes of case input count as at
      // least 12,500 tokens by the approved conservative counter — it cannot fit.
      policy: stepPolicies,
    });

    const outcome = await runner({
      ...contextFor(executionId),
      frozenCase: {
        ...frozenCase,
        safeInput: { state: "projected", text: "z".repeat(20_000) },
      },
    });

    // Never dialed: the count refused the request outright, at step 0.
    expect(gateway.bodies.length).toBe(0);
    expect(outcome).toEqual({ status: "failed", reason: "input_over_limit" });
    expect(observations[0]?.ending).toEqual({
      kind: "refused",
      code: "input_over_limit",
    });

    // The ledger says what actually happened: the case hold stays retained on the
    // unknown-cost doctrine's evidence row, named with the budget's own word for the
    // refusal — never a provider error for a request no provider saw.
    const eventId = eventIdOf(executionId, 0);
    expect(await outboxRow(eventId)).toMatchObject({
      status: "input_over_limit",
      reservationId: null,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect((await reservationOf(eventId))?.status).toBe("reserved");
  } finally {
    gateway.stop();
  }
});
