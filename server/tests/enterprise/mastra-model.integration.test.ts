import { expect, test } from "../../../tests/support/bun-test-compat";
import { generateText, type LanguageModel, streamText } from "ai";
import type { PlatformScope, RunService } from "../../src/enterprise/contracts";
import { createRuntimeModelAdapter } from "../../src/enterprise/models/runtime-adapter";
import { createGovernedMastraModel } from "../../src/mastra/model";

type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: "v3" }>;

const scope: PlatformScope = {
  tenantId: "synthetic-tenant",
  workspaceId: "synthetic-workspace",
  principalId: "synthetic-principal",
  actorId: "synthetic-actor",
  memberEpoch: 1,
  aclEpoch: 1,
  entrypoint: "web",
};
const callUsage = {
  inputTokens: {
    total: 2,
    noCache: 2,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
let sequence = 0;
function syntheticModel(): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "loopback-synthetic",
    modelId: "test-only",
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: "text", text: "synthetic answer" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: callUsage,
        warnings: [],
      };
    },
    async doStream() {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "answer" });
            controller.enqueue({
              type: "text-delta",
              id: "answer",
              delta: "synthetic stream",
            });
            controller.enqueue({ type: "text-end", id: "answer" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: callUsage,
            });
            controller.close();
          },
        }),
      };
    },
  };
}

function governedModel() {
  const capabilities = new Map<string, number>();
  const runs = {
    async issueModelInvocationCapability(
      _scope: PlatformScope,
      input: { modelRequestId: string; maximumTokens: number },
    ) {
      const capability = `synthetic-cap-${++sequence}`;
      capabilities.set(capability, input.maximumTokens);
      return {
        capability,
        model_request_id: input.modelRequestId,
        maximum_tokens: input.maximumTokens,
        expires_at: "2030-01-01T00:00:00Z",
      };
    },
    async resolveModelInvocationCapability(
      _scope: PlatformScope,
      capability: string,
    ) {
      return {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        principalId: scope.principalId,
        runId: "synthetic-run",
        attemptId: "synthetic-attempt",
        generation: 1,
        modelRouteRef: "locked-route",
        modelRequestId: capability,
        maximumTokens: capabilities.get(capability)!,
        expiresAt: "2030-01-01T00:00:00Z",
      };
    },
    async confirmModelInvocationUsage(
      _scope: PlatformScope,
      capability: string,
      usedTokens: number,
    ) {
      expect(capabilities.has(capability)).toBe(true);
      expect(usedTokens).toBe(3);
      capabilities.delete(capability);
    },
    async markModelInvocationUnknown(
      _scope: PlatformScope,
      capability: string,
    ) {
      capabilities.delete(capability);
    },
    async releaseModelInvocation(_scope: PlatformScope, capability: string) {
      capabilities.delete(capability);
    },
  } as unknown as RunService;
  return createGovernedMastraModel(
    {
      runs,
      estimateInputTokenUpperBound: async () => 1,
      getAttemptGeneration: async () => 1,
      adapter: {
        selectModel: async () => ({
          model: { provider: "openai", defaultModel: "synthetic" },
          credentialSecretRef: "secret",
        }),
        runtimeModel: (route) => route.model,
        resolveApiKey: async () => "synthetic-key",
      } as never,
      createModel: async () => syntheticModel(),
      environment: {},
    },
    {
      scope,
      runId: "synthetic-run",
      attemptId: "synthetic-attempt",
      modelRouteRef: "locked-route",
      signal: new AbortController().signal,
    },
  );
}

test("AI SDK generateText and streamText use the governed native v3 model protocol", async () => {
  const model = await governedModel();
  const generated = await generateText({
    model,
    prompt: "hello",
    maxOutputTokens: 8,
  });
  expect(generated.text).toBe("synthetic answer");

  const streamed = streamText({ model, prompt: "hello", maxOutputTokens: 8 });
  expect(await streamed.text).toBe("synthetic stream");
});

