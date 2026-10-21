import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  type AbstractAgent,
  type BaseEvent,
  EventType,
  HttpAgent,
  type RunAgentInput,
} from "@ag-ui/client";
import { Hono } from "hono";
import { Observable } from "rxjs";
import { parseApprovalContinuation } from "../src/approvals/types";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import {
  ComputerUnavailableError,
  ComputerUnreachableError,
} from "../src/computer/client";
import type { ComputerGateway } from "../src/computer/gateway";
import {
  createHeadlessComputerTools,
  HeadlessToolSuspension,
} from "../src/computer/headless-tools";
import type {
  SignInCodeInput,
  SignInCodeResult,
  SignInFillInput,
  SignInFillResult,
} from "../src/computer/schema";
import {
  createPasswordRoutes,
  createSignInRoutes,
} from "../src/passwords/routes";
import {
  createSignInService,
  isFinalSignIn,
  signInToolResult,
} from "../src/passwords/service";
import { createMemoryPasswordStore } from "../src/passwords/store";
import { originOf, type SignInRequestRecord } from "../src/passwords/types";
import { createTurnRunner, type RunnerLike } from "../src/routines/run-turn";

/**
 * The private sign-in request and the Passwords vault, as properties:
 *  - a submitted password never appears in an AG-UI event, a model request, a stored row, an audit
 *    payload or a route response;
 *  - the computer is the only thing that receives it;
 *  - a saved login is used only when its owner confirms it, only on its own origin, and only while
 *    the password manager is on.
 */

const PASSWORD = "Tr0ub4dor&3-never-show-me";
const USERNAME = "alice.private@example.test";
const CODE = "918273";
const KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * The computer as the service sees it. Every call is recorded, and the answers are shaped by the
 * caller: `fill` for the password step, `code` for the verification-code step. `gate` holds one
 * named call open — a delivery whose outcome nobody knows yet — until `letGo()` runs. `fail` makes a
 * named step throw; it is held by reference, so a test can clear a failure to retry.
 */
function fakeGateway(
  fill: Partial<SignInFillResult> = {},
  code: Partial<SignInCodeResult> = {},
  gate: "signIn" | "signInCode" | null = null,
  fail: { signIn?: Error; signInCode?: Error } = {},
) {
  const fills: SignInFillInput[] = [];
  const codes: SignInCodeInput[] = [];
  const helps: string[] = [];
  let letGo: () => void = () => {};
  const delivery = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  const gateway: Pick<
    ComputerGateway,
    "signIn" | "signInCode" | "requestHelp"
  > = {
    async signIn(_botId, input) {
      fills.push(input);
      if (gate === "signIn") await delivery;
      if (fail.signIn) throw fail.signIn;
      return {
        submitted: true,
        passwordFieldVisible: false,
        url: "https://example.com/home",
        ...fill,
      };
    },
    async signInCode(_botId, input) {
      codes.push(input);
      if (gate === "signInCode") await delivery;
      if (fail.signInCode) throw fail.signInCode;
      return {
        submitted: true,
        codeFieldVisible: false,
        passwordFieldVisible: false,
        url: "https://example.com/home",
        ...code,
      };
    },
    async requestHelp(_botId, _actor, reason) {
      helps.push(reason);
      return {
        holder: "bot",
        request: { id: "control-1" },
      } as unknown as Awaited<ReturnType<ComputerGateway["requestHelp"]>>;
    },
  };
  return { gateway, fills, codes, helps, letGo };
}

function audit() {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  return { rows, store };
}

function setup(
  options: {
    manager?: boolean;
    fill?: Partial<SignInFillResult>;
    code?: Partial<SignInCodeResult>;
    gate?: "signIn" | "signInCode" | null;
    fail?: { signIn?: Error; signInCode?: Error };
  } = {},
) {
  const store = createMemoryPasswordStore();
  const fail = options.fail ?? {};
  const computer = fakeGateway(
    options.fill,
    options.code,
    options.gate ?? null,
    fail,
  );
  const trail = audit();
  const resolved: SignInRequestRecord[] = [];
  const service = createSignInService({
    store,
    gateway: computer.gateway,
    encryptionKey: KEY,
    auditStore: trail.store,
    passwordManagerEnabled: async () => options.manager ?? true,
    onResolved: async (request) => void resolved.push(request),
  });
  return { store, computer, trail, service, resolved };
}

