import { afterAll, expect, onTestFinished, spyOn, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  HttpAgent,
  type RunAgentInput,
} from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { OUTCOME_UNKNOWN } from "@openbot/shared/approval-outcomes";
import { openBotPersonalReview } from "@openbot/shared/direct-chat-learning";
import { answerMessageId, HANDED_OVER } from "@openbot/shared/handoff-markers";
import {
  HeadlessToolSuspension,
  HeadlessToolsMiddleware,
} from "@openbot/toolkit/headless-tools";
import {
  type RunContextVersion,
  runContextVersions,
} from "@openbot/toolkit/run-context";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { Observable } from "rxjs";
import { z } from "zod";
import {
  askChannelAgent,
  messageText,
} from "../../app/src/lib/voice/agent-bridge";
import { VoiceSession } from "../../app/src/lib/voice/session";
import type { VoiceEvent } from "../../app/src/lib/voice/types";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import { createEnterpriseStore } from "../src/admin/settings-store";
import {
  type ActorAgentResolver,
  createActorAgentResolver,
} from "../src/agents/agent-resolver";
import {
  mintRunAssertion,
  readRunAssertion,
  type RunAssertion,
} from "../src/agents/callback-token";
import { wireCoordination } from "../src/agents/coordination-wiring";
import { createAgentFetch } from "../src/agents/endpoint";
import {
  createHandoffDesk,
  HANDOFF_GRANT,
  HANDOFF_KIND,
} from "../src/agents/handoff";
import { createHandoffRunner } from "../src/agents/handoff-runner";
import { signHandoffDeliveryRun } from "../src/agents/handoff-signing";
import { HANDOFF_TOOL, handoffTool } from "../src/agents/handoff-tool";
import {
  answerGoneFrom,
  createOpenBotHandoffDelivery,
} from "../src/agents/handoff-wiring";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import { createApp } from "../src/app";
import { createApprovalResumeTick } from "../src/approvals/resume-sweep";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { approvalAction, withApprovalContext } from "../src/approvals/types";
import {
  type AuditInitiator,
  createAuditStore,
  PERSON_INITIATOR,
} from "../src/audit";
import { createAuth } from "../src/auth";
import {
  type AppVariables,
  type AuthenticatedActor,
  createRoleRepository,
} from "../src/auth/guards";
import {
  createBifrostLogProxy,
  loadBifrostEvidenceReader,
  recoverBifrostEvidence,
} from "../src/billing/bifrost-evidence";
import {
  createCasdoorBillingIdentity,
  type DirectChatTestCreditDependencies,
} from "../src/billing/direct-chat-test-credit";
import { loadDirectChatTestCredit } from "../src/billing/direct-chat-test-credit-config";
import { createDirectChatCreditRecovery } from "../src/billing/direct-chat-test-credit-recovery";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import { createTestCreditLedger } from "../src/billing/test-credit";
import type { TestCreditExecutor } from "../src/billing/test-credit-routes";
import { loadTestCreditRuntimeAuthentication } from "../src/billing/test-credit-runtime-auth";
import {
  createAttachmentRoutes,
  createChannelAttachmentRoutes,
} from "../src/channels/attachments";
import type { DirectChatReflect } from "../src/channels/direct-chat";
import {
  appendDirectChatEvent,
  backgroundMessageId,
  expireDirectChatEvents,
} from "../src/channels/direct-chat-replay";
import {
  createGroupConversations,
  createGroupRoutes,
  createGroupStore,
  createNativeGroupTurn,
  groupSourceForRun,
} from "../src/channels/group";
import {
  createChannelRoutes,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { loadConfig } from "../src/config";
import { buildAgents, mountCopilotRuntime, type SignRun } from "../src/copilot";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  agents,
  approvalRequests,
  attachments,
  auditEvents,
  channelAgents,
  channelMemberships,
  channels,
  directChatAnalyses,
  directChatProposalReviews,
  directChatRunEvents,
  directChatRuns,
  directChatSkillShares,
  enterpriseSettings,
  intelligenceChannelMappings,
  lagoUsageEvents,
  learningSettings,
  opikRuns,
  pluginGrants,
  recorderConnections,
  revokedAccess,
  routineRuns,
  testCreditAccounts,
  testCreditBatches,
  testCreditEnrollments,
  testCreditEvidence,
  testCreditOperations,
  userRoles,
  users,
  workItems,
} from "../src/db/schema";
import { currentEdition, setEdition } from "../src/edition";
import { createSkillApprovalStore } from "../src/learning/approvals";
import { readLearningSource } from "../src/learning/evidence";
import { createLearningRoutes } from "../src/learning/routes";
import { createLearningSettingsStore } from "../src/learning/settings";
import { createLearningSharingStore } from "../src/learning/sharing";
import { createManagedModel, operationId } from "../src/managed-model";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { createMemoryRoutes } from "../src/memory/routes";
import { createMemoryStore } from "../src/memory/store";
import { createPeopleStore } from "../src/people/store";
import { createPluginStore } from "../src/plugins/store";
import { restrictCoordinationForRun } from "../src/proactive/restriction";
import { createRecorderConnectionStore } from "../src/recorder/connections";
import { createOpenBotRecordings } from "../src/recorder/openbot-recordings";
import { createRecorderRoutes } from "../src/recorder/routes";
import { createRequestActor } from "../src/request-actor";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { createRoutineRoutes } from "../src/routines/routes";
import { createRoutineRunner, createRoutineTurn } from "../src/routines/runner";
import { createRoutineStore } from "../src/routines/store";
import { createWorkQueue } from "../src/work/queue";
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
  await database.insert(userRoles).values({ userId: id, role: "user" });
  return { id, email, role: "user" };
}

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function nativeLearningSettings(
  signedIn: AuthenticatedActor,
  chat: ReturnType<typeof web>,
) {
  const args = new Array(createApp.length) as unknown as Parameters<
    typeof createApp
  >;
  args[0] = { ...config, singleUser: false };
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({
        user: { id: signedIn.id, email: signedIn.email, name: signedIn.id },
      }),
    },
  };
  args[2] = { rolesForUser: async () => [signedIn.role] };
  args[6] = chat.copilotHandler;
  args[34] = {
    personalLearning: {
      store: createLearningSharingStore(database),
      approvals: createSkillApprovalStore(database),
      skillsOf: async () => ({ unavailable: "unavailable" as const }),
      invalidate: () => {},
      sharingAllowed: async () => false,
      settings: createLearningSettingsStore(database),
      scopesFor: async () => [],
      openbotDatabase: database,
      conversationsFor: chat.learningConversations,
    },
  };
  return createApp(...args);
}

test("the original personal Learning switch updates the preference read in OpenBot chat", async () => {
  const actor = await person();
  const bot = await profiles.create(actor, {
    name: "Learning preference Bot",
    visibility: "private",
    title: "Bot",
    roleDescription: "Answers locally.",
  });
  const previousEdition = currentEdition();
  try {
    setEdition("personal");
    const chat = web(database, actor, bot.id, async () => {
      throw new Error("Reading a preference must not call a model.");
    });
    const opened = await chat.request(
      "/api/channels",
      post({ agentIds: [bot.id] }),
    );
    expect(opened.status).toBe(201);
    const { channel } = await opened.json();
    const path = `/api/copilotkit/threads/${channel.threadId}/learn?agentId=${bot.id}`;
    expect(await (await chat.request(path)).json()).toMatchObject({
      autoApprove: false,
    });

    const settings = nativeLearningSettings(actor, chat);
    const reviewPath = "/api/settings/learning/review";
    const initialReview = await settings.request(reviewPath);
    expect(initialReview.status).toBe(200);
    expect(await initialReview.json()).toMatchObject({
      mode: "openbot",
      autoApprove: false,
      conversations: [
        {
          channelId: channel.id,
          threadId: channel.threadId,
          botId: bot.id,
        },
      ],
    });
    const other = await person();
    try {
      const foreignChat = web(database, other, bot.id, async () => {
        throw new Error("Listing conversations must not call a model.");
      });
      const foreign = await nativeLearningSettings(other, foreignChat).request(
        `${reviewPath}?personId=${actor.id}&threadId=${channel.threadId}`,
      );
      expect(foreign.status).toBe(200);
      expect(await foreign.json()).toMatchObject({ conversations: [] });
    } finally {
      await database.delete(users).where(eq(users.id, other.id));
    }
    const refused = await settings.request(
      "/api/settings/learning/auto-approve",
      {
        ...post({ autoApprove: true }),
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
      },
    );
    expect(refused.status).toBe(403);
    expect(await (await chat.request(path)).json()).toMatchObject({
      autoApprove: false,
    });
    const response = await settings.request(
      "/api/settings/learning/auto-approve",
      {
        ...post({ autoApprove: true }),
        method: "PUT",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ autoApprove: true });
    expect(await (await chat.request(path)).json()).toMatchObject({
      autoApprove: true,
    });
    await profiles.setHidden(actor, bot.id, true);
    expect(await (await settings.request(reviewPath)).json()).toMatchObject({
      autoApprove: true,
      conversations: [],
    });
    expect((await settings.request(path)).status).toBe(404);
  } finally {
    setEdition(previousEdition);
    await database.delete(users).where(eq(users.id, actor.id));
  }
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
    makeAgent,
    buildAgent,
    resolver,
    managed,
  }: {
    deployment?: typeof config;
    opik?: typeof config.opik;
    partial?: string;
    learningClock?: () => Date;
    prepare?: () => Promise<void>;
    authorized?: () => boolean | Promise<boolean>;
    reflect?: DirectChatReflect;
    makeAgent?: () => Promise<AbstractAgent>;
    buildAgent?: () => AbstractAgent;
    resolver?: ActorAgentResolver;
    managed?: {
      testCredit: DirectChatTestCreditDependencies;
      auth: ReturnType<typeof createAuth>;
      runtime?: {
        authenticate: NonNullable<
          ReturnType<typeof loadTestCreditRuntimeAuthentication>
        >;
        execute: TestCreditExecutor;
      };
    };
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
    return (
      makeAgent?.() ?? buildAgent?.() ?? new AnsweringAgent(answer, partial)
    );
  };
  const groupStore = createGroupStore(db, () => crypto.randomUUID());
  const groupConversations = createGroupConversations({
    store: groupStore,
    queue: createWorkQueue(db),
    owner: "fixture-group",
    createChannel: (id, agentIds, requestId) =>
      channelStore.create({ id, role: "user" }, agentIds, undefined, requestId),
    roster: async (id, channelId) => {
      const channel = await channelStore.get({ id, role: "user" }, channelId);
      if (!channel || channel.agentIds.length < 2) return null;
      return channel.agentIds.map((id) => ({ id, name: id }));
    },
    native: true,
    runTurn: (input) => {
      if (!copilot.runBackground) throw new Error("Missing OpenBot runtime.");
      return createNativeGroupTurn(
        copilot.runBackground,
        async () => actor,
      )(input);
    },
    caps: { maxDepth: 2, maxPerRun: 3 },
    mayAddress: async () => true,
    auditStore: createAuditStore(db),
  });
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
    { ...deployment, ...(opik ? { opik } : {}) },
    resolver ?? {
      resolveAgentsForActor: async () => ({
        [botId]: await agentFor(actor, botId),
      }),
      resolveAgentForActor: agentFor,
    },
    signedIn?.identifyUser ?? (async () => ({ id: actor.id, name: actor.id })),
    signedIn?.identifyActor ??
      (async () =>
        (await authorized?.()) === false ? { id: "", role: "user" } : actor),
    {
      directChat: {
        database: db,
        profiles: store,
        testCredit: managed?.testCredit,
        reflect,
        learningClock,
        groupThread: groupStore.thread,
        publishGroupReply: groupConversations.announceHandoff,
        backgroundActor: async () => actor,
        mayAddress: async () => true,
      },
    },
  );
  let managedApp: ReturnType<typeof createApp> | undefined;
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
      runtime: managed.runtime,
      paidLedger: createPaidCreditLedger(db),
      casdoorIdentityOf: createCasdoorBillingIdentity(
        db,
        managed.testCredit.casdoor,
      ),
    };
    managedApp = createApp(...args);
  }
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
        if ((await authorized?.()) === false)
          throw new Error("Account disabled.");
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
  return Object.assign(managedApp ?? app, {
    copilotHandler: copilot.handler,
    sweepLearning: copilot.sweepLearning,
    learningConversations: copilot.learningConversations,
    learnedSkillVersionsCurrent: copilot.learnedSkillVersionsCurrent,
    routineRunner,
    runBackground: copilot.runBackground,
    backgroundApproval: copilot.backgroundApproval,
    groupConversations,
    channelStore,
  });
}

test("a shared channel submits one native Run without Intelligence", async () => {
  const actor = await person();
  const makeBot = (name: string) =>
    profiles.create(actor, {
      name,
      title: "Bot",
      roleDescription: "Offline fixture",
      visibility: "private",
    });
  const bot = await makeBot("Shared worker");
  const peer = await makeBot("Shared peer");
  let calls = 0;
  const app = web(database, actor, bot.id, async () => {
    calls++;
  });
  const created = await app.request(
    "/api/groups",
    post({ agentIds: [bot.id, peer.id] }),
  );
  expect(created.status).toBe(201);
  const { channel } = await created.json();
  const path = `/api/groups/${channel.id}`;
  const turn = {
    id: crypto.randomUUID(),
    text: "Share the report.",
    agentId: bot.id,
  };
  expect((await app.request(path, post(turn))).status).toBe(202);
  expect((await app.request(path, post(turn))).status).toBe(202);
  await app.groupConversations.sweep();
  const transcript = await (await app.request(path)).json();
  expect(transcript.messages).toEqual([
    expect.objectContaining({ id: turn.id, text: turn.text }),
    expect.objectContaining({
      agentId: bot.id,
      text: "Offline answer.",
      status: "completed",
    }),
  ]);
  expect(calls).toBe(1);
  expect(transcript.backgroundRuns).toEqual([
    expect.objectContaining({ agentId: bot.id, status: "completed" }),
  ]);
});

