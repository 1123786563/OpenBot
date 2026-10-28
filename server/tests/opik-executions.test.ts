import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REDACTION_POLICY_VERSION } from "../../shared/ai-observability";
import { ObservationScopeError } from "../src/ai-observability/contracts";
import {
  createEvaluationToolGate,
  createExperimentExecutionService,
  ExecutionError,
  isTerminalExecutionState,
  parseExecutionState,
} from "../src/ai-observability/executions";
import {
  createObservationExperimentStore,
  ExperimentStoreError,
  experimentConfigHash,
  freezeExperimentConfig,
} from "../src/ai-observability/experiments";
import { resolveObservationScope } from "../src/ai-observability/scope";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

/**
 * Unit contract of the isolated execution surface (Issue #29 / DAG T23): the fail-closed
 * state vocabulary, the tool gate that refuses every production write (and every unknown
 * tool) in the evaluation context, the whitelist the frozen configuration carries, and the
 * budget precheck that refuses to start an execution the billing seam will not cover. The
 * behavioral proofs against a real database live in opik-executions.integration.test.ts.
 */

const trusted = resolveObservationScope({
  actorId: "user-a",
  botId: "agent-1",
  ownership: "owner",
  epoch: 1,
});

const config = {
  botConfig: { toolChoice: "auto" },
  prompt: "Answer the support question from the outage report.",
  modelName: "claude-sonnet-5",
  modelParameters: { temperature: 0, maxTokens: 1024 },
  toolFixtures: { search: { query: "outage", results: 0 } },
  judgeConfig: { type: "llm-judge", threshold: 0.8 },
  judgeVersion: "judge/1",
  readOnlyTools: ["search", "fetch"],
};

/** A classifier in the tests' pocket: exactly the two whitelisted names read, all else write. */
const searchReads = (toolName: string) =>
  toolName === "search" || toolName === "fetch" ? "read" : "write";

const frozen = freezeExperimentConfig(config);

describe("the execution state vocabulary is fail-closed", () => {
  test("accepts exactly pending/running/completed/failed/cancelled", () => {
    for (const state of [
      "pending",
      "running",
      "completed",
      "failed",
      "cancelled",
    ]) {
      expect(parseExecutionState(state)).toBe(state);
    }
  });

  test("refuses a stored value outside the vocabulary — including the export word queued", () => {
    for (const state of ["queued", "done", "", "RUNNING", null, 1]) {
      expect(() => parseExecutionState(state)).toThrow(
        new ExecutionError("EXECUTION_STATE_INVALID", 500),
      );
    }
  });

  test("terminal means completed, failed or cancelled", () => {
    expect(["pending", "running"].map(isTerminalExecutionState)).toEqual([
      false,
      false,
    ]);
    expect(
      ["completed", "failed", "cancelled"].map(isTerminalExecutionState),
    ).toEqual([true, true, true]);
  });
});

describe("the evaluation tool gate", () => {
  const gate = createEvaluationToolGate(frozen, searchReads);
  const caseFixtures = freezeExperimentConfig({
    ...config,
    toolFixtures: { search: { query: "outage", results: 3 } },
  }).toolFixtures;

  test("replays the frozen fixture for a whitelisted read-only tool", () => {
    const call = gate.call("search", [caseFixtures, frozen.toolFixtures]);
    // The fixture is the frozen projection: SafeValue envelopes all the way down,
    // exactly as the freeze stored it. The case runner unwraps; the gate never does.
    expect(call).toEqual({
      outcome: "replayed",
      fixture: {
        state: "projected",
        value: {
          query: { state: "projected", value: "outage" },
          results: { state: "projected", value: 3 },
        },
      },
    });
  });

  test("falls back to the experiment configuration's fixtures when the case holds none", () => {
    const call = gate.call("search", [
      freezeExperimentConfig({ ...config, toolFixtures: {} }).toolFixtures,
      frozen.toolFixtures,
    ]);
    expect(call).toEqual({
      outcome: "replayed",
      fixture: {
        state: "projected",
        value: {
          query: { state: "projected", value: "outage" },
          results: { state: "projected", value: 0 },
        },
      },
    });
  });

  test("refuses a tool the whitelist never named — the unknown-tool fail-closed", () => {
    for (const name of ["calendar_create", "totally_unheard_of", "Search"]) {
      expect(gate.call(name, [caseFixtures, frozen.toolFixtures])).toEqual({
        outcome: "refused",
        reason: "not_whitelisted",
      });
    }
  });

  test("refuses a whitelisted name the classifier still calls a write", () => {
    const writeSearch = () => "write" as const;
    const refusing = createEvaluationToolGate(frozen, writeSearch);
    expect(
      refusing.call("search", [caseFixtures, frozen.toolFixtures]),
    ).toEqual({ outcome: "refused", reason: "write_tool" });
  });

  test("refuses a whitelisted read with no frozen fixture anywhere", () => {
    expect(gate.call("fetch", [caseFixtures, frozen.toolFixtures])).toEqual({
      outcome: "refused",
      reason: "no_fixture",
    });
  });

  test("a configuration frozen before the whitelist existed reads as empty, not permissive", () => {
    const before = createEvaluationToolGate(
      // The T22 frozen shape: no readOnlyTools field on rows the older submit wrote.
      { ...frozen, readOnlyTools: undefined } as typeof frozen,
      searchReads,
    );
    expect(before.call("search", [frozen.toolFixtures])).toEqual({
      outcome: "refused",
      reason: "not_whitelisted",
    });
  });

  test("counts every refusal and names the distinct tools it refused", () => {
    const counted = createEvaluationToolGate(frozen, searchReads);
    counted.call("search", [frozen.toolFixtures]);
    counted.call("calendar_create", [frozen.toolFixtures]);
    counted.call("calendar_create", [frozen.toolFixtures]);
    counted.call("browser_navigate", [frozen.toolFixtures]);
    expect(counted.tally()).toEqual({
      rejections: 3,
      rejectedTools: ["browser_navigate", "calendar_create"],
    });
  });
});

