import { BuiltInAgentWithSaneHistory } from "@openbot/toolkit/copilotkit/agents";
import { parametersFor } from "@openbot/toolkit/granted-tool";
import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import type { FrozenDatasetCase } from "../src/ai-observability/datasets";
import {
  createProductionEvaluationCaseRunner,
  type EvaluationStepBudget,
  type EvaluationStepUsage,
} from "../src/ai-observability/execution-runner";
import {
  createPublicExecutionSeamModelCall,
  EVALUATION_SEAM_STATE_TOOL_NAMES,
  publicExecutionSeamForTests,
} from "../src/ai-observability/execution-seam";
import {
  createEvaluationToolGate,
  type EvaluationCaseContext,
  type EvaluationToolSurface,
} from "../src/ai-observability/executions";
import { freezeExperimentConfig } from "../src/ai-observability/experiments";
import type { ModelSpanObservation } from "../src/ai-observability/model-span";
import { resolveObservationScope } from "../src/ai-observability/scope";
import {
  builtInAgentConfiguration,
  setBuiltinModelSpanObserver,
  setModelUsageGate,
} from "../src/copilot";

/**
 * The public execution seam (FREV-04, R2 close condition): an evaluation case runs
 * through the SAME builtin assembly and engine production serves Bots through — the
 * production `builtInAgentConfiguration` composition and the `BuiltInAgent` engine — with
 * the case's isolation (a thread that exists nowhere else, no memory, no attachments),
 * its gate-intercepted tool surface, and its own admission. These tests are the
 * assembly-consistency proof the finding asked for: the wire the model actually receives
 * is byte-identical to what the production assembly builds for the same frozen inputs,
 * and the F6A step budget / F5C1 cancellation still hold under the shared seam.
 *
 * A real local SSE upstream (the same precedent as the runner suite): no mocked fetch.
 */

const scope = resolveObservationScope({
  actorId: "user-a",
  botId: "agent-1",
  ownership: "owner",
  epoch: 1,
});

const FROZEN_PROMPT = "Answer the support question.";
const FROZEN_INPUT = "Summarize the outage.";

const baseConfig = () => ({
  botConfig: {},
  prompt: FROZEN_PROMPT,
  modelName: "gateway-model",
  modelParameters: { temperature: 0 } as Record<string, unknown>,
  toolFixtures: {},
  judgeConfig: {},
  judgeVersion: "judge/1",
  readOnlyTools: [] as string[],
});

const frozenCase: FrozenDatasetCase = {
  safeInput: { state: "projected", text: FROZEN_INPUT },
  referenceOutput: { state: "projected", text: "A summary." },
  toolFixtures: { state: "projected", value: {} },
  sourceRunId: "run-1",
  sourceAttemptId: "attempt-1",
  sourceBindingId: null,
};

const surfaceFor = (
  _name: string,
  description = "Search the support knowledge base.",
): EvaluationToolSurface => ({
  description,
  parameters: {
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"],
  },
  effect: "read",
});

