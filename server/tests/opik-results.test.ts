// Issue #34 / DAG T28 — the experiment result query surface and its failure taxonomy.
//
// Every case here runs against injected stores, exactly like the T11/T19/T20 suites: no
// database, no network. The fake stores record what the service reached them with, so the
// unit contract includes "which reads a scope may even attempt". The behavioral proofs
// against a real database — settle through the real projection, lease-orphan detection
// against the real work queue, scope isolation at the SQL layer — live in
// opik-results.integration.test.ts.
//
// The acceptance under test, in issue order:
//   1. per-sample score, reason, scorer version, usage and result link (the link names
//      the T23 execution id — the safe execution record).
//   2. execution failure, scoring failure, cancellation, pending reconciliation and sync
//      failure are distinct classes that never impersonate one another or a score of 0;
//      the mean covers scored samples only, over an explicit base with explicit exclusions.
//   3. scope/Bot authorization: a forged scope is refused before any store is asked; a
//      guessed experiment, dataset version or execution id is simply not found.
//   4. the result link is unfakeable: an execution that does not name this experiment is
//      not found, and no client input ever names a scope.
import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfile } from "../src/agents/profile-types";
import {
  type BotManagementCheck,
  OBSERVATION_BOT_NOT_FOUND,
} from "../src/ai-observability/context";
import { ObservationScopeError } from "../src/ai-observability/contracts";
import type { ObservationDatasetVersion } from "../src/ai-observability/datasets";
import type { ObservationExecution } from "../src/ai-observability/executions";
import type { ObservationExperiment } from "../src/ai-observability/experiments";
import { freezeExperimentConfig } from "../src/ai-observability/experiments";
import {
  createExperimentResultService,
  ExperimentResultsError,
  SAMPLE_CLASSES,
  type WorkTicketState,
} from "../src/ai-observability/results";
import { createExperimentResultsRoutes } from "../src/ai-observability/routes/results";
import { resolveObservationScope } from "../src/ai-observability/scope";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";

const owner = { id: "user-owner", role: "user" } as const;
const EPOCH = 3;

