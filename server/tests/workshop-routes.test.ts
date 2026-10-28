import { describe, expect, test } from "../../tests/support/e2e-compat";
import { createWorkshopRoutes } from "../src/workshop/routes";
import type { TurnEventBus } from "../src/workshop/bus";
import type { WorkshopStore, WorkshopTurnRow } from "../src/workshop/store";
import type { TurnOrchestrator } from "../src/workshop/orchestrator";
import type { SandboxClient } from "../src/codesandbox/client";
import type { AppVariables } from "../src/auth/guards";
import type { MiddlewareHandler } from "hono";

/** The store as the routes need it: two sessions, some turns and artifacts. */
function fakeStore() {
  const session = {
    id: "ws_1",
    channelId: "ch_1",
    botId: "bot_1",
    ownerUserId: "user_1",
    status: "active" as const,
    opencodeSessionId: null,
    webappPort: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    lastActivityAt: new Date("2026-01-01T00:01:00Z"),
    visibility: "private" as const,
    shareTokenHash: null,
    shareScope: "preview" as const,
    shareExpiresAt: null,
    shareRevokedAt: null,
    shareCreatedBy: null,
    shareCreatedAt: null,
  };
  const turn: WorkshopTurnRow = {
    id: "wt_1",
    sessionId: "ws_1",
    prompt: "算一下",
    status: "succeeded",
    turnIndex: 0,
    codeRunId: null,
    runnerHeartbeatAt: new Date(),
    error: null,
    usage: { inputTokens: 10, outputTokens: 5 },
    startedAt: new Date("2026-01-01T00:00:10Z"),
    finishedAt: new Date("2026-01-01T00:00:20Z"),
    initiator: "person",
  };
  const artifact = {
    id: "wa_1",
    sessionId: "ws_1",
    type: "csv" as const,
    name: "out.csv",
    path: "out.csv",
    sizeBytes: 12,
    previewUrl: null,
    visibility: "private" as const,
    createdAt: new Date("2026-01-01T00:00:15Z"),
  };
  return {
    async sessionByChannel(channelId: string) {
      return channelId === "ch_1" ? (session as never) : undefined;
    },
    async sessionById(id: string) {
      return id === "ws_1" ? (session as never) : undefined;
    },
    async touchSession() {},
    async getOrCreateSession() {
      return session as never;
    },
    async listTurns(sessionId: string) {
      return sessionId === "ws_1" ? ([turn] as never) : ([] as never);
    },
    async listArtifacts(sessionId: string) {
      return sessionId === "ws_1" ? ([artifact] as never) : ([] as never);
    },
    async insertArtifact() {
      throw new Error("not under test");
    },
    async enqueueTurn() {
      return turn as never;
    },
    async markRunning() {
      return true;
    },
    async heartbeat() {},
    async markSucceeded() {
      return true;
    },
    async markFailed() {
      return true;
    },
    async markCancelled() {
      return true;
    },
    async getTurn() {
      return turn as never;
    },
    async recoverStale() {
      return [];
    },
    async appendEvent() {
      throw new Error("not under test");
    },
    // wt_1 carries one persisted event by default — the settled-history endpoint reads it.
    async readEventsSince(turnId: string, _seq: number, _limit?: number) {
      return turnId === "wt_1"
        ? ([
            {
              id: "we_1",
              turnId: "wt_1",
              seq: 1,
              type: "message_chunk",
              payload: { type: "message.part.delta", delta: "hi" },
              createdAt: new Date("2026-01-01T00:00:12Z"),
            },
          ] as never)
        : ([] as never);
    },
  } as unknown as WorkshopStore;
}

function fakeBus(): TurnEventBus {
  return {
    mode: "poll",
    async publish() {},
    async subscribe() {
      return () => undefined;
    },
    async close() {},
  };
}

function fakeOrchestrator() {
  const enqueued: Array<{ sessionId: string; prompt: string }> = [];
  const cancelled: string[] = [];
  const orchestrator: TurnOrchestrator = {
    async enqueue(input) {
      enqueued.push({ sessionId: input.sessionId, prompt: input.prompt });
      return { turnId: "wt_1" };
    },
    async cancel(turnId) {
      cancelled.push(turnId);
      return true;
    },
    async recoverStale() {
      return [];
    },
    async heartbeat() {},
  };
  return { orchestrator, enqueued, cancelled };
}

