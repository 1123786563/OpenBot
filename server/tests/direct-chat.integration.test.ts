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
import { agents, channels, opikRuns, users } from "../src/db/schema";
import { createMemoryStore } from "../src/memory/store";
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
  opik?: typeof config.opik,
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
    { ...config, ...(opik ? { opik } : {}) },
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

test(
  "Run feedback survives an Opik outage and scores an incomplete Run once after recovery",
  async () => {
    const { createOpikDelivery } = await import("../src/opik/delivery");
    const alice = await person();
    const bob = await person();
    const bot = await profiles.create(alice, {
      name: "Feedback Bot",
      title: "Bot",
      roleDescription: "Answers locally.",
      visibility: "private",
    });
    const bobWeb = web(database, bob, bot.id, async () => {});
    const aliceChannelWeb = web(database, alice, bot.id, async () => {});
    const { channel } = await (
      await aliceChannelWeb.request(
        "/api/channels",
        post({ agentIds: [bot.id] }),
      )
    ).json();
    const botPath = `/api/copilotkit/agent/${bot.id}`;
    try {
      const runId = crypto.randomUUID();
      const tracePosts: {
        id: string;
        name: string;
        metadata: { status: string; duration_ms: number; incomplete: boolean };
      }[] = [];
      const realApi = process.env.TEST_OPIK_API_URL;
      const project = `openbot-acceptance-${crypto.randomUUID()}`;
      let scoreWrites = 0;
      const scores = new Map<string, number>();
      const dropped: number[] = [];
      let available = false;
      const opik = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          if (!available) return new Response(null, { status: 503 });
          const raw = await request.text();
          const body = JSON.parse(raw);
          if (realApi) {
            const upstream = await fetch(
              new URL(
                new URL(request.url).pathname.replace(/^\/api\//, ""),
                realApi.endsWith("/") ? realApi : `${realApi}/`,
              ),
              {
                method: request.method,
                headers: { "content-type": "application/json" },
                body: raw,
              },
            );
            if (!upstream.ok) {
              console.error(
                `Real Opik returned ${upstream.status}: ${await upstream.text()}`,
              );
              return new Response(null, { status: 503 });
            }
            await upstream.body?.cancel();
          }
          if (request.method === "POST") tracePosts.push(...body.traces);
          else {
            for (const score of body.scores)
              scores.set(`${score.id}:${score.name}`, score.value);
            if (++scoreWrites === 1) return new Response(null, { status: 503 });
          }
          return new Response(null, { status: 204 });
        },
      });
      try {
        const config = { apiUrl: new URL("api/", opik.url), project };
        const aliceWeb = web(database, alice, bot.id, async () => {}, config);
        const options = {
          now: () => now,
          onDropped: (count: number) => dropped.push(count),
        };
        const run = await aliceWeb.request(
          `${botPath}/run`,
          post({
            runId,
            threadId: channel.threadId,
            messages: [
              { role: "user", id: "question", content: "private prompt" },
            ],
          }),
        );
        expect(await run.text()).toContain("Offline answer.");
        const memory = createMemoryStore(database);
        const fact = await memory.create(alice.id, {
          content: "private memory",
        });
        expect(await memory.list(alice.id)).toContainEqual(
          expect.objectContaining({ id: fact.id, content: "private memory" }),
        );
        await memory.remove(alice.id, fact.id);
        let now = new Date();
        await createOpikDelivery(database, config, options).drain();
        const feedback = {
          feedbackId: crypto.randomUUID(),
          score: 1,
          comment: "private feedback",
        };
        const path = `/api/copilotkit/threads/${channel.threadId}/runs/${runId}/feedback?agentId=${bot.id}`;
        expect((await bobWeb.request(path, post(feedback))).status).toBe(404);
        expect((await aliceWeb.request(path, post(feedback))).status).toBe(202);
        expect(
          (await aliceWeb.request(path, post({ ...feedback, score: 0 })))
            .status,
        ).toBe(409);
        expect(
          await database
            .select({
              feedbackId: opikRuns.feedbackId,
              comment: opikRuns.comment,
            })
            .from(opikRuns)
            .where(eq(opikRuns.runId, runId)),
        ).toEqual([
          { feedbackId: feedback.feedbackId, comment: feedback.comment },
        ]);
        now = new Date(now.getTime() + 60 * 60_000 + 1);
        await createOpikDelivery(database, config, options).drain();
        expect(dropped).toEqual([1]);
        expect(scores.size).toBe(0);
        const restarted = createDatabase(databaseUrl, TEST_POOL);
        try {
          const aliceReplica = web(
            restarted,
            alice,
            bot.id,
            async () => {},
            config,
          );
          expect(
            (await aliceReplica.request(path, post(feedback))).status,
          ).toBe(202);
        } finally {
          await restarted.$client.close();
        }
        available = true;
        now = new Date(now.getTime() + 60_000);
        await createOpikDelivery(database, config, options).drain();
        expect((await aliceWeb.request(path, post(feedback))).status).toBe(202);
        for (
          let attempt = 0;
          attempt < (realApi ? 5 : 2) && scoreWrites < 2;
          attempt++
        ) {
          now = new Date(now.getTime() + 11_000);
          await createOpikDelivery(database, config, options).drain();
        }
        await createOpikDelivery(database, config, options).drain();
        expect(scoreWrites).toBe(2);
        expect([...scores.values()]).toEqual([1]);
        const incompleteTrace = tracePosts[0];
        expect(tracePosts.length).toBeGreaterThanOrEqual(2);
        expect(incompleteTrace).toMatchObject({
          name: "OpenBot Run (incomplete)",
          metadata: { incomplete: true, status: "completed" },
        });
        for (const trace of tracePosts) expect(trace).toEqual(incompleteTrace);
        expect(JSON.stringify(tracePosts)).not.toContain("private");

        const ordinary = await aliceWeb.request(
          `${botPath}/run`,
          post({
            runId: crypto.randomUUID(),
            threadId: channel.threadId,
            messages: [
              {
                role: "user",
                id: "ordinary",
                content: "private ordinary prompt",
              },
            ],
          }),
        );
        expect(await ordinary.text()).toContain("Offline answer.");
        now = new Date();

        const delivery = createOpikDelivery(database, config, options).start();
        try {
          for (
            let attempt = 0;
            attempt < (realApi ? 75 : 2) &&
            !tracePosts.some((trace) => !trace.metadata.incomplete);
            attempt++
          )
            await Bun.sleep(1000);
        } finally {
          await delivery.stop();
        }
        const ordinaryTrace = tracePosts.find(
          (trace) => !trace.metadata.incomplete,
        );
        expect(ordinaryTrace).toMatchObject({
          name: "OpenBot Run",
          metadata: { incomplete: false, status: "completed" },
        });
        if (realApi) {
          const base = new URL(realApi.endsWith("/") ? realApi : `${realApi}/`);
          for (const trace of [incompleteTrace, ordinaryTrace]) {
            if (!trace) throw new Error("Trace was not sent");
            const url = new URL(`v1/private/traces/${trace.id}`, base);
            let response = await fetch(url);
            for (let attempt = 0; !response.ok && attempt < 30; attempt++) {
              await response.body?.cancel();
              await Bun.sleep(100);
              response = await fetch(url);
            }
            expect(response.status).toBe(200);
            const record = await response.json();
            expect(record.name).toBe(trace.name);
            expect(record.metadata).toEqual(trace.metadata);
            expect(record.input ?? null).toBeNull();
            expect(record.output ?? null).toBeNull();
            expect(JSON.stringify(record)).not.toContain("private");
            if (trace === incompleteTrace) {
              expect(record.feedback_scores).toMatchObject([
                { name: "user_feedback", value: 1 },
              ]);
              expect(record.feedback_scores).toHaveLength(1);
            }
          }
        }
      } finally {
        opik.stop(true);
      }
    } finally {
      await database.delete(channels).where(eq(channels.id, channel.id));
      await database.delete(users).where(eq(users.id, alice.id));
      await database.delete(users).where(eq(users.id, bob.id));
    }
  },
  process.env.TEST_OPIK_API_URL ? 300_000 : 30_000,
);
