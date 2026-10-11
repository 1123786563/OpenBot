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
  expect(calls.filter((call) => call.startsWith("confirm:"))).toHaveLength(3);
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

for (const [label, maxOutputTokens] of [
  ["missing", undefined],
  ["zero", 0],
  ["negative", -1],
  ["fractional", 1.5],
] as const) {
  test(`rejects a ${label} output cap before any invocation dependencies run`, async () => {
    const { deps, calls } = dependencies({
      getAttemptGeneration: async () => {
        calls.push("generation");
        return 1;
      },
      estimateInputTokenUpperBound: async () => {
        calls.push("estimate");
        return 0;
      },
    });
    const wrapped = await createGovernedMastraModel(deps, context);
    await expect(
      wrapped.doGenerate({ ...callOptions, maxOutputTokens } as never),
    ).rejects.toThrow("MODEL_INVOCATION_FAILED");
    expect(calls).toEqual([]);
  });
}

test("generation lookup failures are generic and happen before capability issue", async () => {
  const { deps, calls } = dependencies({
    getAttemptGeneration: async () => {
      calls.push("generation");
      throw new Error("db-secret https://private.invalid");
    },
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  let thrown: unknown;
  try {
    await wrapped.doGenerate(callOptions);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe("MODEL_INVOCATION_FAILED");
  expect(calls).toEqual(["route:locked-route", "generation"]);
});

test("rejects a same-provider runtime with a different default model before key lookup", async () => {
  const calls: string[] = [];
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: { provider: "openai", defaultModel: "selected-model" },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: () => ({ provider: "openai", defaultModel: "other-model" }),
      resolveApiKey: async () => {
        calls.push("key");
        return "native-key";
      },
    } as never,
    createModel: async () => {
      calls.push("factory");
      return model();
    },
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  await expect(wrapped.doGenerate(callOptions)).rejects.toThrow(
    "MODEL_INVOCATION_FAILED",
  );
  expect(calls).toEqual([]);
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

test("PlanModel finish with unknown usage marks unknown then delivers finish", async () => {
  const calls: string[] = [];
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://plan-secret.invalid/model"),
            token: "plan-secret-token",
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    runs: {
      ...dependencies().deps.runs,
      markModelInvocationUnknown: async () => {
        calls.push("unknown");
      },
      confirmModelInvocationUsage: async () => {
        calls.push("confirm");
      },
    } as never,
    createPlanModel: () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: {
                  inputTokens: { total: undefined },
                  outputTokens: { total: undefined },
                },
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
  expect((await reader.read()).value?.type).toBe("finish");
  expect(calls).toEqual(["unknown"]);
  await reader.cancel();
});

test("stream EOF without finish settles unknown then errors", async () => {
  const calls: string[] = [];
  const { deps } = dependencies({
    runs: {
      ...dependencies().deps.runs,
      markModelInvocationUnknown: async () => {
        calls.push("unknown");
      },
    } as never,
    createModel: async () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const result = await wrapped.doStream(callOptions);
  let thrown: unknown;
  try {
    await result.stream.getReader().read();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe("MODEL_INVOCATION_FAILED");
  expect(calls).toEqual(["unknown"]);
});

test("stream provider Error parts are replaced with a generic safe Error", async () => {
  const { deps } = dependencies({
    createModel: async () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "error",
                error: new Error("private-key https://provider-secret.invalid"),
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
  expect(part.value?.type).toBe("error");
  expect((part.value as { error: Error }).error).toBeInstanceOf(Error);
  expect((part.value as { error: Error }).error.message).toBe(
    "MODEL_INVOCATION_FAILED",
  );
  await reader.cancel();
});

test("PlanModel stream preserves endpoint strings and redacts tokens in emitted values", async () => {
  const token = "plan-secret-token";
  const endpoint = "https://plan-secret.invalid/model";
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL(endpoint),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "text-delta",
                id: "delta",
                delta: `${token} ${endpoint}`,
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
  const deltas: string[] = [];
  let part = await reader.read();
  while (!part.done) {
    if (part.value?.type === "text-delta") deltas.push(part.value.delta);
    part = await reader.read();
  }
  const delta = deltas.join("");
  expect(delta).not.toContain(token);
  expect(delta).toContain(endpoint);
  expect(delta).toContain(" ");
  await reader.cancel();
});

test("PlanModel stream preserves endpoints and redacts tokens in request and response metadata", async () => {
  const token = "plan-secret-token";
  const endpoint = "https://plan-secret.invalid/model";
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL(endpoint),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => {
        throw new Error("PlanModel must not resolve native API keys");
      },
    } as never,
    createPlanModel: () =>
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
          request: {
            body: JSON.stringify({ token, endpoint }),
            metadata: { [token]: `metadata ${token}` },
          },
          response: {
            headers: new Headers({
              authorization: `${token} ${endpoint}`,
              [token]: "header value",
            }),
          },
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const result = await wrapped.doStream(callOptions);
  const metadata = JSON.stringify(result.request);
  expect(metadata).not.toContain(token);
  expect(metadata).toContain(endpoint);
  const responseHeaders = result.response?.headers;
  expect(responseHeaders).toBeInstanceOf(Headers);
  const authorization = (responseHeaders as Headers).get("authorization");
  expect(authorization).not.toContain(token);
  expect(authorization).toContain(endpoint);
  expect(authorization).toContain(" ");
  expect((responseHeaders as Headers).has(token.toLowerCase())).toBe(false);
  expect([...(responseHeaders as Headers).keys()]).toHaveLength(2);
  const reader = result.stream.getReader();
  expect((await reader.read()).value?.type).toBe("finish");
  await reader.cancel();
});

test("stream text delta sanitizes its id and all metadata before buffering", async () => {
  const token = "plan-secret-token";
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://safe.invalid"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "text-delta",
                id: `id-${token}`,
                delta: "sa",
                providerMetadata: { marker: token },
              } as never);
              controller.enqueue({
                type: "text-delta",
                id: `id-${token}`,
                delta: "fe",
                providerMetadata: { marker: token },
              } as never);
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
  const delta = (await reader.read()).value as Record<string, unknown>;
  expect(JSON.stringify(delta)).not.toContain(token);
  expect(delta.id).not.toContain(token);
  expect(JSON.stringify(delta)).not.toContain(token);
  await reader.cancel();
});

test("nested stream metadata fails closed and settles invocation unknown", async () => {
  let nestedCancelled = false;
  let rootCancelled = false;
  const nested = new ReadableStream({
    start(controller) {
      controller.enqueue("private-key");
    },
    cancel() {
      nestedCancelled = true;
      throw new Error("private nested cancellation failure");
    },
  });
  const { deps, calls } = dependencies({
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
            cancel() {
              rootCancelled = true;
            },
          }),
          request: { metadata: { debugStream: nested } },
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  await expect(wrapped.doStream(callOptions)).rejects.toThrow(
    "MODEL_INVOCATION_FAILED",
  );
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
  expect(nestedCancelled).toBe(true);
  expect(rootCancelled).toBe(true);
});

test("text delta nested provider metadata cancels streams and settles unknown", async () => {
  let nestedCancelled = false;
  let rootCancelled = false;
  const nested = new ReadableStream({
    cancel() {
      nestedCancelled = true;
    },
  });
  const { deps, calls } = dependencies({
    createModel: async () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "text-delta",
                id: "text-1",
                delta: "must not escape",
                providerMetadata: { nested: [nested] },
              });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage,
              });
              controller.close();
            },
            cancel() {
              rootCancelled = true;
            },
          }),
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const { stream } = await wrapped.doStream(callOptions);
  const reader = stream.getReader();

  await expect(reader.read()).rejects.toThrow("MODEL_INVOCATION_FAILED");
  expect(nestedCancelled).toBe(true);
  expect(rootCancelled).toBe(true);
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
});

test("nested stream cleanup initiates every cancellation without blocking failure settlement", async () => {
  const cancelled: string[] = [];
  let rootCancelled = false;
  const first = new ReadableStream({
    cancel() {
      cancelled.push("first");
      return new Promise<void>(() => {});
    },
  });
  const second = new ReadableStream({
    cancel() {
      cancelled.push("second");
    },
  });
  const { deps, calls } = dependencies({
    createModel: async () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            cancel() {
              rootCancelled = true;
            },
          }),
          request: { metadata: { first, sibling: [second] } },
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  const outcome = await Promise.race([
    wrapped.doStream(callOptions).then(
      () => "resolved",
      (error: unknown) =>
        error instanceof Error && error.message === "MODEL_INVOCATION_FAILED"
          ? "public-error"
          : "unexpected-error",
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 100)),
  ]);

  expect(outcome).toBe("public-error");
  expect(cancelled).toEqual(["first", "second"]);
  expect(rootCancelled).toBe(true);
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
});

