import { describe, expect, test } from "../../tests/support/e2e-compat";
import { Hono, type MiddlewareHandler } from "hono";
// The REAL gateway filter: the server's bus must survive exactly the bytes
// agent-sandbox's /events forwarder emits — sourcing the stream through
// forwardBlock is what makes this test reproduce the live chain (F-G: the
// filter used to drop permission.asked, parking the turn with no egress).
import { forwardBlock } from "../../agent-sandbox/src/sse";
import type { AppVariables } from "../src/auth/guards";
import { loadCraftConfig } from "../src/craft/config";
import { createInProcessConnectAppSignals } from "../src/craft/connect-app";
import { createInterruptFence } from "../src/craft/interrupt";
import { CraftSessionManager } from "../src/craft/manager";
import { createMessageRoutes } from "../src/craft/message-routes";
import { createSandboxGateway } from "../src/craft/sandbox-gateway";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import { createTurnExecutor } from "../src/craft/turn-executor";
import { createTurnRoutes } from "../src/craft/turn-routes";
import { createTurnStateStore } from "../src/craft/turn-state";
import type { Database } from "../src/db/client";

/**
 * F-G / F-H — the turn engine's live chain through the REAL HTTP SSE attach
 * endpoint (`GET /sessions/:id/turns/:turnId/events`, turn-routes.ts), the real
 * executor, the real manager/gateway/bus fan-out, and the real gateway-shaped
 * event stream. The connect_app ask parks the turn exactly the way the live
 * sandbox does (opencode parks on the unanswered permission), so this is the
 * closest assembly reproduction of remediation-verification §0.3.
 */

const config = loadCraftConfig({
  OPENBOT_CRAFT_APPROVAL_WAIT_TIMEOUT_SECONDS: "1",
  OPENBOT_CRAFT_SSE_KEEPALIVE_INTERVAL: "1",
  // The agent-sandbox deployment dialect: the gateway re-exposes opencode's
  // /event as /events (family-filtered) and carries only the sync message verb.
  OPENBOT_CRAFT_OPENCODE_EVENT_PATH: "/events",
  OPENBOT_CRAFT_OPENCODE_PROMPT_ENDPOINT: "message",
  // #618: the real gateway fails closed without the deployment's execution
  // ownership (MT050), so the fixture configures the pair like a deployment.
  OPENBOT_CRAFT_SANDBOX_EXECUTION_TENANT_ID: "acme-co",
  OPENBOT_CRAFT_SANDBOX_EXECUTION_WORKSPACE_ID: "team-1",
});

const OPENCODE_SESSION = "ses_live";

function fakeRequireUser(
  userId: string,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id: userId, email: `${userId}@x`, role: "user" });
    await next();
  };
}

function sessionRow(): CraftSessionRow {
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
    opencodeSessionId: null,
    agentProvider: null,
    agentModel: null,
    skillsHash: null,
    mcpConfigHash: null,
  };
}

type RecordedCall = { method: string; path: string; body: string };

/** The raw opencode /event blocks this test plays, in order. */
const RAW_ASK = `data: {"id":"p1","type":"permission.asked","properties":{"sessionID":"${OPENCODE_SESSION}","id":"perm_1","permission":"connect_app","patterns":[],"metadata":{"external_app_id":7,"reason":"Need Slack to post updates"}}}\n\n`;
const RAW_DECLINED_TOOL_RESULT = `data: {"id":"p2","type":"message.part.updated","properties":{"sessionID":"${OPENCODE_SESSION}","part":{"id":"pt_1","messageID":"m1","sessionID":"${OPENCODE_SESSION}","type":"tool","tool":"connect_app","callID":"call_1","state":{"status":"completed","input":{"external_app_id":7},"output":"The user declined to connect external app 7. Do not retry connecting it; offer an alternative or proceed without it."}}}}\n\n`;
const RAW_IDLE = `data: {"id":"p3","type":"session.idle","properties":{"sessionID":"${OPENCODE_SESSION}"}}\n\n`;

/**
 * The scripted gateway: one /events SSE stream whose bytes are exactly what
 * forwardBlock lets through, plus a recording unary surface.
 */
