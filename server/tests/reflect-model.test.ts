import { expect, test } from "bun:test";
import { createManagedModel } from "../src/managed-model-trial";
import { createReflectModelGateway } from "../src/memory/reflect-model";

test("a Hindsight model callback uses authenticated run scope and Test Credit admission", async () => {
  const scope = {
    personId: "person",
    botId: "bot",
    conversationId: "thread",
    runId: "run",
  };
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const priceVersion = "a6000000-0000-4000-8000-000000000001";
  let denied = false;
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/quote")
        return Response.json({ route: "approved-v1", priceVersion });
      const body = await request.json();
      calls.push({ path, body });
      switch (path) {
        case "/v1/reserve":
          return Response.json(
            denied
              ? { state: "denied", reason: "insufficient_credits" }
              : { state: "reserved", permit: "fixture-permit" },
          );
        case "/v1/dispatch":
          return Response.json({
            state: "completed",
            text: '{"answer":"amber"}',
          });
        default:
          return Response.json({ state: "settled" });
      }
    },
  });
  try {
    const gateway = createReflectModelGateway({
      model: createManagedModel({
        url: control.url,
        credentials: new Map([["person", "control-fixture"]]),
      }),
      route: "approved-v1",
      token: "hindsight-fixture",
    });
    const callback = (
      query: string,
      token = "hindsight-fixture",
      structured = true,
    ) =>
      gateway.complete(
        new Request(
          "http://openbot.test/internal/hindsight/v1/chat/completions",
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({
              model: "ignored-provider-model",
              messages: [
                { role: "system", content: "Answer using retrieved evidence." },
                { role: "user", content: query },
              ],
              response_format: structured
                ? {
                    type: "json_schema",
                    json_schema: { schema: { type: "object" } },
                  }
                : undefined,
            }),
          },
        ),
      );
    let expiredQuery = "";
    const query = "Which lanterns are available?";
    const run = { scope, query, canDispatch: async () => true };
    expect(
      await gateway.reflect({
        ...run,
        request: async (ticket) => {
          expiredQuery = ticket;
          expect((await callback(ticket, "wrong")).status).toBe(401);
          const replies = await Promise.all([
            callback(ticket),
            callback(ticket),
          ]);
          expect(replies.map((response) => response.status)).toEqual([
            200, 200,
          ]);
          return replies[0]?.json();
        },
      }),
    ).toMatchObject({
      choices: [{ message: { content: '{"answer":"amber"}' } }],
    });
    expect((await callback(expiredQuery)).status).toBe(403);
    expect(calls.map(({ path }) => path)).toEqual([
      "/v1/reserve",
      "/v1/dispatch",
      "/v1/reconcile",
    ]);
    const operationId = calls[0]?.body.operationId;
    expect(calls[0]?.body).toEqual({
      operationId: expect.any(String),
      applicationId: "openbot",
      creditType: "test",
      route: "approved-v1",
      priceVersion,
      resumable: false,
    });
    expect(calls[1]?.body).toMatchObject({
      operationId,
      permit: "fixture-permit",
      messages: expect.arrayContaining([{ role: "user", content: query }]),
    });
    expect(JSON.stringify(calls)).not.toContain("OpenBot Reflect");
    expect(calls[2]?.body).toEqual({ operationId });
    calls.length = 0;

    const finalPrompt = (question: string) =>
      `## Retrieved Data\nAmber lanterns are available.\n\n## Question\n${question}\n\n## Instructions\nSynthesize the answer.`;
    const finalCallback = (prompt: string) =>
      callback(prompt, "hindsight-fixture", false);
    expect(
      await gateway.reflect({
        ...run,
        request: async (ticket) => {
          expect((await finalCallback(ticket)).status).toBe(403);
          expect(
            (await finalCallback(finalPrompt(`${ticket}altered`))).status,
          ).toBe(403);
          return (await finalCallback(finalPrompt(ticket))).json();
        },
      }),
    ).toMatchObject({
      choices: [{ message: { content: '{"answer":"amber"}' } }],
    });
    expect(calls.map(({ path }) => path)).toEqual([
      "/v1/reserve",
      "/v1/dispatch",
      "/v1/reconcile",
    ]);
    expect(calls[1]?.body.messages).toEqual([
      { role: "system", content: "Answer using retrieved evidence." },
      { role: "user", content: finalPrompt(query) },
    ]);
    calls.length = 0;

    const fallback = (ticket: string) =>
      callback(ticket).then(async (response) => {
        expect(response.status).toBe(503);
        return { unverifiedText: "must be discarded" };
      });
    denied = true;
    expect(await gateway.reflect({ ...run, request: fallback })).toBeNull();
    expect(calls.map(({ path }) => path)).toEqual(["/v1/reserve"]);
    denied = false;
    calls.length = 0;
    expect(
      await gateway.reflect({
        ...run,
        canDispatch: async () => false,
        request: fallback,
      }),
    ).toBeNull();
    expect(calls.map(({ path }) => path)).toEqual([
      "/v1/reserve",
      "/v1/reconcile",
    ]);
    calls.length = 0;
    let authorized = true;
    expect(
      await gateway.reflect({
        ...run,
        canDispatch: async () => authorized,
        request: async (ticket) => {
          expect((await callback(ticket)).status).toBe(200);
          authorized = false;
          const retry = await callback(ticket);
          expect(retry.status).toBe(403);
          expect(await retry.text()).not.toContain("amber");
          return { unverifiedText: "must be discarded" };
        },
      }),
    ).toBeNull();
    expect(calls.map(({ path }) => path)).toEqual([
      "/v1/reserve",
      "/v1/dispatch",
      "/v1/reconcile",
    ]);
  } finally {
    control.stop(true);
  }
});
