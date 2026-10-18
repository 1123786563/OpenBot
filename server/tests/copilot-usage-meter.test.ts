import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LLMock } from "@copilotkit/aimock";
import { createOpenAI } from "@ai-sdk/openai";
import {
  builtInAgentConfiguration,
  type BuiltinModelSpanFact,
  CreditGateError,
  CreditPolicyUnconfiguredError,
  type ModelUsageGateLifecycle,
  meteredModelForTests,
  ModelNotPricedError,
  ModelUsageSettlementError,
  resolveRuntimeAgents,
  runtimeModelForEnvironment,
  setBuiltinModelSpanObserver,
  setModelUsageGate,
  setModelUsageMeter,
  UnmeterableModelError,
} from "../src/copilot";
import { loadTenantPackage } from "../src/tenant-package";
import { testEnvironment } from "./support/environment";
import { withUsageOrigin } from "../src/usage-origin";

const packagePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "examples",
  "fintech",
);

// A stand-in provider credential, assembled rather than literal, referenced everywhere and
// expected to appear nowhere (the same convention the billing tests use).
const STUB_MODEL_KEY = `synthetic-${"model-key"}`;

/**
 * The metering chain end to end, against the real model wiring: an LLMock backend answers with a
 * usage block, the runtime's real stream runs through the middleware this module wraps models in,
 * and the meter wired for the test records what fell out of the finish chunk. The billing service
 * and the provider behind it are each other's tests; here the contract under test is "a model call
 * delivers its token counts to the meter" — the one link only a real stream can prove.
 */
