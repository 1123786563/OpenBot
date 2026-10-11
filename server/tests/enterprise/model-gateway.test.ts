import { afterEach, expect, test } from "bun:test";
import type { ModelInvocationContext } from "../../src/enterprise/contracts";
import { createModelGateway } from "../../src/enterprise/models/gateway";

const context: ModelInvocationContext = {
  tenantId: "t",
  workspaceId: "w",
  principalId: "p",
  runId: "run-1",
  attemptId: "attempt-1",
  generation: 1,
  modelRouteRef: "trusted-route",
  modelRequestId: "request-1",
  maximumTokens: 64,
  expiresAt: "2030-01-01T00:00:00Z",
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function req(body: unknown, signal?: AbortSignal) {
  const withDefaultCap =
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    !("max_tokens" in body)
      ? { ...body, max_tokens: 32 }
      : body;
  return new Request("https://runtime.example/model", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withDefaultCap),
    signal,
  });
}
function rawReq(body: unknown, signal?: AbortSignal) {
  return new Request("https://runtime.example/model", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}
function deps(overrides: Record<string, unknown> = {}) {
  return {
    resolveInvocation: async () => ({
      context,
      confirmUsage: async (_n: number) => {},
      markUnknown: async () => {},
    }),
    selectModel: async () => ({
      model: { provider: "openai" as const, defaultModel: "gpt-fixed" },
      credentialSecretRef: "credential-1",
    }),
    resolveApiKey: async () => "synthetic-secret",
    fetch: (async () =>
      Response.json({
        id: "x",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "answer" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      })) as typeof fetch,
    environment: { OPENAI_BASE_URL: "https://gateway.example/v1" },
    ...overrides,
  };
}
function manualTimer() {
  let now = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const pending: Array<{
    callback: () => void;
    at: number;
    active: boolean;
  }> = [];
  return {
    timer: {
      schedule(callback: () => void, milliseconds: number) {
        const handle = { callback, at: now + milliseconds, active: true };
        pending.push(handle);
        for (const waiter of waiters.splice(0)) {
          if (pending.length >= waiter.count) waiter.resolve();
          else waiters.push(waiter);
        }
        return handle;
      },
      cancel(handle: unknown) {
        (handle as (typeof pending)[number]).active = false;
      },
      activeCount() {
        return pending.filter((item) => item.active).length;
      },
    },
    waitForCount(count: number) {
      if (pending.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push({ count, resolve }));
    },
    advanceBy(milliseconds: number) {
      now += milliseconds;
      for (const item of pending) {
        if (item.active && item.at <= now) {
          item.active = false;
          item.callback();
        }
      }
    },
  };
}

test("trusted route and token ceiling ignore caller substitution; usage settles", async () => {
  let route = "";
  let confirmed = 0;
  const gateway = createModelGateway(
    deps({
      selectModel: async (ref: string) => {
        route = ref;
        return deps().selectModel();
      },
      resolveInvocation: async () => ({
        context,
        confirmUsage: async (n: number) => {
          confirmed = n;
        },
        markUnknown: async () => {},
      }),
    }) as never,
  );
  const response = await gateway.handle(
    req({
      model: "gpt-fixed",
      model_route_ref: "evil",
      max_tokens: 900,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  expect(response.status).toBe(400); // route override is outside strict request schema
  expect(route).toBe("");
  const overCeiling = await gateway.handle(
    req({
      model: "gpt-fixed",
      max_tokens: 65,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  expect(overCeiling.status).toBe(400);
  expect(route).toBe("");
  const valid = await gateway.handle(
    req({
      model: "gpt-fixed",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  expect(valid.status).toBe(200);
  expect(route).toBe("trusted-route");
  expect(confirmed).toBe(5);
});

test("missing, invalid and over-ceiling output caps reject before route or credentials", async () => {
  let touched = 0;
  const gateway = createModelGateway(
    deps({
      selectModel: async () => {
        touched++;
        return null;
      },
      resolveApiKey: async () => {
        touched++;
        return null;
      },
      fetch: (async () => {
        touched++;
        return Response.json({});
      }) as typeof fetch,
    }) as never,
  );
  for (const value of [
    undefined,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "5",
    null,
  ]) {
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: "hi" }],
    };
    if (value !== undefined) body.max_tokens = value;
    const response = await gateway.handle(rawReq(body));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("secret");
  }
  const above = await gateway.handle(
    req({ max_tokens: 65, messages: [{ role: "user", content: "hi" }] }),
  );
  expect(above.status).toBe(400);
  expect(touched).toBe(0);
});

test("confirmation rejection falls back to exactly one unknown settlement", async () => {
  let confirmed = 0,
    unknown = 0;
  const gateway = createModelGateway(
    deps({
      resolveInvocation: async () => ({
        context,
        confirmUsage: async () => {
          confirmed++;
          throw new Error("private settlement secret");
        },
        markUnknown: async () => {
          unknown++;
          throw new Error("private unknown secret");
        },
      }),
    }) as never,
  );
  const response = await gateway.handle(
    req({ messages: [{ role: "user", content: "hi" }] }),
  );
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("secret");
  expect(confirmed).toBe(1);
  expect(unknown).toBe(1);
});

test("SSE confirmation rejection falls back once and exposes only a generic body error", async () => {
  let confirmed = 0,
    unknown = 0;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        ),
      );
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
        ),
      );
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const gateway = createModelGateway(
    deps({
      resolveInvocation: async () => ({
        context,
        confirmUsage: async () => {
          confirmed++;
          throw new Error("private confirmation detail");
        },
        markUnknown: async () => {
          unknown++;
          throw new Error("private unknown detail");
        },
      }),
      fetch: (async () =>
        new Response(source, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const response = await gateway.handle(
    req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  );
  await expect(response.text()).rejects.toThrow("MODEL_STREAM_FAILED");
  expect(confirmed).toBe(1);
  expect(unknown).toBe(1);
});

test("resolver rejection precedes route and credential access and returns a safe error", async () => {
  let touched = false;
  const gateway = createModelGateway(
    deps({
      resolveInvocation: async () => {
        throw new Error("private capability secret");
      },
      selectModel: async () => {
        touched = true;
        return null;
      },
      resolveApiKey: async () => {
        touched = true;
        return null;
      },
    }) as never,
  );
  const response = await gateway.handle(
    req({ messages: [{ role: "user", content: "hi" }] }),
  );
  expect(response.status).toBe(401);
  expect(touched).toBe(false);
  expect(await response.text()).not.toContain("private capability secret");
});

test("OpenAI preserves tool calls/results and normalizes usage", async () => {
  let sent: Record<string, unknown> = {};
  const gateway = createModelGateway(
    deps({
      fetch: (async (_url: unknown, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return Response.json({
          id: "chat-1",
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
                    function: { name: "lookup", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
        });
      }) as typeof fetch,
    }) as never,
  );
  const response = await gateway.handle(
    req({
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "done" },
      ],
    }),
  );
  expect(sent.messages).toHaveLength(2);
  expect((await response.json()).choices[0].finish_reason).toBe("tool_calls");
});

test("Anthropic maps system, assistant tool use and tool result to native protocol", async () => {
  let sent: Record<string, unknown> = {};
  const gateway = createModelGateway(
    deps({
      selectModel: async () => ({
        model: { provider: "anthropic", defaultModel: "claude-fixed" },
        credentialSecretRef: "credential-1",
      }),
      fetch: (async (_url: unknown, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return Response.json({
          id: "msg",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "lookup",
              input: { q: "x" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 4, output_tokens: 3 },
        });
      }) as typeof fetch,
    }) as never,
  );
  const response = await gateway.handle(
    req({
      messages: [
        { role: "system", content: "rules" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"x"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "ok" },
      ],
    }),
  );
  expect(sent.system).toBe("rules");
  expect(sent.messages[0].content[0].type).toBe("tool_use");
  expect(sent.messages[1].content[0].type).toBe("tool_result");
  expect((await response.json()).usage.total_tokens).toBe(7);
});

test("desktop PlanModel route bypasses API key resolution and keeps harness config private", async () => {
  let keyRead = false;
  const gateway = createModelGateway(
    deps({
      environment: {
        CHATGPT_AUTH_FILE: "/private/auth",
        PICKED_HARNESS_IMAGE: "agent-langgraph-agui:latest",
        PICKED_HARNESS_URL: "http://127.0.0.1:9988",
        MANAGED_AGENT_TOKEN: "harness-secret",
      },
      selectModel: async () => ({
        model: {
          provider: "openai",
          defaultModel: "gpt-fixed",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("http://127.0.0.1:9988"),
            token: "harness-secret",
          },
        },
        credentialSecretRef: "",
        planBotId: "bot-1",
      }),
      resolveApiKey: async () => {
        keyRead = true;
        return null;
      },
      createPlanModel: () => ({
        doGenerate: async () => ({
          content: [{ type: "text", text: "plan answer" }],
          finishReason: "stop",
          usage: {},
        }),
      }),
    }) as never,
  );
  const response = await gateway.handle(
    req({ messages: [{ role: "user", content: "hello" }] }),
  );
  expect(response.status).toBe(200);
  expect(keyRead).toBe(false);
  const body = await response.text();
  expect(body).toContain("plan answer");
  expect(body).not.toContain("harness-secret");
});

test("PlanModel model parts become OpenAI SSE and preserve run thread, tools and unknown usage", async () => {
  let keyRead = false;
  let unknown = 0;
  let observed: unknown;
  const gateway = createModelGateway(
    deps({
      environment: {
        CHATGPT_AUTH_FILE: "/private/auth",
        PICKED_HARNESS_IMAGE: "agent-langgraph-agui:latest",
        PICKED_HARNESS_URL: "http://127.0.0.1:9988",
        MANAGED_AGENT_TOKEN: "harness-secret",
      },
      selectModel: async () => ({
        model: { provider: "openai", defaultModel: "gpt-fixed" },
        credentialSecretRef: "",
        planBotId: "trusted-bot",
      }),
      resolveApiKey: async () => {
        keyRead = true;
        return null;
      },
      resolveInvocation: async () => ({
        context,
        confirmUsage: async () => {
          throw new Error("must not confirm unknown plan usage");
        },
        markUnknown: async () => {
          unknown++;
        },
      }),
      createPlanModel: (_config: unknown, botId: string, threadId: string) => {
        expect(botId).toBe("trusted-bot");
        expect(threadId).toBe(context.runId);
        return {
          doGenerate: async () => ({
            content: [],
            finishReason: "stop",
            usage: {},
          }),
          doStream: async (options: unknown) => {
            observed = options;
            return {
              stream: new ReadableStream({
                start(controller) {
                  controller.enqueue({
                    type: "text-delta",
                    id: "text-1",
                    delta: "answer",
                  });
                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: "call-1",
                    toolName: "lookup",
                    input: { q: 1 },
                  });
                  controller.enqueue({
                    type: "finish",
                    finishReason: { unified: "tool-calls" },
                    usage: {},
                  });
                  controller.close();
                },
              }),
            };
          },
        };
      },
    }) as never,
  );
  const response = await gateway.handle(
    req({
      stream: true,
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object" } },
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    }),
  );
  const output = await response.text();
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(output).toContain('"content":"answer"');
  expect(output).toContain('"name":"lookup"');
  expect(output).toContain("[DONE]");
  expect(keyRead).toBe(false);
  expect(unknown).toBe(1);
  expect(JSON.stringify(observed)).toContain('"name":"lookup"');
  expect(output).not.toContain("harness-secret");
});

test("stream responds incrementally and redacts a secret split across chunks", async () => {
  let finish!: () => void;
  const end = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        ),
      );
      void (async () => {
        await end;
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"synthe',
          ),
        );
        controller.enqueue(
          new TextEncoder().encode(
            'tic-secret"},"finish_reason":"stop"}] ,"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
          ),
        );
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      })();
    },
  });
  const gateway = createModelGateway(
    deps({
      fetch: (async () =>
        new Response(upstream, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const response = await gateway.handle(
    req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  );
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  finish();
  let output = new TextDecoder().decode(first.value);
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    output += new TextDecoder().decode(next.value);
  }
  expect(output).not.toContain("synthetic-secret");
  expect(output).toContain("[redacted]");
  expect(output).toContain("[DONE]");
});

test("Anthropic SSE frames normalize incrementally to canonical OpenAI tool and usage chunks", async () => {
  let confirmed = 0;
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":4}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-1","name":"lookup","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames)
        controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
  const gateway = createModelGateway(
    deps({
      selectModel: async () => ({
        model: { provider: "anthropic", defaultModel: "claude-fixed" },
        credentialSecretRef: "credential-1",
      }),
      resolveInvocation: async () => ({
        context,
        confirmUsage: async (n: number) => {
          confirmed = n;
        },
        markUnknown: async () => {},
      }),
      fetch: (async () =>
        new Response(upstream, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const response = await gateway.handle(
    req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  );
  const output = await response.text();
  expect(output).toContain('"object":"chat.completion.chunk"');
  expect(output).toContain('"id":"call-1"');
  expect(output).toContain('"finish_reason":"tool_calls"');
  expect(output).toContain("[DONE]");
  expect(confirmed).toBe(7);
});

test("abort after dispatch marks usage unknown once and upstream errors stay generic", async () => {
  const controller = new AbortController();
  let unknown = 0;
  let signalReady!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const gateway = createModelGateway(
    deps({
      resolveInvocation: async () => ({
        context,
        confirmUsage: async () => {},
        markUnknown: async () => {
          unknown++;
        },
      }),
      fetch: (async (_url: unknown, init?: RequestInit) => {
        return await new Promise<Response>((_resolve, reject) => {
          signalReady();
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("private URL and secret")),
            { once: true },
          );
        });
      }) as typeof fetch,
    }) as never,
  );
  const pending = gateway.handle(
    req({ messages: [{ role: "user", content: "hi" }] }, controller.signal),
  );
  await dispatched;
  controller.abort();
  const response = await pending;
  expect(response.status).toBe(502);
  expect(unknown).toBe(1);
  expect(await response.text()).not.toContain("private");
});

test("stream rejects malformed and oversized SSE frames without forwarding provider bytes", async () => {
  const malformed = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(
        new TextEncoder().encode("data: synthetic-secret malformed\n\n"),
      );
      c.close();
    },
  });
  const gateway = createModelGateway(
    deps({
      fetch: (async () =>
        new Response(malformed, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const response = await gateway.handle(
    req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  );
  await expect(response.text()).rejects.toThrow();
  const oversizedFrame = `data: ${"x".repeat(1_048_577)}\n\n`;
  // The second case deliberately withholds the delimiter until the next
  // upstream read, proving the parser enforces its limit across chunks.
  for (const chunks of [
    [oversizedFrame],
    [oversizedFrame.slice(0, 700_000), oversizedFrame.slice(700_000)],
  ]) {
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        for (const x of chunks) c.enqueue(new TextEncoder().encode(x));
        c.close();
      },
    });
    const g = createModelGateway(
      deps({
        fetch: (async () =>
          new Response(source, {
            headers: { "content-type": "text/event-stream" },
          })) as typeof fetch,
      }) as never,
    );
    const r = await g.handle(
      req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
    );
    await expect(r.text()).rejects.toThrow();
  }
});

test("stream redacts OpenAI tool arguments across events", async () => {
  const frames = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"synthe"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"tic-secret"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
    "data: [DONE]\n\n",
  ];
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      frames.forEach((x) => {
        c.enqueue(new TextEncoder().encode(x));
      });
      c.close();
    },
  });
  const g = createModelGateway(
    deps({
      fetch: (async () =>
        new Response(source, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const out = await (
    await g.handle(
      req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
    )
  ).text();
  expect(out).not.toContain("synthetic-secret");
  expect(out).toContain("[redacted]");
});

test("Anthropic stream confirms only authoritative usage and normalizes prompt/completion fields", async () => {
  for (const outputTokens of [3, "bad", undefined]) {
    let confirmed = 0,
      unknown = 0;
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":4}}}\n\n',
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":${JSON.stringify(outputTokens === undefined ? {} : { output_tokens: outputTokens })}}\n\n`,
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        frames.forEach((x) => {
          c.enqueue(new TextEncoder().encode(x));
        });
        c.close();
      },
    });
    const g = createModelGateway(
      deps({
        selectModel: async () => ({
          model: { provider: "anthropic", defaultModel: "claude-fixed" },
          credentialSecretRef: "c",
        }),
        resolveInvocation: async () => ({
          context,
          confirmUsage: async (n) => {
            confirmed = n;
          },
          markUnknown: async () => {
            unknown++;
          },
        }),
        fetch: (async () =>
          new Response(source, {
            headers: { "content-type": "text/event-stream" },
          })) as typeof fetch,
      }) as never,
    );
    const out = await (
      await g.handle(
        req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
      )
    ).text();
    if (outputTokens === 3) {
      expect(confirmed).toBe(7);
      expect(out).toContain(
        '"prompt_tokens":4,"completion_tokens":3,"total_tokens":7',
      );
    } else expect(unknown).toBe(1);
  }
});

test("PlanModel stream header wait is bounded while its live body outlives header deadline", async () => {
  const clock = manualTimer();
  let unknown = 0;
  let signal!: AbortSignal;
  const g = createModelGateway(
    deps({
      environment: {
        CHATGPT_AUTH_FILE: "/private/auth",
        PICKED_HARNESS_IMAGE: "agent-langgraph-agui:latest",
        PICKED_HARNESS_URL: "http://127.0.0.1:9988",
        MANAGED_AGENT_TOKEN: "harness-secret",
      },
      requestTimeoutMs: 5,
      streamTimeoutMs: 20,
      timer: clock.timer,
      selectModel: async () => ({
        model: {
          provider: "openai",
          defaultModel: "gpt-fixed",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("http://127.0.0.1:9988"),
            token: "harness-secret",
          },
        },
        credentialSecretRef: "",
        planBotId: "bot",
      }),
      resolveInvocation: async () => ({
        context,
        confirmUsage: async () => {},
        markUnknown: async () => {
          unknown++;
        },
      }),
      createPlanModel: (
        _c: unknown,
        _b: string,
        _t: string,
        s: AbortSignal,
      ) => {
        signal = s;
        return {
          doGenerate: async () => ({
            content: [],
            finishReason: "stop",
            usage: {},
          }),
          doStream: async () =>
            await new Promise<never>((_resolve, reject) => {
              if (s.aborted) reject(s.reason);
              else
                s.addEventListener("abort", () => reject(s.reason), {
                  once: true,
                });
            }),
        };
      },
    }) as never,
  );
  const pending = g.handle(
    req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  );
  await clock.waitForCount(2);
  clock.advanceBy(5);
  const abortedAtHeaderDeadline = signal.aborted;
  clock.advanceBy(20);
  expect((await pending).status).toBe(502);
  expect(abortedAtHeaderDeadline).toBe(true);
  expect(unknown).toBe(1);

  const healthyClock = manualTimer();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let confirmed = 0;
  const healthy = createModelGateway(
    deps({
      environment: {
        CHATGPT_AUTH_FILE: "/private/auth",
        PICKED_HARNESS_IMAGE: "agent-langgraph-agui:latest",
        PICKED_HARNESS_URL: "http://127.0.0.1:9988",
        MANAGED_AGENT_TOKEN: "harness-secret",
      },
      requestTimeoutMs: 5,
      streamTimeoutMs: 20,
      timer: healthyClock.timer,
      selectModel: async () => ({
        model: {
          provider: "openai",
          defaultModel: "gpt-fixed",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("http://127.0.0.1:9988"),
            token: "harness-secret",
          },
        },
        credentialSecretRef: "",
        planBotId: "bot",
      }),
      resolveInvocation: async () => ({
        context,
        confirmUsage: async () => {
          confirmed++;
        },
        markUnknown: async () => {},
      }),
      createPlanModel: () => ({
        doGenerate: async () => ({
          content: [],
          finishReason: "stop",
          usage: {},
        }),
        doStream: async () => ({
          stream: new ReadableStream({
            async pull(c) {
              await delayed;
              c.enqueue({
                type: "finish",
                finishReason: { unified: "stop" },
                usage: {},
              });
              c.close();
            },
          }),
        }),
      }),
    }) as never,
  );
  const responsePromise = healthy.handle(
    req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  );
  await healthyClock.waitForCount(2);
  const response = await responsePromise;
  const body = response.text();
  healthyClock.advanceBy(5);
  release();
  expect(await body).toContain("[DONE]");
  expect(confirmed).toBe(0);
});