test("native OpenAI and Anthropic factories honor persisted route identity and local endpoints", async () => {
  const observed: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      observed.push({ url: request.url, body });
      if (new URL(request.url).pathname.endsWith("/messages")) {
        return Response.json({
          id: "msg_synthetic",
          type: "message",
          role: "assistant",
          model: "claude-locked",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      return Response.json({
        id: "chat_synthetic",
        object: "chat.completion",
        created: 1,
        model: "gpt-locked",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  try {
    const adapter = createRuntimeModelAdapter({
      encryptionKey: "synthetic-only",
      reader: {} as never,
      selectModel: async () => null,
    });
    const endpoint = `http://127.0.0.1:${server.port}`;
    const persistedPlanRoute = {
      model: {
        provider: "openai" as const,
        defaultModel: "gpt-plan-locked",
        plan: {
          provider: "chatgpt" as const,
          endpoint: new URL("https://plan.invalid/model"),
          token: "synthetic-plan-token",
        },
      },
      credentialSecretRef: "synthetic-plan-ref",
    };
    expect(
      adapter.runtimeModel(persistedPlanRoute, {
        BOT_PROVIDER: "anthropic",
        BOT_MODEL: "ambient-model",
      }),
    ).toEqual(persistedPlanRoute.model);
    const options = {
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      maxOutputTokens: 8,
    } as never;
    for (const provider of ["openai", "anthropic"] as const) {
      const route = {
        model: {
          provider,
          defaultModel: provider === "openai" ? "gpt-locked" : "claude-locked",
        },
        credentialSecretRef: "synthetic-ref",
      };
      const model = adapter.createNativeModel(route, "synthetic-key", {
        BOT_PROVIDER: provider === "openai" ? "anthropic" : "openai",
        BOT_MODEL: "ambient-model",
        ...(provider === "openai"
          ? { OPENAI_BASE_URL: endpoint }
          : { ANTHROPIC_BASE_URL: endpoint }),
      });
      const result = await model.doGenerate(options);
      expect(result.content).toContainEqual({ type: "text", text: "ok" });
      expect(new URL(observed.at(-1)!.url).pathname).toBe(
        provider === "anthropic" ? "/v1/messages" : "/chat/completions",
      );
    }
    expect(observed).toHaveLength(2);
    expect(observed[0]?.body.model).toBe("gpt-locked");
    expect(observed[1]?.body.model).toBe("claude-locked");
    expect(observed[0]?.url).toContain("127.0.0.1");
    expect(observed[1]?.url).toContain("127.0.0.1");

    const versionedAnthropicModel = adapter.createNativeModel(
      {
        model: { provider: "anthropic", defaultModel: "claude-locked" },
        credentialSecretRef: "synthetic-ref",
      },
      "synthetic-key",
      { ANTHROPIC_BASE_URL: `${endpoint}/v1/` },
    );
    await versionedAnthropicModel.doGenerate(options);
    expect(new URL(observed.at(-1)!.url).pathname).toBe("/v1/messages");
  } finally {
    server.stop(true);
  }
});

test("native model rejects unsupported providers before making a request", () => {
  let requestCount = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requestCount += 1;
      return new Response(null, { status: 500 });
    },
  });
  try {
    const adapter = createRuntimeModelAdapter({
      encryptionKey: "synthetic-only",
      reader: {} as never,
      selectModel: async () => null,
    });
    const unsupportedRoute = {
      model: { provider: "unsupported", defaultModel: "test-only" },
      credentialSecretRef: "synthetic-ref",
    } as never;

    expect(() =>
      adapter.createNativeModel(unsupportedRoute, "synthetic-key", {
        OPENAI_BASE_URL: `http://127.0.0.1:${server.port}`,
      }),
    ).toThrow("UNSUPPORTED_MODEL_PROVIDER");
    expect(requestCount).toBe(0);
  } finally {
    server.stop(true);
  }
});