/** A request the site has taken the password for and asked a verification code after. */
async function withCodeStep(
  options: Parameters<typeof setup>[0] = {},
  credential: { username?: string; password: string; save?: boolean } = {},
) {
  const context = setup(options);
  const request = await context.service.request({
    ownerUserId: "owner",
    botId: "bot",
    site: "https://example.com/login",
    actor,
  });
  await context.service.submit("owner", request.id, actor, {
    username: credential.username ?? USERNAME,
    password: credential.password ?? PASSWORD,
    ...(credential.save === undefined ? {} : { save: credential.save }),
  });
  return { ...context, request };
}

/** Waits until the request is in `status`, so a test interleaves at a real boundary, not a guess. */
async function untilStatus(
  store: ReturnType<typeof createMemoryPasswordStore>,
  requestId: string,
  status: string,
) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const row = await store.request("owner", requestId);
    if (row?.status === status) return row;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the request never reached ${status}`);
}

const actor = {
  id: "owner",
  userId: "owner",
  initiator: { kind: "person" as const },
};

function everything(...values: unknown[]) {
  return JSON.stringify(values);
}

function expectNoCredential(text: string) {
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(CODE);
}

describe("the site a login belongs to", () => {
  test("is an exact origin, never a path, and never carries credentials", () => {
    expect(originOf("example.com/login?next=/")).toBe("https://example.com");
    expect(originOf("http://127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080");
    expect(() => originOf("ftp://example.com")).toThrow();
    expect(() => originOf("https://user:pw@example.com")).toThrow();
  });
});

describe("a sign-in request answered with a typed login", () => {
  test("types it through the computer and tells the Bot only that it worked", async () => {
    const { service, computer, trail, store, resolved } = setup();
    const request = await service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "https://example.com/login",
      reason: "to read the dashboard",
      actor,
    });
    const view = await service.submit("owner", request.id, actor, {
      username: USERNAME,
      password: PASSWORD,
      save: true,
    });
    expect(view.status).toBe("signed_in");
    // No code goes with the password, ever: a code is asked for only after the site has it.
    expect(computer.fills).toEqual([
      {
        origin: "https://example.com",
        username: USERNAME,
        password: PASSWORD,
      },
    ]);
    const done = resolved[0];
    if (!done) throw new Error("not resolved");
    const toolResult = signInToolResult(done);
    expect(toolResult).toMatchObject({
      ok: true,
      signedIn: true,
      site: "https://example.com",
    });
    // Saved, encrypted.
    const [saved] = await store.logins("owner");
    expect(saved?.username).toBe(USERNAME);
    expect(saved?.encryptedPassword).not.toContain(PASSWORD);
    const logins = await service.logins("owner");
    expectNoCredential(
      everything(
        view,
        toolResult,
        trail.rows,
        [...store.requests.values()],
        logins,
      ),
    );
    // And no username in the audit trail or the Bot's answer either.
    expect(everything(trail.rows, toolResult)).not.toContain(USERNAME);
    // Saved after the sign-in is recorded, so a failed save cannot leave the request half done.
    expect(trail.rows.map((row) => row.eventType)).toEqual([
      "computer.sign_in_requested",
      "computer.sign_in_completed",
      "password.saved",
    ]);
  });

  test("a login the site rejects reopens the request and stores nothing", async () => {
    const { service, store, trail } = setup({
      fill: { passwordFieldVisible: true },
    });
    const request = await service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    await expect(
      service.submit("owner", request.id, actor, {
        username: USERNAME,
        password: PASSWORD,
        save: true,
      }),
    ).rejects.toThrow(/password field/);
    expect((await service.get("owner", request.id)).status).toBe("pending");
    expect(await store.logins("owner")).toEqual([]);
    expectNoCredential(everything(trail.rows, [...store.requests.values()]));
  });

  test("an error the computer words is scrubbed of anything the person typed", async () => {
    const { service, trail, store } = setup({
      fill: { error: `could not type ${PASSWORD} into the field` },
    });
    const request = await service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    const failure = await service
      .submit("owner", request.id, actor, { password: PASSWORD })
      .catch((error: Error) => error.message);
    expectNoCredential(
      everything(failure, trail.rows, [...store.requests.values()]),
    );
  });
});

describe("a saved login", () => {
  async function withSaved(options: { manager?: boolean } = {}) {
    const context = setup(options);
    const first = await context.service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    await context.service.submit("owner", first.id, actor, {
      username: USERNAME,
      password: PASSWORD,
      save: true,
    });
    const [login] = await context.store.logins("owner");
    if (!login) throw new Error("not saved");
    context.computer.fills.length = 0;
    return { ...context, login };
  }

  test("is offered by username only, and used only when its owner confirms it", async () => {
    const { service, computer, login } = await withSaved();
    const next = await service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "https://example.com/other",
      actor,
    });
    const view = await service.get("owner", next.id);
    expect(view.savedLogins).toEqual([{ id: login.id, username: USERNAME }]);
    expectNoCredential(JSON.stringify(view));
    // Nothing is typed until the owner chooses it.
    expect(computer.fills).toEqual([]);
    const done = await service.useSaved("owner", next.id, actor, {
      loginId: login.id,
    });
    expect(done.status).toBe("signed_in");
    expect(done.method).toBe("saved");
    expect(computer.fills).toEqual([
      { origin: "https://example.com", username: USERNAME, password: PASSWORD },
    ]);
  });

  test("is never typed into another origin", async () => {
    const { service, computer, login } = await withSaved();
    const elsewhere = await service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "https://example.com.evil.test",
      actor,
    });
    expect((await service.get("owner", elsewhere.id)).savedLogins).toEqual([]);
    await expect(
      service.useSaved("owner", elsewhere.id, actor, { loginId: login.id }),
    ).rejects.toThrow(/not for this site/);
    expect(computer.fills).toEqual([]);
  });

  test("belongs to its owner alone", async () => {
    const { service, login } = await withSaved();
    const theirs = await service.request({
      ownerUserId: "stranger",
      botId: "bot",
      site: "example.com",
      actor: { id: "stranger", userId: "stranger" },
    });
    await expect(
      service.useSaved("stranger", theirs.id, actor, { loginId: login.id }),
    ).rejects.toThrow(/not for this site/);
    await expect(service.get("stranger", "missing")).rejects.toThrow(/no such/);
    expect((await service.logins("stranger")).logins).toEqual([]);
  });

  test("is neither offered nor saved while the password manager is off", async () => {
    const context = setup({ manager: false });
    const request = await context.service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    const view = await context.service.get("owner", request.id);
    expect(view.passwordManager).toBe(false);
    await expect(
      context.service.submit("owner", request.id, actor, {
        username: USERNAME,
        password: PASSWORD,
        save: true,
      }),
    ).rejects.toThrow(/turned off/);
    expect(await context.store.logins("owner")).toEqual([]);
  });
});

describe("the other answers", () => {
  test("take over hands the person the browser, and finishing tells the Bot", async () => {
    const { service, computer, resolved } = setup();
    const request = await service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    const taken = await service.takeOver("owner", request.id, actor);
    expect(taken.status).toBe("taken_over");
    expect(taken.controlRequestId).toBe("control-1");
    expect(computer.helps[0]).toContain("Sign in to https://example.com");
    const done = await service.finishTakeover("owner", request.id, actor);
    expect(done.method).toBe("takeover");
    expect(resolved).toHaveLength(1);
  });

  test("declining closes it, and the Bot is told not to ask another way", async () => {
    const { service, resolved } = setup();
    const request = await service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    await service.cancel("owner", request.id, actor);
    const result = signInToolResult(resolved[0] as SignInRequestRecord);
    expect(result.signedIn).toBe(false);
    expect(result.result).toContain("Do not ask for the login another way");
    await expect(
      service.submit("owner", request.id, actor, { password: PASSWORD }),
    ).rejects.toThrow(/no longer open/);
  });

  test("an expired request closes itself", async () => {
    const store = createMemoryPasswordStore();
    const service = createSignInService({
      store,
      gateway: fakeGateway().gateway,
      encryptionKey: KEY,
      ttlMs: -1,
    });
    const request = await service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    expect((await service.get("owner", request.id)).status).toBe("expired");
  });
});

describe("the routes", () => {
  function app(context: ReturnType<typeof setup>) {
    const requireUser = async (
      c: { set: (key: "actor", value: AppVariables["actor"]) => void },
      next: () => Promise<void>,
    ) => {
      c.set("actor", {
        id: "owner",
        email: "owner@example.test",
      } as AppVariables["actor"]);
      await next();
    };
    const root = new Hono<{ Variables: AppVariables }>();
    root.route(
      "/api/sign-in-requests",
      createSignInRoutes(
        context.service,
        requireUser as never,
        async (_actor, botId) => botId === "bot",
      ),
    );
    root.route(
      "/api/passwords",
      createPasswordRoutes(context.service, requireUser as never),
    );
    return root;
  }
  const post = (path: string, body: unknown) =>
    new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("never answer with a credential, and refuse a Bot the person cannot use", async () => {
    const context = setup();
    const server = app(context);
    const refused = await server.fetch(
      post("/api/sign-in-requests", { botId: "other", site: "example.com" }),
    );
    expect(refused.status).toBe(404);
    const created = await server.fetch(
      post("/api/sign-in-requests", { botId: "bot", site: "example.com" }),
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const submitted = await server.fetch(
      post(`/api/sign-in-requests/${id}/submit`, {
        username: USERNAME,
        password: PASSWORD,
        // What an old client sends: a code alongside the password. Ignored, never typed.
        code: CODE,
        save: true,
      }),
    );
    expect(submitted.status).toBe(200);
    // The code the old client sent with the password went nowhere near the computer.
    expect(context.computer.fills[0]).not.toHaveProperty("code");
    const bodies = [
      await submitted.text(),
      await (
        await server.fetch(
          new Request(`http://127.0.0.1/api/sign-in-requests/${id}`),
        )
      ).text(),
      await (
        await server.fetch(new Request("http://127.0.0.1/api/passwords"))
      ).text(),
    ];
    for (const body of bodies) expectNoCredential(body);
    expect(bodies[2]).toContain(USERNAME);
  });

  test("an unexpected failure is one fixed sentence, not the error it came from", async () => {
    const context = setup();
    context.store.createRequest = async () => {
      throw new Error(`Failed query: insert ... params: ${PASSWORD}`);
    };
    const response = await app(context).fetch(
      post("/api/sign-in-requests", { botId: "bot", site: "example.com" }),
    );
    expect(response.status).toBe(500);
    expectNoCredential(await response.text());
  });

  test("the code endpoint serves the code step alone, and its field is capped", async () => {
    const context = setup({ fill: { codeRequested: true } });
    const server = app(context);
    const created = await server.fetch(
      post("/api/sign-in-requests", { botId: "bot", site: "example.com" }),
    );
    const { id } = (await created.json()) as { id: string };
    // At pending the site has not asked for a code, and the endpoint says so.
    const early = await server.fetch(
      post(`/api/sign-in-requests/${id}/code`, { code: CODE }),
    );
    expect(early.status).toBe(409);
    await server.fetch(
      post(`/api/sign-in-requests/${id}/submit`, {
        username: USERNAME,
        password: PASSWORD,
      }),
    );
    const submitted = await server.fetch(
      post(`/api/sign-in-requests/${id}/code`, { code: CODE }),
    );
    expect(submitted.status).toBe(200);
    expect(submitted.text()).resolves.not.toContain(CODE);
    expect(context.computer.codes).toEqual([
      { origin: "https://example.com", code: CODE },
    ]);
    // Sixty-four characters, like the other secret fields.
    const tooLong = await server.fetch(
      post(`/api/sign-in-requests/${id}/code`, { code: "9".repeat(65) }),
    );
    expect(tooLong.status).toBe(400);
  });
});

