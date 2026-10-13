import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { loadCraftConfig } from "../src/craft/config";
import { subagentStartedPacket } from "../src/craft/events/packets";
import { SSEKeepalive } from "../src/craft/events/types";
import { CraftSessionManager } from "../src/craft/manager";
import type { SandboxGateway } from "../src/craft/sandbox-gateway";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import { createSubagentRoutes } from "../src/craft/subagent-routes";
import { sessionDirectory } from "../src/craft/workspace";

/**
 * The subagent direct-push endpoint's HTTP contract (onyx messages.py's
 * /subagents/{subagent_session_id}/send-message): ownership-checked like every session route,
 * body `{content}` with extra=forbid, and a synchronous SSE stream in the turn wire that closes
 * on the terminal frame. The sandbox side is a scripted serve client behind a fake gateway, so
 * the manager's delegation (target session id + directory + content) is asserted on the way by.
 */

function fakeRequireUser(
  userId = "u1",
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: userId,
      email: `${userId}@example.com`,
      role: "user",
    });
    await next();
  };
}

function sessionRow(overrides: Partial<CraftSessionRow> = {}): CraftSessionRow {
  return {
    id: "cs-1",
    userId: "u1",
    name: "Session",
    status: "active",
    lastActivityAt: new Date("2026-01-01T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    nextjsPort: null,
    sharingScope: "private",
    origin: "INTERACTIVE",
    opencodeSessionId: "oc-parent",
    agentProvider: null,
    agentModel: null,
    skillsHash: null,
    mcpConfigHash: null,
    ...overrides,
  };
}

function fakeStore(session: CraftSessionRow | undefined): CraftStore {
  return {
    async getSession(id, userId) {
      return id === session?.id && userId === session?.userId
        ? session
        : undefined;
    },
  } as unknown as CraftStore;
}

/** A scripted serve client: records the manager's call, replays a canned event list. */
function fakeManagerWithScript(script: () => Promise<Array<object>>): {
  manager: CraftSessionManager;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    async *sendMessage(
      opencodeSessionId: string,
      message: string,
      options: Record<string, unknown>,
    ) {
      calls.push({ opencodeSessionId, message, ...options });
      for (const event of await script()) {
        yield event as never;
      }
    },
  };
  const gateway = {
    serveClientFor: () => client,
    eventBusFor: () => null,
  } as unknown as SandboxGateway;
  const config = loadCraftConfig({});
  const manager = new CraftSessionManager({
    config,
    store: fakeStore(sessionRow()),
    gateway,
    llmConfigFor: async () =>
      ({
        provider: "p",
        modelName: "m",
        apiKey: null,
        apiBase: null,
        displayName: null,
        models: null,
      }) as never,
    botIdFor: async () => "bot-1",
  });
  return { manager, calls };
}

function appFixture(input: {
  script?: () => Promise<Array<object>>;
  /** null = the session does not exist; undefined = the default u1-owned row. */
  session?: CraftSessionRow | null;
  userId?: string;
}) {
  const session = input.session === undefined ? sessionRow() : input.session;
  const { manager, calls } = fakeManagerWithScript(
    input.script ?? (async () => []),
  );
  const config = loadCraftConfig({});
  const app = createSubagentRoutes(fakeRequireUser(input.userId ?? "u1"), {
    store: fakeStore(session ?? undefined),
    manager,
    botIdFor: async () => "bot-1",
  });
  return { app, calls, config };
}

const url = "/sessions/cs-1/subagents/oc-child/send-message";

/** Drain an SSE Response to its full text — the reader ends when the route closes the stream. */
async function sseText(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

// ---------------------------------------------------------------------------
// Admission: auth parity, body validation (extra=forbid), routing deps
// ---------------------------------------------------------------------------

describe("POST /sessions/:id/subagents/:ocSessionId/send-message admission", () => {
  test("404 when the session does not exist", async () => {
    const { app } = appFixture({ session: null });
    const res = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Session not found" });
  });

  test("404 when the session belongs to another user (same strength as send-message)", async () => {
    const { app } = appFixture({ userId: "u2" });
    const res = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(404);
  });

  test("400 when content is missing, empty, or not a string", async () => {
    const { app } = appFixture({});
    const bodies: Array<string | undefined> = [
      undefined, // no body at all
      "{}", // no content key
      '{"content":""}', // empty
      '{"content":5}', // wrong type
    ];
    for (const body of bodies) {
      const res = await app.request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "content is required" });
    }
  });

  test("400 on any extra body field (onyx extra=forbid)", async () => {
    const { app } = appFixture({});
    const res = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi", client_request_id: "x" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "extra fields are not allowed" });
  });

  test("400 when no sandbox backs the session", async () => {
    const session = sessionRow();
    const { manager } = fakeManagerWithScript(async () => []);
    const app = createSubagentRoutes(fakeRequireUser(), {
      store: fakeStore(session),
      manager,
      botIdFor: async () => null,
    });
    const res = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "No sandbox configured for this session.",
    });
  });

  test("drives the SUBAGENT opencode session in the session's directory", async () => {
    const { app, calls, config } = appFixture({
      script: async () => [{ stopReason: "end_turn" }],
    });
    const res = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "go deeper" }),
    });
    expect(res.status).toBe(200);
    await sseText(res);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      opencodeSessionId: "oc-child",
      message: "go deeper",
      directory: sessionDirectory("cs-1", config.sessionDirectoryMode),
    });
  });
});

// ---------------------------------------------------------------------------
// The stream: turn-SSE wire, _meta passthrough, terminal close
// ---------------------------------------------------------------------------

describe("POST /sessions/:id/subagents/:ocSessionId/send-message stream", () => {
  test("streams the turn wire byte-for-byte and closes on prompt_response", async () => {
    const { app } = appFixture({
      script: async () => [
        new SSEKeepalive(),
        subagentStartedPacket("oc-grandchild", "oc-child"),
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "working" },
          _meta: { sessionId: "oc-child", parentSessionId: "oc-parent" },
        },
        { stopReason: "end_turn" },
      ],
    });

    const res = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const text = await sseText(res);
    // Keepalive rides the comment line; events ride `event: message` data frames.
    expect(text).toContain(": keepalive\n\n");
    expect(text).toContain(
      'event: message\ndata: {"sessionUpdate":"agent_message_chunk"',
    );
    // The routing _meta passes through untouched — the frontend routes on it verbatim.
    expect(text).toContain(
      '"_meta":{"sessionId":"oc-child","parentSessionId":"oc-parent"}',
    );
    expect(text).toContain('"type":"subagent_started"');
    // The terminal frame closes the stream — nothing after prompt_response.
    const terminalIndex = text.indexOf('"type":"prompt_response"');
    expect(terminalIndex).toBeGreaterThan(0);
    expect(text.slice(terminalIndex)).not.toContain("agent_message_chunk");
  });

  test("closes on an error frame (the terminal pair, not just prompt_response)", async () => {
    const { app } = appFixture({
      script: async () => [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "partial" },
        },
        { code: -1, message: "session error" },
        { stopReason: "end_turn" }, // must never go out after the error frame
      ],
    });

    const res = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
    const text = await sseText(res);
    expect(text).toContain('"type":"error"');
    expect(text).toContain('"message":"session error"');
    expect(text).not.toContain('"type":"prompt_response"');
  });

  test("a generator failure becomes one error frame, then the stream closes", async () => {
    const { app } = appFixture({
      script: async () => {
        throw new Error("no sandbox serve client");
      },
    });
    const res = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
    const text = await sseText(res);
    expect(text).toContain('"type":"error"');
    expect(text).toContain("no sandbox serve client");
  });
});