test("header redaction uses safe unique names for redacted and x-redacted secrets", async () => {
  for (const token of ["redacted", "x-redacted"]) {
    const { deps } = dependencies({
      adapter: {
        selectModel: async () => ({
          model: {
            provider: "plan",
            defaultModel: "selected-plan",
            plan: {
              provider: "chatgpt",
              endpoint: new URL("https://plan.invalid/model"),
              token,
            },
          },
          credentialSecretRef: "selected-secret",
        }),
        runtimeModel: (route) => route.model,
        resolveApiKey: async () => "unused-key",
      } as never,
      createPlanModel: () =>
        model({
          doGenerate: async () => ({
            content: [{ type: "text", text: "ok" }],
            finishReason: { unified: "stop", raw: undefined },
            usage,
            warnings: [],
            response: {
              headers: new Headers({
                [token]: "secret-name",
                ordinary: "keep",
              }),
            },
            request: { metadata: { [token]: "secret-name", ordinary: "keep" } },
          }),
        }),
    });
    const wrapped = await createGovernedMastraModel(deps, context);
    const result = await wrapped.doGenerate(callOptions);
    const response = result.response;
    const request = result.request;
    expect(response?.headers).toBeInstanceOf(Headers);
    if (!response || !request) throw new Error("Expected model metadata");
    expect([...(response.headers as Headers).keys()]).not.toContain(token);
    expect(JSON.stringify(request)).not.toContain(token);
    expect((request.metadata as Record<string, string>).ordinary).toBe("keep");
  }
});

