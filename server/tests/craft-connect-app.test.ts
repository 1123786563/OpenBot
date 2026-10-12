import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { CraftConfig } from "../src/craft/config";
import { loadCraftConfig } from "../src/craft/config";
import {
  CONNECT_APP_PERMISSION,
  type CraftConnectAppSignals,
  createInProcessConnectAppSignals,
  parseConnectAppAsk,
  stashAndAnnounce,
} from "../src/craft/connect-app";
import { createConnectAppRoutes } from "../src/craft/connect-app-routes";
import { connectAppRequestPacket } from "../src/craft/events/packets";
import { CraftSessionManager } from "../src/craft/manager";
import {
  type PodEventBus,
  type PodSubscription,
  SubscriberQueue,
} from "../src/craft/opencode/event-bus";
import { OpencodeServeClient } from "../src/craft/opencode/serve-client";
import type { SandboxGateway } from "../src/craft/sandbox-gateway";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import { eventToSse } from "../src/craft/streaming";

/**
 * Fixture F4 B/C/D — the connect_app handshake: the no-op tool's ask is
 * announced + stashed (Redis-shaped KV, onyx connect_app.py TTLs 60s/30min),
 * the decision endpoint answers opencode out-of-band with onyx's four
 * branches (external_apps/api.py:436-472), and an unanswered ask times out to
 * a reject. One approval attempt per request; deny paths never execute
 * anything; no credential bytes anywhere near the flow.
 */

const fastConfig = loadCraftConfig({
  OPENBOT_CRAFT_APPROVAL_WAIT_TIMEOUT_SECONDS: "1",
});

// ---------------------------------------------------------------------------
// fixtures (mirroring craft-approval-producer.test.ts)
// ---------------------------------------------------------------------------

function fakeBus(): PodEventBus & { sub: PodSubscription } {
  let sub: PodSubscription | null = null;
  const bus = {
    streamReady: true,
    isClosed: () => false,
    subscribe(sessionId: string) {
      sub = { sessionId, queue: new SubscriberQueue(500) };
      return sub;
    },
    unsubscribe: () => undefined,
    parentOf: () => null,
    listChildren: () => [],
  } as unknown as PodEventBus;
  Object.defineProperty(bus, "sub", {
    get: () => {
      if (sub === null) throw new Error("bus not subscribed yet");
      return sub;
    },
  });
  return bus as PodEventBus & { sub: PodSubscription };
}

type Posted = { url: string; body: string };