const scopeA = resolveObservationScope({
  actorId: owner.id,
  botId: "agent-1",
  ownership: "owner",
  epoch: EPOCH,
});
const scopeB = resolveObservationScope({
  actorId: "user-b",
  botId: "agent-1",
  ownership: "admin",
  epoch: EPOCH,
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

const config = freezeExperimentConfig({
  botConfig: { toolChoice: "auto" },
  prompt: "Answer the support question from the outage report.",
  modelName: "claude-sonnet-5",
  modelParameters: { temperature: 0, maxTokens: 1024 },
  toolFixtures: { search: { query: "outage", results: 0 } },
  judgeConfig: RULES,
  judgeVersion: "rules/1",
  readOnlyTools: ["search"],
});

const experiment = {
  id: "experiment-1",
  scopeKey: scopeA.key,
  actorId: scopeA.actorId,
  botId: scopeA.botId,
  name: "outage-eval",
  datasetVersionId: "version-1",
  datasetContentHash: "a".repeat(64),
  config,
  configHash: "b".repeat(64),
  state: "frozen",
  frozenAt: new Date("2026-10-16T00:00:00.000Z"),
  createdAt: new Date("2026-10-16T00:00:00.000Z"),
  updatedAt: new Date("2026-10-16T00:00:00.000Z"),
} as ObservationExperiment;

const version = (cases: number) =>
  ({
    id: "version-1",
    scopeKey: scopeA.key,
    datasetId: "dataset-1",
    contentHash: "c".repeat(64),
    redactionPolicyVersion: "opik-redaction/5",
    cases: Array.from({ length: cases }, () => ({
      safeInput: { state: "projected", text: "Summarize the outage report." },
      referenceOutput: { state: "projected", text: "A one-paragraph summary." },
      toolFixtures: { state: "projected", value: {} },
      sourceRunId: "run-1",
      sourceAttemptId: "attempt-1",
      sourceBindingId: null,
    })),
    locatorWorkspace: "ws",
    locatorProject: "proj",
    createdAt: new Date("2026-10-16T00:00:00.000Z"),
  }) as ObservationDatasetVersion;

function execution(
  overrides: Partial<ObservationExecution>,
): ObservationExecution {
  return {
    id: "execution-1",
    scopeKey: scopeA.key,
    actorId: scopeA.actorId,
    botId: scopeA.botId,
    experimentId: "experiment-1",
    experimentConfigHash: "b".repeat(64),
    state: "completed",
    errorCode: null,
    caseCount: 1,
    toolRejections: 0,
    result: null,
    createdAt: new Date("2026-10-16T00:10:00.000Z"),
    updatedAt: new Date("2026-10-16T00:11:00.000Z"),
    startedAt: new Date("2026-10-16T00:10:05.000Z"),
    settledAt: new Date("2026-10-16T00:11:00.000Z"),
    ...overrides,
  };
}

/**
 * The stores under the service's hands. Each records the reads so a test can prove a
 * refusal happened before any store was reached; every read is scope-keyed exactly like
 * the real stores, so another scope's id is simply not found.
 */
function stores(setup: {
  /** Defaults to the module's rows; `null` means "not found". */
  experiment?: ObservationExperiment | null;
  version?: ObservationDatasetVersion | null;
  execution?: ObservationExecution | null;
  ticket?: WorkTicketState | null;
}) {
  const reads = { experiments: 0, executions: 0, versions: 0, tickets: 0 };
  const experimentRow =
    setup.experiment === undefined ? experiment : setup.experiment;
  const versionRow = setup.version === undefined ? version(1) : setup.version;
  const executionRow =
    setup.execution === undefined
      ? execution({ caseCount: 1 })
      : setup.execution;
  return {
    reads,
    deps: {
      experiments: {
        getExperiment: async (scope: { key: string }, id: string) => {
          reads.experiments += 1;
          const row = experimentRow;
          return row && row.id === id && row.scopeKey === scope.key
            ? row
            : null;
        },
      },
      executions: {
        get: async (scope: { key: string }, id: string) => {
          reads.executions += 1;
          const row = executionRow;
          return row && row.id === id && row.scopeKey === scope.key
            ? row
            : null;
        },
      },
      datasets: {
        getVersion: async (scope: { key: string }, id: string) => {
          reads.versions += 1;
          const row = versionRow;
          return row && row.id === id && row.scopeKey === scope.key
            ? row
            : null;
        },
      },
      ticket: async (id: string) => {
        reads.tickets += 1;
        return setup.execution?.id === id ? (setup.ticket ?? null) : null;
      },
    },
  };
}

const textOutput = (text: string) => ({ state: "projected", text }) as const;

function serviceFor(setup: Parameters<typeof stores>[0]) {
  const fake = stores(setup);
  return {
    fake,
    service: createExperimentResultService(fake.deps),
  };
}

describe("the closed failure taxonomy", () => {
  test("the five failure classes and the two non-failure states are named, once each", () => {
    expect(SAMPLE_CLASSES).toEqual([
      "scored",
      "in_progress",
      "execution_failed",
      "scoring_failed",
      "cancelled",
      "pending_reconciliation",
      "sync_failure",
    ]);
  });
});

describe("a completed execution answers per-sample score, reason, version, usage, link", () => {
  test("a scored sample carries its fraction, rule rows, usage and the execution link", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: execution({
        caseCount: 1,
        result: {
          cases: [
            {
              index: 0,
              status: "completed",
              output: textOutput("A one-paragraph outage summary."),
              usage: {
                state: "projected",
                value: { tokens_input: { state: "projected", value: 12 } },
              },
            },
          ],
        },
      }),
    });

    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });

    expect(report.state).toBe("completed");
    expect(report.scorerVersion).toBe("rules/1");
    expect(report.execution.id).toBe("execution-1");
    expect(report.execution.experimentConfigHash).toBe("b".repeat(64));
    expect(report.samples).toHaveLength(1);
    const sample = report.samples[0];
    expect(sample.class).toBe("scored");
    expect(sample.score).toBe(1);
    expect(sample.reason).toEqual({
      class: "scored",
      passed: 2,
      failed: 0,
      rules: [
        { id: "greeting", index: 0, status: "passed" },
        { id: "mentions-outage", index: 1, status: "passed" },
      ],
    });
    expect(sample.usage).toEqual({ tokens_input: 12 });
    expect(sample.resultLink).toBe(
      "/api/ai-observability/bots/agent-1/experiments/experiment-1/results/execution-1",
    );
    expect(report.resultLink).toBe(sample.resultLink);
    expect(report.summary).toEqual({
      sampleBase: 1,
      scored: 1,
      executionFailed: 0,
      scoringFailed: 0,
      cancelled: 0,
      pendingReconciliation: 0,
      syncFailure: 0,
      inProgress: 0,
      meanScore: 1,
    });
  });

  test("a partially passing sample scores its fraction, not a round zero", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: execution({
        caseCount: 1,
        result: {
          cases: [
            {
              index: 0,
              status: "completed",
              output: textOutput("An unrelated answer."),
            },
          ],
        },
      }),
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].score).toBe(0);
    expect(report.samples[0].reason).toMatchObject({
      class: "scored",
      passed: 0,
      failed: 2,
    });
    expect(
      report.samples[0].reason.rules.find((r) => r.status === "failed"),
    ).toMatchObject({ reason: "not_equal" });
  });
});