test("redacted header and object-key collisions preserve every metadata value", async () => {
  const token = "plan-secret-token";
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://plan.invalid/model"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
      model({
        doGenerate: async () => ({
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
          response: {
            headers: new Headers([
              [token, "secret-header"],
              ["redacted", "ordinary-header"],
            ]),
          },
          request: {
            metadata: { [token]: "secret-object", redacted: "ordinary-object" },
          },
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const result = await wrapped.doGenerate(callOptions);
  const headers = result.response?.headers as Headers;
  expect(headers).toBeInstanceOf(Headers);
  expect([...headers.values()].sort()).toEqual([
    "ordinary-header",
    "secret-header",
  ]);
  const values = Object.values(
    result.request?.metadata as Record<string, string>,
  ).sort();
  expect(values).toEqual(["ordinary-object", "secret-object"]);
});

test("redacted is never recreated in metadata values or stream parts", async () => {
  const token = "redacted";
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://plan.invalid/model"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
      model({
        doGenerate: async () => ({
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
          request: { metadata: { ordinary: token } },
          response: { headers: new Headers({ ordinary: token }) },
        }),
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "text-delta",
                id: "delta",
                delta: token,
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
  const generated = await wrapped.doGenerate(callOptions);
  expect(JSON.stringify(generated.request)).not.toContain(token);
  const headers = generated.response?.headers;
  expect(headers).toBeInstanceOf(Headers);
  expect([...(headers as Headers).values()]).not.toContain(token);
  const streamed = await wrapped.doStream(callOptions);
  const reader = streamed.stream.getReader();
  const part = await reader.read();
  const delta = (part.value as { delta: string }).delta;
  expect(delta).not.toContain(token);
  await reader.cancel();
});

test("whole-value replacements cannot reconstruct a selected secret", async () => {
  const token = "A[redacted]B";
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://plan.invalid/model"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
      model({
        doGenerate: async () => ({
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
          request: { metadata: { ordinary: `A${token}B` } },
          response: { headers: new Headers({ ordinary: `A${token}B` }) },
        }),
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "text-delta",
                id: "ordinary",
                delta: "keep",
              });
              controller.enqueue({
                type: "text-delta",
                id: "delta",
                delta: `A${token}B`,
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
  const generated = await wrapped.doGenerate(callOptions);
  expect(JSON.stringify(generated.request)).not.toContain(token);
  const responseHeaders = generated.response?.headers as Headers;
  expect([...responseHeaders.values()].join()).not.toContain(token);
  const streamed = await wrapped.doStream(callOptions);
  const reader = streamed.stream.getReader();
  const part = await reader.read();
  expect((part.value as { delta: string }).delta).not.toContain(token);
  await reader.cancel();
});

test("bracket secrets preserve ordinary metadata and redact secret-bearing values", async () => {
  const token = "[";
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://plan.invalid/model"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
      model({
        doGenerate: async () => ({
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
          request: { metadata: { ordinary: "keep", sensitive: "has [secret" } },
        }),
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "text-delta",
                id: "ordinary-bracket",
                delta: "keep",
              });
              controller.enqueue({
                type: "text-delta",
                id: "delta",
                delta: "keep [secret",
              });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage,
              });
              controller.close();
            },
          }),
          request: { metadata: { ordinary: "keep", sensitive: "has [secret" } },
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const generated = await wrapped.doGenerate(callOptions);
  const metadata = generated.request?.metadata as Record<string, string>;
  expect(metadata.ordinary).toBe("keep");
  expect(metadata.sensitive).not.toContain(token);
  const streamed = await wrapped.doStream(callOptions);
  const streamedMetadata = streamed.request?.metadata as Record<string, string>;
  expect(streamedMetadata.ordinary).toBe("keep");
  expect(streamedMetadata.sensitive).not.toContain(token);
  const reader = streamed.stream.getReader();
  const deltas: string[] = [];
  let part = await reader.read();
  while (!part.done) {
    if (part.value.type === "text-delta") deltas.push(part.value.delta);
    part = await reader.read();
  }
  expect(deltas.join("")).toContain("keepkeep ");
  expect(deltas.join("")).not.toContain(token);
});

test("constrained secret namespace allocates distinct names for multiple secret keys", async () => {
  const token = "ob-r-0";
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://plan.invalid/model"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
      model({
        doGenerate: async () => ({
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
          request: { metadata: { [`${token}a`]: "one", [`${token}b`]: "two" } },
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const metadata = (await wrapped.doGenerate(callOptions)).request
    ?.metadata as Record<string, string>;
  expect(Object.keys(metadata)).toHaveLength(2);
  expect(new Set(Object.keys(metadata)).size).toBe(2);
  expect(Object.values(metadata).sort()).toEqual(["one", "two"]);
  expect(JSON.stringify(metadata)).not.toContain(token);
});

test("unsafe stream metadata key cancels acquired reader and marks invocation unknown once", async () => {
  const token = "ob-r-";
  let cancelled = false;
  const { deps, calls } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://plan.invalid/model"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
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
            cancel() {
              cancelled = true;
            },
          }),
          request: { metadata: { [`${token}private`]: "safe" } },
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  await expect(wrapped.doStream(callOptions)).rejects.toThrow(
    "MODEL_INVOCATION_FAILED",
  );
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(cancelled).toBe(true);
});

test("native API key is redacted from streaming metadata values and property names", async () => {
  const apiKey = "native-private-key";
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: { provider: "openai", defaultModel: "selected-model" },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => apiKey,
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
          request: { metadata: { [apiKey]: `value ${apiKey}` } },
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const result = await wrapped.doStream(callOptions);
  const metadata = JSON.stringify(result.request);
  expect(metadata).not.toContain(apiKey);
  await result.stream.getReader().cancel();
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

test("adjacent public text deltas cannot reconstruct the selected plan token", async () => {
  const token = "Xob-v-";
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://plan.invalid/model"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "text-delta",
                id: "text",
                delta: "X",
              });
              controller.enqueue({
                type: "text-delta",
                id: "text",
                delta: "Xob-v-",
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
  const { stream } = await wrapped.doStream(callOptions);
  const reader = stream.getReader();
  const deltas: string[] = [];
  let result = await reader.read();
  while (!result.done) {
    if (result.value.type === "text-delta") deltas.push(result.value.delta);
    result = await reader.read();
  }
  expect(deltas.join("")).not.toContain(token);
});

test("a selected plan token split across source deltas is removed from assembled output", async () => {
  const token = "Xob-v-";
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://plan.invalid/model"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "text-delta",
                id: "text",
                delta: "Xob",
              });
              controller.enqueue({
                type: "text-delta",
                id: "text",
                delta: "-v-",
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
  const { stream } = await wrapped.doStream(callOptions);
  const reader = stream.getReader();
  const deltas: string[] = [];
  let result = await reader.read();
  while (!result.done) {
    if (result.value.type === "text-delta") deltas.push(result.value.delta);
    result = await reader.read();
  }
  expect(deltas.join("")).not.toContain(token);
});

test("pending text flushes immediately before finish", async () => {
  const token = "selected-secret-token";
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://plan.invalid/model"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "text-delta",
                id: "text",
                delta: "hello",
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
  const { stream } = await wrapped.doStream(callOptions);
  const reader = stream.getReader();
  const types: string[] = [];
  let result = await reader.read();
  while (!result.done) {
    types.push(result.value.type);
    result = await reader.read();
  }
  expect(types).toEqual(["text-delta", "finish"]);
});

test("text flushes before text-end and interleaved source parts", async () => {
  const token = "selected-secret-token";
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://plan.invalid/model"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "text" });
              controller.enqueue({
                type: "text-delta",
                id: "text",
                delta: "hello",
              });
              controller.enqueue({ type: "text-end", id: "text" });
              controller.enqueue({
                type: "tool-input-start",
                id: "tool",
                toolName: "search",
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
  const { stream } = await wrapped.doStream(callOptions);
  const reader = stream.getReader();
  const types: string[] = [];
  let result = await reader.read();
  while (!result.done) {
    types.push(result.value.type);
    result = await reader.read();
  }
  expect(types).toEqual([
    "text-start",
    "text-delta",
    "text-end",
    "tool-input-start",
    "finish",
  ]);
});

test("secret-bearing text IDs stay stable across lifecycle events and flushes", async () => {
  const token = "selected-secret-token";
  const rawId = `text-${token}`;
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://plan.invalid/model"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-start", id: rawId });
              controller.enqueue({
                type: "text-delta",
                id: rawId,
                delta: "hello",
              });
              controller.enqueue({
                type: "tool-input-start",
                id: "tool-1",
                toolName: "search",
              });
              controller.enqueue({
                type: "text-delta",
                id: rawId,
                delta: " world",
              });
              controller.enqueue({ type: "text-end", id: rawId });
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
  const { stream } = await wrapped.doStream(callOptions);
  const reader = stream.getReader();
  const parts: Record<string, unknown>[] = [];
  let result = await reader.read();
  while (!result.done) {
    parts.push(result.value as Record<string, unknown>);
    result = await reader.read();
  }

  const textParts = parts.filter((part) =>
    ["text-start", "text-delta", "text-end"].includes(String(part.type)),
  );
  const ids = textParts.map((part) => part.id);
  expect(textParts.map((part) => part.type)).toEqual([
    "text-start",
    "text-delta",
    "text-delta",
    "text-end",
  ]);
  expect(new Set(ids).size).toBe(1);
  expect(JSON.stringify(textParts)).not.toContain(token);
});

test("adjacent safe replacements are checked as one output string", async () => {
  const token = "0ob-v-";
  const source = `${token}aaaaaa${token}`;
  const { deps } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://plan.invalid/model"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "text-delta",
                id: "text",
                delta: source,
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
  const { stream } = await wrapped.doStream(callOptions);
  const reader = stream.getReader();
  const deltas: string[] = [];
  let result = await reader.read();
  while (!result.done) {
    if (result.value.type === "text-delta") deltas.push(result.value.delta);
    result = await reader.read();
  }
  expect(deltas.join("")).not.toContain(token);
  expect(deltas.join("")).toContain("aaaaaa");
});

test("a later delta completing a secret across a forced flush fails closed", async () => {
  const token = "Xob-v-";
  let cancelled = false;
  const { deps, calls } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://plan.invalid/model"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "text-delta",
                id: "text",
                delta: "X",
              });
              controller.enqueue({ type: "text-end", id: "text" });
              controller.enqueue({
                type: "text-delta",
                id: "text",
                delta: token,
              });
            },
            cancel() {
              cancelled = true;
            },
          }),
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const { stream } = await wrapped.doStream(callOptions);
  const reader = stream.getReader();
  const seen: string[] = [];
  await expect(
    (async () => {
      let result = await reader.read();
      while (!result.done) {
        if (result.value.type === "text-delta") seen.push(result.value.delta);
        result = await reader.read();
      }
    })(),
  ).rejects.toThrow("MODEL_INVOCATION_FAILED");
  expect(seen.join("")).not.toContain(token);
  expect(cancelled).toBe(true);
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
});

test("finish redaction preserves context around a replacement-like Plan token", async () => {
  const token = "ob-v-";
  let cancelled = false;
  const { deps, calls } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://plan.invalid/model"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "text-delta",
                id: "text",
                delta: `before ${token} after`,
              });
              controller.enqueue({
                type: "finish",
                finishReason: {
                  unified: "stop",
                  raw: `before ${token} after`,
                },
                usage,
              });
              controller.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const { stream } = await wrapped.doStream(callOptions);
  const reader = stream.getReader();
  const parts = [];
  let result = await reader.read();
  while (!result.done) {
    parts.push(result.value);
    result = await reader.read();
  }
  const finish = parts.find((part) => part.type === "finish");
  expect(finish?.type).toBe("finish");
  if (finish?.type !== "finish") throw new Error("expected finish part");
  expect(finish.finishReason.raw).toContain("before ");
  expect(finish.finishReason.raw).toContain(" after");
  expect(JSON.stringify(finish)).not.toContain(token);
  expect(cancelled).toBe(false);
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(0);
  expect(calls.filter((call) => call.startsWith("confirm:"))).toHaveLength(1);
});

test("text part redaction preserves context around a replacement-like Plan token", async () => {
  const token = "ob-v-";
  let cancelled = false;
  const { deps, calls } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://plan.invalid/model"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "text-delta",
                id: "text",
                delta: `before ${token} after`,
              });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage,
              });
              controller.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const { stream } = await wrapped.doStream(callOptions);
  const reader = stream.getReader();
  const deltas: string[] = [];
  let result = await reader.read();
  while (!result.done) {
    if (result.value.type === "text-delta") deltas.push(result.value.delta);
    result = await reader.read();
  }
  const text = deltas.join("");
  expect(text).toContain("before ");
  expect(text).toContain(" after");
  expect(text).not.toContain(token);
  expect(cancelled).toBe(false);
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(0);
  expect(calls.filter((call) => call.startsWith("confirm:"))).toHaveLength(1);
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

