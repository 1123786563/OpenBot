import { afterAll, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { eq, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { Observable } from "rxjs";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import { createAuth } from "../src/auth";
import {
  type AppVariables,
  type AuthenticatedActor,
  createRoleRepository,
} from "../src/auth/guards";
import {
  createCasdoorBillingIdentity,
  type DirectChatTestCreditDependencies,
} from "../src/billing/direct-chat-test-credit";
import { loadDirectChatTestCredit } from "../src/billing/direct-chat-test-credit-config";
import { createDirectChatCreditRecovery } from "../src/billing/direct-chat-test-credit-recovery";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import { createTestCreditLedger } from "../src/billing/test-credit";
import {
  createChannelRoutes,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  agents,
  channels,
  enterpriseSettings,
  lagoUsageEvents,
  testCreditAccounts,
  testCreditBatches,
  testCreditEnrollments,
  testCreditEvidence,
  testCreditOperations,
  userRoles,
  users,
} from "../src/db/schema";
import { createRequestActor } from "../src/request-actor";
import { fixtureTraceReport } from "./support/bifrost-evidence";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  OPENBOT_ORGANIZATION_AUTH_URL: "https://example.test",
  KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
});
const endpoint = new URL("http://127.0.0.1:4200/ag-ui");
const profiles = createAgentProfileStore(database, endpoint);

afterAll(() => database.$client.close());

async function person(): Promise<AuthenticatedActor> {
  const id = crypto.randomUUID();
  const email = `${id}@example.test`;
  await database.insert(users).values({ id, email, name: id });
  return { id, email, role: "user" };
}

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

class AnsweringAgent extends AbstractAgent {
  constructor(private readonly answer: () => Promise<void>) {
    super();
  }

  run({ threadId, runId }: RunAgentInput): Observable<BaseEvent> {
    return new Observable((observer) => {
      const messageId = `reply-${runId}`;
      const events: BaseEvent[] = [
        { type: EventType.RUN_STARTED, threadId, runId },
        { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: "Offline answer.",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId },
        { type: EventType.RUN_FINISHED, threadId, runId },
      ];
      void this.answer().then(
        () => {
          for (const event of events) observer.next(event);
          observer.complete();
        },
        (error: unknown) => observer.error(error),
      );
    });
  }
}

function web(
  db: typeof database,
  actor: AuthenticatedActor,
  botId: string,
  answer: () => Promise<void>,
  deployment = config,
  managed?: {
    testCredit: DirectChatTestCreditDependencies;
    auth: ReturnType<typeof createAuth>;
  },
) {
  const store = createAgentProfileStore(db, endpoint);
  const channelStore = createChannelStore(
    db,
    store,
    createThreadIdentity("issue-31"),
  );
  const agentFor = async (_actor: unknown, id: string) => {
    if (id !== botId) throw new Error("Unexpected Bot.");
    return new AnsweringAgent(answer);
  };
  const roles = createRoleRepository(db);
  const signedIn =
    managed &&
    createRequestActor({
      singleUser: false,
      getSession: (headers) =>
        managed.auth.api.getSession({
          headers,
          query: { disableCookieCache: true },
        }),
      rolesForUser: roles.rolesForUser,
    });
  const copilot = mountCopilotRuntime(
    deployment,
    {
      resolveAgentsForActor: async () => ({
        [botId]: await agentFor(actor, botId),
      }),
      resolveAgentForActor: agentFor,
    },
    signedIn?.identifyUser ?? (async () => ({ id: actor.id, name: actor.id })),
    signedIn?.identifyActor ?? (async () => actor),
    {
      directChat: {
        database: db,
        profiles: store,
        testCredit: managed?.testCredit,
      },
    },
  );
  if (managed) {
    const args = new Array(createApp.length) as unknown as Parameters<
      typeof createApp
    >;
    args[0] = deployment;
    args[1] = managed.auth;
    args[2] = roles;
    args[6] = copilot.handler;
    args[10] = channelStore;
    args[createApp.length - 1] = {
      testLedger: managed.testCredit.ledger,
      paidLedger: createPaidCreditLedger(db),
      casdoorIdentityOf: createCasdoorBillingIdentity(
        db,
        managed.testCredit.casdoor,
      ),
    };
    return createApp(...args);
  }
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/api/channels", createChannelRoutes(channelStore, requireUser));
  app.route("/", copilot.handler);
  return app;
}

