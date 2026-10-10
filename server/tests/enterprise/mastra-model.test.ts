import { expect, test } from "bun:test";
import type { LanguageModelV3 } from "ai";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  createGovernedMastraModel,
  type GovernedModelDependencies,
} from "../../src/mastra/model";

const scope: PlatformScope = {
  tenantId: "tenant",
  workspaceId: "workspace",
  principalId: "principal",
  actorId: "actor",
  memberEpoch: 1,
  aclEpoch: 1,
  entrypoint: "desktop",
};
const context = {
  scope,
  runId: "run-1",
  attemptId: "attempt-1",
  modelRouteRef: "locked-route",
  signal: new AbortController().signal,
};
const usage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
function model(overrides: Partial<LanguageModelV3> = {}): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "synthetic",
    modelId: "synthetic-model",
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "text-1" });
          controller.enqueue({ type: "text-delta", id: "text-1", delta: "ok" });
          controller.enqueue({ type: "text-end", id: "text-1" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage,
          });
          controller.close();
        },
      }),
    }),
    ...overrides,
  };
}
function dependencies(overrides: Partial<GovernedModelDependencies> = {}) {
  const calls: string[] = [];
  let charged = 0;
  const reserved = new Map<string, number>();
  const deps: GovernedModelDependencies = {
    estimateInputTokenUpperBound: async () => 0,
    runs: {
      issueModelInvocationCapability: async (_scope, input) => {
        calls.push(`issue:${input.maximumTokens}`);
        if (charged + input.maximumTokens > 30)
          throw new Error("RUN_BUDGET_EXCEEDED");
        charged += input.maximumTokens;
        reserved.set(input.modelRequestId, input.maximumTokens);
        return {
          capability: `cap-${input.modelRequestId}`,
          model_request_id: input.modelRequestId,
          maximum_tokens: input.maximumTokens,
          expires_at: "2030-01-01T00:00:00.000Z",
        };
      },
      resolveModelInvocationCapability: async (_scope, cap) => {
        calls.push(`consume:${cap}`);
        return {
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          principalId: scope.principalId,
          runId: context.runId,
          attemptId: context.attemptId,
          generation: 1,
          modelRouteRef: context.modelRouteRef,
          modelRequestId: cap.slice(4),
          maximumTokens: reserved.get(cap.slice(4)) ?? 0,
          expiresAt: "2030-01-01T00:00:00.000Z",
        };
      },
      confirmModelInvocationUsage: async (_scope, cap, amount) => {
        calls.push(`confirm:${cap}:${amount}`);
        const requestId = cap.slice(4);
        charged -= (reserved.get(requestId) ?? amount) - amount;
        reserved.set(requestId, amount);
      },
      markModelInvocationUnknown: async (_scope, cap) => {
        calls.push(`unknown:${cap}`);
      },
      releaseModelInvocation: async (_scope, cap) => {
        calls.push(`release:${cap}`);
      },
    } as never,
    getAttemptGeneration: async () => 1,
    adapter: {
      selectModel: async (ref) => {
        calls.push(`route:${ref}`);
        return {
          model: { provider: "openai", defaultModel: "synthetic" },
          credentialSecretRef: "secret-ref",
        };
      },
      resolveApiKey: async () => {
        calls.push("secret");
        return "private-key";
      },
      runtimeModel: (route) => {
        calls.push("runtime");
        return route.model;
      },
    } as never,
    createModel: async () => {
      calls.push("provider");
      return model();
    },
    createPlanModel: () => model(),
    environment: {},
    ...overrides,
  };
  return { deps, calls };
}