test("generate with an absent usage object settles unknown without throwing", async () => {
  const { deps, calls } = dependencies({
    createModel: async () =>
      model({
        doGenerate: async () =>
          ({
            content: [{ type: "text", text: "answer" }],
            finishReason: { unified: "stop", raw: undefined },
            warnings: [],
          }) as never,
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  let thrown: unknown;
  try {
    await wrapped.doGenerate(callOptions);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeUndefined();
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
});

test("stream finish with an absent usage object settles unknown and delivers finish", async () => {
  const { deps, calls } = dependencies({
    createModel: async () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
              } as never);
              controller.close();
            },
          }),
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const { stream } = await wrapped.doStream(callOptions);
  const reader = stream.getReader();

  const finish = await reader.read();
  expect(finish.value?.type).toBe("finish");
  expect(await reader.read()).toEqual({ value: undefined, done: true });
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
});

test("generate with null usage settles unknown without throwing", async () => {
  const { deps, calls } = dependencies({
    createModel: async () =>
      model({
        doGenerate: async () =>
          ({
            content: [{ type: "text", text: "answer" }],
            finishReason: { unified: "stop", raw: undefined },
            usage: null,
            warnings: [],
          }) as never,
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  let thrown: unknown;
  try {
    await wrapped.doGenerate(callOptions);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeUndefined();
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
});

test("stream finish with null usage settles unknown and delivers finish", async () => {
  const { deps, calls } = dependencies({
    createModel: async () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: null,
              } as never);
              controller.close();
            },
          }),
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const { stream } = await wrapped.doStream(callOptions);
  const reader = stream.getReader();

  const finish = await reader.read();
  expect(finish.value?.type).toBe("finish");
  expect(await reader.read()).toEqual({ value: undefined, done: true });
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
});

test("generated text redaction preserves context around a replacement-like Plan token", async () => {
  const token = "ob-v-";
  const { deps, calls } = dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://plan.invalid/model"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () =>
      model({
        doGenerate: async () => ({
          content: [{ type: "text", text: `answer ${token} leaked` }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  const result = await wrapped.doGenerate(callOptions);
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  expect(text).toContain("answer ");
  expect(text).toContain(" leaked");
  expect(text).not.toContain(token);
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(0);
  expect(calls.filter((call) => call.startsWith("confirm:"))).toHaveLength(1);
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

class ThrowingInputTokensUsage {
  get inputTokens(): never {
    throw new Error("private usage getter failure");
  }
}

test("generate with a throwing usage getter settles unknown without exposing the exception", async () => {
  const { deps, calls } = dependencies({
    createModel: async () =>
      model({
        doGenerate: async () =>
          ({
            content: [{ type: "text", text: "answer" }],
            finishReason: { unified: "stop", raw: undefined },
            usage: new ThrowingInputTokensUsage(),
            warnings: [],
          }) as never,
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  let thrown: unknown;
  try {
    await wrapped.doGenerate(callOptions);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeUndefined();
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
});

test("stream finish with a throwing usage getter settles unknown and delivers finish", async () => {
  const { deps, calls } = dependencies({
    createModel: async () =>
      model({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: new ThrowingInputTokensUsage(),
              } as never);
              controller.close();
            },
          }),
        }),
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const { stream } = await wrapped.doStream(callOptions);
  const reader = stream.getReader();

  const finish = await reader.read();
  expect(finish.value?.type).toBe("finish");
  expect(await reader.read()).toEqual({ value: undefined, done: true });
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
});

test("generate with a throwing root usage getter safely settles unknown", async () => {
  const { deps, calls } = dependencies({
    createModel: async () =>
      model({
        doGenerate: async () => {
          const result = {
            content: [{ type: "text", text: "answer" }],
            finishReason: { unified: "stop", raw: undefined },
            warnings: [],
          };
          Object.defineProperty(result, "usage", {
            get() {
              throw new Error("private root usage getter failure");
            },
          });
          return result as never;
        },
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  await expect(wrapped.doGenerate(callOptions)).resolves.toBeDefined();
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
});

class OpaqueProviderMetadata {
  credential = "private-key";
}

test("generate sanitizes opaque provider metadata before exposing the result", async () => {
  const { deps, calls } = dependencies({
    createModel: async () =>
      model({
        doGenerate: async () =>
          ({
            content: [{ type: "text", text: "answer" }],
            finishReason: { unified: "stop", raw: undefined },
            usage,
            warnings: [],
            providerMetadata: { synthetic: new OpaqueProviderMetadata() },
          }) as never,
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  const result = await wrapped.doGenerate(callOptions);
  expect(JSON.stringify(result)).not.toContain("private-key");
  expect(result.providerMetadata?.synthetic).not.toBeInstanceOf(
    OpaqueProviderMetadata,
  );
  expect(calls.filter((call) => call.startsWith("confirm:"))).toHaveLength(1);
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(0);
});

test("stream getReader acquisition failure fails generically and settles unknown", async () => {
  const { deps, calls } = dependencies({
    createModel: async () =>
      model({
        doStream: async () =>
          ({
            stream: {
              get getReader(): never {
                throw new Error("private reader acquisition failure");
              },
            },
          }) as never,
      }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  await expect(wrapped.doStream(callOptions)).rejects.toThrow(
    "MODEL_INVOCATION_FAILED",
  );
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
});

function planDependencies(
  token: string,
  overrides: Partial<LanguageModelV3> = {},
) {
  return dependencies({
    adapter: {
      selectModel: async () => ({
        model: {
          provider: "plan",
          defaultModel: "selected-plan",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("https://endpoint.invalid/plan"),
            token,
          },
        },
        credentialSecretRef: "selected-secret",
      }),
      runtimeModel: (route) => route.model,
      resolveApiKey: async () => "unused-key",
    } as never,
    createPlanModel: () => model(overrides),
  });
}

for (const [token, partType] of [
  ["-", "text-delta"],
  ["finish", "finish"],
] as const) {
  test(`stream discriminator containing Plan credential ${JSON.stringify(token)} fails closed`, async () => {
    let providerCancelled = false;
    const { deps, calls } = planDependencies(token, {
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue(
              partType === "finish"
                ? {
                    type: "finish",
                    finishReason: { unified: "stop", raw: undefined },
                    usage,
                  }
                : { type: "text-delta", id: "text", delta: "safe" },
            );
          },
          cancel() {
            providerCancelled = true;
          },
        }),
      }),
    });
    const wrapped = await createGovernedMastraModel(deps, context);
    const { stream } = await wrapped.doStream(callOptions);
    const reader = stream.getReader();
    const returnedParts: unknown[] = [];
    let thrown: unknown;
    try {
      const next = await reader.read();
      if (!next.done) returnedParts.push(next.value);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ message: "MODEL_INVOCATION_FAILED" });
    expect(returnedParts).toHaveLength(0);
    expect(providerCancelled).toBe(true);
    expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
  });
}

for (const [name, part, rejectCancel] of [
  [
    "object containing the selected credential",
    { type: { label: "plan-secret-token" } },
    false,
  ],
  ["null type", { type: null }, false],
  ["missing type", {}, false],
  ["numeric type", { type: 7 }, false],
  [
    "inherited type",
    Object.assign(Object.create({ type: "text-delta" }), { delta: "x" }),
    false,
  ],
  ["credential-bearing primitive type", { type: "plan-secret-token" }, true],
] as const) {
  test(`malformed provider stream ${name} fails closed`, async () => {
    let providerCancelled = false;
    const { deps, calls } = planDependencies("plan-secret-token", {
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue(part as never);
          },
          cancel() {
            providerCancelled = true;
            if (rejectCancel) throw new Error("private cancel failure");
          },
        }),
      }),
    });
    const wrapped = await createGovernedMastraModel(deps, context);
    const { stream } = await wrapped.doStream(callOptions);
    const reader = stream.getReader();
    const returnedParts: unknown[] = [];
    let thrown: unknown;
    try {
      const next = await reader.read();
      if (!next.done) returnedParts.push(next.value);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ message: "MODEL_INVOCATION_FAILED" });
    expect(returnedParts).toHaveLength(0);
    expect(providerCancelled).toBe(true);
    expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
  });
}

test("malformed provider stream discriminator accessors are rejected without invocation", async () => {
  let getterCalls = 0;
  let providerCancelled = false;
  const accessorPart = {
    get type() {
      getterCalls += 1;
      return getterCalls === 1 ? "finish" : "plan-secret-token";
    },
    finishReason: { unified: "stop", raw: undefined },
    usage,
  };
  const { deps, calls } = planDependencies("plan-secret-token", {
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(accessorPart as never);
        },
        cancel() {
          providerCancelled = true;
        },
      }),
    }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const { stream } = await wrapped.doStream(callOptions);
  let thrown: unknown;
  try {
    await stream.getReader().read();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({ message: "MODEL_INVOCATION_FAILED" });
  expect(getterCalls).toBe(0);
  expect(providerCancelled).toBe(true);
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
});

test("buffered text before malformed provider stream discriminator is discarded", async () => {
  let providerCancelled = false;
  const { deps, calls } = planDependencies("plan-secret-token", {
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-delta", id: "text", delta: "x" });
          controller.enqueue({
            type: { label: "plan-secret-token" },
          } as never);
        },
        cancel() {
          providerCancelled = true;
        },
      }),
    }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const { stream } = await wrapped.doStream(callOptions);
  const returnedParts: unknown[] = [];
  let thrown: unknown;
  try {
    const next = await stream.getReader().read();
    if (!next.done) returnedParts.push(next.value);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({ message: "MODEL_INVOCATION_FAILED" });
  expect(returnedParts).toHaveLength(0);
  expect(providerCancelled).toBe(true);
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
});

test("generated text masks only exact credential intervals and preserves context", async () => {
  const token = "plan-secret-token";
  const { deps } = planDependencies(token, {
    doGenerate: async () => ({
      content: [{ type: "text", text: `before ${token} after ${token} again` }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  const result = await wrapped.doGenerate(callOptions);
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  expect(text).toContain("before ");
  expect(text).toContain(" after ");
  expect(text).toContain(" again");
  expect(text).not.toContain(token);
});

test("header text redaction preserves context around a one-character credential", async () => {
  const token = "u";
  const { deps } = planDependencies(token, {
    doGenerate: async () => ({
      content: [{ type: "text", text: "answer" }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
      response: { headers: new Headers({ "x-safe": `before ${token} after` }) },
    }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  const result = await wrapped.doGenerate(callOptions);
  const headers = result.response?.headers;
  expect(headers).toBeInstanceOf(Headers);
  const value = (headers as Headers).get("x-safe");
  expect(value).toContain("before ");
  expect(value).toContain(" after");
  expect(value).not.toContain(token);
  expect(() => new Headers({ "x-safe": value as string })).not.toThrow();
});

test("header text redaction fails closed when no ByteString sentinel is available", async () => {
  const token = Array.from({ length: 0x7e - 0x21 + 1 }, (_, index) =>
    String.fromCharCode(0x21 + index),
  ).join("");
  const { deps, calls } = planDependencies(token, {
    doGenerate: async () => ({
      content: [{ type: "text", text: "answer" }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
      response: { headers: new Headers({ "x-safe": `before ${token} after` }) },
    }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  await expect(wrapped.doGenerate(callOptions)).rejects.toThrow(
    "MODEL_INVOCATION_FAILED",
  );
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
});

test("overlapping and adjacent credential matches mask their union only", async () => {
  const token = "aba";
  const { deps } = planDependencies(token, {
    doGenerate: async () => ({
      content: [{ type: "text", text: `left ababa${token} right` }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  const result = await wrapped.doGenerate(callOptions);
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  expect(text.startsWith("left ")).toBe(true);
  expect(text.endsWith(" right")).toBe(true);
  expect(text).not.toContain(token);
});

test("marker-shaped source text and redacted credential preserve safe context", async () => {
  const token = "redacted";
  const { deps } = planDependencies(token, {
    doGenerate: async () => ({
      content: [{ type: "text", text: `A[${token}]B` }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  const result = await wrapped.doGenerate(callOptions);
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  expect(text.startsWith("A[")).toBe(true);
  expect(text.endsWith("]B")).toBe(true);
  expect(text).not.toContain(token);
});

test("Plan endpoint survives generated output while its token is masked", async () => {
  const token = "plan-secret-token";
  const endpoint = "https://endpoint.invalid/plan";
  const { deps } = planDependencies(token, {
    doGenerate: async () => ({
      content: [
        { type: "text", text: `route ${endpoint}; token ${token}; done` },
      ],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  const result = await wrapped.doGenerate(callOptions);
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  expect(text).toContain(endpoint);
  expect(text).toContain("route ");
  expect(text).toContain("; done");
  expect(text).not.toContain(token);
});

test("stream chunk-split credential keeps safe prefix and suffix intact", async () => {
  const token = "abcdef";
  const { deps } = planDependencies(token, {
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({
            type: "text-delta",
            id: "text",
            delta: `safe-prefix ${token.slice(0, 3)}`,
          });
          controller.enqueue({
            type: "text-delta",
            id: "text",
            delta: `${token.slice(3)} safe-suffix`,
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
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  const { stream } = await wrapped.doStream(callOptions);
  const reader = stream.getReader();
  const deltas: string[] = [];
  let result = await reader.read();
  while (!result.done) {
    if (result.value.type === "text-delta") deltas.push(result.value.delta);
    result = await reader.read();
  }
  const text = deltas.join("");
  expect(text).toContain("safe-prefix ");
  expect(text).toContain(" safe-suffix");
  expect(text).not.toContain(token);
});

test("generated ob-v marker credential preserves surrounding prose", async () => {
  const token = "ob-v-";
  const { deps } = planDependencies(token, {
    doGenerate: async () => ({
      content: [{ type: "text", text: `before ${token} after` }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  const result = await wrapped.doGenerate(callOptions);
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  expect(text).toContain("before ");
  expect(text).toContain(" after");
  expect(text).not.toContain(token);
});

test("streamed ob-v marker credential preserves surrounding prose", async () => {
  const token = "ob-v-";
  const { deps } = planDependencies(token, {
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({
            type: "text-delta",
            id: "text",
            delta: `before ${token} after`,
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
  });
  const wrapped = await createGovernedMastraModel(deps, context);

  const { stream } = await wrapped.doStream(callOptions);
  const reader = stream.getReader();
  const deltas: string[] = [];
  let result = await reader.read();
  while (!result.done) {
    if (result.value.type === "text-delta") deltas.push(result.value.delta);
    result = await reader.read();
  }
  const text = deltas.join("");
  expect(text).toContain("before ");
  expect(text).toContain(" after");
  expect(text).not.toContain(token);
});

for (const token of ["-", "4"]) {
  test(`generated text preserves context around the one-character ${token} credential`, async () => {
    const { deps } = planDependencies(token, {
      doGenerate: async () => ({
        content: [{ type: "text", text: `before ${token} after` }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      }),
    });
    const wrapped = await createGovernedMastraModel(deps, context);
    const result = await wrapped.doGenerate(callOptions);
    const text = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(text).toContain("before ");
    expect(text).toContain(" after");
    expect(text).not.toContain(token);
  });

  if (token !== "-")
    test(`split stream deltas preserve context around the one-character ${token} credential`, async () => {
      const { deps } = planDependencies(token, {
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "text-delta",
                id: "text",
                delta: `before ${token.slice(0, 1)}`,
              });
              controller.enqueue({
                type: "text-delta",
                id: "text",
                delta: `${token.slice(1)} after`,
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
      });
      const wrapped = await createGovernedMastraModel(deps, context);
      const { stream } = await wrapped.doStream(callOptions);
      const reader = stream.getReader();
      const deltas: string[] = [];
      let result = await reader.read();
      while (!result.done) {
        if (result.value.type === "text-delta") deltas.push(result.value.delta);
        result = await reader.read();
      }
      const text = deltas.join("");
      expect(text).toContain("before ");
      expect(text).toContain(" after");
      expect(text).not.toContain(token);
    });
}

test("exhausting the bounded text sentinel pool fails closed", async () => {
  const sentinelPool =
    Array.from({ length: 0x20 }, (_, index) =>
      String.fromCodePoint(0x2580 + index),
    ).join("") +
    Array.from({ length: 0xf900 - 0xe000 }, (_, index) =>
      String.fromCodePoint(0xe000 + index),
    ).join("");
  const { deps, calls } = planDependencies(sentinelPool, {
    doGenerate: async () => ({
      content: [{ type: "text", text: `before ${sentinelPool} after` }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  await expect(wrapped.doGenerate(callOptions)).rejects.toThrow(
    "MODEL_INVOCATION_FAILED",
  );
  expect(calls.filter((call) => call.startsWith("unknown:"))).toHaveLength(1);
  expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
});

test("single-character credential streams do not retain emitted text tails", async () => {
  const token = "!";
  const { deps } = planDependencies(token, {
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (let index = 0; index < 128; index += 1)
            controller.enqueue({
              type: "text-delta",
              id: "text",
              delta: "x".repeat(64),
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
  });
  const wrapped = await createGovernedMastraModel(deps, context);
  const { stream } = await wrapped.doStream(callOptions);
  const reader = stream.getReader();
  const deltas: string[] = [];
  let result = await reader.read();
  while (!result.done) {
    if (result.value.type === "text-delta") deltas.push(result.value.delta);
    result = await reader.read();
  }
  expect(deltas.join("")).toBe("x".repeat(128 * 64));
});
