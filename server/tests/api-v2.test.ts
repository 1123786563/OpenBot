import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createApiV2Routes } from "../src/api-v2/routes";
import { createApp } from "../src/app";
import type { AppVariables } from "../src/auth/guards";
import { computerSocketPath } from "../src/computer/stream-path";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const org = "/api/v2/organizations/default";

test("the app serves native sign-in options before authentication, and lists only the caller's organization", async () => {
  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: {
        getSession: async ({ headers }) =>
          headers.has("cookie")
            ? { user: { id: "person-1", email: "person@openbot.test" } }
            : null,
      },
    },
    { rolesForUser: async () => ["user"] },
  );

  const deployment = await app.request(`${org}/deployment`);
  expect(deployment.status).toBe(200);
  expect(await deployment.json()).toMatchObject({
    authProviders: ["google"],
    api: ["v2"],
  });
  const organizations = "/api/v2/people/me/organizations";
  expect((await app.request(organizations)).status).toBe(401);
  const headers = { cookie: "session=fixture" };
  expect(
    await (await app.request(organizations, { headers })).json(),
  ).toMatchObject({
    organizations: [{ id: "default", role: "member", active: true }],
  });
  expect(
    (await app.request(`${org}/people/other/company-sign-in`, { headers }))
      .status,
  ).toBe(404);
  const foreign = await app.request(`${org}/deployment`, {
    headers: { ...headers, "OpenBot-Organization": "elsewhere" },
  });
  expect(foreign.status).toBe(404);
  expect(await foreign.json()).toMatchObject({
    code: "ORGANIZATION_NOT_FOUND",
  });
  expect((await app.request("/api/capabilities")).status).toBe(200);
});

test("v2 conversation paths map fields and retry the same native delivery", async () => {
  const app = new Hono<{ Variables: AppVariables }>();
  const deliveries = new Set<string>();
  app.get("/api/channels", (context) =>
    context.json({
      channels: [
        { id: "conversation", agentIds: ["bot"], work: [{ agentId: "bot" }] },
      ],
      nextCursor: null,
    }),
  );
  app.get("/api/channels/:id", (context) =>
    context.json({
      channel: { id: context.req.param("id"), agentIds: ["bot"] },
    }),
  );
  app.get("/api/agents/:id", (context) =>
    context.json({ agent: { id: context.req.param("id"), name: "Bot" } }),
  );
  app.get("/api/delivery/conversations/:id/history", (context) => {
    expect(context.req.query("agentId")).toBe("bot");
    return context.json({
      history: {
        messages: [{ id: "reply", role: "assistant", content: "hello" }],
      },
    });
  });
  app.post("/api/delivery/conversations/:id/messages", async (context) => {
    const input = await context.req.json();
    expect(input).toMatchObject({ agentId: "bot", text: "hello" });
    const queued = !deliveries.has(input.externalId);
    deliveries.add(input.externalId);
    return context.json({ queued }, 202);
  });
  app.route(
    "/api/v2",
    createApiV2Routes({
      dispatch: (request, env) => app.fetch(request, env),
      requireUser: async (context, next) => {
        context.set("actor", {
          id: "person",
          email: "person@example.test",
          role: "user",
        });
        await next();
      },
      deployment: {
        builtInBots: true,
        isolatedBots: false,
        botComputers: false,
      },
    }),
  );

  const list = await app.request(`${org}/conversations`);
  expect(await list.json()).toEqual({
    conversations: [
      { id: "conversation", botIds: ["bot"], work: [{ botId: "bot" }] },
    ],
    nextCursor: null,
  });
  const conversation = await app.request(`${org}/conversations/conversation`);
  expect(await conversation.json()).toEqual({
    conversation: { id: "conversation", botIds: ["bot"] },
  });
  const bot = await app.request(`${org}/bots/bot`);
  expect(await bot.json()).toEqual({ bot: { id: "bot", name: "Bot" } });
  const messages = `${org}/conversations/conversation/messages`;
  const history = await app.request(`${messages}?botId=bot`);
  expect(await history.json()).toMatchObject({
    messages: [{ id: "reply", botId: "bot", text: "hello" }],
  });
  for (const queued of [true, false]) {
    const response = await app.request(messages, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "caller-selected-id",
        botId: "bot",
        text: "hello",
      }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ queued });
  }
  expect(deliveries.size).toBe(1);
});

test("the v2 screen path uses the same Bot socket as the existing screen", () => {
  expect(computerSocketPath(`${org}/computers/a%2Fb/screen`)).toEqual(
    computerSocketPath("/api/computers/a%2Fb/stream"),
  );
  expect(
    computerSocketPath("/api/v2/organizations/other/computers/a/screen"),
  ).toBeNull();
});