function createHarness() {
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  const eventsStream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  /** Play one RAW opencode block through the real gateway filter. */
  const emit = (rawBlock: string): void => {
    const forwarded = forwardBlock(rawBlock);
    if (forwarded !== null && streamController !== null) {
      streamController.enqueue(encoder.encode(forwarded));
    }
  };

  const calls: RecordedCall[] = [];
  const promptPosts = (): number =>
    calls.filter(
      (call) =>
        call.method === "POST" &&
        call.path.endsWith(`/${OPENCODE_SESSION}/message`),
    ).length;
  const permissionAnswers = (): RecordedCall[] =>
    calls.filter((call) => call.path.includes("/permissions/"));

  const gatewayFetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/events") {
      return new Response(eventsStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    calls.push({
      method,
      path: url.pathname,
      body: String(init?.body ?? ""),
    });
    if (method === "POST" && url.pathname === "/session") {
      // Minting answers a DIFFERENT id than the row carries — the executor
      // must reuse the row's id (GET 200 below), not re-mint: the attach
      // stream and the decision endpoint key on the row's id.
      return Response.json({ id: "ses_reminted" });
    }
    if (method === "GET" && url.pathname === `/session/${OPENCODE_SESSION}`) {
      return Response.json({ id: OPENCODE_SESSION }); // the row's id exists
    }
    return Response.json({});
  }) as typeof fetch;

  const row = sessionRow();
  row.opencodeSessionId = OPENCODE_SESSION; // provisioned before the turn
  const messages: Array<Record<string, unknown>> = [];
  const store = {
    messages,
    async getSession(sessionId: string, userId: string) {
      return row.id === sessionId && row.userId === userId ? row : undefined;
    },
    async persistOpencodeSessionId(
      _sessionId: string,
      opencodeSessionId: string,
    ) {
      row.opencodeSessionId = opencodeSessionId;
    },
    async createMessage(input: Record<string, unknown>) {
      messages.push(input);
    },
    async countUserMessages() {
      return 0;
    },
    async updateSession(_sessionId: string, patch: Record<string, unknown>) {
      Object.assign(row, patch);
    },
    async upsertAgentPlan() {
      return { id: "plan_1" };
    },
  } as unknown as CraftStore;

  const signals = createInProcessConnectAppSignals();
  const gateway = createSandboxGateway({
    config,
    connectionFor: () => ({
      botId: "craft",
      baseUrl: "http://craft-sandbox.test",
      token: null,
    }),
    fetchImpl: gatewayFetch,
  });
  const manager = new CraftSessionManager({
    config,
    store,
    gateway,
    llmConfigFor: async () => ({}) as never,
    botIdFor: async () => "craft",
    approvals: null,
    approvalSignals: null,
    connectAppSignals: signals,
  });
  const turnState = createTurnStateStore({ redis: null, config });
  const fence = createInterruptFence(null);
  const executor = createTurnExecutor({
    db: {} as Database,
    config,
    store,
    manager,
    turnState,
    fence,
    botIdFor: async () => "craft",
    gateway,
  });

  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createMessageRoutes(fakeRequireUser("u1"), {
      config,
      store,
      manager,
      turnState,
      executor,
      botIdFor: async () => "craft",
      fence,
    }),
  );
  app.route(
    "/",
    createTurnRoutes(fakeRequireUser("u1"), {
      config,
      store,
      manager,
      turnState,
      executor,
      botIdFor: async () => "craft",
      approvalSignals: null,
      connectAppSignals: signals,
    }),
  );

  return {
    app,
    emit,
    calls,
    promptPosts,
    permissionAnswers,
    turnState,
    fence,
    signals,
    store,
    row,
    executor,
  };
}

const waitFor = async (
  probe: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error("waitFor: condition never met");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Attach the real SSE endpoint and collect its bytes until stop(). */
async function attachSse(
  app: Hono<{ Variables: AppVariables }>,
  turnId: string,
): Promise<{ text: () => string; stop: () => Promise<void> }> {
  const response = await app.request(
    `/sessions/cs-sess/turns/${turnId}/events`,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const pump = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      seen += decoder.decode(chunk.value, { stream: true });
    }
  })();
  return {
    text: () => seen,
    stop: async () => {
      await reader.cancel();
      await pump.catch(() => undefined);
    },
  };
}