const callOptions = {
  prompt: [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "hello" }],
    },
  ],
  maxOutputTokens: 20,
  tools: [
    {
      type: "function" as const,
      name: "lookup",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
};

test("every nested model request gets a separate capability and shared run ceiling rejects excess", async () => {
  const { deps, calls } = dependencies();
  const wrapped = await createGovernedMastraModel(deps, context);
  await wrapped.doGenerate(callOptions);
  await wrapped.doGenerate(callOptions);
  await wrapped.doGenerate(callOptions);
  await expect(wrapped.doGenerate(callOptions)).rejects.toThrow(
    "MODEL_INVOCATION_FAILED",
  );
  expect(calls.filter((call) => call.startsWith("issue:"))).toHaveLength(4);
  expect(calls.filter((call) => call.startsWith("consume:"))).toHaveLength(3);
});

test("reserves the input upper bound plus the output cap", async () => {
  const { deps, calls } = dependencies({
    estimateInputTokenUpperBound: async () => 7,
  } as never);
  const wrapped = await createGovernedMastraModel(deps, context);
  await wrapped.doGenerate(callOptions);
  expect(calls).toContain("issue:27");
});

test("an estimator cannot mutate the selected provider, model, or plan route", async () => {
  const selectedRoute = {
    model: { provider: "openai", defaultModel: "selected-model" },
    credentialSecretRef: "selected-secret",
  };
  const calls: string[] = [];
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => selectedRoute,
      runtimeModel: (route) => {
        calls.push(
          `runtime:${route.model.provider}:${route.model.defaultModel}`,
        );
        return route.model;
      },
      resolveApiKey: async (route, provider) => {
        calls.push(`key:${provider}:${route.credentialSecretRef}`);
        return "selected-key";
      },
    } as never,
    estimateInputTokenUpperBound: async (route) => {
      const mutable = route as unknown as {
        model: { provider: string; defaultModel: string; plan?: unknown };
        credentialSecretRef: string;
      };
      Reflect.set(mutable.model, "provider", "anthropic");
      Reflect.set(mutable.model, "defaultModel", "attacker-model");
      Reflect.set(mutable.model, "plan", {
        provider: "chatgpt",
        endpoint: new URL("https://attacker.invalid"),
        token: "attacker-token",
      });
      Reflect.set(mutable, "credentialSecretRef", "attacker-secret");
      return 0;
    },
    createModel: async (route) => {
      calls.push(`create:${route.model.provider}:${route.model.defaultModel}`);
      return model();
    },
    createPlanModel: () => {
      calls.push("plan");
      return model();
    },
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  await wrapped.doGenerate(callOptions);
  expect(calls).toEqual([
    "runtime:openai:selected-model",
    "key:openai:selected-secret",
    "create:openai:selected-model",
  ]);
});

test("an estimator cannot mutate the selected PlanModel endpoint", async () => {
  const selectedEndpoint = "https://selected.invalid/model?tenant=one";
  let planEndpoint: URL | undefined;
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL(selectedEndpoint),
            token: "selected-token",
          },
        },
        credentialSecretRef: "selected-secret",
        planBotId: "selected-bot",
      }),
      runtimeModel: (route) => route.model,
    } as never,
    estimateInputTokenUpperBound: async (route) => {
      const endpoint = route.model.plan?.endpoint as unknown;
      expect(typeof endpoint).toBe("string");
      expect(
        Reflect.set(
          route.model.plan as object,
          "endpoint",
          "https://attacker.invalid",
        ),
      ).toBe(false);
      if (endpoint instanceof URL) {
        endpoint.href = "https://attacker.invalid/model";
        endpoint.searchParams.set("tenant", "attacker");
      }
      expect(route.model.plan?.endpoint as unknown).toBe(selectedEndpoint);
      return 0;
    },
    createPlanModel: (config) => {
      planEndpoint = config.endpoint;
      return model();
    },
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  await wrapped.doGenerate(callOptions);
  expect(planEndpoint?.href).toBe(selectedEndpoint);
});

test("rejects an unbounded prompt before capability, secret, or provider resolution", async () => {
  const { deps, calls } = dependencies({
    estimateInputTokenUpperBound: async () => undefined,
  } as never);
  const wrapped = await createGovernedMastraModel(deps, context);
  await expect(wrapped.doGenerate(callOptions)).rejects.toThrow(
    "MODEL_INVOCATION_FAILED",
  );
  expect(calls.some((call) => call.startsWith("issue:"))).toBe(false);
  expect(calls).not.toContain("secret");
  expect(calls).not.toContain("provider");
});

test("reservation amount competes against the run ceiling using input plus output", async () => {
  const { deps, calls } = dependencies({
    estimateInputTokenUpperBound: async () => 1,
    createModel: async () =>
      model({
        doGenerate: async () => ({
          content: [],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: undefined },
            outputTokens: { total: undefined },
          },
          warnings: [],
        }),
      }),
  } as never);
  const wrapped = await createGovernedMastraModel(deps, context);
  await wrapped.doGenerate(callOptions);
  await expect(wrapped.doGenerate(callOptions)).rejects.toThrow(
    "MODEL_INVOCATION_FAILED",
  );
  expect(calls.filter((call) => call === "issue:21")).toHaveLength(2);
  expect(calls.filter((call) => call.startsWith("consume:")).length).toBe(1);
});

test("ambient conflicting route values do not change selected route", async () => {
  const { deps } = dependencies({
    environment: {
      BOT_PROVIDER: "anthropic",
      BOT_MODEL: "ambient-model",
      OPENAI_BASE_URL: "https://example.invalid/override",
    },
    estimateInputTokenUpperBound: async () => 1,
  } as never);
  const wrapped = await createGovernedMastraModel(deps, context);
  await wrapped.doGenerate({
    ...callOptions,
    provider: "anthropic",
    modelId: "ambient-model",
  } as never);
});

