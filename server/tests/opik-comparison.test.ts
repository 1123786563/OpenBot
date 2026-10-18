// Issue #35 / DAG T29 — the experiment comparison interface and its compatibility verdict.
//
// Every case here runs against injected stores, exactly like the T28 suite: no database, no
// network. The fake stores hold TWO experiments and TWO executions (a baseline and a
// candidate) so one comparison exercises both sides of the ledger. The behavioral proofs
// against a real database — settle through the real projection, the mounted route table,
// scope isolation at the SQL layer — live in opik-comparison.integration.test.ts.
//
// The acceptance under test, in issue order:
//   1. only experiments over the same frozen sample set (dataset content hash) and the same
//      scoring definition (judgeVersion + judgeConfig) are comparable; an incompatible pair
//      answers the per-field diff ledger and never a quality winner.
//   2. completion rate, valid scores, execution/scoring failures, per-sample delta, timing
//      and actual usage; a missing value is never a 0 and never silently dropped.
//   3. regressed samples link to the safe case and both execution records; the classes and
//      codes stay the T28 vocabulary — unknown stays unknown, nothing is explained away.
//   4. both sides pass the current scope/Bot authorization; rule experiments compare without
//      any model judge.
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfile } from "../src/agents/profile-types";
import {
  createExperimentComparisonService,
  ExperimentComparisonError,
} from "../src/ai-observability/comparison";
import {
  type BotManagementCheck,
  OBSERVATION_BOT_NOT_FOUND,
} from "../src/ai-observability/context";
import { ObservationScopeError } from "../src/ai-observability/contracts";
import type { ObservationDatasetVersion } from "../src/ai-observability/datasets";
import type { ObservationExecution } from "../src/ai-observability/executions";
import type { ObservationExperiment } from "../src/ai-observability/experiments";
import { freezeExperimentConfig } from "../src/ai-observability/experiments";
import { ExperimentResultsError } from "../src/ai-observability/results";
import { createExperimentComparisonRoutes } from "../src/ai-observability/routes/comparison";
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

const baseConfig = freezeExperimentConfig({
  botConfig: { toolChoice: "auto" },
  prompt: "Answer the support question from the outage report.",
  modelName: "claude-sonnet-5",
  modelParameters: { temperature: 0, maxTokens: 1024 },
  toolFixtures: { search: { query: "outage", results: 0 } },
  judgeConfig: RULES,
  judgeVersion: "rules/1",
  readOnlyTools: ["search"],
});

const candidateConfig = freezeExperimentConfig({
  botConfig: { toolChoice: "auto" },
  // The configuration under test differs — that is the experiment's variable, not an
  // incompatibility.
  prompt: "Answer the support question tersely.",
  modelName: "claude-haiku-4-5",
  modelParameters: { temperature: 0, maxTokens: 512 },
  toolFixtures: { search: { query: "outage", results: 0 } },
  judgeConfig: RULES,
  judgeVersion: "rules/1",
  readOnlyTools: ["search", "fetch"],
});

function experiment(
  overrides: Partial<ObservationExperiment>,
): ObservationExperiment {
  return {
    id: "experiment-1",
    scopeKey: scopeA.key,
    actorId: scopeA.actorId,
    botId: scopeA.botId,
    name: "outage-eval",
    datasetVersionId: "version-1",
    datasetContentHash: "c".repeat(64),
    config: baseConfig,
    configHash: "b".repeat(64),
    state: "frozen",
    frozenAt: new Date("2026-10-16T00:00:00.000Z"),
    createdAt: new Date("2026-10-16T00:00:00.000Z"),
    updatedAt: new Date("2026-10-16T00:00:00.000Z"),
    ...overrides,
  } as ObservationExperiment;
}

const baselineExperiment = experiment({
  id: "experiment-base",
  name: "outage-eval-base",
});

const candidateExperiment = experiment({
  id: "experiment-cand",
  name: "outage-eval-candidate",
  config: candidateConfig,
  configHash: "e".repeat(64),
});

const version = (cases: number, id = "version-1"): ObservationDatasetVersion =>
  ({
    id,
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
    experimentId: "experiment-base",
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
  } as ObservationExecution;
}

const textOutput = (text: string) => ({ state: "projected", text }) as const;