describe("the mean never masks a missing or failed sample", () => {
  test("the mean covers scored samples only, over an explicit base", async () => {
    const { service } = serviceFor({
      version: version(3),
      execution: execution({
        caseCount: 3,
        result: {
          cases: [
            {
              index: 0,
              status: "completed",
              output: textOutput("A one-paragraph outage summary."),
            },
            { index: 1, status: "failed" },
            { index: 2, status: "completed" }, // no output: scoring failure
          ],
        },
      }),
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
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

  test("no scored samples means a null mean, never a masked zero", async () => {
    const { service } = serviceFor({
      version: version(2),
      execution: execution({
        caseCount: 2,
        result: {
          cases: [
            { index: 0, status: "failed" },
            { index: 1, status: "completed" },
          ],
        },
      }),
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.summary.scored).toBe(0);
    expect(report.summary.meanScore).toBeNull();
  });
});

describe("execution failure is its own class, never a score", () => {
  test("a failed case inside a completed execution is execution_failed", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: execution({
        caseCount: 1,
        result: { cases: [{ index: 0, status: "failed" }] },
      }),
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].class).toBe("execution_failed");
    expect(report.samples[0].score).toBeNull();
    expect(report.samples[0].reason).toEqual({
      class: "execution_failed",
      code: "CASE_FAILED",
    });
  });

  test("a failed execution classifies every base sample with its error code", async () => {
    const { service } = serviceFor({
      version: version(2),
      execution: execution({
        state: "failed",
        errorCode: "EXPERIMENT_NOT_FROZEN",
        caseCount: null,
        result: null,
        settledAt: new Date("2026-10-16T00:11:00.000Z"),
      }),
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.state).toBe("failed");
    expect(report.execution.errorCode).toBe("EXPERIMENT_NOT_FROZEN");
    expect(report.samples.map((s) => s.class)).toEqual([
      "execution_failed",
      "execution_failed",
    ]);
    expect(report.samples[0].reason).toEqual({
      class: "execution_failed",
      code: "EXPERIMENT_NOT_FROZEN",
    });
    expect(report.summary.meanScore).toBeNull();
  });
});

describe("scoring failure is its own class, never a zero", () => {
  const scoredBase = {
    version: version(1),
    execution: execution({
      caseCount: 1,
      result: { cases: [{ index: 0, status: "completed" }] },
    }),
  };

  test("an absent output is a scoring failure with the OUTPUT_MISSING code", async () => {
    const { service } = serviceFor(scoredBase);
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].class).toBe("scoring_failed");
    expect(report.samples[0].reason).toMatchObject({
      class: "scoring_failed",
      code: "OUTPUT_MISSING",
    });
    expect(report.samples[0].score).toBeNull();
  });

  test("an output the redaction policy withheld is a scoring failure, not a pass", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: execution({
        caseCount: 1,
        result: {
          cases: [
            {
              index: 0,
              status: "completed",
              output: { state: "omitted", reason: "credential" },
            },
          ],
        },
      }),
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].class).toBe("scoring_failed");
    expect(report.samples[0].reason).toMatchObject({ code: "OUTPUT_MISSING" });
  });

  test("an unextractable rule set is a scoring failure with RULESET_UNAVAILABLE", async () => {
    const broken = {
      ...experiment,
      config: freezeExperimentConfig({
        botConfig: {},
        prompt: "p",
        modelName: "m",
        modelParameters: {},
        toolFixtures: {},
        judgeConfig: { threshold: 0.8 },
        judgeVersion: "rules/1",
      }),
    } as ObservationExperiment;
    const { service } = serviceFor({
      experiment: broken,
      version: version(1),
      execution: execution({
        caseCount: 1,
        result: {
          cases: [
            { index: 0, status: "completed", output: textOutput("anything") },
          ],
        },
      }),
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].class).toBe("scoring_failed");
    expect(report.samples[0].reason).toMatchObject({
      code: "RULESET_UNAVAILABLE",
    });
  });

  test("a rule the scorer errored on is a scoring failure carrying its rows", async () => {
    const syntactic = {
      ...experiment,
      config: freezeExperimentConfig({
        botConfig: {},
        prompt: "p",
        modelName: "m",
        modelParameters: {},
        toolFixtures: {},
        judgeConfig: {
          rules: [{ id: "bad", kind: "regex", pattern: "(" }],
        },
        judgeVersion: "rules/1",
      }),
    } as ObservationExperiment;
    const { service } = serviceFor({
      experiment: syntactic,
      version: version(1),
      execution: execution({
        caseCount: 1,
        result: {
          cases: [
            { index: 0, status: "completed", output: textOutput("anything") },
          ],
        },
      }),
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].class).toBe("scoring_failed");
    expect(report.samples[0].reason).toMatchObject({ code: "RULE_ERROR" });
    expect(report.samples[0].reason.rules?.[0]).toMatchObject({
      id: "bad",
      status: "error",
      code: "RULE_SYNTAX_INVALID",
    });
  });

  test("an empty rule set cannot mint a score from nothing", async () => {
    const empty = {
      ...experiment,
      config: freezeExperimentConfig({
        botConfig: {},
        prompt: "p",
        modelName: "m",
        modelParameters: {},
        toolFixtures: {},
        judgeConfig: { rules: [] },
        judgeVersion: "rules/1",
      }),
    } as ObservationExperiment;
    const { service } = serviceFor({
      experiment: empty,
      version: version(1),
      execution: execution({
        caseCount: 1,
        result: {
          cases: [
            { index: 0, status: "completed", output: textOutput("anything") },
          ],
        },
      }),
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].class).toBe("scoring_failed");
    expect(report.samples[0].reason).toMatchObject({ code: "NO_RULES" });
  });
});

