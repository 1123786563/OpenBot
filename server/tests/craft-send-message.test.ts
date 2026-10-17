import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { loadCraftConfig } from "../src/craft/config";
import type { CraftSessionManager } from "../src/craft/manager";
import { createMessageRoutes } from "../src/craft/message-routes";
import type { InterruptFence } from "../src/craft/interrupt";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import type { TurnExecutor } from "../src/craft/turn-executor";
import {
  createInProcessTurnStateStore,
  type TurnStateStore,
} from "../src/craft/turn-state";

/**
 * POST /sessions/:id/send-message — port of onyx's send-message contract
 * (`tests/integration/tests/craft/test_messages_api.py` semantics, unit-driven): idempotent by
 * client_request_id (a retry gets the same turn back and never duplicates the USER row), 409
 * while a live turn holds the session, attachment paths validated to live under `attachments/`
 * (only image/* ride the prompt), the USER row written under the admission lock, and the runner
 * started fire-and-forget.
 *
 * The turn-state store is the real in-process one (the CAS under admission); the DB and the
 * executor are in-memory fakes at the transport boundary.
 */

const SESSION_ID = "cs-sess";
const USER_ID = "u1";

const config = loadCraftConfig({});

function fakeRequireUser(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id: USER_ID, email: "u1@example.com", role: "user" });
    await next();
  };
}

function sessionRow(): CraftSessionRow {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    name: null,
    status: "active",
    lastActivityAt: new Date(),
    createdAt: new Date(),
    nextjsPort: null,
    sharingScope: "private",
    origin: "INTERACTIVE",
    opencodeSessionId: null,
    agentProvider: "anthropic",
    agentModel: "claude-sonnet",
    skillsHash: null,
    mcpConfigHash: null,
  };
}

type RecordedMessage = {
  sessionId: string;
  type: string;
  turnIndex: number;
  messageMetadata: Record<string, unknown>;
};

function fakeStore(options: { failUserMessagesOnce?: boolean } = {}) {
  const messages: RecordedMessage[] = [];
  const sessionPatches: Array<Record<string, unknown>> = [];
  let failedOnce = false;
  const store: CraftStore = {
    async getSession(sessionId, userId) {
      return sessionId === SESSION_ID && userId === USER_ID ? sessionRow() : undefined;
    },
    async updateSessionActivity() {},
    async countUserMessages(sessionId) {
      return messages.filter((m) => m.sessionId === sessionId && m.type === "user").length;
    },
    async createMessage(input) {
      if (input.type === "user" && options.failUserMessagesOnce && !failedOnce) {
        failedOnce = true;
        throw new Error("db down");
      }
      messages.push(input);
      return { id: `cm-${messages.length}`, ...input } as never;
    },
    async updateSession(_sessionId, patch) {
      sessionPatches.push(patch);
      return sessionRow();
    },
  } as unknown as CraftStore;
  return { store, messages: () => messages, sessionPatches };
}

function fakeExecutor() {
  const started: string[] = [];
  const executor = {
    startInteractiveTurnRunner(turnId: string) {
      started.push(turnId);
    },
  } as unknown as TurnExecutor;
  return { executor, started };
}

function buildApp(store: CraftStore, turnState: TurnStateStore, executor: TurnExecutor) {
  return createMessageRoutes(fakeRequireUser(), {
    config,
    store,
    manager: {} as unknown as CraftSessionManager,
    turnState,
    executor,
    botIdFor: async () => "bot-1",
    fence: {
      requestInterrupt: async () => undefined,
      clearInterrupt: async () => undefined,
    } as unknown as InterruptFence,
  });
}

