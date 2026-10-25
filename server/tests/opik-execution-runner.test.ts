import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import type { FrozenDatasetCase } from "../src/ai-observability/datasets";
import {
  createGatewayModelCall,
  createProductionEvaluationCaseRunner,
  type EvaluationModelCall,
  type EvaluationModelCallObserver,
  type EvaluationStepBudget,
  type EvaluationStepUsage,
} from "../src/ai-observability/execution-runner";
import type {
  EvaluationCaseContext,
  EvaluationToolSurface,
} from "../src/ai-observability/executions";
import { createEvaluationToolGate } from "../src/ai-observability/executions";
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
      output: "the answer",
      usage: { inputTokens: 10, outputTokens: 20 },
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
    expect(outcome.usage).toBeUndefined();
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
    // The admission's own reason survives: the span and the outcome carry it, so the
    // refusal never collapses into a generic budget word (T25-rev L-1).
    expect(outcome).toEqual({ status: "failed", reason: "no credit" });
    expect(observations[0]?.ending).toEqual({
      kind: "refused",
      code: "no credit",
    });
  });

  test("a refusal without a reason keeps the budget_refused fallback word", async () => {
    const { observe, observations } = recorder();
    const runner = createProductionEvaluationCaseRunner({
      callModel: async () => ({ output: "ok" }),
      observe,
      admit: async () => ({ allowed: false }),
    });

    const outcome = await runner(contextFor());

    expect(outcome).toEqual({ status: "failed" });
    expect(observations[0]?.ending).toEqual({
      kind: "refused",
      code: "budget_refused",
    });
  });

  test("a withheld prompt refuses the case before admission and before any dial (OCR R4-21)", async () => {
    // The freeze projected the prompt away: an empty string is not what the case
    // meant to ask, and dialing it spends money on a question nobody wrote. The
    // judge's AC3 precedent governs the evaluation call too — non-projected input
    // is a domain refusal settled before the billing admission (zero holds), not
    // a silent dial of "".
    const withheldPrompt = {
      ...frozen,
      prompt: { state: "omitted", reason: "unhandled_free_text" },
    } as typeof frozen;
    const { callModel, observe, observations, calls } = recorder();
    let admitted = 0;
    const runner = createProductionEvaluationCaseRunner({
      callModel,
      observe,
      admit: async () => {
        admitted += 1;
        return { allowed: true };
      },
    });

    const outcome = await runner({ ...contextFor(), config: withheldPrompt });

    expect(outcome).toEqual({ status: "failed", reason: "input_unavailable" });
    expect(admitted).toBe(0);
    expect(calls).toEqual([]);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.ending).toEqual({
      kind: "refused",
      code: "input_unavailable",
    });
  });

  test("a withheld case input or model name refuses the same way (OCR R4-21)", async () => {
    const withheldInput = {
      ...frozenCase,
      safeInput: { state: "omitted", reason: "credential" },
    } as typeof frozenCase;
    const withheldModel = {
      ...frozen,
      modelName: { state: "omitted", reason: "credential" },
    } as typeof frozen;
    const { callModel, observe, observations, calls } = recorder();
    const runner = createProductionEvaluationCaseRunner({
      callModel,
      observe,
      admit: async () => ({ allowed: true }),
    });

    const byInput = await runner({
      ...contextFor(),
      frozenCase: withheldInput,
    });
    const byModel = await runner({ ...contextFor(), config: withheldModel });

    expect(byInput).toEqual({ status: "failed", reason: "input_unavailable" });
    expect(byModel).toEqual({ status: "failed", reason: "input_unavailable" });
    expect(calls).toEqual([]);
    expect(observations).toHaveLength(2);
    expect(observations[0]?.ending).toEqual({
      kind: "refused",
      code: "input_unavailable",
    });
    expect(observations[1]?.ending).toEqual({
      kind: "refused",
      code: "input_unavailable",
    });
  });

  test("a truncated prompt, input or model name still proceeds — a truncation is reviewed text (OCR R5-18 / R4-21)", async () => {
    // The R4-21 guard's own comment and the judge's ruling agree: a truncation
    // still carries reviewed text (`textOf` returns the cut text), so it dials
    // rather than pretending the freeze withheld the field. Only an omitted
    // envelope — the field withheld outright — is the input_unavailable refusal.
    const truncatedPrompt = {
      ...frozen,
      prompt: {
        state: "truncated",
        text: "Answer the support qu",
        originalBytes: 40,
      },
    } as typeof frozen;
    const truncatedInput = {
      ...frozenCase,
      safeInput: {
        state: "truncated",
        text: "Summarize the out",
        originalBytes: 40,
      },
    } as typeof frozenCase;
    const truncatedModel = {
      ...frozen,
      modelName: {
        state: "truncated",
        text: "gateway-mode",
        originalBytes: 40,
      },
    } as typeof frozen;
    const { callModel, observations, calls } = recorder();
    let admitted = 0;
    const runner = createProductionEvaluationCaseRunner({
      callModel,
      observe: (fact) => observations.push(fact),
      admit: async () => {
        admitted += 1;
        return { allowed: true };
      },
    });

    const byPrompt = await runner({ ...contextFor(), config: truncatedPrompt });
    const byInput = await runner({
      ...contextFor(),
      frozenCase: truncatedInput,
    });
    const byModel = await runner({ ...contextFor(), config: truncatedModel });

    expect(byPrompt.status).toBe("completed");
    expect(byInput.status).toBe("completed");
    expect(byModel.status).toBe("completed");
    expect(calls[0]?.system).toBe("Answer the support qu");
    expect(calls[1]?.user).toBe("Summarize the out");
    expect(calls[2]?.modelName).toBe("gateway-mode");
    expect(admitted).toBe(3);
    expect(observations.every((one) => one.ending.kind === "succeeded")).toBe(
      true,
    );
  });

  test("a non-projected modelParameters envelope refuses before admission — the dial is never priced on stripped parameters (OCR R5-20)", async () => {
    // The parameters are the frozen configuration, not garnish: a top-level
    // envelope the projection did not keep whole (omitted outright, or
    // truncated past the record cap) would dial gateway defaults while the
    // case still costs money — R4-21's stripped-dial judgment applies to it
    // exactly as to a stripped prompt. The refusal settles before the billing
    // admission, the same as the text fields' guard.
    const omittedParameters = {
      ...frozen,
      modelParameters: { state: "omitted", reason: "unhandled_free_text" },
    } as typeof frozen;
    const truncatedParameters = {
      ...frozen,
      modelParameters: {
        state: "truncated",
        value: { temperature: { state: "projected", value: 0.7 } },
        originalBytes: 4096,
        dropped: 3,
      },
    } as typeof frozen;
    const { callModel, observations, calls } = recorder();
    let admitted = 0;
    const runner = createProductionEvaluationCaseRunner({
      callModel,
      observe: (fact) => observations.push(fact),
      admit: async () => {
        admitted += 1;
        return { allowed: true };
      },
    });

    const byOmitted = await runner({
      ...contextFor(),
      config: omittedParameters,
    });
    const byTruncated = await runner({
      ...contextFor(),
      config: truncatedParameters,
    });

    expect(byOmitted).toEqual({
      status: "failed",
      reason: "input_unavailable",
    });
    expect(byTruncated).toEqual({
      status: "failed",
      reason: "input_unavailable",
    });
    expect(admitted).toBe(0);
    expect(calls).toEqual([]);
    expect(observations).toHaveLength(2);
    expect(observations[0]?.ending).toEqual({
      kind: "refused",
      code: "input_unavailable",
    });
    expect(observations[1]?.ending).toEqual({
      kind: "refused",
      code: "input_unavailable",
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

describe("the task's cancellation signal (FREV-05)", () => {
  test("the runner threads the task's signal into the model call", async () => {
    const { callModel, calls } = recorder();
    const runner = createProductionEvaluationCaseRunner({ callModel });
    const controller = new AbortController();

    await runner({ ...contextFor(), signal: controller.signal });

    // The signal the worker's cancel-watch aborts is the signal the dial holds:
    // no re-derivation, no copy — one chain from the execution row to the wire.
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  test("a task cancelled before the dial refuses with zero holds and the canceled observation", async () => {
    const controller = new AbortController();
    controller.abort();
    const { callModel, observe, observations, calls } = recorder();
    let admitted = 0;
    const runner = createProductionEvaluationCaseRunner({
      callModel,
      observe,
      admit: async () => {
        admitted += 1;
        return { allowed: true };
      },
    });

    const outcome = await runner({
      ...contextFor(),
      signal: controller.signal,
    });

    // The same settlement class as the projection refusal: the case lands
    // failed with its reason, nothing is held, nothing is dialed, and the
    // observation says canceled — never a provider error the call never got
    // the chance to be.
    expect(outcome).toEqual({ status: "failed", reason: "cancelled" });
    expect(admitted).toBe(0);
    expect(calls).toEqual([]);
    expect(observations[0]?.ending).toEqual({ kind: "canceled" });
  });

  test("an abort that fires mid-call lands as cancellation, not provider_error", async () => {
    const controller = new AbortController();
    const { observe, observations } = recorder();
    // The dial's shape of an abort: it holds the call open until the task's
    // signal fires, then rejects. Nothing about the rejection itself says WHY,
    // so the runner asks the signal — the only fact that knows.
    let dialing!: () => void;
    const dialStarted = new Promise<void>((resolve) => {
      dialing = resolve;
    });
    const callModel = (async (request: Parameters<EvaluationModelCall>[0]) => {
      const signal = request.signal;
      if (!signal) throw new Error("no signal threaded into the model call");
      dialing();
      return new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () =>
          reject(new Error("The operation was aborted")),
        );
      });
    }) satisfies EvaluationModelCall;
    const runner = createProductionEvaluationCaseRunner({ callModel, observe });

    const settled = runner({ ...contextFor(), signal: controller.signal });
    await dialStarted;
    controller.abort();
    const outcome = await settled;

    expect(outcome).toEqual({ status: "failed", reason: "cancelled" });
    expect(observations[0]?.ending).toEqual({ kind: "canceled" });
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

  test("frozen model parameters reach the gateway wire — the projected envelopes are unwrapped at the dial (R4-26)", async () => {
    // The full production chain: the freeze wraps every leaf in a projection
    // envelope (`projectSafeFixture`), the runner hands them to the gateway call,
    // and the dial must see numbers — not silently completed calls with every
    // parameter dropped (R4-26).
    const frozenWithParameters = freezeExperimentConfig({
      botConfig: {},
      prompt: "Answer the support question.",
      modelName: "gateway-model",
      modelParameters: { temperature: 0.7, maxTokens: 512, topP: 0.9 },
      toolFixtures: {},
      judgeConfig: {},
      judgeVersion: "judge/1",
      readOnlyTools: [],
    });
    const runner = createProductionEvaluationCaseRunner({
      callModel: createGatewayModelCall({
        apiKey: "test-key",
        baseURL: `http://127.0.0.1:${gateway.port}/v1`,
      }),
    });

    const outcome = await runner({
      ...contextFor(),
      config: frozenWithParameters,
    });

    expect(outcome.status).toBe("completed");
    expect(seenRequests.at(-1)).toMatchObject({
      model: "gateway-model",
      temperature: 0.7,
      max_tokens: 512,
      top_p: 0.9,
    });
  });

  test("a withheld parameter envelope is not forwarded — fail-closed at the numeric gate (R4-26)", async () => {
    const answer = await callModel({
      modelName: "gateway-model",
      modelParameters: {
        temperature: { state: "omitted", reason: "credential" },
      },
      system: "Answer the support question.",
      user: "Summarize the outage.",
    });

    expect(answer.output).toBe("gateway answer");
    expect(seenRequests.at(-1)).not.toHaveProperty("temperature");
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

  test("a task cancellation aborts an in-flight dial before its own time bound (FREV-05)", async () => {
    // The call's two bounds — its own timeout and the task's cancellation — are
    // one signal, whichever fires first. A dial holding a 5s budget is aborted
    // by the task at 50ms: the interrupt reaches the wire, it does not wait
    // for the budget to expire.
    const hanging = Bun.serve({
      port: 0,
      fetch: () => new Promise(() => {}),
    });
    try {
      const bounded = createGatewayModelCall({
        apiKey: "test-key",
        baseURL: `http://127.0.0.1:${hanging.port}/v1`,
        timeoutMs: 5_000,
      });
      const controller = new AbortController();
      const startedAt = Date.now();
      const call = bounded({
        modelName: "gateway-model",
        modelParameters: {},
        system: "s",
        user: "u",
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 50);
      await expect(call).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      hanging.stop(true);
    }
  });
});

/*
 * FREV-04: the evaluation runs the case as the Bot's public tool loop — the real
 * gateway adapter against a scripted OpenAI-compatible upstream (no mocked fetch),
 * the gate the worker hands the runner, and the frozen fixture as the only thing a
 * tool call may answer with. What is asserted is the production chain end to end:
 * the model is offered the frozen surface, its call lands in the gate, the replayed
 * fixture comes back to it as a tool result, invented tools are counted refusals, and
 * a cancellation still interrupts a loop already in flight.
 */

/** One scripted upstream round; `body` is what the adapter actually sent. */
type Round = (body: Record<string, unknown>) => Response | Promise<Response>;

const upstreamUsage = {
  prompt_tokens: 5,
  completion_tokens: 3,
  total_tokens: 8,
};

function chatCompletion(message: Record<string, unknown>, finish: string) {
  return Response.json({
    id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
    object: "chat.completion",
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: upstreamUsage,
  });
}

/** One round that answers with a tool call the model "made". */
const toolCallRound =
  (name: string, args = "{}", id = "call_1") =>
  () =>
    chatCompletion(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id, type: "function", function: { name, arguments: args } },
        ],
      },
      "tool_calls",
    );

/** One round that answers with plain text. */
const textRound = (text: string) => () =>
  chatCompletion({ role: "assistant", content: text }, "stop");

/**
 * A scripted upstream: rounds are consumed in order (the last one repeats), every
 * request body is kept, and `when(n)` resolves once n requests have arrived — the
 * handle the cancellation test needs to abort a loop that is already away.
 */
function scriptedGateway(rounds: Round[]) {
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
        : round(body);
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
  return { server, bodies, when };
}

const toolContextFor = (input: {
  config: ReturnType<typeof freezeExperimentConfig>;
  caseFixtures?: Record<string, unknown>;
  surface?: (name: string) => EvaluationToolSurface | undefined;
  callTool?: EvaluationCaseContext["callTool"];
}): EvaluationCaseContext => {
  const gate = createEvaluationToolGate(
    input.config,
    (name) => input.surface?.(name)?.effect ?? "write",
  );
  return {
    ...contextFor(),
    config: input.config,
    frozenCase: input.caseFixtures
      ? {
          ...frozenCase,
          toolFixtures: freezeExperimentConfig({
            ...baseConfig(),
            toolFixtures: input.caseFixtures,
          }).toolFixtures,
        }
      : frozenCase,
    callTool:
      input.callTool ??
      (async (name) =>
        gate.call(name, [frozenCase.toolFixtures, input.config.toolFixtures])),
    ...(input.surface === undefined
      ? {}
      : { resolveToolSurface: input.surface }),
  };
};

const baseConfig = () => ({
  botConfig: {},
  prompt: "Answer the support question.",
  modelName: "gateway-model",
  modelParameters: { temperature: 0 },
  toolFixtures: {},
  judgeConfig: {},
  judgeVersion: "judge/1",
  readOnlyTools: [] as string[],
});

describe("the evaluation runs the frozen tool surface through the gate (FREV-04)", () => {
  test("a frozen fixture answers the model's tool call and shapes the output", async () => {
    const { server, bodies } = scriptedGateway([
      toolCallRound("search", '{"q":"outage"}'),
      textRound("the outage reached three regions"),
    ]);
    try {
      const config = freezeExperimentConfig({
        ...baseConfig(),
        readOnlyTools: ["search"],
        toolFixtures: { search: { summary: "three regions of impact" } },
      });
      const surface = (name: string): EvaluationToolSurface | undefined =>
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
          : undefined;
      const observations: ModelSpanObservation[] = [];
      const runner = createProductionEvaluationCaseRunner({
        callModel: createGatewayModelCall({
          apiKey: "test-key",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
        }),
        observe: (fact) => observations.push(fact),
      });

      const outcome = await runner(toolContextFor({ config, surface }));

      expect(outcome.status).toBe("completed");
      expect(outcome.output).toBe("the outage reached three regions");
      // The two provider calls the loop made are billed as one case's usage.
      expect(outcome.usage).toEqual({ inputTokens: 10, outputTokens: 6 });
      expect(observations[0]?.ending).toEqual({
        kind: "succeeded",
        inputTokens: 10,
        outputTokens: 6,
      });
      // The first request declared the frozen tool with the catalogue's own
      // description and schema — the surface the experiment pinned, not an invention.
      const first = JSON.stringify(bodies[0]);
      expect(first).toContain('"name":"search"');
      expect(first).toContain("Search the support knowledge base.");
      expect(first).toContain('"q"');
      // The replayed fixture is the tool result the model answered from: the frozen
      // answer reached the wire, which is what makes the output depend on the freeze.
      expect(JSON.stringify(bodies[1])).toContain("three regions of impact");
    } finally {
      server.stop(true);
    }
  });

  test("a whitelisted tool the classifier calls a write is refused, counted, and never replays its fixture", async () => {
    const { server, bodies } = scriptedGateway([
      toolCallRound("search", '{"q":"outage"}'),
      textRound("I could not look that up"),
    ]);
    try {
      const config = freezeExperimentConfig({
        ...baseConfig(),
        readOnlyTools: ["search"],
        toolFixtures: { search: { summary: "three regions of impact" } },
      });
      // No surface: the fail-closed classifier's word — a write — governs.
      const runner = createProductionEvaluationCaseRunner({
        callModel: createGatewayModelCall({
          apiKey: "test-key",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
        }),
      });

      const outcome = await runner(toolContextFor({ config }));

      expect(outcome.status).toBe("completed");
      // The model was told the call failed; the fixture never reached it.
      expect(JSON.stringify(bodies[1])).toContain(
        "EVALUATION_TOOL_REFUSED: write_tool",
      );
      expect(JSON.stringify(bodies[1])).not.toContain(
        "three regions of impact",
      );
    } finally {
      server.stop(true);
    }
  });

  test("a name the model invents is put through the gate and counted — the case still completes", async () => {
    const { server } = scriptedGateway([
      toolCallRound("evil_tool", "{}"),
      textRound("no tools available"),
    ]);
    try {
      // No whitelist: the case declares no tools at all, and the model still invents
      // one. The engine reports the attempt; the runner's own gate call is what makes
      // it a counted refusal instead of an invisible nothing.
      const config = freezeExperimentConfig(baseConfig());
      const seen: string[] = [];
      const gate = createEvaluationToolGate(config, () => "read");
      const runner = createProductionEvaluationCaseRunner({
        callModel: createGatewayModelCall({
          apiKey: "test-key",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
        }),
      });

      const outcome = await runner(
        toolContextFor({
          config,
          callTool: async (name) => {
            seen.push(name);
            return gate.call(name, [
              frozenCase.toolFixtures,
              config.toolFixtures,
            ]);
          },
        }),
      );

      expect(outcome.status).toBe("completed");
      expect(seen).toEqual(["evil_tool"]);
      expect(gate.tally()).toEqual({
        rejections: 1,
        rejectedTools: ["evil_tool"],
      });
    } finally {
      server.stop(true);
    }
  });

  test("a cancellation interrupts a tool loop already in flight, landed as cancelled", async () => {
    const hanging = new Promise<Response>(() => {});
    const { server, when } = scriptedGateway([
      toolCallRound("search", "{}"),
      () => hanging,
    ]);
    try {
      const config = freezeExperimentConfig({
        ...baseConfig(),
        readOnlyTools: ["search"],
        toolFixtures: { search: { summary: "the fixture answer" } },
      });
      const surface = (name: string): EvaluationToolSurface | undefined =>
        name === "search"
          ? {
              description: "Search.",
              parameters: { type: "object" },
              effect: "read",
            }
          : undefined;
      const controller = new AbortController();
      const observations: ModelSpanObservation[] = [];
      const runner = createProductionEvaluationCaseRunner({
        callModel: createGatewayModelCall({
          apiKey: "test-key",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
          timeoutMs: 5_000,
        }),
        observe: (fact) => observations.push(fact),
      });

      const run = runner({
        ...toolContextFor({ config, surface }),
        signal: controller.signal,
      });
      await when(2);
      controller.abort();
      const outcome = await run;

      expect(outcome).toEqual({ status: "failed", reason: "cancelled" });
      expect(observations[0]?.ending).toEqual({ kind: "canceled" });
    } finally {
      server.stop(true);
    }
  });
});

/*
 * R3-01: the budget is not a business-whitelist fact. Every actual provider request
 * a dialed model makes is admitted and input-bounded — the toolless single call
 * included, and the count that refuses it happens BEFORE the wire.
 */
describe("the gateway dial carries the step budget on every request (R3-01)", () => {
  const callModel = createGatewayModelCall({
    apiKey: "test-key",
    baseURL: `http://127.0.0.1:${gateway.port}/v1`,
  });

  const request = (user: string) => ({
    modelName: "gateway-model",
    modelParameters: { temperature: 0 },
    system: "Answer the support question.",
    user,
  });

  test("a call with no tool surface still asks the budget before its one request — and carries the admitted ceiling", async () => {
    const verdicts: number[] = [];
    const records: EvaluationStepUsage[] = [];
    const budget: EvaluationStepBudget = {
      admit: async (stepIndex) => {
        verdicts.push(stepIndex);
        return { allowed: true, maxOutputTokens: 700 };
      },
      record: (usage) => {
        records.push(usage);
      },
    };

    const answer = await callModel({
      ...request("Summarize the outage."),
      stepBudget: budget,
    });

    expect(answer.output).toBe("gateway answer");
    // The budget is asked for the single provider request too — whether a case can
    // multi-step is not decided by the declared tool surface (R3-01).
    expect(verdicts).toEqual([0]);
    expect(records).toEqual([{ index: 0, inputTokens: 7, outputTokens: 11 }]);
    // The admitted ceiling lands on the wire even though the frozen configuration
    // names no cap of its own.
    expect(seenRequests.at(-1)).toMatchObject({ max_tokens: 700 });
  });

  test("an input the conservative count places over the step's input ceiling is refused before the dial", async () => {
    const verdicts: number[] = [];
    const before = seenRequests.length;
    const budget: EvaluationStepBudget = {
      inputCeiling: 300,
      admit: async (stepIndex) => {
        verdicts.push(stepIndex);
        return { allowed: true };
      },
      record: () => {},
    };

    const answer = await callModel({
      ...request("y".repeat(2_000)),
      stepBudget: budget,
    });

    // 2,000 ASCII bytes count as at least 1,250 tokens by the approved conservative
    // counter — the request never reaches the wire, and nothing is admitted for it.
    expect(seenRequests.length).toBe(before);
    expect(verdicts).toEqual([]);
    expect(answer.budgetRefusal).toEqual({
      step: 0,
      reason: "input_over_limit",
    });
    expect(answer.output).toBe("");
  });
});