/*
 * The whole path an unattended Bot takes, through the real headless middleware and turn runner:
 * the Bot asks, the turn pauses, the person answers in the form, and the turn resumes. Every AG-UI
 * event, every request the model receives, every audit row and every stored row is then searched
 * for the password.
 */
describe("an unattended turn that needs a sign-in", () => {
  function lifecycle(input: RunAgentInput, body: BaseEvent[]) {
    return [
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      },
      ...body,
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      },
    ];
  }
  function remoteTurn(
    events: (input: RunAgentInput, index: number) => BaseEvent[],
  ) {
    const requests: RunAgentInput[] = [];
    const agent = new HttpAgent({
      agentId: "bot",
      url: "https://agent.example/ag-ui",
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init.body)) as RunAgentInput;
        requests.push(request);
        return new Response(
          events(request, requests.length - 1)
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    return { requests, agent };
  }
  function harness(agent: AbstractAgent, tools: () => Promise<unknown[]>) {
    const persisted: BaseEvent[] = [];
    const runner: RunnerLike = {
      run: ({ agent: selected, input }) =>
        new Observable((subscriber) => {
          selected
            .runAgent(input, {
              onEvent: ({ event }) => {
                persisted.push(event);
                subscriber.next(event);
              },
            })
            .then(
              () => subscriber.complete(),
              (error) => subscriber.error(error),
            );
        }),
      stop: async () => true,
    };
    const run = createTurnRunner({
      intelligence: {
        getOrCreateThread: async () => undefined,
        getThreadMessages: async () => ({ messages: [] }),
        ɵacquireThreadLock: async () => undefined,
        ɵrenewThreadLock: async () => undefined,
        ɵcleanupThreadLock: async () => undefined,
      },
      runner,
      buildAgentFor: async () => agent,
      toolsForTurn: tools as never,
    });
    return { persisted, run };
  }

  test("pauses, resumes with the outcome, and never carries the password", async () => {
    const context = setup();
    const remote = remoteTurn((input, index) =>
      lifecycle(
        input,
        index === 0
          ? [
              {
                type: EventType.TOOL_CALL_START,
                toolCallId: "sign-in-call",
                toolCallName: "computer_request_sign_in",
                parentMessageId: "message-1",
              },
              {
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: "sign-in-call",
                delta: JSON.stringify({ site: "https://example.com/login" }),
              },
              { type: EventType.TOOL_CALL_END, toolCallId: "sign-in-call" },
            ]
          : [
              {
                type: EventType.TEXT_MESSAGE_START,
                messageId: "reply",
                role: "assistant",
              },
              {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: "reply",
                delta: "I am in.",
              },
              { type: EventType.TEXT_MESSAGE_END, messageId: "reply" },
            ],
      ),
    );
    const tools = async () =>
      createHeadlessComputerTools({
        gateway: {} as ComputerGateway,
        botId: "bot",
        actor,
        signIn: context.service,
      }).filter((tool) => tool.definition.name === "computer_request_sign_in");
    const { persisted, run } = harness(remote.agent, tools);
    const paused = await run({
      ownerUserId: "owner",
      routineId: "routine",
      agentId: "bot",
      threadId: "thread",
      instruction: "Check the dashboard",
    }).catch((error: unknown) => error);
    expect(paused).toBeInstanceOf(HeadlessToolSuspension);
    const waiting = (paused as HeadlessToolSuspension).waiting;
    expect(waiting.kind).toBe("computer_sign_in");
    const requestId = String(waiting.signInRequestId);

    await context.service.submit("owner", requestId, actor, {
      username: USERNAME,
      password: PASSWORD,
      save: true,
    });
    const done = context.resolved[0];
    if (!done?.continuation) throw new Error("no continuation saved");
    const snapshot = parseApprovalContinuation(done.continuation);
    expect(snapshot.toolCallId).toBe("sign-in-call");
    const resumed = await run({
      ownerUserId: "owner",
      routineId: "routine",
      agentId: "bot",
      threadId: "thread",
      instruction: "",
      continuation: {
        snapshot,
        result: { content: JSON.stringify(signInToolResult(done)) },
        messageId: `sign-in-result:${done.id}`,
      },
    } as never);
    expect(resumed).toEqual({ replyText: "I am in." });
    expect(context.computer.fills[0]?.password).toBe(PASSWORD);
    const toolMessage = remote.requests[1]?.messages.find(
      (message) => message.role === "tool",
    );
    expect(String(toolMessage?.content)).toContain('"signedIn":true');
    expectNoCredential(
      everything(persisted, remote.requests, context.trail.rows, [
        ...context.store.requests.values(),
      ]),
    );
  });
});