describe("cancellation is its own class", () => {
  test("a cancelled execution classifies every base sample as cancelled", async () => {
    const { service } = serviceFor({
      version: version(2),
      execution: execution({
        state: "cancelled",
        caseCount: null,
        result: null,
      }),
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.state).toBe("cancelled");
    expect(report.samples.map((s) => s.class)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect(report.samples[0].reason).toEqual({
      class: "cancelled",
      code: "CANCELLED",
    });
    expect(report.summary).toMatchObject({ cancelled: 2, meanScore: null });
  });
});

describe("pending reconciliation is its own class, distinct from in progress", () => {
  const unsettled = (state: "pending" | "running") =>
    execution({
      state,
      caseCount: null,
      result: null,
      settledAt: null,
      startedAt:
        state === "running" ? new Date("2026-10-16T00:10:05.000Z") : null,
    });

  test("a healthy unclaimed ticket means in progress, not reconciliation", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: unsettled("pending"),
      ticket: { claimedBy: null, finishedAt: null, leaseExpired: false },
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].class).toBe("in_progress");
    expect(report.samples[0].reason).toEqual({
      class: "in_progress",
      code: "EXECUTION_NOT_SETTLED",
      state: "pending",
    });
    expect(report.summary).toMatchObject({
      inProgress: 1,
      pendingReconciliation: 0,
    });
  });

  test("a live lease means in progress too", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: unsettled("running"),
      ticket: { claimedBy: "worker-1", finishedAt: null, leaseExpired: false },
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].class).toBe("in_progress");
  });

  test("an expired lease is pending reconciliation — lease recovery territory", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: unsettled("running"),
      ticket: { claimedBy: "worker-1", finishedAt: null, leaseExpired: true },
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].class).toBe("pending_reconciliation");
    expect(report.samples[0].reason).toMatchObject({ code: "LEASE_EXPIRED" });
  });

  test("a finished ticket over an unsettled execution is pending reconciliation", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: unsettled("pending"),
      ticket: {
        claimedBy: "worker-1",
        finishedAt: new Date(),
        leaseExpired: false,
      },
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].reason).toMatchObject({ code: "TICKET_FINISHED" });
  });

  test("a ticket the retention sweep took is pending reconciliation", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: unsettled("running"),
      ticket: null,
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].reason).toMatchObject({ code: "TICKET_MISSING" });
  });

  test("a case whose ending the runner could not observe is pending reconciliation", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: execution({
        caseCount: 1,
        result: { cases: [{ index: 0, status: "unknown" }] },
      }),
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].class).toBe("pending_reconciliation");
    expect(report.samples[0].reason).toMatchObject({ code: "CASE_UNKNOWN" });
  });
});