test.each([
  "shared",
  "handoff",
  "group",
  "pre-execution race",
  "lost dispatch",
  "saved result",
  "recovered result",
] as const)(
  "approval worker withdrawal persisted state on %s",
  async (kind) => {
    const lostDispatch = kind === "lost dispatch";
    const lateWithdrawal = kind === "pre-execution race";
    const savedResult = kind === "saved result" || kind === "recovered result";
    const resultContent = "Fixture tool called";
    const actor = await person();
    const bot = await profiles.create(actor, {
      name: "Worker boundary fixture",
      title: "Bot",
      roleDescription: "Offline fixture",
      visibility: "private",
    });
    const peer = await profiles.create(actor, {
      name: "Worker peer fixture",
      title: "Bot",
      roleDescription: "Offline fixture",
      visibility: "private",
    });
    const app = web(database, actor, bot.id, async () => {
      throw new Error("Unexpected model call");
    });
    const channelReply = await app.request(
      "/api/channels",
      post({ agentIds: [bot.id, peer.id] }),
    );
    expect(channelReply.status).toBe(201);
    const { channel } = await channelReply.json();
    const group = createGroupStore(database, () => crypto.randomUUID());
    const conversationBotId = kind === "handoff" ? peer.id : bot.id;
    const backgroundSource =
      kind === "group" ? undefined : kind === "handoff" ? "handoff" : "routine";
    const threadId = await group.thread(
      actor.id,
      channel.id,
      conversationBotId,
    );
    let runId: string = crypto.randomUUID();
    if (backgroundSource === "routine") {
      const routineStore = createRoutineStore(database);
      const routine = await routineStore.create({
        ownerUserId: actor.id,
        channelId: channel.id,
        agentId: bot.id,
        instruction: "Fixture Routine",
        cron: "0 9 * * *",
      });
      ({ runId } = await routineStore.startManualRun(actor.id, routine.id));
    }
    const messageId = crypto.randomUUID();
    const text = "Output delivered before approval.";
    const approvalStore = createApprovalStore(database);
    const approvalService = createApprovalService(approvalStore);
    const memoryStore = createMemoryStore(database);
    const memory = await memoryStore.create(actor.id, {
      content: "Fixture context.",
    });
    const pluginStore = createPluginStore({
      brokerProvider: "composio",
      database,
      auditStore: createAuditStore(database),
      credentials: createCredentialStore(database),
      encryptionKey: Buffer.alloc(32, 7).toString("base64"),
      policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    });
    const ingestion = createMemoryIngestion({
      store: memoryStore,
      plugins: pluginStore,
      canUseBot: async () => true,
    });
    const memoryRoutes = createMemoryRoutes(
      memoryStore,
      ingestion,
      async (ctx, next) => {
        ctx.set("actor", actor);
        await next();
      },
    );
    const action = approvalAction({
      actorId: actor.id,
      botId: bot.id,
      toolRef: "fixture:write",
      effect: "write",
      scope: "fixture",
      args: {},
      continuation: {
        runId,
        threadId,
        toolCallId: crypto.randomUUID(),
        toolName: "fixture_write",
        args: {},
        messages: [],
        state: {},
        context: [],
        forwardedProps: {},
        sourceVersions: [
          { kind: "memory", id: memory.id, version: memory.version },
        ],
      },
    });
    const request = await approvalStore.open(action);
    if (kind === "group") {
      const turn = {
        ownerUserId: actor.id,
        channelId: channel.id,
        messageId,
        agentIds: [bot.id],
        text: "Group fixture.",
      };
      expect(await group.start(turn, bot.id, threadId)).toBe("run");
      await group.finish(`${messageId}:${bot.id}`, text, "waiting", {
        approvalId: request.id,
        message: "This action is waiting for your approval.",
      });
    } else {
      await database.insert(directChatRuns).values({
        id: runId,
        threadId,
        groupThreadId: threadId,
        status: "running",
        waitingApprovalId: request.id,
        userMessageId: backgroundSource
          ? backgroundMessageId(backgroundSource, runId)
          : messageId,
        ...(kind === "handoff" ? { handoffFromBotId: peer.id } : {}),
        prompt: "Fixture prompt.",
      });
      await appendDirectChatEvent(
        database,
        { threadId, runId },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: `partial-${runId}`,
          role: "assistant",
        },
      );
      await appendDirectChatEvent(
        database,
        { threadId, runId },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: `partial-${runId}`,
          delta: text,
        },
      );
    }
    await approvalService.decide(actor.id, request.id, "allow_once");
    const withdraw = async () => {
      const reply = await memoryRoutes.request(`/${memory.id}`, {
        method: "DELETE",
      });
      expect(reply.status).toBe(204);
    };
    if (lostDispatch || kind === "recovered result")
      expect(
        await approvalStore.consume(actor.id, request.id, action.actionDigest),
      ).toBe(true);
    if (kind === "recovered result")
      expect(
        await approvalStore.saveResult(actor.id, request.id, {
          content: resultContent,
        }),
      ).toBe(true);
    if (!lateWithdrawal && kind !== "saved result") await withdraw();
    let checks = 0;
    let tools = 0;
    let runs = 0;
    if (backgroundSource) {
      expect(await app.backgroundApproval?.(action, request.id)).toBeDefined();
      expect(
        await (await app.backgroundApproval?.(action, request.id))?.check(),
      ).toBeFalsy();
    }
    const approvalQueue = createWorkQueue(database);
    const worker = () =>
      createApprovalResumeTick({
        backgroundApproval: app.backgroundApproval,
        approvalQueue,
        approvalOwner: crypto.randomUUID(),
        approvalService,
        executeApprovedAction: async (candidate) => {
          await approvalService.gate(candidate);
          tools++;
          if (kind === "saved result") await withdraw();
          return resultContent;
        },
        contextCurrent: async (candidate) => {
          const current = await ingestion.memoryVersionsCurrent(
            candidate.actorId,
            candidate.botId,
            candidate.continuation?.sourceVersions ?? [],
          );
          if (lateWithdrawal && ++checks === 1) await withdraw();
          return current;
        },
        database,
        groupConversations: app.groupConversations,
        responsibilityStore: createResponsibilityStore(database, {
          resolveTarget: async () => null,
        }),
        approvalContinuationRunner: async () => {
          runs++;
          return { replyText: "Unexpected continuation" };
        },
        channelStore: app.channelStore,
        actorFor: async () => actor,
        notify: async () => undefined,
      });
    await worker()();
    if (savedResult)
      await approvalQueue.offer({
        kind: "approval.resume",
        key: `redelivery:${request.id}`,
        payload: { ownerUserId: actor.id, approvalId: request.id },
      });
    await worker()();
    expect({ tools, runs }).toEqual({
      tools: kind === "saved result" ? 1 : 0,
      runs: 0,
    });
    expect(await approvalStore.get(actor.id, request.id)).toMatchObject({
      status: "completed",
      result: savedResult
        ? { content: resultContent }
        : {
            error: lostDispatch
              ? OUTCOME_UNKNOWN
              : "The run paused because Memory or Learned skill access changed.",
          },
    });
    if (kind === "group") {
      const transcript = await (
        await app.request(`/api/groups/${channel.id}`)
      ).json();
      expect(transcript.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "failed",
            text,
            stopReason: "context_revoked",
          }),
        ]),
      );
      expect(
        await group.start(
          {
            ownerUserId: actor.id,
            channelId: channel.id,
            messageId: crypto.randomUUID(),
            agentIds: [bot.id],
            text: "Next fixture turn.",
          },
          bot.id,
          threadId,
        ),
      ).toBe("run");
      return;
    }
    if (savedResult) {
      const events = await database
        .select({ event: directChatRunEvents.event })
        .from(directChatRunEvents)
        .where(
          and(
            eq(directChatRunEvents.threadId, threadId),
            eq(directChatRunEvents.runId, runId),
          ),
        );
      expect(
        events.filter(({ event }) => event.type === EventType.RUN_ERROR),
      ).toHaveLength(1);
    }
    const transcript = await (
      await app.request(
        `/api/copilotkit/threads/${threadId}/messages?agentId=${conversationBotId}`,
      )
    ).json();
    expect(transcript.runs).toEqual([
      expect.objectContaining({
        id: runId,
        status: "failed",
        stopReason: "context_revoked",
      }),
    ]);
    expect(transcript.runs[0].waitingForApproval).toBeUndefined();
    expect(transcript.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", content: text }),
      ]),
    );
    const sharedTranscript = await (
      await app.request(`/api/groups/${channel.id}`)
    ).json();
    expect(sharedTranscript.backgroundRuns).toEqual([
      expect.objectContaining({
        id: runId,
        status: "failed",
        waitingForApproval: false,
        stopReason: "context_revoked",
        partialReply: text,
      }),
    ]);
    const admission = await group.start(
      {
        ownerUserId: actor.id,
        channelId: channel.id,
        messageId: crypto.randomUUID(),
        agentIds: [conversationBotId],
        text: "Next fixture turn.",
      },
      conversationBotId,
      threadId,
    );
    const externalOutcome = lostDispatch
      ? "unknown"
      : savedResult
        ? "executed"
        : null;
    expect({
      shared: sharedTranscript.backgroundRuns[0].externalOutcome,
      thread: transcript.runs[0].externalOutcome,
      admission,
    }).toEqual({
      shared: externalOutcome,
      thread: externalOutcome ?? undefined,
      admission: lostDispatch ? "busy" : "run",
    });
  },
  120_000,
);

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

for (const outcome of [
  "allow",
  "stop",
  "revoke",
  "lose the worker during",
  "save a successful result after stopping",
  "pause a disabled SkillHub version in",
] as const) {
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
    const marketPause =
      "Run paused. Market skill version 1.0.0 is disabled by an OpenBot administrator. Reason: withdrawn";
    let pauseReason: string | null = null;
    const service = createApprovalService(approvals, undefined, undefined, {
      marketPause: async () => pauseReason,
    });
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
              message.role === "tool" &&
              typeof message.content === "string" &&
              message.content.includes("done"),
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
    await database
      .update(routineRuns)
      .set({ startedAt: sql`now() - interval '1 hour'` })
      .where(eq(routineRuns.id, runId));
    expect(
      await createRoutineStore(database).reapAbandonedRuns(
        30 * 60_000,
        "Worker expired",
      ),
    ).toBe(0);
    const [approval] = await approvals.list(actor.id);
    if (!approval) throw new Error("Missing approval.");
    const decision = await app.request(
      `/api/approvals/${approval.id}/decision`,
      post({ decision: "allow_once" }),
    );
    expect(decision.status).toBe(200);
    if (outcome === "pause a disabled SkillHub version in")
      pauseReason = marketPause;
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
    if (outcome === "lose the worker during") {
      expect(
        await approvals.consume(
          actor.id,
          approval.id,
          approval.action.actionDigest,
        ),
      ).toBe(true);
    }
    if (outcome === "save a successful result after stopping") {
      expect(
        await approvals.consume(
          actor.id,
          approval.id,
          approval.action.actionDigest,
        ),
      ).toBe(true);
      expect(
        await (
          await app.request(
            `${thread}/runs/${runId}/stop?agentId=${bot.id}`,
            post({}),
          )
        ).json(),
      ).toEqual({ stopped: true });
      const reconcile = async () =>
        (
          await restarted.request(
            `${thread}/runs/${runId}/reconcile?agentId=${bot.id}`,
            post({}),
          )
        ).json();
      expect(await reconcile()).toEqual({ externalOutcome: "unknown" });
      const blocked = await restarted.request(
        `/api/copilotkit/agent/${bot.id}/run`,
        post({
          threadId: channel.threadId,
          runId: "new-turn",
          messages: [{ id: "new-turn", role: "user", content: "Try again." }],
        }),
      );
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toEqual({
        error: "The previous Run has an unverified external outcome.",
      });
      await approvals.saveResult(actor.id, approval.id, { content: "done" });
      expect(await reconcile()).toEqual({ externalOutcome: "executed" });
      expect(await history()).toMatchObject({
        runs: [
          {
            id: runId,
            status: "failed",
            stopReason: "stopped",
            externalOutcome: "executed",
          },
        ],
      });
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
        pauseWaiting: async () => {
          throw new Error("Wrong continuation path.");
        },
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
    if (outcome === "lose the worker during") {
      expect(await history()).toMatchObject({
        runs: [{ id: runId, externalOutcome: "unknown" }],
      });
    }
    if (pauseReason) {
      const [routineRun] = await database
        .select({ status: routineRuns.status, error: routineRuns.error })
        .from(routineRuns)
        .where(eq(routineRuns.id, runId));
      expect(routineRun).toEqual({ status: "skipped", error: pauseReason });
      expect(await approvals.get(actor.id, approval.id)).toMatchObject({
        status: "completed",
        result: { pauseReason },
      });
    }
    expect(executions).toBe(completed ? 1 : 0);
    expect(resumes).toBe(completed ? 1 : 0);
  }, 60_000);
}

const trialPriceVersion = "a6000000-0000-4000-8000-000000000001";

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
      if (path === "/v1/quote")
        return Response.json({
          route: "pilot-text-v1",
          priceVersion: trialPriceVersion,
        });
      paths.push(path);
      const call = await request.json();
      if (path === "/v1/reserve") {
        expect(call.priceVersion).toBe(trialPriceVersion);
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
      OPENBOT_MANAGED_MODEL_TRIAL_PERSON_CREDENTIALS: JSON.stringify({
        [actor.id]: "test-token",
      }),
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

for (const scenario of [
  "direct",
  "shared",
  "shared with Test Credit",
] as const) {
  test(`a redelivered handoff appears once in its ${scenario} Conversation`, async () => {
    const shared = scenario !== "direct";
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
    let deployment = config;
    if (scenario === "shared with Test Credit") {
      const control = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          switch (new URL(request.url).pathname) {
            case "/v1/quote":
              return Response.json({
                route: "pilot-text-v1",
                priceVersion: trialPriceVersion,
              });
            case "/v1/reserve":
              expect(await request.json()).toMatchObject({
                creditType: "test",
              });
              return Response.json({
                state: "reserved",
                permit: "test-permit",
              });
            case "/v1/dispatch":
              dispatches++;
              return Response.json({
                state: "completed",
                text: "Offline answer.",
              });
            case "/v1/reconcile":
              return Response.json({ state: "settled" });
            default:
              return new Response(null, { status: 404 });
          }
        },
      });
      onTestFinished(() => {
        control.stop(true);
      });
      deployment = loadConfig({
        DATABASE_URL: databaseUrl,
        OPENBOT_ORGANIZATION_AUTH_URL: "https://example.test",
        KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        OPENBOT_MANAGED_MODEL_TRIAL_URL: control.url.href,
        OPENBOT_MANAGED_MODEL_TRIAL_PERSON_CREDENTIALS: JSON.stringify({
          [actor.id]: "test-token",
        }),
        OPENBOT_MANAGED_MODEL_TRIAL_ROUTE: "pilot-text-v1",
      });
    }
    const answer = async () => {
      expect(scenario).not.toBe("shared with Test Credit");
      dispatches++;
    };
    const app = web(database, actor, target.id, answer, { deployment });
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
        database,
        groupConversations: mounted.groupConversations,
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
    const restarted = web(database, actor, target.id, answer, { deployment });
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

/*
 * index.ts builds the next two inline and is the entry module, so neither can be imported. Copied
 * verbatim; re-diff them against those lines when index.ts changes: which conversation a run is in
 * (index.ts:868-895), and how a run is signed for a Bot at its own endpoint (index.ts:2312-2347).
 */
async function channelSourceOfRun(
  run: Pick<RunAssertion, "actorId" | "threadId" | "botId" | "handoff">,
) {
  if (!run.threadId) return null;
  const sources = await database
    .select({ channelId: channels.id, botId: channelAgents.agentId })
    .from(intelligenceChannelMappings)
    .innerJoin(channels, eq(channels.id, intelligenceChannelMappings.channelId))
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channels.id),
        eq(channelMemberships.userId, run.actorId),
      ),
    )
    .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
    .where(
      and(
        eq(intelligenceChannelMappings.threadId, run.threadId),
        eq(intelligenceChannelMappings.userId, run.actorId),
        isNull(channels.deletedAt),
      ),
    );
  return (
    sources.find((source) => source.botId === run.botId) ??
    (run.handoff ? (sources[0] ?? null) : null)
  );
}

const signRunAs =
  (
    actorId: string,
    initiator: AuditInitiator = PERSON_INITIATOR,
    depth?: number,
  ): SignRun =>
  (botId, runId, threadId, previousAssertion) => {
    const previous = readRunAssertion(
      previousAssertion,
      config.keyEncryptionKey,
    );
    if (previous?.handoff) {
      if (previous.botId !== botId || previous.actorId !== actorId)
        throw new Error(
          "The delegated run identity does not match this Bot and owner.",
        );
      return previousAssertion as string;
    }
    return mintRunAssertion(
      {
        botId,
        actorId,
        runId,
        threadId,
        initiator,
        ...(depth ? { depth } : {}),
      },
      config.keyEncryptionKey,
    );
  };

