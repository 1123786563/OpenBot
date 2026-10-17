import { describe, expect, test } from "../../../tests/support/e2e-compat";
import { streamText, tool } from "ai";
import { z } from "zod";
import { createAiSdkV3GatewayAdapter } from "../../src/enterprise/models/ai-sdk-v3-gateway-adapter";
import { createModelGateway } from "../../src/enterprise/models/gateway";

const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const completion = (
  usage = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
) => ({
  id: "cmpl-1",
  object: "chat.completion",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "hello" },
      finish_reason: "stop",
    },
  ],
  usage,
});
const options = {
  prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  maxOutputTokens: 20,
} as const;

const capability = "A".repeat(43);

describe("AI SDK v3 ModelGateway adapter", () => {
  test("maps generate request, bearer capability, and gateway authoritative usage", async () => {
    let request!: Request;
    let requestedCap: number | undefined;
    const model = createAiSdkV3GatewayAdapter({
      routeRef: "route-a",
      runTokenCeiling: 30,
      issueCapability: async (maximumTokens) => {
        requestedCap = maximumTokens;
        return capability;
      },
      gateway: {
        handle: async (r) => {
          request = r;
          return response(completion());
        },
      },
    });
    const result = await model.doGenerate(options as never);
    expect(request.headers.get("authorization")).toBe(`Bearer ${capability}`);
    expect(requestedCap).toBe(30);
    expect(await request.json()).toEqual({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      max_tokens: 20,
    });
    expect(result.usage.inputTokens.total).toBe(4);
    expect(result.usage.outputTokens.total).toBe(2);
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("clamps the per-call output field and refuses invalid request ceilings", async () => {
    let issued = 0;
    const payloads: unknown[] = [];
    const model = createAiSdkV3GatewayAdapter({
      routeRef: "r",
      runTokenCeiling: 20,
      issueCapability: async () => {
        issued++;
        return capability;
      },
      gateway: {
        handle: async (request) => {
          payloads.push(await request.json());
          return response(completion());
        },
      },
    });
    await model.doGenerate({ ...options, maxOutputTokens: 21 } as never);
    expect(payloads).toEqual([
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
        max_tokens: 20,
      },
    ]);
    await expect(
      model.doGenerate({ ...options, maxOutputTokens: 0 } as never),
    ).rejects.toThrow();
    await expect(
      model.doGenerate({ ...options, maxOutputTokens: -5 } as never),
    ).rejects.toThrow();
    await expect(
      model.doGenerate({
        ...options,
        maxOutputTokens: undefined,
      } as never),
    ).rejects.toThrow();
    expect(issued).toBe(1);
  });

  test("mints a distinct capability for each invocation", async () => {
    const seen: string[] = [];
    const issued: number[] = [];
    let n = 0;
    const model = createAiSdkV3GatewayAdapter({
      routeRef: "r",
      runTokenCeiling: 20,
      issueCapability: async (maximumTokens) => {
        issued.push(maximumTokens);
        return Buffer.alloc(32, ++n).toString("base64url");
      },
      gateway: {
        handle: async (r) => {
          seen.push(r.headers.get("authorization")!);
          return response(completion());
        },
      },
    });
    await model.doGenerate(options as never);
    await model.doGenerate(options as never);
    expect(issued).toEqual([20, 14]);
    expect(seen).toEqual([
      `Bearer ${Buffer.alloc(32, 1).toString("base64url")}`,
      `Bearer ${Buffer.alloc(32, 2).toString("base64url")}`,
    ]);
  });

  test("rejects unsupported prompt semantics", async () => {
    const model = createAiSdkV3GatewayAdapter({
      routeRef: "r",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway: { handle: async () => response(completion()) },
    });
    await expect(
      model.doGenerate({ ...options, temperature: 0.5 } as never),
    ).rejects.toThrow();
    await expect(
      model.doGenerate({
        ...options,
        prompt: [
          {
            role: "assistant",
            content: [{ type: "reasoning", text: "secret" }],
          },
        ],
      } as never),
    ).rejects.toThrow();
  });

  test("fails when gateway usage is absent", async () => {
    const model = createAiSdkV3GatewayAdapter({
      routeRef: "r",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway: {
        handle: async () => response({ ...completion(), usage: undefined }),
      },
    });
    await expect(model.doGenerate(options as never)).rejects.toThrow();
  });

  test("maps a stream and preserves terminal authoritative usage", async () => {
    const frames = [
      {
        id: "s1",
        object: "chat.completion.chunk",
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
      },
      {
        id: "s1",
        object: "chat.completion.chunk",
        choices: [
          { index: 0, delta: { content: "hello" }, finish_reason: null },
        ],
      },
      {
        id: "s1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      {
        id: "s1",
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      },
    ];
    const model = createAiSdkV3GatewayAdapter({
      routeRef: "r",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway: {
        handle: async () =>
          new Response(
            `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          ),
      },
    });
    const result = await model.doStream(options as never);
    const parts = await Array.fromAsync(result.stream);
    expect(parts.map((part) => part.type)).toContain("text-delta");
    expect(parts.at(-1)?.usage.inputTokens.total).toBe(4);
  });

  test("cancels gateway response on consumer cancellation and rejects missing stream usage", async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}\n\n',
          ),
        );
      },
      cancel() {
        cancelled++;
      },
    });
    const model = createAiSdkV3GatewayAdapter({
      routeRef: "r",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway: {
        handle: async () =>
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
      },
    });
    const result = await model.doStream(options as never);
    const reader = result.stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(1);

    const noUsage = createAiSdkV3GatewayAdapter({
      routeRef: "r",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway: {
        handle: async () =>
          new Response(
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          ),
      },
    });
    const missing = await noUsage.doStream(options as never);
    await expect(Array.fromAsync(missing.stream)).rejects.toThrow();
  });

  test("rejects unknown stream types and propagates abort", async () => {
    const unknown = createAiSdkV3GatewayAdapter({
      routeRef: "r",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway: {
        handle: async () =>
          new Response(
            'data: {"type":"unexpected","choices":[]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          ),
      },
    });
    const result = await unknown.doStream(options as never);
    await expect(Array.fromAsync(result.stream)).rejects.toThrow();
    const controller = new AbortController();
    let gotSignal = false;
    const abortModel = createAiSdkV3GatewayAdapter({
      routeRef: "r",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway: {
        handle: async (request) => {
          gotSignal = request.signal === controller.signal;
          return response(completion());
        },
      },
    });
    await abortModel.doGenerate({
      ...options,
      abortSignal: controller.signal,
    } as never);
    expect(gotSignal).toBe(true);
  });

  test("lets ModelGateway resolve a distinct provider model from its route", async () => {
    let selectedRoute = "";
    let providerRequest: Request | undefined;
    const gateway = createModelGateway({
      resolveInvocation: async (request) => {
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${capability}`,
        );
        return {
          context: {
            tenantId: "tenant",
            workspaceId: "workspace",
            principalId: "principal",
            runId: "run",
            attemptId: "attempt",
            generation: 1,
            modelRouteRef: "trusted-route",
            modelRequestId: "request",
            maximumTokens: 20,
            expiresAt: "2030-01-01T00:00:00Z",
          },
          confirmUsage: async () => {},
          markUnknown: async () => {},
        };
      },
      selectModel: async (routeRef) => {
        selectedRoute = routeRef;
        return {
          model: { provider: "openai", defaultModel: "gpt-fixed" },
          credentialSecretRef: "secret",
        };
      },
      resolveApiKey: async () => "secret",
      environment: { OPENAI_BASE_URL: "https://provider.example/v1" },
      fetch: (async (input, init) => {
        providerRequest = new Request(input, init);
        return Response.json({
          id: "completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }) as typeof fetch,
    } as never);
    const model = createAiSdkV3GatewayAdapter({
      routeRef: "trusted-route",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway,
    });

    const result = await model.doGenerate(options as never);
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(selectedRoute).toBe("trusted-route");
    expect(providerRequest?.url).toBe(
      "https://provider.example/v1/chat/completions",
    );
    expect(await providerRequest?.json()).toMatchObject({ model: "gpt-fixed" });
  });

  test("consumes the real ModelGateway terminal placeholder with pinned streamText", async () => {
    const gateway = createModelGateway({
      resolveInvocation: async () => ({
        context: {
          tenantId: "tenant",
          workspaceId: "workspace",
          principalId: "principal",
          runId: "run",
          attemptId: "attempt",
          generation: 1,
          modelRouteRef: "trusted-route",
          modelRequestId: "request",
          maximumTokens: 20,
          expiresAt: "2030-01-01T00:00:00Z",
        },
        confirmUsage: async () => {},
        markUnknown: async () => {},
      }),
      selectModel: async () => ({
        model: { provider: "openai", defaultModel: "gpt-fixed" },
        credentialSecretRef: "secret",
      }),
      resolveApiKey: async () => "secret",
      environment: { OPENAI_BASE_URL: "https://provider.example/v1" },
      fetch: (async () =>
        new Response(
          [
            'data: {"id":"upstream","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
            'data: {"id":"upstream","choices":[{"index":0,"delta":{"content":"gateway answer"},"finish_reason":null}]}\n\n',
            'data: {"id":"upstream","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        )) as typeof fetch,
    } as never);
    const model = createAiSdkV3GatewayAdapter({
      routeRef: "trusted-route",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway,
    });
    const result = streamText({ model, prompt: "hello", maxOutputTokens: 20 });
    expect(await result.text).toBe("gateway answer");
    expect(await result.usage).toMatchObject({
      inputTokens: 3,
      outputTokens: 2,
    });
    expect(await result.finishReason).toBe("stop");
  });

  test("rejects malformed or non-terminal unindexed placeholder choices", async () => {
    const prefix = [
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
    ].join("");
    const placeholders = [
      '{"choices":[{"delta":{"content":"x"}}]}',
      '{"choices":[{"delta":{},"index":0}]}',
      '{"choices":[{"delta":{},"finish_reason":null}]}',
    ];
    for (const placeholder of placeholders) {
      const model = createAiSdkV3GatewayAdapter({
        routeRef: "r",
        runTokenCeiling: 20,
        issueCapability: async () => capability,
        gateway: {
          handle: async () =>
            new Response(`${prefix}data: ${placeholder}\n\ndata: [DONE]\n\n`, {
              headers: { "content-type": "text/event-stream" },
            }),
        },
      });
      const streamed = await model.doStream(options as never);
      await expect(Array.fromAsync(streamed.stream)).rejects.toThrow();
    }

    const beforeUsage = createAiSdkV3GatewayAdapter({
      routeRef: "r",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway: {
        handle: async () =>
          new Response(
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
              'data: {"choices":[{"delta":{}}]}\n\n' +
              'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          ),
      },
    });
    const streamed = await beforeUsage.doStream(options as never);
    await expect(Array.fromAsync(streamed.stream)).rejects.toThrow();

    const invalidPositions = [
      'data: {"choices":[{"delta":{}}]}\n\n' +
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
        "data: [DONE]\n\n",
      prefix +
        'data: {"choices":[{"delta":{}}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
        "data: [DONE]\n\n",
    ];
    for (const payload of invalidPositions) {
      const model = createAiSdkV3GatewayAdapter({
        routeRef: "r",
        runTokenCeiling: 20,
        issueCapability: async () => capability,
        gateway: {
          handle: async () =>
            new Response(payload, {
              headers: { "content-type": "text/event-stream" },
            }),
        },
      });
      const result = await model.doStream(options as never);
      await expect(Array.fromAsync(result.stream)).rejects.toThrow();
    }
  });

  test("aborts and cancels a stalled body when abort precedes listener registration", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const model = createAiSdkV3GatewayAdapter({
      routeRef: "r",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway: {
        handle: async () => {
          controller.abort(new Error("aborted before stream start"));
          return new Response(
            new ReadableStream<Uint8Array>({
              pull() {
                return new Promise<void>(() => {});
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
    });
    const streamed = await model.doStream({
      ...options,
      abortSignal: controller.signal,
    } as never);
    await expect(Array.fromAsync(streamed.stream)).rejects.toThrow();
    expect(cancelled).toBe(true);
  });

  test("validates inputs before capability issuance and sends canonical bearer", async () => {
    let issued = 0;
    let authorization: string | null = null;
    const model = createAiSdkV3GatewayAdapter({
      routeRef: "route",
      runTokenCeiling: 20,
      issueCapability: async () => {
        issued++;
        return capability;
      },
      gateway: {
        handle: async (request) => {
          authorization = request.headers.get("authorization");
          return response(completion());
        },
      },
    });
    await expect(
      model.doGenerate({ ...options, temperature: 0.5 } as never),
    ).rejects.toThrow();
    expect(issued).toBe(0);
    await expect(
      model.doGenerate({
        ...options,
        tools: [
          {
            type: "function",
            name: "bad name",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      } as never),
    ).rejects.toThrow();
    expect(issued).toBe(0);
    await model.doGenerate(options as never);
    expect(authorization).toBe(`Bearer ${capability}`);
    expect(issued).toBe(1);
  });

  test("keeps generated tool input as validated JSON text", async () => {
    const model = createAiSdkV3GatewayAdapter({
      routeRef: "route",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway: {
        handle: async () =>
          response({
            ...completion(),
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: { name: "lookup", arguments: '{"query":"x"}' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
      },
    });
    const result = await model.doGenerate(options as never);
    expect(result.content).toContainEqual({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "lookup",
      input: '{"query":"x"}',
      providerExecuted: false,
    });
  });

  test("AI SDK streamText consumes text lifecycle and executes fragmented tool calls", async () => {
    const chunks = [
      {
        id: "stream-1",
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
      },
      {
        id: "stream-1",
        choices: [
          { index: 0, delta: { content: "hello" }, finish_reason: null },
        ],
      },
      {
        id: "stream-1",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-",
                  type: "function",
                  function: { name: "look", arguments: '{"query":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "stream-1",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "1",
                  function: { name: "up", arguments: '"x"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "stream-1",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
      {
        id: "stream-1",
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      },
    ];
    let executedInput: unknown;
    const model = createAiSdkV3GatewayAdapter({
      routeRef: "route",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway: {
        handle: async () =>
          new Response(
            `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          ),
      },
    });
    const result = streamText({
      model,
      prompt: "run tool",
      maxOutputTokens: 20,
      tools: {
        lookup: tool({
          inputSchema: z.object({ query: z.string() }),
          execute: async (input) => {
            executedInput = input;
            return "found";
          },
        }),
      },
      stopWhen: ({ steps }) => steps.length >= 2,
    });
    const text = await result.text;
    const toolResults = await result.toolResults;
    expect(text).toContain("hello");
    expect(executedInput).toEqual({ query: "x" });
    expect(toolResults).toHaveLength(1);
  });

  test("preserves stream finish reasons and rejects inconsistent choices", async () => {
    for (const [raw, unified] of [
      ["stop", "stop"],
      ["length", "length"],
      ["tool_calls", "tool-calls"],
      ["content_filter", "content-filter"],
    ]) {
      const frames = [
        { choices: [{ index: 0, delta: {}, finish_reason: raw }] },
        {
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ];
      const model = createAiSdkV3GatewayAdapter({
        routeRef: "r",
        runTokenCeiling: 20,
        issueCapability: async () => capability,
        gateway: {
          handle: async () =>
            new Response(
              `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            ),
        },
      });
      const streamed = await model.doStream(options as never);
      const parts = await Array.fromAsync(streamed.stream);
      expect(parts.at(-1)?.finishReason).toEqual({ unified, raw });
    }

    const contradictory = createAiSdkV3GatewayAdapter({
      routeRef: "r",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway: {
        handle: async () =>
          new Response(
            `${[
              { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
              { choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
              {
                choices: [],
                usage: {
                  prompt_tokens: 1,
                  completion_tokens: 1,
                  total_tokens: 2,
                },
              },
            ]
              .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
              .join("")}data: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          ),
      },
    });
    const contradictoryResult = await contradictory.doStream(options as never);
    await expect(Array.fromAsync(contradictoryResult.stream)).rejects.toThrow();
  });

  test("cancels a stalled reader on abort and rejects trailing data after DONE", async () => {
    const abort = new AbortController();
    let cancelled = 0;
    const model = createAiSdkV3GatewayAdapter({
      routeRef: "r",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway: {
        handle: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel: () => {
                cancelled++;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      },
    });
    const streamed = await model.doStream({
      ...options,
      abortSignal: abort.signal,
    } as never);
    const reader = streamed.stream.getReader();
    await reader.read();
    abort.abort();
    await expect(reader.read()).rejects.toThrow();
    expect(cancelled).toBe(1);

    const trailing = createAiSdkV3GatewayAdapter({
      routeRef: "r",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway: {
        handle: async () =>
          new Response(
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\ndata: {"choices":[]}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          ),
      },
    });
    const trailingStream = await trailing.doStream(options as never);
    await expect(Array.fromAsync(trailingStream.stream)).rejects.toThrow();
  });

  test("rejects file names and provider metadata on tool results", async () => {
    const model = createAiSdkV3GatewayAdapter({
      routeRef: "r",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway: { handle: async () => response(completion()) },
    });
    await expect(
      model.doGenerate({
        ...options,
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "image/png",
                data: "AAAA",
                filename: "secret.png",
              },
            ],
          },
        ],
      } as never),
    ).rejects.toThrow();
    await expect(
      model.doGenerate({
        ...options,
        prompt: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call",
                toolName: "lookup",
                output: {
                  type: "text",
                  value: "ok",
                  providerOptions: { vendor: { x: true } },
                },
              },
            ],
          },
        ],
      } as never),
    ).rejects.toThrow();
  });

  describe("per-step cap from the remaining run ceiling", () => {
    test("issues the whole remaining ceiling first and narrows after settled usage", async () => {
      const issued: number[] = [];
      const payloads: Record<string, unknown>[] = [];
      const model = createAiSdkV3GatewayAdapter({
        routeRef: "r",
        runTokenCeiling: 100,
        issueCapability: async (maximumTokens) => {
          issued.push(maximumTokens);
          return capability;
        },
        gateway: {
          handle: async (request) => {
            payloads.push(await request.json());
            return response(
              completion({
                prompt_tokens: 60,
                completion_tokens: 10,
                total_tokens: 70,
              }),
            );
          },
        },
      });
      await model.doGenerate({ ...options, maxOutputTokens: 100 } as never);
      expect(issued).toEqual([100]);
      expect(payloads[0].max_tokens).toBe(100);
      await model.doGenerate({ ...options, maxOutputTokens: 100 } as never);
      expect(issued).toEqual([100, 30]);
      expect(payloads[1].max_tokens).toBe(30);
    });

    test("refuses an exhausted or malformed remaining ceiling before issue and gateway", async () => {
      let issued = 0;
      let handled = 0;
      const model = createAiSdkV3GatewayAdapter({
        routeRef: "r",
        runTokenCeiling: 100,
        issueCapability: async () => {
          issued++;
          return capability;
        },
        gateway: {
          handle: async () => {
            handled++;
            return response(
              completion({
                prompt_tokens: 90,
                completion_tokens: 10,
                total_tokens: 100,
              }),
            );
          },
        },
      });
      await model.doGenerate({ ...options, maxOutputTokens: 100 } as never);
      await expect(
        model.doGenerate({ ...options, maxOutputTokens: 100 } as never),
      ).rejects.toThrow("MODEL_GATEWAY_RUN_BUDGET_EXHAUSTED");
      expect(issued).toBe(1);
      expect(handled).toBe(1);

      let invalidIssued = 0;
      const invalid = createAiSdkV3GatewayAdapter({
        routeRef: "r",
        runTokenCeiling: 100.5,
        issueCapability: async () => {
          invalidIssued++;
          return capability;
        },
        gateway: { handle: async () => response(completion()) },
      });
      await expect(
        invalid.doGenerate({ ...options, maxOutputTokens: 100 } as never),
      ).rejects.toThrow("MODEL_GATEWAY_RUN_BUDGET_EXHAUSTED");
      expect(invalidIssued).toBe(0);
    });

    test("stops before the gateway when the persisted capability issue rejects", async () => {
      let handled = 0;
      const rejection = new Error("MODEL_BUDGET_EXCEEDED");
      const model = createAiSdkV3GatewayAdapter({
        routeRef: "r",
        runTokenCeiling: 100,
        issueCapability: async () => {
          throw rejection;
        },
        gateway: {
          handle: async () => {
            handled++;
            return response(completion());
          },
        },
      });
      await expect(
        model.doGenerate({ ...options, maxOutputTokens: 100 } as never),
      ).rejects.toBe(rejection);
      expect(handled).toBe(0);
    });

    test("errors a stream after its usage frame without crediting or finishing", async () => {
      const issued: number[] = [];
      const frames = [
        'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":60,"completion_tokens":10,"total_tokens":70}}\n\n',
      ].join("");
      const model = createAiSdkV3GatewayAdapter({
        routeRef: "r",
        runTokenCeiling: 100,
        issueCapability: async (maximumTokens) => {
          issued.push(maximumTokens);
          return capability;
        },
        gateway: {
          handle: async (request) =>
            request.headers.get("accept") === "text/event-stream"
              ? new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(new TextEncoder().encode(frames));
                      controller.error(
                        new Error("upstream failed before DONE"),
                      );
                    },
                  }),
                  { headers: { "content-type": "text/event-stream" } },
                )
              : response(completion()),
        },
      });
      const streamed = await model.doStream({
        ...options,
        maxOutputTokens: 100,
      } as never);
      const collected: { type?: unknown }[] = [];
      await expect(
        (async () => {
          for await (const part of streamed.stream) collected.push(part);
        })(),
      ).rejects.toThrow();
      expect(collected.some((part) => part.type === "finish")).toBe(false);
      await model.doGenerate({ ...options, maxOutputTokens: 100 } as never);
      expect(issued).toEqual([100, 100]);
    });

    test("treats a failed usage confirmation as an errored stream without a finish", async () => {
      const gateway = createModelGateway({
        resolveInvocation: async () => ({
          context: {
            tenantId: "tenant",
            workspaceId: "workspace",
            principalId: "principal",
            runId: "run",
            attemptId: "attempt",
            generation: 1,
            modelRouteRef: "trusted-route",
            modelRequestId: "request",
            maximumTokens: 100,
            expiresAt: "2030-01-01T00:00:00Z",
          },
          confirmUsage: async () => {
            throw new Error("settlement unavailable");
          },
          markUnknown: async () => {},
        }),
        selectModel: async () => ({
          model: { provider: "openai", defaultModel: "gpt-fixed" },
          credentialSecretRef: "secret",
        }),
        resolveApiKey: async () => "secret",
        environment: { OPENAI_BASE_URL: "https://provider.example/v1" },
        fetch: (async () =>
          new Response(
            [
              'data: {"id":"upstream","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
              'data: {"id":"upstream","choices":[{"index":0,"delta":{"content":"gateway answer"},"finish_reason":null}]}\n\n',
              'data: {"id":"upstream","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
            ].join(""),
            { headers: { "content-type": "text/event-stream" } },
          )) as typeof fetch,
      } as never);
      const model = createAiSdkV3GatewayAdapter({
        routeRef: "trusted-route",
        runTokenCeiling: 100,
        issueCapability: async () => capability,
        gateway,
      });
      const streamed = await model.doStream({
        ...options,
        maxOutputTokens: 100,
      } as never);
      const collected: { type?: unknown }[] = [];
      await expect(
        (async () => {
          for await (const part of streamed.stream) collected.push(part);
        })(),
      ).rejects.toThrow();
      expect(collected.some((part) => part.type === "finish")).toBe(false);
    });

    test("issues a distinct narrowed capability for each pinned streamText step", async () => {
      const issued: number[] = [];
      const sentCaps: number[] = [];
      const seen: string[] = [];
      let n = 0;
      let call = 0;
      const stepUsage = {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      };
      const streamBody = (id: string, chunks: unknown[]) =>
        new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: ${JSON.stringify({ id, choices: [], usage: stepUsage })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      const toolStep = (id: string, callId: string) => [
        {
          id,
          choices: [
            { index: 0, delta: { role: "assistant" }, finish_reason: null },
          ],
        },
        {
          id,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: callId,
                    type: "function",
                    function: { name: "lookup", arguments: '{"query":"x"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { id, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ];
      const textStep = (id: string) => [
        {
          id,
          choices: [
            { index: 0, delta: { role: "assistant" }, finish_reason: null },
          ],
        },
        {
          id,
          choices: [
            { index: 0, delta: { content: "done" }, finish_reason: null },
          ],
        },
        { id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      let executions = 0;
      const model = createAiSdkV3GatewayAdapter({
        routeRef: "r",
        runTokenCeiling: 100,
        issueCapability: async (maximumTokens) => {
          issued.push(maximumTokens);
          return Buffer.alloc(32, ++n).toString("base64url");
        },
        gateway: {
          handle: async (request) => {
            call++;
            sentCaps.push((await request.json()).max_tokens);
            seen.push(request.headers.get("authorization")!);
            if (call < 3)
              return streamBody(
                `s${call}`,
                toolStep(`s${call}`, `call-${call}`),
              );
            return streamBody("s3", textStep("s3"));
          },
        },
      });
      const result = streamText({
        model,
        prompt: "run tool",
        maxOutputTokens: 100,
        tools: {
          lookup: tool({
            inputSchema: z.object({ query: z.string() }),
            execute: async () => {
              executions++;
              return "found";
            },
          }),
        },
        stopWhen: ({ steps }) => steps.length >= 3,
      });
      expect(await result.text).toBe("done");
      expect(executions).toBe(2);
      expect(issued).toEqual([100, 85, 70]);
      expect(sentCaps).toEqual([100, 85, 70]);
      expect(new Set(seen).size).toBe(3);
    });
  });
});

// --- OCR R5: parallel tool results, error-body surfacing, usage agreement ---

test("parallel_tool_results_each_become_their_own_tool_message", async () => {
  const payloads: unknown[] = [];
  const model = createAiSdkV3GatewayAdapter({
    routeRef: "r",
    runTokenCeiling: 20,
    issueCapability: async () => capability,
    gateway: {
      handle: async (request) => {
        payloads.push(await request.json());
        return response(completion());
      },
    },
  });
  await model.doGenerate({
    prompt: [
      { role: "user", content: [{ type: "text", text: "run both" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "lookup",
            output: { type: "text", value: "first" },
          },
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "lookup",
            output: { type: "text", value: "second" },
          },
        ],
      },
    ],
    maxOutputTokens: 20,
  } as never);
  // One OpenAI tool message per tool_call_id — AI SDK merges a step's tool
  // results into one message with distinct per-part ids (R5-H1).
  expect(payloads[0]).toEqual({
    messages: [
      { role: "user", content: [{ type: "text", text: "run both" }] },
      { role: "tool", tool_call_id: "call-1", content: "first" },
      { role: "tool", tool_call_id: "call-2", content: "second" },
    ],
    max_tokens: 20,
  });
});

test("non_2xx_response_surfaces_gateway_code", async () => {
  const gatewayError = () =>
    new Response(
      JSON.stringify({ error: { code: "MODEL_ROUTE_UNAVAILABLE" } }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      },
    );
  const model = createAiSdkV3GatewayAdapter({
    routeRef: "r",
    runTokenCeiling: 20,
    issueCapability: async () => capability,
    gateway: { handle: async () => gatewayError() },
  });
  // The gateway's structured non-2xx body must reach the thrown error so
  // downstream classification can tell drift from infrastructure (R5-M1).
  await expect(model.doGenerate(options as never)).rejects.toThrow(
    /MODEL_GATEWAY_HTTP_400.*MODEL_ROUTE_UNAVAILABLE/,
  );
  await expect(model.doStream(options as never)).rejects.toThrow(
    /MODEL_GATEWAY_HTTP_400.*MODEL_ROUTE_UNAVAILABLE/,
  );
});

test("second_usage_chunk_must_agree_or_fail", async () => {
  const sse = (
    usages: { prompt_tokens: number; completion_tokens: number }[],
  ) =>
    new Response(
      [
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        ...usages.map(
          (usage) =>
            `data: ${JSON.stringify({
              choices: [],
              usage: {
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                total_tokens: usage.prompt_tokens + usage.completion_tokens,
              },
            })}\n\n`,
        ),
        "data: [DONE]\n\n",
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  const agree = createAiSdkV3GatewayAdapter({
    routeRef: "r",
    runTokenCeiling: 20,
    issueCapability: async () => capability,
    gateway: {
      handle: async () =>
        sse([
          { prompt_tokens: 4, completion_tokens: 2 },
          { prompt_tokens: 4, completion_tokens: 2 },
        ]),
    },
  });
  const agreed = await agree.doStream(options as never);
  const parts = await Array.fromAsync(agreed.stream);
  expect(parts.at(-1)?.usage.inputTokens.total).toBe(4);

  // Two internally-consistent but mutually contradictory usage blocks must
  // fail closed instead of the second silently overwriting the first (R5-L1).
  const disagree = createAiSdkV3GatewayAdapter({
    routeRef: "r",
    runTokenCeiling: 20,
    issueCapability: async () => capability,
    gateway: {
      handle: async () =>
        sse([
          { prompt_tokens: 4, completion_tokens: 2 },
          { prompt_tokens: 5, completion_tokens: 2 },
        ]),
    },
  });
  const disagreed = await disagree.doStream(options as never);
  await expect(Array.fromAsync(disagreed.stream)).rejects.toThrow(
    "UNSUPPORTED_OR_INVALID_MODEL_GATEWAY_RESPONSE",
  );
});

test("finish_reason_mapping_still_strict", async () => {
  for (const finish_reason of [
    "stop",
    "length",
    "tool_calls",
    "content_filter",
  ]) {
    const model = createAiSdkV3GatewayAdapter({
      routeRef: "r",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway: {
        handle: async () => response({ ...completion(), choices: undefined }),
      },
    });
    void model;
    void finish_reason;
  }
  // Behavior lock for the mapping refactor: unknown finish reasons reject.
  const model = createAiSdkV3GatewayAdapter({
    routeRef: "r",
    runTokenCeiling: 20,
    issueCapability: async () => capability,
    gateway: {
      handle: async () =>
        response({
          ...completion(),
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "x" },
              finish_reason: "totally_unknown",
            },
          ],
        }),
    },
  });
  await expect(model.doGenerate(options as never)).rejects.toThrow();
  // And every mapped reason still succeeds end-to-end.
  for (const finish_reason of [
    "stop",
    "length",
    "tool_calls",
    "content_filter",
  ]) {
    const okay = createAiSdkV3GatewayAdapter({
      routeRef: "r",
      runTokenCeiling: 20,
      issueCapability: async () => capability,
      gateway: {
        handle: async () =>
          response({
            ...completion(),
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "x" },
                finish_reason,
              },
            ],
          }),
      },
    });
    const result = await okay.doGenerate(options as never);
    expect(result.finishReason).toBeDefined();
  }
});