test("settlement failure withholds finish and returns a generic stream error", async () => {
  const { deps } = dependencies({
    runs: {
      ...dependencies().deps.runs,
      confirmModelInvocationUsage: async () => {
        throw new Error("settlement-private");
      },
    } as never,
    estimateInputTokenUpperBound: async () => 1,
  } as never);
  const wrapped = await createGovernedMastraModel(deps, context);
  const result = await wrapped.doStream(callOptions);
  const reader = result.stream.getReader();
  let sawFinish = false;
  let observedError: unknown;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.type === "finish") sawFinish = true;
    }
  } catch (error) {
    observedError = error;
  }
  expect(sawFinish).toBe(false);
  expect(observedError).toBeInstanceOf(Error);
  expect((observedError as Error).message).toBe("MODEL_INVOCATION_FAILED");
});

test("redaction preserves binary parts byte-for-byte", async () => {
  const bytes = new TextEncoder().encode("private-key");
  const { deps } = dependencies({
    createModel: async () =>
      model({
        doGenerate: async () => ({
          content: [
            { type: "file", data: bytes, mimeType: "application/octet-stream" },
          ],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const result = await wrapped.doGenerate(callOptions);
  expect((result.content[0] as { data: Uint8Array }).data).toEqual(bytes);
});

test("stream redaction preserves binary file bytes exactly", async () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const { deps } = dependencies({
    createModel: async () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "file",
                data: bytes,
                mimeType: "application/octet-stream",
              });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage,
              });
              controller.close();
            },
          }),
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const result = await wrapped.doStream(callOptions);
  const reader = result.stream.getReader();
  const part = await reader.read();
  expect(part.value).toMatchObject({
    type: "file",
    mimeType: "application/octet-stream",
  });
  expect((part.value as { data: Uint8Array }).data).toEqual(bytes);
  await reader.cancel();
});

test("usage confirmation completes before finish is observable", async () => {
  const calls: string[] = [];
  const { deps } = dependencies({
    runs: {
      ...dependencies().deps.runs,
      confirmModelInvocationUsage: async (_scope, _cap, amount) => {
        await Promise.resolve();
        calls.push(`confirmed:${amount}`);
      },
    } as never,
    createModel: async () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage,
              });
              controller.close();
            },
          }),
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const result = await wrapped.doStream(callOptions);
  const reader = result.stream.getReader();
  const finish = await reader.read();
  expect(finish.value?.type).toBe("finish");
  expect(calls).toEqual(["confirmed:5"]);
  await reader.cancel();
});

test("abort or unknown usage marks the consumed claim unknown exactly once", async () => {
  const { deps, calls } = dependencies({
    createModel: async () =>
      model({
        doGenerate: async () => {
          throw new Error("provider-private-detail");
        },
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  await expect(wrapped.doGenerate(callOptions)).rejects.toThrow(
    "MODEL_INVOCATION_FAILED",
  );
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(calls.join(" ")).not.toContain("provider-private-detail");
});

test("desktop PlanModel receives caller tools and the call abort signal", async () => {
  const controller = new AbortController();
  const planConfig = {
    provider: "chatgpt" as const,
    endpoint: new URL("https://selected-plan.invalid/model"),
    token: "selected-plan-token",
  };
  const calls: string[] = [];
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: planConfig,
        },
        credentialSecretRef: "selected-secret",
        planBotId: "selected-bot",
      }),
      runtimeModel: (route) => {
        calls.push("runtime");
        return route.model;
      },
      resolveApiKey: async () => {
        calls.push("secret");
        return "native-key";
      },
    } as never,
    createPlanModel: (config, botId) => {
      calls.push(
        `plan:${config.provider}:${config.token}:${config.endpoint.href}:${botId}`,
      );
      return model({
        doGenerate: async (options) => {
          expect(options.tools).toEqual(callOptions.tools);
          expect(options.abortSignal).toBe(controller.signal);
          return {
            content: [],
            finishReason: { unified: "stop", raw: undefined },
            usage,
            warnings: [],
          };
        },
      });
    },
    createModel: async () => {
      calls.push("native");
      return model();
    },
  });
  const wrapped = await createGovernedMastraModel(deps, {
    ...context,
    signal: controller.signal,
  });
  await wrapped.doGenerate({ ...callOptions, abortSignal: controller.signal });
  expect(calls).toEqual([
    "runtime",
    "plan:chatgpt:selected-plan-token:https://selected-plan.invalid/model:selected-bot",
  ]);
});

