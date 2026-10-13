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

/**
 * fetch mock: permission-answer POSTs recorded; the prompt admits at once (the
 * turn parks on the unanswered ask, not the POST). `answerStatuses` scripts the
 * Nth permission POST's status (default 200); a 404 carries opencode's
 * PermissionNotFoundError body (pinned live against opencode 1.18.7).
 */
function recordingFetch(
  posts: Posted[],
  answerStatuses: number[] = [],
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/permissions/")) {
      const index = posts.length;
      posts.push({ url, body: String(init?.body ?? "") });
      const status = answerStatuses[index] ?? 200;
      const body =
        status === 404
          ? '{"_tag":"PermissionNotFoundError","requestID":"perm","message":"Permission request not found: perm"}'
          : "{}";
      return new Response(body, { status });
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
  answerStatuses: number[] = [],
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
    fetchImpl: recordingFetch(posts, answerStatuses),
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
    // The decision endpoint answered (allow) — its mechanism is the atomic
    // take, which also cleared the record. This is the ONLY answer opencode
    // may ever see for this permission (OCR r3: the timeout must reconcile
    // through the same take, losing cleanly when the decide wins it).
    expect(await signals.takePending(card.request_id)).not.toBeNull();

    // Window (1s) passes: the loop must NOT send its redundant reject after
    // the user already connected (OCR r2: the deletion-path gap).
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const answers = posts.filter((post) =>
      post.url.includes("/permissions/perm_decided"),
    );
    expect(answers).toHaveLength(0);

    await turn.finish();
  }, 15000);

  // ── OCR round-3: the timeout's reconcile mirrors the decide endpoint ───────
  // Claim through the atomic take (never load+answer+clear, which races the
  // endpoint's own take), and only drop the entry once an answer landed.
  test("KV blip at the deadline → the reject is retried next pass, not silently dropped", async () => {
    const base = createInProcessConnectAppSignals();
    let failed = false;
    const blip = (): void => {
      if (!failed) {
        failed = true;
        throw new Error("kv blip");
      }
    };
    const signals: CraftConnectAppSignals = {
      ...base,
      loadPending: async (id) => {
        blip();
        return base.loadPending(id);
      },
      takePending: async (id) => {
        blip();
        return base.takePending(id);
      },
    };
    const posts: Posted[] = [];
    const turn = await startTurn(
      fastConfig,
      { sessionId: "cs-sess", signals },
      posts,
    );

    turn.bus.sub.queue.push(
      connectAppAsk("perm_blip", { external_app_id: 7, reason: "x" }),
    );
    // The window passes during the blip: the first claim attempt fails, the
    // entry must survive it and the next pass must still deliver the reject
    // (pre-fix, the read failure read as "decide took it" and the ask hung
    // unanswered until the inactivity timeout).
    await waitFor(
      () => posts.some((post) => post.url.includes("/permissions/perm_blip")),
      6000,
    );
    expect(JSON.parse(posts[0].body)).toEqual({ response: "reject" });
    // Exactly one answer, once delivered.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(
      posts.filter((post) => post.url.includes("/permissions/perm_blip")),
    ).toHaveLength(1);
    expect(
      await base.loadPending(
        signals
          .peekAnnouncements("cs-sess")
          .map((p) => JSON.parse(p) as { request_id: string })[0].request_id,
      ),
    ).toBeNull();

    await turn.finish();
  }, 15000);

  test("reject delivery fails once → pending re-stashed, reject retried, one answer in the end", async () => {
    const signals = createInProcessConnectAppSignals();
    const posts: Posted[] = [];
    const turn = await startTurn(
      fastConfig,
      { sessionId: "cs-sess", signals },
      posts,
      [500, 200], // first answer POST fails, the retry lands
    );

    turn.bus.sub.queue.push(
      connectAppAsk("perm_retry", { external_app_id: 7, reason: "x" }),
    );
    // The first reject POST 500s: the take already consumed the record, so it
    // must be re-stashed (the card stays decidable) and the entry kept so the
    // next pass retries — instead of losing the record with no answer sent
    // (pre-fix) or clearing it after a phantom success.
    await waitFor(
      () =>
        posts.filter((post) => post.url.includes("/permissions/perm_retry"))
          .length === 2,
      6000,
    );
    const requestId = signals
      .peekAnnouncements("cs-sess")
      .map((p) => JSON.parse(p) as { request_id: string })[0].request_id;
    // The retry's take removed it again — no lingering record for a late card.
    expect(await signals.loadPending(requestId)).toBeNull();

    await turn.finish();
  }, 15000);

  test("ask already answered upstream at the deadline → timeout stands down (terminal 404), no re-stash", async () => {
    const signals = createInProcessConnectAppSignals();
    const posts: Posted[] = [];
    const turn = await startTurn(
      fastConfig,
      { sessionId: "cs-sess", signals },
      posts,
      [404], // opencode: permission already resolved — PermissionNotFoundError
    );

    turn.bus.sub.queue.push(
      connectAppAsk("perm_gone", { external_app_id: 7, reason: "x" }),
    );
    await waitFor(
      () => posts.some((post) => post.url.includes("/permissions/perm_gone")),
      6000,
    );
    // The ask is dead upstream: exactly one probe, no retry storm, and the
    // take-consumed record is NOT re-stashed (a re-stash would resurrect a
    // card that can never be answered).
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(
      posts.filter((post) => post.url.includes("/permissions/perm_gone")),
    ).toHaveLength(1);
    const requestId = signals
      .peekAnnouncements("cs-sess")
      .map((p) => JSON.parse(p) as { request_id: string })[0].request_id;
    expect(await signals.loadPending(requestId)).toBeNull();

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
        return {
          ok: recorder.answerStatus === 200,
          permissionGone: recorder.answerStatus === 404,
        };
      },
    }),
  } as unknown as SandboxGateway;
}

