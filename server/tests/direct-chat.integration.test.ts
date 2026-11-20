import { afterAll, expect, spyOn, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { Observable } from "rxjs";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  createChannelRoutes,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { agents, channels, users } from "../src/db/schema";
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
  const copilot = mountCopilotRuntime(
    deployment,
    {
      resolveAgentsForActor: async () => ({
        [botId]: await agentFor(actor, botId),
      }),
      resolveAgentForActor: agentFor,
    },
    async () => ({ id: actor.id, name: actor.id }),
    async () => actor,
    {
      directChat: { database: db, profiles: store },
    },
  );
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

test("normal Web turns share Test Credits across conversations and keep history readable during a billing outage", async () => {
  const alice = await person();
  const bots: string[] = [];
  const conversations: string[] = [];
  const ids = new Set<string>();
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
      const call = await request.json();
      if (path === "/v1/reserve") {
        expect(call.scope.personId).toBe(alice.id);
        expect(call.route).toBe("pilot-text-v1");
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
      expect(ids.has(call.operationId)).toBe(true);
      if (path === "/v1/dispatch") {
        expect(call.permit).toBe("one-call");
        dispatches++;
        return Response.json({ state: "completed", text: "Managed answer." });
      }
      expect(path).toBe("/v1/reconcile");
      return Response.json({ state: "settled" });
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
          run: async (id: string) =>
            (
              await app.request(
                `/api/copilotkit/agent/${bot.id}/run`,
                post({
                  threadId: channel.threadId,
                  runId: id,
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
  } finally {
    await control.stop(true);
    for (const id of conversations)
      await database.delete(channels).where(eq(channels.id, id));
    for (const id of bots)
      await database.delete(agents).where(eq(agents.id, id));
    await database.delete(users).where(eq(users.id, alice.id));
  }
});
