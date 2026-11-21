import { afterAll, expect, spyOn, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  HttpAgent,
  type RunAgentInput,
} from "@ag-ui/client";
import { answerMessageId } from "@openbot/shared/handoff-markers";
import {
  HeadlessToolSuspension,
  HeadlessToolsMiddleware,
} from "@openbot/toolkit/headless-tools";
import { and, eq, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { Observable } from "rxjs";
import {
  askChannelAgent,
  messageText,
} from "../../app/src/lib/voice/agent-bridge";
import { VoiceSession } from "../../app/src/lib/voice/session";
import type { VoiceEvent } from "../../app/src/lib/voice/types";
import { createHandoffDesk, HANDOFF_KIND } from "../src/agents/handoff";
import { createHandoffRunner } from "../src/agents/handoff-runner";
import { handoffTool } from "../src/agents/handoff-tool";
import { createOpenBotHandoffDelivery } from "../src/agents/handoff-wiring";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApprovalResumeTick } from "../src/approvals/resume-sweep";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { withApprovalContext } from "../src/approvals/types";
import { createAuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  createAttachmentRoutes,
  createChannelAttachmentRoutes,
} from "../src/channels/attachments";
import type { DirectChatReflect } from "../src/channels/direct-chat";
import { expireDirectChatEvents } from "../src/channels/direct-chat-replay";
import {
  createGroupConversations,
  createGroupRoutes,
  createGroupStore,
} from "../src/channels/group";
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
  attachments,
  auditEvents,
  channelMemberships,
  channels,
  directChatRunEvents,
  directChatRuns,
  learningSettings,
  opikRuns,
  recorderConnections,
  revokedAccess,
  userRoles,
  users,
  workItems,
} from "../src/db/schema";
import { createLearningRoutes } from "../src/learning/routes";
import { createLearningSettingsStore } from "../src/learning/settings";
import { createMemoryStore } from "../src/memory/store";
import { createRecorderConnectionStore } from "../src/recorder/connections";
import { createOpenBotRecordings } from "../src/recorder/openbot-recordings";
import { createRecorderRoutes } from "../src/recorder/routes";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { createRoutineRoutes } from "../src/routines/routes";
import { createRoutineRunner, createRoutineTurn } from "../src/routines/runner";
import { createRoutineStore } from "../src/routines/store";
import { createWorkQueue } from "../src/work/queue";
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
  await database.insert(userRoles).values({ userId: id, role: "user" });
  return { id, email, role: "user" };
}

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