describe("the model usage meter", () => {
  test("two completed model calls report distinct event ids and their own token counts", async () => {
    const environment = {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    };
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, environment);
    const recorder = new LLMock();
    const originalBase = process.env.OPENAI_BASE_URL;
    const seen: {
      eventId: string | undefined;
      occurredAt: Date | undefined;
      inputTokens: number | undefined;
      outputTokens: number | undefined;
    }[] = [];
    try {
      process.env.OPENAI_BASE_URL = await recorder.start();
      recorder.onMessage(
        /Complete the first fixture request\./,
        { type: "text", content: "Metered fixture completed." },
        {
          usage: {
            prompt_tokens: 120,
            completion_tokens: 30,
            total_tokens: 150,
          },
        },
      );
      recorder.onMessage(
        /Complete the second fixture request\./,
        { type: "text", content: "Metered fixture completed again." },
        {
          usage: {
            prompt_tokens: 220,
            completion_tokens: 40,
            total_tokens: 260,
          },
        },
      );
      // Wired before the agents are built: the meter wraps the model at configuration time, which
      // is also the production order — index.ts wires the billing seam before any agent is built.
      setModelUsageMeter((usage) => {
        seen.push({
          eventId: (usage as { eventId?: string }).eventId,
          occurredAt: (usage as { occurredAt?: Date }).occurredAt,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
      });
      const agents = await resolveRuntimeAgents(
        () => [
          {
            id: "general-assistant",
            name: "General Assistant",
            type: "built_in" as const,
            systemPrompt: "Be helpful.",
          },
        ],
        model,
        async () => STUB_MODEL_KEY,
      );
      const first = agents["general-assistant"]?.clone();
      const second = agents["general-assistant"]?.clone();
      if (!first || !second) throw new Error("Expected General Assistant.");
      first.addMessage({
        id: "usage-meter-request-1",
        role: "user",
        content: "Complete the first fixture request.",
      });
      await first.runAgent();
      second.addMessage({
        id: "usage-meter-request-2",
        role: "user",
        content: "Complete the second fixture request.",
      });
      await second.runAgent();
      expect(first.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "Metered fixture completed.",
      });
      expect(second.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "Metered fixture completed again.",
      });
      expect(seen).toHaveLength(2);
      expect(seen[0]?.eventId).toBeTruthy();
      expect(seen[1]?.eventId).toBeTruthy();
      expect(seen[0]?.eventId).not.toBe(seen[1]?.eventId);
      expect(seen[0]?.occurredAt).toBeInstanceOf(Date);
      expect(seen[1]?.occurredAt).toBeInstanceOf(Date);
      expect(seen[0]?.inputTokens ?? 0).toBeGreaterThan(0);
      expect(seen[1]?.inputTokens ?? 0).toBeGreaterThan(0);
      expect(seen[0]?.outputTokens ?? 0).toBeGreaterThan(0);
      expect(seen[1]?.outputTokens ?? 0).toBeGreaterThan(0);
      expect(
        new Set(seen.map((entry) => `${entry.inputTokens}:${entry.outputTokens}`))
          .size,
      ).toBe(2);
    } finally {
      setModelUsageMeter(undefined);
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await recorder.stop();
    }
  });

  test("no wired meter costs nothing: the run completes unobserved", async () => {
    const environment = {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    };
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, environment);
    const recorder = new LLMock();
    const originalBase = process.env.OPENAI_BASE_URL;
    try {
      process.env.OPENAI_BASE_URL = await recorder.start();
      recorder.onMessage(/.*/, {
        type: "text",
        content: "Unmetered fixture completed.",
      });
      const agents = await resolveRuntimeAgents(
        () => [
          {
            id: "general-assistant",
            name: "General Assistant",
            type: "built_in" as const,
            systemPrompt: "Be helpful.",
          },
        ],
        model,
        async () => STUB_MODEL_KEY,
      );
      const agent = agents["general-assistant"]?.clone();
      if (!agent) throw new Error("Expected General Assistant.");
      agent.addMessage({
        id: "unmetered-request",
        role: "user",
        content: "Complete the fixture request.",
      });
      await agent.runAgent();
      expect(agent.messages.at(-1)).toMatchObject({
        content: "Unmetered fixture completed.",
      });
    } finally {
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await recorder.stop();
    }
  });

  test("a refusing gate fails the run with the credit sentinel before any token streams", async () => {
    const environment = {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    };
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, environment);
    const recorder = new LLMock();
    const originalBase = process.env.OPENAI_BASE_URL;
    let gateCalls = 0;
    try {
      process.env.OPENAI_BASE_URL = await recorder.start();
      // The gate refuses every call — the shape index.ts wires when the balance is zero.
      setModelUsageGate(async () => {
        gateCalls += 1;
        throw new CreditGateError();
      });
      const agents = await resolveRuntimeAgents(
        () => [
          {
            id: "general-assistant",
            name: "General Assistant",
            type: "built_in" as const,
            systemPrompt: "Be helpful.",
          },
        ],
        model,
        async () => STUB_MODEL_KEY,
      );
      const agent = agents["general-assistant"]?.clone();
      if (!agent) throw new Error("Expected General Assistant.");
      agent.addMessage({
        id: "gate-refusal-request",
        role: "user",
        content: "This call must be refused by the gate.",
      });
      // The run fails (the stream never starts) with OUR sentinel in the chain — not a
      // generic transport error the reader cannot act on.
      let refusal: unknown;
      try {
        await agent.runAgent();
      } catch (error) {
        refusal = error;
      }
      expect(gateCalls).toBeGreaterThanOrEqual(1);
      expect(refusal).toBeDefined();
      const chain: string[] = [];
      for (let e = refusal; e instanceof Error && chain.length < 5; ) {
        chain.push(`${e.name}: ${e.message}`);
        e = (e.cause ?? e) as Error;
      }
      expect(chain.join(" | ")).toMatch(
        /CreditGateError|credits_exhausted|no credits left/,
      );
    } finally {
      setModelUsageGate(undefined);
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await recorder.stop();
    }
  });

  test("a reservation refusal never reaches the provider", async () => {
    const environment = {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    };
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, environment);
    const recorder = new LLMock();
    const originalBase = process.env.OPENAI_BASE_URL;
    let providerCalls = 0;
    let seenEventId: string | undefined;
    try {
      process.env.OPENAI_BASE_URL = await recorder.start();
      recorder.onMessage(/.*/, () => {
        providerCalls += 1;
        return { type: "text", content: "provider should not have been called" };
      });
      setModelUsageGate(async (input) => {
        seenEventId = input?.eventId;
        throw new CreditGateError();
      });
      const agents = await resolveRuntimeAgents(
        () => [
          {
            id: "general-assistant",
            name: "General Assistant",
            type: "built_in" as const,
            systemPrompt: "Be helpful.",
          },
        ],
        model,
        async () => STUB_MODEL_KEY,
      );
      const agent = agents["general-assistant"]?.clone();
      if (!agent) throw new Error("Expected General Assistant.");
      agent.addMessage({
        id: "reservation-refusal-request",
        role: "user",
        content: "This request should be refused before the provider sees it.",
      });
      await expect(agent.runAgent()).rejects.toBeDefined();
      expect(seenEventId).toBeTruthy();
      expect(providerCalls).toBe(0);
    } finally {
      setModelUsageGate(undefined);
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await recorder.stop();
    }
  });

  test("a provider failure releases the admitted work instead of reporting finished usage", async () => {
    const lifecycle: Array<{ phase: string; eventId: string; reason?: string }> = [];
    try {
      setModelUsageGate(async (input) => {
        lifecycle.push({ phase: "admit", eventId: input.eventId });
        return {
          bounds: admittingBounds(),
          async finish(finish) {
            lifecycle.push({ phase: "finish", eventId: finish.eventId });
          },
          async fail(failure) {
            lifecycle.push({
              phase: "fail",
              eventId: failure.eventId,
              reason: failure.reason,
            });
          },
        };
      });
      const wrapped = meteredModelForTests({
        modelId: "gpt-test",
        async doStream() {
          throw new Error("provider exploded");
        },
      });
      await expect((wrapped as { doStream: (params: unknown) => Promise<unknown> }).doStream({})).rejects.toThrow(
        "provider exploded",
      );
      expect(lifecycle[0]?.phase).toBe("admit");
      expect(lifecycle.some((entry) => entry.phase === "finish")).toBe(false);
      expect(
        lifecycle.some(
          (entry) =>
            entry.phase === "fail" &&
            entry.reason === "provider_error" &&
            entry.eventId === lifecycle[0]?.eventId,
        ),
      ).toBe(true);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("string-form built-in models fail closed when billing admission is wired", async () => {
    const originalBase = process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    try {
      // Any wired gate admits or refuses; the string-form refusal happens at agent build,
      // before this gate could even be asked.
      setModelUsageGate(async () => {
        throw new CreditGateError();
      });

      const openai = builtInAgentConfiguration(
        {
          id: "general-assistant",
          name: "General Assistant",
          type: "built_in",
          systemPrompt: "Be helpful.",
        },
        { provider: "openai", defaultModel: "gpt-5.6-terra" },
        STUB_MODEL_KEY,
      ) as {
        type?: string;
        factory?: () => AsyncGenerator<unknown>;
      };
      expect(openai.type).toBe("custom");
      // Not CreditGateError: the balance is fine, the model wiring is what cannot be
      // metered, and the message must not send an administrator to buy credits.
      await expect(openai.factory?.().next()).rejects.toBeInstanceOf(
        UnmeterableModelError,
      );

      const anthropic = builtInAgentConfiguration(
        {
          id: "general-assistant",
          name: "General Assistant",
          type: "built_in",
          systemPrompt: "Be helpful.",
        },
        { provider: "anthropic", defaultModel: "claude-sonnet-4-5" },
        STUB_MODEL_KEY,
      ) as {
        type?: string;
        factory?: () => AsyncGenerator<unknown>;
      };
      expect(anthropic.type).toBe("custom");
      await expect(anthropic.factory?.().next()).rejects.toBeInstanceOf(
        UnmeterableModelError,
      );
    } finally {
      setModelUsageGate(undefined);
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
    }
  });

  test("cancelling the consumer stream cancels upstream and releases once", async () => {
    const lifecycle: Array<{ phase: string; reason?: string }> = [];
    let upstreamCancelled = false;
    try {
      setModelUsageGate(async () => ({
        bounds: admittingBounds(),
        async finish() {
          lifecycle.push({ phase: "finish" });
        },
        async fail(failure) {
          lifecycle.push({ phase: "fail", reason: failure.reason });
        },
      }));
      const source = new ReadableStream<Record<string, unknown>>({
        start(controller) {
          controller.enqueue({ type: "message", text: "hello" });
        },
        cancel() {
          upstreamCancelled = true;
        },
      });
      const wrapped = meteredModelForTests({
        modelId: "gpt-test",
        async doStream() {
          return { stream: source };
        },
      }) as {
        doStream: (params: unknown) => Promise<{
          stream: ReadableStream<Record<string, unknown>>;
        }>;
      };

      const result = await wrapped.doStream({});
      const reader = result.stream.getReader();
      expect((await reader.read()).value).toMatchObject({ type: "message" });
      await reader.cancel("caller-cancelled");
      await Promise.resolve();

      expect(upstreamCancelled).toBe(true);
      expect(lifecycle).toEqual([{ phase: "fail", reason: "cancelled" }]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("only the first finish chunk triggers metering and settlement", async () => {
    const meter: Array<{ inputTokens: number | undefined; outputTokens: number | undefined }> = [];
    const lifecycle: string[] = [];
    try {
      setModelUsageMeter((usage) => {
        meter.push({
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
      });
      setModelUsageGate(async () => ({
        bounds: admittingBounds(),
        async finish() {
          lifecycle.push("finish");
        },
        async fail() {
          lifecycle.push("fail");
        },
      }));
      const wrapped = meteredModelForTests({
        modelId: "gpt-test",
        async doStream() {
          return {
            stream: new ReadableStream<Record<string, unknown>>({
              start(controller) {
                controller.enqueue({
                  type: "finish",
                  usage: {
                    inputTokens: { total: 3 },
                    outputTokens: { total: 2 },
                  },
                });
                controller.enqueue({
                  type: "finish",
                  usage: {
                    inputTokens: { total: 30 },
                    outputTokens: { total: 20 },
                  },
                });
                controller.close();
              },
            }),
          };
        },
      }) as {
        doStream: (params: unknown) => Promise<{
          stream: ReadableStream<Record<string, unknown>>;
        }>;
      };

      const result = await wrapped.doStream({});
      for await (const _part of result.stream) {
      }

      expect(meter).toEqual([{ inputTokens: 3, outputTokens: 2 }]);
      expect(lifecycle).toEqual(["finish"]);
    } finally {
      setModelUsageMeter(undefined);
      setModelUsageGate(undefined);
    }
  });

  test("malformed finish usage is not charged as normal usage", async () => {
    const meter: Array<{ inputTokens: number | undefined; outputTokens: number | undefined }> = [];
    const lifecycle: Array<{ phase: string; reason?: string }> = [];
    try {
      setModelUsageMeter((usage) => {
        meter.push({
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
      });
      setModelUsageGate(async () => ({
        bounds: admittingBounds(),
        async finish() {
          lifecycle.push({ phase: "finish" });
        },
        async fail(failure) {
          lifecycle.push({ phase: "fail", reason: failure.reason });
        },
      }));
      const wrapped = meteredModelForTests({
        modelId: "gpt-test",
        async doStream() {
          return {
            stream: new ReadableStream<Record<string, unknown>>({
              start(controller) {
                controller.enqueue({
                  type: "finish",
                  usage: {
                    inputTokens: { total: -1 },
                    outputTokens: { total: 2.5 },
                  },
                });
                controller.close();
              },
            }),
          };
        },
      }) as {
        doStream: (params: unknown) => Promise<{
          stream: ReadableStream<Record<string, unknown>>;
        }>;
      };

      const result = await wrapped.doStream({});
      let failure: unknown;
      try {
        for await (const _part of result.stream) {
        }
      } catch (error) {
        failure = error;
      }

      expect(meter).toEqual([]);
      // Malformed usage is a distinct settlement failure: no charge is invented, no
      // successful finish is emitted, and the hold stays visible for reconciliation.
      expect(lifecycle).toEqual([]);
      expect(failure).toMatchObject({
        name: "ModelUsageSettlementError",
        code: "usage_invalid",
      });
    } finally {
      setModelUsageMeter(undefined);
      setModelUsageGate(undefined);
    }
  });
});

/** Bounds that admit everything: a counted input far above any fixture, a cap far above any output. */
function admittingBounds() {
  return {
    input: {
      enforced: "counted" as const,
      maximumTokens: 100_000n,
      countInputTokens: () => 1,
    },
    output: { enforced: "provider_cap" as const, maximumTokens: 100_000n },
  };
}

describe("the model usage bound contract (pre-call admission)", () => {
  type WrappedModel = {
    doStream: (params: unknown) => Promise<{
      stream: ReadableStream<Record<string, unknown>>;
    }>;
  };

  /** An inner model that records every call and its effective request parameters. */
  function recordingModel(finishUsage?: { inputTokens: number; outputTokens: number }) {
    const calls: unknown[] = [];
    const model = {
      modelId: "gpt-test",
      async doStream(params: unknown) {
        calls.push(params);
        return {
          stream: new ReadableStream<Record<string, unknown>>({
            start(controller) {
              controller.enqueue({ type: "text-delta", id: "t", delta: "hi" });
              if (finishUsage) {
                controller.enqueue({
                  type: "finish",
                  usage: {
                    inputTokens: { total: finishUsage.inputTokens },
                    outputTokens: { total: finishUsage.outputTokens },
                  },
                });
              }
              controller.close();
            },
          }),
        };
      },
    };
    return { calls, model };
  }

  /** A lifecycle that records its phases against the arrays a test inspects. */
  function recordingLifecycle(bounds: ModelUsageGateLifecycle["bounds"]) {
    const phases: Array<{ phase: string; reason?: string }> = [];
    const lifecycle: ModelUsageGateLifecycle = {
      ...(bounds ? { bounds } : {}),
      finish: async () => {
        phases.push({ phase: "finish" });
      },
      fail: async (failure) => {
        phases.push({ phase: "fail", reason: failure.reason });
      },
    };
    return { phases, lifecycle };
  }

  test("input over the configured maximum is refused before the provider call", async () => {
    const { calls, model } = recordingModel();
    const { phases, lifecycle } = recordingLifecycle({
      input: {
        enforced: "counted",
        maximumTokens: 10n,
        countInputTokens: () => 11,
      },
      output: { enforced: "provider_cap", maximumTokens: 100n },
    });
    try {
      setModelUsageGate(async () => lifecycle);
      const wrapped = meteredModelForTests(model) as WrappedModel;
      await expect(wrapped.doStream({ prompt: [] })).rejects.toMatchObject({
        name: "ModelUsageRefusalError",
        code: "input_over_limit",
      });
      expect(calls).toHaveLength(0);
      expect(phases).toEqual([{ phase: "fail", reason: "bound_refused" }]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("an input bound this deployment cannot prove is refused before the provider call", async () => {
    const { calls, model } = recordingModel();
    const { phases, lifecycle } = recordingLifecycle({
      input: {
        enforced: "unsupported",
        reason:
          "the OpenAI-compatible chat adapter offers no exact pre-call input token count",
      },
      output: { enforced: "provider_cap", maximumTokens: 100n },
    });
    try {
      setModelUsageGate(async () => lifecycle);
      const wrapped = meteredModelForTests(model) as WrappedModel;
      await expect(wrapped.doStream({ prompt: [] })).rejects.toMatchObject({
        name: "ModelUsageRefusalError",
        code: "input_bound_unsupported",
      });
      expect(calls).toHaveLength(0);
      expect(phases).toEqual([{ phase: "fail", reason: "bound_refused" }]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("a fit is applied before counting and the fitted request reaches the provider", async () => {
    const { calls, model } = recordingModel({ inputTokens: 1, outputTokens: 1 });
    const original = {
      prompt: [
        { role: "system", content: "sys" },
        { role: "user", content: "old ".repeat(200) },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "new question" },
      ],
    };
    const fitted = {
      prompt: [
        { role: "system", content: "sys" },
        { role: "user", content: "new question" },
      ],
    };
    const { phases, lifecycle } = recordingLifecycle({
      input: {
        enforced: "counted",
        maximumTokens: 50n,
        countInputTokens: (params: unknown) => {
          // The counter must see the FITTED request, not the original.
          expect(params).toEqual(fitted);
          return 20;
        },
        fit: () => fitted,
      },
      output: { enforced: "provider_cap", maximumTokens: 100n },
    });
    try {
      setModelUsageGate(async () => lifecycle);
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream(original);
      for await (const _part of result.stream) {
        // Drain the stream: settlement happens on the finish part.
      }
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ prompt: fitted.prompt });
      expect(phases).toEqual([{ phase: "finish" }]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("a fit that cannot bring the request under the bound leaves it refused", async () => {
    const { calls, model } = recordingModel();
    const { phases, lifecycle } = recordingLifecycle({
      input: {
        enforced: "counted",
        maximumTokens: 10n,
        countInputTokens: () => 11,
        fit: (params: unknown) => params,
      },
      output: { enforced: "provider_cap", maximumTokens: 100n },
    });
    try {
      setModelUsageGate(async () => lifecycle);
      const wrapped = meteredModelForTests(model) as WrappedModel;
      await expect(wrapped.doStream({ prompt: [] })).rejects.toMatchObject({
        name: "ModelUsageRefusalError",
        code: "input_over_limit",
      });
      expect(calls).toHaveLength(0);
      expect(phases).toEqual([{ phase: "fail", reason: "bound_refused" }]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("an output cap this provider cannot enforce is refused before the provider call", async () => {
    const { calls, model } = recordingModel();
    const { phases, lifecycle } = recordingLifecycle({
      input: {
        enforced: "counted",
        maximumTokens: 10n,
        countInputTokens: () => 1,
      },
      output: {
        enforced: "unsupported",
        reason: "the adapter drops maxOutputTokens",
      },
    });
    try {
      setModelUsageGate(async () => lifecycle);
      const wrapped = meteredModelForTests(model) as WrappedModel;
      await expect(wrapped.doStream({ prompt: [] })).rejects.toMatchObject({
        name: "ModelUsageRefusalError",
        code: "output_bound_unsupported",
      });
      expect(calls).toHaveLength(0);
      expect(phases).toEqual([{ phase: "fail", reason: "bound_refused" }]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("an admitted lifecycle without bounds is refused before the provider call", async () => {
    const { calls, model } = recordingModel();
    const { phases, lifecycle } = recordingLifecycle(undefined);
    try {
      setModelUsageGate(async () => lifecycle);
      const wrapped = meteredModelForTests(model) as WrappedModel;
      await expect(wrapped.doStream({ prompt: [] })).rejects.toMatchObject({
        name: "ModelUsageRefusalError",
        code: "model_bounds_missing",
      });
      expect(calls).toHaveLength(0);
      expect(phases).toEqual([{ phase: "fail", reason: "bound_refused" }]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("a failing or non-whole input count is a refusal, never an approximation", async () => {
    const { calls, model } = recordingModel();
    const { phases, lifecycle } = recordingLifecycle({
      input: {
        enforced: "counted",
        maximumTokens: 10n,
        countInputTokens: () => {
          throw new Error("counter unavailable");
        },
      },
      output: { enforced: "provider_cap", maximumTokens: 100n },
    });
    try {
      setModelUsageGate(async () => lifecycle);
      const wrapped = meteredModelForTests(model) as WrappedModel;
      await expect(wrapped.doStream({ prompt: [] })).rejects.toMatchObject({
        name: "ModelUsageRefusalError",
        code: "input_bound_unsupported",
      });
      expect(calls).toHaveLength(0);
      expect(phases).toEqual([{ phase: "fail", reason: "bound_refused" }]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("exactly-at-limit input is admitted and the configured cap reaches the provider request", async () => {
    const { calls, model } = recordingModel({ inputTokens: 10, outputTokens: 7 });
    const { phases, lifecycle } = recordingLifecycle({
      input: {
        enforced: "counted",
        maximumTokens: 10n,
        countInputTokens: () => 10,
      },
      output: { enforced: "provider_cap", maximumTokens: 7n },
    });
    try {
      setModelUsageGate(async () => lifecycle);
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const first = await wrapped.doStream({ prompt: [], maxOutputTokens: 20 });
      for await (const _part of first.stream) {
      }
      // A caller's smaller request is never raised to the configured cap.
      const second = await wrapped.doStream({ prompt: [], maxOutputTokens: 3 });
      for await (const _part of second.stream) {
      }
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ maxOutputTokens: 7 });
      expect(calls[1]).toMatchObject({ maxOutputTokens: 3 });
      expect(phases).toEqual([
        { phase: "finish" },
        { phase: "finish" },
      ]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("a finish above the advertised bound fails visibly and keeps the hold", async () => {
    const meter: number[] = [];
    const { calls, model } = recordingModel({ inputTokens: 3, outputTokens: 6 });
    const { phases, lifecycle } = recordingLifecycle({
      input: {
        enforced: "counted",
        maximumTokens: 10n,
        countInputTokens: () => 3,
      },
      output: { enforced: "provider_cap", maximumTokens: 5n },
    });
    try {
      setModelUsageMeter(() => {
        meter.push(1);
      });
      setModelUsageGate(async () => lifecycle);
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({ prompt: [] });
      let failure: unknown;
      try {
        for await (const _part of result.stream) {
        }
      } catch (error) {
        failure = error;
      }
      expect(calls).toHaveLength(1);
      expect(meter).toEqual([]);
      // Neither finish (no charge invented) nor fail (the hold stays reserved for
      // reconciliation) runs: the provider broke its advertised bound.
      expect(phases).toEqual([]);
      expect(failure).toMatchObject({
        name: "ModelUsageSettlementError",
        code: "usage_over_bound",
      });
    } finally {
      setModelUsageMeter(undefined);
      setModelUsageGate(undefined);
    }
  });

  test("the real OpenAI chat adapter carries the configured cap on the outgoing request", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const sse = [
      `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-test",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const model = createOpenAI({
      apiKey: STUB_MODEL_KEY,
      baseURL: "http://adapter.test/v1",
      fetch: (async (
        _input: unknown,
        init?: { body?: BodyInit | null },
      ) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as unknown as typeof fetch,
    }).chat("gpt-4o-mini");
    const finishes: number[] = [];
    try {
      setModelUsageGate(async () => ({
        bounds: {
          input: {
            enforced: "counted",
            maximumTokens: 50n,
            countInputTokens: () => 4,
          },
          output: { enforced: "provider_cap", maximumTokens: 7n },
        },
        finish: async (usage) => {
          finishes.push((usage as { outputTokens?: number }).outputTokens ?? 0);
        },
      }));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
      for await (const _part of result.stream) {
      }
      expect(requests).toHaveLength(1);
      // The adapter maps maxOutputTokens to max_tokens, which the chat-completions
      // contract enforces: this is the provider cap the bound contract claims.
      expect(requests[0]).toMatchObject({ max_tokens: 7 });
      expect(finishes).toEqual([2]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("an over-budget input makes zero provider requests through the real adapter", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const model = createOpenAI({
      apiKey: STUB_MODEL_KEY,
      baseURL: "http://adapter.test/v1",
      fetch: (async (
        _input: unknown,
        init?: { body?: BodyInit | null },
      ) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as unknown as typeof fetch,
    }).chat("gpt-4o-mini");
    try {
      setModelUsageGate(async () => ({
        bounds: {
          input: {
            enforced: "counted",
            maximumTokens: 10n,
            countInputTokens: () => 11,
          },
          output: { enforced: "provider_cap", maximumTokens: 7n },
        },
      }));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      await expect(
        wrapped.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        }),
      ).rejects.toMatchObject({
        name: "ModelUsageRefusalError",
        code: "input_over_limit",
      });
      expect(requests).toHaveLength(0);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("a finish whose durable write fails rejects the stream and keeps the hold", async () => {
    const { calls, model } = recordingModel({ inputTokens: 3, outputTokens: 2 });
    const phases: Array<{ phase: string; reason?: string }> = [];
    try {
      setModelUsageGate(async () => ({
        bounds: admittingBounds(),
        // The lifecycle owner's outbox write failed after the provider finished.
        finish: async () => {
          phases.push({ phase: "finish" });
          throw new ModelUsageSettlementError("usage_outbox_write_failed");
        },
        fail: async (failure) => {
          phases.push({ phase: "fail", reason: failure.reason });
        },
      }));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({ prompt: [] });
      const parts: string[] = [];
      let failure: unknown;
      try {
        for await (const part of result.stream) {
          parts.push(String((part as { type?: string }).type));
        }
      } catch (error) {
        failure = error;
      }
      // The provider worked, but no successful finish may be reported: the finish chunk
      // never reaches the consumer, the stream rejects, and — because the work was
      // chargeable — the hold is NOT released, leaving it for reconciliation.
      expect(calls).toHaveLength(1);
      expect(parts).toEqual(["text-delta"]);
      expect(failure).toMatchObject({
        name: "ModelUsageSettlementError",
        code: "usage_outbox_write_failed",
      });
      expect(phases).toEqual([{ phase: "finish" }]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("a finish whose durable write fails still reports the call's one settlement_failed span (OCR R5-47)", async () => {
    const { calls, model } = recordingModel({ inputTokens: 3, outputTokens: 2 });
    const spans: BuiltinModelSpanFact[] = [];
    try {
      setBuiltinModelSpanObserver((fact) => spans.push(fact));
      setModelUsageGate(async () => ({
        bounds: admittingBounds(),
        // The lifecycle owner's outbox write failed after the provider finished.
        finish: async () => {
          throw new ModelUsageSettlementError("usage_persistence_failed");
        },
      }));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({ prompt: [] });
      let failure: unknown;
      try {
        for await (const _part of result.stream) {
        }
      } catch (error) {
        failure = error;
      }
      expect(calls).toHaveLength(1);
      expect(failure).toMatchObject({
        name: "ModelUsageSettlementError",
        code: "usage_persistence_failed",
      });
      // OCR R5-47 regression: settleFinish claims `settled` BEFORE awaiting
      // lifecycle.finish, so when that await rejects the settlement-failure
      // exit read the borrowed flag as "verdict already on record" and the
      // call produced ZERO spans (pre-V5 reported exactly one
      // settlement_failed). What is on record is the span flag's business,
      // not the billing flag's: exactly one span, naming the failure.
      expect(spans).toHaveLength(1);
      expect(spans[0].ending).toEqual({
        kind: "settlement_failed",
        code: "usage_persistence_failed",
      });
    } finally {
      setBuiltinModelSpanObserver(undefined);
      setModelUsageGate(undefined);
    }
  });

  test("a refusing finish is not re-recorded as unsettled evidence", async () => {
    const { calls, model } = recordingModel({ inputTokens: 3, outputTokens: 2 });
    const phases: Array<{ phase: string; reason?: string }> = [];
    const unsettled: Array<{ inputTokens: number; outputTokens: number; reason: string }> = [];
    try {
      setModelUsageGate(async () => ({
        bounds: admittingBounds(),
        // The finish path's owner (index.ts) writes the evidence row carrying the REAL token
        // counts before it rethrows, so a second record from the failure path could only be a
        // 0/0 duplicate the outbox rejects with a usage_evidence_superseded warn (final review,
        // Minor 1). The failure path stays silent; the hold stays held for reconciliation.
        finish: async () => {
          phases.push({ phase: "finish" });
          throw new ModelUsageSettlementError("usage_pricing_refused");
        },
        fail: async (failure) => {
          phases.push({ phase: "fail", reason: failure.reason });
        },
        recordUnsettled: async (input) => {
          unsettled.push({
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            reason: input.reason,
          });
        },
      }));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({ prompt: [] });
      let failure: unknown;
      try {
        for await (const _part of result.stream) {
        }
      } catch (error) {
        failure = error;
      }
      // The stream still errors with the settlement error the finish threw.
      expect(calls).toHaveLength(1);
      expect(failure).toMatchObject({
        name: "ModelUsageSettlementError",
        code: "usage_pricing_refused",
      });
      // The finish ran and threw, and the reservation is still not released: no fail call,
      // so nothing can hand the hold back.
      expect(phases).toEqual([{ phase: "finish" }]);
      expect(unsettled).toEqual([]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("a retried finish for the identical event succeeds once", async () => {
    const { model } = recordingModel({ inputTokens: 3, outputTokens: 2 });
    const phases: string[] = [];
    try {
      setModelUsageGate(async () => ({
        bounds: admittingBounds(),
        // record() answered { inserted: false } for identical facts: the durable row
        // already stands, so the finish resolves and the run reports success exactly once.
        finish: async () => {
          phases.push("finish");
        },
        fail: async () => {
          phases.push("fail");
        },
      }));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({ prompt: [] });
      const parts: string[] = [];
      for await (const part of result.stream) {
        parts.push(String((part as { type?: string }).type));
      }
      expect(parts).toEqual(["text-delta", "finish"]);
      expect(phases).toEqual(["finish"]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("a billed run without a provable input bound is refused before the provider", async () => {
    const environment = {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    };
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, environment);
    const recorder = new LLMock();
    const originalBase = process.env.OPENAI_BASE_URL;
    let providerCalls = 0;
    const phases: Array<{ phase: string; reason?: string }> = [];
    try {
      process.env.OPENAI_BASE_URL = await recorder.start();
      recorder.onMessage(/.*/, () => {
        providerCalls += 1;
        return { type: "text", content: "must never be reached" };
      });
      // The production declaration for the OpenAI-compatible chat adapter: the output
      // cap is provider-enforced, the input bound is not provable, so the run refuses.
      setModelUsageGate(async () => ({
        bounds: {
          input: {
            enforced: "unsupported",
            reason:
              "no exact pre-call input token count or provider-enforced input ceiling",
          },
          output: { enforced: "provider_cap", maximumTokens: 1000n },
        },
        finish: async () => {
          phases.push({ phase: "finish" });
        },
        fail: async (failure) => {
          phases.push({ phase: "fail", reason: failure.reason });
        },
      }));
      const agents = await resolveRuntimeAgents(
        () => [
          {
            id: "general-assistant",
            name: "General Assistant",
            type: "built_in" as const,
            systemPrompt: "Be helpful.",
          },
        ],
        model,
        async () => STUB_MODEL_KEY,
      );
      const agent = agents["general-assistant"]?.clone();
      if (!agent) throw new Error("Expected General Assistant.");
      agent.addMessage({
        id: "input-bound-refusal-request",
        role: "user",
        content: "This request must be refused for lack of a provable input bound.",
      });
      await expect(agent.runAgent()).rejects.toBeDefined();
      expect(providerCalls).toBe(0);
      expect(phases).toEqual([{ phase: "fail", reason: "bound_refused" }]);
    } finally {
      setModelUsageGate(undefined);
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await recorder.stop();
    }
  });
});

/*
 * Usage source attribution (2026-10-13 audit, F6): the wrapper reads the caller's origin at
 * doStream time — where the request context still exists — and hands it to the billing gate
 * with the event, so the gate's outbox write can record the surface the call really came from
 * instead of a hardcoded "web".
 */
describe("model usage origin", () => {
  test("the gate receives the caller's real origin with the event", async () => {
    const environment = {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    };
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, environment);
    const recorder = new LLMock();
    const originalBase = process.env.OPENAI_BASE_URL;
    const origins: (string | undefined)[] = [];
    try {
      process.env.OPENAI_BASE_URL = await recorder.start();
      recorder.onMessage(
        /Complete the origin fixture request\./,
        { type: "text", content: "Origin fixture completed." },
        { inputTokens: 120, outputTokens: 30 },
      );
      setModelUsageGate(async (input) => {
        origins.push((input as { client?: string }).client);
        return {
          bounds: {
            input: {
              enforced: "counted" as const,
              maximumTokens: 1_000_000n,
              countInputTokens: () => 42,
            },
            output: {
              enforced: "provider_cap" as const,
              maximumTokens: 8_192n,
            },
          },
        };
      });
      const agents = await resolveRuntimeAgents(
        () => [
          {
            id: "origin-agent",
            name: "Origin Agent",
            type: "built_in" as const,
            systemPrompt: "Be helpful.",
          },
        ],
        model,
        async () => STUB_MODEL_KEY,
      );
      const agent = agents["origin-agent"]?.clone();
      if (!agent) throw new Error("Expected Origin Agent.");
      agent.addMessage({
        id: "origin-request",
        role: "user",
        content: "Complete the origin fixture request.",
      });
      await withUsageOrigin("cli", () => agent.runAgent());
      expect(origins).toContain("cli");
    } finally {
      setModelUsageGate(undefined);
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await recorder.stop();
    }
  });
});

describe("an unknown usage outcome keeps the hold (audit A2)", () => {
  type WrappedModel = {
    doStream: (params: unknown) => Promise<{
      stream: ReadableStream<Record<string, unknown>>;
    }>;
  };

  /** A wrapped model whose upstream emits exactly these parts, then closes. */
  function modelEmitting(parts: Record<string, unknown>[]) {
    return meteredModelForTests({
      modelId: "GLM-5.3",
      async doStream() {
        return {
          stream: new ReadableStream<Record<string, unknown>>({
            start(controller) {
              for (const part of parts) controller.enqueue(part);
              controller.close();
            },
          }),
        };
      },
    }) as WrappedModel;
  }

  test("a stream that ends with no finish part reports usage_missing, not no_usage", async () => {
    const reasons: string[] = [];
    try {
      setModelUsageGate(async () => ({
        bounds: admittingBounds(),
        fail: (input) => {
          reasons.push(input.reason);
        },
      }));
      const model = meteredModelForTests({
        modelId: "GLM-5.3",
        async doStream() {
          return { stream: new ReadableStream({ start(c) { c.close(); } }) };
        },
      }) as WrappedModel;
      for await (const _part of (await model.doStream({})).stream) {
      }
      expect(reasons).toEqual(["usage_missing"]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("a finish part with no usage numbers reports usage_missing", async () => {
    const reasons: string[] = [];
    try {
      setModelUsageGate(async () => ({
        bounds: admittingBounds(),
        fail: (i) => {
          reasons.push(i.reason);
        },
      }));
      const model = modelEmitting([
        { type: "finish", usage: { inputTokens: {}, outputTokens: {} } },
      ]);
      for await (const _part of (await model.doStream({})).stream) {
      }
      expect(reasons).toEqual(["usage_missing"]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("a finish part that reports only half its usage is unknown, not a half-billable fact", async () => {
    const reasons: string[] = [];
    try {
      setModelUsageGate(async () => ({
        bounds: admittingBounds(),
        fail: (i) => {
          reasons.push(i.reason);
        },
      }));
      const model = modelEmitting([
        { type: "finish", usage: { inputTokens: { total: 12 }, outputTokens: {} } },
      ]);
      for await (const _part of (await model.doStream({})).stream) {
      }
      expect(reasons).toEqual(["usage_missing"]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("a finish part that reports zero tokens is a confirmed no-cost and stays no_usage", async () => {
    const reasons: string[] = [];
    try {
      setModelUsageGate(async () => ({
        bounds: admittingBounds(),
        fail: (i) => {
          reasons.push(i.reason);
        },
      }));
      const model = modelEmitting([
        {
          type: "finish",
          usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
        },
      ]);
      for await (const _part of (await model.doStream({})).stream) {
      }
      expect(reasons).toEqual(["no_usage"]);
    } finally {
      setModelUsageGate(undefined);
    }
  });
});

/*
 * Audit A3: an over-bound finish is work the provider produced and this deployment refuses to
 * charge. The tokens must not die with the stream error — they leave as durable evidence the
 * gate can hand to the outbox, with the hold retained.
 */
describe("an over-bound finish leaves its tokens behind (audit A3)", () => {
  /** An upstream that emits exactly these parts, then closes. */
  function streamOf(parts: Record<string, unknown>[]) {
    return new ReadableStream<Record<string, unknown>>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
  }

  /** Drain a stream to its end (or its error). */
  async function consume(stream: ReadableStream<Record<string, unknown>>) {
    for await (const _part of stream) {
    }
  }

  test("the settlement failure records the real usage before the stream errors", async () => {
    const evidence: { inputTokens: number; outputTokens: number; reason: string }[] = [];
    try {
      setModelUsageGate(async () => ({
        bounds: {
          input: {
            enforced: "counted" as const,
            maximumTokens: 100n,
            countInputTokens: async () => 10,
          },
          output: { enforced: "provider_cap" as const, maximumTokens: 100n },
        },
        recordUnsettled: (input) => {
          evidence.push({
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            reason: input.reason,
          });
        },
      }));
      const model = meteredModelForTests({
        modelId: "GLM-5.3",
        doStream: async () => ({
          stream: streamOf([
            { type: "finish", usage: { inputTokens: { total: 900 }, outputTokens: { total: 10 } } },
          ]),
        }),
      });

      const stream = (await model.doStream({} as never)).stream;
      await expect(consume(stream)).rejects.toThrow(/usage_over_bound/);
      expect(evidence).toEqual([
        { inputTokens: 900, outputTokens: 10, reason: "usage_over_bound" },
      ]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("malformed usage records what arrived and names the reason", async () => {
    const evidence: string[] = [];
    try {
      setModelUsageGate(async () => ({
        // The brief's sketch omitted bounds; without them admission refuses
        // model_bounds_missing before the provider is called and this finish is never reached.
        bounds: admittingBounds(),
        recordUnsettled: (input) => {
          evidence.push(input.reason);
        },
      }));
      const model = meteredModelForTests({
        modelId: "GLM-5.3",
        doStream: async () => ({
          stream: streamOf([
            { type: "finish", usage: { inputTokens: { total: -1 }, outputTokens: { total: 5 } } },
          ]),
        }),
      });
      await expect(consume((await model.doStream({} as never)).stream)).rejects.toThrow(/usage_invalid/);
      expect(evidence).toEqual(["usage_invalid"]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("a half-reported usage carries the reported half to the fail path's evidence", async () => {
    const seen: Array<{ reason: string; inputTokens?: number; outputTokens?: number }> = [];
    try {
      setModelUsageGate(async () => ({
        bounds: admittingBounds(),
        fail: (input) => {
          seen.push({
            reason: input.reason,
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
          });
        },
      }));
      const model = meteredModelForTests({
        modelId: "GLM-5.3",
        doStream: async () => ({
          stream: streamOf([
            { type: "finish", usage: { inputTokens: { total: 12 }, outputTokens: {} } },
          ]),
        }),
      });
      await consume((await model.doStream({} as never)).stream);
      // index.ts writes failure.inputTokens ?? 0 into the evidence row: the reported half
      // survives, the unreported half stays an honest zero rather than a guessed one.
      expect(seen).toEqual([
        { reason: "usage_missing", inputTokens: 12, outputTokens: undefined },
      ]);
    } finally {
      setModelUsageGate(undefined);
    }
  });
});

/*
 * Audit A4: a refusal must name its real cause. "No credits left" was the one sentence for
 * three different failures — prices never configured, this model never priced, and a balance
 * that cannot fund the hold — and each of them sends an administrator to a different fix.
 */
describe("a refusal names its real cause (audit A4)", () => {
  /** An upstream that emits exactly these parts, then closes. */
  function streamOf(parts: Record<string, unknown>[]) {
    return new ReadableStream<Record<string, unknown>>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
  }

  test("an unconfigured credit policy is not 'no credits left'", async () => {
    try {
      const model = meteredModelForTests({
        modelId: "GLM-5.3",
        doStream: async () => ({ stream: streamOf([]) }),
      });
      setModelUsageGate(async () => {
        throw new CreditPolicyUnconfiguredError([
          { key: "BILLING_MODEL_CREDIT_RATES", reason: "missing" },
        ]);
      });
      await expect(model.doStream({} as never)).rejects.toMatchObject({
        name: "CreditPolicyUnconfiguredError",
        code: "credit_policy_unconfigured",
      });
      await expect(model.doStream({} as never)).rejects.not.toMatchObject({
        code: "credits_exhausted",
      });
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("an unpriced model names the model, not the balance", async () => {
    try {
      const model = meteredModelForTests({
        modelId: "gpt-4o-mini",
        doStream: async () => ({ stream: streamOf([]) }),
      });
      setModelUsageGate(async () => {
        throw new ModelNotPricedError("gpt-4o-mini");
      });
      await expect(model.doStream({} as never)).rejects.toMatchObject({
        code: "model_not_priced",
        modelId: "gpt-4o-mini",
      });
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("a gate that broke for an unknown reason stays fail-closed under its own name", async () => {
    try {
      const model = meteredModelForTests({
        modelId: "GLM-5.3",
        doStream: async () => ({ stream: streamOf([]) }),
      });
      setModelUsageGate(async () => {
        throw new Error("select 1: connection reset by peer");
      });
      await expect(model.doStream({} as never)).rejects.toMatchObject({
        code: "credit_gate_failed",
      });
      await expect(model.doStream({} as never)).rejects.toThrow(
        /^(?!.*connection reset).*$/,
      );
    } finally {
      setModelUsageGate(undefined);
    }
  });
});