test("PlanModel non-stream completion and early configuration failure clear request timers", async () => {
  const clock = manualTimer();
  const base = {
    environment: {
      CHATGPT_AUTH_FILE: "/private/auth",
      PICKED_HARNESS_IMAGE: "agent-langgraph-agui:latest",
      PICKED_HARNESS_URL: "http://127.0.0.1:9988",
      MANAGED_AGENT_TOKEN: "harness-secret",
    },
    timer: clock.timer,
    selectModel: async () => ({
      model: {
        provider: "openai",
        defaultModel: "gpt-fixed",
        plan: {
          provider: "chatgpt",
          endpoint: new URL("http://127.0.0.1:9988"),
          token: "harness-secret",
        },
      },
      credentialSecretRef: "",
      planBotId: "bot",
    }),
    createPlanModel: () => ({
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: {},
      }),
    }),
  };
  const success = createModelGateway(deps(base) as never);
  expect(
    (await success.handle(req({ messages: [{ role: "user", content: "hi" }] })))
      .status,
  ).toBe(200);
  expect((clock.timer as { activeCount(): number }).activeCount()).toBe(0);
  const earlyClock = manualTimer();
  const early = createModelGateway(
    deps({
      ...base,
      timer: earlyClock.timer,
      selectModel: async () => ({
        model: {
          provider: "openai",
          defaultModel: "gpt-fixed",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("http://127.0.0.1:9988"),
            token: "harness-secret",
          },
        },
        credentialSecretRef: "",
      }),
    }) as never,
  );
  expect(
    (await early.handle(req({ messages: [{ role: "user", content: "hi" }] })))
      .status,
  ).toBe(503);
  expect((earlyClock.timer as { activeCount(): number }).activeCount()).toBe(0);
});