class AnsweringAgent extends AbstractAgent {
  constructor(
    private readonly answer: (input: RunAgentInput) => Promise<void>,
    private readonly partial?: string,
  ) {
    super();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const { threadId, runId } = input;
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
      void this.answer(input).then(
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
  answer: (input: RunAgentInput) => Promise<void>,
  {
    deployment = config,
    opik,
    partial,
    learningClock,
    prepare,
    authorized,
    reflect,
    buildAgent,
  }: {
    deployment?: typeof config;
    opik?: typeof config.opik;
    partial?: string;
    learningClock?: () => Date;
    prepare?: () => Promise<void>;
    authorized?: () => boolean;
    reflect?: DirectChatReflect;
    buildAgent?: () => AbstractAgent;
  } = {},
) {
  const store = createAgentProfileStore(db, endpoint);
  const channelStore = createChannelStore(
    db,
    store,
    createThreadIdentity("issue-31"),
  );
  const agentFor = async (_actor: unknown, id: string) => {
    if (id !== botId) throw new Error("Unexpected Bot.");
    await prepare?.();
    return buildAgent?.() ?? new AnsweringAgent(answer, partial);
  };
  const groupStore = createGroupStore(db, () => crypto.randomUUID());
  const groupConversations = createGroupConversations({
    store: groupStore,
    queue: createWorkQueue(db),
    owner: "fixture-group",
    roster: async (id, channelId) => {
      const channel = await channelStore.get({ id, role: "user" }, channelId);
      if (!channel || channel.agentIds.length < 2) return null;
      return channel.agentIds.map((id) => ({ id, name: id }));
    },
    runTurn: async () => {
      throw new Error("Unexpected legacy group turn.");
    },
    caps: { maxDepth: 2, maxPerRun: 3 },
    mayAddress: async () => true,
    auditStore: createAuditStore(db),
  });
  const copilot = mountCopilotRuntime(
    { ...deployment, ...(opik ? { opik } : {}) },
    {
      resolveAgentsForActor: async () => ({
        [botId]: await agentFor(actor, botId),
      }),
      resolveAgentForActor: agentFor,
    },
    async () => ({ id: actor.id, name: actor.id }),
    async () => (authorized?.() === false ? { id: "", role: "user" } : actor),
    {
      directChat: {
        database: db,
        profiles: store,
        reflect,
        learningClock,
        groupThread: groupStore.thread,
        publishGroupReply: groupConversations.announceHandoff,
        backgroundActor: async () => actor,
      },
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
  app.route(
    "/api/channels",
    createChannelRoutes(
      channelStore,
      requireUser,
      undefined,
      createAuditStore(db),
    ),
  );
  app.route("/api/channels", createChannelAttachmentRoutes(db, requireUser));
  app.route("/api/attachments", createAttachmentRoutes(db, requireUser));
  app.route(
    "/api/approvals",
    createApprovalRoutes(
      createApprovalService(createApprovalStore(db)),
      requireUser,
    ),
  );
  const routineStore = createRoutineStore(db);
  const routineRunner = createRoutineRunner({
    routineStore,
    channelStore,
    runTurn: createRoutineTurn(
      copilot.runBackground ??
        (() =>
          Promise.reject(new Error("OpenBot background runs unavailable."))),
      async () => {
        if (authorized?.() === false) throw new Error("Account disabled.");
        return actor;
      },
    ),
  });
  app.route(
    "/api/routines",
    createRoutineRoutes(routineStore, requireUser, { runner: routineRunner }),
  );
  app.route("/api/groups", createGroupRoutes(groupConversations, requireUser));
  app.route("/", copilot.handler);
  return Object.assign(app, {
    sweepLearning: copilot.sweepLearning,
    routineRunner,
    runBackground: copilot.runBackground,
    backgroundApproval: copilot.backgroundApproval,
    channelStore,
  });
}

test("Run now has the same Conversation Run after redelivery to a restarted worker", async () => {
  const actor = await person();
  const bot = await profiles.create(actor, {
    name: "Routine Bot",
    title: "Bot",
    roleDescription: "Reports on demand.",
    visibility: "private",
  });
  let dispatches = 0;
  const answer = async () => {
    dispatches++;
  };
  const preparing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const app = web(database, actor, bot.id, answer, {
    prepare: async () => {
      preparing.resolve();
      await release.promise;
    },
  });
  const response = await app.request(
    "/api/channels",
    post({ agentIds: [bot.id] }),
  );
  expect(response.status).toBe(201);
  const { channel } = await response.json();
  const store = createRoutineStore(database);
  const routine = await store.create({
    ownerUserId: actor.id,
    agentId: bot.id,
    channelId: channel.id,
    instruction: "Send the status report.",
    cron: "0 9 * * *",
  });
  const fired = await app.request(`/api/routines/${routine.id}/run`, post({}));
  expect(fired.status).toBe(202);
  const { runId } = await fired.json();
  const history = async () =>
    (await app.request(`/api/routines/${routine.id}/runs`)).json();
  const restarted = web(database, actor, bot.id, answer);
  try {
    await preparing.promise;
    expect(await history()).toMatchObject({
      runs: [{ id: runId, status: "running", conversationRunId: runId }],
    });
    await restarted.routineRunner.run(runId);
    expect(await history()).toMatchObject({
      runs: [{ id: runId, status: "succeeded", conversationRunId: runId }],
    });
  } finally {
    release.resolve();
    await app.routineRunner.run(runId);
  }
  await restarted.routineRunner.run(runId);
  expect(dispatches).toBe(1);
  const conversation = await restarted.request(
    `/api/copilotkit/threads/${channel.threadId}/messages?agentId=${bot.id}`,
  );
  const transcript = await conversation.json();
  expect(transcript.runs).toMatchObject([{ id: runId, status: "completed" }]);
  expect(transcript.messages).toContainEqual({
    id: `reply-${runId}`,
    role: "assistant",
    content: "Offline answer.",
  });
}, 60_000);

test("Run now completes in a shared Conversation", async () => {
  const actor = await person();
  const bot = await profiles.create(actor, {
    name: "Shared Routine Bot",
    title: "Bot",
    roleDescription: "Reports on demand.",
    visibility: "private",
  });
  const peer = await profiles.create(actor, {
    name: "Peer Bot",
    title: "Bot",
    roleDescription: "Shares the conversation.",
    visibility: "private",
  });
  let dispatches = 0;
  const app = web(database, actor, bot.id, async () => {
    dispatches++;
  });
  const created = await app.request(
    "/api/channels",
    post({ agentIds: [bot.id, peer.id] }),
  );
  expect(created.status).toBe(201);
  const { channel } = await created.json();
  const groups = createGroupStore(database, () => crypto.randomUUID());
  await groups.seedOrder(actor.id, channel.id, [bot.id, peer.id]);
  const threadId = await groups.thread(actor.id, channel.id, bot.id);
  const routine = await createRoutineStore(database).create({
    ownerUserId: actor.id,
    agentId: bot.id,
    channelId: channel.id,
    instruction: "Send the shared report.",
    cron: "0 9 * * *",
  });
  const fired = await app.request(`/api/routines/${routine.id}/run`, post({}));
  expect(fired.status).toBe(202);
  const { runId } = await fired.json();
  await app.routineRunner.run(runId);
  const history = await app.request(`/api/routines/${routine.id}/runs`);
  expect(await history.json()).toMatchObject({
    runs: [{ id: runId, status: "succeeded", conversationRunId: runId }],
  });
  const transcript = await app.request(
    `/api/copilotkit/threads/${threadId}/messages?agentId=${bot.id}`,
  );
  expect(await transcript.json()).toMatchObject({
    runs: [{ id: runId, status: "completed" }],
  });
  const group = await app.request(`/api/groups/${channel.id}`);
  expect(await group.json()).toMatchObject({
    messages: [{ id: runId, text: "Offline answer.", status: "completed" }],
  });
  expect(dispatches).toBe(1);
}, 60_000);

for (const outcome of ["allow", "stop", "revoke"] as const) {
  test(`a background approval can ${outcome} the original Routine Run`, async () => {
    const actor = await person();
    const bot = await profiles.create(actor, {
      name: "Approval Routine",
      title: "Bot",
      roleDescription: "Asks before acting.",
      visibility: "private",
    });
    const approvals = createApprovalStore(database);
    await approvals.setEnabled(actor.id, true);
    const service = createApprovalService(approvals);
    let executions = 0;
    let resumes = 0;
    const action = async () => {
      const approval = await service.gate({
        actorId: actor.id,
        botId: bot.id,
        toolRef: "fixture:write",
        scope: "fixture",
        effect: "write",
        args: {},
      });
      if (approval?.replay !== undefined) return approval.replay;
      executions++;
      await approval?.complete("done");
      return "done";
    };
    class ToolAgent extends AnsweringAgent {
      override run(input: RunAgentInput) {
        if (
          input.messages.some(
            (message) =>
              message.role === "tool" && message.content.includes("done"),
          )
        ) {
          resumes++;
          return super.run(input);
        }
        return new Observable<BaseEvent>((observer) => {
          const { threadId, runId } = input;
          const toolCallId = "fixture-call";
          observer.next({ type: EventType.RUN_STARTED, threadId, runId });
          observer.next({
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName: "fixture_write",
          });
          observer.next({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId,
            delta: "{}",
          });
          observer.next({ type: EventType.TOOL_CALL_END, toolCallId });
          observer.next({ type: EventType.RUN_FINISHED, threadId, runId });
          observer.complete();
        });
      }
    }
    const buildAgent = () => {
      const agent = new ToolAgent(async () => {});
      agent.use(
        new HeadlessToolsMiddleware([
          {
            definition: {
              name: "fixture_write",
              description: "write",
              parameters: {},
            },
            execute: action,
          },
        ]),
      );
      return agent;
    };
    const app = web(database, actor, bot.id, async () => {}, { buildAgent });
    const restarted = web(database, actor, bot.id, async () => {}, {
      buildAgent,
    });
    const { channel } = await (
      await app.request("/api/channels", post({ agentIds: [bot.id] }))
    ).json();
    const routine = await createRoutineStore(database).create({
      ownerUserId: actor.id,
      channelId: channel.id,
      agentId: bot.id,
      instruction: "Run the approved operation.",
      cron: "0 9 * * *",
    });
    const fired = await app.request(
      `/api/routines/${routine.id}/run`,
      post({}),
    );
    const { runId } = await fired.json();
    await app.routineRunner.run(runId);
    const thread = `/api/copilotkit/threads/${channel.threadId}`;
    const history = async () =>
      (await app.request(`${thread}/messages?agentId=${bot.id}`)).json();
    expect(await history()).toMatchObject({
      runs: [{ id: runId, status: "running", waitingForApproval: true }],
    });
    const [approval] = await approvals.list(actor.id);
    if (!approval) throw new Error("Missing approval.");
    const decision = await app.request(
      `/api/approvals/${approval.id}/decision`,
      post({ decision: "allow_once" }),
    );
    expect(decision.status).toBe(200);
    if (outcome === "stop") {
      const stopped = await app.request(
        `${thread}/runs/${runId}/stop?agentId=${bot.id}`,
        post({}),
      );
      expect(await stopped.json()).toEqual({ stopped: true });
    }
    if (outcome === "revoke") {
      await database
        .insert(revokedAccess)
        .values({ email: actor.email, revokedBy: actor.id });
    }
    const tick = createApprovalResumeTick({
      approvalQueue: createWorkQueue(database),
      approvalOwner: `worker-${runId}`,
      approvalService: service,
      executeApprovedAction: action,
      database,
      responsibilityStore: createResponsibilityStore(database, {
        resolveTarget: async () => null,
      }),
      groupConversations: {
        continueWaiting: async () => {
          throw new Error("Wrong continuation path.");
        },
      },
      approvalContinuationRunner: async () => {
        throw new Error("Intelligence cannot resume this Run.");
      },
      backgroundApproval: restarted.backgroundApproval,
      channelStore: restarted.channelStore,
      actorFor: async () => actor,
      notify: async () => {},
    });
    await tick();
    await tick();
    await restarted.routineRunner.run(runId);
    await restarted.routineRunner.run(runId);
    const completed = outcome === "allow";
    expect(await history()).toMatchObject({
      runs: [{ id: runId, status: completed ? "completed" : "failed" }],
    });
    expect(executions).toBe(completed ? 1 : 0);
    expect(resumes).toBe(completed ? 1 : 0);
  }, 60_000);
}

test("Routine recovery checks an unknown model outcome without dispatching again", async () => {
  const actor = await person();
  const bot = await profiles.create(actor, {
    name: "Routine Recovery",
    title: "Bot",
    roleDescription: "Reports.",
    visibility: "private",
  });
  const paths: string[] = [];
  let reconciledOperation: string | undefined;
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      const call = await request.json();
      if (path === "/v1/reserve") {
        expect(call.scope.personId).toBe(actor.id);
        reconciledOperation = call.operationId;
        return Response.json({ state: "reserved", permit: "test-permit" });
      }
      expect(call.operationId).toBe(reconciledOperation);
      if (path === "/v1/dispatch") return new Response(null, { status: 504 });
      return Response.json({ state: "pending" });
    },
  });
  try {
    const deployment = loadConfig({
      DATABASE_URL: databaseUrl,
      OPENBOT_ORGANIZATION_AUTH_URL: "https://example.test",
      KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      OPENBOT_MANAGED_MODEL_TRIAL_URL: control.url.href,
      OPENBOT_MANAGED_MODEL_TRIAL_TOKEN: "test-token",
      OPENBOT_MANAGED_MODEL_TRIAL_ROUTE: "pilot-text-v1",
    });
    const legacy = async () => {
      throw new Error("Unexpected legacy model call.");
    };
    const options = { deployment };
    const app = web(database, actor, bot.id, legacy, options);
    const response = await app.request(
      "/api/channels",
      post({ agentIds: [bot.id] }),
    );
    expect(response.status).toBe(201);
    const { channel } = await response.json();
    const store = createRoutineStore(database);
    const routine = await store.create({
      ownerUserId: actor.id,
      agentId: bot.id,
      channelId: channel.id,
      instruction: "Send the report.",
      cron: "0 9 * * *",
    });
    const fire = () => app.request(`/api/routines/${routine.id}/run`, post({}));
    const fired = await fire();
    expect(fired.status).toBe(202);
    const { runId } = await fired.json();
    await app.routineRunner.run(runId);
    const restarted = web(database, actor, bot.id, legacy, options);
    await restarted.routineRunner.run(runId);
    expect(paths).toEqual([
      "/v1/reserve",
      "/v1/dispatch",
      "/v1/reconcile",
      "/v1/reconcile",
    ]);
    const historyResponse = await restarted.request(
      `/api/copilotkit/threads/${channel.threadId}/messages?agentId=${bot.id}`,
    );
    expect(await historyResponse.json()).toMatchObject({
      runs: [{ id: runId, status: "failed", externalOutcome: "unknown" }],
    });
    await database.insert(revokedAccess).values({
      email: actor.email,
      revokedBy: "scim:directory",
    });
    const blocked = await fire();
    expect(blocked.status).toBe(202);
    const blockedRun = await blocked.json();
    await app.routineRunner.run(blockedRun.runId);
    const routineHistory = await app.request(
      `/api/routines/${routine.id}/runs`,
    );
    expect(await routineHistory.json()).toMatchObject({
      runs: [
        {
          id: blockedRun.runId,
          status: "failed",
          error: expect.stringContaining("cannot run"),
        },
        { id: runId, status: "failed", conversationRunId: runId },
      ],
    });
    expect(paths.filter((path) => path === "/v1/reserve")).toHaveLength(1);
  } finally {
    control.stop(true);
  }
}, 60_000);

for (const shared of [false, true]) {
  test(`a redelivered handoff appears once in its ${shared ? "shared" : "direct"} Conversation`, async () => {
    const actor = await person();
    const asker = await profiles.create(actor, {
      name: "Asker",
      title: "Bot",
      roleDescription: "Coordinates work.",
      visibility: "private",
    });
    const target = await profiles.create(actor, {
      name: "Answerer",
      title: "Bot",
      roleDescription: "Answers handoffs.",
      visibility: "private",
    });
    let dispatches = 0;
    const answer = async () => {
      dispatches++;
    };
    const app = web(database, actor, target.id, answer);
    const created = await app.request(
      "/api/channels",
      post({ agentIds: shared ? [asker.id, target.id] : [asker.id] }),
    );
    expect(created.status).toBe(201);
    const { channel } = await created.json();
    const threadId = shared
      ? await createGroupStore(database, () => crypto.randomUUID()).thread(
          actor.id,
          channel.id,
          asker.id,
        )
      : channel.threadId;
    const queue = createWorkQueue(database);
    const auditStore = createAuditStore(database);
    const actorFor = async () => actor;
    const mayAddress = async (from: string, to: string) =>
      from === asker.id && to === target.id;
    const desk = createHandoffDesk({
      queue,
      profiles,
      actorFor,
      mayAddress,
      auditStore,
      caps: { maxDepth: 2, maxPerRun: 3 },
    });
    const approvalStore = createApprovalStore(database);
    const approvalService = createApprovalService(approvalStore);
    await approvalStore.setEnabled(actor.id, true);
    const askingRunId = crypto.randomUUID();
    const tool = handoffTool({
      desk,
      from: {
        actorId: actor.id,
        botId: asker.id,
        threadId,
        runId: askingRunId,
      },
      hasSomebodyToAsk: true,
      maxDepth: 2,
      maxPerRun: 3,
      approvalGate: approvalService.gate,
    });
    if (!tool) throw new Error("Handoff tool unavailable.");
    const args = { bot: target.id, task: "Find the status." };
    const send = () => tool.execute(args);
    const waiting = await withApprovalContext(
      {
        runId: askingRunId,
        threadId,
        toolCallId: crypto.randomUUID(),
        toolName: "message_bot",
        args,
        messages: [
          {
            id: crypto.randomUUID(),
            role: "user",
            content: "Ask Answerer for the status.",
          },
        ],
        state: {},
        context: [],
        forwardedProps: {},
      },
      send,
    ).catch((error: unknown) => error);
    expect(waiting).toBeInstanceOf(HeadlessToolSuspension);
    const [approval] = await approvalStore.list(actor.id);
    if (!approval) throw new Error("Handoff approval was not requested.");
    const approved = await app.request(
      `/api/approvals/${approval.id}/decision`,
      post({ decision: "allow_once" }),
    );
    expect(approved.status).toBe(200);
    const continued: string[] = [];
    const resume = () =>
      approvalService.resume(actor.id, approval.id, {
        validate: (action) => approvalService.validateReentry(action, send),
        execute: send,
        continue: async ({ result }) => {
          continued.push(result.content);
        },
      });
    await resume();
    await resume();
    expect(continued).toHaveLength(1);
    expect(continued[0]).toContain("Handed to Answerer.");
    const [offered] = await database
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, HANDOFF_KIND),
          sql`${workItems.payload}->>'actorId' = ${actor.id}`,
        ),
      );
    if (!offered || !app.runBackground)
      throw new Error("Handoff was not offered.");
    const delivery = (mounted: typeof app) => {
      if (!mounted.runBackground) throw new Error("Missing OpenBot runtime.");
      return createOpenBotHandoffDelivery({
        runBackground: mounted.runBackground,
        channelStore: mounted.channelStore,
        actorFor,
        mayAddress,
      });
    };
    const runner = createHandoffRunner({
      queue,
      auditStore,
      owner: "first",
      sign: () => "",
      delivery: delivery(app),
    });
    expect((await runner.sweep()).delivered).toEqual([target.id]);

