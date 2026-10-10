import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfile } from "../src/agents/profile-types";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import type { AgentChannel, ChannelStore } from "../src/channels/routes";
import { createMobileBffActivity } from "../src/mobile-bff/activity";
import { createMobileBffRoutes } from "../src/mobile-bff/routes";
import { createMobileBffWorkspace } from "../src/mobile-bff/workspace";

const actor: AuthenticatedActor = {
  id: "user-1",
  email: "mobile@openbot.test",
  role: "user",
};

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "bot-1",
    name: "Knowledge",
    title: "Research",
    roleDescription: "Finds answers.",
    avatarSeed: "knowledge",
    visibility: "public",
    ownerUserId: null,
    systemOwned: true,
    hidden: false,
    pinned: false,
    deletedAt: null,
    ...overrides,
  };
}

function channel(overrides: Partial<AgentChannel> = {}): AgentChannel {
  return {
    id: "channel-1",
    name: "Knowledge",
    agentIds: ["bot-1"],
    threadId: "thread-1",
    active: true,
    lastMessageAt: null,
    ...overrides,
  };
}

const agentsStore: AgentProfileStore = {
  async list() {
    return [
      profile(),
      profile({ id: "bot-hidden", name: "Hidden", hidden: true }),
      profile({
        id: "bot-gone",
        name: "Gone",
        deletedAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ];
  },
  async get(_actor, id) {
    return id === "bot-1" ? profile() : null;
  },
} as unknown as AgentProfileStore;

const channelStore: ChannelStore = {
  async direct(_actor, agentId) {
    return channel({ agentIds: [agentId] });
  },
  async list() {
    return {
      channels: [channel({ lastMessageAt: new Date("2026-10-11T00:00:00Z") })],
      nextCursor: null,
    };
  },
} as unknown as ChannelStore;

function appFor(overrides: Partial<Parameters<typeof createMobileBffRoutes>[0]> = {}) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createMobileBffRoutes({
      requireUser,
      agentProfileStore: agentsStore,
      channelStore,
      workspace: createMobileBffWorkspace({
        agentProfileStore: agentsStore,
        channelStore,
      }),
      ...overrides,
    }),
  );
  return app;
}

describe("GET /workspace", () => {
  test("answers the cold-start bundle in one round trip", async () => {
    const response = await appFor().request("/workspace");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.user).toEqual({ id: "user-1", role: "user" });
    // Hidden and deleted Bots never reach the mobile roster.
    expect(body.agents).toEqual([
      {
        id: "bot-1",
        name: "Knowledge",
        title: "Research",
        avatarSeed: "knowledge",
        visibility: "public",
      },
    ]);
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0].threadId).toBe("thread-1");
    expect(body.channels[0].lastMessageAt).toBe("2026-10-11T00:00:00.000Z");
  });

  test("survives an empty deployment: no stores, empty lists", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createMobileBffRoutes({
        requireUser,
        workspace: createMobileBffWorkspace({}),
      }),
    );
    const response = await app.request("/workspace");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agents).toEqual([]);
    expect(body.channels).toEqual([]);
  });
});

describe("POST /conversations", () => {
  test("returns the OpenBotSession identifiers for an accessible Bot", async () => {
    const response = await appFor().request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-1" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      channelId: "channel-1",
      botId: "bot-1",
      threadId: "thread-1",
      mode: "single",
    });
  });

  test("refuses a Bot the caller cannot see with 404", async () => {
    const response = await appFor().request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "someone-elses" }),
    });
    expect(response.status).toBe(404);
  });

  test("refuses a malformed body with 400", async () => {
    const response = await appFor().request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bot: 1 }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Supply a valid request." });
  });
});

describe("GET /activity", () => {
  test("counts waiting approvals and routines", async () => {
    const app = appFor({
      activity: createMobileBffActivity({
        approvals: {
          inbox: async () => ({
            requests: [{ id: "a-1" }, { id: "a-2" }],
            rules: [],
            questions: [],
          }),
        } as unknown as Parameters<typeof createMobileBffActivity>[0]["approvals"],
        routines: {
          listFor: async () => [
            { id: "r-1", enabled: true },
            { id: "r-2", enabled: false },
          ],
        } as unknown as Parameters<typeof createMobileBffActivity>[0]["routines"],
      }),
    });
    const response = await app.request("/activity");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      approvals: { total: 2, items: [{ id: "a-1" }, { id: "a-2" }] },
      routines: { total: 2, enabled: 1 },
    });
  });

  test("is absent when the deployment has neither half", async () => {
    const response = await appFor().request("/activity");
    expect(response.status).toBe(404);
  });
});
