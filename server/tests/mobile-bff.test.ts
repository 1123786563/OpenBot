import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AgentProfile } from "../src/agents/profile-types";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import type { AgentChannel, ChannelStore } from "../src/channels/routes";
import {
  OpenMuseConnectionRefusedError,
  OpenMuseOwnerDisabledError,
} from "../src/openmuse-connectors/google-oauth";
import {
  OpenMuseFileQuotaError,
  OpenMuseOwnerDisabledError as FilesOwnerDisabledError,
} from "../src/openmuse-files/store";
import { OpenMuseMailVendorError } from "../src/openmuse-mail/client";
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
  async list(_actor, query) {
    return query?.archived
      ? { channels: [], nextCursor: null }
      : {
          channels: [
            channel({ lastMessageAt: new Date("2026-10-11T00:00:00Z") }),
          ],
          nextCursor: null,
        };
  },
} as unknown as ChannelStore;

function appFor(
  overrides: Partial<Parameters<typeof createMobileBffRoutes>[0]> = {},
) {
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

  test("carries archivedAt and lists the archived partition after the active one", async () => {
    // Both partitions are read for the caller's own actor: the archived page
    // is as much this person's roster as the active one, never anybody else's.
    const actors: unknown[] = [];
    const store = {
      async list(receivedActor: unknown, query?: { archived?: boolean }) {
        actors.push([receivedActor, query?.archived ?? false]);
        return query?.archived
          ? {
              channels: [
                channel({
                  id: "channel-arch",
                  archivedAt: new Date("2026-10-12T00:00:00Z"),
                }),
              ],
              nextCursor: null,
            }
          : { channels: [channel()], nextCursor: null };
      },
    } as unknown as ChannelStore;
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createMobileBffRoutes({
        requireUser,
        workspace: createMobileBffWorkspace({ channelStore: store }),
      }),
    );

    const response = await app.request("/workspace");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.channels).toEqual([
      {
        id: "channel-1",
        name: "Knowledge",
        agentIds: ["bot-1"],
        threadId: "thread-1",
        lastMessageAt: null,
        archivedAt: null,
      },
      {
        id: "channel-arch",
        name: "Knowledge",
        agentIds: ["bot-1"],
        threadId: "thread-1",
        lastMessageAt: null,
        archivedAt: "2026-10-12T00:00:00.000Z",
      },
    ]);
    expect(actors).toEqual([
      [actor, false],
      [actor, true],
    ]);
  });

  test("follows the archived partition's cursor instead of dropping it", async () => {
    // Past the first 100 archived conversations the store answers a page
    // plus nextCursor: the cold start must walk the pages, or the filing
    // cabinet's tail is permanently unreachable from this endpoint.
    const archivedQueries: Array<{ cursor?: string }> = [];
    const store = {
      async list(
        _actor: unknown,
        query?: { archived?: boolean; cursor?: string },
      ) {
        if (!query?.archived) {
          return { channels: [channel()], nextCursor: null };
        }
        if (query.cursor !== undefined)
          archivedQueries.push({ cursor: query.cursor });
        return query.cursor === "page-2"
          ? {
              channels: [
                channel({
                  id: "channel-arch-2",
                  archivedAt: new Date("2026-10-13T00:00:00Z"),
                }),
              ],
              nextCursor: null,
            }
          : {
              channels: [
                channel({
                  id: "channel-arch-1",
                  archivedAt: new Date("2026-10-12T00:00:00Z"),
                }),
              ],
              nextCursor: "page-2",
            };
      },
    } as unknown as ChannelStore;
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createMobileBffRoutes({
        requireUser,
        workspace: createMobileBffWorkspace({ channelStore: store }),
      }),
    );

    const response = await app.request("/workspace");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.channels.map((c: { id: string }) => c.id)).toEqual([
      "channel-1",
      "channel-arch-1",
      "channel-arch-2",
    ]);
    // The second page was fetched with the first page's cursor.
    expect(archivedQueries).toEqual([{ cursor: "page-2" }]);
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
        } as unknown as Parameters<
          typeof createMobileBffActivity
        >[0]["approvals"],
        routines: {
          listFor: async () => [
            { id: "r-1", enabled: true },
            { id: "r-2", enabled: false },
          ],
        } as unknown as Parameters<
          typeof createMobileBffActivity
        >[0]["routines"],
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

