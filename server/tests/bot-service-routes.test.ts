import type { MiddlewareHandler } from "hono";
import { expect, test } from "../../tests/support/e2e-compat";
import type { AuditEventInput } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import {
  botServiceRoutes,
  createBotServiceAuthenticator,
  createFailureLimiter,
} from "../src/bot-services/auth";
import { botServiceAdminRoutes } from "../src/bot-services/routes";
import type {
  BotServiceRecord,
  BotServiceStore,
} from "../src/bot-services/store";
import {
  BotServiceAuthFailureError,
  BotServiceConflictError,
  BotServiceInputError,
  BotServiceNotFoundError,
} from "../src/bot-services/types";

/**
 * Bifrost #234 (04.1): the public boundary of the admin registration surface.
 *
 * Only an administrator may register, edit, disable or enable a bot service, a duplicate botId is
 * a refusal and not a replacement, and nothing that leaves these routes is a credential —
 * registration produces an identity and a declaration, never a grant, a key or a credit.
 */

const ADMIN: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "admin-person",
    email: "admin@example.com",
    role: "admin",
  } as never);
  await next();
};

const USER: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "plain-person",
    email: "user@example.com",
    role: "user",
  } as never);
  await next();
};

const NOBODY: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
  context.json({ error: "Authentication required." }, 401);

const record: BotServiceRecord = {
  botId: "com.example.bot",
  displayName: "Example Bot",
  kind: "external",
  capabilities: ["chat", "image"],
  status: "active",
  createdAt: new Date("2026-10-15T00:00:00Z"),
  updatedAt: new Date("2026-10-15T00:00:00Z"),
};

function fixture(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
  const events: AuditEventInput[] = [];
  const registered: unknown[] = [];
  const updated: { botId: string; patch: unknown }[] = [];
  const statusCalls: { botId: string; status: string }[] = [];
  const store: BotServiceStore = {
    register: async (input) => {
      registered.push(input);
      return { ...record, ...(input as object) } as BotServiceRecord;
    },
    update: async (botId, patch) => {
      updated.push({ botId, patch });
      return { ...record, botId };
    },
    disable: async (botId) => {
      statusCalls.push({ botId, status: "disabled" });
      return { ...record, botId, status: "disabled" };
    },
    enable: async (botId) => {
      statusCalls.push({ botId, status: "active" });
      return { ...record, botId, status: "active" };
    },
    getBotService: async (botId) => (botId === record.botId ? record : null),
    listBotServices: async () => [record],
  };
  const app = botServiceAdminRoutes(requireUser, store, {
    insert: async (event) => void events.push(event),
  });
  return { app, events, registered, updated, statusCalls, store };
}

const refusingStore: BotServiceStore = {
  register: async () => {
    throw new BotServiceConflictError();
  },
  update: async () => {
    throw new BotServiceNotFoundError();
  },
  disable: async () => {
    throw new BotServiceNotFoundError();
  },
  enable: async () => {
    throw new BotServiceNotFoundError();
  },
  getBotService: async () => null,
  listBotServices: async () => [],
};

const registration = {
  botId: "com.example.bot",
  displayName: "Example Bot",
  kind: "external",
  capabilities: ["chat", "image"],
};

test("credential infrastructure errors are not returned as invalid credentials", async () => {
  const app = botServiceRoutes({
    authenticate: async () => {
      throw new Error("credential store unavailable");
    },
  });
  const response = await app.request("/", {
    headers: { authorization: "Bearer obot_bsvc_com.example.bot~secret" },
  });

  expect(response.status).toBe(500);
});

test("credential failures still return the uniform authentication refusal", async () => {
  const app = botServiceRoutes({
    authenticate: async () => {
      throw new BotServiceAuthFailureError();
    },
  });
  const response = await app.request("/", {
    headers: { authorization: "Bearer obot_bsvc_com.example.bot~secret" },
  });

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    error: "Bot service authentication failed.",
    code: "bot_service_auth_failed",
  });
});

test("rate-limit responses reflect a configured authentication window", async () => {
  const authenticate = createBotServiceAuthenticator({
    encryptionKey: "unused",
    credentialStore: {} as never,
    botServices: { getBotService: async () => null },
    limiter: createFailureLimiter({
      windowMs: 5_000,
      maxFailures: 1,
      now: () => 0,
    }),
  });
  const app = botServiceRoutes({ authenticate });
  const headers = {
    authorization: "Bearer invalid",
  };

  expect((await app.request("/", { headers })).status).toBe(401);
  const rateLimited = await app.request("/", { headers });

  expect(rateLimited.status).toBe(429);
  expect(rateLimited.headers.get("retry-after")).toBe("5");
});

test("an administrator registers a bot and the trail names it", async () => {
  const f = fixture(ADMIN);
  const response = await f.app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registration),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { botService: BotServiceRecord };
  expect(body.botService.botId).toBe("com.example.bot");
  expect(body.botService.status).toBe("active");
  expect(f.registered).toEqual([registration]);
  expect(f.events).toHaveLength(1);
  expect(f.events[0]).toMatchObject({
    eventType: "bot_service.registered",
    targetType: "bot_service",
    targetId: "com.example.bot",
    actorUserId: "admin-person",
  });
  expect(f.events[0]?.payload).toMatchObject({
    kind: "external",
    capabilities: ["chat", "image"],
  });
  // Registration carries no credential material in either direction.
  expect(JSON.stringify(body)).not.toMatch(/credential|secret|token|key/i);
});

