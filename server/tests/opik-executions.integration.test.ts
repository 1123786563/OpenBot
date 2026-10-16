import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TransactionSQL } from "bun";
import { and, eq } from "drizzle-orm";
import { createObservationDatasetStore } from "../src/ai-observability/datasets";
import {
  cancelExecutionsForActor,
  createExperimentExecutionService,
  createObservationExecutionStore,
  createObservationExecutionWorker,
  type EvaluationCaseContext,
  type EvaluationCaseOutcome,
  type EvaluationToolCall,
  EXECUTION_WORK_KIND,
  ExecutionError,
} from "../src/ai-observability/executions";
import { createObservationExperimentStore } from "../src/ai-observability/experiments";
import { resolveObservationScope } from "../src/ai-observability/scope";
import { createAuditStore } from "../src/audit";
import { aiObservationExperimentExecutions } from "../src/db/schema/ai-observability-executions";
import { workItems } from "../src/db/schema/work";
import { opikTestDatabase } from "./support/opik-test-db";
import { rejectionOf } from "./support/pg-errors";

/**
 * Behavioral proof of the isolated execution against a real, dedicated PostgreSQL
 * database (Issue #29 / DAG T23): enqueue refuses drafts and other scopes, the state
 * vocabulary is a database fact, the worker runs frozen configuration only — refusing
 * and counting every production write tool call through the one interception seam —
 * revocation wins any race, a refused budget never starts anything, and the settle
 * row carries the refusal counter into the audit trail. There is no skip and no
 * fallback database; a missing test database fails the run.
 *
 * The sweep-driven tests take an explicit timeout: one worker pass is a dozen-plus
 * sequential round trips, and bun's 5s default only holds on a fast local Postgres.
 */

const database = opikTestDatabase();
const datasets = createObservationDatasetStore(database);
const experiments = createObservationExperimentStore(database);
const executions = createObservationExecutionStore(database);
const audit = createAuditStore(database);
const prefix = `t23-${randomUUID()}`;

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
  toolFixtures: { search: { query: "outage", results: 3 } },
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
  readOnlyTools: ["search"],
};

/** search reads; everything else — including the calendar write — is a production write. */
const classify = (toolName: string) =>
  toolName === "search" ? "read" : "write";

/** One frozen experiment to execute, minted through the real T19+T22 pipelines. */
async function frozenExperiment(
  scope: typeof scopeA = scopeA,
  extra: Partial<typeof config> = {},
  /** How many cases the dataset freezes; each case's input is distinct. */
  caseCount = 1,
) {
  const { version } = await datasets.saveVersion(scope, {
    datasetName: `${prefix}-dataset-${randomUUID().slice(0, 8)}`,
    cases: Array.from({ length: caseCount }, (_, i) => ({
      ...caseInput,
      input: i === 0 ? caseInput.input : `${caseInput.input} (case ${i})`,
    })),
  });
  return experiments.submit(scope, {
    name: `${prefix}-experiment-${randomUUID().slice(0, 8)}`,
    datasetVersionId: version.id,
    config: { ...config, ...extra },
  });
}

/** The worker over injected case runners; the production runner has its own unit contract. */
function workerFor(
  runCase: (context: EvaluationCaseContext) => Promise<EvaluationCaseOutcome>,
  input: {
    revoked?: boolean;
    leaseMs?: number;
    concurrency?: number;
    /** Overrides the default scope-echoing reauthorize seam. */
    reauthorize?: Parameters<
      typeof createObservationExecutionWorker
    >[0]["reauthorize"];
  } = {},
) {
  return createObservationExecutionWorker({
    database,
    audit,
    classify,
    runCase,
    concurrency: input.concurrency,
    leaseMs: input.leaseMs,
    reauthorize:
      input.reauthorize ??
      (input.revoked
        ? async () => null
        : async ({ actorId }) =>
            actorId === scopeA.actorId
              ? scopeA
              : actorId === scopeB.actorId
                ? scopeB
                : null),
    owner: `t23-owner-${randomUUID()}`,
  });
}