/** fetch mock: permission-answer POSTs recorded; the prompt admits at once (the turn parks on the unanswered ask, not the POST). */
function recordingFetch(posts: Posted[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/permissions/")) {
      posts.push({ url, body: String(init?.body ?? "") });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

const waitFor = async (
  probe: () => boolean,
  timeoutMs = 8000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition never met");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

function connectAppAsk(
  permissionId: string,
  metadata: Record<string, unknown> | null,
): { type: string; properties: Record<string, unknown> } {
  return {
    type: "permission.asked",
    properties: {
      sessionID: "ses_1",
      id: permissionId,
      permission: CONNECT_APP_PERMISSION,
      patterns: ["7"],
      ...(metadata !== null ? { metadata } : {}),
    },
  };
}

/** One parked turn: starts sendMessage against the fake bus, ready for events. */
async function startTurn(
  config: CraftConfig,
  connectApp: { sessionId: string; signals: CraftConnectAppSignals } | null,
  posts: Posted[],
): Promise<{
  bus: PodEventBus & { sub: PodSubscription };
  finish: () => Promise<void>;
}> {
  const bus = fakeBus();
  const client = new OpencodeServeClient({
    baseUrl: "http://sandbox",
    config,
    token: null,
    botId: "craft",
    eventBus: bus,
    fetchImpl: recordingFetch(posts),
  });
  const runner = (async () => {
    for await (const _event of client.sendMessage("ses_1", "hi", {
      directory: "/w",
      connectApp,
    })) {
      void _event;
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 50));
  return {
    bus,
    finish: async () => {
      bus.sub.queue.push({
        type: "session.idle",
        properties: { sessionID: "ses_1" },
      });
      await runner;
    },
  };
}

// ---------------------------------------------------------------------------
// ① the agent-side plugin (schema + result strings, verbatim)
// ---------------------------------------------------------------------------

describe("connect-app plugin source (F4 tool schema)", () => {
  test("carries onyx's description, arg descriptions, and both result strings", async () => {
    const source = await readFile(
      new URL("../src/craft/templates/connect-app.plugin.ts", import.meta.url),
      "utf8",
    );
    // The description concatenates five literals in the source; each segment
    // verbatim (F4 pins the concatenated runtime value — these are its parts).
    expect(source).toContain(
      '"Ask the user to connect an org app you aren\'t set up to use yet. "',
    );
    expect(source).toContain(
      "\"Pass the app's numeric ID (as listed under 'Connectable apps' in AGENTS.md). \"",
    );
    expect(source).toContain(
      '"This pauses for the user to connect it. If this returns normally the "',
    );
    expect(source).toContain(
      '"app is connected and you can use it; if it is denied, do not retry — "',
    );
    expect(source).toContain('"offer an alternative."');
    expect(source).toContain('"Numeric ID of the connectable app, e.g. 42"');
    expect(source).toContain(
      '"One short sentence on why you need it, shown to the user"',
    );
    expect(source).toContain(
      "`The user declined to connect external app ${args.external_app_id}. `",
    );
    expect(source).toContain("`Do not retry connecting ` +");
    expect(source).toContain(
      "`it; offer an alternative or proceed without it.`",
    );
    expect(source).toContain(
      "`External app ${args.external_app_id} is connected. You can use it now.`",
    );
    // The ask carries the metadata the server side keys the card on.
    expect(source).toContain('permission: "connect_app"');
    expect(source).toContain("external_app_id: args.external_app_id");
  });
});

// ---------------------------------------------------------------------------
// ② metadata parse (invalid → immediate deny, onyx serve_client.py:1750-1775)
// ---------------------------------------------------------------------------

describe("parseConnectAppAsk", () => {
  test("parses a valid ask; empty reason becomes null", () => {
    expect(
      parseConnectAppAsk({
        external_app_id: 7,
        reason: "Need Slack to post updates",
      }),
    ).toEqual({ externalAppId: 7, reason: "Need Slack to post updates" });
    expect(parseConnectAppAsk({ external_app_id: 7, reason: "" })).toEqual({
      externalAppId: 7,
      reason: null,
    });
    expect(parseConnectAppAsk({ external_app_id: 7 })).toEqual({
      externalAppId: 7,
      reason: null,
    });
    expect(parseConnectAppAsk({ external_app_id: "7", reason: "x" })).toEqual({
      externalAppId: 7,
      reason: "x",
    });
  });

  test("missing or non-numeric app id → null (deny without announcing)", () => {
    expect(parseConnectAppAsk({})).toBeNull();
    expect(parseConnectAppAsk({ external_app_id: null })).toBeNull();
    expect(parseConnectAppAsk({ external_app_id: "seven" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ③ serve-client dispatch: stash + announce; invalid → immediate deny
// ---------------------------------------------------------------------------

describe("serve-client connect_app dispatch", () => {
  test("valid ask: no immediate answer; announce + pending carry the wire card", async () => {
    const signals = createInProcessConnectAppSignals();
    const posts: Posted[] = [];
    const turn = await startTurn(
      fastConfig,
      { sessionId: "cs-sess", signals },
      posts,
    );

    turn.bus.sub.queue.push(
      connectAppAsk("perm_ok", {
        external_app_id: 7,
        reason: "Need Slack to post updates",
      }),
    );
    await waitFor(() => signals.peekAnnouncements("cs-sess").length === 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // NOT answered yet — the decision endpoint owns the answer.
    expect(posts).toHaveLength(0);

    // The announce payload is onyx's ConnectAppRequest model_dump_json.
    const [announced] = signals.peekAnnouncements("cs-sess");
    expect(Object.keys(JSON.parse(announced))).toEqual([
      "request_id",
      "external_app_id",
      "reason",
    ]);
    const card = JSON.parse(announced);
    expect(card.external_app_id).toBe(7);
    expect(card.reason).toBe("Need Slack to post updates");

    // The pending context answers the permission out-of-band (onyx's
    // ConnectAppPending shape, plus the app id this deployment's audit row needs).
    expect(await signals.loadPending(card.request_id)).toEqual({
      build_session_id: "cs-sess",
      opencode_session_id: "ses_1",
      perm_id: "perm_ok",
      directory: "/w",
      external_app_id: 7,
    });

    // No credential bytes ride the announce or pending payloads.
    expect(announced).not.toMatch(/token|secret|credential|bearer/i);
    expect(
      JSON.stringify(await signals.loadPending(card.request_id)),
    ).not.toMatch(/token|secret|credential|bearer/i);

    await turn.finish();
  }, 15000);

  test("invalid metadata: immediate reject, nothing announced or stashed", async () => {
    const signals = createInProcessConnectAppSignals();
    const posts: Posted[] = [];
    const turn = await startTurn(
      fastConfig,
      { sessionId: "cs-sess", signals },
      posts,
    );

    turn.bus.sub.queue.push(connectAppAsk("perm_bad", { reason: "no id" }));
    await waitFor(() =>
      posts.some((post) => post.url.includes("/permissions/perm_bad")),
    );
    expect(JSON.parse(posts[0].body)).toEqual({ response: "reject" });
    expect(signals.peekAnnouncements("cs-sess")).toEqual([]);

    await turn.finish();
  }, 15000);

  test("signals failure: deny immediately (fail closed, no hanging turn)", async () => {
    const signals: CraftConnectAppSignals = {
      ...createInProcessConnectAppSignals(),
      stashPending: async () => {
        throw new Error("kv down");
      },
    };
    const posts: Posted[] = [];
    const turn = await startTurn(
      fastConfig,
      { sessionId: "cs-sess", signals },
      posts,
    );

    turn.bus.sub.queue.push(
      connectAppAsk("perm_err", { external_app_id: 7, reason: "x" }),
    );
    await waitFor(() =>
      posts.some((post) => post.url.includes("/permissions/perm_err")),
    );
    expect(JSON.parse(posts[0].body)).toEqual({ response: "reject" });

    await turn.finish();
  }, 15000);
});

// ---------------------------------------------------------------------------
// ④ timeout: nobody decides → the loop rejects once (serve_client.py:1813-1827)
// ---------------------------------------------------------------------------

describe("connect_app timeout", () => {
  test("window passes → reject answered upstream exactly once", async () => {
    const signals = createInProcessConnectAppSignals();
    const posts: Posted[] = [];
    const turn = await startTurn(
      fastConfig,
      { sessionId: "cs-sess", signals },
      posts,
    );

    turn.bus.sub.queue.push(
      connectAppAsk("perm_slow", { external_app_id: 7, reason: "x" }),
    );
    await waitFor(() =>
      posts.some((post) => post.url.includes("/permissions/perm_slow")),
    );
    expect(JSON.parse(posts[0].body)).toEqual({ response: "reject" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Exactly one answer — the agent sees one declined result, no retries.
    expect(posts).toHaveLength(1);

    await turn.finish();
  }, 15000);

  test("decided out-of-band BEFORE expiry: the timeout adds no second reject, KV cleared", async () => {
    const signals = createInProcessConnectAppSignals();
    const posts: Posted[] = [];
    const turn = await startTurn(
      fastConfig,
      { sessionId: "cs-sess", signals },
      posts,
    );

    turn.bus.sub.queue.push(
      connectAppAsk("perm_decided", { external_app_id: 7, reason: "x" }),
    );
    await waitFor(() => signals.peekAnnouncements("cs-sess").length === 1);
    const [card] = signals.peekAnnouncements("cs-sess").map(JSON.parse);
    // The decision endpoint answered (allow) and cleared the pending record —
    // the ONLY answer opencode may ever see for this permission.
    await signals.clearPending(card.request_id);

    // Window (1s) passes: the loop must NOT send its redundant reject after
    // the user already connected (OCR r2: the deletion-path gap).
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const answers = posts.filter((post) =>
      post.url.includes("/permissions/perm_decided"),
    );
    expect(answers).toHaveLength(0);

    await turn.finish();
  }, 15000);

  test("timeout rejected: the pending record is cleared so a late card click is a 200 no-op", async () => {
    const signals = createInProcessConnectAppSignals();
    const posts: Posted[] = [];
    const turn = await startTurn(
      fastConfig,
      { sessionId: "cs-sess", signals },
      posts,
    );

    turn.bus.sub.queue.push(
      connectAppAsk("perm_late", { external_app_id: 7, reason: "x" }),
    );
    await waitFor(() =>
      posts.some((post) => post.url.includes("/permissions/perm_late")),
    );
    // The timeout rejected; the KV pending must not linger until TTL — the
    // user's still-visible card must land in the endpoint's no-op branch
    // (200 ok, no second answer), not 502-retry against a dead permission.
    const pendingId = signals
      .peekAnnouncements("cs-sess")
      .map((payload) => JSON.parse(payload) as { request_id: string })
      .find((card) => card.request_id)?.request_id;
    expect(pendingId).toBeDefined();
    expect(await signals.loadPending(pendingId!)).toBeNull();

    await turn.finish();
  }, 15000);
});

// ---------------------------------------------------------------------------
// ⑤ the decision endpoint (onyx external_apps/api.py:436-472)
// ---------------------------------------------------------------------------

function fakeRequireUser(
  userId: string,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id: userId, email: `${userId}@x`, role: "user" });
    await next();
  };
}

function sessionRow(overrides: Partial<CraftSessionRow> = {}): CraftSessionRow {
  return {
    id: "cs-sess",
    userId: "u1",
    name: null,
    status: "active",
    lastActivityAt: new Date(),
    createdAt: new Date(),
    nextjsPort: null,
    sharingScope: "private",
    origin: "INTERACTIVE",
    opencodeSessionId: "ses_1",
    agentProvider: null,
    agentModel: null,
    skillsHash: null,
    mcpConfigHash: null,
    ...overrides,
  };
}

type AnswerRecorder = {
  posts: Posted[];
  answerStatus: number;
};

/** A gateway whose serve client records every permission answer. */
function recordingGateway(recorder: AnswerRecorder): SandboxGateway {
  return {
    serveClientFor: () => ({
      answerPermission: async (
        sessionId: string,
        permissionId: string,
        options: { allow: boolean },
      ) => {
        recorder.posts.push({
          url: `/session/${sessionId}/permissions/${permissionId}`,
          body: JSON.stringify({ response: options.allow ? "once" : "reject" }),
        });
        return recorder.answerStatus === 200;
      },
    }),
  } as unknown as SandboxGateway;
}

async function decisionHarness(input: {
  session?: CraftSessionRow | null;
  answerStatus?: number;
}): Promise<{
  app: ReturnType<typeof createConnectAppRoutes>;
  signals: ReturnType<typeof createInProcessConnectAppSignals>;
  posts: Posted[];
  requestId: string;
  auditEvents: Array<Record<string, unknown>>;
}> {
  const signals = createInProcessConnectAppSignals();
  const posts: Posted[] = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  const app = createConnectAppRoutes(fakeRequireUser("u1"), {
    config: fastConfig,
    store: {
      getSession: async () => input.session ?? undefined,
    } as unknown as CraftStore,
    gateway: recordingGateway({
      posts,
      answerStatus: input.answerStatus ?? 200,
    }),
    botIdFor: async () => "craft",
    signals,
    audit: {
      insert: async (event: Record<string, unknown>) => {
        auditEvents.push(event);
      },
    } as never,
  });
  const requestId = await stashAndAnnounce(signals, {
    sessionId: "cs-sess",
    opencodeSessionId: "ses_1",
    directory: "/w",
    permissionId: "perm_ok",
    externalAppId: 7,
    reason: "Need Slack to post updates",
    newRequestId: () => "req-1",
  });
  return { app, signals, posts, requestId, auditEvents };
}

describe("POST /apps/connect/:requestId/decision", () => {
  test("connected: answers once, clears pending, writes the audit row", async () => {
    const h = await decisionHarness({ session: sessionRow() });
    const response = await h.app.request(
      `/apps/connect/${h.requestId}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "connected" }),
      },
    );
    expect(response.status).toBe(200);
    expect(h.posts).toEqual([
      {
        url: "/session/ses_1/permissions/perm_ok",
        body: '{"response":"once"}',
      },
    ]);
    expect(await h.signals.loadPending(h.requestId)).toBeNull();
    // One approval attempt, one audit record.
    expect(h.auditEvents).toHaveLength(1);
    expect(h.auditEvents[0].payload).toMatchObject({
      decision: "connected",
      external_app_id: 7,
      session: "cs-sess",
    });
    // No credential bytes in the audit payload.
    expect(JSON.stringify(h.auditEvents[0])).not.toMatch(
      /token|secret|credential|bearer/i,
    );
  });

  test("declined: answers reject; the plugin's result is the declined string", async () => {
    const h = await decisionHarness({ session: sessionRow() });
    const response = await h.app.request(
      `/apps/connect/${h.requestId}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "declined" }),
      },
    );
    expect(response.status).toBe(200);
    expect(h.posts[0].body).toBe('{"response":"reject"}');
    expect(h.auditEvents[0].payload).toMatchObject({ decision: "declined" });
  });

  test("second decision is a 200 no-op — one approval attempt, no re-answer", async () => {
    const h = await decisionHarness({ session: sessionRow() });
    const first = await h.app.request(`/apps/connect/${h.requestId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "connected" }),
    });
    const replay = await h.app.request(
      `/apps/connect/${h.requestId}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "declined" }),
      },
    );
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(h.posts).toHaveLength(1);
    expect(h.auditEvents).toHaveLength(1);
  });

  test("concurrent duplicate decisions: exactly one answer, one audit row (atomic take)", async () => {
    const h = await decisionHarness({ session: sessionRow() });
    // Double-click / two tabs: both POSTs in flight at once. The take is
    // atomic — only one caller can win the pending record; the loser lands in
    // the no-op branch. Pre-fix, both read the still-present record and each
    // answers opencode (the second possibly 404-ing into a phantom 502) with
    // two audit rows.
    const [first, replay] = await Promise.all([
      h.app.request(`/apps/connect/${h.requestId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "connected" }),
      }),
      h.app.request(`/apps/connect/${h.requestId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "declined" }),
      }),
    ]);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(h.posts).toHaveLength(1);
    expect(h.auditEvents).toHaveLength(1);
  });

  test("unknown/expired pending → 200 no-op", async () => {
    const h = await decisionHarness({ session: sessionRow() });
    const response = await h.app.request(
      "/apps/connect/req-does-not-exist/decision",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "connected" }),
      },
    );
    expect(response.status).toBe(200);
    expect(h.posts).toHaveLength(0);
  });

  test("cross-user: the session is not the caller's → 404 'Connect request not found.'", async () => {
    const signals = createInProcessConnectAppSignals();
    const requestId = await stashAndAnnounce(signals, {
      sessionId: "cs-sess", // u1's session
      opencodeSessionId: "ses_1",
      directory: "/w",
      permissionId: "perm_x",
      externalAppId: 7,
      reason: null,
      newRequestId: () => "req-x",
    });
    const posts: Posted[] = [];
    const app = createConnectAppRoutes(fakeRequireUser("u2"), {
      config: fastConfig,
      store: { getSession: async () => undefined } as unknown as CraftStore, // u2 owns nothing
      gateway: recordingGateway({ posts, answerStatus: 200 }),
      botIdFor: async () => "craft",
      signals,
    });
    const response = await app.request(`/apps/connect/${requestId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "connected" }),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Connect request not found.");
    // u2's caller learned nothing about u1's sandbox; nothing was answered.
    expect(posts).toHaveLength(0);
  });

  test("session not active → 503 'Sandbox is not running.'", async () => {
    const h = await decisionHarness({
      session: sessionRow({ status: "failed" }),
    });
    const response = await h.app.request(
      `/apps/connect/${h.requestId}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "connected" }),
      },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Sandbox is not running.");
    expect(h.posts).toHaveLength(0);
  });

  test("sandbox answer fails → 502, pending retained for retry", async () => {
    const h = await decisionHarness({
      session: sessionRow(),
      answerStatus: 500,
    });
    const response = await h.app.request(
      `/apps/connect/${h.requestId}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "connected" }),
      },
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toContain(
      "Could not reach the sandbox to apply your choice — please try again.",
    );
    expect(await h.signals.loadPending(h.requestId)).not.toBeNull();
  });

  test("invalid decision body → 400", async () => {
    const h = await decisionHarness({ session: sessionRow() });
    const response = await h.app.request(
      `/apps/connect/${h.requestId}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "maybe" }),
      },
    );
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// ⑥ SSE wire: the connect_app_request packet (packets.py:78-89; reason:null stays)
// ---------------------------------------------------------------------------