/**
 * Round 3: `route()` merges a sub-app's handlers, not its application-level `onError` — the
 * files sub-app's deliberate error-to-status contract (409 connection_required, 403 owner
 * disabled, 502 vendor) died at this mount and everything landed in this file's 503.
 */
describe("sub-app error contracts through the BFF mount", () => {
  function bffWithThrowingRoute(makeError: () => Error) {
    const files = new Hono<{ Variables: AppVariables }>();
    files.get("/boom", () => {
      throw makeError();
    });
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createMobileBffRoutes({
        requireUser,
        workspace: createMobileBffWorkspace({}),
        openMuseFiles: files,
      }),
    );
    return app;
  }

  test("a refused connection still answers 409 with code connection_required", async () => {
    const app = bffWithThrowingRoute(
      () => new OpenMuseConnectionRefusedError("Connect Gmail first."),
    );
    const response = await app.request("/openmuse-files/boom");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Connect Gmail first.",
      code: "connection_required",
    });
  });

  test("a disabled owner still answers 403", async () => {
    const app = bffWithThrowingRoute(
      () => new OpenMuseOwnerDisabledError("user-1"),
    );
    const response = await app.request("/openmuse-files/boom");
    expect(response.status).toBe(403);
  });

  test("the files store's own disabled-owner class — a different class with the same name — still answers 403", async () => {
    // The mounted sub-apps throw their OWN OpenMuseOwnerDisabledError, not the connectors'
    // one the BFF imports: an instanceof against either class alone is a dead branch for the
    // other, so the mount matches the name.
    const app = bffWithThrowingRoute(() => new FilesOwnerDisabledError());
    const response = await app.request("/openmuse-files/boom");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "This owner's files are unavailable.",
    });
  });

  test("a vendor failure still answers 502", async () => {
    const app = bffWithThrowingRoute(
      () => new OpenMuseMailVendorError("Gmail exploded."),
    );
    const response = await app.request("/openmuse-files/boom");
    expect(response.status).toBe(502);
  });

  test("a files quota refusal still answers 413 with its stable code, not the mount's 503", async () => {
    const app = bffWithThrowingRoute(() => new OpenMuseFileQuotaError(1024));
    const response = await app.request("/openmuse-files/boom");
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error:
        "That upload would pass this owner's 1024-byte Files quota. Delete some files first.",
      code: "openmuse_file_quota_exceeded",
    });
  });
});

describe("the archived partition's cap (round 3)", () => {
  test("past the five-page cap the leftover cursor is handed back, not dropped", async () => {
    // Every page answers another cursor: the walk stops at the cap with a
    // sixth page still unread, and the response must say where it starts.
    const store = {
      async list(
        _actor: unknown,
        query?: { archived?: boolean; cursor?: string },
      ) {
        if (!query?.archived) {
          return { channels: [channel()], nextCursor: null };
        }
        const page = query.cursor ? Number(query.cursor.slice(5)) : 1;
        return {
          channels: [
            channel({
              id: `channel-arch-${page}`,
              archivedAt: new Date("2026-10-12T00:00:00Z"),
            }),
          ],
          nextCursor: `page-${page + 1}`,
        };
      },
    } as unknown as ChannelStore;
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createMobileBffRoutes({
        requireUser,
        workspace: createMobileBffWorkspace({ channelStore: store }),
      }),
    );

    const response = await app.request("/workspace");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.channels).toHaveLength(6); // active + five archived pages
    expect(body.archivedNextCursor).toBe("page-6");
  });

  test("a fully walked partition reports no leftover cursor", async () => {
    const app = appFor();
    const response = await app.request("/workspace");
    expect(response.status).toBe(200);
    expect((await response.json()).archivedNextCursor).toBe(null);
  });
});
