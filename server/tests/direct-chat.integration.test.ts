import { afterAll, expect, spyOn, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { and, eq, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { Observable } from "rxjs";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { expireDirectChatEvents } from "../src/channels/direct-chat-replay";
import {
  createChannelRoutes,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import {
  agents,
  approvalRequests,
  auditEvents,
  channelMemberships,
  channels,
  directChatRunEvents,
  users,
} from "../src/db/schema";
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
  constructor(
    private readonly answer: () => Promise<void>,
    private readonly partial?: string,
  ) {
    super();
  }

  run({ threadId, runId }: RunAgentInput): Observable<BaseEvent> {
    return new Observable((observer) => {
      const messageId = `reply-${runId}`;
      const events: BaseEvent[] = [
        { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: "Offline answer.",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId },
        { type: EventType.RUN_FINISHED, threadId, runId },
      ];
      observer.next({ type: EventType.RUN_STARTED, threadId, runId });
      if (this.partial !== undefined) {
        observer.next({
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: "assistant",
        });
        observer.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: this.partial,
        });
        events.shift();
      }
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
  partial?: string,
) {
  const store = createAgentProfileStore(db, endpoint);
  const channelStore = createChannelStore(
    db,
    store,
    createThreadIdentity("issue-31"),
  );
  const agentFor = async (_actor: unknown, id: string) => {
    if (id !== botId) throw new Error("Unexpected Bot.");
    return new AnsweringAgent(answer, partial);
  };
  const copilot = mountCopilotRuntime(
    config,
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

test("a disconnected direct chat resumes after its last delivered event", async () => {
  const actor = await person();
  const bot = await profiles.create(actor, {
    name: "Replay Bot",
    title: "Bot",
    roleDescription: "Answers locally.",
    visibility: "private",
  });
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let dispatches = 0;
  const app = web(database, actor, bot.id, async () => {
    dispatches++;
    started.resolve();
    await release.promise;
  });
  const create = await app.request(
    "/api/channels",
    post({ agentIds: [bot.id] }),
  );
  expect(create.status).toBe(201);
  const { channel } = await create.json();
  try {
    const path = `/api/copilotkit/agent/${bot.id}`;
    const input = { threadId: channel.threadId, runId: "replay-run" };
    const first = await app.request(
      `${path}/run`,
      post({
        ...input,
        messages: [
          { role: "user", id: "replay-message", content: "Replay this." },
        ],
      }),
    );
    const reader = first.body?.getReader();
    await started.promise;
    const frame = await reader?.read();
    await reader?.cancel();
    release.resolve();
    const header = new TextDecoder().decode(frame?.value).match(/^id: (\d+)$/m);
    const replay = await app.request(
      `${path}/resume`,
      post({ ...input, cursor: Number(header?.[1] ?? 1) }),
    );
    expect(replay.status).toBe(200);
    expect(header?.[1]).toBe("1");
    expect(events(await replay.text()).map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(dispatches).toBe(1);
  } finally {
    release.resolve();
    await database.delete(channels).where(eq(channels.id, channel.id));
    await database.delete(agents).where(eq(agents.id, bot.id));
    await database.delete(users).where(eq(users.id, actor.id));
  }
});

test("expired replay uses an authorized snapshot boundary and retains history and audit", async () => {
  const actor = await person();
  const stranger = await person();
  const bot = await profiles.create(actor, {
    name: "Snapshot Bot",
    title: "Bot",
    roleDescription: "Answers locally.",
    visibility: "private",
  });
  const release = Promise.withResolvers<void>();
  const app = web(database, actor, bot.id, () => release.promise, "Partial: ");
  const other = web(database, stranger, bot.id, async () => {});
  const { channel } = await (
    await app.request("/api/channels", post({ agentIds: [bot.id] }))
  ).json();
  const base = `/api/copilotkit/agent/${bot.id}`;
  const key = { threadId: channel.threadId, runId: crypto.randomUUID() };
  const userMessage = {
    role: "user",
    id: "snapshot-message",
    content: "Show current output.",
  };
  const approvalId = crypto.randomUUID();
  const resume = `${base}/resume`;
  const history = `/api/copilotkit/threads/${key.threadId}/messages?agentId=${bot.id}`;
  try {
    const first = await app.request(
      `${base}/run`,
      post({ ...key, messages: [userMessage] }),
    );
    const reader = first.body?.getReader();
    if (!reader) throw new Error("Missing Run stream");
    let received = "";
    while (!received.includes("Partial: ")) {
      const next = await reader.read();
      if (next.done) throw new Error("Run closed before partial output");
      received += new TextDecoder().decode(next.value);
    }
    await reader.cancel();
    expect(received).toContain("id: 3\n");
    await database.insert(approvalRequests).values({
      id: approvalId,
      ownerUserId: actor.id,
      runId: key.runId,
      toolCallId: "approval-call",
      actionDigest: "fixture-digest",
      action: {
        ...key,
        toolCallId: "approval-call",
        actionDigest: "fixture-digest",
        actorId: actor.id,
        botId: bot.id,
        toolRef: "fixture",
        scope: "fixture",
        effect: "fixture",
        args: {},
      },
    });
    const [audit] = await database
      .insert(auditEvents)
      .values({
        actorUserId: actor.id,
        eventType: "test.direct_chat_replay",
        targetType: "run",
        targetId: key.runId,
        payload: {},
      })
      .returning({ id: auditEvents.id });
    await database
      .update(directChatRunEvents)
      .set({ createdAt: sql`now() - interval '2 hours'` })
      .where(
        and(
          eq(directChatRunEvents.threadId, key.threadId),
          eq(directChatRunEvents.runId, key.runId),
        ),
      );
    await expireDirectChatEvents(database);
    expect(
      await database
        .select()
        .from(directChatRunEvents)
        .where(eq(directChatRunEvents.runId, key.runId)),
    ).toEqual([]);
    expect(
      (
        await database
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.id, audit.id))
      ).length,
    ).toBe(1);
    expect(
      (await other.request(resume, post({ ...key, cursor: 1 }))).status,
    ).toBe(404);
    expect(
      (await other.request(resume, post({ ...key, cursor: 3 }))).status,
    ).toBe(404);
    expect(
      (await app.request(resume, post({ ...key, cursor: 4 }))).status,
    ).toBe(400);
    const response = await app.request(resume, post({ ...key, cursor: 1 }));
    expect(response.status).toBe(200);
    const resumed = response.body?.getReader();
    if (!resumed) throw new Error("Missing replay stream");
    let snapshot = "";
    while (!snapshot.includes("openbot.run.snapshot")) {
      const next = await resumed.read();
      if (next.done) throw new Error("Run closed before snapshot");
      snapshot += new TextDecoder().decode(next.value);
    }
    expect(events(snapshot)).toEqual([
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          userMessage,
          { role: "assistant", id: `reply-${key.runId}`, content: "Partial: " },
        ],
      },
      {
        type: EventType.CUSTOM,
        name: "openbot.run.snapshot",
        value: {
          ...key,
          cursor: 3,
          status: "running",
          pendingApprovals: [{ id: approvalId, toolCallId: "approval-call" }],
        },
      },
    ]);
    release.resolve();
    let tail = "";
    for (
      let next = await resumed.read();
      !next.done;
      next = await resumed.read()
    ) {
      tail += new TextDecoder().decode(next.value);
    }
    expect(tail.match(/^id: (\d+)$/gm)).toEqual(["id: 4", "id: 5", "id: 6"]);
    expect(events(tail).map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(
      (await (await app.request(history)).json()).messages.map(
        (message: { content: string }) => message.content,
      ),
    ).toEqual([userMessage.content, "Partial: Offline answer."]);
    await database
      .delete(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channel.id),
          eq(channelMemberships.userId, actor.id),
        ),
      );
    expect(
      (await app.request(resume, post({ ...key, cursor: 1 }))).status,
    ).toBe(404);
    expect(
      (await app.request(resume, post({ ...key, cursor: 3 }))).status,
    ).toBe(404);
    expect((await app.request(history)).status).toBe(404);
  } finally {
    release.resolve();
    await database.delete(channels).where(eq(channels.id, channel.id));
    await database.delete(agents).where(eq(agents.id, bot.id));
    await database.delete(users).where(eq(users.id, actor.id));
    await database.delete(users).where(eq(users.id, stranger.id));
  }
});