describe("the whitelist is part of the frozen configuration", () => {
  test("canonicalizes to a sorted, deduplicated projected list", () => {
    expect(
      freezeExperimentConfig({
        ...config,
        readOnlyTools: ["fetch", "search", "fetch"],
      }).readOnlyTools,
    ).toEqual(frozen.readOnlyTools);
  });

  test("an absent whitelist is an empty one, never an inherited one", () => {
    const { readOnlyTools: _absent, ...without } = config;
    expect(
      freezeExperimentConfig(without as typeof config).readOnlyTools,
    ).toEqual([]);
  });

  test("refuses a whitelist that is not a bounded list of non-blank names", () => {
    // Routed through the store, like every other input refusal: the check precedes
    // any query, so a store over an empty database proves it never reached one.
    const store = createObservationExperimentStore({} as never);
    for (const bad of [
      "search" as unknown,
      ["search", 7] as unknown,
      ["search", " "] as unknown,
      Array.from({ length: 65 }, () => "tool") as unknown,
    ]) {
      expect(() =>
        store.saveDraft(trusted, {
          name: "outage-eval",
          datasetVersionId: "version-1",
          config: { ...config, readOnlyTools: bad },
        }),
      ).toThrow(new ExperimentStoreError("EXPERIMENT_INPUT_INVALID", 400));
    }
  });

  test("a different whitelist is a different experiment", () => {
    const other = freezeExperimentConfig({
      ...config,
      readOnlyTools: ["search", "fetch", "calendar_read"],
    });
    expect(
      experimentConfigHash("version-1", other, REDACTION_POLICY_VERSION),
    ).not.toBe(
      experimentConfigHash("version-1", frozen, REDACTION_POLICY_VERSION),
    );
  });
});

describe("the budget precheck gates the start, not the settle", () => {
  test("a refused precheck answers EXECUTION_BUDGET_REFUSED and never reaches the store", async () => {
    const enqueued: unknown[] = [];
    const service = createExperimentExecutionService({
      executions: {
        enqueue: async (...args: unknown[]) => {
          enqueued.push(args);
          return {} as never;
        },
      },
      billing: {
        precheck: async () => ({ allowed: false as const }),
      },
    });
    await expect(service.start(trusted, "experiment-1")).rejects.toThrow(
      new ExecutionError("EXECUTION_BUDGET_REFUSED", 402),
    );
    expect(enqueued).toEqual([]);
  });

  test("an allowed precheck starts exactly one enqueue", async () => {
    const enqueued: unknown[] = [];
    const service = createExperimentExecutionService({
      executions: {
        enqueue: async (...args: unknown[]) => {
          enqueued.push(args);
          return {} as never;
        },
      },
      billing: {
        precheck: async () => ({ allowed: true as const }),
      },
    });
    await service.start(trusted, "experiment-1");
    expect(enqueued).toEqual([[trusted, "experiment-1"]]);
  });

  test("a forged scope is refused before the billing seam is asked", async () => {
    let asked = 0;
    const service = createExperimentExecutionService({
      executions: {
        enqueue: async () => ({}) as never,
      },
      billing: {
        precheck: async () => {
          asked += 1;
          return { allowed: true as const };
        },
      },
    });
    expect(() => service.start({ ...trusted }, "experiment-1")).toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
    expect(asked).toBe(0);
  });
});

describe("the revocation seam composition (R5-25)", () => {
  test("the boot composes the audited executions cancel into the revoke seam", () => {
    // R5-25: cancelExecutionsForActor's docblock promised "the audited
    // revocation seam", but the boot's aiObservabilityCancelForActor composed
    // only the export store's cancelForActor (T34 §6) — a revoked person's
    // pending/running executions kept running under an authorization that no
    // longer exists, and the settle audit rows the seam exists to leave were
    // unreachable from production. The boot now composes both halves of the
    // same seam. The pin reads index.ts because the composition exists in
    // exactly one place and no injected fake can observe it (the R2-59
    // precedent); the export half stays first so the T34 §6 behavior and its
    // ordering are unchanged.
    const source = readFileSync(join(hereDir, "..", "src", "index.ts"), "utf8");
    expect(source).toMatch(
      /aiObservabilityCancelForActor:\s*async\s*\(actorId\)\s*=>\s*\{[\s\S]*?observationExportStore\.cancelForActor\(actorId\)[\s\S]*?cancelExecutionsForActor\(/,
    );
  });
});