/*
 * Issue #37: a Routine fires with Intelligence switched off, its Bot hands the work to another Bot
 * over the AG-UI tool path, the handoff is delivered, and the same trigger and the same handoff
 * arriving again run nothing twice. Wired the way index.ts wires it — the real resolver, so the
 * asking Bot is a remote AG-UI Bot holding its per-run coordination tools, the real desk, queue and
 * runner — with only the two Bots' behaviour as a fixture: a local AG-UI endpoint that streams one
 * `message_bot` call and, once it has been answered, one sentence.
 */
test("a Routine's Run hands off to another Bot without Intelligence, every entry shows the handoff, and nothing runs twice", async () => {
  const actor = await person();
  const suite = crypto.randomUUID().slice(0, 8);
  const NAMES = {
    asker: `Asker ${suite}`,
    target: `Answerer ${suite}`,
    bystander: `Bystander ${suite}`,
  };
  const INSTRUCTION = "Get the status from the team's records.";
  const TASK = "Find the status.";
  const ASKER_REPLY = "I asked the other Bot to find the status.";
  const ANSWER = "Everything is clear.";
  type BotRequest = {
    threadId: string;
    runId: string;
    messages: { role: string; toolCallId?: string; content?: unknown }[];
    tools: {
      name: string;
      parameters: { properties: { bot: { enum?: string[] } } };
    }[];
    forwardedProps?: { openbotRun?: unknown };
  };
  const seen = { asker: [] as BotRequest[], target: [] as BotRequest[] };
  const sse = (frames: Record<string, unknown>[]) =>
    new Response(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  const harness = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const asking = new URL(request.url).pathname === "/asker/ag-ui";
      const body = (await request.json()) as BotRequest;
      seen[asking ? "asker" : "target"].push(body);
      const run = { threadId: body.threadId, runId: body.runId };
      const reply = `reply-${body.runId}`;
      const answered = body.messages.some((message) => message.role === "tool");
      return sse(
        asking && !answered
          ? [
              { type: EventType.RUN_STARTED, ...run },
              {
                type: EventType.TOOL_CALL_START,
                toolCallId: "ask",
                toolCallName: HANDOFF_TOOL,
              },
              {
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: "ask",
                delta: JSON.stringify({ bot: NAMES.target, task: TASK }),
              },
              { type: EventType.TOOL_CALL_END, toolCallId: "ask" },
              { type: EventType.RUN_FINISHED, ...run },
            ]
          : [
              { type: EventType.RUN_STARTED, ...run },
              {
                type: EventType.TEXT_MESSAGE_START,
                messageId: reply,
                role: "assistant",
              },
              {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: reply,
                delta: asking ? ASKER_REPLY : ANSWER,
              },
              { type: EventType.TEXT_MESSAGE_END, messageId: reply },
              { type: EventType.RUN_FINISHED, ...run },
            ],
      );
    },
  });
  onTestFinished(() => {
    harness.stop(true);
  });
  const asker = await profiles.create(actor, {
    name: NAMES.asker,
    title: "Bot",
    roleDescription: "Coordinates work.",
    visibility: "private",
    endpoint: new URL("/asker/ag-ui", harness.url).href,
  });
  const target = await profiles.create(actor, {
    name: NAMES.target,
    title: "Bot",
    roleDescription: "Answers handoffs.",
    visibility: "private",
    endpoint: new URL("/target/ag-ui", harness.url).href,
  });
  await profiles.create(actor, {
    name: NAMES.bystander,
    title: "Bot",
    roleDescription: "Was never granted.",
    visibility: "private",
  });
  const edition = currentEdition();
  // The team edition: a Bot may ask exactly the Bots it was granted.
  setEdition("team");
  try {
    expect(config.runtime.intelligence).toBeUndefined();
    expect(config.handoff.maxDepth).toBeGreaterThan(0);
    const auditStore = createAuditStore(database);
    const pluginStore = createPluginStore({
      brokerProvider: "composio",
      database,
      auditStore,
      credentials: createCredentialStore(database),
      encryptionKey: config.keyEncryptionKey,
      policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    });
    const actorFor = async (id: string) => {
      if (id !== actor.id) throw new Error("Unexpected person.");
      return actor;
    };
    const mayAddress = async (fromBotId: string, toBotId: string) =>
      (
        await pluginStore.botsReachableFrom(fromBotId).catch((): string[] => [])
      ).includes(toBotId);
    const channelStore = createChannelStore(
      database,
      profiles,
      createThreadIdentity("issue-31"),
    );
    const queue = createWorkQueue(database);
    const { coordinationForActor } = wireCoordination({
      handoffDesk: createHandoffDesk({
        queue,
        profiles,
        mayAddress,
        addressable: (fromBotId) => pluginStore.botsReachableFrom(fromBotId),
        actorFor,
        auditStore,
        caps: config.handoff,
        onOffered: (threadId) => channelStore.signalWork(threadId),
      }),
      config,
      approvalService: createApprovalService(createApprovalStore(database)),
      agentProfileStore: profiles,
      actorFor,
      channelSourceForRun: channelSourceOfRun,
      database,
      pluginStore,
      bootAuditStore: auditStore,
      peopleStore: createPeopleStore(database, []),
      sourceForCoordinationRun: async (run) =>
        (await channelSourceOfRun(run)) ?? groupSourceForRun(database, run),
      channelStore,
      notify: async () => {
        throw new Error("Asking a person is not on this path.");
      },
    });
    const app = web(
      database,
      actor,
      asker.id,
      async () => {
        throw new Error("The fixture Bot must not be built.");
      },
      {
        resolver: createActorAgentResolver({
          loadAgents: createRuntimeAgentLoader(database),
          model: { provider: "openai", defaultModel: "unused" },
          resolveModelApiKey: async () => null,
          agentFetch: createAgentFetch({ allowPrivateHosts: true }),
          signRunForActor: signRunAs,
          handoffForActor: (actorId, initiator, depth) =>
            restrictCoordinationForRun(
              initiator,
              coordinationForActor(actorId, initiator, depth),
            ),
        }),
      },
    );
    if (!app.runBackground) throw new Error("Missing OpenBot runtime.");
    await database.insert(pluginGrants).values({
      kind: HANDOFF_GRANT,
      ref: target.id,
      agentId: asker.id,
      grantedBy: "test",
    });
    const created = await app.request(
      "/api/channels",
      post({ agentIds: [asker.id] }),
    );
    expect(created.status).toBe(201);
    const { channel } = await created.json();
    const routine = await createRoutineStore(database).create({
      ownerUserId: actor.id,
      agentId: asker.id,
      channelId: channel.id,
      instruction: INSTRUCTION,
      cron: "0 9 * * *",
    });
    const runs = async () =>
      (await app.request(`/api/routines/${routine.id}/runs`)).json();
    const transcript = async () =>
      (
        await app.request(
          `/api/copilotkit/threads/${channel.threadId}/messages?agentId=${asker.id}`,
        )
      ).json();
    const roster = async () => (await app.request("/api/channels")).json();
    const mine = sql`${workItems.payload}->>'actorId' = ${actor.id}`;
    const hops = () =>
      database
        .select({
          key: workItems.key,
          payload: workItems.payload,
          attempts: workItems.attempts,
          finishedAt: workItems.finishedAt,
        })
        .from(workItems)
        .where(and(eq(workItems.kind, HANDOFF_KIND), mine));
    const trail = () =>
      database
        .select({
          eventType: auditEvents.eventType,
          targetId: auditEvents.targetId,
          initiatorKind: auditEvents.initiatorKind,
          initiatorId: auditEvents.initiatorId,
          payload: auditEvents.payload,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.actorUserId, actor.id),
            inArray(auditEvents.eventType, [
              "agent.handoff_offered",
              "agent.handoff_delivered",
              "agent.handoff_refused",
              "agent.handoff_retried",
              "agent.handoff_failed",
            ]),
          ),
        )
        .orderBy(auditEvents.createdAt);

    // Run now, awaited: its worker would otherwise still be running when the hop is swept.
    const fired = await app.request(
      `/api/routines/${routine.id}/run`,
      post({}),
    );
    expect(fired.status).toBe(202);
    const { runId } = await fired.json();
    await app.routineRunner.run(runId);

    // The Routine's Run, finished, and the Conversation's own Run.
    const first = await runs();
    expect(first).toMatchObject({
      runs: [
        {
          id: runId,
          status: "succeeded",
          conversationRunId: runId,
          source: "run_now",
        },
      ],
    });
    const [hop] = await hops();
    if (!hop) throw new Error("The handoff was not offered.");
    const handed = `${HANDED_OVER}${NAMES.target}.`;
    expect(hop).toMatchObject({
      attempts: 0,
      finishedAt: null,
      payload: {
        fromBotId: asker.id,
        toBotId: target.id,
        actorId: actor.id,
        threadId: channel.threadId,
        runId,
        depth: 1,
        initiator: { kind: "routine", id: routine.id },
        fromName: NAMES.asker,
        toName: NAMES.target,
        task: TASK,
      },
    });
    // Two steps of one Run: the first offered `message_bot` with the granted Bot as the only
    // choice, the second carrying the signed Routine and the tool's answer.
    expect(seen.asker.map((request) => request.runId)).toEqual([runId, runId]);
    expect(
      readRunAssertion(
        seen.asker[0].forwardedProps?.openbotRun,
        config.keyEncryptionKey,
      ),
    ).toMatchObject({
      botId: asker.id,
      actorId: actor.id,
      runId,
      threadId: channel.threadId,
      initiator: { kind: "routine", id: routine.id },
    });
    const offered = seen.asker[0].tools.find(
      (tool) => tool.name === HANDOFF_TOOL,
    );
    if (!offered) throw new Error("message_bot was not offered.");
    expect(offered.parameters.properties.bot).toEqual(
      expect.objectContaining({ enum: [NAMES.target] }),
    );
    expect(
      seen.asker[1].messages.find((message) => message.role === "tool"),
    ).toMatchObject({
      toolCallId: "ask",
      content: expect.stringContaining(handed),
    });
    expect(await transcript()).toMatchObject({
      runs: [
        {
          id: runId,
          status: "completed",
          userMessageId: backgroundMessageId("routine", runId),
          assistantMessageId: `reply-${runId}`,
        },
      ],
      messages: [
        {
          id: backgroundMessageId("routine", runId),
          role: "user",
          content: expect.stringContaining(INSTRUCTION),
        },
        { id: `reply-${runId}`, role: "assistant", content: ASKER_REPLY },
      ],
    });
    // The Run's own stream, as a reload reads it: the call the Bot made and the answer it got.
    expect(
      (
        await database
          .select({ event: directChatRunEvents.event })
          .from(directChatRunEvents)
          .where(eq(directChatRunEvents.runId, runId))
          .orderBy(directChatRunEvents.cursor)
      )
        .map((row) => row.event)
        .filter(
          (event) =>
            event.type === EventType.TOOL_CALL_START ||
            event.type === EventType.TOOL_CALL_RESULT,
        ),
    ).toMatchObject([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "ask",
        toolCallName: HANDOFF_TOOL,
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "ask",
        content: expect.stringContaining(handed),
      },
    ]);
    // The Conversation's entry: waiting on the other Bot, on the key the queue holds.
    expect(await roster()).toMatchObject({
      channels: [
        {
          id: channel.id,
          threadId: channel.threadId,
          lastMessage: ASKER_REPLY,
          lastMessageAgentId: asker.id,
          work: [
            {
              kind: "handoff",
              key: hop.key,
              botId: target.id,
              botName: NAMES.target,
            },
          ],
        },
      ],
    });

    // A worker picks the hop up and delivers it as the other Bot, in the asking Conversation.
    const runner = createHandoffRunner({
      // `claim` filters by kind alone, so a hop another test leaked would be delivered here as this
      // person's. Only this person's hops are taken.
      queue: {
        ...queue,
        claim: (input) => queue.claim({ ...input, ready: mine }),
      },
      owner: `routine-handoff-${suite}`,
      auditStore,
      sign: (work, claim) =>
        signHandoffDeliveryRun(work, config.keyEncryptionKey, undefined, claim),
      answerGone: answerGoneFrom(database),
      onSettled: (work) => app.channelStore.signalWork(work.threadId),
      delivery: createOpenBotHandoffDelivery({
        runBackground: app.runBackground,
        channelStore: app.channelStore,
        actorFor,
        mayAddress,
        database,
        groupConversations: app.groupConversations,
      }),
    });
    expect(await runner.sweep()).toEqual({
      delivered: [target.id],
      skipped: [],
    });
    const deliveryRunId = createHash("sha256").update(hop.key).digest("hex");
    const shown = `${NAMES.asker} asked ${NAMES.target} for this on your behalf: ${TASK}`;
    expect(await transcript()).toMatchObject({
      runs: [
        { id: runId, status: "completed" },
        {
          id: deliveryRunId,
          status: "completed",
          externalOutcome: "executed",
          userMessageId: backgroundMessageId("handoff", deliveryRunId),
          assistantMessageId: answerMessageId(target.id, deliveryRunId),
        },
      ],
      messages: [
        { role: "user", content: expect.stringContaining(INSTRUCTION) },
        { role: "assistant", content: ASKER_REPLY },
        {
          id: backgroundMessageId("handoff", deliveryRunId),
          role: "user",
          content: shown,
        },
        {
          id: answerMessageId(target.id, deliveryRunId),
          role: "assistant",
          content: ANSWER,
        },
      ],
    });
    // The Conversation's entry: no longer waiting, and moved. A hop finishes with no browser
    // attached, so nobody reports its answer: the entry moves only if the delivery records it.
    const settled = await roster();
    expect(settled).toMatchObject({
      channels: [
        {
          id: channel.id,
          lastMessage: ANSWER,
          // Under the Conversation's own Bot: the roster admits nobody else in it.
          lastMessageAgentId: asker.id,
          work: [],
        },
      ],
    });
    // Told of when the answer landed: the latest event of the Run that answered.
    const [landed] = await database
      .select({ at: directChatRunEvents.createdAt })
      .from(directChatRunEvents)
      .where(
        and(
          eq(directChatRunEvents.threadId, channel.threadId),
          eq(directChatRunEvents.runId, deliveryRunId),
        ),
      )
      .orderBy(desc(directChatRunEvents.createdAt))
      .limit(1);
    expect(new Date(settled.channels[0].lastMessageAt).getTime()).toBe(
      landed.at.getTime(),
    );
    expect(await hops()).toMatchObject([
      { key: hop.key, attempts: 1, finishedAt: expect.any(Date) },
    ]);
    // The other Bot ran once, as itself, in the asking Conversation, under the Routine's origin.
    expect(seen.target.map((request) => request.runId)).toEqual([
      deliveryRunId,
    ]);
    const asked = seen.target[0];
    // The Bot that answered is offered no tool to hand the work on again. That holds today because
    // the Conversation's own Bot is the one that asked, not because its statement carries the hop's
    // depth: this delivery drops the statement the runner signed for it.
    expect(asked.tools.map((tool) => tool.name)).not.toContain(HANDOFF_TOOL);
    expect(asked.messages.at(-1)?.content).toContain(
      `You are ${NAMES.target}.`,
    );
    expect(asked.messages.at(-1)?.content).toContain(`Task: ${TASK}`);
    expect(
      readRunAssertion(
        asked.forwardedProps?.openbotRun,
        config.keyEncryptionKey,
      ),
    ).toMatchObject({
      botId: target.id,
      actorId: actor.id,
      runId: deliveryRunId,
      threadId: channel.threadId,
      initiator: {
        kind: "handoff",
        id: asker.id,
        origin: { kind: "routine", id: routine.id },
      },
    });
    expect(
      await database
        .select({
          id: directChatRuns.id,
          handoffFromBotId: directChatRuns.handoffFromBotId,
          dispatchedAt: directChatRuns.dispatchedAt,
        })
        .from(directChatRuns)
        .where(
          and(
            eq(directChatRuns.threadId, channel.threadId),
            eq(directChatRuns.handoffFromBotId, asker.id),
          ),
        ),
    ).toMatchObject([{ id: deliveryRunId, dispatchedAt: expect.any(Date) }]);
    // The Audit trail: offered under the Routine, delivered under the asking Bot.
    expect(await trail()).toMatchObject([
      {
        eventType: "agent.handoff_offered",
        targetId: target.id,
        initiatorKind: "routine",
        initiatorId: routine.id,
        payload: {
          bot: asker.id,
          from: asker.id,
          to: target.id,
          run: runId,
          depth: 1,
          task: TASK,
        },
      },
      {
        eventType: "agent.handoff_delivered",
        targetId: target.id,
        initiatorKind: "handoff",
        initiatorId: asker.id,
        payload: {
          bot: asker.id,
          from: asker.id,
          to: target.id,
          run: runId,
          depth: 1,
          conversationRunId: deliveryRunId,
        },
      },
    ]);

    // The same trigger again: the Run is finished, so nothing is said and nothing runs.
    const said = spyOn(app.channelStore, "recordActivity");
    await app.routineRunner.run(runId);
    expect(said).not.toHaveBeenCalled();
    expect(await runs()).toMatchObject({
      runs: [
        {
          id: runId,
          status: "succeeded",
          finishedAt: first.runs[0].finishedAt,
        },
      ],
    });
    // The same handoff again: nothing left to claim, the same key is already there, and a hop
    // whose queue row went missing, offered again, lands on the Run that already answered.
    expect(await runner.sweep()).toEqual({ delivered: [], skipped: [] });
    expect(
      await queue.offer({
        kind: HANDOFF_KIND,
        key: hop.key,
        payload: hop.payload,
      }),
    ).toBe("already");
    await database.delete(workItems).where(eq(workItems.key, hop.key));
    await queue.offer({
      kind: HANDOFF_KIND,
      key: hop.key,
      payload: hop.payload,
    });
    expect(await runner.sweep()).toEqual({
      delivered: [target.id],
      skipped: [],
    });
    expect(seen.asker).toHaveLength(2);
    expect(seen.target).toHaveLength(1);
    expect(await transcript()).toMatchObject({
      runs: [{ id: runId }, { id: deliveryRunId }],
    });
    expect(await hops()).toMatchObject([
      { key: hop.key, attempts: 1, finishedAt: expect.any(Date) },
    ]);
    // Told again, of when the answer landed. The entry is where the first delivery left it, not
    // lifted again for an old answer: the roster only goes forward.
    expect(said).toHaveBeenCalledTimes(1);
    expect(said.mock.calls[0][2]).toMatchObject({
      text: ANSWER,
      agentId: asker.id,
    });
    // Compared as numbers: toMatchObject takes any Date for a Date.
    expect(said.mock.calls[0][2].at.getTime()).toBe(landed.at.getTime());
    expect(await roster()).toMatchObject({
      channels: [
        { id: channel.id, lastMessageAt: settled.channels[0].lastMessageAt },
      ],
    });
    // The Run's events go after an hour; its row stays. Told a third time, once they are gone, of
    // when the Run started, which the same database stamped before the answer: still nothing moves.
    await database
      .delete(directChatRunEvents)
      .where(
        and(
          eq(directChatRunEvents.threadId, channel.threadId),
          eq(directChatRunEvents.runId, deliveryRunId),
        ),
      );
    await database.delete(workItems).where(eq(workItems.key, hop.key));
    await queue.offer({
      kind: HANDOFF_KIND,
      key: hop.key,
      payload: hop.payload,
    });
    expect(await runner.sweep()).toEqual({
      delivered: [target.id],
      skipped: [],
    });
    const [started] = await database
      .select({ startedAt: directChatRuns.startedAt })
      .from(directChatRuns)
      .where(
        and(
          eq(directChatRuns.threadId, channel.threadId),
          eq(directChatRuns.id, deliveryRunId),
        ),
      );
    expect(said).toHaveBeenCalledTimes(2);
    expect(said.mock.calls[1][2].at.getTime()).toBe(
      started.startedAt.getTime(),
    );
    expect(seen.target).toHaveLength(1);
    expect(await roster()).toMatchObject({
      channels: [
        { id: channel.id, lastMessageAt: settled.channels[0].lastMessageAt },
      ],
    });
  } finally {
    await database
      .delete(workItems)
      .where(
        and(
          eq(workItems.kind, HANDOFF_KIND),
          sql`${workItems.payload}->>'actorId' = ${actor.id}`,
        ),
      );
    await database
      .delete(pluginGrants)
      .where(eq(pluginGrants.agentId, asker.id));
    setEdition(edition);
  }
}, 60_000);

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
          if (!response.ok)
            return { availability: "unavailable", messages: [] };
          const history = await response.json();
          return { ...history, availability: "ready" };
        },
      }),
  });
  const result = (async () => {
    await session.start();
    expect(session.getSnapshot().phase).toBe("connected");
    receive({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "fixture-transcript",
      transcript: request,
    });
    expect(session.getSnapshot().transcript).toBe(request);
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

test("a voice-triggered tool waits for approval and resumes the original Run once", async () => {
  const actor = await person();
  const bot = await profiles.create(actor, {
    name: "Notes",
    title: "Bot",
    roleDescription: "Posts approved notes.",
    visibility: "private",
  });
  const store = createApprovalStore(database);
  await store.setEnabled(actor.id, true);
  const service = createApprovalService(store);
  let writes = 0;
  const act = async () => {
    const permit = await service.gate({
      actorId: actor.id,
      botId: bot.id,
      toolRef: "notes/post",
      scope: "fixture",
      effect: "write",
      args: {},
    });
    if (permit && typeof permit.replay === "string") return permit.replay;
    writes++;
    await permit?.complete("posted");
    return "posted";
  };
  const llm = new LLMock({ host: "127.0.0.1", port: 0 });
  llm.on(
    {
      predicate: ({ messages }) => messages.some(({ role }) => role === "tool"),
    },
    () => ({ content: "Your note was posted." }),
  );
  llm.on({ predicate: () => true }, ({ tools }) =>
    JSON.stringify(tools).includes("post_note")
      ? { toolCalls: [{ name: "post_note", arguments: "{}" }] }
      : { content: "I do not have the notes tool." },
  );
  const originalBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = `${await llm.start()}/v1`;
  try {
    const resolver = createActorAgentResolver({
      loadAgents: async () => [
        {
          id: bot.id,
          name: bot.name,
          type: "built_in",
          systemPrompt: "Post a note.",
        },
      ],
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      resolveModelApiKey: async () => "fixture-key",
      loadToolsForActor: (actorId) => async (botId) =>
        actorId === actor.id && botId === bot.id
          ? [
              {
                name: "post_note",
                ref: "notes/post",
                description: "Post a note.",
                parameters: z.object({}),
                execute: act,
              },
            ]
          : [],
    });
    const app = web(database, actor, bot.id, async () => {}, { resolver });
    const restarted = web(database, actor, bot.id, async () => {}, {
      resolver,
    });
    const { channel } = await (
      await app.request("/api/channels", post({ agentIds: [bot.id] }))
    ).json();
    const thread = `/api/copilotkit/threads/${channel.threadId}`;
    const path = `/api/copilotkit/agent/${bot.id}`;
    const voice = voiceTurn(app, channel, bot.id, "Post the note.");
    const runId = await voice.id;
    const history = async () =>
      (await restarted.request(`${thread}/messages?agentId=${bot.id}`)).json();
    let snapshot = await history();
    const waitingDeadline = Date.now() + 8_000;
    while (
      !snapshot.runs[0]?.waitingForApproval &&
      Date.now() < waitingDeadline
    ) {
      await Bun.sleep(100);
      snapshot = await history();
    }
    expect(snapshot.runs).toMatchObject([
      { id: runId, status: "running", waitingForApproval: true },
    ]);
    expect(writes).toBe(0);
    const mobileInbox = await restarted.request(
      `/api/approvals?threadId=${encodeURIComponent(channel.threadId)}`,
    );
    expect(mobileInbox.status).toBe(200);
    const { requests } = await mobileInbox.json();
    expect(requests).toMatchObject([
      {
        status: "pending",
        action: { threadId: channel.threadId, toolRef: "notes/post" },
      },
    ]);
    const [request] = requests;
    expect(
      (
        await restarted.request(
          `/api/approvals/${request.id}/decision`,
          post({ decision: "allow_once" }),
        )
      ).status,
    ).toBe(200);
    const tick = createApprovalResumeTick({
      approvalQueue: createWorkQueue(database),
      approvalOwner: runId,
      approvalService: service,
      executeApprovedAction: act,
      database,
      responsibilityStore: createResponsibilityStore(database, {
        resolveTarget: async () => null,
      }),
      groupConversations: {
        pauseWaiting: async () => {
          throw new Error("Unexpected group approval.");
        },
        continueWaiting: async () => {
          throw new Error("Unexpected group continuation.");
        },
      },
      approvalContinuationRunner: async () => {
        throw new Error("Unexpected legacy continuation.");
      },
      backgroundApproval: restarted.backgroundApproval,
      channelStore: restarted.channelStore,
      actorFor: async () => actor,
      notify: async () => {},
    });
    const until = Date.now() + 20_000;
    do {
      await tick();
      if ((await store.get(actor.id, request.id)).status === "completed") break;
      await Bun.sleep(200);
    } while (Date.now() < until);
    expect((await store.get(actor.id, request.id)).status).toBe("completed");
    expect(writes).toBe(1);
    const resume = await restarted.request(`${path}/resume`, {
      ...post({ threadId: channel.threadId, runId, cursor: 0 }),
      signal: AbortSignal.timeout(15_000),
    });
    const replay = events(await resume.text());
    expect(
      replay.filter(({ type }) => type === EventType.RUN_STARTED),
    ).toMatchObject([
      { type: EventType.RUN_STARTED, threadId: channel.threadId, runId },
    ]);
    expect(replay).toContainEqual({
      type: EventType.RUN_FINISHED,
      threadId: channel.threadId,
      runId,
    });
    expect(await voice.result).toEqual({ answer: "Your note was posted." });
    expect(await history()).toMatchObject({
      messages: [
        { id: runId },
        { role: "assistant", content: "Your note was posted." },
      ],
      runs: [{ id: runId, status: "completed" }],
    });
    expect(writes).toBe(1);
  } finally {
    if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBase;
    await llm.stop();
  }
}, 60_000);

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
    expect((await readConversation.json()).channel).toMatchObject({
      threadId: channel.threadId,
      direct: true,
    });
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

function traceOperatorApp(operators?: string) {
  // createApp takes attachmentDatabase as its 26th argument.
  const args = new Array(createApp.length) as Parameters<typeof createApp>;
  args[0] = loadConfig({
    DATABASE_URL: databaseUrl,
    OPENBOT_ORGANIZATION_AUTH_URL: "https://example.test",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    OPENBOT_OPIK_TRACE_OPERATORS: operators,
  });
  args[1] = {
    handler: () => new Response(null, { status: 404 }),
    api: {
      getSession: async ({ headers }) => {
        const id = headers.get("x-test-actor");
        return id ? { user: { id, email: `${id}@example.test` } } : null;
      },
    },
  };
  args[2] = {
    rolesForUser: async (id) => [id === "member" ? "user" : "admin"],
  };
  args[25] = database;
  return createApp(...args);
}

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
        const tracePath = "/api/admin/opik/traces";
        const operator = { headers: { "x-test-actor": "operator" } };
        const traceApp = traceOperatorApp(" operator , member ");
        expect((await traceApp.request(tracePath)).status).toBe(401);
        for (const actor of ["member", "other-admin"]) {
          expect(
            (
              await traceApp.request(tracePath, {
                headers: { "x-test-actor": actor },
              })
            ).status,
          ).toBe(403);
        }
        expect(
          (await traceOperatorApp().request(tracePath, operator)).status,
        ).toBe(403);
        expect(
          (await traceApp.request(`${tracePath}?after=invalid`, operator))
            .status,
        ).toBe(400);
        const duringOutage = await traceApp.request(tracePath, operator);
        expect(duringOutage.status).toBe(200);
        expect((await duringOutage.json()).traces).toContainEqual(
          expect.objectContaining({
            state: "dropped",
            traceId: null,
            score: null,
          }),
        );
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
        const view = await traceApp.request(tracePath, operator);
        expect(view.status).toBe(200);
        expect(view.headers.get("cache-control")).toBe("no-store");
        expect(await view.json()).toEqual({
          traces: expect.arrayContaining([
            {
              recordId: expect.any(String),
              traceId: ordinaryTrace?.id,
              state: "complete",
              status: "completed",
              startedAt: expect.any(String),
              finishedAt: expect.any(String),
              durationMs: ordinaryTrace?.metadata.duration_ms,
              score: null,
            },
            {
              recordId: expect.any(String),
              traceId: incompleteTrace?.id,
              state: "incomplete",
              status: "completed",
              startedAt: expect.any(String),
              finishedAt: expect.any(String),
              durationMs: incompleteTrace?.metadata.duration_ms,
              score: 1,
            },
          ]),
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
  process.env.TEST_OPIK_API_URL ? 300_000 : 120_000,
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
    if (!reader) throw new Error("Missing Run stream.");
    await started.promise;
    const decoder = new TextDecoder();
    let cursor: string | undefined;
    while (cursor === undefined) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Run stream closed before sending a cursor.");
      cursor = decoder.decode(value).match(/^id: (\d+)$/m)?.[1];
    }
    await reader.cancel();
    release.resolve();
    expect(cursor).toBe("1");
    const replay = await app.request(
      `${path}/resume`,
      post({ ...input, cursor: Number(cursor) }),
    );
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

test("Conversation and voice turns share Test Credits, reconcile uncertain dispatch, and keep history and basic Memory available during an outage", async () => {
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
  let billingRequests = 0;
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      billingRequests++;
      const path = new URL(request.url).pathname;
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      if (path === "/v1/quote")
        return Response.json({
          route: "pilot-text-v1",
          priceVersion: trialPriceVersion,
        });
      const call = await request.json();
      calls.push({ path, operationId: call.operationId });
      if (path === "/v1/reserve") {
        expect(call).toEqual({
          operationId: expect.any(String),
          route: "pilot-text-v1",
          priceVersion: trialPriceVersion,
          creditType: "test",
          applicationId: "openbot",
          resumable: false,
        });
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
      if (call.operationId === uncertainOperation) {
        return Response.json({
          state: uncertainState,
          operation: {
            operationId: call.operationId,
            state: uncertainState,
            outcome: confirmedUnsent
              ? null
              : verifiedText
                ? "completed"
                : "unknown",
            dispatchedAt: confirmedUnsent ? null : "2026-11-23T00:00:00.000Z",
            resultText: verifiedText ?? null,
          },
        });
      }
      return Response.json({
        state: ids.has(call.operationId) ? "settled" : "absent",
      });
    },
  });
  const deployment = loadConfig({
    DATABASE_URL: databaseUrl,
    OPENBOT_ORGANIZATION_AUTH_URL: "https://example.test",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    OPENBOT_MANAGED_MODEL_TRIAL_URL: control.url.href,
    OPENBOT_MANAGED_MODEL_TRIAL_PERSON_CREDENTIALS: JSON.stringify({
      [alice.id]: "test-token",
    }),
    OPENBOT_MANAGED_MODEL_TRIAL_ROUTE: "pilot-text-v1",
  });
  try {
    const memory = createMemoryStore(database);
    const ingestion = createMemoryIngestion({
      store: memory,
      plugins: createPluginStore({
        brokerProvider: "composio",
        database,
        auditStore: createAuditStore(database),
        credentials: createCredentialStore(database),
        encryptionKey: Buffer.alloc(32, 7).toString("base64"),
        policy: () => ({ mode: "enforce", deny: [], allow: [] }),
      }),
      canUseBot: async () => false,
    });
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
        app.route(
          "/api/memory",
          createMemoryRoutes(memory, ingestion, async (context, next) => {
            context.set("actor", alice);
            await next();
          }),
        );
        const opened = await app.request(
          "/api/channels",
          post({ agentIds: [bot.id] }),
        );
        expect(opened.status).toBe(201);
        const { channel } = await opened.json();
        conversations.push(channel.id);
        return {
          app,
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
    const callsBeforeMemory = billingRequests;
    const content = "A manual Memory saved during the ledger outage.";
    const savedMemory = await winner.app.request(
      "/api/memory",
      post({ content }),
    );
    expect(savedMemory.status).toBe(201);
    const listedMemory = await winner.app.request("/api/memory");
    expect(listedMemory.status).toBe(200);
    expect(await listedMemory.json()).toEqual({
      memories: expect.arrayContaining([expect.objectContaining({ content })]),
    });
    expect(billingRequests).toBe(callsBeforeMemory);
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
      error:
        "Check the run’s unverified outcome in the conversation before asking again.",
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
        pendingApprovals: [{ id: request.id, toolCallId: "call" }],
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
  const people = createPeopleStore(database, []);
  let dispatches = 0;
  const aliceApp = web(
    database,
    alice,
    aliceBot.id,
    async () => {
      dispatches++;
      await release.promise;
    },
    {
      authorized: async () => !(await people.isRevoked(alice.email)),
      partial: "Before revocation.",
    },
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
  const history = `/api/copilotkit/threads/${aliceChannel.threadId}/messages?agentId=${aliceBot.id}`;
  try {
    // The Run in flight when access goes is the one the call started, not a plain HTTP turn.
    const spoken = voiceTurn(
      aliceApp,
      aliceChannel,
      aliceBot.id,
      "Hello from the call.",
    );
    const spokenId = await spoken.id;
    const payload = {
      threadId: aliceChannel.threadId,
      runId: spokenId,
      messages: [
        { role: "user", id: spokenId, content: "Hello from the call." },
      ],
    };
    let partial = "";
    while (!partial.includes("Before revocation.")) {
      partial = await (await aliceApp.request(history)).text();
    }
    await people.revoke(alice.id, bob.id);
    const revokedAt = Date.now();
    expect(await spoken.result).toEqual({
      error: expect.stringContaining("The Bot run is unavailable."),
    });
    expect(Date.now() - revokedAt).toBeLessThan(60_000);
    expect((await aliceApp.request(history)).status).toBe(404);
    expect((await aliceApp.request(`${path}/run`, post(payload))).status).toBe(
      404,
    );
    expect(
      await voiceTurn(
        aliceApp,
        aliceChannel,
        aliceBot.id,
        "Continue from the call.",
      ).result,
    ).toEqual({ error: expect.stringContaining("HTTP 404") });
    expect(dispatches).toBe(1);
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
    await people.restore(alice.id);
    release.resolve();
    const original = await aliceApp.request(`${path}/run`, post(payload));
    expect(await original.text()).toContain("access_revoked");
    expect(dispatches).toBe(1);
    expect(
      await voiceTurn(aliceApp, aliceChannel, bobBot.id, "Ask a different Bot.")
        .result,
    ).toEqual({ error: expect.stringContaining("HTTP 404") });
    expect(dispatches).toBe(1);
    const retry = voiceTurn(
      aliceApp,
      aliceChannel,
      aliceBot.id,
      "Try again from the call.",
    );
    expect(await retry.result).toEqual({
      answer: "Before revocation.Offline answer.",
    });
    expect(
      (
        await (
          await aliceApp.request(
            `/api/copilotkit/threads/${aliceChannel.threadId}/messages?agentId=${aliceBot.id}`,
          )
        ).json()
      ).runs,
    ).toContainEqual(
      expect.objectContaining({ id: await retry.id, status: "completed" }),
    );
    expect(dispatches).toBe(2);
  } finally {
    release.resolve();
    await people.restore(alice.id);
    for (const channel of [aliceChannel, bobChannel])
      await database.delete(channels).where(eq(channels.id, channel.id));
    for (const bot of bots)
      await database.delete(agents).where(eq(agents.id, bot.id));
    for (const actor of [alice, bob])
      await database.delete(users).where(eq(users.id, actor.id));
  }
});

test("Memory withdrawn after model dispatch pauses the original Run before its next action and survives reconnect", async () => {
  const actor = await person();
  const bot = await profiles.create(actor, {
    name: "Memory boundary Bot",
    title: "Bot",
    roleDescription: "Use the product Memory.",
    visibility: "public",
  });
  const store = createMemoryStore(database);
  const plugins = createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: createCredentialStore(database),
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  });
  const ingestion = createMemoryIngestion({
    store,
    plugins,
    canUseBot: async (person, id) => person === actor.id && id === bot.id,
  });
  const memory = createMemoryRoutes(store, ingestion, async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  const created = await memory.request(
    "/",
    post({ content: "Private Memory fixture." }),
  );
  expect(created.status).toBe(201);
  const { memory: fact } = await created.json();
  const provider = new LLMock();
  const base = process.env.OPENAI_BASE_URL;
  const loaded = Promise.withResolvers<string>();
  const respond = Promise.withResolvers<void>();
  let modelCalls = 0;
  let actions = 0;
  provider.on({ predicate: () => true }, async (request) => {
    modelCalls += 1;
    if (modelCalls > 1) return { content: "Unexpected continuation." };
    loaded.resolve(JSON.stringify(request.messages));
    await respond.promise;
    return {
      content: "Output already in flight.",
      toolCalls: [
        { id: "fixture-action", name: "mcp__fixture__write", arguments: "{}" },
      ],
    };
  });
  process.env.OPENAI_BASE_URL = await provider.start();
  let channelId: string | undefined;
  try {
    const makeAgent = async () => {
      const agents = await buildAgents(
        [
          {
            id: bot.id,
            name: bot.name,
            type: "built_in",
            systemPrompt: "Answer the question.",
          },
        ],
        { provider: "openai", defaultModel: "gpt-5.5" },
        "fixture-key",
        undefined,
        async () => [
          {
            ref: "fixture/write",
            name: "mcp__fixture__write",
            description: "Record that the external action was called.",
            parameters: z.object({}),
            execute: async () => {
              actions += 1;
              return "Action dispatched.";
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => ingestion.contextFor(actor.id, bot.id),
      );
      const agent = agents[bot.id];
      if (!agent) throw new Error("Test Bot unavailable.");
      return agent;
    };
    const client = web(database, actor, bot.id, async () => {}, { makeAgent });
    const opened = await client.request(
      "/api/channels",
      post({ agentIds: [bot.id] }),
    );
    const { channel } = await opened.json();
    channelId = channel.id;
    const runId = "memory-revoked";
    const route = `/api/copilotkit/agent/${bot.id}`;
    const original = await client.request(
      `${route}/run`,
      post({
        threadId: channel.threadId,
        runId,
        messages: [
          { id: "ask-memory", role: "user", content: "Use the fixture." },
        ],
      }),
    );
    expect(await loaded.promise).toContain("Private Memory fixture.");
    expect(
      (await memory.request(`/${fact.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    respond.resolve();
    const originalEvents = await original.text();
    expect(originalEvents).toContain("context_revoked");
    const output = (stream: string) =>
      events(stream)
        .filter(({ type }) => type === EventType.TEXT_MESSAGE_CONTENT)
        .map(({ delta }) => delta)
        .join("");
    const delivered = output(originalEvents);
    expect("Output already in flight.".startsWith(delivered)).toBe(true);
    const reconnected = await web(database, actor, bot.id, async () => {}, {
      makeAgent,
    }).request(
      `${route}/resume`,
      post({ threadId: channel.threadId, runId, cursor: 0 }),
    );
    const replay = await reconnected.text();
    expect(replay).toContain(runId);
    expect(replay).toContain("context_revoked");
    expect(output(replay)).toBe(delivered);
    expect(actions).toBe(0);
    expect(modelCalls).toBe(1);
  } finally {
    respond.resolve();
    if (base === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = base;
    await provider.stop();
    if (channelId)
      await database.delete(channels).where(eq(channels.id, channelId));
    await database.delete(agents).where(eq(agents.id, bot.id));
    await database.delete(users).where(eq(users.id, actor.id));
  }
}, 20_000);

test.each([
  "native",
  "managed",
  "managed-uncertain",
  "native-selection",
  "native-write-lock",
  "managed-write-lock",
  "managed-evidence-write-lock",
  "managed-sharing-setting-write-lock",
  "late-user",
  "late-background",
  "late-authorized",
  "late-background-authorized",
  "late-deleted",
  "late-version-change",
  "late-legacy",
])(
  "published skill catalog checks guidance and revocation for %s",
  exercisePublishedSkill,
  90_000,
);

async function exercisePublishedSkill(mode: string) {
  const alice = await person();
  const bob = await person();
  const outsider = await person();
  const reviewer = await person();
  await database
    .insert(userRoles)
    .values({ userId: reviewer.id, role: "admin" });
  const botDetails = {
    name: "Packing Bot",
    title: "Bot",
    roleDescription: "Answers locally.",
  };
  const bot = await profiles.create(alice, {
    ...botDetails,
    visibility: "public",
  });
  const second = await profiles.create(alice, {
    ...botDetails,
    name: "Second Bot",
    visibility: "public",
  });
  const channelIds: string[] = [];
  const enterprise = createEnterpriseStore(database);
  const previousSharing = (await enterprise.settings()).skillSharing;
  const runInputs: RunAgentInput[] = [];
  let sharedVersions: RunContextVersion[] | undefined;
  const capture = async (input: RunAgentInput) => {
    runInputs.push(input);
    if (input.runId === "shared-skill") sharedVersions = runContextVersions();
  };
  const aliceChat = web(database, alice, bot.id, capture);
  const bobChat = web(database, bob, bot.id, capture);
  const outsiderChat = web(database, outsider, bot.id, capture);
  const admin = web(database, { ...reviewer, role: "admin" }, bot.id, capture);
  try {
    await enterprise.setSetting("skillSharing", true, bob.id);
    async function open(app: typeof aliceChat, ids: string[]) {
      const result = await app.request(
        "/api/channels",
        post({ agentIds: ids }),
      );
      expect(result.status).toBe(201);
      const data = z
        .object({
          channel: z.object({ id: z.string(), threadId: z.string() }),
        })
        .parse(await result.json());
      channelIds.push(data.channel.id);
      return data.channel;
    }
    const aliceChannel = await open(aliceChat, [bot.id]);
    const bobChannel = await open(bobChat, [bot.id]);
    await open(outsiderChat, [bot.id]);
    const source = await open(aliceChat, [bot.id, second.id]);
    const groups = createGroupStore(database, () => crypto.randomUUID());
    await groups.seedOrder(alice.id, source.id, [bot.id, second.id]);
    await groups.addMember(alice.id, source.id, bob.email);
    await groups.addMember(alice.id, source.id, reviewer.email);
    await groups.append({
      id: crypto.randomUUID(),
      ownerUserId: alice.id,
      channelId: source.id,
      agentId: bot.id,
      threadId: "shared-fixture",
      text: "Check the shipping label.",
      details: {},
    });
    const permission = `/api/copilotkit/conversations/${source.id}/learning-evidence`;
    const grant = { ...post({ allowed: true }), method: "PUT" };
    expect((await aliceChat.request(permission, grant)).status).toBe(200);
    expect((await bobChat.request(permission, grant)).status).toBe(200);
    expect((await admin.request(permission, grant)).status).toBe(200);
    const scope = {
      personId: alice.id,
      botId: bot.id,
      threadId: aliceChannel.threadId,
    };
    const locator = { kind: "conversation", id: source.id } as const;
    const cutoff = new Date();
    const evidence = await database.transaction((tx) =>
      readLearningSource(tx, scope, locator, cutoff),
    );
    if (!evidence) throw new Error("Expected eligible shared evidence.");
    const id = crypto.randomUUID();
    await database.insert(directChatAnalyses).values({
      id,
      threadId: scope.threadId,
      botId: scope.botId,
      state: "proposed",
      evidenceRunIds: [],
      evidenceSources: [
        { ...locator, digest: evidence.digest, cutoff: cutoff.toISOString() },
      ],
      proposal: {
        title: "Pack a shipment",
        instructions: "List the steps in order.",
      },
    });
    const catalog = "/api/copilotkit/learning/skills";
    expect((await aliceChat.request(`${catalog}/${id}`)).status).toBe(404);
    expect(
      (
        await admin.request(
          `/api/copilotkit/admin/learning/proposals/${id}`,
          post({ decision: "approve" }),
        )
      ).status,
    ).toBe(200);
    const detail = `${catalog}/${id}`;
    const share = (recipient: string) => post({ email: recipient });
    expect(await (await aliceChat.request(catalog)).json()).toMatchObject({
      skills: [expect.objectContaining({ id: id, access: "owned" })],
    });
    expect((await bobChat.request(detail)).status).toBe(404);
    expect(
      (await bobChat.request(`${detail}/shares`, share(alice.email))).status,
    ).toBe(404);
    expect(
      (await aliceChat.request(`${detail}/shares`, share(alice.email))).status,
    ).toBe(404);
    expect(
      (await aliceChat.request(`${detail}/shares`, share(outsider.email)))
        .status,
    ).toBe(404);
    expect(
      (await aliceChat.request(`${detail}/shares`, share(bob.email))).status,
    ).toBe(200);
    expect(await (await bobChat.request(detail)).json()).toMatchObject({
      id: id,
      access: "shared",
      instructions: "List the steps in order.",
    });
    const bobTurn = async (runId: string) => {
      const response = await bobChat.request(
        `/api/copilotkit/agent/${bot.id}/run`,
        post({
          threadId: bobChannel.threadId,
          runId,
          messages: [
            { id: runId, role: "user", content: "Show the procedure." },
          ],
        }),
      );
      expect(response.status).toBe(200);
      await response.text();
      return runInputs.at(-1)?.messages[0]?.content;
    };
    const guidance = await bobTurn("shared-skill");
    expect(guidance).toContain(id);
    expect(guidance).toContain(
      "Follow existing instructions, tool permissions, and approval requirements.",
    );
    const versionsCurrent = bobChat.learnedSkillVersionsCurrent;
    if (!versionsCurrent || !sharedVersions)
      throw new Error("Expected versioned shared guidance.");
    expect(sharedVersions).toEqual([
      { kind: "learned_skill", id, version: expect.any(String) },
    ]);
    expect(
      await versionsCurrent(bob, bobChannel.threadId, bot.id, sharedVersions),
    ).toBe(true);
    const revoke = `${detail}/shares/${encodeURIComponent(bob.id)}`;
    expect((await bobChat.request(revoke, { method: "DELETE" })).status).toBe(
      404,
    );
    expect((await aliceChat.request(revoke, { method: "DELETE" })).status).toBe(
      200,
    );
    expect((await bobChat.request(detail)).status).toBe(404);
    expect(await bobTurn("unshared-skill")).not.toContain(id);
    expect(
      await versionsCurrent(bob, bobChannel.threadId, bot.id, sharedVersions),
    ).toBe(false);
    expect(
      (await aliceChat.request(`${detail}/shares`, share(bob.email))).status,
    ).toBe(200);

    expect(await (await bobChat.request(catalog)).json()).toMatchObject({
      skills: [{ id, access: "shared" }],
    });
    const native = mode.startsWith("native");
    const writeLock = mode.endsWith("-write-lock");
    const evidenceWriteLock = mode === "managed-evidence-write-lock";
    const settingsWriteLock = mode === "managed-sharing-setting-write-lock";
    const late = mode.startsWith("late");
    const background = mode.startsWith("late-background");
    const selectionChanged = mode === "native-selection";
    const authorizedReceipt = mode.endsWith("-authorized");
    const loaded = Promise.withResolvers<string>();
    const respond = Promise.withResolvers<void>();
    let dispatches = 0;
    let receiptReady = false;
    const dispatch = async (prompt: string) => {
      dispatches++;
      loaded.resolve(prompt);
      await respond.promise;
    };
    const control = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        switch (new URL(request.url).pathname) {
          case "/v1/quote":
            return Response.json({
              route: "pilot-text-v1",
              priceVersion: "00000000-0000-4000-8000-000000000001",
            });
          case "/v1/reserve":
            return Response.json({ state: "reserved", permit: "fixture" });
          case "/v1/dispatch":
            await dispatch(await request.text());
            return late || mode === "managed-uncertain"
              ? new Response(null, { status: 504 })
              : Response.json({
                  state: "completed",
                  text: "Withheld managed answer.",
                });
          case "/v1/reconcile":
            return Response.json(
              receiptReady
                ? {
                    state: "settled",
                    outcome: "executed",
                    text: "Withheld managed answer.",
                  }
                : { state: "pending" },
            );
          default:
            return new Response(null, { status: 404 });
        }
      },
    });
    const runtimeDatabase = writeLock
      ? createDatabase(databaseUrl, TEST_POOL)
      : database;
    try {
      const mount = () =>
        web(
          runtimeDatabase,
          bob,
          bot.id,
          async (input) => {
            await dispatch(JSON.stringify(input.messages));
          },
          {
            ...(native
              ? { partial: "Safe partial." }
              : {
                  deployment: {
                    ...config,
                    managedModelTrial: {
                      url: control.url,
                      credentials: new Map([[bob.id, "fixture"]]),
                      route: "pilot-text-v1",
                    },
                  },
                }),
          },
        );
      let chat = mount();
      const route = `/api/copilotkit/agent/${bot.id}`;
      const runId = `in-flight-share-${mode}`;
      const run = { threadId: bobChannel.threadId, runId };
      const request = post({
        ...run,
        messages: [{ id: runId, role: "user", content: "Use the share." }],
      });
      const backgroundTurn = {
        source: "delivery" as const,
        id: runId,
        threadId: run.threadId,
        conversationBotId: bot.id,
        personId: bob.id,
        agentId: bot.id,
        prompt: "Use the share.",
        authorize: async () => bob,
        initiator: { kind: "person" as const },
      };
      const runBackground = chat.runBackground;
      if (!runBackground) throw new Error("Missing background runtime.");
      const initial = background
        ? runBackground(backgroundTurn).catch((error: unknown) => error)
        : null;
      const response = background
        ? null
        : await chat.request(`${route}/run`, request);
      if (response) expect(response.status).toBe(200);
      expect(await loaded.promise).toContain(id);
      const reader = response?.body?.getReader();
      const decoder = new TextDecoder();
      let live = "";
      const read = async () => {
        if (!reader) return false;
        const { done, value } = await reader.read();
        live += decoder.decode(value, { stream: !done });
        return !done;
      };
      if (native) {
        while (!live.includes("Safe partial.") && (await read())) {}
        expect(live).toContain("Safe partial.");
      }
      const revokeShare = async () => {
        expect(
          (await aliceChat.request(revoke, { method: "DELETE" })).status,
        ).toBe(200);
      };
      const withdraw = evidenceWriteLock
        ? async () => {
            expect(
              (
                await bobChat.request(permission, {
                  ...post({ allowed: false }),
                  method: "PUT",
                })
              ).status,
            ).toBe(200);
          }
        : settingsWriteLock
          ? () => enterprise.setSetting("skillSharing", false, reviewer.id)
          : revokeShare;
      let authorizationLocked = false;
      const newerIds = Array.from({ length: 20 }, () => crypto.randomUUID());
      if (selectionChanged) {
        const [original] = await database
          .select()
          .from(directChatAnalyses)
          .where(eq(directChatAnalyses.id, id));
        const [decision] = await database
          .select()
          .from(directChatProposalReviews)
          .where(eq(directChatProposalReviews.proposalId, id));
        if (!original || !decision) throw new Error("Missing published skill.");
        await database.insert(directChatAnalyses).values(
          newerIds.map((id) => ({
            ...original,
            id,
            startedAt: new Date("2099-01-01"),
          })),
        );
        await database
          .insert(directChatProposalReviews)
          .values(newerIds.map((proposalId) => ({ ...decision, proposalId })));
        await database.insert(directChatSkillShares).values(
          newerIds.map((proposalId) => ({
            proposalId,
            recipientId: bob.id,
            threadId: run.threadId,
          })),
        );
      } else if (writeLock) {
        await database.transaction(async (tx) => {
          await tx
            .select({ id: directChatRuns.id })
            .from(directChatRuns)
            .where(
              and(
                eq(directChatRuns.threadId, run.threadId),
                eq(directChatRuns.id, runId),
              ),
            )
            .for("update");
          // The result has returned and the mounted runtime is trying to write
          // it. Probe the withdrawal lock while the write waits on the Run row.
          respond.resolve();
          const deadline = Date.now() + 5000;
          for (;;) {
            await tx.execute(sql`select pg_stat_clear_snapshot()`);
            const [waiting] = await tx.execute(sql`
              select pid from pg_stat_activity
              where pg_backend_pid() = any(pg_blocking_pids(pid))
                and query like 'update "direct_chat_runs"%'
            `);
            if (waiting) break;
            if (Date.now() >= deadline)
              throw new Error(
                "The output write did not reach the held Run row.",
              );
            await Bun.sleep(10);
          }
          authorizationLocked = await database
            .transaction(async (probe) => {
              if (evidenceWriteLock) {
                await probe
                  .select({ id: channels.id })
                  .from(channels)
                  .where(eq(channels.id, source.id))
                  .for("update", { noWait: true });
              } else if (settingsWriteLock) {
                await probe
                  .select({ key: enterpriseSettings.key })
                  .from(enterpriseSettings)
                  .where(eq(enterpriseSettings.key, "skill_sharing"))
                  .for("update", { noWait: true });
              } else {
                await probe
                  .select({ id: directChatSkillShares.proposalId })
                  .from(directChatSkillShares)
                  .where(
                    and(
                      eq(directChatSkillShares.proposalId, id),
                      eq(directChatSkillShares.recipientId, bob.id),
                    ),
                  )
                  .for("update", { noWait: true });
              }
              return false;
            })
            .catch((error: unknown) => {
              const cause = error instanceof Error ? error.cause : undefined;
              if (
                cause &&
                typeof cause === "object" &&
                "errno" in cause &&
                cause.errno === "55P03"
              )
                return true;
              throw error;
            });
          if (!authorizationLocked) await withdraw();
        });
      } else if (!late) {
        await revokeShare();
      }
      respond.resolve();
      while (await read()) {}
      const thread = `/api/copilotkit/threads/${run.threadId}`;
      const history = () =>
        chat.request(`${thread}/messages?agentId=${bot.id}`);
      const reconcile = () =>
        chat.request(
          `${thread}/runs/${runId}/reconcile?agentId=${bot.id}`,
          post({}),
        );
      if (writeLock) {
        const answer = native ? "Offline answer." : "Withheld managed answer.";
        // If withdrawal slipped through, the pending write must never expose
        // the answer. On the fixed path publication wins and withdrawal follows.
        if (!authorizationLocked) expect(live).not.toContain(answer);
        expect(authorizationLocked).toBe(true);
        expect(live).toContain(answer);
        expect((await (await history()).json()).runs).toContainEqual(
          expect.objectContaining({ id: runId, status: "completed" }),
        );
        await withdraw();
        expect((await bobChat.request(detail)).status).toBe(404);
        const repeated = await chat.request(`${route}/run`, request);
        expect(await repeated.text()).toContain(answer);
        expect(dispatches).toBe(1);
        return;
      }
      if (selectionChanged) {
        expect(live).toContain("Offline answer.");
        expect(live).not.toContain("context_revoked");
        expect(await bobTurn("capped-selection")).not.toContain(id);
        await database
          .delete(directChatAnalyses)
          .where(inArray(directChatAnalyses.id, newerIds));
        return;
      }
      if (late) {
        if (background) {
          expect(await initial).toEqual(
            expect.objectContaining({
              message: expect.stringContaining("unverified external outcome"),
            }),
          );
        } else {
          expect(live).toContain("reconciling");
        }
        expect((await (await history()).json()).runs).toContainEqual(
          expect.objectContaining({
            id: runId,
            status: "failed",
            externalOutcome: "unknown",
          }),
        );
        if (mode === "late-deleted") {
          await database
            .delete(directChatAnalyses)
            .where(eq(directChatAnalyses.id, id));
        } else if (mode === "late-version-change") {
          await database
            .update(directChatAnalyses)
            .set({
              proposal: {
                title: "Pack a shipment",
                instructions: "Check the label first.",
              },
            })
            .where(eq(directChatAnalyses.id, id));
        } else if (mode === "late-legacy") {
          await database
            .update(directChatRuns)
            .set({ dispatchedSkillVersions: null })
            .where(
              and(
                eq(directChatRuns.id, runId),
                eq(directChatRuns.threadId, run.threadId),
              ),
            );
        } else if (!authorizedReceipt) {
          await revokeShare();
        }
      } else {
        expect(live).toContain("context_revoked");
        expect(live).not.toContain(
          native ? "Offline answer." : "Withheld managed answer.",
        );
      }
      if (late || mode === "managed-uncertain") {
        if (late) chat = mount();
        receiptReady = true;
        if (background) {
          const retryBackground = chat.runBackground;
          if (!retryBackground) throw new Error("Missing background runtime.");
          if (authorizedReceipt) {
            expect(await retryBackground(backgroundTurn)).toEqual({
              replyText: "Withheld managed answer.",
              shared: false,
            });
          } else {
            await expect(retryBackground(backgroundTurn)).rejects.toThrow(
              "The Bot Run failed",
            );
          }
        } else {
          expect(await (await reconcile()).json()).toEqual({
            externalOutcome: "executed",
            settlement: "settled",
          });
        }
      }
      const transcript = await (await history()).json();
      const replay = async (cursor: number) =>
        (
          await chat.request(`${route}/resume`, post({ ...run, cursor }))
        ).text();
      const replayed = await replay(0);
      const resumed = late ? await replay(2) : replayed;
      if (authorizedReceipt) {
        expect(JSON.stringify(transcript.messages)).toContain(
          "Withheld managed answer.",
        );
        expect(replayed).toContain("Withheld managed answer.");
        expect(resumed).toContain("Withheld managed answer.");
      } else {
        expect(JSON.stringify(transcript.messages)).not.toContain(
          "Withheld managed answer.",
        );
        expect(transcript.runs).toContainEqual(
          expect.objectContaining({
            id: runId,
            status: "failed",
            stopReason: "context_revoked",
            ...((late || mode === "managed-uncertain") && {
              externalOutcome: "executed",
            }),
          }),
        );
        expect(replayed).toContain("context_revoked");
        expect(resumed).toContain("context_revoked");
        expect(resumed).not.toContain("Withheld managed answer.");
        expect(replayed).not.toContain(
          native ? "Offline answer." : "Withheld managed answer.",
        );
        expect(replayed.includes("Safe partial.")).toBe(native);
        if (!background) {
          const repeated = await chat.request(`${route}/run`, request);
          const repeatedEvents = await repeated.text();
          expect(repeatedEvents).toContain("context_revoked");
          expect(repeatedEvents).not.toContain(
            native ? "Offline answer." : "Withheld managed answer.",
          );
        }
      }
      expect(dispatches).toBe(1);
    } finally {
      respond.resolve();
      await control.stop(true);
      if (writeLock) await runtimeDatabase.$client.close();
    }
    if (mode === "late-deleted") return;
    expect(
      (await aliceChat.request(`${detail}/shares`, share(bob.email))).status,
    ).toBe(200);

    await database.insert(revokedAccess).values({
      email: reviewer.email,
      revokedBy: "scim:directory",
    });
    try {
      expect((await bobChat.request(detail)).status).toBe(404);
      expect(await (await bobChat.request(catalog)).json()).toEqual({
        skills: [],
      });
      expect(await bobTurn("reviewer-revoked")).not.toContain(id);
    } finally {
      await database
        .delete(revokedAccess)
        .where(eq(revokedAccess.email, reviewer.email));
    }
    expect((await bobChat.request(detail)).status).toBe(200);
    await enterprise.setSetting("skillSharing", false, bob.id);
    expect((await bobChat.request(detail)).status).toBe(404);
    expect((await aliceChat.request(detail)).status).toBe(200);
    await enterprise.setSetting("skillSharing", true, bob.id);
    await profiles.update(alice, bot.id, {
      ...botDetails,
      visibility: "private",
    });
    expect((await bobChat.request(detail)).status).toBe(404);
    await profiles.update(alice, bot.id, {
      ...botDetails,
      visibility: "public",
    });
    expect(
      (
        await bobChat.request(permission, {
          ...post({ allowed: false }),
          method: "PUT",
        })
      ).status,
    ).toBe(200);
    expect((await bobChat.request(detail)).status).toBe(404);
    expect(await (await aliceChat.request(catalog)).json()).toEqual({
      skills: [],
    });
    expect(await bobTurn("withdrawn-shared-skill")).not.toContain(id);
    expect((await aliceChat.request(revoke, { method: "DELETE" })).status).toBe(
      200,
    );
  } finally {
    await enterprise.setSetting("skillSharing", previousSharing, bob.id);
    for (const id of channelIds)
      await database.delete(channels).where(eq(channels.id, id));
    for (const id of [bot.id, second.id])
      await database.delete(agents).where(eq(agents.id, id));
    for (const { id } of [alice, bob, outsider, reviewer])
      await database.delete(users).where(eq(users.id, id));
  }
}

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
  let pauseDuringAdmission = false;
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
        case "/v1/quote":
          return Response.json({
            route: "pilot-text-v1",
            priceVersion: trialPriceVersion,
          });
        case "/v1/reserve": {
          const reservation = await request.json();
          reservations.push(reservation);
          if (pauseDuringAdmission) {
            pauseDuringAdmission = false;
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
      credentials: new Map([[alice.id, "test-token"]]),
      route: "pilot-text-v1",
    },
  };
  let now = new Date();
  const learningClock = () => now;
  const runInputs: RunAgentInput[] = [];
  let loadedSkillVersions: RunContextVersion[] | undefined;
  const capture = async (input: RunAgentInput) => {
    runInputs.push(input);
    if (input.runId === "published-skill")
      loadedSkillVersions = runContextVersions();
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
    const mountedLearning = nativeLearningSettings(alice, aliceLearning);
    const listing = await mountedLearning.request(
      "/api/settings/learning/review",
    );
    expect(listing.status).toBe(200);
    const { conversations } = openBotPersonalReview.parse(await listing.json());
    expect(conversations).toEqual([
      expect.objectContaining({
        channelId,
        threadId: channel.threadId,
        botId: bot.id,
      }),
    ]);
    const [listed] = conversations;
    if (!listed) throw new Error("Expected the newly opened conversation.");
    const path = `/api/copilotkit/threads/${listed.threadId}/learn?agentId=${listed.botId}`;
    expect(await (await mountedLearning.request(path)).json()).toMatchObject({
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
    expect(
      (
        await mountedLearning.request(path, {
          ...post({}),
          headers: { ...post({}).headers, "sec-fetch-site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    const empty = await mountedLearning.request(path, post({}));
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
      mountedLearning.request(path, post({})),
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
    expect(await (await mountedLearning.request(path)).json()).toMatchObject({
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
      {
        operationId: expect.any(String),
        creditType: "test",
        route: "pilot-text-v1",
        priceVersion: trialPriceVersion,
        applicationId: "openbot",
        resumable: false,
      },
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
        await mountedLearning.request(
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
    expect((await mountedLearning.request(reviewPath, approve)).status).toBe(
      409,
    );
    expect((await admin.request("/settings", settings(true))).status).toBe(200);
    expect((await mountedLearning.request(reviewPath, approve)).status).toBe(
      200,
    );
    expect((await mountedLearning.request(reviewPath, approve)).status).toBe(
      200,
    );
    expect(await (await mountedLearning.request(path)).json()).toMatchObject({
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
    expect((await mountedLearning.request(path, post({}))).status).toBe(202);
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
      await mountedLearning.request(path, post({}))
    ).json();
    expect(oldAnalysis.lastResult).toEqual(skipped.latest);
    await dispatched.promise;
    expect((await admin.request("/settings", settings(false))).status).toBe(
      200,
    );
    expect((await mountedLearning.request(path, post({}))).status).toBe(409);
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
      await mountedLearning.request(path, post({}))
    ).json();
    expect(restarted.latest.id).not.toBe(oldAnalysis.latest.id);
    expect(restarted.lastResult).toEqual(afterPause.latest);
    const completed = await waitFor("proposed");
    expect(completed.proposals).toHaveLength(2);
    expect(completed.proposals[0]).toMatchObject({
      id: restarted.latest.id,
      evidence: [{ runId: "later-evidence" }],
    });
    const repeated = await (
      await mountedLearning.request(path, post({}))
    ).json();
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

      expect(loadedSkillVersions).toEqual([
        { kind: "learned_skill", id: proposal.id, version: expect.any(String) },
      ]);
      const current = aliceChat.learnedSkillVersionsCurrent;
      if (!current || !loadedSkillVersions)
        throw new Error("Expected the published skill version.");
      expect(
        await current(alice, channel.threadId, bot.id, loadedSkillVersions),
      ).toBe(true);
      pauseDuringAdmission = true;
      const afterPause = await managedDelivery("pause-during-admission");
      expect(
        await current(alice, channel.threadId, bot.id, loadedSkillVersions),
      ).toBe(false);
      expect(afterPause).not.toContain("List the steps in order.");
      expect(afterPause).not.toContain(auto.latest.id);
      expect(managedPrompts).toHaveLength(2);
      const replay = await aliceLearning.request(
        `/api/copilotkit/agent/${bot.id}/resume`,
        post({
          threadId: channel.threadId,
          runId: "pause-during-admission",
          cursor: 0,
        }),
      );
      const replayed = await replay.text();
      expect(replayed).toContain("Managed answer.");
      expect(replayed).toContain("pause-during-admission");
      expect(managedPrompts).toHaveLength(2);
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
          recordings: local,
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
      const listedRecordings = await recorderApp.request(
        "/api/recorder/recordings",
      );
      expect(listedRecordings.status).toBe(200);
      const saved = (await listedRecordings.json()).recordings;
      expect(saved).toMatchObject([
        { id: recordingId, title: "Pack a shipment", ended: "succeeded" },
      ]);
      const recording = { kind: "recording", id: saved[0].id };
      const recordingRequest = post({ evidence: [recording] });
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
      const beforeRecording = reservations.length;
      const mountedBob = nativeLearningSettings(bob, bobLearning);
      expect((await mountedBob.request(path, recordingRequest)).status).toBe(
        404,
      );
      expect((await mountedBob.request(bobPath, recordingRequest)).status).toBe(
        409,
      );
      expect(reservations).toHaveLength(beforeRecording);
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

      dispatched = Promise.withResolvers<void>();
      release = Promise.withResolvers<void>();
      reconciled = Promise.withResolvers<void>();
      const starts = await Promise.all([
        mountedLearning.request(path, recordingRequest),
        mountedLearning.request(path, recordingRequest),
      ]);
      expect(starts.map(({ status }) => status)).toEqual([202, 202]);
      const [first, retry] = await Promise.all(
        starts.map((response) => response.json()),
      );
      expect(first.latest).toMatchObject({
        state: "running",
        evidenceCount: 1,
      });
      expect(retry.latest).toEqual(first.latest);
      await dispatched.promise;
      expect(reservations.slice(beforeRecording)).toEqual([
        expect.objectContaining({
          creditType: "test",
          applicationId: "openbot",
        }),
      ]);
      release.resolve();
      await reconciled.promise;
      await waitFor("proposed");
      const recordedLearning = await (
        await mountedLearning.request(path)
      ).json();
      expect(recordedLearning.autoApprove).toBe(true);
      const recordingProposal = recordedLearning.proposals[0];
      expect(recordingProposal).toMatchObject({
        id: first.latest.id,
        state: "pending_review",
        review: null,
        evidence: [{ source: recording, excerpt: "click: Open packing list" }],
      });
      await database
        .insert(userRoles)
        .values({ userId: bob.id, role: "admin" });
      const adminLearning = web(
        database,
        { ...bob, role: "admin" },
        bot.id,
        async () => {},
        { deployment },
      );
      const operations = "/api/copilotkit/admin/learning";
      expect((await bobLearning.request(operations)).status).toBe(403);
      expect((await adminLearning.request(operations)).status).toBe(200);
      expect(await (await adminLearning.request(operations)).json()).toEqual({
        runs: [],
      });
      const adminDecision = (id: string) => `${operations}/proposals/${id}`;
      expect(
        (
          await adminLearning.request(
            adminDecision(recordingProposal.id),
            post({ decision: "approve" }),
          )
        ).status,
      ).toBe(404);

      expect(
        (await aliceLearning.request(path, post({ evidence: [conversation] })))
          .status,
      ).toBe(202);
      const sharedProposal = (await waitFor("proposed")).proposals[0];
      expect(await (await adminLearning.request(operations)).json()).toEqual({
        runs: [
          expect.objectContaining({
            id: sharedProposal.id,
            state: "proposed",
            proposal: expect.objectContaining({
              evidence: [
                {
                  source: conversation,
                  title: expect.any(String),
                  excerpt: "Bot: Check the shipping label.",
                },
              ],
            }),
          }),
        ],
      });
      expect(
        (
          await bobLearning.request(
            adminDecision(sharedProposal.id),
            post({ decision: "approve" }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await adminLearning.request(
            adminDecision(sharedProposal.id),
            post({
              decision: "approve",
              scope: { ...scope, personId: bob.id },
            }),
          )
        ).status,
      ).toBe(400);
      const botDetails = {
        name: bot.name,
        title: bot.title,
        roleDescription: bot.roleDescription,
      };
      await profiles.update(alice, bot.id, {
        ...botDetails,
        visibility: "private",
      });
      expect(await (await adminLearning.request(operations)).json()).toEqual({
        runs: [],
      });
      expect(
        (
          await adminLearning.request(
            adminDecision(sharedProposal.id),
            post({ decision: "approve" }),
          )
        ).status,
      ).toBe(404);
      await profiles.update(alice, bot.id, {
        ...botDetails,
        visibility: "public",
      });
      expect((await admin.request("/settings", settings(false))).status).toBe(
        200,
      );
      expect(
        (
          await adminLearning.request(
            adminDecision(sharedProposal.id),
            post({ decision: "approve" }),
          )
        ).status,
      ).toBe(409);
      expect((await admin.request("/settings", settings(true))).status).toBe(
        200,
      );
      await database
        .delete(userRoles)
        .where(and(eq(userRoles.userId, bob.id), eq(userRoles.role, "admin")));
      expect(
        (
          await adminLearning.request(
            adminDecision(sharedProposal.id),
            post({ decision: "approve" }),
          )
        ).status,
      ).toBe(404);
      await database
        .insert(userRoles)
        .values({ userId: bob.id, role: "admin" });
      expect(
        (
          await adminLearning.request(
            adminDecision(sharedProposal.id),
            post({ decision: "approve" }),
          )
        ).status,
      ).toBe(200);
      expect((await read()).proposals).toContainEqual(
        expect.objectContaining({
          id: sharedProposal.id,
          state: "published",
          review: expect.objectContaining({ reviewerId: bob.id, scope }),
        }),
      );
      expect(
        (await (await bobLearning.request(bobPath)).json()).proposals,
      ).toEqual([]);

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

      dispatched = Promise.withResolvers<void>();
      release = Promise.withResolvers<void>();
      reconciled = Promise.withResolvers<void>();
      const racing = await mountedLearning.request(path, recordingRequest);
      expect(racing.status).toBe(202);
      const { latest: inFlight } = await racing.json();
      await dispatched.promise;
      const remove = await recorderApp.request(
        `/api/recorder/recordings/${recordingId}`,
        { method: "DELETE" },
      );
      expect(remove.ok).toBe(true);
      expect(
        (await recorderApp.request(`/api/recorder/recordings/${recordingId}`))
          .status,
      ).toBe(404);
      release.resolve();
      await reconciled.promise;
      const withdrawn = await (await mountedLearning.request(path)).json();
      expect(withdrawn.latest).toMatchObject({
        id: inFlight.id,
        state: "cancelled",
        reason: "evidence_unavailable",
      });
      expect(
        withdrawn.proposals.map(({ id }: { id: string }) => id),
      ).not.toContain(inFlight.id);
      const afterDeletion = reservations.length;
      expect(
        (await mountedLearning.request(path, recordingRequest)).status,
      ).toBe(409);
      expect(reservations).toHaveLength(afterDeletion);
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
      expect(
        (
          await adminLearning.request(
            adminDecision(sharedProposal.id),
            post({ decision: "approve" }),
          )
        ).status,
      ).toBe(404);
      expect(await (await adminLearning.request(operations)).json()).toEqual({
        runs: [],
      });
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
  const runtimeBatch = crypto.randomUUID();
  const retryBatch = crypto.randomUUID();
  let now = Date.now();
  const ledger = createTestCreditLedger(database, () => new Date(now));
  const aliceIdentity = { issuer, subject: crypto.randomUUID() };
  const bobIdentity = { issuer, subject: crypto.randomUUID() };
  const harness = `agent-langgraph-agui@sha256:${"a".repeat(64)}`;
  const alternate = "conversation-alternate";
  const primaryConfig = {
    provider: "fixture",
    model: "text",
    gatewayRevision: "fixture-gateway",
    meteringRevision: "fixture-meter",
    maxInputTokens: 3,
    maxOutputTokens: 3,
    price: { inputPerMillion: 250_000, outputPerMillion: 250_000 },
    tools: false,
  };
  const alternateConfig = {
    ...primaryConfig,
    provider: "fixture-b",
    model: "alternate",
  };
  const draft = configure(emptyCatalog, {
    harnessImage: harness,
    routes: { [route]: primaryConfig, [alternate]: alternateConfig },
  });
  const proposed = draft.routes[route];
  const proposedAlternate = draft.routes[alternate];
  if (!proposed || !proposedAlternate)
    throw new Error("Fixture route missing.");
  const verified = verify(
    verify(draft, route, fixtureTraceReport(harness, proposed), "fixture"),
    alternate,
    fixtureTraceReport(harness, proposedAlternate),
    "fixture",
  );
  const { catalog } = publish(verified, [route, alternate], route, "fixture");
  const selectedPrimary = { id: route, revision: proposed.revision };
  const selectedAlternate = {
    id: alternate,
    revision: proposedAlternate.revision,
  };
  let onMeter: (() => Promise<void>) | undefined;
  let onDispatch: (() => Promise<void>) | undefined;
  const sentModels: string[] = [];
  const saveCatalog = async (value: ReturnType<typeof configure>) => {
    await database
      .update(enterpriseSettings)
      .set({ value })
      .where(eq(enterpriseSettings.key, pilotCatalogKey));
  };
  const operationIds: string[] = [];
  const meteredRequests = new Map<
    string,
    { body: string; operationId: string | null }
  >();
  let gatewayOutcome: "answer" | "unknown" | "partial" = "answer";
  let invalidProof = false;
  let lostRequest:
    | { id: string; metadata: Record<string, string | null> }
    | undefined;
  let storedLog: object | undefined;
  let evidenceReads = 0;
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
      await onMeter?.();
      return Response.json({
        gatewayRevision: "fixture-gateway",
        meteringRevision: "fixture-meter",
        inputTokenUpperBound: 1,
        requestId: invalidProof ? crypto.randomUUID() : requestId,
        requestSha256: Bun.CryptoHasher.hash("sha256", body, "hex"),
      });
    },
  });
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "GET") {
        expect(request.headers.get("authorization")).toBeNull();
        if (new URL(request.url).pathname !== `/api/logs/${lostRequest?.id}`)
          return new Response(null, { status: 404 });
        evidenceReads++;
        return storedLog
          ? Response.json(storedLog)
          : new Response(null, { status: 404 });
      }
      const operationId = request.headers.get("x-openbot-operation-id");
      if (!operationId) return new Response(null, { status: 400 });
      const body = await request.text();
      if (gatewayOutcome === "unknown") {
        const id = request.headers.get("x-request-id");
        if (!id) throw new Error("Missing gateway request ID.");
        lostRequest = {
          id,
          metadata: {
            "openbot-operation-id": operationId,
            "openbot-request-sha256": request.headers.get(
              "x-bf-lh-openbot-request-sha256",
            ),
            "openbot-route-proof": request.headers.get(
              "x-bf-lh-openbot-route-proof",
            ),
          },
        };
      }
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
      const payload = JSON.parse(body);
      sentModels.push(payload.model);
      expect(payload).toMatchObject({
        max_completion_tokens: 3,
        stream: false,
      });
      expect(JSON.parse(body)).not.toHaveProperty("max_tokens");
      operationIds.push(operationId);
      await onDispatch?.();
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
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createBifrostLogProxy({
      BIFROST_LOG_PROXY_UPSTREAM_ORIGIN: gateway.url.origin,
      TEST_CREDIT_BIFROST_LOG_TOKEN: "fixture-reader",
    }),
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
    const environment = {
      OPENBOT_TEST_CREDIT_CONVERSATIONS: "enabled",
      TEST_CREDIT_CASDOOR_ISSUER: issuer,
      TEST_CREDIT_CASDOOR_PROVIDER_ID: providerId,
      TEST_CREDIT_BIFROST_URL: gateway.url.href,
      TEST_CREDIT_BIFROST_LOG_ORIGIN: proxy.url.origin,
      TEST_CREDIT_BIFROST_LOG_TOKEN: "fixture-reader",
      TEST_CREDIT_BIFROST_TOKEN: "fixture-gateway",
      TEST_CREDIT_GATEWAY_REVISION: "fixture-gateway",
      TEST_CREDIT_GATEWAY_IMAGE_DIGEST: `sha256:${"d".repeat(64)}`,
      TEST_CREDIT_INPUT_METER_URL: meter.url.href,
      TEST_CREDIT_INPUT_METER_TOKEN: "fixture-meter",
      TEST_CREDIT_METERING_REVISION: "fixture-meter",
    };
    const settings = loadDirectChatTestCredit(environment);
    const readEvidence = loadBifrostEvidenceReader(environment);
    if (!readEvidence) throw new Error("Reader settings missing.");
    if (!settings) throw new Error("Fixture settings missing.");
    const testCredit = { ledger, ...settings };
    const aliceToken = crypto.randomUUID();
    const bobToken = crypto.randomUUID();
    const wrongSubjectToken = crypto.randomUUID();
    const authenticate = loadTestCreditRuntimeAuthentication(
      JSON.stringify([
        {
          personId: alice.id,
          subject: aliceIdentity.subject,
          token: aliceToken,
        },
        { personId: bob.id, subject: bobIdentity.subject, token: bobToken },
        {
          personId: alice.id,
          subject: bobIdentity.subject,
          token: wrongSubjectToken,
        },
      ]),
      createCasdoorBillingIdentity(database, settings.casdoor),
    );
    if (!authenticate) throw new Error("Fixture runtime credentials missing.");
    const runtime = { authenticate, execute: settings.execute };
    const opened = await Promise.all(
      [alice, alice, bob].map(async (actor) => {
        const bot = await profiles.create(actor, {
          name: "Billing fixture",
          title: "Bot",
          roleDescription: "Answers questions.",
          visibility: actor.id === bob.id ? "public" : "private",
        });
        bots.push(bot.id);
        const app = web(
          database,
          actor,
          bot.id,
          async () => {
            throw new Error("Unexpected legacy dispatch.");
          },
          { deployment, managed: { auth, testCredit, runtime } },
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
          models: (session = headers) =>
            app.request(
              `${path}/test-credit-model?threadId=${channel.threadId}`,
              { headers: session },
            ),
          saveModel: (
            scope: "bot" | "conversation",
            selection: object | null,
            session = headers,
          ) =>
            app.request(
              `${path}/test-credit-model${scope === "conversation" ? `?threadId=${channel.threadId}` : ""}`,
              {
                ...authenticatedPost({ selection }),
                method: "PUT",
                headers: { ...post({}).headers, ...session },
              },
            ),
          receipt: (id: string) =>
            app.request(`/api/billing/operations/${id}`, { headers }),
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
    const models = await first.models();
    expect(models.status).toBe(200);
    expect(await models.json()).toMatchObject({
      saved: null,
      source: "harness",
      quote: { route, model: "text" },
      options: expect.arrayContaining([
        { ...selectedPrimary, provider: "fixture", model: "text" },
        { ...selectedAlternate, provider: "fixture-b", model: "alternate" },
      ]),
    });
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
    if (!lostRequest) throw new Error("Missing lost gateway request.");
    storedLog = {
      id: lostRequest.id,
      metadata: lostRequest.metadata,
      object: "chat_completion",
      provider: "fixture",
      model: "text",
      status: "success",
      stop_reason: "stop",
      stream: false,
      parent_request_id: null,
      number_of_retries: 0,
      fallback_index: 0,
      token_usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
      output_message: {
        role: "assistant",
        content: "Recovered fixture result.",
      },
    };
    const goodLog = storedLog;
    now += 90_000;
    storedLog = { ...storedLog, model: "other-model" };
    await recoverBifrostEvidence(ledger, readEvidence);
    expect(await ledger.receipt(bobIdentity, unknown)).toMatchObject({
      state: "pending",
    });
    now += 300_000;
    storedLog = goodLog;
    await Promise.all([
      recoverBifrostEvidence(ledger, readEvidence),
      recoverBifrostEvidence(ledger, readEvidence),
    ]);
    await recover();
    expect(evidenceReads).toBe(2);
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
      amount: 20n,
    });
    await ledger.claim(bobIdentity, freshBatch);
    gatewayOutcome = "answer";
    invalidProof = true;
    expect(await (await other.run("bad-meter", confirmed)).text()).toContain(
      "route_unavailable",
    );
    expect(operationIds).toHaveLength(2);
    expect(await ledger.balance(bobIdentity)).toMatchObject({
      availableMicrocredits: "20",
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
    const late = await other.run("late-gateway-log", confirmed);
    expect(await late.text()).toContain('"state":"pending"');
    const lateOperation = operationIds.at(-1);
    if (!lateOperation || !lostRequest)
      throw new Error("Missing late gateway request.");
    const lateLog = {
      ...goodLog,
      id: lostRequest.id,
      metadata: lostRequest.metadata,
    };
    await expect(
      Promise.resolve(
        database
          .update(testCreditOperations)
          .set({ gatewayRequestId: lostRequest.id })
          .where(eq(testCreditOperations.id, unknown)),
      ),
    ).rejects.toThrow("Failed query");
    now += day;
    storedLog = lateLog;
    const balanceAtCutoff = await ledger.balance(bobIdentity);
    await recoverBifrostEvidence(ledger, readEvidence);
    await recoverBifrostEvidence(ledger, readEvidence);
    expect(await receiptOf(lateOperation)).toMatchObject({
      state: "released",
      outcome: "unknown",
      chargedMicrocredits: null,
      releasedMicrocredits: "2",
    });
    expect(await ledger.reconciliationCost(bobAccount, lateOperation)).toBe(
      "2",
    );
    expect(await ledger.balance(bobIdentity)).toEqual(balanceAtCutoff);
    expect(operationIds).toHaveLength(8);

    expect(sentModels).toEqual(Array.from({ length: 8 }, () => "fixture/text"));
    const beforeModelSelection = sentModels.length;
    gatewayOutcome = "answer";
    expect((await first.models(other.headers)).status).toBe(404);
    expect(
      (await other.saveModel("conversation", selectedAlternate, first.headers))
        .status,
    ).toBe(404);
    expect(
      (await other.saveModel("bot", selectedAlternate, first.headers)).status,
    ).toBe(403);
    expect(
      (
        await other.saveModel("bot", {
          ...selectedAlternate,
          revision: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(
      await (await other.saveModel("bot", selectedAlternate)).json(),
    ).toMatchObject({
      saved: selectedAlternate,
      source: "bot",
      quote: { route: alternate },
    });
    expect(await (await other.models()).json()).toMatchObject({
      saved: null,
      source: "bot",
      quote: { route: alternate },
    });
    const botQuote = await (await other.quote()).json();
    expect(botQuote).toMatchObject({ route: alternate });
    const send = async (
      id: string,
      quote: { route: string; priceVersion: string },
    ) =>
      (
        await other.run(id, {
          route: quote.route,
          priceVersion: quote.priceVersion,
        })
      ).text();
    expect(await send("bot-default", botQuote)).toContain("Fixture answer.");
    expect(sentModels.at(-1)).toBe("fixture-b/alternate");

    expect(
      await (await other.saveModel("conversation", selectedPrimary)).json(),
    ).toMatchObject({
      saved: selectedPrimary,
      source: "conversation",
      quote: { route },
    });
    expect(await send("old-bot-quote", botQuote)).toContain("price changed");
    expect(sentModels).toHaveLength(beforeModelSelection + 1);
    const overrideQuote = await (await other.quote()).json();
    expect(overrideQuote).toMatchObject({ route });
    const nextPrice = {
      inputPerMillion: 1_000_000,
      outputPerMillion: 1_000_000,
    };
    const repriced = publish(
      configure(verified, {
        harnessImage: harness,
        routes: {
          [route]: { ...primaryConfig, price: nextPrice },
          [alternate]: alternateConfig,
        },
      }),
      [route, alternate],
      route,
      "fixture",
    );
    onDispatch = () => saveCatalog(repriced.catalog);
    expect(await send("conversation-override", overrideQuote)).toContain(
      "Fixture answer.",
    );
    onDispatch = undefined;
    expect(sentModels.at(-1)).toBe("fixture/text");
    const original = operationIds.at(-1);
    if (!original) throw new Error("Missing original operation.");
    const newQuote = await (await other.quote()).json();
    expect(newQuote).toMatchObject({
      route,
      priceVersion: repriced.release.id,
      price: nextPrice,
      maxChargeMicrocredits: "6",
    });
    const countBeforeReplay = sentModels.length;
    expect(
      await (
        await other.run("conversation-override", undefined, "after-reprice")
      ).text(),
    ).toContain("Fixture answer.");
    expect(sentModels).toHaveLength(countBeforeReplay);
    expect(await send("new-price", newQuote)).toContain("Fixture answer.");
    const newOperation = operationIds.at(-1);
    if (!newOperation) throw new Error("Missing repriced operation.");
    expect(await (await other.receipt(newOperation)).json()).toMatchObject({
      priceVersion: repriced.release.id,
      price: nextPrice,
      reservedMicrocredits: "6",
      chargedMicrocredits: "2",
    });
    expect(await (await other.receipt(original)).json()).toMatchObject({
      priceVersion: overrideQuote.priceVersion,
      price: primaryConfig.price,
      reservedMicrocredits: "2",
      chargedMicrocredits: "1",
    });

    const revoked = configure(repriced.catalog, {
      harnessImage: harness,
      routes: { [alternate]: alternateConfig },
    });
    const beforeRevocation = await ledger.balance(bobIdentity);
    expect(beforeRevocation).toBeDefined();
    let unsent: string | undefined;
    onMeter = async () => {
      unsent = [...meteredRequests.values()].at(-1)?.operationId ?? undefined;
      await saveCatalog(revoked);
    };
    expect(await send("revoked-before-send", newQuote)).toContain(
      "route_unavailable",
    );
    onMeter = undefined;
    if (!unsent) throw new Error("Missing unsent operation.");
    expect(await (await other.receipt(unsent)).json()).toMatchObject({
      state: "released",
      dispatchedAt: null,
      heldMicrocredits: "0",
      releasedMicrocredits: "6",
    });
    expect(await ledger.balance(bobIdentity)).toEqual(beforeRevocation);
    expect(await (await other.models()).json()).toMatchObject({
      saved: selectedPrimary,
      source: "conversation",
      reason: expect.stringContaining("Saved Conversation override"),
    });
    expect(await (await other.quote()).json()).toMatchObject({
      error: expect.stringContaining("Choose another verified model"),
    });
    expect(await send("stale-override", newQuote)).toContain(
      "Saved Conversation override",
    );
    expect(sentModels).toHaveLength(beforeModelSelection + 3);
    expect(
      await (await other.saveModel("conversation", null)).json(),
    ).toMatchObject({
      saved: null,
      source: "bot",
      quote: { route: alternate },
    });
    const reselected = await (await other.quote()).json();
    expect(await send("after-reselection", reselected)).toContain(
      "Fixture answer.",
    );
    expect(sentModels.slice(beforeModelSelection)).toEqual([
      "fixture-b/alternate",
      "fixture/text",
      "fixture/text",
      "fixture-b/alternate",
    ]);

    // The Conversation session and the Worker bearer both resolve to Alice's
    // ledger account. Fund one maximum reservation and race the two entry points.
    await saveCatalog(catalog);
    await ledger.enroll({
      identity: aliceIdentity,
      batchId: runtimeBatch,
      amount: 1n,
    });
    await ledger.claim(aliceIdentity, runtimeBatch);
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    const runtimePath = "/api/billing/v1/";
    expect(
      (
        await first.app.request(`${runtimePath}quote`, {
          headers: bearer(wrongSubjectToken),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await first.app.request("/api/billing/balance", {
          headers: bearer(aliceToken),
        })
      ).status,
    ).toBe(401);
    const runtimeQuote = await first.app.request(`${runtimePath}quote`, {
      headers: bearer(aliceToken),
    });
    expect(runtimeQuote.status).toBe(200);
    expect(await runtimeQuote.json()).toMatchObject(confirmed);

    let dropDispatch = false;
    const relay = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const response = await first.app.fetch(request);
        if (
          dropDispatch &&
          new URL(request.url).pathname === `${runtimePath}dispatch`
        ) {
          dropDispatch = false;
          await response.body?.cancel();
          return new Response(null, { status: 502 });
        }
        return response;
      },
    });
    try {
      const worker = createManagedModel({
        url: new URL("/api/billing/", relay.url),
        executionHeaders: async () => bearer(aliceToken),
      });
      const job = {
        scope: {
          source: "learning" as const,
          personId: alice.id,
          conversationId: crypto.randomUUID(),
          runId: crypto.randomUUID(),
          botId: crypto.randomUUID(),
        },
        step: "direct-chat-proposal",
        ...confirmed,
        messages: [
          { role: "user" as const, content: "Worker fixture prompt." },
        ],
      };
      const beforeRace = operationIds.length;
      const [conversation, workerResult] = await Promise.all([
        sendForRace(),
        worker.complete(job),
      ]);
      async function sendForRace() {
        return (await first.run("runtime-balance-race", confirmed)).text();
      }
      expect(
        [
          conversation.includes("Fixture answer."),
          workerResult.state === "completed",
        ].filter(Boolean),
      ).toHaveLength(1);
      expect(
        [
          conversation.includes("insufficient_credits"),
          workerResult.state === "insufficient_credits",
        ].filter(Boolean),
      ).toHaveLength(1);
      expect(operationIds).toHaveLength(beforeRace + 1);
      expect(await ledger.balance(aliceIdentity)).toMatchObject({
        availableMicrocredits: "1",
        reservedMicrocredits: "0",
        chargedMicrocredits: "2",
      });

      await ledger.enroll({
        identity: aliceIdentity,
        batchId: retryBatch,
        amount: 1n,
      });
      await ledger.claim(aliceIdentity, retryBatch);
      const lost = {
        ...job,
        scope: { ...job.scope, runId: crypto.randomUUID() },
      };
      dropDispatch = true;
      expect(await worker.complete(lost)).toEqual({ state: "reconciling" });
      expect(await worker.reconcile(lost)).toBe("settled");
      expect(await worker.complete(lost)).toEqual({ state: "settled" });
      expect(operationIds).toHaveLength(beforeRace + 2);
      expect(
        await ledger.receipt(aliceIdentity, operationId(lost)),
      ).toMatchObject({
        state: "settled",
        chargedMicrocredits: "1",
        resultText: "Fixture answer.",
      });
      expect(await ledger.balance(aliceIdentity)).toMatchObject({
        availableMicrocredits: "1",
        chargedMicrocredits: "3",
        reservedMicrocredits: "0",
      });
      const response = await first.app.request(`${runtimePath}reconcile`, {
        ...post({ operationId: operationId(lost) }),
        headers: { ...post({}).headers, ...bearer(bobToken) },
      });
      expect(await response.json()).toEqual({ state: "absent" });
    } finally {
      await relay.stop(true);
    }

    await database
      .delete(testCreditEnrollments)
      .where(eq(testCreditEnrollments.batchId, freshBatch));
    await database
      .delete(testCreditBatches)
      .where(eq(testCreditBatches.id, freshBatch));
  } finally {
    await proxy.stop(true);
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
      .where(
        inArray(testCreditBatches.id, [batchId, runtimeBatch, retryBatch]),
      );
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
