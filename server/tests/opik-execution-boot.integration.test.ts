import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { createObservationDatasetStore } from "../src/ai-observability/datasets";
import { createExecutionBudgetPrecheck } from "../src/ai-observability/execution-billing";
import {
  createCatalogueToolSurface,
  createExperimentExecutionWorkerBoot,
} from "../src/ai-observability/execution-boot";
import type { EvaluationModelCall } from "../src/ai-observability/execution-runner";
import { GATEWAY_CALL_TIMEOUT_MS } from "../src/ai-observability/execution-runner";
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
import { mcpServers, mcpTools } from "../src/db/schema/plugins";
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
  callModel?: EvaluationModelCall;
}) {
  const calls: Parameters<EvaluationModelCall>[0][] = [];
  const callModel =
    input.callModel ??
    ((async (request) => {
      calls.push(request);
      return {
        output: "the answer with outage",
        inputTokens: 10,
        outputTokens: 20,
      };
    }) satisfies EvaluationModelCall);
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

/**
 * The executions this suite actually started. The cleanup narrows to exactly
 * these (T-routes review M1, the C-4 L-4 footing): no full-table sweep, so a
 * shared database keeps other suites' in-flight rows.
 */
const startedExecutionIds: string[] = [];

/** One frozen dataset version + experiment, and the execution the service started. */
async function submittedExecution(
  customer: string,
  config: typeof configInput = configInput,
) {
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
    config,
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
  const execution = await service.start(scope, experiment.id);
  startedExecutionIds.push(execution.id);
  return execution;
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
  // This suite's own rows, by id — no full-table sweep, no other suite's rows
  // on the shared database (T-routes review M1).
  for (const id of startedExecutionIds) {
    await database
      .delete(aiObservationExperimentExecutions)
      .where(eq(aiObservationExperimentExecutions.id, id));
    await database
      .delete(workItems)
      .where(
        and(eq(workItems.kind, EXECUTION_WORK_KIND), eq(workItems.key, id)),
      );
    // This execution's usage facts, by the event-id shape evaluationCaseUsageId
    // pins. Like, not eq — the review's L1: the old eq compared the column
    // against the pattern string itself and matched zero rows, a fake cleanup.
    await database
      .delete(usageOutbox)
      .where(like(usageOutbox.eventId, `opik-execution-case:${id}:%`));
  }
  startedExecutionIds.length = 0;
  await database.$client.begin(async (tx: TransactionSQL) => {
    await tx`select set_config('ai_observation.experiment_cleanup', 'on', true)`;
    await tx`select set_config('ai_observation.dataset_cleanup', 'on', true)`;
    await tx`DELETE FROM ai_observation_experiments WHERE name LIKE ${`${prefix}%`}`;
    await tx`DELETE FROM ai_observation_datasets WHERE name LIKE ${`${prefix}%`}`;
  });
});

afterAll(async () => {
  // The per-execution cleanup above is this suite's whole usage_outbox footprint
  // (every fact rides a startedExecutionIds event id), so no client-wide delete
  // here (T-routes review M1) — a shared database keeps other suites' rows.
  await database.$client.close();
});

test("the production boot's work-item lease outlives the per-case gateway budget (OCR m131, fix2 R4)", {
  timeout: 30_000,
}, async () => {
  const customer = `${prefix}-lease`;
  await grant(customer, 10_000);
  const execution = await submittedExecution(customer);

  // A case that stays in flight until the test has read the claimed work item:
  // the lease observation must happen while the sweep holds the item, which is
  // exactly the state m131 is about — one case sitting at the gateway budget.
  let releaseCase!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseCase = resolve;
  });
  let caseEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    caseEntered = resolve;
  });
  const { worker } = boot({
    customer,
    callModel: async (_request) => {
      caseEntered();
      await released;
      return {
        output: "the answer with outage",
        inputTokens: 10,
        outputTokens: 20,
      };
    },
  });

  // Not awaited: the sweep must be observed mid-flight, with the case running.
  const sweeping = worker.sweep();
  await entered;

  const [item] = await database
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, EXECUTION_WORK_KIND),
        eq(workItems.key, execution.id),
      ),
    );
  // The sweep claimed the item: the lease is live and somebody owns it.
  expect(item?.owner).not.toBeNull();
  expect(item?.leaseUntil).not.toBeNull();
  // The whole point (OCR m131, tightened by R2-36): the production lease must
  // outlast the WORST single work item, which is no longer one gateway call —
  // the judge composes a second one on top (evaluation call + judge call, two
  // GATEWAY_CALL_TIMEOUT_MS budgets) before settlement even starts. At 2× the
  // lease sat exactly at that composed boundary; the remaining lease must
  // still exceed the whole worst case, not merely one of its two calls.
  // Read live from the claimed row, not from a constant.
  const remainingMs = item.leaseUntil!.getTime() - Date.now();
  expect(remainingMs).toBeGreaterThan(2 * GATEWAY_CALL_TIMEOUT_MS);

  releaseCase();
  await sweeping;
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