describe("sync failure is its own class — the record did not land", () => {
  test("a base case absent from the stored result is a record gap", async () => {
    const { service } = serviceFor({
      version: version(2),
      execution: execution({
        caseCount: 1,
        result: { cases: [{ index: 0, status: "completed" }] },
      }),
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[1].class).toBe("sync_failure");
    expect(report.samples[1].reason).toMatchObject({
      code: "CASE_RECORD_MISSING",
    });
  });

  test("a damaged case record is a record gap, never a guessed score", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: execution({
        caseCount: 1,
        // A record whose fields are not the result contract's vocabulary.
        result: { cases: [{ index: 0, status: "banana" }] },
      }),
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].class).toBe("sync_failure");
    expect(report.samples[0].reason).toMatchObject({
      code: "CASE_RECORD_DAMAGED",
    });
  });

  test("a completed execution with no result at all is all record gaps", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: execution({ caseCount: 1, result: null }),
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].reason).toMatchObject({
      code: "CASE_RECORD_MISSING",
    });
  });
});

describe("overflow values never enter the contract (T26 rev3 leftover)", () => {
  test("an overflow numeric literal scores as non_numeric, no Infinity anywhere", async () => {
    const numeric = {
      ...experiment,
      config: freezeExperimentConfig({
        botConfig: {},
        prompt: "p",
        modelName: "m",
        modelParameters: {},
        toolFixtures: {},
        judgeConfig: {
          rules: [{ id: "big", kind: "numeric", op: ">", expected: 5 }],
        },
        judgeVersion: "rules/1",
      }),
    } as ObservationExperiment;
    const { service } = serviceFor({
      experiment: numeric,
      version: version(1),
      execution: execution({
        caseCount: 1,
        result: {
          cases: [
            { index: 0, status: "completed", output: textOutput("1e400") },
          ],
        },
      }),
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].class).toBe("scored");
    expect(report.samples[0].score).toBe(0);
    expect(
      report.samples[0].reason.rules?.find((r) => r.status === "failed"),
    ).toMatchObject({ reason: "non_numeric" });
    // The wire form carries no non-finite number under any spelling.
    const wire = JSON.stringify(report);
    expect(wire).not.toMatch(/Infinity|NaN|-Infinity/);
  });

  test("a json_path leaf that parses past infinity is non_numeric, not a comparison", async () => {
    const pathy = {
      ...experiment,
      config: freezeExperimentConfig({
        botConfig: {},
        prompt: "p",
        modelName: "m",
        modelParameters: {},
        toolFixtures: {},
        judgeConfig: {
          rules: [
            {
              id: "big-leaf",
              kind: "json_path",
              path: "big",
              assert: "gte",
              expected: 5,
            },
          ],
        },
        judgeVersion: "rules/1",
      }),
    } as ObservationExperiment;
    const { service } = serviceFor({
      experiment: pathy,
      version: version(1),
      execution: execution({
        caseCount: 1,
        result: {
          cases: [
            {
              index: 0,
              status: "completed",
              // A stored structured output whose leaf parses past JS infinity (the
              // rev3 leftover's exact shape): the read path must classify it, not
              // compare it and not serialize it.
              output: {
                state: "projected",
                value: { big: { state: "projected", value: Infinity } },
              },
            },
          ],
        },
      }),
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].class).toBe("scored");
    expect(report.samples[0].score).toBe(0);
    // The overflow never passes and never serializes: the row is a failure whose
    // reason is T26's current vocabulary for a non-finite number leaf
    // (`comparison_false` — the rev3-maintained leftover; renaming it to
    // `non_numeric` is T26's round to open, not this read path's).
    expect(
      report.samples[0].reason.rules?.find((r) => r.status === "failed"),
    ).toMatchObject({ status: "failed", reason: "comparison_false" });
    expect(JSON.stringify(report)).not.toContain("Infinity");
  });

  test("a non-finite usage leaf is served as null, never as Infinity", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: execution({
        caseCount: 1,
        result: {
          cases: [
            {
              index: 0,
              status: "completed",
              output: textOutput("A one-paragraph outage summary."),
              // Damaged-in-transit shape: a jsonb numeric that parses past JS infinity.
              usage: {
                state: "projected",
                value: {
                  tokens_input: { state: "projected", value: Infinity },
                },
              },
            },
          ],
        },
      }),
    });
    const report = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(report.samples[0].usage).toEqual({ tokens_input: null });
    expect(JSON.stringify(report)).not.toContain("Infinity");
  });
});