test("PlanModel timeout uses its shared signal and settlement is attempted once", async () => {
  const clock = manualTimer();
  let captured: AbortSignal | undefined,
    unknown = 0;
  const g = createModelGateway(
    deps({
      environment: {
        CHATGPT_AUTH_FILE: "/private/auth",
        PICKED_HARNESS_IMAGE: "agent-langgraph-agui:latest",
        PICKED_HARNESS_URL: "http://127.0.0.1:9988",
        MANAGED_AGENT_TOKEN: "harness-secret",
      },
      requestTimeoutMs: 5,
      timer: clock.timer,
      selectModel: async () => ({
        model: {
          provider: "openai",
          defaultModel: "gpt-fixed",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("http://127.0.0.1:9988"),
            token: "harness-secret",
          },
        },
        credentialSecretRef: "",
        planBotId: "bot",
      }),
      resolveInvocation: async () => ({
        context,
        confirmUsage: async () => {},
        markUnknown: async () => {
          unknown++;
          throw new Error("settlement failed");
        },
      }),
      createPlanModel: (
        _c: unknown,
        _b: string,
        _t: string,
        signal: AbortSignal,
      ) => {
        captured = signal;
        return {
          doGenerate: async () => {
            await new Promise<void>((_r, reject) => {
              if (signal.aborted) reject(signal.reason);
              else
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
            });
            return { content: [], finishReason: "stop", usage: {} };
          },
        };
      },
    }) as never,
  );
  const pending = g.handle(
    req({ messages: [{ role: "user", content: "hi" }] }),
  );
  await clock.waitForCount(1);
  clock.advanceBy(5);
  expect((await pending).status).toBe(502);
  expect(captured?.aborted).toBe(true);
  expect(unknown).toBe(1);
});