/*
 * FREV-04: the evaluated Bot's tool surface is the deployment's OWN catalogue. The
 * frozen whitelist is resolved against the same `mcp_tools` rows the runtime's
 * granted-tool listing reads, classified by the same `classifyTool` the store's
 * `callTool` classifies a real call with — so an evaluation offers the model
 * production schemas and refuses on production's read/write answer, rather than
 * starting every name from a fail-closed "write" the catalogue could have answered.
 */
const toolPrefix = `f5c2-${randomUUID().slice(0, 8)}`;

async function seedTool(
  serverId: string,
  tool: {
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    effect?: string | null;
  },
) {
  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: serverId,
      vendor: "Test",
      url: `https://${serverId}.example.test/mcp`,
      provenance: "custom",
    })
    .onConflictDoNothing();
  await database.insert(mcpTools).values({
    serverId,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? { type: "object" },
    effect: tool.effect ?? null,
  });
}

async function dropToolServers() {
  for (const serverId of [`${toolPrefix}-kb`, `${toolPrefix}-kb2`]) {
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  }
}

test("the catalogue tool surface answers every spelling of a frozen name, and refuses to guess at an ambiguous bare one (FREV-04)", async () => {
  try {
    await seedTool(`${toolPrefix}-kb`, {
      name: "search",
      description: "Search the support knowledge base.",
      inputSchema: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      },
      // The vendor's own label, which is what a custom server's classification reads.
      effect: "read",
    });
    await seedTool(`${toolPrefix}-kb`, {
      name: "note_delete",
      description: "Delete a note.",
    });

    const surfaces = await createCatalogueToolSurface(database)([
      `${toolPrefix}-kb/search`,
      `mcp__${toolPrefix}-kb__search`,
      "search",
      "note_delete",
      "never_listed",
    ]);

    const expected = {
      description: "Search the support knowledge base.",
      parameters: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      },
      effect: "read",
    };
    // The ref spelling, the model-facing spelling a transcript would carry, and the
    // bare name that is unique among advertised tools all resolve to the same facts.
    expect(surfaces.get(`${toolPrefix}-kb/search`)).toEqual(expected);
    expect(surfaces.get(`mcp__${toolPrefix}-kb__search`)).toEqual(expected);
    expect(surfaces.get("search")).toEqual(expected);
    // A tool the vendor recorded no effect for is a write — the store's own answer.
    expect(surfaces.get("note_delete")?.effect).toBe("write");
    // A name no row advertises stays absent: the fail-closed classifier keeps it a write.
    expect(surfaces.has("never_listed")).toBe(false);

    // A second server advertising the same bare name makes it ambiguous: the bare
    // spelling resolves to nothing, while each ref still names its own row.
    await seedTool(`${toolPrefix}-kb2`, {
      name: "search",
      description: "A different server's search.",
      effect: "read",
    });
    const ambiguous = await createCatalogueToolSurface(database)([
      "search",
      `${toolPrefix}-kb/search`,
    ]);
    expect(ambiguous.has("search")).toBe(false);
    expect(ambiguous.get(`${toolPrefix}-kb/search`)?.description).toBe(
      "Search the support knowledge base.",
    );
  } finally {
    await dropToolServers();
  }
});

test("a swept execution declares the catalogue's tool surface and keeps every call on the gate (FREV-04)", {
  timeout: 30_000,
}, async () => {
  const serverId = `${toolPrefix}-kb`;
  const toolName = `mcp__${serverId}__lookup`;
  try {
    await seedTool(serverId, {
      name: "lookup",
      description: "Look a support article up.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      effect: "read",
    });
    const customer = `${prefix}-tools`;
    await grant(customer, 10_000);
    const execution = await submittedExecution(customer, {
      ...configInput,
      readOnlyTools: [toolName],
      toolFixtures: { [toolName]: { answer: "the frozen article" } },
    });

    // What the production runner hands the engine: the declared surface (catalogue
    // description and schema) and the replayed fixture. The model here is a stand-in
    // for the provider's "call the tool, then answer from it" — the tool invocation
    // itself is the production closure under test, not a re-implementation.
    let declared: readonly {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }[] = [];
    const replayed: unknown[] = [];
    const { worker } = boot({
      customer,
      callModel: async (request) => {
        declared = (request.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }));
        for (const tool of request.tools ?? []) {
          replayed.push(await tool.execute({ id: "article-1" }));
        }
        return {
          output: "answered from the frozen article",
          inputTokens: 10,
          outputTokens: 20,
          // A name the model invented: the runner must put it through the gate too.
          undeclaredToolCalls: ["evil_tool"],
        };
      },
    });

    await worker.sweep();

    expect(declared).toEqual([
      {
        name: toolName,
        description: "Look a support article up.",
        parameters: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    ]);
    // The gate answered the call with the frozen fixture — not a live tool, and not
    // a refusal: the projection envelopes are unwrapped, so the model reads the
    // frozen value the experiment pinned.
    expect(replayed).toEqual([{ answer: "the frozen article" }]);

    const rows = await database
      .select()
      .from(aiObservationExperimentExecutions)
      .where(eq(aiObservationExperimentExecutions.id, execution.id));
    expect(rows[0]?.state).toBe("completed");
    // The invented tool reached the gate: the governance counter is a real count.
    expect(rows[0]?.toolRejections).toBe(1);
  } finally {
    await dropToolServers();
  }
});