/**
 * A request claimed for typing leaves `filling` on every path. Left there, every later attempt is
 * answered "already being entered" and the waiting turn never resumes.
 */
describe("a sign-in that is being entered", () => {
  test("is refused before anything is typed when saving is off and the person asked to save", async () => {
    const context = setup({ manager: false });
    const request = await context.service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    await expect(
      context.service.submit("owner", request.id, actor, {
        username: USERNAME,
        password: PASSWORD,
        save: true,
      }),
    ).rejects.toThrow(/turned off/);
    expect(context.computer.fills).toHaveLength(0);
    expect((await context.service.get("owner", request.id)).status).toBe(
      "pending",
    );
  });

  test("ends signed in, and the Bot is told, when saving the login fails after the site accepted it", async () => {
    const context = setup();
    context.store.saveLogin = async () => {
      throw new Error("the vault is unavailable");
    };
    const request = await context.service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    await expect(
      context.service.submit("owner", request.id, actor, {
        username: USERNAME,
        password: PASSWORD,
        save: true,
      }),
    ).rejects.toThrow(/could not be saved/);
    expect((await context.service.get("owner", request.id)).status).toBe(
      "signed_in",
    );
    expect(context.resolved.map((row) => row.status)).toEqual(["signed_in"]);
    expectNoCredential(everything(context.trail.rows, context.resolved));
  });

  test("an attempt whose lease ran out is failed as unknown, never silently reopened", async () => {
    const context = setup();
    const request = await context.service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    // What a server that died mid-fill leaves behind.
    await context.store.transition("owner", request.id, ["pending"], {
      status: "filling",
      fillingUntil: new Date(Date.now() - 1_000),
    });
    // Whether the login went through is unknown, so the request does not reopen for a replay: it
    // ends as failed, the waiting turn is told, and a new request is a person's explicit act.
    const view = await context.service.get("owner", request.id);
    expect(view.status).toBe("failed");
    expect(view.outcome).toMatch(/not known whether/);
    expect(context.resolved.map((row) => row.status)).toEqual(["failed"]);
    await expect(
      context.service.submit("owner", request.id, actor, {
        username: USERNAME,
        password: PASSWORD,
      }),
    ).rejects.toThrow(/no longer open/);
    expect(context.computer.fills).toEqual([]);
  });
});