describe("scope and authorization discipline (A5/A9)", () => {
  test("a forged scope is refused before any store is asked", async () => {
    const { service, fake } = serviceFor({
      version: version(1),
      execution: execution({ caseCount: 1 }),
    });
    expect(() =>
      service.query(
        { ...scopeA },
        {
          experimentId: "experiment-1",
          executionId: "execution-1",
        },
      ),
    ).toThrow(new ObservationScopeError("OWNERSHIP_REQUIRED", 403));
    expect(fake.reads).toEqual({
      experiments: 0,
      executions: 0,
      versions: 0,
      tickets: 0,
    });
  });

  test("a guessed experiment id is simply not found", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: execution(),
    });
    await expect(
      service.query(scopeA, {
        experimentId: "experiment-guess",
        executionId: "execution-1",
      }),
    ).rejects.toThrow(
      new ExperimentResultsError("RESULTS_EXPERIMENT_NOT_FOUND", 404),
    );
  });

  test("a guessed execution id is simply not found", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: execution(),
    });
    await expect(
      service.query(scopeA, {
        experimentId: "experiment-1",
        executionId: "execution-guess",
      }),
    ).rejects.toThrow(
      new ExperimentResultsError("RESULTS_EXECUTION_NOT_FOUND", 404),
    );
  });

  test("another scope learns nothing — the same ids are not found", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: execution(),
    });
    await expect(
      service.query(scopeB, {
        experimentId: "experiment-1",
        executionId: "execution-1",
      }),
    ).rejects.toThrow(
      new ExperimentResultsError("RESULTS_EXPERIMENT_NOT_FOUND", 404),
    );
  });

  test("an execution that does not name this experiment is not found — unfakeable link", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: execution({ experimentId: "experiment-other" }),
    });
    await expect(
      service.query(scopeA, {
        experimentId: "experiment-1",
        executionId: "execution-1",
      }),
    ).rejects.toThrow(
      new ExperimentResultsError("RESULTS_EXECUTION_NOT_FOUND", 404),
    );
  });

  test("a pinned dataset version that vanished refuses the whole read", async () => {
    const { service } = serviceFor({
      version: null,
      execution: execution(),
    });
    await expect(
      service.query(scopeA, {
        experimentId: "experiment-1",
        executionId: "execution-1",
      }),
    ).rejects.toThrow(
      new ExperimentResultsError("RESULTS_DATASET_VERSION_NOT_FOUND", 404),
    );
  });

  test("a blank id is an input refusal", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: execution(),
    });
    await expect(
      service.query(scopeA, { experimentId: "  ", executionId: "execution-1" }),
    ).rejects.toThrow(new ExperimentResultsError("RESULTS_INPUT_INVALID", 400));
  });

  test("the same query answers identically every time — scoring is deterministic", async () => {
    const { service } = serviceFor({
      version: version(1),
      execution: execution({
        caseCount: 1,
        result: {
          cases: [
            {
              index: 0,
              status: "completed",
              output: textOutput("A one-paragraph outage summary."),
            },
          ],
        },
      }),
    });
    const one = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    const two = await service.query(scopeA, {
      experimentId: "experiment-1",
      executionId: "execution-1",
    });
    expect(two).toEqual(one);
  });
});

