import { afterAll, describe, expect, test } from "bun:test";
import type { FrozenDatasetCase } from "../src/ai-observability/datasets";
import {
  createGatewayModelCall,
  createProductionEvaluationCaseRunner,
  type EvaluationModelCall,
  type EvaluationModelCallObserver,
} from "../src/ai-observability/execution-runner";
import type { EvaluationCaseContext } from "../src/ai-observability/executions";
import { freezeExperimentConfig } from "../src/ai-observability/experiments";
import type { ModelSpanObservation } from "../src/ai-observability/model-span";
import { resolveObservationScope } from "../src/ai-observability/scope";

/**
 * Unit contract of the production evaluation case runner (Issue #30 / DAG T24): one
 * controlled model call per frozen case — the frozen prompt as the system message,
 * the frozen case input as the user message — with per-call billing admission as the
 * T25 seam (interface only, no settlement here) and every call observed through the
 * T14/T15 model-span channel. The concurrency, resume and takeover behavior of the
 * worker that drives this runner lives in opik-executions.integration.test.ts.
 */

const scope = resolveObservationScope({
  actorId: "user-a",
  botId: "agent-1",
  ownership: "owner",
  epoch: 1,
});

const frozen = freezeExperimentConfig({
  botConfig: {},
  prompt: "Answer the support question.",
  modelName: "gateway-model",
  modelParameters: { temperature: 0 },
  toolFixtures: {},
  judgeConfig: {},
  judgeVersion: "judge/1",
  readOnlyTools: [],
});

const frozenCase: FrozenDatasetCase = {
  safeInput: { state: "projected", text: "Summarize the outage." },
  referenceOutput: { state: "projected", text: "A summary." },
  toolFixtures: { state: "projected", value: {} },
  sourceRunId: "run-1",
  sourceAttemptId: "attempt-1",
  sourceBindingId: null,
};

/** The worker hands each case its context; the runner never reaches past it. */
function contextFor(index = 0): EvaluationCaseContext {
  return {
    executionId: "execution-1",
    experimentId: "experiment-1",
    caseIndex: index,
    frozenCase,
    config: frozen,
    scope,
    callTool: async () => ({ outcome: "refused", reason: "not_whitelisted" }),
  };
}

/** Records model calls and observations; the tests read back exactly what was asked. */
function recorder() {
  const calls: Parameters<EvaluationModelCall>[0][] = [];
  const observations: ModelSpanObservation[] = [];
  return {
    calls,
    observations,
    callModel: (async (input: Parameters<EvaluationModelCall>[0]) => {
      calls.push(input);
      return { output: "the answer", inputTokens: 10, outputTokens: 20 };
    }) satisfies EvaluationModelCall,
    observe: ((fact: ModelSpanObservation) => {
      observations.push(fact);
    }) satisfies EvaluationModelCallObserver,
  };
}