/*
 * The verification code a site asks for after it has taken the password: `code_required`, the
 * private code submission, and every way the request refuses to dress an unknown outcome up as a
 * known one. Every write back is a conditional update, so two racing submissions end with exactly
 * one, and a late response cannot reach a request that has already closed.
 */
describe("a verification code the site asks for after the password", () => {
  test("moves the request to code_required, saves the accepted login, and tells the Bot nothing yet", async () => {
    const { service, store, trail, resolved, computer } = await withCodeStep(
      { fill: { codeRequested: true } },
      { save: true },
    );
    const [row] = [...store.requests.values()];
    expect(row?.status).toBe("code_required");
    expect(row?.fillingUntil).toBeNull();
    expect(row?.method).toBe("typed");
    // No code has been typed, and no turn resumed: waiting for a code is not an outcome.
    expect(computer.codes).toEqual([]);
    expect(resolved).toEqual([]);
    expect(isFinalSignIn("code_required")).toBe(false);
    // The password the site accepted is saved while it is in hand. Never a code.
    const [saved] = await store.logins("owner");
    expect(saved?.username).toBe(USERNAME);
    expect(saved?.encryptedPassword).not.toContain(PASSWORD);
    expect(trail.rows.map((row) => row.eventType)).toEqual([
      "computer.sign_in_requested",
      "computer.sign_in_code_requested",
      "password.saved",
    ]);
    // The pending list still shows the request, so the form can ask for the code.
    expect((await service.pending("owner")).map((r) => r.id)).toEqual([
      row?.id,
    ]);
    expectNoCredential(everything(trail.rows, [...store.requests.values()]));
  });

  test("a failed save of the accepted password leaves the request waiting for the code", async () => {
    const context = setup({ fill: { codeRequested: true } });
    context.store.saveLogin = async () => {
      throw new Error("the vault is unavailable");
    };
    const request = await context.service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    await expect(
      context.service.submit("owner", request.id, actor, {
        username: USERNAME,
        password: PASSWORD,
        save: true,
      }),
    ).rejects.toThrow(/could not be saved/);
    // The site has the password either way, so the request stays at the code step.
    const [row] = [...context.store.requests.values()];
    expect(row?.status).toBe("code_required");
    expect(await context.store.logins("owner")).toEqual([]);
  });

  test("an explicit code is typed through the code endpoint and finishes the sign-in", async () => {
    const { service, request, computer, trail, store, resolved } =
      await withCodeStep({ fill: { codeRequested: true } });
    const view = await service.submitCode("owner", request.id, actor, {
      code: `  ${CODE}  `,
    });
    expect(view.status).toBe("signed_in");
    // Exactly this origin, and the code trimmed of the whitespace a phone pastes around it.
    expect(computer.codes).toEqual([
      { origin: "https://example.com", code: CODE },
    ]);
    expect(resolved.map((row) => row.status)).toEqual(["signed_in"]);
    expect(
      trail.rows.find((row) => row.eventType === "computer.sign_in_completed")
        ?.payload,
    ).toMatchObject({ request: request.id, verificationCode: true });
    expectNoCredential(
      everything(view, trail.rows, [...store.requests.values()]),
    );
  });

  test("a wrong code keeps the request at the code step for an explicit retry", async () => {
    const code = { codeFieldVisible: true, passwordFieldVisible: false };
    const { service, request, computer, trail, store, resolved } =
      await withCodeStep({ fill: { codeRequested: true }, code });
    await expect(
      service.submitCode("owner", request.id, actor, { code: CODE }),
    ).rejects.toThrow(/did not accept that code/);
    const [row] = [...store.requests.values()];
    expect(row?.status).toBe("code_required");
    expect(row?.fillingUntil).toBeNull();
    expect(resolved).toEqual([]);
    expect(
      trail.rows.find((row) => row.eventType === "computer.sign_in_failed")
        ?.payload,
    ).toMatchObject({ request: request.id, step: "code" });
    // The retry is the person's own act: nothing was sent again by itself.
    expect(computer.codes).toHaveLength(1);
    code.codeFieldVisible = false;
    const done = await service.submitCode("owner", request.id, actor, {
      code: CODE,
    });
    expect(done.status).toBe("signed_in");
    expect(computer.codes).toHaveLength(2);
    expect(resolved.map((row) => row.status)).toEqual(["signed_in"]);
    expectNoCredential(everything(trail.rows, [...store.requests.values()]));
  });

  test("a site that goes back to its login page asks for the whole login again", async () => {
    const fill = { codeRequested: true };
    const code = { codeFieldVisible: false, passwordFieldVisible: true };
    const { service, request, store, computer } = await withCodeStep(
      { fill, code },
      { username: USERNAME },
    );
    await expect(
      service.submitCode("owner", request.id, actor, { code: CODE }),
    ).rejects.toThrow(/Enter the login again/);
    const [row] = [...store.requests.values()];
    expect(row?.status).toBe("pending");
    expect(row?.method).toBeNull();
    // The login can be entered again from the top, and this time the site does not ask for a code.
    fill.codeRequested = false;
    const done = await service.submit("owner", request.id, actor, {
      username: USERNAME,
      password: PASSWORD,
    });
    expect(done.status).toBe("signed_in");
    expect(computer.codes).toHaveLength(1);
  });

  test("a code is only taken from a request the site has brought to the code step", async () => {
    const { service } = await withCodeStep({ fill: { codeRequested: true } });
    const fresh = await service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    await expect(
      service.submitCode("owner", fresh.id, actor, { code: CODE }),
    ).rejects.toThrow(/not asking for a verification code/);
    await service.cancel("owner", fresh.id, actor);
    await expect(
      service.submitCode("owner", fresh.id, actor, { code: CODE }),
    ).rejects.toThrow(/no longer open/);
    await expect(
      service.submitCode("stranger", fresh.id, actor, { code: CODE }),
    ).rejects.toThrow(/no such sign-in request/);
    await expect(
      service.submitCode("owner", fresh.id, actor, { code: "   " }),
    ).rejects.toThrow(/Enter the verification code/);
  });

  test("two racing code submissions end with exactly one", async () => {
    const { service, request, computer, resolved, store } = await withCodeStep({
      fill: { codeRequested: true },
      gate: "signInCode",
    });
    const first = service.submitCode("owner", request.id, actor, {
      code: CODE,
    });
    await untilStatus(store, request.id, "filling");
    // Held at the computer, the first submission owns the lease; the second is refused, not queued.
    await expect(
      service.submitCode("owner", request.id, actor, { code: CODE }),
    ).rejects.toThrow(/already being entered/);
    computer.letGo();
    await expect(first).resolves.toMatchObject({ status: "signed_in" });
    expect(computer.codes).toHaveLength(1);
    expect(resolved.map((row) => row.status)).toEqual(["signed_in"]);
  });

  /*
   * What the transport's own classification owes the request: a timeout or a mid-flight disconnect
   * means the write may have landed, so the request ends failed as unknown and never reopens; a
   * refusal that PROVES the computer never heard anything keeps the request open for an explicit
   * retry. Neither branch sends anything twice.
   */
  test("a code delivery whose answer never came ends the request failed as unknown", async () => {
    const fail = {
      signInCode: new ComputerUnavailableError(
        "The assistant's computer did not respond in time.",
      ),
    };
    const { service, request, store, trail, resolved, computer } =
      await withCodeStep({ fill: { codeRequested: true }, fail });
    await expect(
      service.submitCode("owner", request.id, actor, { code: CODE }),
    ).rejects.toThrow(/not known whether/);
    const [row] = [...store.requests.values()];
    expect(row?.status).toBe("failed");
    expect(row?.outcome).toMatch(/not known whether/);
    expect(row?.resolvedAt).not.toBeNull();
    expect(resolved.map((row) => row.status)).toEqual(["failed"]);
    // No success was reported, and nothing was sent twice: the one attempt is all there is.
    expect(computer.codes).toHaveLength(1);
    expect(
      trail.rows.some((row) => row.eventType === "computer.sign_in_completed"),
    ).toBe(false);
    expectNoCredential(everything(trail.rows, [...store.requests.values()]));
  });

  test("a code the computer provably never received keeps the code step open", async () => {
    const fail = {
      signInCode: new ComputerUnreachableError(
        "The assistant's computer is not running.",
      ),
    };
    const { service, request, store, trail, resolved, computer } =
      await withCodeStep({ fill: { codeRequested: true }, fail });
    await expect(
      service.submitCode("owner", request.id, actor, { code: CODE }),
    ).rejects.toThrow(/not running/);
    const [row] = [...store.requests.values()];
    expect(row?.status).toBe("code_required");
    expect(row?.fillingUntil).toBeNull();
    expect(resolved).toEqual([]);
    expect(computer.codes).toHaveLength(1);
    expect(
      trail.rows.find((row) => row.eventType === "computer.sign_in_failed")
        ?.payload,
    ).toMatchObject({ request: request.id, step: "code" });
    // The retry is the person's own act, on the same request, once the computer is back.
    delete fail.signInCode;
    const done = await service.submitCode("owner", request.id, actor, {
      code: CODE,
    });
    expect(done.status).toBe("signed_in");
    expect(computer.codes).toHaveLength(2);
  });

  test("a login delivery whose answer never came ends the request failed as unknown", async () => {
    const context = setup({
      fail: {
        signIn: new ComputerUnavailableError(
          "The assistant's computer dropped the connection mid-flight.",
        ),
      },
    });
    const request = await context.service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    await expect(
      context.service.submit("owner", request.id, actor, {
        username: USERNAME,
        password: PASSWORD,
        save: true,
      }),
    ).rejects.toThrow(/not known whether/);
    const [row] = [...context.store.requests.values()];
    expect(row?.status).toBe("failed");
    expect(row?.outcome).toMatch(/not known whether/);
    expect(context.resolved.map((row) => row.status)).toEqual(["failed"]);
    // The outcome is unknown, so nothing is saved on the strength of it.
    expect(await context.store.logins("owner")).toEqual([]);
    expect(context.computer.fills).toHaveLength(1);
    expectNoCredential(
      everything(context.trail.rows, [...context.store.requests.values()]),
    );
  });

  test("a login the computer provably never received reopens the request", async () => {
    const fail = {
      signIn: new ComputerUnreachableError(
        "The assistant's computer is not running.",
      ),
    };
    const context = setup({ fail });
    const request = await context.service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    await expect(
      context.service.submit("owner", request.id, actor, {
        username: USERNAME,
        password: PASSWORD,
      }),
    ).rejects.toThrow(/not running/);
    const [row] = [...context.store.requests.values()];
    expect(row?.status).toBe("pending");
    expect(row?.fillingUntil).toBeNull();
    expect(context.resolved).toEqual([]);
    expect(context.computer.fills).toHaveLength(1);
    delete fail.signIn;
    const done = await context.service.submit("owner", request.id, actor, {
      username: USERNAME,
      password: PASSWORD,
    });
    expect(done.status).toBe("signed_in");
    expect(context.computer.fills).toHaveLength(2);
  });

  test("a late code response cannot overwrite a request closed while it was in flight", async () => {
    const { service, request, store, trail, resolved, computer } =
      await withCodeStep({ fill: { codeRequested: true }, gate: "signInCode" });
    const inFlight = service.submitCode("owner", request.id, actor, {
      code: CODE,
    });
    await untilStatus(store, request.id, "filling");
    // The request closes while the code is on its way to the computer.
    const closed = await store.transition("owner", request.id, ["filling"], {
      status: "cancelled",
      resolvedAt: new Date(),
    });
    expect(closed?.status).toBe("cancelled");
    computer.letGo();
    await expect(inFlight).rejects.toThrow(
      /changed while it was being entered/,
    );
    const [row] = [...store.requests.values()];
    expect(row?.status).toBe("cancelled");
    expect(resolved).toEqual([]);
    expect(
      trail.rows.some((row) => row.eventType === "computer.sign_in_completed"),
    ).toBe(false);
  });

  test("a late password response cannot overwrite an expired request or save the login", async () => {
    const context = setup({ gate: "signIn" });
    const request = await context.service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    const inFlight = context.service.submit("owner", request.id, actor, {
      username: USERNAME,
      password: PASSWORD,
      save: true,
    });
    await untilStatus(context.store, request.id, "filling");
    await context.store.transition("owner", request.id, ["filling"], {
      status: "expired",
      resolvedAt: new Date(),
    });
    context.computer.letGo();
    await expect(inFlight).rejects.toThrow(
      /changed while it was being entered/,
    );
    const [row] = [...context.store.requests.values()];
    expect(row?.status).toBe("expired");
    expect(await context.store.logins("owner")).toEqual([]);
    expect(context.resolved).toEqual([]);
  });

  test("a restart restores state and types nothing until the person acts", async () => {
    const { request, store } = await withCodeStep({
      fill: { codeRequested: true },
    });
    // A new service over the same rows: what a restarted process is.
    const second = fakeGateway();
    const restarted = createSignInService({
      store,
      gateway: second.gateway,
      encryptionKey: KEY,
    });
    expect((await restarted.get("owner", request.id)).status).toBe(
      "code_required",
    );
    expect((await restarted.pending("owner")).map((r) => r.id)).toContain(
      request.id,
    );
    // The restart itself never re-calls the computer; only the person's explicit code does.
    expect(second.fills).toEqual([]);
    expect(second.codes).toEqual([]);
    const done = await restarted.submitCode("owner", request.id, actor, {
      code: CODE,
    });
    expect(done.status).toBe("signed_in");
    expect(second.codes).toEqual([
      { origin: "https://example.com", code: CODE },
    ]);
  });
});