async function decisionHarness(input: {
  session?: CraftSessionRow | null;
  answerStatus?: number;
  signals?: CraftConnectAppSignals;
}): Promise<{
  app: ReturnType<typeof createConnectAppRoutes>;
  signals: CraftConnectAppSignals;
  posts: Posted[];
  requestId: string;
  auditEvents: Array<Record<string, unknown>>;
}> {
  const signals = input.signals ?? createInProcessConnectAppSignals();
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
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain(
      "Could not reach the sandbox to apply your choice — please try again.",
    );
    // The restore succeeded, so the client may honestly retry.
    expect(body).toMatchObject({ retryable: true });
    expect(await h.signals.loadPending(h.requestId)).not.toBeNull();
  });

  // ── OCR round-3: authorize BEFORE the destructive take ─────────────────────
  // The pending record must survive every unauthorized/failed exit, or a
  // leaked requestId (they ride SSE cards, audit rows, logs) becomes a remote
  // cancel of the owner's decision.
  test("cross-user 404 does not consume the pending — the owner can still decide", async () => {
    const signals = createInProcessConnectAppSignals();
    const requestId = await stashAndAnnounce(signals, {
      sessionId: "cs-sess",
      opencodeSessionId: "ses_1",
      directory: "/w",
      permissionId: "perm_ok",
      externalAppId: 7,
      reason: null,
      newRequestId: () => "req-o",
    });
    const posts: Posted[] = [];
    const store = {
      // u1 owns the session; any other caller owns nothing.
      getSession: async (_id: string, userId: string) =>
        userId === "u1" ? sessionRow() : undefined,
    } as unknown as CraftStore;
    const deps = {
      config: fastConfig,
      store,
      gateway: recordingGateway({ posts, answerStatus: 200 }),
      botIdFor: async () => "craft",
      signals,
    };
    const attackerApp = createConnectAppRoutes(fakeRequireUser("u2"), deps);
    const ownerApp = createConnectAppRoutes(fakeRequireUser("u1"), deps);

    // A user holding someone else's requestId (SSE card / audit / log leak):
    // the 404 must NOT have deleted the record (pre-fix, the take ran before
    // the ownership check and the owner's later decision no-opped forever).
    const attack = await attackerApp.request(
      `/apps/connect/${requestId}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "declined" }),
      },
    );
    expect(attack.status).toBe(404);
    expect(await signals.loadPending(requestId)).not.toBeNull();
    expect(posts).toHaveLength(0);

    // The owner's decision still lands — exactly one answer, ever.
    const owner = await ownerApp.request(
      `/apps/connect/${requestId}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "connected" }),
      },
    );
    expect(owner.status).toBe(200);
    expect(posts).toEqual([
      {
        url: "/session/ses_1/permissions/perm_ok",
        body: '{"response":"once"}',
      },
    ]);
  });

  test("503 (sandbox not running) leaves the pending answerable once it returns", async () => {
    const signals = createInProcessConnectAppSignals();
    const requestId = await stashAndAnnounce(signals, {
      sessionId: "cs-sess",
      opencodeSessionId: "ses_1",
      directory: "/w",
      permissionId: "perm_ok",
      externalAppId: 7,
      reason: null,
      newRequestId: () => "req-s",
    });
    let row = sessionRow({ status: "paused" });
    const posts: Posted[] = [];
    const app = createConnectAppRoutes(fakeRequireUser("u1"), {
      config: fastConfig,
      store: { getSession: async () => row } as unknown as CraftStore,
      gateway: recordingGateway({ posts, answerStatus: 200 }),
      botIdFor: async () => "craft",
      signals,
    });

    const paused = await app.request(`/apps/connect/${requestId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "connected" }),
    });
    expect(paused.status).toBe(503);
    // The 503 consumed nothing (pre-fix it ate the record permanently).
    expect(await signals.loadPending(requestId)).not.toBeNull();

    row = sessionRow(); // the sandbox is back
    const retry = await app.request(`/apps/connect/${requestId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "connected" }),
    });
    expect(retry.status).toBe(200);
    expect(posts).toHaveLength(1);
  });

  // ── OCR round-3: KV failure at the gate is a 5xx, never a false 200 no-op ──
  test("KV failure at the load → 502, not a silent no-op 200", async () => {
    const base = createInProcessConnectAppSignals();
    const h = await decisionHarness({
      session: sessionRow(),
      signals: {
        ...base,
        loadPending: async () => {
          throw new Error("kv down");
        },
      },
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
    expect(h.posts).toHaveLength(0);
  });

  test("KV failure at the take → 502, the record stays put", async () => {
    const base = createInProcessConnectAppSignals();
    const h = await decisionHarness({
      session: sessionRow(),
      signals: {
        ...base,
        takePending: async () => {
          throw new Error("kv down");
        },
      },
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
    expect(h.posts).toHaveLength(0);
    // The stash was never taken: the owner can retry once the KV recovers.
    expect(await base.loadPending(h.requestId)).not.toBeNull();
  });

  // ── OCR round-3: failed restore + terminal upstream 404 stop the retry loop ─
  test("answer fails AND the re-stash fails → 502 retryable:false (a retry would no-op)", async () => {
    const base = createInProcessConnectAppSignals();
    // The initial stash (handshake setup) succeeds; only the RESTORE after a
    // failed answer hits the dead KV.
    let stashedOnce = false;
    const h = await decisionHarness({
      session: sessionRow(),
      answerStatus: 500,
      signals: {
        ...base,
        stashPending: async (id, pending) => {
          if (!stashedOnce) {
            stashedOnce = true;
            return base.stashPending(id, pending);
          }
          throw new Error("kv down");
        },
      },
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
    // The record is LOST (restore failed): the response must say so — a
    // retryable 502 here sends the user into false-success no-op 200s.
    expect(await response.json()).toMatchObject({ retryable: false });
    expect(await h.signals.loadPending(h.requestId)).toBeNull();
  });

  test("ask already resolved upstream (opencode 404 PermissionNotFoundError) → terminal 410, no re-stash, no loop", async () => {
    // Pinned: opencode 1.18.7's reply handler deletes the pending entry on the
    // first answer and 404s PermissionNotFoundError on every re-answer (live
    // probe + packages/core/src/permission.ts) — a false-negative answer
    // (applied but response lost) makes every retry 404 forever. The endpoint
    // must recognize the terminal 404 and stop promising "please try again".
    const h = await decisionHarness({
      session: sessionRow(),
      answerStatus: 404,
    });
    const response = await h.app.request(
      `/apps/connect/${h.requestId}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "connected" }),
      },
    );
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ retryable: false });
    // Terminal: NOT re-stashed (the retry loop's cap) and not audited — this
    // side cannot prove the user's choice took effect upstream.
    expect(await h.signals.loadPending(h.requestId)).toBeNull();
    expect(h.auditEvents).toHaveLength(0);
    expect(h.posts).toHaveLength(1);
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