    // Restore the delivery the queue would reclaim if the first worker died before acknowledging it.
    await database
      .delete(workItems)
      .where(
        and(eq(workItems.kind, HANDOFF_KIND), eq(workItems.key, offered.key)),
      );
    await queue.offer({
      kind: HANDOFF_KIND,
      key: offered.key,
      payload: offered.payload,
    });
    const restarted = web(database, actor, target.id, answer);
    const recovered = createHandoffRunner({
      queue,
      auditStore,
      owner: "restarted",
      sign: () => "",
      delivery: delivery(restarted),
    });
    expect((await recovered.sweep()).delivered).toContain(target.id);
    if (shared) {
      await recovered.sweep();
      const group = await restarted.request(`/api/groups/${channel.id}`);
      const transcript = await group.json();
      expect(transcript.messages).toMatchObject([
        {
          agentId: asker.id,
          answeredBy: target.id,
          text: "Offline answer.",
          status: "completed",
        },
      ]);
    }
    expect(dispatches).toBe(1);
    const history = await restarted.request(
      `/api/copilotkit/threads/${threadId}/messages?agentId=${asker.id}`,
    );
    const body = await history.json();
    expect(body.runs).toHaveLength(shared ? 2 : 1);
    expect(body.runs[0]).toMatchObject({
      status: "completed",
      externalOutcome: "executed",
    });
    expect(body.messages).toContainEqual({
      id: answerMessageId(target.id, body.runs[0].id),
      role: "assistant",
      content: "Offline answer.",
    });
  }, 60_000);
}