describe("the production case runner makes one controlled, observed model call", () => {
  test("a settled call completes the case with its usage and one observation", async () => {
    const { callModel, observe, observations, calls } = recorder();
    const runner = createProductionEvaluationCaseRunner({ callModel, observe });

    const outcome = await runner(contextFor());

    expect(calls).toEqual([
      {
        modelName: "gateway-model",
        modelParameters: { temperature: { state: "projected", value: 0 } },
        system: "Answer the support question.",
        user: "Summarize the outage.",
      },
    ]);
    expect(outcome).toEqual({
      status: "completed",
      detail: { output: "the answer", inputTokens: 10, outputTokens: 20 },
    });
    expect(observations).toMatchObject([
      {
        scope,
        modelId: "gateway-model",
        ending: { kind: "succeeded", inputTokens: 10, outputTokens: 20 },
      },
    ]);
  });

  test("a call without a usage report is observed usage_missing, never a zero", async () => {
    const { observe, observations } = recorder();
    const runner = createProductionEvaluationCaseRunner({
      callModel: async () => ({ output: "ok" }),
      observe,
    });
    const outcome = await runner(contextFor());

    expect(outcome.status).toBe("completed");
    expect(observations[0]?.ending).toEqual({ kind: "usage_missing" });
  });

  test("a refused admission never calls the model and is observed refused", async () => {
    const { callModel, observe, observations, calls } = recorder();
    let admitted = 0;
    const runner = createProductionEvaluationCaseRunner({
      callModel,
      observe,
      admit: async () => {
        admitted += 1;
        return { allowed: false, reason: "no credit" };
      },
    });

    const outcome = await runner(contextFor());

    expect(admitted).toBe(1);
    expect(calls).toEqual([]);
    expect(outcome).toEqual({
      status: "failed",
      detail: { reason: "budget_refused" },
    });
    expect(observations[0]?.ending).toEqual({
      kind: "refused",
      code: "budget_refused",
    });
  });

  test("a failing model call is a failed case, observed failed — not a crash", async () => {
    const { observe, observations } = recorder();
    const runner = createProductionEvaluationCaseRunner({
      callModel: async () => {
        throw new Error("gateway is down");
      },
      observe,
    });

    const outcome = await runner(contextFor());

    expect(outcome.status).toBe("failed");
    expect(observations[0]?.ending).toEqual({
      kind: "failed",
      code: "provider_error",
    });
  });

  test("the observation carries exactly what was sent — the frozen prompt and input", async () => {
    const { callModel, observe, observations } = recorder();
    const runner = createProductionEvaluationCaseRunner({ callModel, observe });
    await runner(contextFor(3));

    // The observation is the raw fact, projected only at the recorder (the T14 rule);
    // attribution beyond the scope is the run-association tickets' work, not a field
    // this runner invents.
    expect(observations[0]?.input).toBe(
      "Answer the support question.\n\nSummarize the outage.",
    );
  });
});

/*
 * The gateway adapter against a real local HTTP upstream (the T15 precedent: a
 * Bun.serve on an ephemeral port, not a mocked fetch) — proving the frozen
 * parameters reach the wire mapped, and the settled usage comes back honest.
 */
const seenRequests: Record<string, unknown>[] = [];
const gateway = Bun.serve({
  port: 0,
  fetch: async (request) => {
    seenRequests.push(await request.json());
    return Response.json({
      id: "chatcmpl-1",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "gateway answer" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 },
    });
  },
});

afterAll(() => {
  gateway.stop(true);
});

describe("the gateway model call", () => {
  const callModel = createGatewayModelCall({
    apiKey: "test-key",
    baseURL: `http://127.0.0.1:${gateway.port}/v1`,
  });

  test("one round trip: frozen parameters mapped, output and usage extracted", async () => {
    const answer = await callModel({
      modelName: "gateway-model",
      modelParameters: {
        temperature: 0,
        maxTokens: 1024,
        ignoredByTheGateway: "not forwarded",
      },
      system: "Answer the support question.",
      user: "Summarize the outage.",
    });

    expect(seenRequests.at(-1)).toMatchObject({
      model: "gateway-model",
      temperature: 0,
      max_tokens: 1024,
      messages: [
        { role: "system", content: "Answer the support question." },
        { role: "user", content: "Summarize the outage." },
      ],
    });
    expect(JSON.stringify(seenRequests.at(-1))).not.toContain(
      "ignoredByTheGateway",
    );
    expect(answer).toEqual({
      output: "gateway answer",
      inputTokens: 7,
      outputTokens: 11,
    });
  });

  test("a hung gateway is cut off by the time bound", async () => {
    const hanging = Bun.serve({
      port: 0,
      fetch: () => new Promise(() => {}),
    });
    try {
      const bounded = createGatewayModelCall({
        apiKey: "test-key",
        baseURL: `http://127.0.0.1:${hanging.port}/v1`,
        timeoutMs: 25,
      });
      await expect(
        bounded({
          modelName: "gateway-model",
          modelParameters: {},
          system: "s",
          user: "u",
        }),
      ).rejects.toThrow();
    } finally {
      hanging.stop(true);
    }
  });
});