describe("connect_app_request packet wire", () => {
  test("serializes with reason null present on the wire", () => {
    const frame = eventToSse(connectAppRequestPacket("req-1", 7, null));
    expect(frame).toContain('"type":"connect_app_request"');
    expect(frame).toContain('"request_id":"req-1"');
    expect(frame).toContain('"external_app_id":7');
    expect(frame).toContain('"reason":null');
  });

  test("serializes a typed reason", () => {
    const frame = eventToSse(
      connectAppRequestPacket("req-2", 42, "Need Slack to post updates"),
    );
    expect(frame).toContain('"reason":"Need Slack to post updates"');
  });
});

// ---------------------------------------------------------------------------
// ⑦ the attach stream's announce merge (onyx's live worker pops the card)
// ---------------------------------------------------------------------------

describe("SSE connect-app announce merge", () => {
  test("subscribeToExistingSessionEvents turns drained announces into cards, once", async () => {
    const signals = createInProcessConnectAppSignals();
    await stashAndAnnounce(signals, {
      sessionId: "cs-sess",
      opencodeSessionId: "ses_1",
      directory: "/w",
      permissionId: "perm_ok",
      externalAppId: 7,
      reason: null,
      newRequestId: () => "req-sse",
    });

    const bus = fakeBus();
    const gateway = {
      eventBusFor: () => bus,
      serveClientFor: () => ({}) as never,
    } as unknown as SandboxGateway;
    const manager = new CraftSessionManager({
      config: fastConfig,
      store: {} as CraftStore,
      gateway,
      llmConfigFor: async () => ({}) as never,
      botIdFor: async () => "craft",
    });

    const stream = manager.subscribeToExistingSessionEvents({
      session: sessionRow(),
      botId: "craft",
      keepaliveSeconds: 3600,
      connectAppAnnounceDrain: () => signals.drainAnnouncements("cs-sess"),
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();

    expect(first.done).toBe(false);
    const packet = first.value as {
      type: string;
      request_id: string;
      external_app_id: number;
      reason: string | null;
    };
    expect(packet.type).toBe("connect_app_request");
    expect(packet.request_id).toBe("req-sse");
    expect(packet.external_app_id).toBe(7);
    expect(packet.reason).toBeNull();
    // Announced once, like onyx's BLPOP: a second drain sees nothing.
    expect(await signals.drainAnnouncements("cs-sess")).toEqual([]);
  });
});