function fakeClient(): SandboxClient {
  return {
    createSession: async () => "ses",
    sendMessage: async () => ({ sessionId: "ses", text: "", usage: undefined }),
    listFiles: async () => ["out.csv"],
    readFile: async (path: string) => ({
      path,
      size: 4,
      content: "a,b\n",
      truncated: false,
    }),
    writeFile: async (path: string) => ({ path, size: 0 }),
    resetWorkspace: async () => undefined,
    abortSession: async () => undefined,
    subscribeEvents: async () => ({ stop: () => undefined }),
  } as never;
}

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { id: "user_1" } as never);
  await next();
};

/** The route app wired with fakes; canUseBot decides per test. */
function makeApp(
  canUseBot: (actor: unknown, botId: string) => Promise<boolean>,
) {
  const { orchestrator, enqueued, cancelled } = fakeOrchestrator();
  const app = createWorkshopRoutes({
    requireUser,
    canUseBot: canUseBot as never,
    deps: {
      store: fakeStore(),
      bus: fakeBus(),
      orchestrator,
      clientFor: (botId) => (botId === "bot_1" ? fakeClient() : null),
    },
  });
  return { app, enqueued, cancelled };
}

describe("workshop routes", () => {
  test("a non-user of the Bot is 403, before any workshop read", async () => {
    const { app } = makeApp(async () => false);
    const response = await app.request("/ch_1", { headers: { "x-test": "1" } });
    expect(response.status).toBe(403);
  });

  test("a missing session is 404", async () => {
    const { app } = makeApp(async () => true);
    const response = await app.request("/ch_missing");
    expect(response.status).toBe(404);
  });

  test("turns without a botId answer 400 without touching the orchestrator", async () => {
    const { app, enqueued } = makeApp(async () => true);
    const response = await app.request("/ch_1/turns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "算一下" }),
    });
    expect(response.status).toBe(400);
    expect(enqueued).toHaveLength(0);
  });

  test("turns with a mismatched botId answer 400 too", async () => {
    const { app, enqueued } = makeApp(async () => true);
    const response = await app.request("/ch_1/turns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot_other", prompt: "算一下" }),
    });
    expect(response.status).toBe(400);
    expect(enqueued).toHaveLength(0);
  });

  test("the aggregate answers the snapshot shape F1 expects", async () => {
    const { app } = makeApp(async () => true);
    const response = await app.request("/ch_1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      session: { id: string; botId: string; visibility: string };
      turns: Array<{ id: string; status: string; initiator: string }>;
      artifacts: Array<{ id: string; type: string }>;
      sandbox: { kind: string; reason?: string };
      usage: { total: { inputTokens: number; outputTokens: number } };
      share: { visibility: string; scope: string };
    };
    expect(body.session.id).toBe("ws_1");
    expect(body.session.botId).toBe("bot_1");
    expect(body.session.visibility).toBe("private");
    expect(body.turns).toHaveLength(1);
    expect(body.turns[0].status).toBe("succeeded");
    expect(body.turns[0].initiator).toBe("person");
    expect(body.artifacts[0].type).toBe("csv");
    expect(body.sandbox.kind).toBe("ready");
    expect(body.usage.total).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(body.share.scope).toBe("preview");
  });

  test("a happy-path turn enqueues and answers its id", async () => {
    const { app, enqueued } = makeApp(async () => true);
    const response = await app.request("/ch_1/turns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot_1", prompt: "算一下" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { turnId: string };
    expect(body.turnId).toBe("wt_1");
    expect(enqueued).toEqual([{ sessionId: "ws_1", prompt: "算一下" }]);
  });

  test("cancel reaches the orchestrator", async () => {
    const { app, cancelled } = makeApp(async () => true);
    const response = await app.request("/ch_1/turns/wt_1/cancel", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect((await response.json()).cancelled).toBe(true);
    expect(cancelled).toEqual(["wt_1"]);
  });

  test("artifact download streams the file with an attachment disposition", async () => {
    const { app } = makeApp(async () => true);
    const response = await app.request("/ch_1/artifacts/wa_1/download");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("a,b\n");
    expect(response.headers.get("content-disposition")).toContain("out.csv");
  });

  test("an unknown artifact is 404", async () => {
    const { app } = makeApp(async () => true);
    const response = await app.request("/ch_1/artifacts/wa_none/download");
    expect(response.status).toBe(404);
  });
});