test("HTTP credential and Anthropic mapping errors clear the request timer", async () => {
  const missingKeyClock = manualTimer();
  const missingKey = createModelGateway(
    deps({
      timer: missingKeyClock.timer,
      resolveApiKey: async () => null,
    }) as never,
  );
  expect(
    (
      await missingKey.handle(
        req({ messages: [{ role: "user", content: "hi" }] }),
      )
    ).status,
  ).toBe(503);
  expect(missingKeyClock.timer.activeCount()).toBe(0);

  const mappingClock = manualTimer();
  const invalidMapping = createModelGateway(
    deps({
      timer: mappingClock.timer,
      selectModel: async () => ({
        model: { provider: "anthropic", defaultModel: "claude-fixed" },
        credentialSecretRef: "credential-1",
      }),
    }) as never,
  );
  expect(
    (
      await invalidMapping.handle(
        req({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: "https://example.com/image.jpg",
                },
              ],
            },
          ],
        }),
      )
    ).status,
  ).toBe(400);
  expect(mappingClock.timer.activeCount()).toBe(0);
});

test("invalid credential header returns safe error without timer or dispatch", async () => {
  const clock = manualTimer();
  let fetchCalls = 0;
  const gateway = createModelGateway(
    deps({
      timer: clock.timer,
      resolveApiKey: async () => "synthetic\nsecret",
      fetch: (async () => {
        fetchCalls++;
        return Response.json({});
      }) as typeof fetch,
    }) as never,
  );

  const response = await gateway.handle(
    req({ messages: [{ role: "user", content: "hi" }] }),
  );

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: { code: "MODEL_CREDENTIAL_UNAVAILABLE" },
  });
  expect(clock.timer.activeCount()).toBe(0);
  expect(fetchCalls).toBe(0);
});

test("PlanModel request deadline resolves when doStream ignores abort", async () => {
  const clock = manualTimer();
  let resolveHandle!: (handle: unknown) => void;
  let cancelled = 0;
  let unknown = 0;
  let resolveLateCancel!: () => void;
  const lateCancel = new Promise<void>((resolve) => {
    resolveLateCancel = resolve;
  });
  const lateStream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
      resolveLateCancel();
    },
  });
  const gateway = createModelGateway(
    deps({
      timer: clock.timer,
      requestTimeoutMs: 5,
      streamTimeoutMs: 20,
      environment: {
        CHATGPT_AUTH_FILE: "/private/auth",
        PICKED_HARNESS_IMAGE: "agent-langgraph-agui:latest",
        PICKED_HARNESS_URL: "http://127.0.0.1:9988",
        MANAGED_AGENT_TOKEN: "harness-secret",
      },
      selectModel: async () => ({
        model: {
          provider: "openai",
          defaultModel: "gpt-fixed",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("http://127.0.0.1:9988"),
            token: "harness-secret",
          },
        },
        credentialSecretRef: "",
        planBotId: "bot",
      }),
      resolveInvocation: async () => ({
        context,
        confirmUsage: async () => {},
        markUnknown: async () => {
          unknown++;
        },
      }),
      createPlanModel: () => ({
        doStream: () =>
          new Promise((resolve) => {
            resolveHandle = resolve;
          }),
      }),
    }) as never,
  );

  const pending = gateway.handle(
    req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  );
  await clock.waitForCount(2);
  clock.advanceBy(5);
  const response = await Promise.race([
    pending,
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), 50),
    ),
  ]);
  expect(response?.status).toBe(502);
  expect(unknown).toBe(1);
  expect(clock.timer.activeCount()).toBe(0);
  resolveHandle({
    stream: lateStream,
    usage: Promise.resolve({}),
  });
  await lateCancel;
  expect(cancelled).toBe(1);
});