function events(sse: string) {
  return sse
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

test("Web direct chat persists messages and one run per send, with only its Personal Workspace able to read and send", async () => {
  const alice = await person();
  const bob = await person();
  const bot = await profiles.create(alice, {
    name: "Offline Bot",
    title: "Bot",
    roleDescription: "Answers locally.",
    visibility: "private",
  });
  const bobBot = await profiles.create(bob, {
    name: "Workspace B Bot",
    title: "Bot",
    roleDescription: "Answers locally.",
    visibility: "private",
  });
  const blockEgress: typeof fetch = Object.assign(
    async () => {
      throw new Error("Network egress blocked.");
    },
    { preconnect: fetch.preconnect },
  );
  const network = spyOn(globalThis, "fetch").mockImplementation(blockEgress);
  const conversationIds: string[] = [];
  let reopened: typeof database | undefined;
  try {
    const dispatchStarted = Promise.withResolvers<void>();
    const releaseAnswer = Promise.withResolvers<void>();
    let dispatches = 0;
    const answer = async () => {
      dispatches++;
      dispatchStarted.resolve();
      await releaseAnswer.promise;
    };
    const aliceWeb = web(database, alice, bot.id, answer);
    const bobWeb = web(database, bob, bobBot.id, answer);
    const bobCreate = await bobWeb.request(
      "/api/channels",
      post({ agentIds: [bobBot.id] }),
    );
    expect(bobCreate.status).toBe(201);
    const bobChannel = (await bobCreate.json()).channel;
    conversationIds.push(bobChannel.id);
    const create = await aliceWeb.request(
      "/api/channels",
      post({ agentIds: [bot.id] }),
    );
    expect(create.status).toBe(201);
    const { channel } = await create.json();
    conversationIds.push(channel.id);
    const history = `/api/copilotkit/threads/${channel.threadId}/messages?agentId=${bot.id}`;
    const botPath = `/api/copilotkit/agent/${bot.id}`;
    const payload = {
      threadId: channel.threadId,
      runId: "run-1",
      messages: [{ role: "user", id: "message-1", content: "One question." }],
    };
    expect((await aliceWeb.request("/api/copilotkit/info")).status).toBe(200);
    expect(
      (
        await aliceWeb.request(
          `${botPath}/connect`,
          post({ threadId: channel.threadId }),
        )
      ).status,
    ).toBe(200);
    const secondReplica = web(database, alice, bot.id, answer);
    const [first, duplicate] = await Promise.all([
      aliceWeb.request(`${botPath}/run`, post(payload)),
      secondReplica.request(`${botPath}/run`, post(payload)),
    ]);
    expect(first.status).toBe(200);
    await dispatchStarted.promise;
    expect(duplicate.status).toBe(200);
    expect(
      (
        await aliceWeb.request(
          `${botPath}/run`,
          post({
            ...payload,
            runId: "other-run",
            messages: [{ ...payload.messages[0], id: "other-message" }],
          }),
        )
      ).status,
    ).toBe(409);
    releaseAnswer.resolve();
    expect(events(await first.text())).toContainEqual({
      type: EventType.RUN_FINISHED,
      threadId: channel.threadId,
      runId: "run-1",
    });
    expect(events(await duplicate.text())).toContainEqual({
      type: EventType.RUN_FINISHED,
      threadId: channel.threadId,
      runId: "run-1",
    });
    const retry = await secondReplica.request(
      `${botPath}/run`,
      post({ ...payload, runId: "transport-retry" }),
    );
    expect(events(await retry.text())).toContainEqual({
      type: EventType.RUN_FINISHED,
      threadId: channel.threadId,
      runId: "run-1",
    });
    expect(dispatches).toBe(1);
    const saved = await (await aliceWeb.request(history)).json();
    expect(saved).toEqual({
      messages: [
        payload.messages[0],
        { role: "assistant", id: "reply-run-1", content: "Offline answer." },
      ],
      runs: [
        {
          id: "run-1",
          status: "completed",
          userMessageId: "message-1",
          assistantMessageId: "reply-run-1",
        },
      ],
    });
    expect((await bobWeb.request(`/api/channels/${channel.id}`)).status).toBe(
      404,
    );
    expect(
      (await aliceWeb.request(`/api/channels/${bobChannel.id}`)).status,
    ).toBe(404);
    expect((await bobWeb.request(history)).status).toBe(404);
    expect(
      (
        await aliceWeb.request(
          `/api/copilotkit/threads/${bobChannel.threadId}/messages?agentId=${bobBot.id}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await bobWeb.request(
          `${botPath}/connect`,
          post({ threadId: channel.threadId }),
        )
      ).status,
    ).toBe(404);
    expect((await bobWeb.request(`${botPath}/run`, post(payload))).status).toBe(
      404,
    );
    expect(
      (
        await aliceWeb.request(
          `${botPath}/run`,
          post({
            ...payload,
            messages: [{ ...payload.messages[0], content: "Different." }],
          }),
        )
      ).status,
    ).toBe(409);

    reopened = createDatabase(databaseUrl, TEST_POOL);
    const reloaded = web(reopened, alice, bot.id, answer);
    const readConversation = await reloaded.request(
      `/api/channels/${channel.id}`,
    );
    expect(readConversation.status).toBe(200);
    expect((await readConversation.json()).channel.threadId).toBe(
      channel.threadId,
    );
    expect(await (await reloaded.request(history)).json()).toEqual(saved);
    expect(
      events(
        await (
          await reloaded.request(
            `${botPath}/connect`,
            post({ threadId: channel.threadId }),
          )
        ).text(),
      ),
    ).toContainEqual({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: saved.messages,
    });
    await profiles.setHidden(alice, bot.id, true);
    expect((await reloaded.request(history)).status).toBe(404);
    expect(
      (
        await reloaded.request(
          `${botPath}/run`,
          post({
            ...payload,
            runId: "new-run",
            messages: [{ ...payload.messages[0], id: "new-message" }],
          }),
        )
      ).status,
    ).toBe(404);
    expect(dispatches).toBe(1);
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    await reopened?.$client.close();
    for (const id of conversationIds)
      await database.delete(channels).where(eq(channels.id, id));
    for (const id of [bot.id, bobBot.id])
      await database.delete(agents).where(eq(agents.id, id));
    for (const id of [alice.id, bob.id])
      await database.delete(users).where(eq(users.id, id));
  }
});

test("Web turns share Test Credits, reconcile uncertain dispatch on replay, and keep history readable during an outage", async () => {
  const alice = await person();
  const bots: string[] = [];
  const conversations: string[] = [];
  const ids = new Set<string>();
  const calls: { path: string; operationId: string }[] = [];
  let uncertainOperation: string | undefined;
  let loseDispatchResponse = false;
  let available = true;
  let dispatches = 0;
  let legacyCalls = 0;
  let outage = false;
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      if (path === "/v1/quote")
        return Response.json({
          route: "pilot-text-v1",
          priceVersion: "publication-1",
        });
      const call = await request.json();
      calls.push({ path, operationId: call.operationId });
      if (path === "/v1/reserve") {
        expect(call.route).toBe("pilot-text-v1");
        expect(call.priceVersion).toBe("publication-1");
        expect(call.creditType).toBe("test");
        if (outage) return new Response(null, { status: 503 });
        if (!available)
          return Response.json({
            state: "denied",
            reason: "insufficient_credits",
          });
        available = false;
        ids.add(call.operationId);
        return Response.json({ state: "reserved", permit: "one-call" });
      }
      if (path === "/v1/dispatch") {
        expect(ids.has(call.operationId)).toBe(true);
        expect(call.permit).toBe("one-call");
        dispatches++;
        if (loseDispatchResponse) {
          uncertainOperation = call.operationId;
          return new Response(null, { status: 504 });
        }
        return Response.json({ state: "completed", text: "Managed answer." });
      }
      expect(path).toBe("/v1/reconcile");
      return Response.json({
        state:
          call.operationId === uncertainOperation
            ? "pending"
            : ids.has(call.operationId)
              ? "settled"
              : "absent",
      });
    },
  });
  const deployment = loadConfig({
    DATABASE_URL: databaseUrl,
    OPENBOT_ORGANIZATION_AUTH_URL: "https://example.test",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    OPENBOT_MANAGED_MODEL_TRIAL_URL: control.url.href,
    OPENBOT_MANAGED_MODEL_TRIAL_TOKEN: "test-token",
    OPENBOT_MANAGED_MODEL_TRIAL_ROUTE: "pilot-text-v1",
  });
  try {
    const product = await Promise.all(
      ["One", "Two"].map(async (name) => {
        const bot = await profiles.create(alice, {
          name,
          title: "Bot",
          roleDescription: "Answers questions.",
          visibility: "private",
        });
        bots.push(bot.id);
        const app = web(
          database,
          alice,
          bot.id,
          async () => {
            legacyCalls++;
          },
          deployment,
        );
        const opened = await app.request(
          "/api/channels",
          post({ agentIds: [bot.id] }),
        );
        expect(opened.status).toBe(201);
        const { channel } = await opened.json();
        conversations.push(channel.id);
        return {
          run: async (id: string, runId = id) =>
            (
              await app.request(
                `/api/copilotkit/agent/${bot.id}/run`,
                post({
                  threadId: channel.threadId,
                  runId,
                  messages: [{ role: "user", id, content: "A question." }],
                  personId: "forged-person",
                  model: "forged-route",
                }),
              )
            ).text(),
          history: () =>
            app.request(
              `/api/copilotkit/threads/${channel.threadId}/messages?agentId=${bot.id}`,
            ),
        };
      }),
    );
    const replies = await Promise.all(
      product.map((entry) => entry.run("same-browser-id")),
    );
    expect(
      replies.filter((reply) => reply.includes("Managed answer.")),
    ).toHaveLength(1);
    expect(
      replies.filter((reply) => reply.includes("insufficient_credits")),
    ).toHaveLength(1);
    expect(dispatches).toBe(1);
    expect(legacyCalls).toBe(0);
    outage = true;
    const winner =
      product[replies.findIndex((reply) => reply.includes("Managed answer."))];
    if (!winner) throw new Error("No managed answer.");
    expect(await winner.run("same-browser-id")).toContain("Managed answer.");
    expect(await winner.run("new-id")).toContain("unavailable");
    expect(await (await winner.history()).text()).toContain("Managed answer.");
    expect(dispatches).toBe(1);
    expect(legacyCalls).toBe(0);

    outage = false;
    available = true;
    loseDispatchResponse = true;
    const beforeUncertain = calls.length;
    expect(events(await winner.run("uncertain-message"))).toContainEqual(
      expect.objectContaining({
        type: EventType.RUN_ERROR,
        code: "reconciling",
      }),
    );
    const operationId = calls[beforeUncertain]?.operationId;
    if (!operationId) throw new Error("Expected an operation ID.");
    expect(
      events(await winner.run("uncertain-message", "new-browser-run")),
    ).toContainEqual(
      expect.objectContaining({
        type: EventType.RUN_ERROR,
        code: "reconciling",
      }),
    );
    expect(calls.slice(beforeUncertain)).toEqual(
      ["/v1/reserve", "/v1/dispatch", "/v1/reconcile", "/v1/reconcile"].map(
        (path) => ({ path, operationId }),
      ),
    );
    expect(dispatches).toBe(2);
    expect(legacyCalls).toBe(0);
  } finally {
    await control.stop(true);
    for (const id of conversations)
      await database.delete(channels).where(eq(channels.id, id));
    for (const id of bots)
      await database.delete(agents).where(eq(agents.id, id));
    await database.delete(users).where(eq(users.id, alice.id));
  }
});

test("the Conversation confirms a published quote and bills its authenticated Casdoor owner", async () => {
  const alice = await person();
  const bob = await person();
  const secret = "test-credit-fixture-session-signing".repeat(2);
  const deployment = loadConfig({
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_URL: "http://localhost",
    BETTER_AUTH_SECRET: secret,
    GOOGLE_OAUTH_CLIENT_ID: "fixture-sign-in",
    GOOGLE_OAUTH_CLIENT_SECRET: "fixture-sign-in-secret",
    INITIAL_ADMIN_EMAILS: "admin@example.test",
    KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
  const auth = createAuth(deployment, database);
  const authContext = await auth.$context;
  const sessionHeaders = new Map<string, { cookie: string }>();
  for (const actor of [alice, bob]) {
    await database.insert(userRoles).values({ userId: actor.id, role: "user" });
    const session = await authContext.internalAdapter.createSession(actor.id);
    const signature = createHmac("sha256", secret)
      .update(session.token)
      .digest("base64");
    const cookie = `${authContext.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`;
    sessionHeaders.set(actor.id, { cookie });
  }
  const issuer = `https://casdoor.example.test/${crypto.randomUUID()}`;
  const providerId = "trial-casdoor";
  const route = "conversation-fixture";
  const batchId = crypto.randomUUID();
  let now = Date.now();
  const ledger = createTestCreditLedger(database, () => new Date(now));
  const aliceIdentity = { issuer, subject: crypto.randomUUID() };
  const bobIdentity = { issuer, subject: crypto.randomUUID() };
  const harness = `agent-langgraph-agui@sha256:${"a".repeat(64)}`;
  const draft = configure(emptyCatalog, {
    harnessImage: harness,
    routes: {
      [route]: {
        provider: "fixture",
        model: "text",
        gatewayRevision: "fixture-gateway",
        meteringRevision: "fixture-meter",
        maxInputTokens: 3,
        maxOutputTokens: 3,
        price: { inputPerMillion: 250_000, outputPerMillion: 250_000 },
        tools: false,
      },
    },
  });
  const proposed = draft.routes[route];
  if (!proposed) throw new Error("Fixture route missing.");
  const { catalog } = publish(
    verify(draft, route, fixtureTraceReport(harness, proposed), "fixture"),
    [route],
    route,
    "fixture",
  );
  const operationIds: string[] = [];
  const meteredRequests = new Map<
    string,
    { body: string; operationId: string | null }
  >();
  let gatewayOutcome: "answer" | "unknown" | "partial" = "answer";
  let invalidProof = false;
  const meter = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-meter");
      const requestId = request.headers.get("x-request-id");
      expect(request.headers.get("x-openbot-bifrost-gateway-revision")).toBe(
        "fixture-gateway",
      );
      expect(request.headers.get("x-openbot-bifrost-metering-revision")).toBe(
        "fixture-meter",
      );
      if (!requestId) return new Response(null, { status: 400 });
      const body = await request.text();
      meteredRequests.set(requestId, {
        body,
        operationId: request.headers.get("x-openbot-operation-id"),
      });
      return Response.json({
        gatewayRevision: "fixture-gateway",
        meteringRevision: "fixture-meter",
        inputTokenUpperBound: 1,
        requestSha256: invalidProof
          ? "9".repeat(64)
          : Bun.CryptoHasher.hash("sha256", body, "hex"),
      });
    },
  });
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const operationId = request.headers.get("x-openbot-operation-id");
      if (!operationId) return new Response(null, { status: 400 });
      const body = await request.text();
      expect(request.headers.get("authorization")).toBe(
        "Bearer fixture-gateway",
      );
      expect(
        meteredRequests.get(request.headers.get("x-request-id") ?? ""),
      ).toEqual({ body, operationId });
      expect(request.headers.get("x-bf-lh-openbot-operation-id")).toBe(
        operationId,
      );
      expect(request.headers.get("x-bf-lh-openbot-request-sha256")).toBe(
        Bun.CryptoHasher.hash("sha256", body, "hex"),
      );
      expect(JSON.parse(body)).toMatchObject({
        model: "fixture/text",
        max_completion_tokens: 3,
        stream: false,
      });
      expect(JSON.parse(body)).not.toHaveProperty("max_tokens");
      operationIds.push(operationId);
      if (gatewayOutcome === "unknown")
        return new Response(null, { status: 502 });
      if (gatewayOutcome === "partial")
        return Response.json({
          choices: [],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        });
      return Response.json({
        choices: [{ message: { content: "Fixture answer." } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  const bots: string[] = [];
  const conversations: string[] = [];
  const [previousCatalog] = await database
    .select()
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, pilotCatalogKey));
  try {
    await database
      .insert(enterpriseSettings)
      .values({ key: pilotCatalogKey, value: catalog })
      .onConflictDoUpdate({
        target: enterpriseSettings.key,
        set: { value: catalog },
      });
    await database.insert(accounts).values([
      {
        id: crypto.randomUUID(),
        providerId,
        issuer,
        userId: alice.id,
        accountId: aliceIdentity.subject,
      },
      {
        id: crypto.randomUUID(),
        providerId,
        issuer,
        userId: bob.id,
        accountId: bobIdentity.subject,
      },
    ]);
    for (const identity of [aliceIdentity, bobIdentity])
      await ledger.enroll({ identity, batchId, amount: 2n });
    const settings = loadDirectChatTestCredit({
      OPENBOT_TEST_CREDIT_CONVERSATIONS: "enabled",
      TEST_CREDIT_CASDOOR_ISSUER: issuer,
      TEST_CREDIT_CASDOOR_PROVIDER_ID: providerId,
      TEST_CREDIT_BIFROST_URL: gateway.url.href,
      TEST_CREDIT_BIFROST_TOKEN: "fixture-gateway",
      TEST_CREDIT_GATEWAY_REVISION: "fixture-gateway",
      TEST_CREDIT_GATEWAY_IMAGE_DIGEST: `sha256:${"d".repeat(64)}`,
      TEST_CREDIT_INPUT_METER_URL: meter.url.href,
      TEST_CREDIT_INPUT_METER_TOKEN: "fixture-meter",
      TEST_CREDIT_METERING_REVISION: "fixture-meter",
    });
    if (!settings) throw new Error("Fixture settings missing.");
    const testCredit = { ledger, ...settings };
    const opened = await Promise.all(
      [alice, alice, bob].map(async (actor) => {
        const bot = await profiles.create(actor, {
          name: "Billing fixture",
          title: "Bot",
          roleDescription: "Answers questions.",
          visibility: "private",
        });
        bots.push(bot.id);
        const app = web(
          database,
          actor,
          bot.id,
          async () => {
            throw new Error("Unexpected legacy dispatch.");
          },
          deployment,
          { auth, testCredit },
        );
        const headers = sessionHeaders.get(actor.id);
        if (!headers) throw new Error("Fixture session missing.");
        const authenticatedPost = (body: unknown) => ({
          ...post(body),
          headers: { ...post(body).headers, ...headers },
        });
        const response = await app.request(
          "/api/channels",
          authenticatedPost({ agentIds: [bot.id] }),
        );
        expect(response.status).toBe(201);
        const { channel } = await response.json();
        conversations.push(channel.id);
        const path = `/api/copilotkit/agent/${bot.id}`;
        return {
          app,
          headers,
          quote: (session = headers) =>
            app.request(
              `${path}/test-credit-quote?threadId=${channel.threadId}`,
              { headers: session },
            ),
          run: (
            id: string,
            confirmation?: object,
            runId = id,
            rerunOfMessageId?: string,
          ) =>
            app.request(
              `${path}/run`,
              authenticatedPost({
                threadId: channel.threadId,
                runId,
                messages: [{ role: "user", id, content: "Fixture prompt." }],
                forwardedProps: {
                  testCreditQuote: confirmation,
                  rerunOfMessageId,
                  personId: bob.id,
                  subject: bobIdentity.subject,
                },
              }),
            ),
          connect: () =>
            app.request(
              `${path}/connect`,
              authenticatedPost({ threadId: channel.threadId }),
            ),
          history: () =>
            app.request(
              `/api/copilotkit/threads/${channel.threadId}/messages?agentId=${bot.id}`,
              { headers },
            ),
        };
      }),
    );
    const [first, second, other] = opened;
    if (!first || !second || !other)
      throw new Error("Fixture Conversation missing.");
    const claim = (conversation: typeof first) =>
      conversation.app.request("/api/billing/claim", {
        ...post({ batchId }),
        headers: { ...post({}).headers, ...conversation.headers },
      });
    const claims = await Promise.all([
      claim(first),
      claim(first),
      claim(other),
    ]);
    expect(claims.map((response) => response.status)).toEqual([200, 200, 200]);
    const [firstClaim, replay] = await Promise.all(
      claims.slice(0, 2).map((response) => response.json()),
    );
    expect(firstClaim).toMatchObject({ batchId });
    expect(replay).toEqual(firstClaim);
    expect(await (await claim(first)).json()).toEqual(firstClaim);
    expect(
      await (
        await first.app.request("/api/billing/balance", {
          headers: first.headers,
        })
      ).json(),
    ).toMatchObject({ grantedMicrocredits: "2" });
    expect(
      (
        await first.app.request("/api/billing/v1/reserve", {
          ...post({ operationId: "untrusted" }),
          headers: { ...post({}).headers, ...first.headers },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await first.app.request("/api/billing/claim", {
          ...post({ batchId }),
          headers: {
            ...post({}).headers,
            ...first.headers,
            origin: "https://foreign.example.test",
          },
        })
      ).status,
    ).toBe(403);
    expect((await first.quote(other.headers)).status).toBe(404);
    const quoteResponse = await first.quote();
    expect(quoteResponse.status).toBe(200);
    const quote = await quoteResponse.json();
    expect(quote).toMatchObject({
      creditType: "test",
      route,
      maxChargeMicrocredits: "2",
      price: { inputPerMillion: 250_000, outputPerMillion: 250_000 },
    });
    expect((await first.run("unconfirmed")).status).toBe(409);
    expect(operationIds).toHaveLength(0);
    const confirmed = { route, priceVersion: quote.priceVersion };
    expect(
      await (
        await first.run("stale", {
          ...confirmed,
          priceVersion: crypto.randomUUID(),
        })
      ).text(),
    ).toContain("route_unavailable");
    expect(operationIds).toHaveLength(0);
    const replies = await Promise.all(
      [first, second].map(async (conversation) =>
        (await conversation.run("confirmed", confirmed)).text(),
      ),
    );
    expect(
      replies.filter((reply) => reply.includes("Fixture answer.")),
    ).toHaveLength(1);
    expect(
      replies.filter((reply) => reply.includes("insufficient_credits")),
    ).toHaveLength(1);
    expect(operationIds).toHaveLength(1);
    const [settled] = operationIds;
    if (!settled) throw new Error("Expected a managed dispatch.");
    expect(await ledger.receipt(aliceIdentity, settled)).toMatchObject({
      state: "settled",
      priceVersion: quote.priceVersion,
      chargedMicrocredits: "1",
      reservedMicrocredits: "2",
      releasedMicrocredits: "1",
    });
    expect(
      (await first.app.request(`/api/billing/operations/${settled}`)).status,
    ).toBe(401);
    expect(
      (
        await first.app.request(`/api/billing/operations/${settled}`, {
          headers: other.headers,
        })
      ).status,
    ).toBe(404);
    const receipt = await first.app.request(
      `/api/billing/operations/${settled}`,
      { headers: first.headers },
    );
    expect(await receipt.json()).toMatchObject({
      chargedMicrocredits: "1",
      releasedMicrocredits: "1",
    });
    expect(
      await (
        await first.app.request("/api/billing/paid/bill", {
          headers: first.headers,
        })
      ).json(),
    ).toMatchObject([
      { operationId: settled, source: "test", amountMicrocredits: "1" },
    ]);
    expect(
      await (
        await other.app.request("/api/billing/paid/bill", {
          headers: other.headers,
        })
      ).json(),
    ).toEqual([]);
    expect(await ledger.balance(bobIdentity)).toMatchObject({
      availableMicrocredits: "2",
    });
    const winner = replies[0]?.includes("Fixture answer.") ? first : second;
    expect(
      await (
        await winner.run("confirmed", undefined, "other-browser-id")
      ).text(),
    ).toContain("Fixture answer.");
    expect(await (await winner.history()).text()).toContain("Fixture answer.");

    gatewayOutcome = "unknown";
    expect(await (await other.run("uncertain", confirmed)).text()).toContain(
      "reconciling",
    );
    const unknown = operationIds[1];
    if (!unknown)
      throw new Error("Expected the uncertain operation to dispatch.");
    expect(
      await (await other.run("uncertain", confirmed, "retry")).text(),
    ).toContain("reconciling");
    expect(operationIds).toHaveLength(2);
    expect(await ledger.receipt(bobIdentity, unknown)).toMatchObject({
      state: "pending",
      heldMicrocredits: "2",
    });
    const recover = createDirectChatCreditRecovery(
      database,
      ledger,
      testCredit.casdoor,
    );
    await recover();
    expect(operationIds).toHaveLength(2);
    expect(await ledger.receipt(bobIdentity, unknown)).toMatchObject({
      state: "pending",
      heldMicrocredits: "2",
    });

    const bobAccount = await ledger.accountOf(bobIdentity);
    if (!bobAccount) throw new Error("Fixture Billing Account missing.");
    // A durable gateway observation arrives, then a replacement Worker resumes the same operation.
    await ledger.recordResult(bobAccount, unknown, "Recovered fixture result.");
    await ledger.recordEvidence(bobAccount, unknown, {
      evidenceId: "fixture-recovered",
      outcome: "completed",
      inputTokens: 100n,
      outputTokens: 100n,
    });
    await Promise.all([recover(), recover()]);
    expect(operationIds).toHaveLength(2);
    expect(await (await other.history()).text()).toContain(
      "Recovered fixture result.",
    );
    expect(await ledger.receipt(bobIdentity, unknown)).toMatchObject({
      state: "settled",
      chargedMicrocredits: "2",
      releasedMicrocredits: "0",
    });
    expect(
      await (await other.run("uncertain", undefined, "after-worker")).text(),
    ).toContain("Recovered fixture result.");

    const freshBatch = crypto.randomUUID();
    await ledger.enroll({
      identity: bobIdentity,
      batchId: freshBatch,
      amount: 8n,
    });
    await ledger.claim(bobIdentity, freshBatch);
    gatewayOutcome = "answer";
    invalidProof = true;
    expect(await (await other.run("bad-meter", confirmed)).text()).toContain(
      "route_unavailable",
    );
    expect(operationIds).toHaveLength(2);
    expect(await ledger.balance(bobIdentity)).toMatchObject({
      availableMicrocredits: "8",
      reservedMicrocredits: "0",
    });
    await database.execute(
      sql`ALTER TABLE test_credit_operations RENAME TO test_credit_operations_fixture_outage`,
    );
    try {
      expect(
        await (await other.run("ledger-outage", confirmed)).text(),
      ).toContain("unavailable");
      expect(await (await other.history()).text()).toContain(
        "Recovered fixture result.",
      );
      expect(operationIds).toHaveLength(2);
    } finally {
      await database.execute(
        sql`ALTER TABLE test_credit_operations_fixture_outage RENAME TO test_credit_operations`,
      );
    }
    invalidProof = false;
    expect(
      (
        await other.run(
          "foreign-rerun",
          confirmed,
          "foreign-rerun",
          "confirmed",
        )
      ).status,
    ).toBe(409);
    expect(
      await (
        await other.run(
          "explicit-rerun",
          confirmed,
          "explicit-rerun",
          "uncertain",
        )
      ).text(),
    ).toContain("Fixture answer.");
    expect(operationIds).toHaveLength(3);
    const rerun = operationIds[2];
    const rerunReceipt = await other.app.request(
      `/api/billing/operations/${rerun}`,
      { headers: other.headers },
    );
    expect(await rerunReceipt.json()).toMatchObject({
      state: "settled",
      operationId: rerun,
      rerunOfOperationId: unknown,
      reservedMicrocredits: "2",
      chargedMicrocredits: "1",
    });
    expect(
      await (
        await other.run("explicit-rerun", undefined, "retry-rerun")
      ).text(),
    ).toContain("Fixture answer.");
    await recover();
    expect(operationIds).toHaveLength(3);
    const receiptOf = async (id: string | undefined) => {
      if (!id) throw new Error("Expected a gateway dispatch.");
      const response = await other.app.request(
        `/api/billing/operations/${id}`,
        {
          headers: other.headers,
        },
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    gatewayOutcome = "partial";
    const partialStream = await (await other.run("partial", confirmed)).text();
    expect(partialStream).toContain('"code":"settled"');
    expect(await receiptOf(operationIds[3])).toMatchObject({
      state: "settled",
      outcome: "partial",
      chargedMicrocredits: "1",
      releasedMicrocredits: "1",
    });

    gatewayOutcome = "unknown";
    const unknownStream = await (
      await other.run("cancelled", confirmed)
    ).text();
    expect(unknownStream).toContain('"state":"pending"');
    const cancelled = operationIds[4];
    if (!cancelled)
      throw new Error("Expected cancelled operation to dispatch.");
    const day = 24 * 60 * 60_000;
    const reconnected = await (await other.connect()).text();
    expect(reconnected).toContain('"name":"openbot-test-credit-receipt"');
    expect(reconnected).toContain('"state":"pending"');
    const dispatched = await receiptOf(cancelled);
    expect(dispatched).toMatchObject({
      state: "pending",
      cutoffAt: new Date(now + day).toISOString(),
      dispatchedAt: new Date(now).toISOString(),
      heldMicrocredits: "2",
    });
    now += day - 1;
    const cancellation = {
      evidenceId: "verified-cancellation",
      outcome: "cancelled",
      inputTokens: 4n,
      outputTokens: 0n,
    } as const;
    await ledger.recordEvidence(bobAccount, cancelled, cancellation);
    now++;
    expect(await receiptOf(cancelled)).toMatchObject({
      state: "pending",
      heldMicrocredits: "1",
      releasedMicrocredits: "1",
    });
    await Promise.all([recover(), recover()]);
    expect(await receiptOf(cancelled)).toMatchObject({
      state: "settled",
      outcome: "cancelled",
      chargedMicrocredits: "1",
    });
    expect(
      await (await other.run("cancelled", undefined, "after-cancel")).text(),
    ).toContain('"code":"settled"');
    const beforeLate = await ledger.balance(bobIdentity);
    expect(
      await ledger.recordEvidence(bobAccount, cancelled, {
        ...cancellation,
        evidenceId: "late-cumulative-usage",
        inputTokens: 20n,
      }),
    ).toMatchObject({ platformMicrocredits: "4" });
    expect(await ledger.balance(bobIdentity)).toEqual(beforeLate);
    expect(operationIds).toHaveLength(5);
    for (const fixture of [
      { outcome: "zero_cost", inputTokens: 0n, expectedCost: "0" },
      { outcome: "platform_failure", inputTokens: 16n, expectedCost: "4" },
    ] as const) {
      const before = await ledger.balance(bobIdentity);
      expect(
        await (await other.run(fixture.outcome, confirmed)).text(),
      ).toContain('"state":"pending"');
      const operation = operationIds.at(-1);
      if (!operation) throw new Error("Missing gateway operation.");
      expect(
        await ledger.recordEvidence(bobAccount, operation, {
          evidenceId: fixture.outcome,
          outcome: fixture.outcome,
          inputTokens: fixture.inputTokens,
          outputTokens: 0n,
        }),
      ).toMatchObject({ platformMicrocredits: fixture.expectedCost });
      await recover();
      expect(await receiptOf(operation)).toMatchObject({
        state: "released",
        outcome: fixture.outcome,
        releasedMicrocredits: "2",
      });
      expect(await (await other.connect()).text()).toContain(
        '"state":"released"',
      );
      expect(await ledger.balance(bobIdentity)).toEqual(before);
    }
    expect(operationIds).toHaveLength(7);

    await database
      .delete(testCreditEnrollments)
      .where(eq(testCreditEnrollments.batchId, freshBatch));
    await database
      .delete(testCreditBatches)
      .where(eq(testCreditBatches.id, freshBatch));
  } finally {
    await gateway.stop(true);
    await meter.stop(true);
    for (const id of conversations)
      await database.delete(channels).where(eq(channels.id, id));
    for (const id of bots)
      await database.delete(agents).where(eq(agents.id, id));
    for (const actor of [alice, bob])
      await database.delete(users).where(eq(users.id, actor.id));
    for (const identity of [aliceIdentity, bobIdentity]) {
      const accountId = await ledger.accountOf(identity);
      if (!accountId) continue;
      await database
        .delete(lagoUsageEvents)
        .where(eq(lagoUsageEvents.accountId, accountId));
      await database
        .delete(testCreditEvidence)
        .where(eq(testCreditEvidence.accountId, accountId));
      await database
        .delete(testCreditOperations)
        .where(eq(testCreditOperations.accountId, accountId));
      await database
        .delete(testCreditEnrollments)
        .where(eq(testCreditEnrollments.accountId, accountId));
      await database
        .delete(testCreditAccounts)
        .where(eq(testCreditAccounts.id, accountId));
    }
    await database
      .delete(testCreditBatches)
      .where(eq(testCreditBatches.id, batchId));
    if (previousCatalog)
      await database
        .update(enterpriseSettings)
        .set(previousCatalog)
        .where(eq(enterpriseSettings.key, pilotCatalogKey));
    else
      await database
        .delete(enterpriseSettings)
        .where(eq(enterpriseSettings.key, pilotCatalogKey));
  }
});