/**
 * The stores under the comparison's hands: two experiments, two executions, one or two
 * dataset versions. Every read is scope-keyed exactly like the real stores, so another
 * scope's id is simply not found, and the read counters prove a refusal happened before
 * any store was reached.
 */
function stores(setup: {
  experiments?: readonly ObservationExperiment[];
  versions?: readonly ObservationDatasetVersion[];
  executions?: readonly ObservationExecution[];
  ticket?: {
    claimedBy: string | null;
    finishedAt: Date | null;
    leaseExpired: boolean;
  };
}) {
  const reads = { experiments: 0, executions: 0, versions: 0, tickets: 0 };
  const experimentRows = setup.experiments ?? [
    baselineExperiment,
    candidateExperiment,
  ];
  const versionRows = setup.versions ?? [version(1)];
  const executionRows = setup.executions ?? [];
  return {
    reads,
    deps: {
      experiments: {
        getExperiment: async (scope: { key: string }, id: string) => {
          reads.experiments += 1;
          return (
            experimentRows.find(
              (row) => row.id === id && row.scopeKey === scope.key,
            ) ?? null
          );
        },
      },
      executions: {
        get: async (scope: { key: string }, id: string) => {
          reads.executions += 1;
          return (
            executionRows.find(
              (row) => row.id === id && row.scopeKey === scope.key,
            ) ?? null
          );
        },
      },
      datasets: {
        getVersion: async (scope: { key: string }, id: string) => {
          reads.versions += 1;
          return (
            versionRows.find(
              (row) => row.id === id && row.scopeKey === scope.key,
            ) ?? null
          );
        },
      },
      ticket: async (id: string) => {
        reads.tickets += 1;
        return executionRows.some((row) => row.id === id)
          ? (setup.ticket ?? null)
          : null;
      },
    },
  };
}

function serviceFor(setup: Parameters<typeof stores>[0] = {}) {
  const fake = stores(setup);
  return {
    fake,
    service: createExperimentComparisonService(fake.deps),
  };
}

const bothSides = {
  baseline: { experimentId: "experiment-base", executionId: "execution-base" },
  candidate: { experimentId: "experiment-cand", executionId: "execution-cand" },
};

