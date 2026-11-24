import { expect, test } from "bun:test";
import { createBifrostCreditExecutor } from "../src/billing/test-credit-bifrost";

test("the pilot executor makes one bounded provider request and returns metered usage", async () => {
  const requests: unknown[] = [];
  let response: unknown = {
    choices: [{ message: { content: "fixture answer" } }],
    usage: { prompt_tokens: 2, completion_tokens: 1 },
  };
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        body: await request.json(),
      });
      return Response.json(response);
    },
  });
  try {
    const execute = createBifrostCreditExecutor({
      endpoint: new URL("/v1/chat/completions", gateway.url),
      gatewayRevision: "gateway-a",
      meteringRevision: "meter-a",
      countInputTokens: async () => 2,
    });
    const input = {
      route: {
        gatewayRevision: "gateway-a",
        meteringRevision: "meter-a",
        provider: "openai",
        model: "fixture",
        maxInputTokens: 2,
        maxOutputTokens: 3,
      },
      messages: [{ role: "user", content: "hello" }] as const,
    };
    await expect(execute(input)).resolves.toEqual({
      text: "fixture answer",
      usage: { inputTokens: 2, outputTokens: 1 },
    });
    await expect(
      execute({ ...input, route: { ...input.route, maxInputTokens: 1 } }),
    ).rejects.toThrow();
    await expect(
      execute({
        ...input,
        route: { ...input.route, gatewayRevision: "other" },
      }),
    ).rejects.toThrow();
    expect(requests).toEqual([
      {
        path: "/v1/chat/completions",
        body: {
          model: "openai/fixture",
          messages: input.messages,
          max_completion_tokens: 3,
          stream: false,
        },
      },
    ]);
    response = {
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 0 },
    };
    await expect(execute(input)).resolves.toEqual({
      outcome: "partial",
      usage: { inputTokens: 2, outputTokens: 0 },
    });
    response = {
      choices: [{ message: { content: "fixture answer" } }],
      usage: { prompt_tokens: 2, completion_tokens: 12 },
    };
    await expect(execute(input)).resolves.toEqual({
      text: "fixture answer",
      usage: { inputTokens: 2, outputTokens: 12 },
    });
  } finally {
    gateway.stop(true);
  }
});