test("a non-administrator cannot register, edit, disable or even list", async () => {
  const f = fixture(USER);
  expect((await f.app.request("/", { method: "GET" })).status).toBe(403);
  const posted = await f.app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registration),
  });
  expect(posted.status).toBe(403);
  expect(
    (
      await f.app.request("/com.example.bot", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Renamed" }),
      })
    ).status,
  ).toBe(403);
  expect(
    (await f.app.request("/com.example.bot/disable", { method: "POST" }))
      .status,
  ).toBe(403);
  expect(
    (await f.app.request("/com.example.bot/enable", { method: "POST" })).status,
  ).toBe(403);
  expect(f.registered).toEqual([]);
  expect(f.statusCalls).toEqual([]);
  expect(f.events).toEqual([]);
});

test("an unauthenticated caller is refused before anything runs", async () => {
  const f = fixture(NOBODY);
  const response = await f.app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registration),
  });
  expect(response.status).toBe(401);
  expect(f.registered).toEqual([]);
});

test("a duplicate botId is a tagged 409, not a replacement", async () => {
  const app = botServiceAdminRoutes(ADMIN, refusingStore, undefined);
  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registration),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: "That botId is already registered and cannot be reused.",
    code: "bot_service_conflict",
  });
});

test("malformed registrations answer 400 naming the problem", async () => {
  const f = fixture(ADMIN);
  const bodies = [
    JSON.stringify({
      displayName: "x",
      kind: "external",
      capabilities: ["chat"],
    }),
    JSON.stringify({ ...registration, botId: " spaced " }),
    JSON.stringify({ ...registration, kind: "mystery" }),
    JSON.stringify({ ...registration, capabilities: [] }),
    JSON.stringify({ ...registration, capabilities: ["telepathy"] }),
    JSON.stringify({ ...registration, extra: true }),
    "not json",
  ];
  for (const body of bodies) {
    const response = await f.app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(400);
  }
  expect(f.registered).toEqual([]);
  expect(f.events).toEqual([]);
});

test("editing renames and redeclares, with the changes on the trail", async () => {
  const f = fixture(ADMIN);
  const response = await f.app.request("/com.example.bot", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Renamed", capabilities: ["chat"] }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { botService: BotServiceRecord };
  expect(body.botService.displayName).toBe("Example Bot"); // the fixture's record
  expect(f.updated).toEqual([
    {
      botId: "com.example.bot",
      patch: { displayName: "Renamed", capabilities: ["chat"] },
    },
  ]);
  expect(f.events).toHaveLength(1);
  expect(f.events[0]).toMatchObject({
    eventType: "bot_service.updated",
    targetId: "com.example.bot",
    actorUserId: "admin-person",
  });
  expect(f.events[0]?.payload).toMatchObject({
    changed: ["displayName", "capabilities"],
  });
});

test("a PATCH that changes nothing is refused", async () => {
  const f = fixture(ADMIN);
  const response = await f.app.request("/com.example.bot", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(400);
  expect(f.updated).toEqual([]);
});

test("disable and enable write their own rows", async () => {
  const f = fixture(ADMIN);
  expect(
    (await f.app.request("/com.example.bot/disable", { method: "POST" }))
      .status,
  ).toBe(200);
  expect(
    (await f.app.request("/com.example.bot/enable", { method: "POST" })).status,
  ).toBe(200);
  expect(f.statusCalls).toEqual([
    { botId: "com.example.bot", status: "disabled" },
    { botId: "com.example.bot", status: "active" },
  ]);
  expect(f.events.map((event) => event.eventType)).toEqual([
    "bot_service.disabled",
    "bot_service.enabled",
  ]);
});

test("unknown botIds answer 404, on every action", async () => {
  const app = botServiceAdminRoutes(ADMIN, refusingStore, undefined);
  const patch = await app.request("/com.example.bot", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Renamed" }),
  });
  expect(patch.status).toBe(404);
  expect(
    (await app.request("/com.example.bot/disable", { method: "POST" })).status,
  ).toBe(404);
  expect(
    (await app.request("/com.example.bot/enable", { method: "POST" })).status,
  ).toBe(404);
});

test("the store's own refusals still answer as the store means them", async () => {
  const store: BotServiceStore = {
    ...refusingStore,
    register: async () => {
      throw new BotServiceInputError();
    },
  };
  const app = botServiceAdminRoutes(ADMIN, store, undefined);
  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registration),
  });
  expect(response.status).toBe(400);
});

test("the list names every registered bot and nothing else", async () => {
  const f = fixture(ADMIN);
  const response = await f.app.request("/", { method: "GET" });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    botServices: BotServiceRecord[];
  };
  expect(body.botServices).toEqual([
    {
      botId: "com.example.bot",
      displayName: "Example Bot",
      kind: "external",
      capabilities: ["chat", "image"],
      status: "active",
      createdAt: "2026-10-15T00:00:00.000Z",
      updatedAt: "2026-10-15T00:00:00.000Z",
    },
  ]);
  expect(JSON.stringify(body)).not.toMatch(/credential|secret|token|key/i);
});

test("responses are not cached", async () => {
  const f = fixture(ADMIN);
  const response = await f.app.request("/", { method: "GET" });
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("without a store every route is a tagged 503", async () => {
  const app = botServiceAdminRoutes(ADMIN, undefined, undefined);
  const response = await app.request("/", { method: "GET" });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "The bot service registry is not available.",
    code: "bot_service_unavailable",
  });
  expect((await app.request("/x/disable", { method: "POST" })).status).toBe(
    503,
  );
});