describe("F-G: the connect_app card rides the turn SSE attach stream", () => {
  test("ask → connect_app_request frame + keepalives; expiry → one reject, declined result, no inactivity abort", async () => {
    const h = createHarness();
    const turn = await h.turnState.createInteractiveTurn({
      sessionId: "cs-sess",
      userId: "u1",
      clientRequestId: "cr-fg",
      prompt: "please connect slack",
      turnIndex: 0,
    });
    // Start the runner exactly the way send-message does (it claims the turn).
    h.executor.startInteractiveTurnRunner(turn.turnId);

    await waitFor(() => h.promptPosts() === 1);

    const sse = await attachSse(h.app, turn.turnId);

    // The ask parks the turn the way the live sandbox does.
    h.emit(RAW_ASK);

    // The card is the request_id's only egress — it must arrive on the SSE.
    await waitFor(() => h.signals.peekAnnouncements("cs-sess").length === 0);
    await waitFor(() => sse.text().includes('"type":"connect_app_request"'));
    expect(sse.text()).toContain('"external_app_id":7');
    expect(sse.text()).toContain('"reason":"Need Slack to post updates"');
    // Keepalives bridge the parked silence (the verifier saw none — pin them).
    await waitFor(() => sse.text().includes(": keepalive"));

    // Window expiry (1s) declines upstream: one reject, exactly once.
    await waitFor(() => h.permissionAnswers().length === 1);
    expect(h.permissionAnswers()[0]?.path).toContain(
      `/session/${OPENCODE_SESSION}/permissions/perm_1`,
    );
    expect(JSON.parse(h.permissionAnswers()[0]?.body ?? "{}")).toEqual({
      response: "reject",
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(h.permissionAnswers()).toHaveLength(1);
    // The step ends via the decline — NOT an inactivity abort.
    expect(sse.text()).not.toContain('"type":"error"');
    expect((await h.turnState.getTurn(turn.turnId))?.status).toBe("RUNNING");

    // The declined tool result lands (model sees it), the turn completes.
    h.emit(RAW_DECLINED_TOOL_RESULT);
    h.emit(RAW_IDLE);
    await waitFor(
      async () =>
        (await h.turnState.getTurn(turn.turnId))?.status === "SUCCEEDED",
    );
    expect(JSON.stringify(h.store.messages)).toContain(
      "The user declined to connect external app 7",
    );
    // The attach stream rode the SAME opencode session as the runner (the
    // row's id — not a re-minted one), so the turn's own events reached it
    // too, not just the card and keepalives.
    expect(sse.text()).toContain('"type":"tool_call_progress"');

    await sse.stop();
  }, 20000);
});

describe("F-H: the interrupt fence must not leak into later turns", () => {
  test("interrupt cancels the live turn; the NEXT turn still runs", async () => {
    const h = createHarness();

    // Turn 1: admit through the real send-message endpoint, let it start.
    const first = await h.app.request("/sessions/cs-sess/send-message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "do a long thing",
        client_request_id: "cr-fh-1",
      }),
    });
    expect(first.status).toBe(200);
    const turn1 = (await first.json()) as { turn_id: string };
    await waitFor(() => h.promptPosts() === 1);

    // Interrupt: fence + direct abort. The runner observes the fence (~1s
    // poll) and records the turn CANCELLED.
    const interrupt = await h.app.request("/sessions/cs-sess/interrupt", {
      method: "POST",
    });
    expect(await interrupt.json()).toEqual({ interrupted: true });
    await waitFor(
      async () =>
        (await h.turnState.getTurn(turn1.turn_id))?.status === "CANCELLED",
    );

    // Turn 2 must run: the fence belongs to turn 1 only. (RED pre-fix: the
    // leaked fence cancels turn 2 within a second — no output, no error row.)
    const second = await h.app.request("/sessions/cs-sess/send-message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "try that again",
        client_request_id: "cr-fh-2",
      }),
    });
    expect(second.status).toBe(200);
    const turn2 = (await second.json()) as { turn_id: string };

    await waitFor(() => h.promptPosts() === 2); // turn 2's runner is live
    // Hold turn 2 open past the runner's 1s interrupt-poll cadence: a leaked
    // fence cancels it right there (RED), a cleared one lets it finish.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    h.emit(RAW_IDLE); // turn 2's answer finishes at once
    await waitFor(
      async () =>
        (await h.turnState.getTurn(turn2.turn_id))?.status === "SUCCEEDED",
      6000,
    );
    expect(h.promptPosts()).toBe(2);
    // No phantom failure/error row for the post-interrupt turn.
    expect(JSON.stringify(h.store.messages)).not.toContain('"type":"error"');
  }, 20000);
});