function sendRequest(
  app: ReturnType<typeof buildApp>,
  body: Record<string, unknown>,
  sessionId = SESSION_ID,
) {
  return app.request(`/sessions/${sessionId}/send-message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const userRows = (messages: RecordedMessage[]) =>
  messages.filter((message) => message.type === "user");

// ───────────────────────── idempotency ─────────────────────────

describe("POST /send-message — idempotency (client_request_id)", () => {
  test("a retry with the same client_request_id returns the same turn, one USER row, one runner start", async () => {
    const { store, messages } = fakeStore();
    const turnState = createInProcessTurnStateStore({ config });
    const { executor, started } = fakeExecutor();
    const app = buildApp(store, turnState, executor);

    const first = await sendRequest(app, {
      content: "hello",
      client_request_id: "req-1",
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody.session_id).toBe(SESSION_ID);
    expect(firstBody.turn_index).toBe(0);
    expect(["QUEUED", "RUNNING"]).toContain(firstBody.status);

    const same = await sendRequest(app, {
      content: "hello",
      client_request_id: "req-1",
    });
    expect(same.status).toBe(200);
    const sameBody = (await same.json()) as Record<string, string>;
    expect(sameBody.turn_id).toBe(firstBody.turn_id);

    // Exactly one USER row and one runner start across both requests.
    expect(userRows(messages())).toHaveLength(1);
    expect(userRows(messages())[0].messageMetadata).toMatchObject({
      type: "user_message",
      content: { type: "text", text: "hello" },
    });
    expect(userRows(messages())[0].turnIndex).toBe(0);
    expect(started).toEqual([firstBody.turn_id]);
  });

  test("idempotency survives turn completion: a post-finish retry resolves the finished turn", async () => {
    const { store, messages } = fakeStore();
    const turnState = createInProcessTurnStateStore({ config });
    const { executor, started } = fakeExecutor();
    const app = buildApp(store, turnState, executor);

    const first = await sendRequest(app, { content: "hello", client_request_id: "req-1" });
    const { turn_id: turnId } = (await first.json()) as Record<string, string>;
    const claimed = await turnState.claimTurnForRunner(turnId);
    await turnState.finishTurn({
      turnId,
      status: "SUCCEEDED",
      runnerId: claimed?.runnerId,
    });

    const retry = await sendRequest(app, { content: "hello", client_request_id: "req-1" });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as Record<string, string>;
    expect(retryBody.turn_id).toBe(turnId);
    expect(retryBody.status).toBe("SUCCEEDED");
    // Still one USER row; the runner was only ever started for the live turn.
    expect(userRows(messages())).toHaveLength(1);
    expect(started).toEqual([turnId]);
  });

  test("when the USER-row write fails, the turn is finished FAILED and a retry resolves it", async () => {
    const { store, messages } = fakeStore({ failUserMessagesOnce: true });
    const turnState = createInProcessTurnStateStore({ config });
    const { executor, started } = fakeExecutor();
    const app = buildApp(store, turnState, executor);

    const failed = await sendRequest(app, { content: "hello", client_request_id: "req-1" });
    expect(failed.status).toBe(500); // the row-write error propagates after the FAILED finish
    expect(started).toEqual([]); // runner never started

    // The retry with the same request id resolves the FAILED turn — no duplicate row.
    const retry = await sendRequest(app, { content: "hello", client_request_id: "req-1" });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as Record<string, string>;
    expect(retryBody.status).toBe("FAILED");
    expect(userRows(messages())).toHaveLength(0);
    const finished = await turnState.getTurn(retryBody.turn_id);
    expect(finished?.status).toBe("FAILED");
    expect(finished?.errorDetail).toBe("Failed to persist user message.");
  });

  test("different client_request_ids are different turns — but the second bounces off the live first (409)", async () => {
    const { store, messages } = fakeStore();
    const turnState = createInProcessTurnStateStore({ config });
    const { executor } = fakeExecutor();
    const app = buildApp(store, turnState, executor);

    const first = await sendRequest(app, { content: "hello", client_request_id: "req-1" });
    expect(first.status).toBe(200);

    const second = await sendRequest(app, { content: "again", client_request_id: "req-2" });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("This session is busy with a previous turn.");

    // The rejected send wrote no USER row.
    expect(userRows(messages())).toHaveLength(1);
  });
});

// ───────────────────────── admission guards ─────────────────────────

describe("POST /send-message — admission guards", () => {
  test("missing or empty content is a 400", async () => {
    const harness = fakeStore();
    const app = buildApp(
      harness.store,
      createInProcessTurnStateStore({ config }),
      fakeExecutor().executor,
    );
    expect((await sendRequest(app, {})).status).toBe(400);
    expect((await sendRequest(app, { content: "" })).status).toBe(400);
  });

  test("an unknown session (or another user's session) is a 404", async () => {
    const harness = fakeStore();
    const app = buildApp(
      harness.store,
      createInProcessTurnStateStore({ config }),
      fakeExecutor().executor,
    );
    const response = await sendRequest(app, { content: "hi" }, "cs-other");
    expect(response.status).toBe(404);
  });

  test("turn_index counts prior USER rows: the second admitted turn is index 1", async () => {
    const { store, messages } = fakeStore();
    const turnState = createInProcessTurnStateStore({ config });
    const { executor } = fakeExecutor();
    const app = buildApp(store, turnState, executor);

    const first = await sendRequest(app, { content: "one", client_request_id: "r1" });
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody.turn_index).toBe(0);

    const turnId = firstBody.turn_id as string;
    const claimed = await turnState.claimTurnForRunner(turnId);
    await turnState.finishTurn({
      turnId,
      status: "SUCCEEDED",
      runnerId: claimed?.runnerId,
    });

    const second = await sendRequest(app, { content: "two", client_request_id: "r2" });
    expect(((await second.json()) as Record<string, unknown>).turn_index).toBe(1);
    expect(userRows(messages())).toHaveLength(2);
  });
});

// ───────────────────────── attachments ─────────────────────────

describe("POST /send-message — attachment validation", () => {
  const validBody = (path: string, extra: Record<string, unknown> = {}) => ({
    content: "look at this",
    client_request_id: `req-${Math.random().toString(36).slice(2)}`,
    attachments: [{ name: "shot.png", path, mime_type: "image/png", ...extra }],
  });

  test("paths outside attachments/ are rejected with 400", async () => {
    for (const path of [
      "../outside.png", // traversal
      "/etc/passwd", // absolute
      "file.txt", // not session-relative, < 2 parts
      "workspace/file.txt", // wrong root
      "attachments/../secret.txt", // traversal inside the prefix
    ]) {
      const harness = fakeStore();
      const turnState = createInProcessTurnStateStore({ config });
      const app = buildApp(harness.store, turnState, fakeExecutor().executor);
      const response = await sendRequest(app, validBody(path));
      expect(response.status, `path ${path}`).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe(
        "Attachment path must be inside the attachments directory",
      );
      // Nothing was admitted: no turn became active.
      expect(
        await turnState.getActiveTurn({ sessionId: SESSION_ID, userId: USER_ID }),
      ).toBeNull();
    }
  });

  test("a malformed attachment entry (missing or non-string name / mime_type) is a 400", async () => {
    const entries = [
      { path: "attachments/shot.png", mime_type: "image/png" }, // name missing
      { path: "attachments/shot.png", name: "shot.png" }, // mime_type missing
      { path: "attachments/shot.png", name: 42, mime_type: "image/png" }, // non-string name
      { path: "attachments/shot.png", name: "shot.png", mime_type: null }, // null mime_type
    ];
    for (const attachment of entries) {
      const harness = fakeStore();
      const app = buildApp(
        harness.store,
        createInProcessTurnStateStore({ config }),
        fakeExecutor().executor,
      );
      const response = await sendRequest(app, {
        content: "look at this",
        client_request_id: `req-${Math.random().toString(36).slice(2)}`,
        attachments: [attachment],
      });
      expect(response.status, `attachment ${JSON.stringify(attachment)}`).toBe(400);
    }
  });

  test("a valid image attachment rides the prompt turn and lands in the USER row", async () => {
    const { store, messages } = fakeStore();
    const turnState = createInProcessTurnStateStore({ config });
    const app = buildApp(store, turnState, fakeExecutor().executor);

    const response = await sendRequest(app, validBody("attachments/shot.png"));
    expect(response.status).toBe(200);
    const { turn_id: turnId } = (await response.json()) as Record<string, string>;

    const turn = await turnState.getTurn(turnId);
    expect(turn?.attachments).toEqual([
      { name: "shot.png", path: "attachments/shot.png", mimeType: "image/png" },
    ]);
    const metadata = userRows(messages())[0].messageMetadata;
    expect(metadata.attachments).toEqual([
      { name: "shot.png", path: "attachments/shot.png", mime_type: "image/png" },
    ]);
  });

  test("a non-image attachment is recorded on the USER row but does not ride the prompt", async () => {
    const { store, messages } = fakeStore();
    const turnState = createInProcessTurnStateStore({ config });
    const app = buildApp(store, turnState, fakeExecutor().executor);

    const response = await sendRequest(
      app,
      validBody("attachments/doc.pdf", { name: "doc.pdf", mime_type: "application/pdf" }),
    );
    expect(response.status).toBe(200);
    const { turn_id: turnId } = (await response.json()) as Record<string, string>;

    const turn = await turnState.getTurn(turnId);
    expect(turn?.attachments).toEqual([]); // only image/* ride the prompt
    const metadata = userRows(messages())[0].messageMetadata;
    expect(metadata.attachments).toEqual([
      { name: "doc.pdf", path: "attachments/doc.pdf", mime_type: "application/pdf" },
    ]);
  });
});

// ───────────────────────── model override ─────────────────────────

describe("POST /send-message — per-message model override", () => {
  test("provider + model together update the session; a lone model does not", async () => {
    const { store, sessionPatches } = fakeStore();
    const app = buildApp(
      store,
      createInProcessTurnStateStore({ config }),
      fakeExecutor().executor,
    );

    const both = await sendRequest(app, {
      content: "hi",
      client_request_id: "r-both",
      provider: "openai",
      model: "gpt-5",
    });
    expect(both.status).toBe(200);
    expect(sessionPatches).toEqual([{ agentProvider: "openai", agentModel: "gpt-5" }]);

    const patchesBefore = sessionPatches.length;
    const lone = await sendRequest(app, {
      content: "hi",
      client_request_id: "r-lone",
      model: "gpt-5",
    });
    expect(lone.status).toBe(409); // the previous turn is still live
    expect(sessionPatches.length).toBe(patchesBefore);
  });
});