/** One case context wired through the real gate, exactly as the worker hands it over. */
function contextFor(input: {
  config: ReturnType<typeof freezeExperimentConfig>;
  caseFixtures?: Record<string, unknown>;
  surface?: (name: string) => EvaluationToolSurface | undefined;
  callTool?: EvaluationCaseContext["callTool"];
  signal?: AbortSignal;
}): EvaluationCaseContext {
  const gate = createEvaluationToolGate(
    input.config,
    (name) => input.surface?.(name)?.effect ?? "write",
  );
  const fixtures =
    input.caseFixtures === undefined
      ? frozenCase
      : {
          ...frozenCase,
          toolFixtures: freezeExperimentConfig({
            ...baseConfig(),
            toolFixtures: input.caseFixtures,
          }).toolFixtures,
        };
  return {
    executionId: "execution-seam",
    experimentId: "experiment-seam",
    caseIndex: 0,
    frozenCase: fixtures,
    config: input.config,
    scope,
    callTool:
      input.callTool ??
      (async (name) =>
        gate.call(name, [fixtures.toolFixtures, input.config.toolFixtures])),
    ...(input.surface === undefined
      ? {}
      : { resolveToolSurface: input.surface }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

/* ------------------------------------------------------------------ *
 * A scripted OpenAI-compatible upstream in the wire shape the AI SDK's
 * chat model actually speaks: SSE chat.completion.chunk frames, one
 * final chunk carrying the step's usage (stream_options.include_usage).
 * ------------------------------------------------------------------ */

function chunk(
  delta: Record<string, unknown>,
  finish: string | null,
  usage?: { input: number; output: number },
): Record<string, unknown> {
  return {
    id: "chatcmpl-seam",
    object: "chat.completion.chunk",
    created: 0,
    model: "gateway-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage === undefined
      ? {}
      : {
          usage: {
            prompt_tokens: usage.input,
            completion_tokens: usage.output,
            total_tokens: usage.input + usage.output,
          },
        }),
  };
}

function sseResponse(chunks: readonly Record<string, unknown>[]): Response {
  const body =
    chunks.map((one) => `data: ${JSON.stringify(one)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

const USAGE_5_3 = { input: 5, output: 3 };

/** One round that answers with a tool call the model "made". */
const toolCallRound =
  (
    name: string,
    args = "{}",
    id = "call_1",
    usage = USAGE_5_3,
  ): (() => Response) =>
  () =>
    sseResponse([
      chunk(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id,
              type: "function",
              function: { name, arguments: args },
            },
          ],
        },
        null,
      ),
      chunk({}, "tool_calls", usage),
    ]);

/** One round that answers with plain text. */
const textRound =
  (text: string, usage = USAGE_5_3): (() => Response) =>
  () =>
    sseResponse([
      chunk({ role: "assistant", content: text }, null),
      chunk({}, "stop", usage),
    ]);

/** One round that answers with text but reports no usage (the unknown-cost shape). */
const textRoundWithoutUsage =
  (text: string): (() => Response) =>
  () =>
    sseResponse([
      chunk({ role: "assistant", content: text }, null),
      chunk({}, "stop"),
    ]);

/**
 * A scripted upstream: rounds are consumed in order (the last one repeats), every
 * request body is kept, and `when(n)` resolves once n requests have arrived.
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

/** The seam dialed at one scripted upstream. */
const seamAt = (port: number, timeoutMs?: number) =>
  createPublicExecutionSeamModelCall({
    apiKey: "test-key",
    baseURL: `http://127.0.0.1:${port}/v1`,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

const wireTools = (
  body: Record<string, unknown> | undefined,
): {
  function?: { name?: string; description?: string; parameters?: unknown };
}[] =>
  (body?.tools ?? []) as {
    function?: { name?: string; description?: string; parameters?: unknown };
  }[];

const wireToolNames = (body: Record<string, unknown> | undefined): string[] =>
  wireTools(body)
    .map((one) => one.function?.name)
    .filter((name): name is string => typeof name === "string")
    .sort();

const searchFixtures = { search: { summary: "three regions of impact" } };
const searchConfig = () =>
  freezeExperimentConfig({
    ...baseConfig(),
    readOnlyTools: ["search"],
    toolFixtures: searchFixtures,
  });

// The scripted upstreams are per-test; nothing outlives a test except this guard.
afterAll(() => {});

describe("the evaluation case shares the production assembly (FREV-04)", () => {
  test("the wire carries the production assembly's own prompt, tool mapping and loop ceiling", async () => {
    const { port, bodies, stop } = scriptedGateway([
      toolCallRound("search", '{"q":"outage"}'),
      textRound("the outage reached three regions"),
    ]);
    try {
      const runner = createProductionEvaluationCaseRunner({
        callModel: seamAt(port),
      });
      const config = searchConfig();
      const surface = (name: string) =>
        name === "search" ? surfaceFor(name) : undefined;

      const outcome = await runner(contextFor({ config, surface }));
      expect(outcome.status).toBe("completed");
      expect(outcome.output).toBe("the outage reached three regions");

      const first = bodies[0];
      expect(first).toBeDefined();
      if (first === undefined) return;

      // THE ORACLE: the production assembly function itself, built here from the same
      // frozen inputs the case carries. The wire must be byte-identical to it — not a
      // lookalike composition, the actual thing production builds for a Bot run.
      const expected = builtInAgentConfiguration(
        {
          id: "opik-evaluation-case",
          name: "OpenBot evaluation case",
          type: "built_in",
          systemPrompt: FROZEN_PROMPT,
        },
        { provider: "openai", defaultModel: "gateway-model" },
        "test-key",
        [
          {
            name: "search",
            description: "Search the support knowledge base.",
            parameters: parametersFor(surfaceFor("search").parameters),
            execute: async () => "",
            ref: "search",
          },
        ],
        undefined,
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "test-key" },
      );
      if (!("prompt" in expected)) throw new Error("expected a classic config");

      // The frozen prompt is composed by the production assembly, verbatim.
      expect(first.messages).toMatchObject([
        { role: "system", content: expected.prompt },
        { role: "user", content: FROZEN_INPUT },
      ]);
      expect(expected.prompt).toContain(FROZEN_PROMPT);
      // The loop ceiling is production's own constant riding out of its assembly.
      expect(expected.maxSteps).toBe(8);
      // The declared surface is production's mapping, plus the engine's own state tools.
      expect(wireToolNames(first)).toEqual(
        ["search", ...EVALUATION_SEAM_STATE_TOOL_NAMES].sort(),
      );
      const search = wireTools(first).find(
        (one) => one.function?.name === "search",
      );
      expect(search?.function?.description).toBe(
        "Search the support knowledge base.",
      );
      expect(JSON.stringify(search?.function?.parameters)).toContain('"q"');

      // The engine is the same class the builtin path serves every Bot through.
      expect(publicExecutionSeamForTests.engineClass).toBe(
        BuiltInAgentWithSaneHistory,
      );
    } finally {
      stop();
    }
  });

  test("the tool loop stops at production's eight steps — no ninth provider request", async () => {
    let call = 0;
    const loopingRound = (): Response => {
      call += 1;
      // Valid args (the declared schema is enforced by the public engine — an invalid
      // call is a tool error, not a fixture replay), and a distinct id per call.
      return toolCallRound("search", '{"q":"outage"}', `call_${call}`)();
    };
    const { port, bodies, stop } = scriptedGateway([loopingRound]);
    try {
      const runner = createProductionEvaluationCaseRunner({
        callModel: seamAt(port),
      });
      const outcome = await runner(
        contextFor({
          config: searchConfig(),
          surface: (name) => (name === "search" ? surfaceFor(name) : undefined),
        }),
      );

      expect(bodies.length).toBe(8);
      expect(outcome.status).toBe("completed");
      // Eight provider calls, each reporting 5/3 — the whole loop's usage settles as one case.
      expect(outcome.usage).toEqual({ inputTokens: 40, outputTokens: 24 });
      // The fixture answered every one of the eight calls the model made.
      for (const body of bodies.slice(1)) {
        expect(JSON.stringify(body)).toContain("three regions of impact");
      }
    } finally {
      stop();
    }
  });

  test("each case runs on a thread of its own — isolated by construction", () => {
    const first = publicExecutionSeamForTests.threadId();
    const second = publicExecutionSeamForTests.threadId();
    expect(first).not.toBe(second);
    expect(first.startsWith("opik-evaluation-")).toBe(true);
  });
});

describe("the same frozen configuration keeps its public semantics", () => {
  test("a frozen fixture answers the model's call and shapes the answer it gives", async () => {
    const { port, bodies, stop } = scriptedGateway([
      toolCallRound("search", '{"q":"outage"}'),
      textRound("the outage reached three regions", { input: 5, output: 3 }),
    ]);
    try {
      const observations: ModelSpanObservation[] = [];
      const runner = createProductionEvaluationCaseRunner({
        callModel: seamAt(port),
        observe: (fact) => observations.push(fact),
      });
      const outcome = await runner(
        contextFor({
          config: searchConfig(),
          surface: (name) => (name === "search" ? surfaceFor(name) : undefined),
        }),
      );

      expect(outcome).toEqual({
        status: "completed",
        output: "the outage reached three regions",
        usage: { inputTokens: 10, outputTokens: 6 },
      });
      expect(observations[0]?.ending).toEqual({
        kind: "succeeded",
        inputTokens: 10,
        outputTokens: 6,
      });
      // The replayed fixture is the tool result the second request carries.
      expect(JSON.stringify(bodies[1])).toContain("three regions of impact");
    } finally {
      stop();
    }
  });

  test("an unknown cost stays unknown — a round without usage is usage_missing, never free", async () => {
    const { port, stop } = scriptedGateway([
      textRoundWithoutUsage("an answer"),
    ]);
    try {
      const observations: ModelSpanObservation[] = [];
      const runner = createProductionEvaluationCaseRunner({
        callModel: seamAt(port),
        observe: (fact) => observations.push(fact),
      });
      const outcome = await runner(contextFor({ config: searchConfig() }));

      expect(outcome.status).toBe("completed");
      expect(outcome.usage).toBeUndefined();
      expect(observations[0]?.ending).toEqual({ kind: "usage_missing" });
    } finally {
      stop();
    }
  });

  test("a whitelisted tool the classifier calls a write is refused, counted, and never replays its fixture", async () => {
    const { port, bodies, stop } = scriptedGateway([
      toolCallRound("search", '{"q":"outage"}'),
      textRound("I could not look that up"),
    ]);
    try {
      const runner = createProductionEvaluationCaseRunner({
        callModel: seamAt(port),
      });
      // No surface: the fail-closed classifier's word — a write — governs.
      const outcome = await runner(contextFor({ config: searchConfig() }));

      expect(outcome.status).toBe("completed");
      expect(JSON.stringify(bodies[1])).toContain(
        "EVALUATION_TOOL_REFUSED: write_tool",
      );
      expect(JSON.stringify(bodies[1])).not.toContain(
        "three regions of impact",
      );
    } finally {
      stop();
    }
  });

  test("a name the model invents is put through the gate and counted — the case still completes", async () => {
    const { port, stop } = scriptedGateway([
      toolCallRound("evil_tool", "{}"),
      textRound("no tools available"),
    ]);
    try {
      const config = freezeExperimentConfig(baseConfig());
      const seen: string[] = [];
      const gate = createEvaluationToolGate(config, () => "read");
      const runner = createProductionEvaluationCaseRunner({
        callModel: seamAt(port),
      });

      const outcome = await runner(
        contextFor({
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
      stop();
    }
  });
});

describe("isolation and zero production side effects", () => {
  test("the seam never consults the deployment's billing gate or the builtin span wrapper", async () => {
    const { port, stop } = scriptedGateway([
      toolCallRound("search", '{"q":"outage"}'),
      textRound("the outage reached three regions"),
    ]);
    const consulted: unknown[] = [];
    const wrapped: unknown[] = [];
    // A billed, observed deployment: both seams are wired in-process, exactly as the
    // production boot wires them. The evaluation bills through its OWN admission (the
    // one-credit-machinery contract) — the workbench gate and the model-span wrapper
    // must stay untouched, or one provider call would be admitted and metered twice.
    setModelUsageGate(async (input) => {
      consulted.push(input);
      return {};
    });
    setBuiltinModelSpanObserver((fact) => {
      wrapped.push(fact);
    });
    try {
      const observations: ModelSpanObservation[] = [];
      const runner = createProductionEvaluationCaseRunner({
        callModel: seamAt(port),
        observe: (fact) => observations.push(fact),
      });
      const outcome = await runner(
        contextFor({
          config: searchConfig(),
          surface: (name) => (name === "search" ? surfaceFor(name) : undefined),
        }),
      );

      expect(outcome.status).toBe("completed");
      // The evaluation's own observation channel still reports the case.
      expect(observations).toHaveLength(1);
      // …and nothing else in the process was reached.
      expect(consulted).toEqual([]);
      expect(wrapped).toEqual([]);
    } finally {
      setModelUsageGate(undefined);
      setBuiltinModelSpanObserver(undefined);
      stop();
    }
  });
});

describe("the case's admission and cancellation survive the public seam (F6A / F5C1)", () => {
  test("every step is admitted before its request, its own usage recorded, its ceiling on the wire", async () => {
    const { port, bodies, stop } = scriptedGateway([
      toolCallRound("search", '{"q":"outage"}', "call_1", {
        input: 5,
        output: 3,
      }),
      textRound("the outage reached three regions", { input: 6, output: 4 }),
    ]);
    try {
      const verdicts: number[] = [];
      const records: EvaluationStepUsage[] = [];
      const budget: EvaluationStepBudget = {
        admit: async (stepIndex) => {
          verdicts.push(stepIndex);
          return { allowed: true, maxOutputTokens: 1000 };
        },
        record: (usage) => {
          records.push(usage);
        },
      };
      const config = freezeExperimentConfig({
        ...baseConfig(),
        readOnlyTools: ["search"],
        toolFixtures: searchFixtures,
        modelParameters: { temperature: 0, maxTokens: 4096 },
      });
      const runner = createProductionEvaluationCaseRunner({
        callModel: seamAt(port),
        stepBudget: budget,
      });

      const outcome = await runner(
        contextFor({
          config,
          surface: (name) => (name === "search" ? surfaceFor(name) : undefined),
        }),
      );

      expect(outcome.status).toBe("completed");
      // Step 0 is the case's first provider request; step 1 its second — asked ONCE
      // before each dial, in order, never after the fact.
      expect(verdicts).toEqual([0, 1]);
      expect(records).toEqual([
        { index: 0, inputTokens: 5, outputTokens: 3 },
        { index: 1, inputTokens: 6, outputTokens: 4 },
      ]);
      // The admitted ceiling narrows the frozen cap on the wire (4096 → 1000), so the
      // provider can never generate past what the step's hold covers.
      expect(bodies[0]).toMatchObject({ max_tokens: 1000 });
      expect(bodies[1]).toMatchObject({ max_tokens: 1000 });
    } finally {
      stop();
    }
  });

  test("a refused admission never dials the step it refused — the case says why", async () => {
    const { port, bodies, stop } = scriptedGateway([
      toolCallRound("search", '{"q":"outage"}'),
      textRound("the outage reached three regions"),
    ]);
    try {
      const records: EvaluationStepUsage[] = [];
      const budget: EvaluationStepBudget = {
        admit: async (stepIndex) =>
          stepIndex === 0
            ? { allowed: true }
            : { allowed: false, reason: "credits_exhausted" },
        record: (usage) => {
          records.push(usage);
        },
      };
      const observations: ModelSpanObservation[] = [];
      const runner = createProductionEvaluationCaseRunner({
        callModel: seamAt(port),
        observe: (fact) => observations.push(fact),
        stepBudget: budget,
      });

      const outcome = await runner(
        contextFor({
          config: searchConfig(),
          surface: (name) => (name === "search" ? surfaceFor(name) : undefined),
        }),
      );

      // The adversarial core: the second provider request never reached the wire.
      expect(bodies.length).toBe(1);
      expect(outcome).toEqual({
        status: "failed",
        reason: "credits_exhausted",
      });
      expect(observations[0]?.ending).toEqual({
        kind: "refused",
        code: "credits_exhausted",
      });
      // The step that did run is settled by its own record, not by the refusal.
      expect(records).toEqual([{ index: 0, inputTokens: 5, outputTokens: 3 }]);
    } finally {
      stop();
    }
  });

  test("a task cancellation interrupts the loop already in flight and lands as cancelled", async () => {
    const hanging = new Promise<Response>(() => {});
    const { port, when, stop } = scriptedGateway([
      toolCallRound("search", "{}"),
      () => hanging,
    ]);
    try {
      const controller = new AbortController();
      const observations: ModelSpanObservation[] = [];
      const runner = createProductionEvaluationCaseRunner({
        callModel: seamAt(port, 5_000),
        observe: (fact: ModelSpanObservation) => observations.push(fact),
      });

      const run = runner(
        contextFor({
          config: searchConfig(),
          surface: (name) => (name === "search" ? surfaceFor(name) : undefined),
          signal: controller.signal,
        }),
      );
      await when(2);
      controller.abort();
      const outcome = await run;

      expect(outcome).toEqual({ status: "failed", reason: "cancelled" });
      expect(observations[0]?.ending).toEqual({ kind: "canceled" });
    } finally {
      stop();
    }
  });

  test("the case's own time bound ends a hung dial as a failed case, not a hang", async () => {
    const hanging = new Promise<Response>(() => {});
    const { port, stop } = scriptedGateway([() => hanging]);
    try {
      const observations: ModelSpanObservation[] = [];
      const runner = createProductionEvaluationCaseRunner({
        callModel: seamAt(port, 50),
        observe: (fact) => observations.push(fact),
      });

      const outcome = await runner(contextFor({ config: searchConfig() }));

      expect(outcome).toEqual({ status: "failed" });
      expect(observations[0]?.ending).toEqual({
        kind: "failed",
        code: "provider_error",
      });
    } finally {
      stop();
    }
  });
});