async function until(
  predicate: () => Promise<boolean> | boolean,
  what: string,
  ms = 5_000,
) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition not reached: ${what}`);
}

const ticketOf = async (id: string) =>
  (
    await database
      .select()
      .from(workItems)
      .where(
        and(eq(workItems.kind, EXECUTION_WORK_KIND), eq(workItems.key, id)),
      )
  )[0];

const auditRows = (executionId: string) =>
  database.$client`
    SELECT payload FROM audit_events
    WHERE event_type = 'opik.experiment_execution_settled' AND target_id = ${executionId}
  `;

afterEach(async () => {
  // Executions first: their foreign key pins the experiments underneath. The guards
  // refuse experiment and dataset rows leaving any way but their cleanup paths, so the
  // transaction-local flags plus the subject-row cascade is the sanctioned route.
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

test("enqueue queues a frozen experiment with its claim ticket and config hash", async () => {
  const { experiment } = await frozenExperiment();
  const row = await executions.enqueue(scopeA, experiment.id);

  expect(row.state).toBe("pending");
  expect(row.experimentId).toBe(experiment.id);
  expect(row.experimentConfigHash).toBe(experiment.configHash);
  expect(row.toolRejections).toBe(0);
  // The claim ticket landed with the execution, atomically.
  expect((await ticketOf(row.id))?.key).toBe(row.id);
});

test("enqueue refuses a draft experiment outright", async () => {
  const { version } = await datasets.saveVersion(scopeA, {
    datasetName: `${prefix}-dataset-${randomUUID().slice(0, 8)}`,
    cases: [caseInput],
  });
  const draft = await experiments.saveDraft(scopeA, {
    name: `${prefix}-experiment-${randomUUID().slice(0, 8)}`,
    datasetVersionId: version.id,
    config,
  });

  const refusal = await executions
    .enqueue(scopeA, draft.id)
    .catch((error: unknown) => error as ExecutionError);
  expect(refusal).toBeInstanceOf(ExecutionError);
  expect(refusal.code).toBe("EXECUTION_EXPERIMENT_NOT_FROZEN");
  expect(refusal.status).toBe(409);
  expect(
    await database
      .select()
      .from(aiObservationExperimentExecutions)
      .where(eq(aiObservationExperimentExecutions.experimentId, draft.id)),
  ).toEqual([]);
});

test("enqueue cannot find another scope's experiment", async () => {
  const { experiment } = await frozenExperiment(scopeB);

  await expect(executions.enqueue(scopeA, experiment.id)).rejects.toThrow(
    new ExecutionError("EXECUTION_EXPERIMENT_NOT_FOUND", 404),
  );
  expect(
    await database
      .select()
      .from(aiObservationExperimentExecutions)
      .where(eq(aiObservationExperimentExecutions.experimentId, experiment.id)),
  ).toEqual([]);
});

test("a budget the precheck refuses never starts anything", async () => {
  const { experiment } = await frozenExperiment();
  const service = createExperimentExecutionService({
    executions,
    billing: { precheck: async () => ({ allowed: false }) },
  });

  await expect(service.start(scopeA, experiment.id)).rejects.toThrow(
    new ExecutionError("EXECUTION_BUDGET_REFUSED", 402),
  );
  expect(
    await database
      .select()
      .from(aiObservationExperimentExecutions)
      .where(eq(aiObservationExperimentExecutions.experimentId, experiment.id)),
  ).toEqual([]);
  expect(await ticketOf(experiment.id)).toBeUndefined();
});

test("the worker executes frozen cases, refusing and counting write tools", {
  timeout: 30_000,
}, async () => {
  const { experiment } = await frozenExperiment();
  const row = await executions.enqueue(scopeA, experiment.id);

  const seen: EvaluationToolCall[] = [];
  let context: EvaluationCaseContext | null = null;
  const worker = workerFor(async (one) => {
    context = one;
    seen.push(await one.callTool("search"));
    seen.push(await one.callTool("calendar_create"));
    seen.push(await one.callTool("never_heard_of_it"));
    return { status: "completed", detail: { answered: true } };
  });
  await worker.sweep();

  // Isolation by construction: the case saw frozen content and the one tool seam —
  // no session, memory or business-data handle exists in the context to see.
  expect(context!.executionId).toBe(row.id);
  expect(context!.experimentId).toBe(experiment.id);
  expect(context!.caseIndex).toBe(0);
  expect(context!.frozenCase.safeInput).toEqual({
    state: "projected",
    text: "Summarize the outage report.",
  });

  // The whitelisted read replayed its frozen fixture; the write tool and the unknown
  // tool were refused — never silently skipped. Both are outside the whitelist, which
  // is the fail-closed first gate; the whitelisted-but-write case is the next test.
  expect(seen.map((call) => call.outcome)).toEqual([
    "replayed",
    "refused",
    "refused",
  ]);
  expect(seen[1]).toEqual({ outcome: "refused", reason: "not_whitelisted" });
  expect(seen[2]).toEqual({ outcome: "refused", reason: "not_whitelisted" });

  const settled = await executions.get(scopeA, row.id);
  expect(settled?.state).toBe("completed");
  expect(settled?.caseCount).toBe(1);
  expect(settled?.toolRejections).toBe(2);
  // The result is assembled from the per-case write-ahead rows, each already projected
  // once at record time (T24): `detail` is the stored envelope embedded as-is, so it is
  // not projected — or depth-cut — a second time. No naked text reaches this column.
  expect(settled?.result).toEqual({
    state: "projected",
    value: {
      cases: {
        state: "projected",
        value: [
          {
            state: "projected",
            value: {
              index: { state: "projected", value: 0 },
              status: { state: "projected", value: "completed" },
              detail: {
                state: "projected",
                value: {
                  answered: { state: "projected", value: true },
                },
              },
            },
          },
        ],
      },
    },
  });

  // The governance channel: the settle row carries the refusal counter and the projected
  // names (T23-rev L-2: a name is projected before it lands in the payload).
  const audited = await auditRows(row.id);
  expect(audited.length).toBe(1);
  expect(audited[0].payload).toMatchObject({
    executionId: row.id,
    experimentId: experiment.id,
    experimentConfigHash: experiment.configHash,
    state: "completed",
    caseCount: 1,
    toolRejections: 2,
    rejectedTools: [
      { state: "projected", text: "calendar_create" },
      { state: "projected", text: "never_heard_of_it" },
    ],
  });
});

test("a whitelisted tool the production classifier calls a write is still refused", {
  timeout: 30_000,
}, async () => {
  const { experiment } = await frozenExperiment();
  const row = await executions.enqueue(scopeA, experiment.id);

  const worker = createObservationExecutionWorker({
    database,
    audit,
    classify: () => "write",
    runCase: async (one) => {
      const call = await one.callTool("search");
      expect(call).toEqual({ outcome: "refused", reason: "write_tool" });
      return { status: "completed" };
    },
    reauthorize: async () => scopeA,
    owner: `t23-owner-${randomUUID()}`,
  });
  await worker.sweep();

  const settled = await executions.get(scopeA, row.id);
  expect(settled?.state).toBe("completed");
  expect(settled?.toolRejections).toBe(1);
});

test("a case runner that fails settles failed with its code, and no result", {
  timeout: 30_000,
}, async () => {
  const { experiment } = await frozenExperiment();
  const row = await executions.enqueue(scopeA, experiment.id);

  const worker = workerFor(async () => {
    throw new Error("the model provider is down");
  });
  await worker.sweep();

  const settled = await executions.get(scopeA, row.id);
  expect(settled?.state).toBe("failed");
  expect(settled?.errorCode).toBe("CASE_EXECUTION_ERROR");
  expect(settled?.result).toBeNull();
  expect(settled?.caseCount).toBeNull();

  const audited = await auditRows(row.id);
  expect(audited[0].payload).toMatchObject({
    state: "failed",
    errorCode: "CASE_EXECUTION_ERROR",
  });
});

test("a revoked actor's execution is cancelled before any case runs", {
  timeout: 30_000,
}, async () => {
  const { experiment } = await frozenExperiment();
  const row = await executions.enqueue(scopeA, experiment.id);

  let ran = 0;
  const worker = workerFor(
    async () => {
      ran += 1;
      return { status: "completed" };
    },
    { revoked: true },
  );
  await worker.sweep();

  expect(ran).toBe(0);
  const settled = await executions.get(scopeA, row.id);
  expect(settled?.state).toBe("cancelled");
  expect(settled?.settledAt).not.toBeNull();
  // T23-rev L-1: the cancel path leaves a settle audit row too — a cancelled execution
  // with mid-run refusals must still reach the governance channel.
  const audited = await auditRows(row.id);
  expect(audited.length).toBe(1);
  expect(audited[0].payload).toMatchObject({
    state: "cancelled",
    toolRejections: 0,
  });
});

test("revocation wins the race against a completion write", {
  timeout: 30_000,
}, async () => {
  const { experiment } = await frozenExperiment();
  const row = await executions.enqueue(scopeA, experiment.id);

  // The case hangs mid-run until the test says so; the cancel seam lands while it hangs.
  let release: (() => void) | null = null;
  const midCase = new Promise<void>((resolve) => {
    release = resolve;
  });
  const swept = workerFor(async () => {
    await midCase;
    return { status: "completed" };
  }).sweep();

  await until(
    async () => (await executions.get(scopeA, row.id))?.state === "running",
    "the execution starts running",
  );
  await executions.cancelForActor(scopeA.actorId);
  release!();
  await swept;

  // The cancel seam settled it first; the worker's completion write was refused.
  const settled = await executions.get(scopeA, row.id);
  expect(settled?.state).toBe("cancelled");
  expect(settled?.result).toBeNull();
});

test("cancelForActor settles every active execution and nothing terminal", async () => {
  const { experiment } = await frozenExperiment();
  const pending = await executions.enqueue(scopeA, experiment.id);
  const done = await executions.enqueue(scopeA, experiment.id);
  await executions.markRunning(done.id);
  await executions.settleCompleted(done.id, [
    { index: 0, status: "completed" },
  ]);

  const cancelled = await executions.cancelForActor(scopeA.actorId);
  expect(cancelled.length).toBe(1);
  expect((await executions.get(scopeA, pending.id))?.state).toBe("cancelled");
  // First terminal write wins: the completed execution is untouched.
  expect((await executions.get(scopeA, done.id))?.state).toBe("completed");
});

test("markRunning claims pending and lease-orphaned running, and nothing terminal", async () => {
  const { experiment } = await frozenExperiment();
  const row = await executions.enqueue(scopeA, experiment.id);

  const first = await executions.markRunning(row.id);
  expect(first?.state).toBe("running");
  // A lease-orphaned running row is claimable again — the takeover discipline.
  const again = await executions.markRunning(row.id);
  expect(again?.state).toBe("running");

  await executions.settleCancelled(row.id);
  expect(await executions.markRunning(row.id)).toBeNull();
});

test("listing is scoped and per-experiment", async () => {
  const mine = await frozenExperiment();
  const theirs = await frozenExperiment(scopeB);
  await executions.enqueue(scopeA, mine.experiment.id);
  await executions.enqueue(scopeB, theirs.experiment.id);

  const listed = await executions.list(scopeA, mine.experiment.id);
  expect(listed.map((row) => row.experimentId)).toEqual([mine.experiment.id]);
  expect(await executions.list(scopeA, theirs.experiment.id)).toEqual([]);
});

test("the state vocabulary is a database fact", async () => {
  const { experiment } = await frozenExperiment();
  const row = await executions.enqueue(scopeA, experiment.id);
  const refuse = (statement: () => Promise<unknown>) =>
    rejectionOf(statement).then((refusal) =>
      expect(refusal.code).toBe("23514"),
    );

  // The export jobs' first word is refused here: this slice's vocabulary is its own.
  await refuse(
    () => database.$client`
    UPDATE ai_observation_experiment_executions SET state = 'queued' WHERE id = ${row.id}
  `,
  );
  // A result may land only on completed.
  await refuse(
    () => database.$client`
    UPDATE ai_observation_experiment_executions SET result = '{"cases":[]}'::jsonb WHERE id = ${row.id}
  `,
  );
  // An error code may land only on failed.
  await refuse(
    () => database.$client`
    UPDATE ai_observation_experiment_executions SET error_code = 'CASE_EXECUTION_ERROR' WHERE id = ${row.id}
  `,
  );
  // settled_at is non-null exactly on the terminal states.
  await refuse(
    () => database.$client`
    UPDATE ai_observation_experiment_executions SET settled_at = now() WHERE id = ${row.id}
  `,
  );
  // An execution backed by a draft's empty config hash cannot exist.
  await refuse(
    () => database.$client`
    INSERT INTO ai_observation_experiment_executions (id, scope_key, actor_id, bot_id, experiment_id, experiment_config_hash)
    VALUES (${randomUUID()}, ${scopeA.key}, ${scopeA.actorId}, ${scopeA.botId}, ${experiment.id}, '')
  `,
  );
});

test("an execution pins its experiment physically", async () => {
  const { experiment } = await frozenExperiment();
  await executions.enqueue(scopeA, experiment.id);

  const refusal = await rejectionOf(
    () => database.$client`
      DELETE FROM ai_observation_experiments WHERE id = ${experiment.id}
    `,
  );
  expect(refusal.code).toBe("23001");
});

/*
 * T24 (Issue #30): durable, bounded-concurrency execution with idempotent resume,
 * per-case re-authorization, and a no-double-invocation promise on lease takeover.
 */

test("a lease takeover resumes without re-running completed cases, and never re-invokes an unknown one", {
  timeout: 30_000,
}, async () => {
  const { experiment } = await frozenExperiment(scopeA, {}, 3);
  const row = await executions.enqueue(scopeA, experiment.id);

  // Worker A dies mid-case-2: it hangs inside the runner (no lease renewal, no settle,
  // no finish) — exactly what a crashed process leaves behind.
  const invocations: number[] = [];
  let release: (() => void) | null = null;
  const hang = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sweptA = workerFor(async (one) => {
    invocations.push(one.caseIndex);
    if (one.caseIndex === 2) await hang;
    return { status: "completed", detail: { by: `a-${one.caseIndex}` } };
  }).sweep();
  await until(
    async () =>
      (await executions.caseOutcomes(row.id)).some(
        (outcome) => outcome.caseIndex === 2 && outcome.status === "in_flight",
      ),
    "worker A reaches case 2",
  );

  // The lease lapses on the database's clock; worker B takes over.
  await database.$client`
    UPDATE work_items SET lease_until = now() - interval '1 second'
    WHERE kind = ${EXECUTION_WORK_KIND} AND key = ${row.id}
  `;
  let resumed = 0;
  await workerFor(async () => {
    resumed += 1;
    return { status: "completed" };
  }).sweep();

  // Completed cases were skipped, not re-run; the in-flight case was NOT re-invoked —
  // its outcome is honestly unknown, and each case ran exactly once in total.
  expect(resumed).toBe(0);
  const settled = await executions.get(scopeA, row.id);
  expect(settled?.state).toBe("completed");
  expect(settled?.caseCount).toBe(3);

  release!();
  await sweptA;
  expect(invocations).toEqual([0, 1, 2]);

  const outcomes = await executions.caseOutcomes(row.id);
  expect(outcomes.map((outcome) => outcome.status)).toEqual([
    "completed",
    "completed",
    "unknown",
  ]);
});

test("two workers claiming one execution are mutually exclusive", {
  timeout: 30_000,
}, async () => {
  const { experiment } = await frozenExperiment();
  const row = await executions.enqueue(scopeA, experiment.id);

  const invocations: string[] = [];
  const workerForOwner = (tag: string) =>
    createObservationExecutionWorker({
      database,
      audit,
      classify,
      runCase: async () => {
        invocations.push(tag);
        return { status: "completed" };
      },
      reauthorize: async () => scopeA,
      owner: `t24-${tag}-${randomUUID()}`,
    });
  await Promise.all([workerForOwner("a").sweep(), workerForOwner("b").sweep()]);

  // The lease is the exclusion: one claim wins, the other worker takes nothing.
  expect(invocations.length).toBe(1);
  expect((await executions.get(scopeA, row.id))?.state).toBe("completed");
  expect((await auditRows(row.id)).length).toBe(1);
});

test("a worker runs at most its concurrency bound at once", {
  timeout: 30_000,
}, async () => {
  const { experiment } = await frozenExperiment();
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    ids.push((await executions.enqueue(scopeA, experiment.id)).id);
  }

  let active = 0;
  let peak = 0;
  const worker = workerFor(
    async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return { status: "completed" };
    },
    { concurrency: 2 },
  );
  await worker.sweep();
  await worker.sweep();
  await worker.sweep();

  expect(peak).toBe(2);
  const settled = await Promise.all(
    ids.map((id) => executions.get(scopeA, id)),
  );
  expect(settled.map((row) => row?.state)).toEqual([
    "completed",
    "completed",
    "completed",
    "completed",
    "completed",
  ]);
});

test("revocation between cases stops the run at the next case boundary, audited", {
  timeout: 30_000,
}, async () => {
  const { experiment } = await frozenExperiment(scopeA, {}, 3);
  const row = await executions.enqueue(scopeA, experiment.id);

  let authorizations = 0;
  const worker = workerFor(async () => ({ status: "completed" }), {
    reauthorize: async () => {
      authorizations += 1;
      return authorizations <= 2 ? scopeA : null;
    },
  });
  await worker.sweep();

  // Authorized at claim and before case 0; refused before case 1 — no case after
  // the revocation runs, reads or consumes anything.
  expect(authorizations).toBe(3);
  const settled = await executions.get(scopeA, row.id);
  expect(settled?.state).toBe("cancelled");
  expect(
    (await executions.caseOutcomes(row.id)).map((outcome) => outcome.status),
  ).toEqual(["completed"]);

  const audited = await auditRows(row.id);
  expect(audited.length).toBe(1);
  expect(audited[0].payload).toMatchObject({
    state: "cancelled",
    executionId: row.id,
  });
});

test("a cancelled execution stops scheduling cases it has not started", {
  timeout: 30_000,
}, async () => {
  const { experiment } = await frozenExperiment(scopeA, {}, 3);
  const row = await executions.enqueue(scopeA, experiment.id);

  let ran = 0;
  let release: (() => void) | null = null;
  const hang = new Promise<void>((resolve) => {
    release = resolve;
  });
  const swept = workerFor(async () => {
    ran += 1;
    await hang;
    return { status: "completed" };
  }).sweep();
  // Cancel while case 0 is mid-run: the case-start write-ahead guard finds a settled
  // row before case 1 and the worker stops — cases 1 and 2 never start.
  await until(
    async () =>
      (await executions.caseOutcomes(row.id)).some(
        (outcome) => outcome.caseIndex === 0,
      ) && ran === 1,
    "case 0 is running",
  );
  await executions.cancelForActor(scopeA.actorId);
  release!();
  await swept;

  expect(ran).toBe(1);
  const settled = await executions.get(scopeA, row.id);
  expect(settled?.state).toBe("cancelled");
  // What had already run is still the truth: case 0's outcome was recorded, not dropped.
  expect(
    (await executions.caseOutcomes(row.id)).map((outcome) => outcome.status),
  ).toEqual(["completed"]);
});

test("cancelling an actor's executions leaves a settle audit row for each", async () => {
  const { experiment } = await frozenExperiment();
  const pending = await executions.enqueue(scopeA, experiment.id);
  const noisy = await executions.enqueue(scopeA, experiment.id);
  await executions.markRunning(noisy.id);
  await executions.bumpToolRejections(noisy.id, 3);

  const cancelled = await cancelExecutionsForActor(
    { executions, audit },
    scopeA.actorId,
  );
  expect(cancelled.length).toBe(2);
  expect((await auditRows(pending.id))[0].payload).toMatchObject({
    state: "cancelled",
    toolRejections: 0,
  });
  // The mid-run refusal counter reaches the governance channel even on this path.
  expect((await auditRows(noisy.id))[0].payload).toMatchObject({
    state: "cancelled",
    toolRejections: 3,
  });
});

test("the case-outcome vocabulary is a database fact, and rows die with the execution", async () => {
  const { experiment } = await frozenExperiment();
  const row = await executions.enqueue(scopeA, experiment.id);
  await executions.markRunning(row.id);

  const refusal = await rejectionOf(
    () => database.$client`
      INSERT INTO ai_observation_execution_case_outcomes (execution_id, case_index, status)
      VALUES (${row.id}, 0, 'queued')
    `,
  );
  expect(refusal.code).toBe("23514");

  // The outcome rows are the execution's own: when the execution row goes, they go.
  await executions.markCaseStarted(row.id, 0);
  await database
    .delete(aiObservationExperimentExecutions)
    .where(eq(aiObservationExperimentExecutions.id, row.id));
  expect(await executions.caseOutcomes(row.id)).toEqual([]);
});