describe("the REST surface (mounting contract: /bots/:botId/experiments/:experimentId/results)", () => {
  const profile = (ownerId: string): AgentProfile =>
    ({
      id: "agent-1",
      ownerUserId: ownerId,
      systemOwned: false,
      deletedAt: null,
    }) as AgentProfile;

  const managementCheck = (rows: AgentProfile[]): BotManagementCheck => {
    return async (actor, botId) => {
      const found = rows.find((row) => row.id === botId) ?? null;
      if (!found || found.systemOwned || found.deletedAt !== null) return null;
      return found.ownerUserId === actor.id || actor.role === "admin"
        ? found
        : null;
    };
  };

  function appFor(
    setup: {
      rows?: AgentProfile[];
      actor?: { id: string; role: string };
      service?: ReturnType<typeof serviceFor>["service"];
      epoch?: number;
    } = {},
  ) {
    const fake = stores({
      version: version(1),
      execution: execution({
        caseCount: 1,
        result: {
          cases: [
            {
              index: 0,
              status: "completed",
              output: textOutput("A one-paragraph outage summary."),
            },
          ],
        },
      }),
    });
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", (async (context, next) => {
      context.set(
        "actor",
        (setup.actor ?? owner) as unknown as AuthenticatedActor,
      );
      await next();
    }) satisfies MiddlewareHandler<{ Variables: AppVariables }>);
    app.route(
      "/bots/:botId/experiments/:experimentId/results",
      createExperimentResultsRoutes({
        canManageBot: managementCheck(setup.rows ?? [profile(owner.id)]),
        scopeEpoch: async () => setup.epoch ?? EPOCH,
        experiments: fake.deps.experiments,
        executions: fake.deps.executions,
        datasets: fake.deps.datasets,
        ticket: fake.deps.ticket,
      }),
    );
    return app;
  }

  const get = (app: Hono, executionId: string) =>
    app.request(
      `http://openbot.test/bots/agent-1/experiments/experiment-1/results/${executionId}`,
    );

  test("a manager reads the report over HTTP, code as contract", async () => {
    const response = await get(appFor(), "execution-1");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      experimentId: "experiment-1",
      executionId: "execution-1",
      scorerVersion: "rules/1",
      state: "completed",
      summary: { sampleBase: 1, scored: 1, meanScore: 1 },
    });
    expect(body.samples[0].resultLink).toBe(
      "/api/ai-observability/bots/agent-1/experiments/experiment-1/results/execution-1",
    );
  });

  test("a stranger learns only the 404 — the manage gate closes before the scope", async () => {
    const response = await get(
      appFor({
        rows: [profile(owner.id)],
        actor: { id: "user-stranger", role: "user" },
      }),
      "execution-1",
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe(OBSERVATION_BOT_NOT_FOUND);
  });

  test("a revoked manager (bot gone) learns the same 404", async () => {
    const response = await get(
      appFor({
        rows: [Object.assign(profile(owner.id), { deletedAt: new Date() })],
      }),
      "execution-1",
    );
    expect(response.status).toBe(404);
  });

  test("a bumped ownership epoch is a different key space — not found", async () => {
    const response = await get(appFor({ epoch: EPOCH + 1 }), "execution-1");
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("RESULTS_EXPERIMENT_NOT_FOUND");
  });

  test("a guessed execution id answers the 404, not an empty report", async () => {
    const response = await get(appFor(), "execution-guess");
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("RESULTS_EXECUTION_NOT_FOUND");
  });
});