test.each([
  { selectedProvider: "openai", runtimeProvider: "anthropic" },
  { selectedProvider: "anthropic", runtimeProvider: "openai" },
])(
  "rejects native runtime provider substitution before reading a secret ($selectedProvider -> $runtimeProvider)",
  async ({ selectedProvider, runtimeProvider }) => {
    const calls: string[] = [];
    const { deps } = dependencies({
      adapter: {
        selectModel: async () => ({
          model: { provider: selectedProvider, defaultModel: "selected-model" },
          credentialSecretRef: "selected-secret",
        }),
        runtimeModel: () => ({
          provider: runtimeProvider,
          defaultModel: "selected-model",
        }),
        resolveApiKey: async (_route, provider) => {
          calls.push(`secret:${provider}`);
          return "native-key";
        },
      } as never,
      createModel: async () => {
        calls.push("native");
        return model();
      },
    });
    const wrapped = await createGovernedMastraModel(deps, context);
    await expect(wrapped.doGenerate(callOptions)).rejects.toThrow(
      "MODEL_INVOCATION_FAILED",
    );
    expect(calls).toEqual([]);
  },
);

test("matching native runtime resolves credentials using the locked provider", async () => {
  const calls: string[] = [];
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: { provider: "anthropic", defaultModel: "selected-model" },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async (route, provider) => {
        calls.push(`secret:${provider}:${route.credentialSecretRef}`);
        return "native-key";
      },
    } as never,
    createModel: async (route, apiKey) => {
      calls.push(
        `native:${route.model.provider}:${route.model.defaultModel}:${apiKey}`,
      );
      return model();
    },
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  await wrapped.doGenerate(callOptions);
  expect(calls).toEqual([
    "secret:anthropic:selected-secret",
    "native:anthropic:selected-model:native-key",
  ]);
});

test("runtime adapter cannot inject PlanModel into a selected native route", async () => {
  const calls: string[] = [];
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: { provider: "openai", defaultModel: "selected-native" },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => ({
        ...route.model,
        plan: {
          provider: "chatgpt",
          endpoint: new URL("https://injected.invalid/model"),
          token: "injected-token",
        },
      }),
      resolveApiKey: async (_route, provider) => {
        calls.push(`secret:${provider}`);
        return "native-key";
      },
    } as never,
    createPlanModel: () => {
      calls.push("plan");
      return model();
    },
    createModel: async (route, apiKey) => {
      calls.push(
        `native:${route.model.provider}:${route.model.defaultModel}:${apiKey}`,
      );
      return model();
    },
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  await wrapped.doGenerate(callOptions);
  expect(calls).toEqual([
    "secret:openai",
    "native:openai:selected-native:native-key",
  ]);
});

test("a route mismatch never resolves its secret", async () => {
  const { deps, calls } = dependencies({
    runs: {
      ...dependencies().deps.runs,
      resolveModelInvocationCapability: async () => ({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        principalId: scope.principalId,
        runId: context.runId,
        attemptId: context.attemptId,
        generation: 1,
        modelRouteRef: "forged-route",
        modelRequestId: "req",
        maximumTokens: 20,
        expiresAt: "2030-01-01T00:00:00Z",
      }),
    } as never,
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  await expect(wrapped.doGenerate(callOptions)).rejects.toThrow();
  expect(calls).not.toContain("secret");
});

test("stream failures and missing usage settle unknown and expose no provider secret", async () => {
  const { deps, calls } = dependencies({
    createModel: async () =>
      model({
        doStream: async () => {
          throw new Error("private-key provider failure");
        },
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  await expect(wrapped.doStream(callOptions)).rejects.toThrow(
    "MODEL_INVOCATION_FAILED",
  );
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
});

test("missing generate usage keeps the invocation charged as unknown", async () => {
  const { deps, calls } = dependencies({
    createModel: async () =>
      model({
        doGenerate: async () => ({
          content: [{ type: "text", text: "answer" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: undefined },
            outputTokens: { total: undefined },
          },
          warnings: [],
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  await wrapped.doGenerate(callOptions);
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
});

test("a stream cancelled before finish settles unknown once", async () => {
  const { deps, calls } = dependencies({
    createModel: async () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "text-1" });
              controller.enqueue({
                type: "text-delta",
                id: "text-1",
                delta: "partial",
              });
            },
          }),
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const result = await wrapped.doStream(callOptions);
  const reader = result.stream.getReader();
  await reader.read();
  await reader.cancel();
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
});