function events(sse: string) {
  return sse
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

function voiceTurn(
  app: ReturnType<typeof web>,
  channel: { id: string; threadId: string },
  botId: string,
  request: string,
) {
  const { threadId } = channel;
  const outcome = Promise.withResolvers<unknown>();
  const dispatched = Promise.withResolvers<string>();
  let receive: (event: VoiceEvent) => void = () => {};
  const session = new VoiceSession({
    channelId: channel.id,
    context: () => "",
    connect: async (options) => {
      receive = options.onEvent;
      return {
        stream: new EventTarget() as MediaStream,
        mute() {},
        close() {},
        send(event) {
          const item = event.item;
          if (
            item &&
            typeof item === "object" &&
            "output" in item &&
            typeof item.output === "string"
          )
            outcome.resolve(JSON.parse(item.output));
        },
      };
    },
    askAgent: (text, signal) =>
      askChannelAgent(text, signal, {
        busy: () => false,
        async send(content, id) {
          const agent = new HttpAgent({
            url: `http://openbot.test/api/copilotkit/agent/${botId}/run`,
            threadId,
            fetch: (url, init) => Promise.resolve(app.request(url, init)),
          });
          agent.addMessage({ role: "user", content, id });
          dispatched.resolve(id);
          let failure: string | undefined;
          await agent.runAgent(
            { runId: id },
            {
              onRunErrorEvent: ({ event }) => {
                failure = event.message;
              },
            },
          );
          if (failure) throw new Error(failure);
          const reply = agent.messages.findLast(
            ({ role }) => role === "assistant",
          );
          return reply ? messageText(reply) : "";
        },
        async read() {
          const response = await app.request(
            `/api/copilotkit/threads/${threadId}/messages?agentId=${botId}`,
          );
          return response.json();
        },
      }),
  });
  const result = (async () => {
    await session.start();
    expect(session.getSnapshot().phase).toBe("connected");
    const call = {
      type: "response.function_call_arguments.done",
      name: "ask_agent",
      call_id: "provider-call",
      arguments: JSON.stringify({ request }),
    };
    receive(call);
    receive({
      type: "response.done",
      response: { output: [{ ...call, type: "function_call" }] },
    });
    return outcome.promise;
  })().finally(session.end);
  return { id: dispatched.promise, result, end: session.end };
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
        const aliceWeb = web(database, alice, bot.id, async () => {}, {
          opik: config,
        });
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
          const aliceReplica = web(restarted, alice, bot.id, async () => {}, {
            opik: config,
          });
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

test("archiving hides only the list entry; deletion withdraws direct history, attachments and an active stream", async () => {
  const actor = await person();
  const bot = await profiles.create(actor, {
    name: "Lifecycle Bot",
    title: "Bot",
    roleDescription: "Answers locally.",
    visibility: "private",
  });
  const started = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  const app = web(database, actor, bot.id, async () => {
    started.resolve();
    await reply.promise;
  });
  const { channel } = await (
    await app.request("/api/channels", post({ agentIds: [bot.id] }))
  ).json();
  const detail = `/api/channels/${channel.id}`;
  const history = `/api/copilotkit/threads/${channel.threadId}/messages?agentId=${bot.id}`;
  try {
    const form = new FormData();
    form.set(
      "file",
      new File(["source text"], "source.txt", { type: "text/plain" }),
    );
    const uploaded = await app.request(`${detail}/attachments`, {
      method: "POST",
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const attachment = await uploaded.json();
    const url = `/api/attachments/${attachment.id}`;
    expect((await app.request(url)).status).toBe(200);
    const run = await app.request(
      `/api/copilotkit/agent/${bot.id}/run`,
      post({
        threadId: channel.threadId,
        runId: "withdrawn-run",
        messages: [
          { id: "source", role: "user", content: "Retain the audit only." },
        ],
      }),
    );
    expect(run.status).toBe(200);
    await started.promise;
    expect(
      (await app.request(`${detail}/archive`, { method: "PUT" })).status,
    ).toBe(204);
    expect(
      (await (await app.request("/api/channels")).json()).channels,
    ).toEqual([]);
    expect((await app.request(history)).status).toBe(200);
    expect((await app.request(url)).status).toBe(200);
    expect((await (await app.request(detail)).json()).channel.archived).toBe(
      true,
    );
    expect(
      (await app.request(`${detail}/archive`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(
      (await (await app.request("/api/channels")).json()).channels,
    ).toHaveLength(1);
    expect((await app.request(detail, { method: "DELETE" })).status).toBe(204);
    reply.resolve();
    expect(await run.text()).not.toContain("Offline answer.");
    expect((await app.request(history)).status).toBe(404);
    expect(
      (
        await app.request(
          `/api/copilotkit/agent/${bot.id}/resume`,
          post({
            threadId: channel.threadId,
            runId: "withdrawn-run",
            cursor: 0,
          }),
        )
      ).status,
    ).toBe(404);
    expect((await app.request(url)).status).toBe(404);
    expect((await app.request(detail, { method: "DELETE" })).status).toBe(204);
    expect(
      await database
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "channel.deleted"),
            eq(auditEvents.targetId, channel.id),
          ),
        ),
    ).toHaveLength(1);
    const withdrawals = await database.execute(
      sql`select channel_id from conversation_evidence_withdrawals where channel_id = ${channel.id} and processed_at is null`,
    );
    expect(withdrawals).toHaveLength(1);
    const { purgeDeletedConversations } = await import(
      "../src/channels/deletion-cleanup"
    );
    await purgeDeletedConversations(database);
    expect(
      await database
        .select()
        .from(attachments)
        .where(eq(attachments.channelId, channel.id)),
    ).toEqual([]);
    expect(
      await database
        .select()
        .from(directChatRuns)
        .where(eq(directChatRuns.threadId, channel.threadId)),
    ).toEqual([]);
    expect((await app.request(history)).status).toBe(404);
    expect((await app.request(detail, { method: "DELETE" })).status).toBe(204);
  } finally {
    reply.resolve();
    await database.delete(channels).where(eq(channels.id, channel.id));
    await database.delete(agents).where(eq(agents.id, bot.id));
    await database.delete(users).where(eq(users.id, actor.id));
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
  const app = web(
    database,
    actor,
    bot.id,
    async () => {
      dispatches++;
      started.resolve();
      await release.promise;
    },
    { opik: { apiUrl: new URL("http://127.0.0.1:1/api/"), project: "replay" } },
  );
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
    const replayed = await replay.text();
    expect(replayed.match(/^id: (\d+)$/gm)).toEqual([
      "id: 2",
      "id: 3",
      "id: 4",
      "id: 5",
    ]);
    expect(events(replayed).map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(dispatches).toBe(1);
    expect(
      await database
        .select({ status: opikRuns.status })
        .from(opikRuns)
        .where(
          and(
            eq(opikRuns.threadId, channel.threadId),
            eq(opikRuns.runId, input.runId),
          ),
        ),
    ).toEqual([{ status: "completed" }]);
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
  const app = web(database, actor, bot.id, () => release.promise, {
    partial: "Partial: ",
  });
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

test("an open replay stream closes when the reader loses access", async () => {
  const actor = await person();
  const bot = await profiles.create(actor, {
    name: "Replay authorization Bot",
    title: "Bot",
    roleDescription: "Answers locally.",
    visibility: "private",
  });
  const release = Promise.withResolvers<void>();
  const app = web(database, actor, bot.id, () => release.promise);
  const { channel } = await (
    await app.request("/api/channels", post({ agentIds: [bot.id] }))
  ).json();
  const key = { threadId: channel.threadId, runId: crypto.randomUUID() };
  const base = `/api/copilotkit/agent/${bot.id}`;
  try {
    const first = await app.request(
      `${base}/run`,
      post({
        ...key,
        messages: [{ role: "user", id: "prompt", content: "Hello" }],
      }),
    );
    const reader = first.body?.getReader();
    if (!reader) throw new Error("Missing Run stream");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "id: 1\n",
    );
    await reader.cancel();

    const resumed = await app.request(
      `${base}/resume`,
      post({ ...key, cursor: 1 }),
    );
    expect(resumed.status).toBe(200);

    await database
      .delete(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channel.id),
          eq(channelMemberships.userId, actor.id),
        ),
      );
    release.resolve();
    expect(events(await resumed.text())).toEqual([
      {
        type: EventType.RUN_ERROR,
        message: "The Bot run is unavailable.",
      },
    ]);
  } finally {
    release.resolve();
    await database.delete(channels).where(eq(channels.id, channel.id));
    await database.delete(agents).where(eq(agents.id, bot.id));
    await database.delete(users).where(eq(users.id, actor.id));
  }
});

test("Conversation and voice turns share Test Credits, reconcile uncertain dispatch, and keep history readable during an outage", async () => {
  const alice = await person();
  const bots: string[] = [];
  const conversations: string[] = [];
  const ids = new Set<string>();
  const calls: { path: string; operationId: string }[] = [];
  let uncertainOperation: string | undefined;
  let uncertainState: "pending" | "settled" | "released" = "pending";
  let verifiedText: string | undefined;
  let confirmedUnsent = false;
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
      const call = await request.json();
      calls.push({ path, operationId: call.operationId });
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
        ...(call.operationId === uncertainOperation &&
          (confirmedUnsent
            ? { outcome: "not_dispatched" }
            : verifiedText && { outcome: "executed", text: verifiedText })),
        state:
          call.operationId === uncertainOperation
            ? uncertainState
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
          {
            deployment,
            opik: {
              apiUrl: new URL("http://127.0.0.1:1/api/"),
              project: "managed",
            },
          },
        );
        const opened = await app.request(
          "/api/channels",
          post({ agentIds: [bot.id] }),
        );
        expect(opened.status).toBe(201);
        const { channel } = await opened.json();
        conversations.push(channel.id);
        return {
          threadId: channel.threadId,
          voice: (request: string) => voiceTurn(app, channel, bot.id, request),
          resume: async (runId: string, cursor: number) =>
            app.request(
              `/api/copilotkit/agent/${bot.id}/resume`,
              post({ threadId: channel.threadId, runId, cursor }),
            ),
          run: async (id: string, runId = id, content = "A question.") =>
            (
              await app.request(
                `/api/copilotkit/agent/${bot.id}/run`,
                post({
                  threadId: channel.threadId,
                  runId,
                  messages: [{ role: "user", id, content }],
                  personId: "forged-person",
                  model: "forged-route",
                }),
              )
            ).text(),
          reconcile: (runId: string) =>
            app.request(
              `/api/copilotkit/threads/${channel.threadId}/runs/${runId}/reconcile?agentId=${bot.id}`,
              post({}),
            ),
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
    const callsBeforeResume = calls.length;
    const replay = await winner.resume("same-browser-id", 1);
    expect(replay.status).toBe(200);
    const replayed = await replay.text();
    expect(replayed.match(/^id: (\d+)$/gm)).toEqual([
      "id: 2",
      "id: 3",
      "id: 4",
      "id: 5",
    ]);
    expect(events(replayed).map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(replayed).toContain("Managed answer.");
    expect(await winner.run("same-browser-id")).toContain("Managed answer.");
    expect(calls).toHaveLength(callsBeforeResume);
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
    const uncertainReplay = await winner.resume("uncertain-message", 1);
    expect(uncertainReplay.status).toBe(200);
    expect(events(await uncertainReplay.text())).toContainEqual(
      expect.objectContaining({
        type: EventType.RUN_ERROR,
        code: "reconciling",
      }),
    );
    expect(await winner.run("different-message")).toContain(
      "The previous Run has an unverified external outcome.",
    );
    expect(await (await winner.history()).text()).toContain(
      '"externalOutcome":"unknown"',
    );
    uncertainState = "settled";
    expect(
      events(await winner.run("uncertain-message", "later-browser-run")),
    ).toContainEqual(
      expect.objectContaining({ type: EventType.RUN_ERROR, code: "settled" }),
    );
    expect(calls.slice(beforeUncertain)).toEqual(
      [
        "/v1/reserve",
        "/v1/dispatch",
        "/v1/reconcile",
        "/v1/reconcile",
        "/v1/reconcile",
      ].map((path) => ({ path, operationId })),
    );
    expect(
      await database
        .select({ runId: opikRuns.runId, status: opikRuns.status })
        .from(opikRuns)
        .where(eq(opikRuns.threadId, winner.threadId)),
    ).toEqual(
      expect.arrayContaining([
        { runId: "same-browser-id", status: "completed" },
        { runId: "uncertain-message", status: "failed" },
      ]),
    );
    expect(await (await winner.reconcile("uncertain-message")).json()).toEqual({
      externalOutcome: "unknown",
      settlement: "settled",
    });
    verifiedText = "Verified original reply.";
    expect(await (await winner.reconcile("uncertain-message")).json()).toEqual({
      externalOutcome: "executed",
      settlement: "settled",
    });
    expect(await (await winner.history()).text()).toContain(verifiedText);
    const recovered = await winner.resume("uncertain-message", 1);
    const recoveredEvents = events(await recovered.text());
    expect(recoveredEvents).toContainEqual(
      expect.objectContaining({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "assistant", content: verifiedText }),
        ]),
      }),
    );
    expect(recoveredEvents.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
    });
    expect(dispatches).toBe(2);
    available = true;
    verifiedText = undefined;
    uncertainState = "pending";
    const uncertainVoice = winner.voice("Please do this from the call.");
    expect(await uncertainVoice.result).toEqual({
      error: expect.stringContaining("unverified outcome"),
    });
    const uncertainVoiceId = await uncertainVoice.id;
    expect((await (await winner.history()).json()).runs).toContainEqual(
      expect.objectContaining({
        id: uncertainVoiceId,
        userMessageId: uncertainVoiceId,
        status: "failed",
        externalOutcome: "unknown",
      }),
    );
    expect(await winner.voice("Try it again.").result).toEqual({
      error: expect.stringContaining("unverified external outcome"),
    });
    uncertainState = "released";
    confirmedUnsent = true;
    expect(await (await winner.reconcile(uncertainVoiceId)).json()).toEqual({
      externalOutcome: "not_dispatched",
      settlement: "released",
    });
    expect(dispatches).toBe(3);

    expect(
      await winner.run(
        uncertainVoiceId,
        "new-browser-run",
        "Please do this from the call.",
      ),
    ).toContain("released");
    expect(dispatches).toBe(3);
    loseDispatchResponse = false;
    expect(await winner.run("retry-without-credits")).toContain(
      "insufficient_credits",
    );
    expect(dispatches).toBe(3);
    available = true;
    const voiceRetry = winner.voice("Please try now.");
    expect(await voiceRetry.result).toEqual({ answer: "Managed answer." });
    expect((await (await winner.history()).json()).runs).toContainEqual(
      expect.objectContaining({
        id: await voiceRetry.id,
        status: "completed",
        externalOutcome: "executed",
      }),
    );
    expect(dispatches).toBe(4);
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

test("another worker resumes a persisted Run before dispatch and the original worker cannot dispatch it again", async () => {
  const actor = await person();
  const bot = await profiles.create(actor, {
    name: "Recovery Bot",
    title: "Bot",
    roleDescription: "Answers locally.",
    visibility: "private",
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let dispatches = 0;
  const answer = async () => {
    dispatches++;
  };
  const original = web(database, actor, bot.id, answer, {
    prepare: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const { channel } = await (
    await original.request("/api/channels", post({ agentIds: [bot.id] }))
  ).json();
  const key = { threadId: channel.threadId, runId: "recoverable" };
  const base = `/api/copilotkit/agent/${bot.id}`;
  const message = { role: "user", id: "prompt", content: "Hello." };
  try {
    const first = await original.request(
      `${base}/run`,
      post({ ...key, messages: [message] }),
    );
    await entered.promise;
    await first.body?.cancel();
    const resumed = Promise.withResolvers<void>();
    const replacement = web(database, actor, bot.id, async () => {
      await answer();
      resumed.resolve();
    });
    const opened = await replacement.request(
      `${base}/connect`,
      post({ threadId: key.threadId }),
    );
    expect(await opened.text()).toContain(message.content);
    await resumed.promise;
    const reattached = await replacement.request(
      `${base}/resume`,
      post({ ...key, cursor: 0 }),
    );
    expect(reattached.status).toBe(200);
    expect(events(await reattached.text())).toContainEqual({
      type: EventType.RUN_FINISHED,
      ...key,
    });
    release.resolve();
    const repeated = await original.request(
      `${base}/run`,
      post({ ...key, messages: [message] }),
    );
    expect(await repeated.text()).toContain("Offline answer.");
    expect(dispatches).toBe(1);
  } finally {
    release.resolve();
    await database.delete(channels).where(eq(channels.id, channel.id));
    await database.delete(agents).where(eq(agents.id, bot.id));
    await database.delete(users).where(eq(users.id, actor.id));
  }
});

test("a voice request uses the current Conversation's approval and access controls", async () => {
  const owner = await person();
  const bot = await profiles.create(owner, {
    name: "Voice Bot",
    title: "Bot",
    roleDescription: "Answers locally.",
    visibility: "private",
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let authorized = true;
  let executions = 0;
  const app = web(
    database,
    owner,
    bot.id,
    async () => {
      executions++;
      entered.resolve();
      await release.promise;
    },
    { authorized: () => authorized },
  );
  const { channel } = await (
    await app.request("/api/channels", post({ agentIds: [bot.id] }))
  ).json();
  const voice = voiceTurn(app, channel, bot.id, "Please do the work.");
  try {
    const runId = await voice.id;
    await entered.promise;
    const approval = await createApprovalStore(database).open({
      threadId: channel.threadId,
      runId,
      toolCallId: "voice-tool",
      actionDigest: "voice-action",
      actorId: owner.id,
      botId: bot.id,
      toolRef: "fixture",
      scope: "fixture",
      effect: "fixture",
      args: {},
    });
    const thread = `/api/copilotkit/threads/${channel.threadId}`;
    const history = `${thread}/messages?agentId=${bot.id}`;
    expect((await (await app.request(history)).json()).runs).toContainEqual(
      expect.objectContaining({
        id: runId,
        status: "running",
        waitingForApproval: true,
      }),
    );
    expect(
      (
        await app.request(
          `${thread}/runs/${runId}/stop?agentId=${bot.id}`,
          post({}),
        )
      ).status,
    ).toBe(200);
    expect(await voice.result).toEqual({
      error: "The user stopped this task before it completed.",
    });
    expect(
      (
        await app.request(
          `/api/approvals/${approval.id}/decision`,
          post({ decision: "allow_once" }),
        )
      ).status,
    ).toBe(404);
    authorized = false;
    expect(await voiceTurn(app, channel, bot.id, "Try again.").result).toEqual({
      error: expect.any(String),
    });
    expect((await app.request(history)).status).toBe(404);
    authorized = true;
    expect((await (await app.request(history)).json()).runs).toHaveLength(1);
    expect(executions).toBe(1);
  } finally {
    voice.end();
    release.resolve();
    await database.delete(channels).where(eq(channels.id, channel.id));
    await database.delete(agents).where(eq(agents.id, bot.id));
    await database.delete(users).where(eq(users.id, owner.id));
  }
});

test("only the owner can stop an active Run and the stopped Run rejects a late approval and preserves output", async () => {
  const actor = await person();
  const stranger = await person();
  const bot = await profiles.create(actor, {
    name: "Stoppable Bot",
    title: "Bot",
    roleDescription: "Answers locally.",
    visibility: "private",
  });
  const release = Promise.withResolvers<void>();
  const app = web(database, actor, bot.id, () => release.promise, {
    partial: "Partial output.",
  });
  const other = web(database, stranger, bot.id, async () => {});
  const { channel } = await (
    await app.request("/api/channels", post({ agentIds: [bot.id] }))
  ).json();
  const key = { threadId: channel.threadId, runId: "waiting" };
  const base = `/api/copilotkit/agent/${bot.id}`;
  const thread = `/api/copilotkit/threads/${key.threadId}`;
  const stop = `${thread}/runs/${key.runId}/stop?agentId=${bot.id}`;
  const send = (runId: string) =>
    app.request(
      `${base}/run`,
      post({
        ...key,
        runId,
        messages: [{ role: "user", id: runId, content: "Hello." }],
      }),
    );
  try {
    const reader = (await send(key.runId)).body?.getReader();
    if (!reader) throw new Error("Missing Run stream.");
    let partial = "";
    while (!partial.includes("Partial output.")) {
      const read = await reader.read();
      if (read.done) throw new Error("Run ended before sending output.");
      partial += new TextDecoder().decode(read.value);
    }
    const approvals = createApprovalStore(database);
    const request = await approvals.open({
      ...key,
      toolCallId: "call",
      actionDigest: "digest",
      actorId: actor.id,
      botId: bot.id,
      toolRef: "fixture",
      scope: "fixture",
      effect: "fixture",
      args: {},
    });
    const waiting = await (
      await app.request(`${thread}/messages?agentId=${bot.id}`)
    ).json();
    expect(waiting.runs).toContainEqual(
      expect.objectContaining({
        id: key.runId,
        status: "running",
        waitingForApproval: true,
      }),
    );
    expect((await send("next")).status).toBe(409);
    expect((await other.request(stop, post({}))).status).toBe(404);
    expect(await (await app.request(stop, post({}))).json()).toEqual({
      stopped: true,
    });
    const lateDecision = await app.request(
      `/api/approvals/${request.id}/decision`,
      post({ decision: "allow_once" }),
    );
    expect(lateDecision.status).toBe(404);
    release.resolve();
    let tail = "";
    for (
      let read = await reader.read();
      !read.done;
      read = await reader.read()
    ) {
      tail += new TextDecoder().decode(read.value);
    }
    expect(events(tail)).toEqual([
      {
        type: EventType.RUN_ERROR,
        code: "stopped",
        message: "The Bot run was stopped.",
      },
    ]);
    const beforeNext = await (
      await app.request(`${thread}/messages?agentId=${bot.id}`)
    ).text();
    expect(beforeNext).toContain("Partial output.");
    expect(beforeNext).toContain('"stopReason":"stopped"');
    expect(beforeNext).not.toContain("Offline answer.");
    expect(await (await send("next")).text()).toContain("Offline answer.");
  } finally {
    release.resolve();
    await database.delete(channels).where(eq(channels.id, channel.id));
    await database.delete(agents).where(eq(agents.id, bot.id));
    await database.delete(users).where(eq(users.id, actor.id));
    await database.delete(users).where(eq(users.id, stranger.id));
  }
});

test("a revoked account loses its live Run and a restored account must start a new Run", async () => {
  const alice = await person();
  const bob = await person();
  const release = Promise.withResolvers<void>();
  const bots = await Promise.all(
    [alice, bob].map((actor) =>
      profiles.create(actor, {
        name: "Account cut-off Bot",
        title: "Bot",
        roleDescription: "Answers locally.",
        visibility: "private",
      }),
    ),
  );
  const [aliceBot, bobBot] = bots;
  if (!aliceBot || !bobBot) throw new Error("Missing test Bots.");
  let authorized = true;
  let dispatches = 0;
  const aliceApp = web(
    database,
    alice,
    aliceBot.id,
    async () => {
      dispatches++;
      await release.promise;
    },
    { authorized: () => authorized, partial: "Before revocation." },
  );
  const bobApp = web(database, bob, bobBot.id, async () => {});
  const [aliceChannel, bobChannel] = await Promise.all(
    [
      [aliceApp, aliceBot.id],
      [bobApp, bobBot.id],
    ].map(async ([app, botId]) => {
      if (typeof app === "string") throw new Error("Missing test app.");
      return (
        await (
          await app.request("/api/channels", post({ agentIds: [botId] }))
        ).json()
      ).channel;
    }),
  );
  const path = `/api/copilotkit/agent/${aliceBot.id}`;
  const message = { role: "user", id: "original", content: "Hello." };
  const payload = {
    threadId: aliceChannel.threadId,
    runId: "original",
    messages: [message],
  };
  try {
    const reader = (
      await aliceApp.request(`${path}/run`, post(payload))
    ).body?.getReader();
    if (!reader) throw new Error("Missing Run stream.");
    let partial = "";
    while (!partial.includes("Before revocation.")) {
      const read = await reader.read();
      if (read.done) throw new Error("Missing partial output.");
      partial += new TextDecoder().decode(read.value);
    }
    authorized = false;
    const revokedAt = Date.now();
    let tail = "";
    for (
      let read = await reader.read();
      !read.done;
      read = await reader.read()
    ) {
      tail += new TextDecoder().decode(read.value);
    }
    expect(tail).toContain("The Bot run is unavailable.");
    expect(Date.now() - revokedAt).toBeLessThan(60_000);
    expect((await aliceApp.request(`${path}/run`, post(payload))).status).toBe(
      404,
    );
    expect(
      await (
        await bobApp.request(
          `/api/copilotkit/agent/${bobBot.id}/run`,
          post({
            ...payload,
            threadId: bobChannel.threadId,
          }),
        )
      ).text(),
    ).toContain("Offline answer.");
    authorized = true;
    release.resolve();
    const original = await aliceApp.request(`${path}/run`, post(payload));
    expect(await original.text()).toContain("access_revoked");
    expect(dispatches).toBe(1);
    const retry = await aliceApp.request(
      `${path}/run`,
      post({
        ...payload,
        runId: "explicit-retry",
        messages: [{ ...message, id: "explicit-retry" }],
      }),
    );
    expect(await retry.text()).toContain("Offline answer.");
    expect(dispatches).toBe(2);
  } finally {
    release.resolve();
    for (const channel of [aliceChannel, bobChannel])
      await database.delete(channels).where(eq(channels.id, channel.id));
    for (const bot of bots)
      await database.delete(agents).where(eq(agents.id, bot.id));
    for (const actor of [alice, bob])
      await database.delete(users).where(eq(users.id, actor.id));
  }
});

test.each([
  { feature: "scheduled analysis", scheduled: true },
  { feature: "review and publication", scheduled: false },
])(
  "Learn now preserves $feature alongside reservation coalescing and evidence snapshots",
  ({ scheduled }) => exerciseLearning(scheduled),
  20_000,
);

async function exerciseLearning(scheduled: boolean) {
  const alice = await person();
  const bob = await person();
  const bot = await profiles.create(alice, {
    name: "Learning Bot",
    title: "Bot",
    roleDescription: "Answers locally.",
    visibility: "public",
  });
  const reservations: unknown[] = [];
  const managedPrompts: string[] = [];
  let insufficient = false;
  let dispatched = Promise.withResolvers<void>();
  let release = Promise.withResolvers<void>();
  let reconciled = Promise.withResolvers<void>();
  const store = createLearningSettingsStore(database);
  const hadSavedSettings = await store.saved();
  const previousSettings = await store.read();
  function settingsApp(actor: AuthenticatedActor) {
    return createLearningRoutes({ store }, async (context, next) => {
      context.set("actor", actor);
      await next();
    });
  }
  const admin = settingsApp({ ...alice, role: "admin" });
  const settings = (enabled: boolean) => ({
    ...post({ ...previousSettings, enabled }),
    method: "PUT",
  });

  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      switch (new URL(request.url).pathname) {
        case "/v1/reserve": {
          const reservation = await request.json();
          reservations.push(reservation);
          if (reservation.scope.runId === "pause-during-admission") {
            const paused = await admin.request("/settings", settings(false));
            expect(paused.status).toBe(200);
          }
          return insufficient
            ? Response.json({ state: "denied", reason: "insufficient_credits" })
            : Response.json({ state: "reserved", permit: "learn-permit" });
        }
        case "/v1/dispatch": {
          const body = await request.text();
          if (body.includes("Managed delivery check")) {
            managedPrompts.push(body);
            return Response.json({
              state: "completed",
              text: "Managed answer.",
            });
          }
          dispatched.resolve();
          await release.promise;
          return Response.json({
            state: "completed",
            text: JSON.stringify({
              title: "Prepare a checklist",
              instructions: "List the steps in order.",
            }),
          });
        }
        case "/v1/reconcile":
          reconciled.resolve();
          return Response.json({ state: "settled" });
        default:
          return new Response(null, { status: 404 });
      }
    },
  });
  const deployment = {
    ...config,
    managedModelTrial: {
      url: control.url,
      token: "test-token",
      route: "pilot-text-v1",
    },
  };
  let now = new Date();
  const learningClock = () => now;
  const runInputs: RunAgentInput[] = [];
  const capture = async (input: RunAgentInput) => {
    runInputs.push(input);
  };
  const aliceChat = web(database, alice, bot.id, capture, {
    reflect: async () => "Synthetic reflection.",
  });
  const bobChat = web(database, bob, bot.id, capture);
  const aliceLearning = web(database, alice, bot.id, async () => {}, {
    deployment,
  });
  const bobLearning = web(database, bob, bot.id, async () => {}, {
    deployment,
  });
  let channelId: string | undefined;
  let bobChannelId: string | undefined;
  let sharedChannelId: string | undefined;
  let sourceChannelId: string | undefined;
  let secondBotId: string | undefined;
  try {
    const opened = await aliceChat.request(
      "/api/channels",
      post({ agentIds: [bot.id] }),
    );
    expect(opened.status).toBe(201);
    const { channel } = await opened.json();
    channelId = channel.id;
    async function send(
      runId: string,
      prompt: string,
      reply = "Offline answer.",
      threadId = channel.threadId,
    ) {
      const turn = await aliceChat.request(
        `/api/copilotkit/agent/${bot.id}/run`,
        post({
          threadId,
          runId,
          messages: [
            { id: `question-${runId}`, role: "user", content: prompt },
          ],
        }),
      );
      expect(await turn.text()).toContain(reply);
    }
    const openedForBob = await bobChat.request(
      "/api/channels",
      post({ agentIds: [bot.id] }),
    );
    expect(openedForBob.status).toBe(201);
    const { channel: bobChannel } = await openedForBob.json();
    bobChannelId = bobChannel.id;
    const path = `/api/copilotkit/threads/${channel.threadId}/learn?agentId=${bot.id}`;
    expect(await (await aliceLearning.request(path)).json()).toMatchObject({
      schedule: {
        enabled: false,
        intervalHours: 24,
        nextAt: null,
        lastResult: null,
      },
    });
    await send(
      "manual-reflect",
      "/reflect Which lanterns?",
      "Synthetic reflection.",
    );
    const empty = await aliceLearning.request(path, post({}));
    expect(await empty.json()).toMatchObject({
      latest: { state: "skipped", reason: "no_evidence", evidenceCount: 0 },
    });
    expect(reservations).toHaveLength(0);
    await send("learn-source", "How should I prepare?");
    const concurrentClient = web(database, alice, bot.id, async () => {}, {
      deployment,
    });
    expect((await bobLearning.request(path)).status).toBe(404);
    expect((await bobLearning.request(path, post({}))).status).toBe(404);
    expect(
      (await settingsApp(bob).request("/settings", settings(false))).status,
    ).toBe(403);

    const read = async () => (await concurrentClient.request(path)).json();
    async function waitFor(state: string) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = await read();
        if (status.latest?.state === state) return status;
        await Bun.sleep(20);
      }
      throw new Error(`Learning did not reach ${state}.`);
    }
    const starts = await Promise.all([
      aliceLearning.request(path, post({})),
      concurrentClient.request(path, post({})),
    ]);
    expect(starts.map(({ status }) => status)).toEqual([202, 202]);
    const [first, joined] = await Promise.all(
      starts.map((response) => response.json()),
    );
    expect(joined.latest).toEqual(first.latest);
    expect(first.latest).toMatchObject({ state: "running", evidenceCount: 1 });
    await dispatched.promise;
    await send("later-evidence", "What should happen next?");
    expect((await read()).latest).toEqual(first.latest);
    release.resolve();
    await waitFor("proposed");
    expect(await (await aliceLearning.request(path)).json()).toMatchObject({
      latest: { state: "proposed" },
      proposals: [
        {
          state: "pending_review",
          title: "Prepare a checklist",
          evidence: [
            {
              runId: "learn-source",
              prompt: "How should I prepare?",
              reply: "Offline answer.",
            },
          ],
        },
      ],
    });
    expect(reservations).toEqual([
      expect.objectContaining({
        creditType: "test",
        scope: expect.objectContaining({
          personId: alice.id,
          conversationId: channel.id,
          source: "learning",
        }),
      }),
    ]);
    const proposal = (await waitFor("proposed")).proposals[0];
    const reviewPath = path.replace(
      "/learn?",
      `/learn/proposals/${proposal.id}?`,
    );
    const scope = {
      personId: alice.id,
      threadId: channel.threadId,
      botId: bot.id,
    };
    const approve = post({ decision: "approve", scope });
    expect((await bobLearning.request(reviewPath, approve)).status).toBe(404);
    expect(
      (
        await aliceLearning.request(
          reviewPath,
          post({
            decision: "approve",
            scope: { ...scope, personId: bob.id },
          }),
        )
      ).status,
    ).toBe(409);
    expect((await admin.request("/settings", settings(false))).status).toBe(
      200,
    );
    expect((await aliceLearning.request(reviewPath, approve)).status).toBe(409);
    expect((await admin.request("/settings", settings(true))).status).toBe(200);
    expect((await aliceLearning.request(reviewPath, approve)).status).toBe(200);
    expect((await aliceLearning.request(reviewPath, approve)).status).toBe(200);
    expect(await (await aliceLearning.request(path)).json()).toMatchObject({
      autoApprove: false,
      proposals: [
        {
          id: proposal.id,
          state: "published",
          review: {
            mode: "manual",
            reviewerId: alice.id,
            scope,
          },
        },
      ],
    });

    insufficient = true;
    expect((await aliceLearning.request(path, post({}))).status).toBe(202);
    const skipped = await waitFor("skipped");
    expect(skipped.latest).toMatchObject({
      state: "skipped",
      reason: "insufficient_credits",
      evidenceCount: 1,
    });
    expect(skipped.proposals).toHaveLength(1);

    insufficient = false;
    dispatched = Promise.withResolvers<void>();
    release = Promise.withResolvers<void>();
    reconciled = Promise.withResolvers<void>();
    const oldAnalysis = await (
      await aliceLearning.request(path, post({}))
    ).json();
    expect(oldAnalysis.lastResult).toEqual(skipped.latest);
    await dispatched.promise;
    expect((await admin.request("/settings", settings(false))).status).toBe(
      200,
    );
    expect((await aliceLearning.request(path, post({}))).status).toBe(409);
    expect((await admin.request("/settings", settings(true))).status).toBe(200);
    release.resolve();
    await reconciled.promise;
    const afterPause = await waitFor("cancelled");
    expect(afterPause.latest).toMatchObject({
      id: oldAnalysis.latest.id,
      reason: "learning_disabled",
    });
    expect(afterPause.proposals).toHaveLength(1);
    const restarted = await (
      await aliceLearning.request(path, post({}))
    ).json();
    expect(restarted.latest.id).not.toBe(oldAnalysis.latest.id);
    expect(restarted.lastResult).toEqual(afterPause.latest);
    const completed = await waitFor("proposed");
    expect(completed.proposals).toHaveLength(2);
    expect(completed.proposals[0]).toMatchObject({
      id: restarted.latest.id,
      evidence: [{ runId: "later-evidence" }],
    });
    const repeated = await (await aliceLearning.request(path, post({}))).json();
    expect(repeated.latest).toEqual(completed.latest);
    expect(reservations).toHaveLength(4);

    if (scheduled) {
      const scheduledClient = web(database, alice, bot.id, async () => {}, {
        deployment,
        learningClock,
      });
      const scheduledReplica = web(database, alice, bot.id, async () => {}, {
        deployment,
        learningClock,
      });
      const configureSchedule = (enabled: boolean, intervalHours = 1) => ({
        ...post({ enabled, intervalHours }),
        method: "PUT",
      });
      const runWorker = () =>
        Promise.all([
          scheduledClient.sweepLearning?.(),
          scheduledReplica.sweepLearning?.(),
        ]);
      async function waitForScheduled(state: string) {
        for (let attempt = 0; attempt < 100; attempt++) {
          const status = await (await scheduledClient.request(path)).json();
          if (status.schedule.lastResult?.state === state) return status;
          await Bun.sleep(20);
        }
        throw new Error(`Scheduled Learning did not reach ${state}.`);
      }

      await send(
        "scheduled-reflect",
        "/reflect\u00a0Which lanterns?",
        "Synthetic reflection.",
      );
      await send("scheduled-source", "What should we automate?");
      await runWorker();
      expect(reservations).toHaveLength(4);
      expect(
        (await bobLearning.request(path, configureSchedule(true))).status,
      ).toBe(404);
      expect(
        (await scheduledClient.request(path, configureSchedule(true, 0)))
          .status,
      ).toBe(400);
      now = new Date();
      const configured = await scheduledClient.request(
        path,
        configureSchedule(true),
      );
      expect(configured.status).toBe(200);
      const next = new Date(now.getTime() + 3_600_000);
      expect(await configured.json()).toMatchObject({
        schedule: {
          enabled: true,
          intervalHours: 1,
          nextAt: next.toISOString(),
          lastResult: null,
        },
      });
      await runWorker();
      expect(reservations).toHaveLength(4);

      now = next;
      await database.delete(userRoles).where(eq(userRoles.userId, alice.id));
      await runWorker();
      expect(reservations).toHaveLength(4);
      await database
        .insert(userRoles)
        .values({ userId: alice.id, role: "user" });
      dispatched = Promise.withResolvers<void>();
      release = Promise.withResolvers<void>();
      await runWorker();
      await dispatched.promise;
      const joinedSchedule = await (
        await scheduledClient.request(path, post({}))
      ).json();
      expect(joinedSchedule.latest).toEqual(joinedSchedule.schedule.lastResult);
      expect(reservations).toHaveLength(5);
      release.resolve();
      const scheduledProposal = await waitForScheduled("proposed");
      expect(scheduledProposal.proposals[0]).toMatchObject({
        state: "pending_review",
        evidence: [{ runId: "scheduled-source" }],
      });

      await send("scheduled-insufficient", "How do we handle low balance?");
      insufficient = true;
      now = new Date(scheduledProposal.schedule.nextAt);
      await runWorker();
      const lowBalance = await waitForScheduled("skipped");
      expect(lowBalance.schedule.lastResult.reason).toBe(
        "insufficient_credits",
      );
      expect(reservations).toHaveLength(6);

      const preference = path.replace("/learn?", "/learn/auto-approval?");
      expect(
        (await scheduledClient.request(preference, post({ autoApprove: true })))
          .status,
      ).toBe(200);
      expect(await (await scheduledClient.request(path)).json()).toMatchObject({
        autoApprove: true,
        schedule: {
          enabled: true,
          intervalHours: 1,
          nextAt: lowBalance.schedule.nextAt,
        },
      });

      insufficient = false;
      dispatched = Promise.withResolvers<void>();
      release = Promise.withResolvers<void>();
      reconciled = Promise.withResolvers<void>();
      now = new Date(lowBalance.schedule.nextAt);
      await runWorker();
      await dispatched.promise;
      expect(
        (await scheduledClient.request(path, configureSchedule(false))).status,
      ).toBe(200);
      expect(
        (await scheduledClient.request(path, configureSchedule(true))).status,
      ).toBe(200);
      release.resolve();
      await reconciled.promise;
      const cancelled = await waitForScheduled("cancelled");
      expect(cancelled.schedule.lastResult.reason).toBe("schedule_disabled");
      expect(
        cancelled.proposals.map(({ id }: { id: string }) => id),
      ).not.toContain(cancelled.schedule.lastResult.id);

      now = new Date(now.getTime() + 3_600_000);
      await runWorker();
      const resumed = await waitForScheduled("skipped");
      expect(resumed.schedule.lastResult.reason).toBe("no_evidence");
      expect(reservations).toHaveLength(7);

      await send("fresh-after-resume", "What should we do after resuming?");
      now = new Date(resumed.schedule.nextAt);
      await runWorker();
      const fresh = await waitForScheduled("proposed");
      expect(fresh.proposals[0]).toMatchObject({
        state: "published",
        review: { mode: "automatic", reviewerId: alice.id, scope },
        evidence: [{ runId: "fresh-after-resume" }],
      });
      expect(reservations).toHaveLength(8);
    } else {
      const laterReview = path.replace(
        "/learn?",
        `/learn/proposals/${completed.latest.id}?`,
      );
      expect(
        (
          await aliceLearning.request(
            laterReview,
            post({ decision: "reject", scope }),
          )
        ).status,
      ).toBe(200);
      expect((await aliceLearning.request(laterReview, approve)).status).toBe(
        409,
      );
      expect(await read()).toMatchObject({
        proposals: [{ state: "rejected" }, { state: "published" }],
      });

      await send("published-skill", "What is your procedure?");
      expect(runInputs.at(-1)?.messages[0]).toMatchObject({ role: "system" });
      const guidance = String(runInputs.at(-1)?.messages[0]?.content);
      expect(guidance).toContain(proposal.id);
      expect(guidance).toContain("List the steps in order.");
      expect(guidance).not.toContain(completed.latest.id);
      expect(runInputs.at(-1)?.tools).toEqual([]);

      const bobPath = `/api/copilotkit/threads/${bobChannel.threadId}/learn?agentId=${bot.id}`;
      expect(await (await bobChat.request(bobPath)).json()).toMatchObject({
        autoApprove: false,
        proposals: [],
      });
      expect(
        (
          await bobChat.request(
            bobPath.replace("/learn?", `/learn/proposals/${proposal.id}?`),
            post({
              decision: "approve",
              scope: {
                ...scope,
                personId: bob.id,
                threadId: bobChannel.threadId,
              },
            }),
          )
        ).status,
      ).toBe(404);
      const bobTurn = await bobChat.request(
        `/api/copilotkit/agent/${bot.id}/run`,
        post({
          threadId: bobChannel.threadId,
          runId: "other-workspace",
          messages: [
            {
              id: "bob-question",
              role: "user",
              content: "What is your procedure?",
            },
          ],
        }),
      );
      expect(await bobTurn.text()).toContain("Offline answer.");
      expect(runInputs.at(-1)?.messages.map(({ role }) => role)).toEqual([
        "user",
      ]);

      const preference = path.replace("/learn?", "/learn/auto-approval?");
      expect(
        (await bobLearning.request(preference, post({ autoApprove: true })))
          .status,
      ).toBe(404);
      expect(
        (await aliceLearning.request(preference, post({ autoApprove: true })))
          .status,
      ).toBe(200);
      expect(await (await bobChat.request(bobPath)).json()).toMatchObject({
        autoApprove: false,
      });
      expect((await aliceLearning.request(path, post({}))).status).toBe(202);
      const auto = await waitFor("proposed");
      expect(auto.proposals[0]).toMatchObject({
        state: "published",
        review: { reviewerId: alice.id, mode: "automatic", scope },
      });
      const audit = await database
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.actorUserId, alice.id));
      expect(
        audit.filter((event) => event.targetId === proposal.id),
      ).toHaveLength(1);
      expect(audit).toContainEqual(
        expect.objectContaining({
          eventType: "learning.personal_auto_approval_changed",
          payload: { enabled: true },
        }),
      );
      expect(audit).toContainEqual(
        expect.objectContaining({
          eventType: "learning.proposal_reviewed",
          targetId: auto.latest.id,
          payload: expect.objectContaining({
            decision: "approve",
            mode: "automatic",
            scope,
          }),
        }),
      );

      async function managedDelivery(
        runId: string,
        expected = "Managed answer.",
      ) {
        const turn = await aliceLearning.request(
          `/api/copilotkit/agent/${bot.id}/run`,
          post({
            threadId: channel.threadId,
            runId,
            messages: [
              {
                id: `question-${runId}`,
                role: "user",
                content: "Managed delivery check",
              },
            ],
          }),
        );
        expect(await turn.text()).toContain(expected);
        return managedPrompts.at(-1);
      }
      expect(await managedDelivery("managed-published")).toContain(
        auto.latest.id,
      );

      await managedDelivery("pause-during-admission", "not_authorized");
      expect(managedPrompts).toHaveLength(1);
      await send("paused-skill", "Can you still answer?");
      expect(
        runInputs.at(-1)?.messages.some(({ role }) => role === "system"),
      ).toBe(false);
      expect(await managedDelivery("managed-paused")).not.toContain(
        proposal.id,
      );
      expect(managedPrompts.at(-1)).not.toContain(auto.latest.id);
      expect(await read()).toMatchObject({
        enabled: false,
        proposals: [
          { state: "published", review: { mode: "automatic" } },
          { state: "rejected" },
          { state: "published" },
        ],
      });

      expect((await admin.request("/settings", settings(true))).status).toBe(
        200,
      );
      await database
        .delete(directChatRuns)
        .where(
          and(
            eq(directChatRuns.threadId, channel.threadId),
            eq(directChatRuns.id, "learn-source"),
          ),
        );
      expect((await aliceLearning.request(reviewPath, approve)).status).toBe(
        409,
      );
      await send("evidence-withdrawn", "What procedure is still available?");
      expect(runInputs.at(-1)?.messages[0]?.content).toContain(auto.latest.id);
      expect(runInputs.at(-1)?.messages[0]?.content).not.toContain(proposal.id);
    }

    if (!scheduled) {
      const second = await profiles.create(alice, {
        name: "Second Bot",
        title: "Bot",
        roleDescription: "Answers locally.",
        visibility: "public",
      });
      secondBotId = second.id;
      const shared = await aliceChat.request(
        "/api/channels",
        post({ agentIds: [bot.id, second.id] }),
      );
      expect(shared.status).toBe(201);
      const groupId = (await shared.json()).channel.id;
      sharedChannelId = groupId;
      const groups = createGroupStore(database, () => crypto.randomUUID());
      await groups.seedOrder(alice.id, groupId, [bot.id, second.id]);
      await groups.addMember(alice.id, groupId, bob.email);
      await groups.append({
        id: crypto.randomUUID(),
        ownerUserId: alice.id,
        channelId: groupId,
        agentId: bot.id,
        threadId: "shared-fixture",
        text: "Check the shipping label.",
        details: {},
      });

      const recordingId = crypto.randomUUID();
      const trajectory = crypto.randomUUID();
      const connection = crypto.randomUUID();
      await database.insert(recorderConnections).values({
        id: connection,
        userId: alice.id,
        tokenHash: connection,
        label: "Test Recorder",
        via: "web",
        extensionId: "fixture",
        installId: "fixture",
      });
      const local = createOpenBotRecordings(database, "test-recorder-secret");
      const recorderApp = new Hono().route(
        "/api/recorder",
        createRecorderRoutes({
          connections: createRecorderConnectionStore(database),
          localRecordings: local,
          requireUser: async (context, next) => {
            context.set("actor", alice);
            await next();
          },
          requireRecorder: async (context, next) => {
            context.set("actor", alice);
            context.set("recorderConnectionId", connection);
            await next();
          },
          allowedExtensionIds: () => [],
          learningSpace: async () => ({
            state: "unassigned",
            containerId: null,
          }),
          user: async () => null,
          sealOrganizationSession: async () => null,
        }),
      );
      const capture = `/api/recorder/capture/${trajectory}`;
      const grant = await recorderApp.request(
        `${capture}/grant`,
        post({ recordingId }),
      );
      expect(grant.status).toBe(200);
      const { token } = await grant.json();
      const recorded = await recorderApp.request(
        `${capture}/events`,
        post({
          captureToken: token,
          dropped: 0,
          events: [
            {
              type: "CUSTOM",
              name: "click",
              timestamp: Date.now(),
              value: { seq: 1, label: "Open packing list" },
            },
            {
              type: "CUSTOM",
              name: "outcome",
              timestamp: Date.now(),
              value: {
                seq: 2,
                phase: "succeeded",
                workflow: "Pack a shipment",
              },
            },
          ],
        }),
      );
      expect(recorded.status).toBe(200);
      expect(await recorded.json()).toMatchObject({ accepted: 2 });
      const details = await recorderApp.request(
        `/api/recorder/recordings/${recordingId}`,
      );
      expect(details.status).toBe(200);
      expect(await details.json()).toMatchObject({
        ended: "succeeded",
        events: [{ name: "click" }, { name: "outcome" }],
      });
      const recording = { kind: "recording", id: recordingId };
      const conversation = { kind: "conversation", id: groupId };
      const openedSource = await aliceChat.request(
        "/api/channels",
        post({ agentIds: [bot.id] }),
      );
      expect(openedSource.status).toBe(201);
      const { channel: sourceChannel } = await openedSource.json();
      sourceChannelId = sourceChannel.id;
      await send(
        "source-direct",
        "Check the address before packing.",
        "Offline answer.",
        sourceChannel.threadId,
      );
      const directSource = { kind: "conversation", id: sourceChannel.id };
      const both = post({ evidence: [recording, conversation, directSource] });
      expect((await aliceLearning.request(path, both)).status).toBe(409);
      const bobPath = `/api/copilotkit/threads/${bobChannel.threadId}/learn?agentId=${bot.id}`;
      expect(
        (await bobLearning.request(bobPath, post({ evidence: [recording] })))
          .status,
      ).toBe(409);
      const grantLearning = {
        ...post({ allowed: true }),
        method: "PUT",
      };
      const permission = `/api/copilotkit/conversations/${groupId}/learning-evidence`;
      expect(
        (await aliceLearning.request(permission, grantLearning)).status,
      ).toBe(200);
      expect((await aliceLearning.request(path, both)).status).toBe(409);
      expect(
        (await bobLearning.request(permission, grantLearning)).status,
      ).toBe(200);

      const recordingOnly = await aliceLearning.request(
        path,
        post({ evidence: [recording] }),
      );
      expect(recordingOnly.status).toBe(202);
      const recordingProposal = (await waitFor("proposed")).proposals[0];
      expect(recordingProposal).toMatchObject({
        state: "pending_review",
        evidence: [{ source: recording, excerpt: "click: Open packing list" }],
      });
      const reviewFor = (id: string) =>
        path.replace("/learn?", `/learn/proposals/${id}?`);
      expect(
        (
          await aliceLearning.request(
            reviewFor(recordingProposal.id),
            post({ decision: "reject", scope }),
          )
        ).status,
      ).toBe(200);

      const started = await aliceLearning.request(path, both);
      expect(await started.json()).toMatchObject({
        latest: { state: "running" },
      });
      expect(started.status).toBe(202);
      const mixed = (await waitFor("proposed")).proposals[0];
      expect(mixed).toMatchObject({
        state: "pending_review",
        evidence: [
          {
            source: recording,
            excerpt: "click: Open packing list",
            title: "Pack a shipment",
          },
          { source: conversation, excerpt: "Bot: Check the shipping label." },
          {
            source: directSource,
            excerpt:
              "Person: Check the address before packing.\nBot: Offline answer.",
          },
        ],
      });
      expect(
        (await aliceLearning.request(reviewFor(mixed.id), approve)).status,
      ).toBe(200);
      expect((await aliceLearning.request(path, both)).status).toBe(202);
      const pending = (await waitFor("proposed")).proposals[0];
      expect(pending.id).not.toBe(mixed.id);
      const remove = await recorderApp.request(
        `/api/recorder/recordings/${recordingId}`,
        { method: "DELETE" },
      );
      expect(remove.ok).toBe(true);
      expect(
        (await recorderApp.request(`/api/recorder/recordings/${recordingId}`))
          .status,
      ).toBe(404);
      const withdrawn = await read();
      expect(withdrawn.proposals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: mixed.id,
            state: "paused",
            evidence: [
              expect.objectContaining({ source: conversation }),
              expect.objectContaining({ source: directSource }),
            ],
          }),
          expect.objectContaining({
            id: pending.id,
            state: "revision_required",
          }),
          expect.objectContaining({
            id: recordingProposal.id,
            state: "rejected",
            evidence: [],
          }),
        ]),
      );
      expect(JSON.stringify(withdrawn)).not.toContain("Open packing list");
      expect(JSON.stringify(withdrawn)).not.toContain("Pack a shipment");
      expect(
        (await aliceLearning.request(reviewFor(pending.id), approve)).status,
      ).toBe(409);
      await send("withdrawn-recording", "What procedure can you use?");
      expect(JSON.stringify(runInputs.at(-1)?.messages)).not.toContain(
        mixed.id,
      );

      const memory = createMemoryStore(database);
      const kept = await memory.create(alice.id, {
        content: "Independently retained packing preference.",
      });
      const deleteSource = await aliceChat.request(
        `/api/channels/${sourceChannel.id}`,
        { method: "DELETE" },
      );
      expect(deleteSource.ok).toBe(true);
      expect(await memory.list(alice.id)).toContainEqual(
        expect.objectContaining({ id: kept.id }),
      );
      expect(JSON.stringify(await read())).not.toContain(
        "Check the address before packing.",
      );
      const resubmit = post({ revisesProposalId: mixed.id });
      expect((await bobLearning.request(bobPath, resubmit)).status).toBe(409);
      expect((await aliceLearning.request(path, resubmit)).status).toBe(202);
      const revised = (await waitFor("proposed")).proposals[0];
      expect(revised).toMatchObject({
        state: "pending_review",
        evidence: [{ source: conversation }],
      });
      await send("awaiting-new-review", "Which procedure is available?");
      expect(JSON.stringify(runInputs.at(-1)?.messages)).not.toContain(
        revised.id,
      );
      expect(
        (await aliceLearning.request(reviewFor(revised.id), approve)).status,
      ).toBe(200);
      await send("revised-skill", "Which procedure is approved?");
      expect(JSON.stringify(runInputs.at(-1)?.messages)).toContain(revised.id);
      expect(
        (
          await bobLearning.request(permission, {
            ...post({ allowed: false }),
            method: "PUT",
          })
        ).status,
      ).toBe(200);
      expect(
        (await aliceLearning.request(reviewFor(revised.id), approve)).status,
      ).toBe(409);
      expect(JSON.stringify(await read())).not.toContain(
        "Check the shipping label.",
      );
      await send(
        "revoked-shared-evidence",
        "Which procedure is still approved?",
      );
      expect(JSON.stringify(runInputs.at(-1)?.messages)).not.toContain(
        revised.id,
      );

      const evidenceAudit = await database
        .select({ eventType: auditEvents.eventType })
        .from(auditEvents)
        .where(eq(auditEvents.targetId, mixed.id));
      expect(evidenceAudit.map(({ eventType }) => eventType)).toEqual(
        expect.arrayContaining([
          "learning.evidence_withdrawn",
          "learning.skill_paused",
        ]),
      );
    }

    expect(
      (
        await aliceChat.request(`/api/channels/${channel.id}`, {
          method: "DELETE",
        })
      ).ok,
    ).toBe(true);
    expect((await aliceLearning.request(path)).status).toBe(404);
    expect((await aliceLearning.request(reviewPath, approve)).status).toBe(404);
    if (!scheduled) {
      const withdrawal = await database
        .select({ eventType: auditEvents.eventType })
        .from(auditEvents)
        .where(eq(auditEvents.targetId, proposal.id));
      expect(withdrawal.map(({ eventType }) => eventType)).toContain(
        "learning.skill_paused",
      );
    }
  } finally {
    release.resolve();
    if (hadSavedSettings) await store.write(previousSettings);
    else
      await database
        .delete(learningSettings)
        .where(eq(learningSettings.id, "current"));
    await control.stop(true);
    if (channelId)
      await database.delete(channels).where(eq(channels.id, channelId));
    if (bobChannelId)
      await database.delete(channels).where(eq(channels.id, bobChannelId));
    if (sharedChannelId)
      await database.delete(channels).where(eq(channels.id, sharedChannelId));
    if (sourceChannelId)
      await database.delete(channels).where(eq(channels.id, sourceChannelId));
    if (secondBotId)
      await database.delete(agents).where(eq(agents.id, secondBotId));
    await database.delete(agents).where(eq(agents.id, bot.id));
    await database.delete(users).where(eq(users.id, alice.id));
    await database.delete(users).where(eq(users.id, bob.id));
  }
}