test("request rejects malformed nested content and non-object tool arguments before dispatch", async () => {
  let dispatches = 0;
  const g = createModelGateway(
    deps({
      fetch: (async () => {
        dispatches++;
        return Response.json({});
      }) as typeof fetch,
    }) as never,
  );
  const bad = [
    { role: "user", content: [{ type: "text" }] },
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: "data:text/plain;base64,AA==" },
        },
      ],
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "", type: "function", function: { name: "x", arguments: "{}" } },
      ],
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "id",
          type: "function",
          function: { name: "x", arguments: "[]" },
        },
      ],
    },
  ];
  for (const message of bad)
    expect((await g.handle(req({ messages: [message] }))).status).toBe(400);
  expect(dispatches).toBe(0);
});

test("PlanModel preserves validated JSON argument strings in JSON and SSE", async () => {
  for (const stream of [false, true]) {
    const g = createModelGateway(
      deps({
        environment: {
          CHATGPT_AUTH_FILE: "/private/auth",
          PICKED_HARNESS_IMAGE: "agent-langgraph-agui:latest",
          PICKED_HARNESS_URL: "http://127.0.0.1:9988",
          MANAGED_AGENT_TOKEN: "harness-secret",
        },
        selectModel: async () => ({
          model: {
            provider: "openai",
            defaultModel: "gpt-fixed",
            plan: {
              provider: "chatgpt",
              endpoint: new URL("http://127.0.0.1:9988"),
              token: "harness-secret",
            },
          },
          credentialSecretRef: "",
          planBotId: "bot",
        }),
        createPlanModel: () => ({
          doGenerate: async () => ({
            content: [
              {
                type: "tool-call",
                toolCallId: "c",
                toolName: "lookup",
                input: '{"q":1}',
              },
            ],
            finishReason: "tool-calls",
            usage: {},
          }),
          doStream: async () => ({
            stream: new ReadableStream({
              start(c) {
                c.enqueue({
                  type: "tool-call",
                  toolCallId: "c",
                  toolName: "lookup",
                  input: '{"q":1}',
                });
                c.close();
              },
            }),
          }),
        }),
      }) as never,
    );
    const response = await g.handle(
      req({
        stream,
        tools: [
          {
            type: "function",
            function: { name: "lookup", parameters: { type: "object" } },
          },
        ],
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const out = await response.text();
    expect(out).toContain('"arguments":"{\\"q\\":1}"');
    expect(out).not.toContain('"arguments":"\\"{');
  }
});

test("Anthropic partial tool JSON is redacted across events and malformed blocks fail closed", async () => {
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c","name":"lookup","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"synthe"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"tic-secret"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      frames.forEach((x) => {
        c.enqueue(new TextEncoder().encode(x));
      });
      c.close();
    },
  });
  const g = createModelGateway(
    deps({
      selectModel: async () => ({
        model: { provider: "anthropic", defaultModel: "claude-fixed" },
        credentialSecretRef: "c",
      }),
      fetch: (async () =>
        new Response(source, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const out = await (
    await g.handle(
      req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
    )
  ).text();
  expect(out).not.toContain("synthetic-secret");
  expect(out).toContain("[redacted]");
});

test("a rejected confirmation is attempted once and falls back to unknown settlement", async () => {
  let confirmed = 0,
    unknown = 0;
  const g = createModelGateway(
    deps({
      resolveInvocation: async () => ({
        context,
        confirmUsage: async () => {
          confirmed++;
          throw new Error("settlement unavailable");
        },
        markUnknown: async () => {
          unknown++;
        },
      }),
    }) as never,
  );
  expect(
    (await g.handle(req({ messages: [{ role: "user", content: "hi" }] })))
      .status,
  ).toBe(502);
  expect(confirmed).toBe(1);
  expect(unknown).toBe(1);
});

test("PlanModel receives the caller's exact output cap for JSON and streams", async () => {
  const seen: number[] = [];
  const gateway = createModelGateway(
    deps({
      environment: {
        CHATGPT_AUTH_FILE: "/private/auth",
        PICKED_HARNESS_IMAGE: "agent-langgraph-agui:latest",
        PICKED_HARNESS_URL: "http://127.0.0.1:9988",
        MANAGED_AGENT_TOKEN: "harness-secret",
      },
      selectModel: async () => ({
        model: {
          provider: "openai",
          defaultModel: "gpt-fixed",
          plan: {
            provider: "chatgpt",
            endpoint: new URL("http://127.0.0.1:9988"),
            token: "harness-secret",
          },
        },
        credentialSecretRef: "",
        planBotId: "bot",
      }),
      createPlanModel: () => ({
        doGenerate: async (options: { maxOutputTokens?: number }) => {
          seen.push(options.maxOutputTokens);
          return { content: [], finishReason: "stop", usage: {} };
        },
        doStream: async (options: { maxOutputTokens?: number }) => {
          seen.push(options.maxOutputTokens);
          return {
            stream: new ReadableStream({
              start(c) {
                c.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop" },
                  usage: {},
                });
                c.close();
              },
            }),
          };
        },
      }),
    }) as never,
  );
  for (const stream of [false, true]) {
    const response = await gateway.handle(
      req({
        stream,
        max_tokens: 17,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    if (stream) await response.body?.cancel();
    else await response.text();
  }
  expect(seen).toEqual([17, 17]);
});

test("stream total deadline cancels a pending reader and settles unknown once", async () => {
  const clock = manualTimer();
  let cancelled = 0,
    unknown = 0;
  const source = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled++;
    },
  });
  const gateway = createModelGateway(
    deps({
      requestTimeoutMs: 100,
      streamTimeoutMs: 10,
      timer: clock.timer,
      resolveInvocation: async () => ({
        context,
        confirmUsage: async () => {
          throw new Error("must not confirm");
        },
        markUnknown: async () => {
          unknown++;
        },
      }),
      fetch: (async () =>
        new Response(source, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const response = await gateway.handle(
    req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  );
  await clock.waitForCount(2);
  const body = response.text();
  clock.advanceBy(10);
  await expect(body).rejects.toThrow();
  expect(cancelled).toBe(1);
  expect(unknown).toBe(1);
});

test("caller abort after provider headers cancels the reader and settles unknown once", async () => {
  const controller = new AbortController();
  let cancelled = 0,
    unknown = 0;
  const source = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled++;
    },
  });
  const gateway = createModelGateway(
    deps({
      requestTimeoutMs: 1000,
      streamTimeoutMs: 1000,
      resolveInvocation: async () => ({
        context,
        confirmUsage: async () => {},
        markUnknown: async () => {
          unknown++;
        },
      }),
      fetch: (async () =>
        new Response(source, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const response = await gateway.handle(
    req(
      { stream: true, messages: [{ role: "user", content: "hi" }] },
      controller.signal,
    ),
  );
  const reading = response.text();
  controller.abort();
  await expect(reading).rejects.toThrow();
  expect(cancelled).toBe(1);
  expect(unknown).toBe(1);
});

test("request header deadline ends after headers while a healthy stream completes", async () => {
  const clock = manualTimer();
  let confirmed = 0;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const frame =
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
    "data: [DONE]\n\n";
  const source = new ReadableStream<Uint8Array>({
    async start(controller) {
      await delayed;
      controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
  const gateway = createModelGateway(
    deps({
      requestTimeoutMs: 5,
      streamTimeoutMs: 100,
      timer: clock.timer,
      resolveInvocation: async () => ({
        context,
        confirmUsage: async () => {
          confirmed++;
        },
        markUnknown: async () => {},
      }),
      fetch: (async () =>
        new Response(source, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const response = await gateway.handle(
    req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  );
  await clock.waitForCount(2);
  expect(response.status).toBe(200);
  const body = response.text();
  clock.advanceBy(5); // the header timer was cleared when the response arrived
  release();
  expect(await body).toContain("[DONE]");
  expect(confirmed).toBe(1);
});

test("malformed or credential-bearing Anthropic runtime types cancel and never confirm", async () => {
  for (const type of [7, "synthetic-secret-message_start"]) {
    let cancelled = 0,
      unknown = 0,
      confirmed = 0;
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1}}}\n\n',
      `event: message_delta\ndata: ${JSON.stringify({ type, delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
    ];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        frames.forEach((frame) => {
          controller.enqueue(new TextEncoder().encode(frame));
        });
      },
      cancel() {
        cancelled++;
      },
    });
    const gateway = createModelGateway(
      deps({
        selectModel: async () => ({
          model: { provider: "anthropic", defaultModel: "claude-fixed" },
          credentialSecretRef: "c",
        }),
        resolveInvocation: async () => ({
          context,
          confirmUsage: async () => {
            confirmed++;
          },
          markUnknown: async () => {
            unknown++;
          },
        }),
        fetch: (async () =>
          new Response(source, {
            headers: { "content-type": "text/event-stream" },
          })) as typeof fetch,
      }) as never,
    );
    const response = await gateway.handle(
      req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
    );
    await expect(response.text()).rejects.toThrow();
    expect(cancelled).toBe(1);
    expect(unknown).toBe(1);
    expect(confirmed).toBe(0);
  }
});

test("OpenAI SSE validates optional top-level type before provider normalization", async () => {
  for (const type of [7, "synthetic-secret-invalid"]) {
    let cancelled = 0,
      unknown = 0,
      confirmed = 0;
    let resolveCancelled!: () => void;
    const cancelledPromise = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });
    const clock = manualTimer();
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ type, choices: [{ delta: { content: "hi" }, finish_reason: null }] })}\n\n`,
          ),
        );
      },
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled++;
        resolveCancelled();
      },
    });
    const g = createModelGateway(
      deps({
        requestTimeoutMs: 10,
        streamTimeoutMs: 5,
        timer: clock.timer,
        resolveInvocation: async () => ({
          context,
          confirmUsage: async () => {
            confirmed++;
          },
          markUnknown: async () => {
            unknown++;
          },
        }),
        fetch: (async () =>
          new Response(source, {
            headers: { "content-type": "text/event-stream" },
          })) as typeof fetch,
      }) as never,
    );
    const response = await g.handle(
      req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
    );
    await clock.waitForCount(2);
    const body = response.text();
    await expect(body).rejects.toThrow();
    await cancelledPromise;
    expect(cancelled).toBe(1);
    expect(unknown).toBe(1);
    expect(confirmed).toBe(0);
    clock.advanceBy(5);
  }
});

test("abort after OpenAI terminal frame cancels instead of confirming usage", async () => {
  const controller = new AbortController();
  let cancelled = 0,
    unknown = 0,
    confirmed = 0,
    release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const frame =
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n' +
    "data: [DONE]\n\n";
  let reads = 0,
    nextRead!: () => void;
  const readingNext = new Promise<void>((resolve) => {
    nextRead = resolve;
  });
  const source = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (reads++ === 0) c.enqueue(new TextEncoder().encode(frame));
      else {
        nextRead();
        await held;
      }
    },
    cancel() {
      cancelled++;
    },
  });
  const g = createModelGateway(
    deps({
      resolveInvocation: async () => ({
        context,
        confirmUsage: async () => {
          confirmed++;
        },
        markUnknown: async () => {
          unknown++;
        },
      }),
      fetch: (async () =>
        new Response(source, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const response = await g.handle(
    req(
      { stream: true, messages: [{ role: "user", content: "hi" }] },
      controller.signal,
    ),
  );
  const body = response.text();
  await readingNext;
  controller.abort();
  release();
  await expect(body).rejects.toThrow();
  expect(cancelled).toBe(1);
  expect(unknown).toBe(1);
  expect(confirmed).toBe(0);
});

test("Anthropic maps supported image and system content blocks faithfully", async () => {
  let sent: Record<string, unknown> = {};
  const g = createModelGateway(
    deps({
      selectModel: async () => ({
        model: { provider: "anthropic", defaultModel: "claude-fixed" },
        credentialSecretRef: "c",
      }),
      fetch: (async (_u: unknown, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return Response.json({
          id: "m",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }) as typeof fetch,
    }) as never,
  );
  const r = await g.handle(
    req({
      messages: [
        { role: "system", content: [{ type: "text", text: "policy" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AA==" },
            },
          ],
        },
      ],
    }),
  );
  expect(r.status).toBe(200);
  expect(sent.system).toBe("policy");
  expect(sent.messages[0].content[1]).toEqual({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AA==" },
  });
});

test("rejects inconsistent OpenAI aggregate usage in JSON and SSE", async () => {
  for (const stream of [false, true]) {
    let confirmed = 0;
    let unknown = 0;
    const payload = {
      prompt_tokens: 100,
      completion_tokens: 100,
      total_tokens: 1,
    };
    const fetch = (async () =>
      stream
        ? new Response(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: payload,
            })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        : Response.json({
            id: "x",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "answer" },
                finish_reason: "stop",
              },
            ],
            usage: payload,
          })) as typeof fetch;
    const g = createModelGateway(
      deps({
        fetch,
        resolveInvocation: async () => ({
          context,
          confirmUsage: async () => {
            confirmed++;
          },
          markUnknown: async () => {
            unknown++;
          },
        }),
      }) as never,
    );
    const response = await g.handle(
      req({ stream, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(confirmed).toBe(0);
    if (stream) await expect(response.text()).rejects.toThrow();
    else expect(response.status).toBe(502);
    expect(unknown).toBe(1);
  }
});

test("Anthropic JSON and SSE aggregate overflow leaves usage unknown", async () => {
  for (const stream of [false, true]) {
    let confirmed = 0;
    let unknown = 0;
    const usage = {
      input_tokens: Number.MAX_SAFE_INTEGER,
      output_tokens: 1,
    };
    const fetch = (async () =>
      stream
        ? new Response(
            [
              `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", usage: { input_tokens: usage.input_tokens } } })}\n\n`,
              `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.output_tokens } })}\n\n`,
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ].join(""),
            { headers: { "content-type": "text/event-stream" } },
          )
        : Response.json({
            id: "m",
            content: [{ type: "text", text: "answer" }],
            usage,
          })) as typeof fetch;
    const g = createModelGateway(
      deps({
        selectModel: async () => ({
          model: { provider: "anthropic", defaultModel: "claude-fixed" },
          credentialSecretRef: "c",
        }),
        fetch,
        resolveInvocation: async () => ({
          context,
          confirmUsage: async () => {
            confirmed++;
          },
          markUnknown: async () => {
            unknown++;
          },
        }),
      }) as never,
    );
    const response = await g.handle(
      req({ stream, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(confirmed).toBe(0);
    if (stream) {
      const output = await response.text();
      expect(output).not.toContain('"total_tokens"');
    } else expect(response.status).toBe(200);
    expect(unknown).toBe(1);
  }
});

test("OpenAI rejects post-finish deltas before a split secret can be reconstructed", async () => {
  let unknown = 0;
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      for (const frame of [
        'data: {"choices":[{"index":0,"delta":{"content":"synthe"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"tic-secret"},"finish_reason":null}]}\n\n',
        "data: [DONE]\n\n",
      ])
        c.enqueue(new TextEncoder().encode(frame));
      c.close();
    },
  });
  const g = createModelGateway(
    deps({
      resolveInvocation: async () => ({
        context,
        confirmUsage: async () => {
          throw new Error("invalid stream must not confirm");
        },
        markUnknown: async () => {
          unknown++;
        },
      }),
      fetch: (async () =>
        new Response(source, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const response = await g.handle(
    req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  );
  let output = "";
  try {
    output = await response.text();
  } catch {
    // Stream failure is expected; collect only canonical frames emitted before it.
  }
  const reconstructed = [...output.matchAll(/"content":"([^"]*)"/g)]
    .map((match) => match[1])
    .join("");
  expect(reconstructed).not.toContain("synthetic-secret");
  expect(output).not.toContain("tic-secret");
  expect(output).not.toContain("[DONE]");
  expect(unknown).toBe(1);
});

test("Anthropic message_stop with an open block fails and settles unknown once", async () => {
  let confirmed = 0;
  let unknown = 0;
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello s"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      for (const frame of frames) c.enqueue(new TextEncoder().encode(frame));
      c.close();
    },
  });
  const g = createModelGateway(
    deps({
      selectModel: async () => ({
        model: { provider: "anthropic", defaultModel: "claude-fixed" },
        credentialSecretRef: "c",
      }),
      resolveInvocation: async () => ({
        context,
        confirmUsage: async () => {
          confirmed++;
        },
        markUnknown: async () => {
          unknown++;
        },
      }),
      fetch: (async () =>
        new Response(source, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const response = await g.handle(
    req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  );
  let output = "";
  try {
    output = await response.text();
  } catch {
    // The invalid terminal frame should error the caller stream.
  }
  expect(output).not.toContain("[DONE]");
  expect(output).not.toContain('"total_tokens"');
  expect(confirmed).toBe(0);
  expect(unknown).toBe(1);
});

test("OpenAI JSON response is rebuilt from canonical fields and rejects upstream errors", async () => {
  const gateway = createModelGateway(
    deps({
      fetch: (async () =>
        Response.json({
          id: "chat-1",
          object: "chat.completion",
          created: 1,
          model: "gpt-fixed",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          "synthetic-secret": "provider extension",
        })) as typeof fetch,
    }) as never,
  );
  const response = await gateway.handle(
    req({ messages: [{ role: "user", content: "hi" }] }),
  );
  const body = await response.json();
  expect(body).toEqual({
    id: "chat-1",
    object: "chat.completion",
    created: 1,
    model: "gpt-fixed",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  expect(JSON.stringify(body)).not.toContain("synthetic-secret");

  const errorGateway = createModelGateway(
    deps({
      fetch: (async () =>
        Response.json({
          error: { message: "upstream private detail synthetic-secret" },
        })) as typeof fetch,
    }) as never,
  );
  const failed = await errorGateway.handle(
    req({ messages: [{ role: "user", content: "hi" }] }),
  );
  expect(failed.status).toBe(502);
  expect(await failed.text()).toBe(
    JSON.stringify({ error: { code: "MODEL_UPSTREAM_UNAVAILABLE" } }),
  );
});

test("OpenAI stream emits canonical fields and rejects provider error frames generically", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(
        new TextEncoder().encode(
          'data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"gpt-fixed","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}],"synthetic-secret":"private"}\n\n',
        ),
      );
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  const gateway = createModelGateway(
    deps({
      fetch: (async () =>
        new Response(source, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const response = await gateway.handle(
    req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  );
  const output = await response.text();
  expect(output).not.toContain("synthetic-secret");
  expect(output).toContain('"content":"ok"');

  const errorSource = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(
        new TextEncoder().encode(
          'data: {"error":{"message":"upstream private detail synthetic-secret"}}\n\n',
        ),
      );
      c.close();
    },
  });
  const errorGateway = createModelGateway(
    deps({
      fetch: (async () =>
        new Response(errorSource, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const failed = await errorGateway.handle(
    req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  );
  await expect(failed.text()).rejects.toThrow();
});

test("OpenAI finish event flushes incomplete redaction overlap tails without changing output", async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"hello s","tool_calls":[{"index":2,"function":{"arguments":"{\\"v\\":\\"s"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      frames.forEach((frame) => {
        c.enqueue(new TextEncoder().encode(frame));
      });
      c.close();
    },
  });
  const gateway = createModelGateway(
    deps({
      fetch: (async () =>
        new Response(source, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const output = await (
    await gateway.handle(
      req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
    )
  ).text();
  const events = output
    .split("\n\n")
    .filter((event) => event.startsWith("data: "))
    .map((event) => event.slice(6))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
  const content = events
    .flatMap((event) => event.choices ?? [])
    .map((choice) => choice.delta?.content ?? "")
    .join("");
  const argumentsText = events
    .flatMap((event) => event.choices ?? [])
    .flatMap((choice) => choice.delta?.tool_calls ?? [])
    .map((tool) => tool.function?.arguments ?? "")
    .join("");
  expect(content).toBe("hello s");
  expect(argumentsText).toBe('{"v":"s');
  expect(output).not.toContain("synthetic-secret");
});

test("OpenAI same-event finish preserves delta order before overlap tails", async () => {
  const frames = [
    'data: {"choices":[{"index":0,"delta":{"content":"hello s","tool_calls":[{"index":2,"id":"call-s","type":"function","function":{"name":"lookup-s","arguments":"{\\"v\\":\\"s"}}]},"finish_reason":"tool_calls"}] }\n\n',
    "data: [DONE]\n\n",
  ];
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      frames.forEach((frame) => {
        c.enqueue(new TextEncoder().encode(frame));
      });
      c.close();
    },
  });
  const gateway = createModelGateway(
    deps({
      fetch: (async () =>
        new Response(source, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const output = await (
    await gateway.handle(
      req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
    )
  ).text();
  const events = output
    .split("\n\n")
    .filter((event) => event.startsWith("data: "))
    .map((event) => event.slice(6))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
  const choices = events.flatMap((event) => event.choices ?? []);
  const calls = choices.flatMap((choice) => choice.delta?.tool_calls ?? []);
  expect(choices.map((choice) => choice.delta?.content ?? "").join("")).toBe(
    "hello s",
  );
  expect(calls.map((call) => call.id ?? "").join("")).toBe("call-s");
  expect(calls.map((call) => call.function?.name ?? "").join("")).toBe(
    "lookup-s",
  );
  expect(calls.map((call) => call.function?.arguments ?? "").join("")).toBe(
    '{"v":"s',
  );
  const finishIndex = choices.findIndex(
    (choice) => choice.finish_reason === "tool_calls",
  );
  const deltaIndexes = choices
    .map((choice, index) => ({ choice, index }))
    .filter(({ choice }) =>
      Object.keys(choice.delta ?? {}).some(
        (field) => field !== "role" || choice.delta.role !== undefined,
      ),
    )
    .map(({ index }) => index);
  expect(finishIndex).toBeGreaterThan(Math.max(...deltaIndexes));
  expect(output).not.toContain("synthetic-secret");
});

test("Anthropic terminal boundaries flush text and tool metadata and arguments exactly", async () => {
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello s"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-s","name":"lookup-s","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"v\\":\\"s"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      frames.forEach((frame) => {
        c.enqueue(new TextEncoder().encode(frame));
      });
      c.close();
    },
  });
  const gateway = createModelGateway(
    deps({
      selectModel: async () => ({
        model: { provider: "anthropic", defaultModel: "claude-fixed" },
        credentialSecretRef: "credential-1",
      }),
      fetch: (async () =>
        new Response(source, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const output = await (
    await gateway.handle(
      req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
    )
  ).text();
  const events = output
    .split("\n\n")
    .filter((event) => event.startsWith("data: "))
    .map((event) => event.slice(6))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
  const choices = events.flatMap((event) => event.choices ?? []);
  expect(choices.map((choice) => choice.delta?.content ?? "").join("")).toBe(
    "hello s",
  );
  const calls = choices.flatMap((choice) => choice.delta?.tool_calls ?? []);
  expect(calls.map((call) => call.id ?? "").join("")).toBe("call-s");
  expect(calls.map((call) => call.function?.name ?? "").join("")).toBe(
    "lookup-s",
  );
  expect(calls.map((call) => call.function?.arguments ?? "").join("")).toBe(
    '{"v":"s',
  );
  expect(output).not.toContain("synthetic-secret");
});

test("provider terminal markers fail closed when the stream has trailing bytes", async () => {
  const consume = async (response: Response) => {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing response body");
    const decoder = new TextDecoder();
    let output = "";
    let failure: string | null = null;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        output += decoder.decode(next.value, { stream: true });
      }
      output += decoder.decode();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    return { output, failure };
  };
  const cases = [
    {
      provider: "openai" as const,
      trailing: 'data: {"choices":[] }\n\n',
      terminal: [
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ],
    },
    {
      provider: "openai" as const,
      trailing: 'data: {"choices":',
      terminal: [
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ],
    },
    {
      provider: "anthropic" as const,
      trailing:
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
      terminal: [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ],
    },
    {
      provider: "anthropic" as const,
      trailing: 'event: message_delta\ndata: {"type":"message_delta"}',
      terminal: [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ],
    },
  ];
  const results: Array<{
    output: string;
    failure: string | null;
    confirmed: number;
    unknown: number;
  }> = [];

  for (const scenario of cases) {
    let confirmed = 0;
    let unknown = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of [...scenario.terminal, scenario.trailing])
          controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      },
    });
    const gateway = createModelGateway(
      deps({
        selectModel: async () => ({
          model:
            scenario.provider === "openai"
              ? { provider: "openai", defaultModel: "gpt-fixed" }
              : { provider: "anthropic", defaultModel: "claude-fixed" },
          credentialSecretRef: "credential-1",
        }),
        resolveInvocation: async () => ({
          context,
          confirmUsage: async () => {
            confirmed++;
          },
          markUnknown: async () => {
            unknown++;
          },
        }),
        fetch: (async () =>
          new Response(source, {
            headers: { "content-type": "text/event-stream" },
          })) as typeof fetch,
      }) as never,
    );
    const result = await consume(
      await gateway.handle(
        req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
      ),
    );
    results.push({ ...result, confirmed, unknown });
  }
  expect(results).toHaveLength(cases.length);
  for (const result of results) {
    expect(result.output).not.toContain("data: [DONE]");
    expect(result.failure).toBe("MODEL_STREAM_FAILED");
    expect(result.confirmed).toBe(0);
    expect(result.unknown).toBe(1);
  }
});

test("Anthropic message_delta cannot finish while a content block remains open", async () => {
  let confirmed = 0;
  let unknown = 0;
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello s"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames)
        controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
  const gateway = createModelGateway(
    deps({
      selectModel: async () => ({
        model: { provider: "anthropic", defaultModel: "claude-fixed" },
        credentialSecretRef: "credential-1",
      }),
      resolveInvocation: async () => ({
        context,
        confirmUsage: async () => {
          confirmed++;
        },
        markUnknown: async () => {
          unknown++;
        },
      }),
      fetch: (async () =>
        new Response(source, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    }) as never,
  );
  const response = await gateway.handle(
    req({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  );
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing response body");
  let output = "";
  let failure: string | null = null;
  try {
    const decoder = new TextDecoder();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      output += decoder.decode(next.value, { stream: true });
    }
    output += decoder.decode();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  expect(output).not.toContain('"finish_reason":"stop"');
  expect(output).not.toContain("data: [DONE]");
  expect(failure).toBe("MODEL_STREAM_FAILED");
  expect(confirmed).toBe(0);
  expect(unknown).toBe(1);
});