describe("compatibility: the frozen fields decide, item by item (AC1)", () => {
  test("same sample set and scoring definition compare, despite other config differences", async () => {
    const { service } = serviceFor({
      executions: [
        execution({
          id: "execution-base",
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
        execution({
          id: "execution-cand",
          experimentId: "experiment-cand",
          experimentConfigHash: "e".repeat(64),
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
      ],
    });

    const comparison = await service.compare(scopeA, bothSides);

    expect(comparison.compatibility.compatible).toBe(true);
    const byField = new Map(
      comparison.compatibility.fields.map((one) => [one.field, one]),
    );
    // The three blockers: the frozen sample set and the scoring definition.
    for (const field of [
      "datasetContentHash",
      "judgeVersion",
      "judgeConfig",
    ] as const) {
      expect(byField.get(field)).toMatchObject({ equal: true, blocking: true });
    }
    // The configuration being compared differs — shown, never hidden, never blocking.
    expect(byField.get("modelName")).toMatchObject({
      equal: false,
      blocking: false,
    });
    expect(byField.get("prompt")).toMatchObject({
      equal: false,
      blocking: false,
    });
    expect(byField.get("readOnlyTools")).toMatchObject({
      equal: false,
      blocking: false,
    });
    expect(byField.get("modelName")).toMatchObject({
      baseline: "claude-sonnet-5",
      candidate: "claude-haiku-4-5",
    });
    expect(byField.get("readOnlyTools")).toMatchObject({
      baseline: '["search"]',
      candidate: '["fetch","search"]',
    });
  });

  test("a different dataset content hash answers the diff, not a winner", async () => {
    const otherSet = experiment({
      id: "experiment-cand",
      name: "outage-eval-candidate",
      config: candidateConfig,
      configHash: "e".repeat(64),
      datasetVersionId: "version-2",
      datasetContentHash: "d".repeat(64),
    });
    const { service } = serviceFor({
      experiments: [baselineExperiment, otherSet],
      versions: [version(1), version(1, "version-2")],
      executions: [
        execution({ id: "execution-base", caseCount: 1 }),
        execution({
          id: "execution-cand",
          experimentId: "experiment-cand",
          experimentConfigHash: "e".repeat(64),
          caseCount: 1,
        }),
      ],
    });

    const comparison = await service.compare(scopeA, bothSides);

    expect(comparison.compatibility.compatible).toBe(false);
    const hash = comparison.compatibility.fields.find(
      (one) => one.field === "datasetContentHash",
    );
    expect(hash).toMatchObject({
      baseline: "c".repeat(64),
      candidate: "d".repeat(64),
      equal: false,
      blocking: true,
    });
    // No deltas, no regressions, nothing that reads as a verdict.
    expect(comparison.deltas).toBeNull();
    expect(comparison.regressions).toBeNull();
    // The per-side facts still arrive, honestly labeled as each experiment's own.
    expect(comparison.baseline.report.experimentId).toBe("experiment-base");
    expect(comparison.candidate.report.experimentId).toBe("experiment-cand");
  });

  test("a different judgeVersion is not comparable — the scorers differ", async () => {
    const otherJudge = experiment({
      id: "experiment-cand",
      config: freezeExperimentConfig({
        botConfig: { toolChoice: "auto" },
        prompt: "Answer the support question from the outage report.",
        modelName: "claude-sonnet-5",
        modelParameters: { temperature: 0, maxTokens: 1024 },
        toolFixtures: { search: { query: "outage", results: 0 } },
        judgeConfig: RULES,
        judgeVersion: "rules/2",
        readOnlyTools: ["search"],
      }),
      configHash: "e".repeat(64),
    });
    const { service } = serviceFor({
      experiments: [baselineExperiment, otherJudge],
      executions: [
        execution({ id: "execution-base", caseCount: 1 }),
        execution({
          id: "execution-cand",
          experimentId: "experiment-cand",
          experimentConfigHash: "e".repeat(64),
          caseCount: 1,
        }),
      ],
    });

    const comparison = await service.compare(scopeA, bothSides);
    expect(comparison.compatibility.compatible).toBe(false);
    expect(
      comparison.compatibility.fields.find(
        (one) => one.field === "judgeVersion",
      ),
    ).toMatchObject({
      baseline: "rules/1",
      candidate: "rules/2",
      equal: false,
      blocking: true,
    });
    expect(comparison.deltas).toBeNull();
  });

  test("a withheld judgeVersion cannot even be compared — unknown, not equal", async () => {
    const withheld = { ...candidateConfig } as typeof candidateConfig;
    // A redaction policy that withheld the version leaves nothing to compare on.
    (withheld as { judgeVersion: unknown }).judgeVersion = {
      state: "omitted",
      reason: "credential",
    };
    const otherJudge = experiment({
      id: "experiment-cand",
      config: withheld,
      configHash: "e".repeat(64),
    });
    const { service } = serviceFor({
      experiments: [baselineExperiment, otherJudge],
      executions: [
        execution({ id: "execution-base", caseCount: 1 }),
        execution({
          id: "execution-cand",
          experimentId: "experiment-cand",
          experimentConfigHash: "e".repeat(64),
          caseCount: 1,
        }),
      ],
    });

    const comparison = await service.compare(scopeA, bothSides);
    expect(comparison.compatibility.compatible).toBe(false);
    expect(
      comparison.compatibility.fields.find(
        (one) => one.field === "judgeVersion",
      ),
    ).toMatchObject({ candidate: null, equal: false, blocking: true });
  });

  test("two sides both refused by the redaction policy are never assumed equal (OCR R4-28)", async () => {
    // Both freezes collapsed the same way: the judge config the redaction policy
    // refused on each side. A structural comparison of the envelope shapes would
    // read the two omitted states as "the same scoring definition" and release
    // the blocking field; the textEqual discipline says a refused value is
    // unknown, and unknown is never assumed equal.
    const refused = (source: typeof baseConfig): typeof source => {
      const copy = { ...source } as typeof source;
      (copy as { judgeConfig: unknown }).judgeConfig = {
        state: "omitted",
        reason: "unhandled_free_text",
      };
      return copy;
    };
    const { service } = serviceFor({
      experiments: [
        experiment({ id: "experiment-base", config: refused(baseConfig) }),
        experiment({
          id: "experiment-cand",
          config: refused(candidateConfig),
          configHash: "e".repeat(64),
        }),
      ],
      executions: [
        execution({ id: "execution-base", caseCount: 1 }),
        execution({
          id: "execution-cand",
          experimentId: "experiment-cand",
          experimentConfigHash: "e".repeat(64),
          caseCount: 1,
        }),
      ],
    });

    const comparison = await service.compare(scopeA, bothSides);

    expect(comparison.compatibility.compatible).toBe(false);
    expect(
      comparison.compatibility.fields.find(
        (one) => one.field === "judgeConfig",
      ),
    ).toMatchObject({ equal: false, blocking: true });
    expect(comparison.deltas).toBeNull();
  });

  test("a different judgeConfig (one rule changed) is not comparable", async () => {
    const otherRules = experiment({
      id: "experiment-cand",
      config: freezeExperimentConfig({
        botConfig: { toolChoice: "auto" },
        prompt: "Answer the support question from the outage report.",
        modelName: "claude-sonnet-5",
        modelParameters: { temperature: 0, maxTokens: 1024 },
        toolFixtures: { search: { query: "outage", results: 0 } },
        judgeConfig: {
          rules: [
            {
              id: "greeting",
              kind: "exact_match",
              expected: "Something else entirely.",
            },
            { id: "mentions-outage", kind: "contains", expected: "outage" },
          ],
        },
        judgeVersion: "rules/1",
        readOnlyTools: ["search"],
      }),
      configHash: "e".repeat(64),
    });
    const { service } = serviceFor({
      experiments: [baselineExperiment, otherRules],
      executions: [
        execution({ id: "execution-base", caseCount: 1 }),
        execution({
          id: "execution-cand",
          experimentId: "experiment-cand",
          experimentConfigHash: "e".repeat(64),
          caseCount: 1,
        }),
      ],
    });

    const comparison = await service.compare(scopeA, bothSides);
    expect(comparison.compatibility.compatible).toBe(false);
    const judgeConfig = comparison.compatibility.fields.find(
      (one) => one.field === "judgeConfig",
    );
    expect(judgeConfig).toMatchObject({ equal: false, blocking: true });
    // Structural witnesses are content identities, not echoed payloads.
    expect(judgeConfig?.baseline).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(judgeConfig?.baseline).not.toBe(judgeConfig?.candidate);
  });
});

describe("deltas: completion, valid scores, failures, timing, usage (AC2)", () => {
  /** A mixed board over six frozen cases: one of every direction. */
  function board() {
    return {
      versions: [version(6)],
      executions: [
        execution({
          id: "execution-base",
          caseCount: 6,
          result: {
            cases: [
              // 1 → 0: regressed with a finite delta.
              {
                index: 0,
                status: "completed",
                output: textOutput("A one-paragraph outage summary."),
                usage: {
                  state: "projected",
                  value: { tokens_input: { state: "projected", value: 12 } },
                },
              },
              // 0.5 → 1: improved.
              {
                index: 1,
                status: "completed",
                output: textOutput("outage partial"),
              },
              // 1 → 1: unchanged.
              {
                index: 2,
                status: "completed",
                output: textOutput("A one-paragraph outage summary."),
                usage: {
                  state: "projected",
                  value: { tokens_input: { state: "projected", value: 8 } },
                },
              },
              // scored → case failed: regressed, and the missing score is NOT a 0 delta.
              {
                index: 3,
                status: "completed",
                output: textOutput("A one-paragraph outage summary."),
              },
              // failed → scored: improved.
              { index: 4, status: "failed" },
              // failed → failed: incomparable.
              { index: 5, status: "failed" },
            ],
          },
        }),
        execution({
          id: "execution-cand",
          experimentId: "experiment-cand",
          experimentConfigHash: "e".repeat(64),
          caseCount: 6,
          result: {
            cases: [
              {
                index: 0,
                status: "completed",
                output: textOutput("irrelevant"),
              },
              {
                index: 1,
                status: "completed",
                output: textOutput("A one-paragraph outage summary."),
                usage: {
                  state: "projected",
                  value: { tokens_input: { state: "projected", value: 20 } },
                },
              },
              {
                index: 2,
                status: "completed",
                output: textOutput("A one-paragraph outage summary."),
              },
              { index: 3, status: "failed" },
              {
                index: 4,
                status: "completed",
                output: textOutput("A one-paragraph outage summary."),
              },
              { index: 5, status: "failed" },
            ],
          },
        }),
      ],
    };
  }

  test("per-sample deltas, mean delta, completion, timing and usage coverage", async () => {
    const { service } = serviceFor(board());

    const comparison = await service.compare(scopeA, bothSides);

    expect(comparison.compatibility.compatible).toBe(true);
    expect(comparison.deltas).not.toBeNull();

    // The summary ledger rides each side verbatim (T28 semantics).
    expect(comparison.baseline.report.summary).toEqual({
      sampleBase: 6,
      scored: 4,
      executionFailed: 2,
      scoringFailed: 0,
      cancelled: 0,
      pendingReconciliation: 0,
      syncFailure: 0,
      inProgress: 0,
      meanScore: (1 + 0.5 + 1 + 1) / 4,
    });
    expect(comparison.candidate.report.summary).toMatchObject({
      scored: 4,
      executionFailed: 2,
    });

    // Completion: every sample settled on both sides of this board.
    expect(comparison.baseline.completionRate).toBe(1);
    expect(comparison.candidate.completionRate).toBe(1);

    // The mean delta is the arithmetic difference of the two means.
    expect(comparison.deltas?.meanScore).toEqual({
      baseline: (1 + 0.5 + 1 + 1) / 4,
      candidate: (0 + 1 + 1 + 1) / 4,
      delta: (0 + 1 + 1 + 1) / 4 - (1 + 0.5 + 1 + 1) / 4,
    });

    const rows = comparison.deltas?.perSample ?? [];
    expect(rows.map((row) => row.direction)).toEqual([
      "regressed", // 1 → 0
      "improved", // 0.5 → 1
      "unchanged", // 1 → 1
      "regressed", // scored → case failed
      "improved", // failed → scored
      "incomparable", // failed → failed
    ]);
    expect(rows[0].scoreDelta).toBe(-1);
    expect(rows[1].scoreDelta).toBe(0.5);
    expect(rows[2].scoreDelta).toBe(0);
    // A missing candidate score is never a −1 or a 0: the delta stays null.
    expect(rows[3].scoreDelta).toBeNull();
    expect(rows[3].candidate).toEqual({
      class: "execution_failed",
      score: null,
    });
    expect(rows[4].scoreDelta).toBeNull();
    expect(rows[5].scoreDelta).toBeNull();

    // Timing: both sides settled, so both name their wall-clock span.
    expect(comparison.baseline.timing.durationMs).toBe(55_000);
    expect(comparison.candidate.timing.durationMs).toBe(55_000);

    // Usage: baseline reported two, candidate one — missing stays counted, not dropped.
    expect(comparison.baseline.usage).toEqual({ reported: 2, missing: 4 });
    expect(comparison.candidate.usage).toEqual({ reported: 1, missing: 5 });
    // The actual values ride the embedded T28 samples.
    expect(comparison.baseline.report.samples[0].usage).toEqual({
      tokens_input: 12,
    });
  });

  test("an unsettled side names its rate honestly and never a masked zero", async () => {
    const { service } = serviceFor({
      versions: [version(1)],
      executions: [
        execution({
          id: "execution-base",
          caseCount: 1,
          state: "pending",
          result: null,
          startedAt: null,
          settledAt: null,
        }),
        execution({
          id: "execution-cand",
          experimentId: "experiment-cand",
          experimentConfigHash: "e".repeat(64),
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
      ],
      ticket: { claimedBy: null, finishedAt: null, leaseExpired: false },
    });

    const comparison = await service.compare(scopeA, bothSides);

    expect(comparison.compatibility.compatible).toBe(true);
    expect(comparison.baseline.completionRate).toBe(0);
    expect(comparison.candidate.completionRate).toBe(1);
    // An unsettled execution has no wall-clock span: null, not 0.
    expect(comparison.baseline.timing.durationMs).toBeNull();
    expect(comparison.baseline.timing.startedAt).toBeNull();
    // The baseline mean is null and the delta stays null — never a −1 verdict.
    expect(comparison.deltas?.meanScore).toEqual({
      baseline: null,
      candidate: 1,
      delta: null,
    });
    // The still-running baseline sample masquerades neither as improved against nor
    // regressed: its settlement is still open, so the direction stays incomparable.
    expect(comparison.deltas?.perSample[0]).toMatchObject({
      baseline: { class: "in_progress" },
      candidate: { class: "scored" },
      direction: "incomparable",
      scoreDelta: null,
    });
    expect(comparison.regressions).toEqual([]);
  });
});

describe("regressions: the safe case and both execution records (AC3)", () => {
  test("a regressed sample links the frozen case and both T28 result links", async () => {
    const { service } = serviceFor({
      versions: [version(1)],
      executions: [
        execution({
          id: "execution-base",
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
        execution({
          id: "execution-cand",
          experimentId: "experiment-cand",
          experimentConfigHash: "e".repeat(64),
          caseCount: 1,
          result: { cases: [{ index: 0, status: "failed" }] },
        }),
      ],
    });

    const comparison = await service.compare(scopeA, bothSides);

    expect(comparison.regressions).toHaveLength(1);
    const regression = comparison.regressions?.[0];
    expect(regression?.index).toBe(0);
    // The safe case: the frozen dataset version and its content hash.
    expect(regression?.case).toEqual({
      datasetVersionId: "version-1",
      contentHash: "c".repeat(64),
    });
    // Both execution records, through the links T28 mints from the rows it read.
    expect(regression?.baseline.resultLink).toBe(
      "/api/ai-observability/bots/agent-1/experiments/experiment-base/results/execution-base",
    );
    expect(regression?.candidate.resultLink).toBe(
      "/api/ai-observability/bots/agent-1/experiments/experiment-cand/results/execution-cand",
    );
    // The vocabulary stays the T28 classes: a terminal failure keeps its own code,
    // and no story is minted the records do not already tell.
    expect(regression?.baseline).toMatchObject({
      class: "scored",
      score: 1,
      code: null,
    });
    expect(regression?.candidate).toMatchObject({
      class: "execution_failed",
      score: null,
      code: "CASE_FAILED",
    });
    expect(JSON.stringify(regression)).not.toMatch(/Infinity|NaN/);
  });

  test("a scoring failure regression keeps its own code, distinct from execution failure", async () => {
    const { service } = serviceFor({
      versions: [version(1)],
      executions: [
        execution({
          id: "execution-base",
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
        execution({
          id: "execution-cand",
          experimentId: "experiment-cand",
          experimentConfigHash: "e".repeat(64),
          caseCount: 1,
          result: {
            cases: [
              // metrics-only: the redaction policy withheld the output.
              {
                index: 0,
                status: "completed",
                output: { state: "omitted", reason: "credential" },
              },
            ],
          },
        }),
      ],
    });

    const comparison = await service.compare(scopeA, bothSides);
    expect(comparison.regressions?.[0]?.candidate).toMatchObject({
      class: "scoring_failed",
      code: "OUTPUT_MISSING",
    });
  });

  test("non-terminal samples masquerade neither as regressions nor as improvements", async () => {
    // The paired board the T31 fix owes: still-open samples (in-flight and
    // awaiting-reconciliation) mixed with terminal ones. The open ones keep the
    // fail-closed `incomparable` and stay out of regressions; the terminal
    // failures still count, scorelessly.
    const { service } = serviceFor({
      versions: [version(4)],
      executions: [
        execution({
          id: "execution-base",
          caseCount: 4,
          result: {
            cases: [
              // scored.
              {
                index: 0,
                status: "completed",
                output: textOutput("A one-paragraph outage summary."),
              },
              // scored.
              {
                index: 1,
                status: "completed",
                output: textOutput("A one-paragraph outage summary."),
              },
              // awaiting reconciliation.
              { index: 2, status: "unknown" },
              // scored.
              {
                index: 3,
                status: "completed",
                output: textOutput("A one-paragraph outage summary."),
              },
            ],
          },
        }),
        execution({
          id: "execution-cand",
          experimentId: "experiment-cand",
          experimentConfigHash: "e".repeat(64),
          caseCount: 4,
          result: {
            cases: [
              // Awaiting reconciliation: the verdict is still open, not a regression.
              { index: 0, status: "unknown" },
              // A terminal execution failure: a regression without a fabricated score.
              { index: 1, status: "failed" },
              // Scored against an open baseline: not an improvement.
              {
                index: 2,
                status: "completed",
                output: textOutput("A one-paragraph outage summary."),
              },
              // 1 → 0.5: the regressed sample with a finite delta.
              {
                index: 3,
                status: "completed",
                output: textOutput("outage partial"),
              },
            ],
          },
        }),
      ],
    });

    const comparison = await service.compare(scopeA, bothSides);

    expect(comparison.deltas?.perSample.map((row) => row.direction)).toEqual([
      "incomparable", // scored → pending_reconciliation
      "regressed", // scored → terminal execution failure
      "incomparable", // pending_reconciliation → scored
      "regressed", // 1 → 0.5
    ]);
    // Only the terminal regressions ride the list; neither open sample is a member.
    expect(comparison.regressions?.map((row) => row.index)).toEqual([1, 3]);
    expect(comparison.deltas?.perSample[3]?.scoreDelta).toBe(-0.5);
    for (const row of comparison.regressions ?? []) {
      for (const side of [row.baseline, row.candidate]) {
        expect(side.class).not.toBe("in_progress");
        expect(side.class).not.toBe("pending_reconciliation");
      }
    }
  });
});

describe("scope and authorization discipline (AC4, spec A5/A9)", () => {
  const settled = [
    execution({
      id: "execution-base",
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
    execution({
      id: "execution-cand",
      experimentId: "experiment-cand",
      experimentConfigHash: "e".repeat(64),
      caseCount: 1,
      result: {
        cases: [
          { index: 0, status: "completed", output: textOutput("outage") },
        ],
      },
    }),
  ];

  test("a forged scope is refused before any store is asked", async () => {
    const { service, fake } = serviceFor({ executions: settled });
    expect(() => service.compare({ ...scopeA }, bothSides)).toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
    expect(fake.reads).toEqual({
      experiments: 0,
      executions: 0,
      versions: 0,
      tickets: 0,
    });
  });

  test("a guessed baseline experiment id is simply not found", async () => {
    const { service } = serviceFor({ executions: settled });
    await expect(
      service.compare(scopeA, {
        baseline: { ...bothSides.baseline, experimentId: "experiment-guess" },
        candidate: bothSides.candidate,
      }),
    ).rejects.toThrow(
      new ExperimentResultsError("RESULTS_EXPERIMENT_NOT_FOUND", 404),
    );
  });

  test("a guessed candidate execution id is simply not found", async () => {
    const { service } = serviceFor({ executions: settled });
    await expect(
      service.compare(scopeA, {
        baseline: bothSides.baseline,
        candidate: { ...bothSides.candidate, executionId: "execution-guess" },
      }),
    ).rejects.toThrow(
      new ExperimentResultsError("RESULTS_EXECUTION_NOT_FOUND", 404),
    );
  });

  test("another scope learns nothing — the same ids are not found", async () => {
    const { service } = serviceFor({ executions: settled });
    await expect(service.compare(scopeB, bothSides)).rejects.toThrow(
      new ExperimentResultsError("RESULTS_EXPERIMENT_NOT_FOUND", 404),
    );
  });

  test("a candidate execution that does not name its experiment is not found", async () => {
    const mismatched = execution({
      id: "execution-cand",
      // Names the baseline's experiment: the unfakeable back-link refuses it.
      experimentId: "experiment-base",
      experimentConfigHash: "e".repeat(64),
      caseCount: 1,
    });
    const { service } = serviceFor({ executions: [settled[0], mismatched] });
    await expect(service.compare(scopeA, bothSides)).rejects.toThrow(
      new ExperimentResultsError("RESULTS_EXECUTION_NOT_FOUND", 404),
    );
  });

  test("a blank id is an input refusal", async () => {
    const { service } = serviceFor({ executions: settled });
    await expect(
      service.compare(scopeA, {
        baseline: { experimentId: " ", executionId: "execution-base" },
        candidate: bothSides.candidate,
      }),
    ).rejects.toThrow(
      new ExperimentComparisonError("COMPARISON_INPUT_INVALID", 400),
    );
  });
});

describe("storage damage: an equal hash with a diverged sample base refuses", () => {
  test("the compatible ledger over diverged frozen bases answers a controlled 502, never a TypeError", async () => {
    // Direct-write damage the freeze pipeline cannot produce (the T29-rev L-2 probe):
    // both experiment rows claim the same content hash, but the versions they pin
    // froze different numbers of cases — index N is no longer the same case on both
    // sides. The read side refuses with its code, the same discipline
    // readStoredCases keeps for damaged case records.
    const { service } = serviceFor({
      experiments: [
        experiment({
          id: "experiment-base",
          name: "outage-eval-base",
          datasetVersionId: "version-6",
        }),
        experiment({
          id: "experiment-cand",
          name: "outage-eval-candidate",
          config: candidateConfig,
          configHash: "e".repeat(64),
          datasetVersionId: "version-4",
        }),
      ],
      versions: [version(6, "version-6"), version(4, "version-4")],
      executions: [
        execution({
          id: "execution-base",
          caseCount: 6,
          result: {
            cases: Array.from({ length: 6 }, (_, index) => ({
              index,
              status: "completed",
              output: textOutput("A one-paragraph outage summary."),
            })),
          },
        }),
        execution({
          id: "execution-cand",
          experimentId: "experiment-cand",
          experimentConfigHash: "e".repeat(64),
          caseCount: 4,
          result: {
            cases: Array.from({ length: 4 }, (_, index) => ({
              index,
              status: "completed",
              output: textOutput("A one-paragraph outage summary."),
            })),
          },
        }),
      ],
    });
    let thrown: unknown = null;
    try {
      await service.compare(scopeA, bothSides);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExperimentComparisonError);
    expect((thrown as ExperimentComparisonError).code).toBe(
      "COMPARISON_SAMPLE_BASE_DIVERGED",
    );
    expect((thrown as ExperimentComparisonError).status).toBe(502);
  });
});

describe("the REST surface (mounting contract: /bots/:botId/experiment-comparisons)", () => {
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
      epoch?: number;
    } = {},
  ) {
    const fake = stores({
      executions: [
        execution({
          id: "execution-base",
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
        execution({
          id: "execution-cand",
          experimentId: "experiment-cand",
          experimentConfigHash: "e".repeat(64),
          caseCount: 1,
          result: {
            cases: [{ index: 0, status: "failed" }],
          },
        }),
      ],
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
      "/bots/:botId/experiment-comparisons",
      createExperimentComparisonRoutes({
        canManageBot: managementCheck(setup.rows ?? [profile(owner.id)]),
        scopeEpoch: async () => setup.epoch ?? EPOCH,
        ...fake.deps,
      }),
    );
    return app;
  }

  const query =
    "?baselineExperimentId=experiment-base&baselineExecutionId=execution-base" +
    "&candidateExperimentId=experiment-cand&candidateExecutionId=execution-cand";

  test("a manager reads the comparison over HTTP, code as contract", async () => {
    const response = await appFor().request(
      `http://openbot.test/bots/agent-1/experiment-comparisons${query}`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      compatibility: { compatible: true },
      baseline: {
        experimentId: "experiment-base",
        executionId: "execution-base",
      },
      candidate: {
        experimentId: "experiment-cand",
        executionId: "execution-cand",
      },
    });
    expect(body.regressions).toHaveLength(1);
    expect(body.regressions[0].candidate).toMatchObject({
      class: "execution_failed",
      code: "CASE_FAILED",
    });
  });

  test("a missing query parameter is an input refusal, not an empty side", async () => {
    const response = await appFor().request(
      "http://openbot.test/bots/agent-1/experiment-comparisons?baselineExperimentId=experiment-base",
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("COMPARISON_INPUT_INVALID");
  });

  test("a stranger learns only the 404 — the manage gate closes first", async () => {
    const response = await appFor({
      rows: [profile(owner.id)],
      actor: { id: "user-stranger", role: "user" },
    }).request(
      `http://openbot.test/bots/agent-1/experiment-comparisons${query}`,
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe(OBSERVATION_BOT_NOT_FOUND);
  });

  test("a bumped ownership epoch is a different key space — not found", async () => {
    const response = await appFor({ epoch: EPOCH + 1 }).request(
      `http://openbot.test/bots/agent-1/experiment-comparisons${query}`,
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("RESULTS_EXPERIMENT_NOT_FOUND");
  });
});