test("Web direct chat dispatches an explicit Reflect with the authenticated Run scope", async () => {
  const owner = await person();
  const bot = await profiles.create(owner, {
    name: "Reflect fixture",
    title: "Bot",
    roleDescription: "Answers locally.",
    visibility: "private",
  });
  const requests: Array<Omit<Parameters<DirectChatReflect>[0], "canContinue">> =
    [];
  const ordinaryTurns: RunAgentInput[] = [];
  const app = web(
    database,
    owner,
    bot.id,
    async (input) => {
      ordinaryTurns.push(input);
    },
    {
      reflect: async ({ canContinue, ...input }) => {
        expect(await canContinue()).toBe(true);
        requests.push(input);
        return "Synthetic reflection.";
      },
    },
  );
  let conversationId: string | undefined;
  try {
    const opened = await app.request(
      "/api/channels",
      post({ agentIds: [bot.id] }),
    );
    expect(opened.status).toBe(201);
    const { channel } = await opened.json();
    conversationId = channel.id;
    const runId = crypto.randomUUID();
    const payload = post({
      threadId: channel.threadId,
      runId,
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          content: "/reflect Which lanterns?",
        },
      ],
    });
    const url = `/api/copilotkit/agent/${bot.id}/run`;
    expect(await (await app.request(url, payload)).text()).toContain(
      "Synthetic reflection.",
    );
    expect(await (await app.request(url, payload)).text()).toContain(
      "Synthetic reflection.",
    );
    expect(requests).toEqual([
      {
        personId: owner.id,
        botId: bot.id,
        runId,
        conversationId: channel.threadId,
        query: "Which lanterns?",
      },
    ]);
    expect(ordinaryTurns).toHaveLength(0);
    const followup = post({
      threadId: channel.threadId,
      runId: crypto.randomUUID(),
      messages: [
        { id: crypto.randomUUID(), role: "user", content: "A normal question" },
      ],
    });
    expect(await (await app.request(url, followup)).text()).toContain(
      "Offline answer.",
    );
    expect(ordinaryTurns).toHaveLength(1);
    expect(JSON.stringify(ordinaryTurns)).not.toContain(
      "Synthetic reflection.",
    );
  } finally {
    if (conversationId)
      await database.delete(channels).where(eq(channels.id, conversationId));
    await database.delete(agents).where(eq(agents.id, bot.id));
    await database.delete(users).where(eq(users.id, owner.id));
  }
});