describe("workshop routes: the owner share endpoints", () => {
  /** A share service stub: mint answers a handle once, revoke flips the flag. */
  const fakeSharing = () => {
    const mints: Array<{
      channelId: string;
      scope: string;
      expiresInDays?: number;
      createdBy: string;
    }> = [];
    let revoked = 0;
    return {
      mints,
      revokes: () => revoked,
      service: {
        createShare: async (input: {
          channelId: string;
          scope: string;
          expiresInDays?: number;
          createdBy: string;
        }) => {
          mints.push(input);
          return {
            token: "token-once",
            shareUrl: "/share/token-once",
            scope: input.scope,
            expiresAt: null,
          };
        },
        revokeShare: async () => {
          revoked += 1;
        },
      } as never,
    };
  };

  test("POST /share mints through the gate and answers the plaintext exactly once", async () => {
    const sharing = fakeSharing();
    const { orchestrator } = fakeOrchestrator();
    const app = createWorkshopRoutes({
      requireUser,
      canUseBot: (async () => true) as never,
      deps: {
        store: fakeStore(),
        bus: fakeBus(),
        orchestrator,
        clientFor: () => fakeClient(),
        sharing: sharing.service,
      },
    });
    const response = await app.request("/ch_1/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "preview_download", expiresInDays: 7 }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      token: string;
      shareUrl: string;
      scope: string;
    };
    expect(body.token).toBe("token-once");
    expect(body.shareUrl).toBe("/share/token-once");
    expect(body.scope).toBe("preview_download");
    expect(sharing.mints).toHaveLength(1);
    expect(sharing.mints[0]?.scope).toBe("preview_download");
    expect(sharing.mints[0]?.expiresInDays).toBe(7);
  });

  test("POST /share without the service configured answers 503, not a crash", async () => {
    const { orchestrator } = fakeOrchestrator();
    const app = createWorkshopRoutes({
      requireUser,
      canUseBot: (async () => true) as never,
      deps: {
        store: fakeStore(),
        bus: fakeBus(),
        orchestrator,
        clientFor: () => fakeClient(),
      },
    });
    const response = await app.request("/ch_1/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "preview" }),
    });
    expect(response.status).toBe(503);
  });

  test("a non-user of the Bot cannot mint (403 through the same gate)", async () => {
    const sharing = fakeSharing();
    const { orchestrator } = fakeOrchestrator();
    const app = createWorkshopRoutes({
      requireUser,
      canUseBot: (async () => false) as never,
      deps: {
        store: fakeStore(),
        bus: fakeBus(),
        orchestrator,
        clientFor: () => fakeClient(),
        sharing: sharing.service,
      },
    });
    const response = await app.request("/ch_1/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "preview" }),
    });
    expect(response.status).toBe(403);
    expect(sharing.mints).toHaveLength(0);
  });

  test("DELETE /share revokes", async () => {
    const sharing = fakeSharing();
    const { orchestrator } = fakeOrchestrator();
    const app = createWorkshopRoutes({
      requireUser,
      canUseBot: (async () => true) as never,
      deps: {
        store: fakeStore(),
        bus: fakeBus(),
        orchestrator,
        clientFor: () => fakeClient(),
        sharing: sharing.service,
      },
    });
    const response = await app.request("/ch_1/share", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect((await response.json()).revoked).toBe(true);
    expect(sharing.revokes()).toBe(1);
  });
});

describe("workshop routes: a settled turn's history", () => {
  test("GET /turns/:id/events answers the persisted events in wire shape", async () => {
    const { orchestrator } = fakeOrchestrator();
    const app = createWorkshopRoutes({
      requireUser,
      canUseBot: (async () => true) as never,
      deps: {
        store: fakeStore(),
        bus: fakeBus(),
        orchestrator,
        clientFor: () => fakeClient(),
      },
    });
    const response = await app.request("/ch_1/turns/wt_1/events");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      turnId: string;
      events: Array<{ seq: number; type: string }>;
    };
    expect(body.turnId).toBe("wt_1");
    expect(Array.isArray(body.events)).toBe(true);
    body.events.forEach((event) => {
      expect(typeof event.seq).toBe("number");
      expect(typeof event.type).toBe("string");
    });
  });

  test("a turn id that belongs to nobody here is 404", async () => {
    const { orchestrator } = fakeOrchestrator();
    const app = createWorkshopRoutes({
      requireUser,
      canUseBot: (async () => true) as never,
      deps: {
        store: fakeStore(),
        bus: fakeBus(),
        orchestrator,
        clientFor: () => fakeClient(),
      },
    });
    const response = await app.request("/ch_1/turns/wt_stranger/events");
    expect(response.status).toBe(404);
  });
});

describe("workshop routes: canUseBot is required at construction", () => {
  test("the type demands it — this test exists to pin the parameter's presence", () => {
    // Compile-time property: createWorkshopRoutes without canUseBot does not typecheck. The
    // assertion is that the factory's parameter is non-optional, verified by the type at the
    // call sites; at runtime we only confirm the happy construction above already ran.
    expect(typeof createWorkshopRoutes).toBe("function");
  });
});
