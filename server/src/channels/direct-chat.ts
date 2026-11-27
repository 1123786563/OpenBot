import { createHash } from "node:crypto";
import type { AbstractAgent, BaseEvent, RunAgentInput } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { OUTCOME_UNKNOWN } from "@openbot/shared/approval-outcomes";
import {
  adminLearningDecision,
  type DirectChatLearningScope,
  type DirectChatReview,
  directChatAutoApproval,
  directChatDecision,
  learningEvidencePermission,
  learningRequest,
  learningScheduleSettings,
  publishedSkillShare,
} from "@openbot/shared/direct-chat-learning";
import { DIRECT_CHAT_REPLAY_HEADER } from "@openbot/shared/direct-chat-replay";
import { answerMessageId } from "@openbot/shared/handoff-markers";
import type { MarketSkillSnapshot } from "@openbot/toolkit/continuation";
import {
  type HeadlessTool,
  HeadlessToolsMiddleware,
} from "@openbot/toolkit/headless-tools";
import {
  CONTEXT_REVOKED,
  CONTEXT_REVOKED_MESSAGE,
  createRunContext,
  type RunContextVersion,
  runContextVersion,
  trackRunContext,
  verifyRunContext,
  withRunContext,
} from "@openbot/toolkit/run-context";
import {
  type TurnRunner,
  turnInput,
  turnMessages,
} from "@openbot/toolkit/run-turn";
import { and, eq, exists, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { headlessTurnRefusal } from "../admin/controls";
import { readSkillSharingAllowed } from "../admin/settings-store";
import { isBotPaused } from "../agents/lifecycle";
import { canManageAgent } from "../agents/profile-policy";
import type {
  AgentProfileStore,
  ProfileReadExecutor,
} from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import {
  type ApprovalAction,
  parseApprovalContinuation,
} from "../approvals/types";
import { type AuditInitiator, PERSON_INITIATOR } from "../audit";
import { DEV_ACTOR } from "../auth/dev-actor";
import { createRoleRepository } from "../auth/guards";
import type { BackgroundModelWaiting } from "../billing/background-model";
import {
  type DirectChatTestCredit,
  testCreditConfirmation,
} from "../billing/direct-chat-test-credit";
import type { IdentifyActor } from "../copilot";
import type { Database } from "../db/client";
import {
  agents,
  approvalRequests,
  channelAgents,
  channelMemberships,
  channels,
  directChatRuns,
  groupBotThreads,
  groupMessages,
  intelligenceChannelMappings,
  revokedAccess,
  routineRuns,
  routines,
  userRoles,
  users,
} from "../db/schema";
import { currentEdition } from "../edition";
import {
  createDirectChatLearning,
  LearningEvidenceUnavailable,
  lockLearningSettings,
} from "../learning/direct-chat";
import { setSharedLearningPermission } from "../learning/evidence";
import { operationId } from "../managed-model";
import type { ManagedModel, ManagedModelResult } from "../managed-model-trial";
import { runFeedback, saveRunFeedback } from "../opik/feedback";
import { marketRunPauseReason } from "../skill-market/disablements";
import { reflectCommand } from "./direct-chat-command";

import {
  appendDirectChatEvent,
  appendDirectChatEventInTransaction,
  backgroundMessageId,
  directChatRunTimeoutMs,
  expireDirectChatRuns,
  directChatHistory as history,
  isBackgroundMessage,
  matchingRun,
  messagesFor,
  pendingRunApprovals,
  type RunKey,
  readDirectChatReplay,
  stopDirectChatRun,
  stoppedRunEvent,
} from "./direct-chat-replay";

type RunTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const dispatchedVersions = z.array(
  runContextVersion.extend({ kind: z.literal("learned_skill") }),
);

import {
  botTestCreditModel,
  conversationTestCreditModels,
  testCreditModelSelection,
  writeTestCreditModel,
} from "./test-credit-model-choice";

const id = z.string().min(1).max(256);
const runBody = z.object({
  threadId: id,
  runId: id,
  messages: z.array(z.unknown()).min(1),
  forwardedProps: z
    .object({
      testCreditQuote: z.unknown().optional(),
      rerunOfMessageId: id.optional(),
    })
    .nullish(),
});
const promptMessage = z.object({
  id,
  role: z.literal("user"),
  content: z.string().min(1).max(1_000_000),
});
const joinBody = z.object({ threadId: id });
const resumeBody = joinBody.extend({
  runId: id,
  cursor: z.number().int().min(0).max(2_147_483_647),
});
const managedRunError: Record<
  Exclude<ManagedModelResult["state"], "completed">,
  string
> = {
  insufficient_credits: "This account does not have enough Test Credits.",
  execution_limit: "This run reached its Test Credit limit.",
  not_authorized:
    "This account is not authorized to spend Test Credits on this run.",
  route_unavailable: "This model route is unavailable.",
  pilot_closed: "The billing pilot has closed.",
  trial_ended: "The Test Credit trial has ended.",
  reconciling: "The model outcome is being reconciled.",
  unavailable: "Test Credit admission is temporarily unavailable.",
  settled: "The previous model call settled, but its reply is unavailable.",
  released: "The previous model call ended and its reservation was released.",
};

const workerKey = ({ threadId, runId }: RunKey) =>
  JSON.stringify([threadId, runId]);

export type DirectChatReflect = (input: {
  query: string;
  personId: string;
  botId: string;
  conversationId: string;
  runId: string;
  canContinue: () => Promise<boolean>;
}) => Promise<string>;

export type BackgroundTurn = {
  id: string;
  threadId: string;
  conversationBotId: string;
  personId: string;
  agentId: string;
  prompt: string;
  shown?: string;
  signal?: AbortSignal;
  beforeDispatch?: () => Promise<void>;
  metered?: {
    agent: AbstractAgent;
    failure: () => BackgroundModelWaiting | undefined;
  };
  authorize: () => Promise<AgentActor | null>;
  initiator: AuditInitiator;
} & (
  | { source: "routine"; literalAnswer?: never; handoffFromBotId?: never }
  | {
      source: "group";
      groupRowId: string;
      depth?: number;
      skill?: string;
      literalAnswer?: never;
      handoffFromBotId?: never;
    }
  // A forwarded message (delivery) is not remapped to a group thread and its reply is not
  // published to one, the two things `source === "routine"` switches on below.
  | { source: "delivery"; literalAnswer?: never; handoffFromBotId?: never }
  /*
   * A hop carries the signed statement of the Run it starts, which says how deep the chain has
   * gone and that this Run is a delivery's. A relay — the variant that carries an answer — runs no
   * model and ignores it, but every delivery is signed one.
   */
  | {
      source: "handoff";
      literalAnswer?: never;
      handoffFromBotId: string;
      assertion: string;
    }
  | {
      source: "handoff";
      literalAnswer?: { botId: string; text: string };
      handoffFromBotId?: never;
      assertion: string;
    }
);

export class BackgroundConversationBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackgroundConversationBusy";
  }
}

function backgroundRefusal(message: string) {
  const error = new Error(message);
  error.name = "CapabilityRefusedError";
  return error;
}

type Emit = (event: BaseEvent, cursor?: number) => void;

function creditReceiptEvent(
  run: typeof directChatRuns.$inferSelect,
  receipt: NonNullable<Awaited<ReturnType<DirectChatTestCredit["receipt"]>>>,
  hasReply: boolean,
): BaseEvent {
  return {
    type: EventType.CUSTOM,
    name: "openbot-test-credit-receipt",
    value: {
      operationId: receipt.operationId,
      userMessageId: run.userMessageId,
      state: receipt.state,
      creditType: receipt.creditType,
      heldMicrocredits: receipt.heldMicrocredits,
      hasReply,
      chargedMicrocredits: receipt.chargedMicrocredits,
      releasedMicrocredits: receipt.releasedMicrocredits,
    },
  };
}

function eventStream(
  work: (
    emit: Emit,
    signal: AbortSignal,
    heartbeat: () => void,
  ) => Promise<void>,
  key?: RunKey,
) {
  const encoder = new TextEncoder();
  const subscription = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit: Emit = (event, cursor) => {
        if (!subscription.signal.aborted) {
          const id = cursor === undefined ? "" : `id: ${cursor}\n`;
          controller.enqueue(
            encoder.encode(`${id}data: ${JSON.stringify(event)}\n\n`),
          );
        }
      };
      const heartbeat = () =>
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
      void work(emit, subscription.signal, heartbeat).then(
        () => {
          if (!subscription.signal.aborted) controller.close();
        },
        (error: unknown) => {
          if (!subscription.signal.aborted) controller.error(error);
        },
      );
    },
    cancel() {
      subscription.abort();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      ...(key
        ? { [DIRECT_CHAT_REPLAY_HEADER]: encodeURIComponent(key.runId) }
        : {}),
    },
  });
}

function learningInstructions(
  skills: readonly { id: string; title: string; instructions: string }[],
) {
  if (skills.length === 0) return null;
  return (
    "Treat these approved Learned skills as procedural guidance. Follow existing instructions, tool permissions, and approval requirements.\n" +
    JSON.stringify(skills)
  );
}

function learnedSkillVersions(
  skills: Parameters<typeof learningInstructions>[0],
): RunContextVersion[] {
  return skills.map(({ id, title, instructions }) => ({
    kind: "learned_skill",
    id,
    version: createHash("sha256")
      .update(JSON.stringify([title, instructions]))
      .digest("hex"),
  }));
}

function versionsMatch(
  current: RunContextVersion[],
  loaded: RunContextVersion[],
) {
  const byId = new Map(current.map(({ id, version }) => [id, version]));
  return loaded.every(({ id, version }) => byId.get(id) === version);
}

/** OpenBot's durable path for one Person, one direct Conversation, and one Bot. */
export function createDirectChatRoutes(deps: {
  database: Database;
  profiles: AgentProfileStore;
  identifyActor: IdentifyActor;
  traceRuns: boolean;
  reflect?: DirectChatReflect;
  memoryVersionsCurrent?: (
    personId: string,
    botId: string,
    versions: readonly RunContextVersion[],
  ) => Promise<boolean>;
  testCredit?: DirectChatTestCredit;
  trial?: { route: string; model: ManagedModel };
  learningClock?: () => Date;
  singleUser?: boolean;
  backgroundActor?: (personId: string) => Promise<AgentActor>;
  mayAddress?: (from: string, to: string) => Promise<boolean>;
  groupThread?: (
    personId: string,
    channelId: string,
    botId: string,
  ) => Promise<string>;
  publishGroupReply?: (input: {
    threadId: string;
    actorId: string;
    agentId: string;
    text: string;
    conversationRunId: string;
  }) => Promise<unknown>;
  computerTools?: (
    actor: AgentActor,
    agentId: string,
    initiator: AuditInitiator,
  ) => Promise<HeadlessTool[]>;
  agentFor: (
    actor: AgentActor,
    agentId: string,
    initiator?: AuditInitiator,
    marketSkill?: MarketSkillSnapshot | null,
    depth?: number,
  ) => Promise<AbstractAgent | null>;
}) {
  const { database, profiles, traceRuns, testCredit } = deps;
  const routes = new Hono();
  const workers = new Map<string, AbortController>();

  const mapping = intelligenceChannelMappings;
  const additionalAgents = alias(channelAgents, "additional_agents");

  // Use the same membership and thread constraints for discovery and route authorization.
  function directThreadQuery(
    executor: ProfileReadExecutor,
    personId: string,
    threadId?: string,
    botId?: string,
  ) {
    const otherAgent = executor
      .select({ id: additionalAgents.agentId })
      .from(additionalAgents)
      .where(
        and(
          eq(additionalAgents.channelId, mapping.channelId),
          ne(additionalAgents.agentId, channelAgents.agentId),
        ),
      );
    const otherMember = executor
      .select({ id: channelMemberships.userId })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, mapping.channelId),
          ne(channelMemberships.userId, personId),
        ),
      );
    const group = executor
      .select({ id: groupBotThreads.channelId })
      .from(groupBotThreads)
      .where(eq(groupBotThreads.channelId, mapping.channelId));
    return executor
      .select({
        channelId: mapping.channelId,
        threadId: mapping.threadId,
        botId: channelAgents.agentId,
        title: sql<string>`coalesce(${channels.title}, ${channels.summary}, ${channels.opening}, ${channels.name})`,
      })
      .from(mapping)
      .innerJoin(channels, eq(channels.id, mapping.channelId))
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.userId, personId),
        ),
      )
      .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
      .where(
        and(
          eq(mapping.userId, personId),
          threadId === undefined ? undefined : eq(mapping.threadId, threadId),
          botId === undefined ? undefined : eq(channelAgents.agentId, botId),
          isNull(channels.deletedAt),
          notExists(otherAgent),
          notExists(otherMember),
          notExists(group),
        ),
      );
  }

  async function threadFor(
    executor: ProfileReadExecutor,
    actor: AgentActor,
    threadId: string,
    agentId: string,
    lock = false,
  ) {
    if (!actor.id) return null;
    const query = directThreadQuery(executor, actor.id, threadId, agentId);
    const [row] = lock
      ? await query.for("update", { of: [channels, mapping] })
      : await query;
    if (!row) return null;
    const profile = await profiles.getWithin(executor, actor, agentId);
    return profile && !profile.deletedAt && !profile.hidden
      ? { channelId: row.channelId, botName: profile.name }
      : null;
  }

  async function learningConversations(actor: AgentActor) {
    if (!actor.id) return [];
    const [rows, profilesForActor] = await Promise.all([
      directThreadQuery(database, actor.id).orderBy(
        sql`coalesce(${channels.lastMessageAt}, ${channels.createdAt}) desc`,
        channels.id,
      ),
      profiles.list(actor),
    ]);
    const botNames = new Map(
      profilesForActor.map(({ id, name }) => [id, name]),
    );
    return rows.flatMap((row) => {
      const botName = botNames.get(row.botId);
      return botName === undefined ? [] : [{ ...row, botName }];
    });
  }

  async function groupThreadFor(
    executor: ProfileReadExecutor,
    actor: AgentActor,
    threadId: string,
    agentId: string,
    lock = false,
  ) {
    const query = executor
      .select({ channelId: channels.id })
      .from(groupBotThreads)
      .innerJoin(channels, eq(channels.id, groupBotThreads.channelId))
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.userId, actor.id),
        ),
      )
      .innerJoin(
        channelAgents,
        and(
          eq(channelAgents.channelId, channels.id),
          eq(channelAgents.agentId, agentId),
        ),
      )
      .where(
        and(
          eq(groupBotThreads.threadId, threadId),
          eq(groupBotThreads.ownerUserId, actor.id),
          eq(groupBotThreads.agentId, agentId),
          isNull(channels.deletedAt),
        ),
      );
    const [row] = lock
      ? await query.for("update", { of: [channels, groupBotThreads] })
      : await query;
    if (!row) return null;
    const profile = await profiles.getWithin(executor, actor, agentId);
    return profile && !profile.deletedAt && !profile.hidden ? row : null;
  }

  /** The Bot whose conversation a thread is, by its group row or its direct channel's agent. */
  async function conversationBotFor(
    executor: ProfileReadExecutor,
    threadId: string,
  ) {
    const [group] = await executor
      .select({ agentId: groupBotThreads.agentId })
      .from(groupBotThreads)
      .where(eq(groupBotThreads.threadId, threadId))
      .limit(1);
    if (group) return group.agentId;
    const [mapped] = await executor
      .select({ channelId: intelligenceChannelMappings.channelId })
      .from(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.threadId, threadId))
      .limit(1);
    if (!mapped) return undefined;
    const [agent] = await executor
      .select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .where(eq(channelAgents.channelId, mapped.channelId))
      .limit(1);
    return agent?.agentId;
  }

  async function runThreadFor(
    executor: ProfileReadExecutor,
    actor: AgentActor,
    threadId: string,
    botId: string,
    lock = false,
  ) {
    if (await groupThreadFor(executor, actor, threadId, botId, lock))
      return "group";
    return (await threadFor(executor, actor, threadId, botId, lock))
      ? "direct"
      : null;
  }

  const actorFor = (request: Request) =>
    deps.identifyActor(request).catch(() => null);
  const absent = { error: "Conversation not found." };

  const learning = createDirectChatLearning(
    database,
    deps.trial,
    deps.learningClock,
  );
  const learningScope = (
    threadId: string,
    agentId: string,
    personId: string,
  ) => ({
    threadId,
    botId: agentId,
    personId,
  });
  function learningAuthorization(
    request: Request,
    threadId: string,
    agentId: string,
    personId: string,
  ) {
    return async () => {
      const actor = await actorFor(request);
      return (tx: ProfileReadExecutor) =>
        actor?.id === personId
          ? threadFor(tx, actor, threadId, agentId, true)
          : Promise.resolve(null);
    };
  }
  const sameOriginJson = (request: Request) =>
    request.headers.get("sec-fetch-site") !== "cross-site" &&
    request.headers.get("content-type")?.split(";")[0]?.trim() ===
      "application/json";

  const skillPolicy = {
    async authorize(tx: ProfileReadExecutor, scope: DirectChatLearningScope) {
      if (!(await accountIsActive(tx, scope.personId))) return null;
      if (!deps.singleUser) {
        const roles = await createRoleRepository(tx).rolesForUser(
          scope.personId,
        );
        if (!roles.includes("admin") && !roles.includes("user")) return null;
      }
      // Publication grants follow the Person's Bot access, including for administrators.
      const owner = { id: scope.personId, role: "user" } satisfies AgentActor;
      return threadFor(tx, owner, scope.threadId, scope.botId);
    },
    enabled: readSkillSharingAllowed,
    async reviewerMayShare(tx: ProfileReadExecutor, review: DirectChatReview) {
      if (currentEdition() === "personal") return true;
      return (
        review.mode === "manual" &&
        (await accountIsActive(tx, review.reviewerId)) &&
        (
          await createRoleRepository(tx).rolesForUser(review.reviewerId)
        ).includes("admin")
      );
    },
  };
  const skillPath = "/learning/skills";
  const skillAbsent = { error: "Published skill not found." };

  routes.get(skillPath, async (context) => {
    context.header("Cache-Control", "no-store");
    const actor = await actorFor(context.req.raw);
    if (!actor?.id)
      return context.json({ error: "Sign in to view skills." }, 401);
    const { skills } = await learning.catalog(actor.id, skillPolicy);
    return context.json({ skills });
  });

  routes.get(`${skillPath}/:id`, async (context) => {
    context.header("Cache-Control", "no-store");
    const actor = await actorFor(context.req.raw);
    const id = z.uuid().safeParse(context.req.param("id"));
    if (!actor?.id || !id.success) return context.json(skillAbsent, 404);
    const { detail } = await learning.catalog(actor.id, skillPolicy, id.data);
    return detail ? context.json(detail) : context.json(skillAbsent, 404);
  });

  routes.post(
    `${skillPath}/:id/shares`,
    bodyLimit({ maxSize: 2048 }),
    async (context) => {
      const request = context.req.raw;
      const actor = await actorFor(request);
      const id = z.uuid().safeParse(context.req.param("id"));
      if (!actor?.id || !id.success) return context.json(skillAbsent, 404);
      if (!sameOriginJson(request))
        return context.json({ error: "Use a same-origin JSON request." }, 403);
      const input = publishedSkillShare.safeParse(
        await request.json().catch(() => null),
      );
      if (!input.success)
        return context.json({ error: "Enter a valid email address." }, 400);
      const shared = await learning.shareSkill(
        actor.id,
        id.data,
        skillPolicy,
        async (tx, botId) => {
          const recipients = await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(sql`lower(trim(${users.email}))`, input.data.email))
            .limit(2);
          const [recipient] = recipients;
          if (
            recipients.length !== 1 ||
            !recipient ||
            recipient.id === actor.id
          )
            return null;
          const threads = await directThreadQuery(
            tx,
            recipient.id,
            undefined,
            botId,
          ).limit(2);
          const [thread] = threads;
          return threads.length === 1 && thread
            ? learningScope(thread.threadId, botId, recipient.id)
            : null;
        },
      );
      return shared
        ? context.json({ ok: true })
        : context.json(
            { error: "This skill or recipient is unavailable for sharing." },
            404,
          );
    },
  );

  routes.delete(`${skillPath}/:id/shares/:recipientId`, async (context) => {
    const request = context.req.raw;
    if (request.headers.get("sec-fetch-site") === "cross-site")
      return context.json({ error: "Use a same-origin request." }, 403);
    const actor = await actorFor(request);
    const id = z.uuid().safeParse(context.req.param("id"));
    if (
      !actor?.id ||
      !id.success ||
      !(await accountIsActive(database, actor.id))
    )
      return context.json(skillAbsent, 404);
    const removed = await learning.revokeSkillShare(
      actor.id,
      id.data,
      context.req.param("recipientId"),
    );
    return removed
      ? context.json({ ok: true })
      : context.json(skillAbsent, 404);
  });

  function authorizeAdminLearning(reviewerId: string) {
    return async (tx: ProfileReadExecutor, scope: DirectChatLearningScope) => {
      if (!(deps.singleUser && reviewerId === DEV_ACTOR.id)) {
        const [admin] = await tx
          .select({ role: userRoles.role })
          .from(userRoles)
          .where(
            and(eq(userRoles.userId, reviewerId), eq(userRoles.role, "admin")),
          )
          .for("share");
        if (!admin) return false;
      }
      if (!(await accountIsActive(tx, scope.personId))) return false;
      if (scope.personId !== reviewerId) {
        const roles = await createRoleRepository(tx).rolesForUser(
          scope.personId,
        );
        if (!roles.includes("admin") && !roles.includes("user")) return false;
        if (!(await accountIsActive(tx, reviewerId))) return false;
      }
      // The admin role grants access to the queue. Bot access still follows each person’s grants.
      const owner = { id: scope.personId, role: "user" } satisfies AgentActor;
      if (!(await threadFor(tx, owner, scope.threadId, scope.botId, true)))
        return false;
      if (scope.personId === reviewerId) return true;
      const reviewer = { id: reviewerId, role: "user" } satisfies AgentActor;
      const profile = await profiles.getWithin(tx, reviewer, scope.botId);
      return Boolean(profile && !profile.deletedAt && !profile.hidden);
    };
  }

  routes.get("/admin/learning", async (context) => {
    const actor = await actorFor(context.req.raw);
    if (!actor?.id || actor.role !== "admin")
      return context.json({ error: "Only an admin can do this." }, 403);
    context.header("Cache-Control", "no-store");
    return context.json(
      await learning.adminHistory(actor.id, authorizeAdminLearning(actor.id)),
    );
  });

  routes.post("/admin/learning/proposals/:proposalId", async (context) => {
    const request = context.req.raw;
    if (!sameOriginJson(request))
      return context.json({ error: "Use a same-origin JSON request." }, 403);
    const actor = await actorFor(request);
    if (!actor?.id || actor.role !== "admin")
      return context.json({ error: "Only an admin can do this." }, 403);
    const { proposalId } = context.req.param();
    if (!z.uuid().safeParse(proposalId).success)
      return context.json({ error: "Proposal not found." }, 404);
    const body = adminLearningDecision.safeParse(
      await request.json().catch(() => null),
    );
    if (!body.success)
      return context.json(
        { error: "Choose whether to approve or reject the proposal." },
        400,
      );
    const outcome = await learning.adminDecide(
      actor.id,
      authorizeAdminLearning(actor.id),
      proposalId,
      body.data.decision,
    );
    switch (outcome) {
      case "saved":
        return context.json({ ok: true });
      case "absent":
        return context.json({ error: "Proposal not found." }, 404);
      case "already_reviewed":
        return context.json(
          { error: "This proposal was already reviewed." },
          409,
        );
      case "learning_disabled":
        return context.json({ error: "Learning is disabled." }, 409);
    }
  });

  routes.get("/conversations/:channelId/learning-evidence", async (context) => {
    const actor = await actorFor(context.req.raw);
    if (!actor) return context.json(absent, 404);
    const channelId = context.req.param("channelId");
    const [membership] = await database
      .select({ allowed: channelMemberships.learningEvidenceAllowed })
      .from(channelMemberships)
      .innerJoin(channels, eq(channels.id, channelMemberships.channelId))
      .where(
        and(
          eq(channels.id, channelId),
          eq(channelMemberships.userId, actor.id),
          isNull(channels.deletedAt),
          exists(
            database
              .select()
              .from(groupBotThreads)
              .where(eq(groupBotThreads.channelId, channelId)),
          ),
        ),
      );
    context.header("cache-control", "no-store");
    return membership ? context.json(membership) : context.json(absent, 404);
  });

  routes.put("/conversations/:channelId/learning-evidence", async (context) => {
    const request = context.req.raw;
    if (!sameOriginJson(request))
      return context.json({ error: "Use a same-origin JSON request." }, 403);
    const actor = await actorFor(request);
    if (!actor) return context.json(absent, 404);
    const body = learningEvidencePermission.safeParse(
      await request.json().catch(() => null),
    );
    if (!body.success)
      return context.json({ error: "Choose whether to allow learning." }, 400);
    const saved = await setSharedLearningPermission(
      database,
      actor.id,
      context.req.param("channelId"),
      body.data.allowed,
    );
    return saved ? context.json({ ok: true }) : context.json(absent, 404);
  });

  routes.on(
    ["GET", "POST", "PUT"],
    "/threads/:threadId/learn",
    async (context) => {
      const { threadId } = context.req.param();
      const agentId = context.req.query("agentId");
      const request = context.req.raw;
      if (request.method !== "GET" && !sameOriginJson(request))
        return context.json({ error: "Use a same-origin JSON request." }, 403);
      const personId = (await actorFor(request))?.id;
      if (!personId || !agentId) return context.json(absent, 404);
      const configuration =
        request.method === "PUT"
          ? learningScheduleSettings.safeParse(
              await request.json().catch(() => null),
            )
          : null;
      if (configuration && !configuration.success)
        return context.json(
          {
            error:
              "Choose whether to enable scheduling and a whole-hour interval from 1 to 168.",
          },
          400,
        );
      const submitted =
        request.method === "POST"
          ? learningRequest.safeParse(await request.json().catch(() => null))
          : null;
      if (submitted && !submitted.success)
        return context.json(
          { error: "Choose valid evidence or a proposal to revise." },
          400,
        );
      try {
        const result = await learning.access(
          learningScope(threadId, agentId, personId),
          learningAuthorization(request, threadId, agentId, personId),
          configuration
            ? { kind: "configure", settings: configuration.data }
            : submitted
              ? { kind: "manual", request: submitted.data }
              : { kind: "read" },
        );
        if (!result) return context.json(absent, 404);
        context.header("cache-control", "no-store");
        if (configuration?.data.enabled && !result.enabled)
          return context.json({ error: "Learning is disabled." }, 409);
        if (request.method === "POST") {
          if (!result.enabled)
            return context.json({ error: "Learning is disabled." }, 409);
          if (!result.available)
            return context.json(
              { error: "Learning model is unavailable." },
              503,
            );
          return context.json(result, 202);
        }
        return context.json(result);
      } catch (error) {
        if (error instanceof LearningEvidenceUnavailable)
          return context.json({ error: error.message }, 409);
        throw error;
      }
    },
  );

  routes.post(
    "/threads/:threadId/learn/proposals/:proposalId",
    async (context) => {
      const { threadId, proposalId } = context.req.param();
      const agentId = context.req.query("agentId");
      const request = context.req.raw;
      if (!sameOriginJson(request))
        return context.json({ error: "Use a same-origin JSON request." }, 403);
      const personId = (await actorFor(request))?.id;
      if (!personId || !agentId || !z.uuid().safeParse(proposalId).success)
        return context.json(absent, 404);
      const decision = directChatDecision.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!decision.success)
        return context.json(
          { error: "A decision and its complete scope are required." },
          400,
        );
      const outcome = await learning.decide(
        learningScope(threadId, agentId, personId),
        await learningAuthorization(request, threadId, agentId, personId)(),
        proposalId,
        decision.data,
      );
      switch (outcome) {
        case "saved":
          return context.json({ ok: true });
        case "absent":
          return context.json(absent, 404);
        case "scope_changed":
          return context.json(
            { error: "The approved scope has changed." },
            409,
          );
        case "evidence_unavailable":
          return context.json(
            { error: "The proposal evidence is unavailable." },
            409,
          );
        case "already_reviewed":
          return context.json(
            { error: "This proposal was already reviewed." },
            409,
          );
        case "learning_disabled":
          return context.json({ error: "Learning is disabled." }, 409);
      }
    },
  );

  routes.post("/threads/:threadId/learn/auto-approval", async (context) => {
    const { threadId } = context.req.param();
    const agentId = context.req.query("agentId");
    const request = context.req.raw;
    if (!sameOriginJson(request))
      return context.json({ error: "Use a same-origin JSON request." }, 403);
    const personId = (await actorFor(request))?.id;
    if (!personId || !agentId) return context.json(absent, 404);
    const preference = directChatAutoApproval.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!preference.success)
      return context.json(
        { error: "An automatic approval preference is required." },
        400,
      );
    const saved = await learning.setAutoApproval(
      learningScope(threadId, agentId, personId),
      await learningAuthorization(request, threadId, agentId, personId)(),
      preference.data.autoApprove,
    );
    return saved ? context.json({ ok: true }) : context.json(absent, 404);
  });

  routes.get("/threads/:threadId/messages", async (context) => {
    const { threadId } = context.req.param();
    const agentId = context.req.query("agentId");
    const actor = await actorFor(context.req.raw);
    if (
      !actor ||
      !agentId ||
      !(await runThreadFor(database, actor, threadId, agentId))
    )
      return context.json(absent, 404);
    const result = await database.transaction(async (tx) => {
      if (!(await runThreadFor(tx, actor, threadId, agentId, true)))
        return null;
      await expireDirectChatRuns(tx, threadId, traceRuns);
      const runs = await history(tx, threadId);
      const active = runs.find((run) => run.status === "running");
      const pendingApprovals = active
        ? await pendingRunApprovals(
            tx,
            { threadId, runId: active.id },
            actor.id,
          )
        : [];
      return { runs, active, pendingApprovals };
    });
    if (!result) return context.json(absent, 404);
    const { runs, active, pendingApprovals } = result;
    // A reconnect can carry on a Run after its approval finished on another replica.
    if (active?.waitingApprovalId)
      startWorker(
        context.req.raw,
        { threadId, runId: active.id },
        agentId,
        active,
      );
    return context.json({
      messages: messagesFor(runs),
      runs: runs.map((run) => ({
        id: run.id,
        status: run.status,
        ...(run === active &&
          pendingApprovals.length > 0 && {
            waitingForApproval: true,
            pendingApprovals,
          }),
        userMessageId: run.userMessageId,
        assistantMessageId: run.assistantMessageId,
        ...(run.externalOutcome && { externalOutcome: run.externalOutcome }),
        ...(run.stopReason && { stopReason: run.stopReason }),
      })),
    });
  });

  routes.post("/threads/:threadId/runs/:runId/stop", async (context) => {
    const key = context.req.param();
    const agentId = context.req.query("agentId");
    const actor = await actorFor(context.req.raw);
    if (!actor || !agentId) return context.json(absent, 404);
    const stopped = await database.transaction(async (tx) => {
      if (!(await runThreadFor(tx, actor, key.threadId, agentId, true)))
        return null;
      const [run] = await tx
        .select()
        .from(directChatRuns)
        .where(matchingRun(key));
      if (!run) return null;
      return stopDirectChatRun(tx, key, "stopped", traceRuns);
    });
    if (stopped === null) return context.json(absent, 404);
    if (stopped) workers.get(workerKey(key))?.abort();
    return context.json({ stopped });
  });

  function operationFor(key: RunKey, agentId: string, personId: string) {
    return {
      scope: {
        source: "direct-chat" as const,
        personId,
        botId: agentId,
        conversationId: key.threadId,
        runId: key.runId,
      },
      step: "direct-chat-answer",
    };
  }

  async function loadedSkillsCurrent(
    tx: RunTransaction,
    scope: DirectChatLearningScope,
    versions: RunContextVersion[],
  ) {
    if (!versions.length) return true;
    const current = await learning.guidanceForIds(
      tx,
      scope,
      skillPolicy,
      versions.map(({ id }) => id),
    );
    return versionsMatch(learnedSkillVersions(current), versions);
  }

  async function lockLoadedSkillAuthorization(
    tx: RunTransaction,
    actor: AgentActor,
    scope: DirectChatLearningScope,
    scopeBot: string,
    versions: RunContextVersion[],
  ) {
    await lockLearningSettings(tx);
    return (
      Boolean(await threadFor(tx, actor, scope.threadId, scopeBot, true)) &&
      loadedSkillsCurrent(tx, scope, versions)
    );
  }

  async function learnedSkillVersionsCurrent(
    actor: AgentActor,
    threadId: string,
    agentId: string,
    versions: RunContextVersion[],
    scopeBot = agentId,
  ) {
    if (!versions.length) return true;
    return database.transaction((tx) =>
      lockLoadedSkillAuthorization(
        tx,
        actor,
        learningScope(threadId, agentId, actor.id),
        scopeBot,
        versions,
      ),
    );
  }

  async function settleManagedReceipt(
    tx: RunTransaction,
    key: RunKey,
    scope: DirectChatLearningScope,
    evidence: Extract<
      Awaited<ReturnType<ManagedModel["reconcileOutcome"]>>,
      { outcome: "executed" | "not_dispatched" }
    >,
    answerId: () => string,
  ) {
    const pending = and(
      matchingRun(key),
      eq(directChatRuns.externalOutcome, "unknown"),
      isNull(directChatRuns.waitingApprovalId),
    );
    const [run] = await tx.select().from(directChatRuns).where(pending);
    if (!run) return;

    // Older dispatches have no dependency record. Their receipts can still settle.
    const versions = dispatchedVersions.safeParse(run.dispatchedSkillVersions);
    const canPublish =
      evidence.outcome === "executed" &&
      run.stopReason !== CONTEXT_REVOKED &&
      versions.success &&
      (await loadedSkillsCurrent(tx, scope, versions.data));
    await tx
      .update(directChatRuns)
      .set({
        externalOutcome: evidence.outcome,
        ...(evidence.outcome === "executed" &&
          (canPublish
            ? {
                assistantMessageId: run.assistantMessageId ?? answerId(),
                reply: evidence.text,
              }
            : { stopReason: run.stopReason ?? CONTEXT_REVOKED })),
      })
      .where(pending);
  }

  routes.post("/threads/:threadId/runs/:runId/reconcile", async (context) => {
    const key = context.req.param();
    const agentId = context.req.query("agentId");
    const actor = await actorFor(context.req.raw);
    if (
      !actor ||
      !agentId ||
      !(await runThreadFor(database, actor, key.threadId, agentId))
    )
      return context.json(absent, 404);
    const run = await database.transaction(async (tx) => {
      if (!(await runThreadFor(tx, actor, key.threadId, agentId, true))) return;
      await expireDirectChatRuns(tx, key.threadId, traceRuns);
      const [current] = await tx
        .select()
        .from(directChatRuns)
        .where(matchingRun(key));
      if (current?.externalOutcome === "unknown" && current.waitingApprovalId) {
        // Only the consumed Approval can verify its action, even after the Run stops.
        const approval = await approvalCheckpoint(
          key,
          current.waitingApprovalId,
          actor.id,
          tx,
        );
        if (approval?.consumedAt && approval.result && !approval.result.error) {
          const [verified] = await tx
            .update(directChatRuns)
            .set({ externalOutcome: "executed" })
            .where(
              and(
                matchingRun(key),
                eq(directChatRuns.externalOutcome, "unknown"),
                eq(directChatRuns.waitingApprovalId, approval.id),
              ),
            )
            .returning();
          return verified ?? current;
        }
      }
      return current;
    });
    if (!run) return context.json(absent, 404);
    if (
      run.externalOutcome !== "unknown" ||
      run.waitingApprovalId ||
      !deps.trial
    )
      return context.json({ externalOutcome: run.externalOutcome });
    const evidence = await deps.trial.model
      .reconcileOutcome(operationFor(key, agentId, actor.id))
      .catch(() => undefined);
    const currentActor = await actorFor(context.req.raw);
    if (!currentActor || currentActor.id !== actor.id)
      return context.json(absent, 404);
    return database.transaction(async (tx) => {
      await lockLearningSettings(tx);
      if (!(await runThreadFor(tx, currentActor, key.threadId, agentId, true)))
        return context.json(absent, 404);
      if (
        evidence?.outcome === "executed" ||
        evidence?.outcome === "not_dispatched"
      ) {
        await settleManagedReceipt(
          tx,
          key,
          learningScope(key.threadId, agentId, actor.id),
          evidence,
          () => crypto.randomUUID(),
        );
      }
      const [current] = await tx
        .select()
        .from(directChatRuns)
        .where(matchingRun(key));
      return context.json({
        externalOutcome: current?.externalOutcome,
        settlement: evidence?.state,
      });
    });
  });

  routes.post("/threads/:threadId/runs/:runId/feedback", async (context) => {
    const { threadId, runId } = context.req.param();
    const agentId = context.req.query("agentId");
    const actor = await actorFor(context.req.raw);
    if (!actor || !agentId) return context.json(absent, 404);
    const feedback = runFeedback.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!feedback.success)
      return context.json({ error: "Invalid Run feedback." }, 400);
    const outcome = await database.transaction(async (transaction) => {
      if (!(await runThreadFor(transaction, actor, threadId, agentId, true)))
        return "absent";
      return saveRunFeedback(transaction, { threadId, runId }, feedback.data);
    });
    if (outcome === "absent") return context.json(absent, 404);
    if (outcome === "conflict")
      return context.json(
        { error: "Feedback already submitted for this Run." },
        409,
      );
    return context.json({ feedbackId: feedback.data.feedbackId }, 202);
  });

  routes.get("/agent/:agentId/thread/:threadId", async (context) => {
    const actor = await actorFor(context.req.raw);
    if (!actor?.id)
      return context.json(
        { error: "Sign in to check this conversation." },
        401,
      );
    const { agentId, threadId } = context.req.param();
    return context.json({
      known: Boolean(await threadFor(database, actor, threadId, agentId)),
    });
  });

  routes.post("/agent/:agentId/connect", async (context) => {
    const parsed = joinBody.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json({ error: "A thread is required." }, 400);
    const { threadId } = parsed.data;
    const agentId = context.req.param("agentId");
    const actor = await actorFor(context.req.raw);
    if (!actor || !(await runThreadFor(database, actor, threadId, agentId)))
      return context.json(absent, 404);
    const runs = await history(database, threadId);
    return eventStream(async (emit) => {
      if (!(await runThreadFor(database, actor, threadId, agentId))) return;
      emit({ type: EventType.MESSAGES_SNAPSHOT, messages: messagesFor(runs) });
      const active = runs.find((run) => run.status === "running");
      if (active)
        startWorker(
          context.req.raw,
          { threadId, runId: active.id },
          agentId,
          active,
        );
      const latest = runs.at(-1);
      if (!testCredit || !latest?.testCreditOperationId) return;
      const receipt = await testCredit
        .receipt(latest.testCreditOperationId, actor.id)
        .catch(() => undefined);
      if (receipt)
        emit(creditReceiptEvent(latest, receipt, latest.reply !== null));
    });
  });

  function terminal(key: RunKey, status: "completed" | "failed"): BaseEvent {
    return status === "completed"
      ? { type: EventType.RUN_FINISHED, ...key }
      : { type: EventType.RUN_ERROR, message: "The Bot run failed." };
  }

  async function read(
    request: Request,
    key: RunKey,
    agentId: string,
    cursor: number,
  ) {
    const actor = await actorFor(request);
    const actorId = actor?.id;
    if (!actor || !actorId) return { kind: "absent" } as const;
    // Close abandoned executions when their existing dispatch deadline passes.
    return database.transaction(
      async (tx) => {
        if (!(await runThreadFor(tx, actor, key.threadId, agentId)))
          return { kind: "absent" } as const;
        await expireDirectChatRuns(tx, key.threadId, traceRuns);
        return readDirectChatReplay(tx, key, cursor, actorId);
      },
      { isolationLevel: "repeatable read" },
    );
  }

  function follow(
    request: Request,
    key: RunKey,
    agentId: string,
    after: number,
    initial?: Awaited<ReturnType<typeof read>>,
    reconcileFailure?: (event: BaseEvent, emit: Emit) => Promise<BaseEvent>,
  ) {
    return eventStream(async (emit, signal, heartbeat) => {
      let nextHeartbeat = Date.now() + 5_000;
      let cursor = after;
      let page = initial;
      while (!signal.aborted && !request.signal.aborted) {
        const result = page ?? (await read(request, key, agentId, cursor));
        page = undefined;
        if (result.kind === "absent" || result.kind === "invalid") {
          emit({
            type: EventType.RUN_ERROR,
            message: "The Bot run is unavailable.",
          });
          return;
        }
        if (result.run.waitingApprovalId)
          startWorker(request, key, agentId, result.run);
        if (result.kind === "snapshot") {
          if (cursor === 0) emit({ type: EventType.RUN_STARTED, ...key });
          emit({
            type: EventType.MESSAGES_SNAPSHOT,
            messages: result.messages,
          });
          cursor = result.run.eventCursor;
          emit(
            {
              type: EventType.CUSTOM,
              name: "openbot.run.snapshot",
              value: {
                ...key,
                cursor,
                status: result.run.status,
                pendingApprovals: result.pendingApprovals,
                ...(result.run.externalOutcome && {
                  externalOutcome: result.run.externalOutcome,
                }),
                ...(result.run.stopReason && {
                  stopReason: result.run.stopReason,
                }),
              },
            },
            cursor,
          );
          if (result.run.status !== "running") {
            const event = result.run.stopReason
              ? stoppedRunEvent(result.run.stopReason)
              : terminal(
                  key,
                  result.run.externalOutcome === "executed"
                    ? "completed"
                    : result.run.status,
                );
            emit(
              event.type === EventType.RUN_ERROR && reconcileFailure
                ? await reconcileFailure(event, emit)
                : event,
            );
            return;
          }
        } else {
          for (const row of result.events) {
            emit(
              row.event.type === EventType.RUN_ERROR && reconcileFailure
                ? await reconcileFailure(row.event, emit)
                : row.event,
              row.cursor,
            );
            cursor = row.cursor;
            if (
              row.event.type === EventType.RUN_FINISHED ||
              row.event.type === EventType.RUN_ERROR
            )
              return;
          }
          if (
            cursor < result.run.eventCursor ||
            result.run.status !== "running"
          )
            continue;
        }
        if (!signal.aborted && Date.now() >= nextHeartbeat) {
          heartbeat();
          nextHeartbeat = Date.now() + 5_000;
        }
        await Bun.sleep(200);
      }
    }, key);
  }

  routes.post("/agent/:agentId/resume", async (context) => {
    const body = resumeBody.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!body.success)
      return context.json({ error: "A run and cursor are required." }, 400);
    const { cursor, ...key } = body.data;
    const agentId = context.req.param("agentId");
    const initial = await read(context.req.raw, key, agentId, cursor);
    if (initial.kind === "absent") return context.json(absent, 404);
    if (initial.kind === "invalid")
      return context.json({ error: "Invalid run cursor." }, 400);
    startWorker(context.req.raw, key, agentId, initial.run);
    return follow(context.req.raw, key, agentId, cursor, initial);
  });

  routes.on(
    ["GET", "PUT"],
    "/agent/:agentId/test-credit-model",
    async (context) => {
      context.header("Cache-Control", "no-store");
      const actor = await actorFor(context.req.raw);
      if (!testCredit || !actor?.id) return context.json(absent, 404);
      const agentId = context.req.param("agentId");
      const threadId = context.req.query("threadId");
      if (threadId === "") return context.json(absent, 404);
      const saving = context.req.method === "PUT";
      // Only our JSON client can write. An HTML form cannot submit this content type.
      if (
        saving &&
        !/^application\/json(?:;|$)/i.test(
          context.req.header("Content-Type") ?? "",
        )
      )
        return context.json({ error: "Send a JSON model selection." }, 415);
      const input = saving
        ? testCreditModelSelection.safeParse(
            await context.req.json().catch(() => undefined),
          )
        : undefined;
      if (input && !input.success)
        return context.json(
          { error: "Choose a verified model or clear the selection." },
          400,
        );

      return database.transaction(async (tx) => {
        if (
          threadId &&
          !(await threadFor(tx, actor, threadId, agentId, saving))
        )
          return context.json(absent, 404);
        if (!threadId) {
          // Take locks in the same order as Bot profile mutations.
          if (saving)
            await tx
              .select({ id: agents.id })
              .from(agents)
              .where(eq(agents.id, agentId))
              .for("update");
          const profile = await profiles.getWithin(tx, actor, agentId);
          if (!profile || profile.deletedAt) return context.json(absent, 404);
          if (saving && !canManageAgent(actor, profile))
            return context.json(
              { error: "You cannot change this Bot's default model." },
              403,
            );
        }

        if (input?.success) {
          const { selection } = input.data;
          if (selection) {
            const candidate = await testCredit.modelChoices(
              { conversation: selection },
              tx,
            );
            if ("reason" in candidate)
              return context.json(
                {
                  error:
                    "That model is no longer verified for this Harness. Choose another model.",
                },
                409,
              );
          }
          if (threadId) {
            const mapping = intelligenceChannelMappings;
            await tx
              .update(mapping)
              .set({
                modelSelection: writeTestCreditModel(
                  mapping.modelSelection,
                  selection,
                ),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(mapping.threadId, threadId),
                  eq(mapping.userId, actor.id),
                ),
              );
          } else {
            await tx
              .update(agents)
              .set({
                configuration: writeTestCreditModel(
                  agents.configuration,
                  selection,
                ),
                updatedAt: new Date(),
              })
              .where(eq(agents.id, agentId));
          }
        }

        const preferences = threadId
          ? await conversationTestCreditModels(tx, actor.id, agentId, threadId)
          : { conversation: null, bot: await botTestCreditModel(tx, agentId) };
        const choices = await testCredit.modelChoices(preferences, tx);
        return context.json({
          saved: threadId ? preferences.conversation : preferences.bot,
          ...choices,
        });
      });
    },
  );

  routes.get("/agent/:agentId/test-credit-quote", async (context) => {
    context.header("Cache-Control", "no-store");
    if (!testCredit)
      return context.json({ error: "Test Credit quote unavailable." }, 404);
    const actor = await actorFor(context.req.raw);
    const threadId = context.req.query("threadId");
    if (
      !actor?.id ||
      !threadId ||
      !(await threadFor(
        database,
        actor,
        threadId,
        context.req.param("agentId"),
      ))
    )
      return context.json(absent, 404);
    const preferences = await conversationTestCreditModels(
      database,
      actor.id,
      context.req.param("agentId"),
      threadId,
    );
    const resolved = await testCredit
      .quote(actor.id, preferences)
      .catch(() => undefined);
    if (!resolved)
      return context.json({ error: "Test Credit quote unavailable." }, 503);
    if ("reason" in resolved)
      return context.json({ error: resolved.reason }, 409);
    return context.json(resolved.quote);
  });

  routes.post("/agent/:agentId/run", async (context) => {
    const body = runBody.safeParse(await context.req.json().catch(() => null));
    if (!body.success)
      return context.json({ error: "A text message is required." }, 400);
    const prompt = promptMessage.safeParse(body.data.messages.at(-1));
    if (!prompt.success || isBackgroundMessage(prompt.data.id))
      return context.json({ error: "A text message is required." }, 400);
    const { threadId, runId } = body.data;
    const rerunOfMessageId = body.data.forwardedProps?.rerunOfMessageId;
    const confirmation = testCreditConfirmation.safeParse(
      body.data.forwardedProps?.testCreditQuote,
    );
    const { id: messageId, content } = prompt.data;
    const agentId = context.req.param("agentId");
    const actor = await actorFor(context.req.raw);
    if (!actor?.id) return context.json(absent, 404);

    const claim = await database.transaction(async (transaction) => {
      if (!(await threadFor(transaction, actor, threadId, agentId, true)))
        return { kind: "absent" } as const;
      // The mapping row serializes claims from every server process. An expired claim remains
      // the original request's record, so repeating it can never start the Bot again.
      await expireDirectChatRuns(transaction, threadId, traceRuns);
      const previous = await history(transaction, threadId);
      const same = previous.find((run) => run.userMessageId === messageId);
      if (same)
        return same.prompt === content
          ? ({ kind: "repeat", run: same } as const)
          : ({ kind: "conflict" } as const);
      if (previous.some((run) => run.id === runId))
        return { kind: "conflict" } as const;
      if (previous.some((run) => run.status === "running"))
        return { kind: "busy" } as const;
      if (previous.some((run) => run.externalOutcome === "unknown"))
        return { kind: "unverified" } as const;
      if (testCredit && !confirmation.success)
        return { kind: "confirmation_required" } as const;
      const original =
        rerunOfMessageId === undefined
          ? undefined
          : previous.find((run) => run.userMessageId === rerunOfMessageId);
      if (
        rerunOfMessageId !== undefined &&
        (!testCredit ||
          !original?.testCreditOperationId ||
          original.prompt !== content)
      )
        return { kind: "rerun_unavailable" } as const;
      const [run] = await transaction
        .insert(directChatRuns)
        .values({
          threadId,
          id: runId,
          userMessageId: messageId,
          testCreditOperationId: testCredit
            ? operationId(operationFor({ threadId, runId }, agentId, actor.id))
            : null,
          testCreditRequest:
            testCredit && confirmation.success
              ? {
                  confirmation: confirmation.data,
                  rerunOfOperationId:
                    original?.testCreditOperationId ?? undefined,
                }
              : null,
          prompt: content,
          status: "running",
        })
        .returning();
      if (!run) throw new Error("Direct chat run was not created.");
      return {
        kind: "start",
        run,
      } as const;
    });
    if (claim.kind === "absent") return context.json(absent, 404);
    if (claim.kind === "confirmation_required")
      return context.json(
        { error: "Confirm the current Test Credit quote before sending." },
        409,
      );
    if (claim.kind === "rerun_unavailable")
      return context.json(
        { error: "The original Test Credit run is unavailable." },
        409,
      );
    if (claim.kind === "conflict")
      return context.json({ error: "The request ID is already in use." }, 409);
    if (claim.kind === "busy")
      return context.json(
        { error: "This conversation already has a running Bot." },
        409,
      );
    if (claim.kind === "unverified")
      return context.json(
        { error: "The previous Run has an unverified external outcome." },
        409,
      );
    const run = claim.run;
    const key = { threadId, runId: run.id };
    const trial = run.testCreditOperationId ? undefined : deps.trial;
    let creditRecovery: Awaited<ReturnType<DirectChatTestCredit["reconcile"]>>;
    if (
      claim.kind === "repeat" &&
      testCredit &&
      run.testCreditOperationId &&
      run.status === "failed" &&
      !run.stopReason &&
      run.reply === null
    ) {
      const recovered = await testCredit
        .reconcile(run.testCreditOperationId, actor.id)
        .catch(() => undefined);
      creditRecovery = recovered;
      if (recovered?.state === "completed") {
        const currentActor = await actorFor(context.req.raw);
        if (!currentActor || currentActor.id !== actor.id)
          return context.json(absent, 404);
        await database.transaction(async (tx) => {
          if (!(await threadFor(tx, currentActor, threadId, agentId, true)))
            return;
          await tx
            .update(directChatRuns)
            .set({
              externalOutcome: "executed",
              reply: recovered.text,
              assistantMessageId: crypto.randomUUID(),
            })
            .where(
              and(
                matchingRun(key),
                eq(directChatRuns.status, "failed"),
                isNull(directChatRuns.stopReason),
                isNull(directChatRuns.reply),
              ),
            );
        });
      }
    }
    startWorker(context.req.raw, key, agentId, run);
    const recovered = creditRecovery;
    return follow(
      context.req.raw,
      key,
      agentId,
      0,
      undefined,
      recovered &&
        recovered.state !== "completed" &&
        recovered.state !== "unavailable"
        ? async (_event, emit) => {
            const currentActor = await actorFor(context.req.raw);
            if (
              currentActor?.id !== actor.id ||
              !(await threadFor(database, currentActor, threadId, agentId))
            )
              return {
                type: EventType.RUN_ERROR,
                message: "The Bot run is unavailable.",
              };
            if (recovered.operation)
              emit(creditReceiptEvent(run, recovered.operation, false));
            return {
              type: EventType.RUN_ERROR,
              code: recovered.state,
              message: managedRunError[recovered.state],
            };
          }
        : claim.kind === "repeat" &&
            trial &&
            !run.stopReason &&
            !(deps.reflect && reflectCommand(run.prompt))
          ? async (event) => {
              if (
                "code" in event &&
                (event.code === "stopped" ||
                  event.code === "access_revoked" ||
                  event.code === CONTEXT_REVOKED)
              )
                return event;
              const state = await trial.model
                .reconcile(operationFor(key, agentId, actor.id))
                .catch(() => undefined);
              const currentActor = await actorFor(context.req.raw);
              if (
                !currentActor ||
                !(await threadFor(database, currentActor, threadId, agentId))
              )
                return {
                  type: EventType.RUN_ERROR,
                  message: "The Bot run is unavailable.",
                };
              const code = state === "pending" ? "reconciling" : state;
              return code && code !== "absent"
                ? {
                    type: EventType.RUN_ERROR,
                    code,
                    message: managedRunError[code],
                  }
                : event;
            }
          : undefined,
    );
  });

  function startWorker(
    request: Request,
    key: RunKey,
    agentId: string,
    run: typeof directChatRuns.$inferSelect,
  ) {
    if (
      run.status !== "running" ||
      run.dispatchedAt ||
      isBackgroundMessage(run.userMessageId)
    )
      return;
    const workerId = workerKey(key);
    if (workers.has(workerId)) return;
    const controller = new AbortController();
    workers.set(workerId, controller);
    const authorize = () => actorFor(request);
    void (async () => {
      const actor = await authorize();
      if (!actor) return;
      const checkpoint = await readApprovalCheckpoint(key, run, actor.id);
      if (checkpoint.kind !== "ready") return;
      await execute(
        authorize,
        key,
        agentId,
        controller.signal,
        undefined,
        checkpoint.continuation,
      );
    })()
      .catch(() => {})
      .finally(() => workers.delete(workerId));
  }

  async function accountIsActive(
    executor: ProfileReadExecutor,
    personId: string,
  ) {
    if (deps.singleUser) return true;
    const [person] = await executor
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, personId),
          notExists(
            executor
              .select({ email: revokedAccess.email })
              .from(revokedAccess)
              .where(eq(revokedAccess.email, sql`lower(trim(${users.email}))`)),
          ),
        ),
      );
    return Boolean(person);
  }

  async function routineCanContinue(
    key: RunKey,
    actorId: string,
    botId: string,
  ) {
    const [routine] = await database
      .select({ enabled: routines.enabled })
      .from(routineRuns)
      .innerJoin(routines, eq(routines.id, routineRuns.routineId))
      .where(
        and(
          eq(routineRuns.id, key.runId),
          eq(routines.ownerUserId, actorId),
          eq(routines.agentId, botId),
          isNull(routineRuns.status),
        ),
      );
    return routine?.enabled === true;
  }

  async function backgroundApproval(
    action: ApprovalAction,
    approvalId: string,
  ) {
    const key = { threadId: action.threadId, runId: action.runId };
    const [run] = await database
      .select()
      .from(directChatRuns)
      .where(matchingRun(key));
    if (!run) return null;
    const background = isBackgroundMessage(run.userMessageId);
    const check = async () => {
      if (run.status !== "running") return "The Bot run has ended.";
      if (run.waitingApprovalId !== approvalId) {
        if (run.dispatchedAt && !run.waitingApprovalId)
          throw new Error("The Bot has not saved its approval checkpoint yet.");
        return "This approval is no longer the Bot run's active checkpoint.";
      }
      const actor = await deps
        .backgroundActor?.(action.actorId)
        .catch(() => null);
      // A Run handed on by another Bot still runs in the conversation's own thread, two deep.
      // The handing Bot grants the work; it is not the Bot whose thread this is, and checking the
      // thread under its id refused every approval in a delivered Run past the first hop.
      const scopeBot =
        (await conversationBotFor(database, key.threadId)) ??
        run.handoffFromBotId ??
        action.botId;
      const profile = actor && (await profiles.get(actor, action.botId));
      const allowed =
        actor?.id === action.actorId &&
        (await accountIsActive(database, actor.id)) &&
        (background
          ? await runThreadFor(database, actor, key.threadId, scopeBot)
          : await threadFor(database, actor, key.threadId, scopeBot)) &&
        profile &&
        !profile.deletedAt &&
        !profile.hidden &&
        !(await isBotPaused(actor.id, action.botId)) &&
        (run.userMessageId !== backgroundMessageId("routine", key.runId) ||
          (await routineCanContinue(key, action.actorId, action.botId))) &&
        (!run.handoffFromBotId ||
          (await deps.mayAddress?.(run.handoffFromBotId, action.botId)));
      const refusal = allowed
        ? await headlessTurnRefusal({
            ownerUserId: action.actorId,
            agentId: action.botId,
            threadId: key.threadId,
          })
        : "This account, conversation or Bot can no longer run this work.";
      if (refusal)
        await database.transaction((tx) =>
          stopDirectChatRun(tx, key, "access_revoked", traceRuns),
        );
      return refusal;
    };
    return { check };
  }

  async function approvalCheckpoint(
    key: RunKey,
    approvalId: string,
    actorId: string,
    executor: ProfileReadExecutor = database,
  ) {
    const [request] = await executor
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.id, approvalId),
          eq(approvalRequests.ownerUserId, actorId),
          eq(approvalRequests.runId, key.runId),
          sql`${approvalRequests.action}->>'threadId' = ${key.threadId}`,
        ),
      );
    return request;
  }

  async function readApprovalCheckpoint(
    key: RunKey,
    run: typeof directChatRuns.$inferSelect,
    actorId: string,
  ): Promise<
    | {
        kind: "ready";
        continuation?: Parameters<TurnRunner>[0]["continuation"];
      }
    | { kind: "waiting" }
    | { kind: "unknown" }
    | { kind: "paused"; reason: string }
  > {
    if (!run.waitingApprovalId) return { kind: "ready" };
    const request = await approvalCheckpoint(
      key,
      run.waitingApprovalId,
      actorId,
    );
    if (request?.status !== "completed" || !request.result)
      return { kind: "waiting" };
    const snapshot = parseApprovalContinuation(request.action.continuation);
    if (!snapshot || request.result.error === OUTCOME_UNKNOWN) {
      await appendDirectChatEvent(
        database,
        key,
        {
          type: EventType.RUN_ERROR,
          message: "The Run has an unverified external outcome.",
        },
        { traceRuns, externalOutcome: "unknown" },
      );
      return { kind: "unknown" };
    }
    const reason =
      request.result.pauseReason ??
      (await marketRunPauseReason(database, request.action));
    if (reason) {
      await appendDirectChatEvent(
        database,
        key,
        {
          type: EventType.RUN_ERROR,
          message: reason,
          code: "MARKET_SKILL_PAUSED",
        },
        { traceRuns },
      );
      return { kind: "paused", reason };
    }
    return {
      kind: "ready",
      continuation: {
        snapshot,
        result: request.result,
        messageId: `approval:${request.id}`,
      },
    };
  }

  async function runBackground(
    turn: BackgroundTurn,
  ): Promise<{ replyText: string; shared: boolean }> {
    const mappedGroup =
      turn.source === "routine" && deps.groupThread
        ? await database
            .select({ channelId: intelligenceChannelMappings.channelId })
            .from(intelligenceChannelMappings)
            .where(
              and(
                eq(intelligenceChannelMappings.threadId, turn.threadId),
                eq(intelligenceChannelMappings.userId, turn.personId),
                exists(
                  database
                    .select()
                    .from(groupBotThreads)
                    .where(
                      eq(
                        groupBotThreads.channelId,
                        intelligenceChannelMappings.channelId,
                      ),
                    ),
                ),
              ),
            )
        : [];
    const input =
      mappedGroup[0] && deps.groupThread
        ? {
            ...turn,
            threadId: await deps.groupThread(
              turn.personId,
              mappedGroup[0].channelId,
              turn.agentId,
            ),
          }
        : turn;
    const key = { threadId: input.threadId, runId: input.id };
    const messageId = backgroundMessageId(input.source, input.id);
    const scopeBot = input.conversationBotId;
    const authorize = async () => {
      const actor = await input.authorize();
      if (
        actor?.id !== input.personId ||
        (await isBotPaused(actor.id, input.agentId))
      )
        return null;
      if (!(await accountIsActive(database, actor.id))) return null;
      const refusal = await headlessTurnRefusal({
        ownerUserId: actor.id,
        agentId: input.agentId,
        threadId: input.threadId,
      });
      return refusal ? null : actor;
    };

    for (;;) {
      input.signal?.throwIfAborted();
      const actor = await authorize();
      if (!actor) {
        await database.transaction(async (tx) => {
          const [owned] = await tx
            .select({ id: directChatRuns.id })
            .from(directChatRuns)

            .where(
              and(
                matchingRun(key),
                eq(directChatRuns.userMessageId, messageId),
              ),
            );
          if (owned)
            await stopDirectChatRun(tx, key, "access_revoked", traceRuns);
        });
        throw backgroundRefusal("This account or Bot cannot run this work.");
      }
      const run = await database.transaction(async (tx) => {
        const scope = await runThreadFor(
          tx,
          actor,
          key.threadId,
          scopeBot,
          true,
        );
        const agent = await profiles.getWithin(tx, actor, input.agentId);
        if (!scope || !agent || agent.deletedAt || agent.hidden) {
          const [existing] = await tx
            .select({ id: directChatRuns.id })
            .from(directChatRuns)
            .where(
              and(
                matchingRun(key),
                eq(directChatRuns.userMessageId, messageId),
              ),
            );
          if (existing)
            await stopDirectChatRun(tx, key, "access_revoked", traceRuns);
          return null;
        }
        await expireDirectChatRuns(tx, key.threadId, traceRuns);
        const previous = await history(tx, key.threadId);
        const existing = previous.find(({ id }) => id === key.runId);
        if (existing) {
          if (existing.userMessageId !== messageId)
            throw backgroundRefusal("The Run ID is already in use.");
          return existing;
        }
        if (previous.some(({ status }) => status === "running"))
          throw new BackgroundConversationBusy(
            "This conversation already has a running Bot.",
          );
        if (
          previous.some(({ externalOutcome }) => externalOutcome === "unknown")
        )
          throw backgroundRefusal(
            "The previous Run has an unverified external outcome.",
          );
        if (input.source === "group") {
          const [row] = await tx
            .select({ id: groupMessages.id })
            .from(groupMessages)
            .where(
              and(
                eq(groupMessages.id, input.groupRowId),
                eq(groupMessages.threadId, key.threadId),
                eq(groupMessages.ownerUserId, actor.id),
                eq(groupMessages.agentId, input.agentId),
                eq(groupMessages.status, "running"),
              ),
            );
          if (scope !== "group" || !row) return null;
        }
        if (scope === "group") {
          const [group] = await tx
            .select({ id: groupMessages.id })
            .from(groupMessages)
            .where(
              and(
                eq(groupMessages.threadId, key.threadId),
                input.source === "group"
                  ? ne(groupMessages.id, input.groupRowId)
                  : undefined,
                or(
                  eq(groupMessages.status, "running"),
                  and(
                    eq(groupMessages.status, "waiting"),
                    sql`${groupMessages.details}->'privateShare' is null`,
                  ),
                ),
              ),
            )
            .limit(1);
          if (group)
            throw new BackgroundConversationBusy(
              "This conversation already has a running Bot.",
            );
        }
        const [created] = await tx
          .insert(directChatRuns)
          .values({
            threadId: key.threadId,
            id: key.runId,
            userMessageId: messageId,
            prompt: input.shown ?? input.prompt,
            status: "running",
            ...(scope === "group" && { groupThreadId: key.threadId }),
            handoffFromBotId: input.handoffFromBotId,
            ...(input.source === "handoff" && {
              assistantMessageId: answerMessageId(
                input.literalAnswer?.botId ?? input.agentId,
                key.runId,
              ),
            }),
          })
          .returning();
        if (!created) throw new Error("Background Run was not created.");
        return created;
      });
      if (!run)
        throw backgroundRefusal("This conversation or Bot is unavailable.");
      if (
        run.reply !== null &&
        (run.status === "completed" || run.externalOutcome === "executed")
      ) {
        if (
          run.groupThreadId &&
          (input.source === "routine" || input.literalAnswer)
        ) {
          await deps.publishGroupReply?.({
            threadId: key.threadId,
            actorId: actor.id,
            agentId: input.literalAnswer?.botId ?? input.agentId,
            text: run.reply,
            conversationRunId: key.runId,
          });
        }
        return { replyText: run.reply, shared: Boolean(run.groupThreadId) };
      }
      if (run.status !== "running") {
        if (
          run.externalOutcome === "unknown" &&
          !run.waitingApprovalId &&
          deps.trial &&
          !input.literalAnswer
        ) {
          const evidence = await deps.trial.model
            .reconcileOutcome(operationFor(key, scopeBot, actor.id))
            .catch(() => undefined);
          if (
            (evidence?.outcome === "executed" ||
              evidence?.outcome === "not_dispatched") &&
            (await authorize())?.id === actor.id
          ) {
            await database.transaction(async (tx) => {
              await lockLearningSettings(tx);
              if (
                !(await runThreadFor(tx, actor, key.threadId, scopeBot, true))
              )
                return;
              await settleManagedReceipt(
                tx,
                key,
                learningScope(key.threadId, input.agentId, actor.id),
                evidence,
                () =>
                  input.source === "handoff"
                    ? answerMessageId(input.agentId, key.runId)
                    : crypto.randomUUID(),
              );
            });
            continue;
          }
        }
        const marketPause = await marketRunPauseReason(database, {
          ...key,
          actorId: actor.id,
          botId: input.agentId,
        });
        throw backgroundRefusal(
          run.externalOutcome === "unknown"
            ? "The Run has an unverified external outcome."
            : (marketPause ??
                "The Bot Run failed. See the conversation for its status."),
        );
      }
      if (!run.dispatchedAt) {
        const checkpoint = await readApprovalCheckpoint(key, run, actor.id);
        if (checkpoint.kind === "waiting")
          throw new BackgroundConversationBusy(
            "The Bot run is waiting for an approval.",
          );
        if (checkpoint.kind === "unknown") continue;
        if (checkpoint.kind === "paused")
          throw backgroundRefusal(checkpoint.reason);
        const controller = new AbortController();
        const workerId = workerKey(key);
        if (!workers.has(workerId)) {
          workers.set(workerId, controller);
          try {
            await execute(
              authorize,
              key,
              input.agentId,
              input.signal
                ? AbortSignal.any([controller.signal, input.signal])
                : controller.signal,
              input,
              checkpoint.continuation,
            );
          } finally {
            workers.delete(workerId);
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async function execute(
    authorize: () => Promise<AgentActor | null>,
    key: RunKey,
    agentId: string,
    signal: AbortSignal,
    background?: BackgroundTurn,
    continuation?: Parameters<TurnRunner>[0]["continuation"],
  ) {
    const { threadId } = key;
    const trial =
      background?.literalAnswer || background?.metered ? undefined : deps.trial;
    const scopeBot = background?.conversationBotId ?? agentId;
    const actor = await authorize();
    if (!actor || !(await runThreadFor(database, actor, threadId, scopeBot)))
      return;
    const operation = operationFor(key, scopeBot, actor.id);
    const currentGuidance = async () => {
      const currentActor = await authorize();
      return learning.guidance(
        learningScope(threadId, agentId, actor.id),
        (tx) =>
          currentActor?.id === actor.id
            ? threadFor(tx, currentActor, threadId, scopeBot, true)
            : Promise.resolve(null),
        skillPolicy,
      );
    };
    const previous = await history(database, threadId);
    const currentRun = previous.find(({ id }) => id === key.runId);
    const creditRun =
      !background &&
      testCredit &&
      currentRun?.testCreditOperationId &&
      currentRun.testCreditRequest
        ? {
            ledger: testCredit,
            id: currentRun.testCreditOperationId,
            request: currentRun.testCreditRequest,
          }
        : undefined;
    if (currentRun?.testCreditOperationId && !creditRun) {
      await appendDirectChatEvent(
        database,
        key,
        {
          type: EventType.RUN_ERROR,
          code: "unavailable",
          message: managedRunError.unavailable,
        },
        { traceRuns },
      );
      return;
    }
    const reflectQuery =
      !background &&
      deps.reflect &&
      currentRun &&
      reflectCommand(currentRun.prompt);
    // Reflection stays in the visible transcript. A later Bot call must not
    // receive a historical inference whose Memory sources may have been revoked.
    const messages =
      background?.source === "handoff" || background?.source === "group"
        ? [
            {
              id: `prompt-${key.runId}`,
              role: "user" as const,
              content:
                background.source === "group"
                  ? (currentRun?.prompt ?? background.prompt)
                  : background.prompt,
            },
          ]
        : messagesFor(
            previous
              .filter(
                ({ id, prompt, handoffFromBotId }) =>
                  id === key.runId ||
                  (!handoffFromBotId && !reflectCommand(prompt)),
              )
              .map((run) =>
                run.stopReason === CONTEXT_REVOKED
                  ? { ...run, partialMessageId: null, partialReply: null }
                  : run,
              ),
            { includePartial: !trial },
          );
    const agent =
      trial || creditRun || reflectQuery || background?.literalAnswer
        ? null
        : (background?.metered?.agent ??
          (await deps
            .agentFor(
              actor,
              agentId,
              background?.initiator,
              continuation
                ? (continuation.snapshot.marketSkill ?? null)
                : undefined,
              background?.source === "group" ? background.depth : undefined,
            )
            .catch(() => null)));
    let runnable = true;
    const shouldContinue = async () => {
      if (!runnable || signal.aborted) return false;
      const currentActor = await authorize();
      const currentProfile =
        currentActor && background
          ? await profiles.get(currentActor, agentId)
          : null;
      if (
        currentActor?.id === actor.id &&
        (await runThreadFor(database, currentActor, threadId, scopeBot)) &&
        (!background ||
          (currentProfile &&
            !currentProfile.deletedAt &&
            !currentProfile.hidden)) &&
        (background?.source !== "routine" ||
          (await routineCanContinue(key, actor.id, agentId)))
      ) {
        const [current] = await database
          .select({ status: directChatRuns.status })
          .from(directChatRuns)
          .where(matchingRun(key));
        return current?.status === "running";
      }
      await database.transaction((tx) =>
        stopDirectChatRun(tx, key, "access_revoked", traceRuns),
      );
      return false;
    };
    if (!(await shouldContinue())) return;
    await background?.beforeDispatch?.();
    const dispatchTime = new Date();
    const [dispatched] = await database
      .update(directChatRuns)
      .set({
        dispatchedAt: dispatchTime,
        waitingApprovalId: null,
        ...(!background && continuation && { externalOutcome: null }),
        ...((trial || (background && !background.literalAnswer)) &&
          !reflectQuery && { externalOutcome: "dispatching" as const }),
      })
      .where(
        and(
          matchingRun(key),
          eq(directChatRuns.status, "running"),
          isNull(directChatRuns.dispatchedAt),
          continuation && currentRun?.waitingApprovalId
            ? eq(directChatRuns.waitingApprovalId, currentRun.waitingApprovalId)
            : isNull(directChatRuns.waitingApprovalId),
        ),
      )
      .returning({ dispatchedAt: directChatRuns.dispatchedAt });
    if (!dispatched) return;

    let watcher: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const abort = () => {
      runnable = false;
      agent?.abortRun();
    };
    signal.addEventListener("abort", abort, { once: true });
    async function watchAuthorization() {
      if (finished) return;
      if (!(await shouldContinue().catch(() => false))) {
        abort();
        return;
      }
      if (!finished) watcher = setTimeout(() => void watchAuthorization(), 250);
    }
    watcher = setTimeout(() => void watchAuthorization(), 250);
    const runContext = createRunContext();
    let learnedVersions: RunContextVersion[] | undefined;
    let learnedContextRevoked = false;
    function revokeLearnedContext() {
      learnedContextRevoked = true;
      runContext.revoked = true;
    }

    async function learnedContextIsCurrent() {
      if (learnedContextRevoked) return false;
      if (!learnedVersions?.length) return true;
      const currentActor = await authorize();
      if (
        currentActor?.id !== operation.scope.personId ||
        !(await learnedSkillVersionsCurrent(
          currentActor,
          threadId,
          agentId,
          learnedVersions,
          scopeBot,
        ).catch(() => false))
      )
        revokeLearnedContext();
      return !learnedContextRevoked;
    }

    const stopRevokedContext = (externalOutcome?: "executed") =>
      database.transaction((tx) =>
        stopDirectChatRun(tx, key, CONTEXT_REVOKED, traceRuns, {
          externalOutcome,
        }),
      );

    async function appendLearnedEvent(
      event: BaseEvent,
      options?: Parameters<typeof appendDirectChatEventInTransaction>[3],
    ) {
      if (!runnable || signal.aborted) return false;
      const versions = learnedVersions;
      const externalOutcome =
        options?.externalOutcome === "executed" ? "executed" : undefined;
      if (runContext.revoked) {
        await stopRevokedContext(externalOutcome);
        return false;
      }
      if (!versions?.length)
        return appendDirectChatEvent(database, key, event, options);
      const currentActor = await authorize();
      if (currentActor?.id !== operation.scope.personId) {
        revokeLearnedContext();
        await stopRevokedContext(externalOutcome);
        return false;
      }
      if (!runnable || signal.aborted) return false;
      return database.transaction(async (tx) => {
        // Hold the grant and evidence locks through publication, as in receipt settlement.
        const current = await lockLoadedSkillAuthorization(
          tx,
          currentActor,
          learningScope(threadId, agentId, currentActor.id),
          scopeBot,
          versions,
        );
        if (!current || runContext.revoked) {
          revokeLearnedContext();
          await stopDirectChatRun(tx, key, CONTEXT_REVOKED, traceRuns, {
            externalOutcome,
          });
          return false;
        }
        if (!runnable || signal.aborted) return false;
        return appendDirectChatEventInTransaction(tx, key, event, options);
      });
    }
    let writes = Promise.resolve();
    let writeFailed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (reflectQuery && deps.reflect) {
        if (
          !(await appendDirectChatEvent(database, key, {
            type: EventType.RUN_STARTED,
            ...key,
          }))
        )
          return;
        if (!(await shouldContinue())) return;
        const content = await deps.reflect({
          personId: actor.id,
          botId: agentId,
          conversationId: threadId,
          runId: key.runId,
          query: reflectQuery,
          canContinue: shouldContinue,
        });
        if (!(await shouldContinue())) return;
        await appendDirectChatEvent(database, key, terminal(key, "completed"), {
          traceRuns,
          reply: { id: crypto.randomUUID(), content },
          streamReply: true,
        });
        return;
      }
      if (background?.literalAnswer) {
        await background.beforeDispatch?.();
        if (!(await shouldContinue())) return;
        await appendDirectChatEvent(database, key, terminal(key, "completed"), {
          traceRuns,
          reply: {
            id: answerMessageId(background.literalAnswer.botId, key.runId),
            content: background.literalAnswer.text,
          },
          streamReply: true,
        });
        return;
      }
      const usesLearningGuidance =
        !background ||
        (background.source !== "handoff" && !currentRun?.groupThreadId);
      const skills = usesLearningGuidance ? await currentGuidance() : [];
      if (!skills) {
        await shouldContinue();
        return;
      }
      const guidance = learningInstructions(skills);
      if (creditRun) {
        if (
          !(await appendDirectChatEvent(database, key, {
            type: EventType.RUN_STARTED,
            ...key,
          }))
        )
          return;
        const messagesForBilling = messages.flatMap(({ role, content }) =>
          (role === "user" || role === "assistant") &&
          typeof content === "string"
            ? [{ role, content }]
            : [],
        );
        const result = await creditRun.ledger
          .complete({
            id: creditRun.id,
            personId: actor.id,
            ...creditRun.request,
            messages: messagesForBilling,
            preferences: await conversationTestCreditModels(
              database,
              actor.id,
              agentId,
              threadId,
            ),
            beforeDispatch: shouldContinue,
          })
          .catch(
            (): Awaited<ReturnType<DirectChatTestCredit["complete"]>> => ({
              state: "unavailable",
            }),
          );
        if (!(await shouldContinue())) return;
        if (result.operation && currentRun)
          await appendDirectChatEvent(
            database,
            key,
            creditReceiptEvent(
              currentRun,
              result.operation,
              result.state === "completed",
            ),
          );
        if (result.state === "completed") {
          await appendLearnedEvent(terminal(key, "completed"), {
            traceRuns,
            reply: { id: crypto.randomUUID(), content: result.text },
            streamReply: true,
            externalOutcome: "executed",
          });
        } else {
          await appendLearnedEvent(
            {
              type: EventType.RUN_ERROR,
              code: result.state,
              message:
                result.reason ??
                (creditRun.request.confirmation.creditType === "paid"
                  ? managedRunError[result.state].replace(
                      /Test Credit/g,
                      "Paid Credit",
                    )
                  : managedRunError[result.state]),
            },
            { traceRuns },
          );
        }
        return;
      }
      if (trial) {
        if (
          !(await appendDirectChatEvent(database, key, {
            type: EventType.RUN_STARTED,
            ...key,
          }))
        )
          return;
        if (!(await shouldContinue())) return;
        const conversation = messages.flatMap(({ role, content }) =>
          (role === "user" || role === "assistant") &&
          typeof content === "string"
            ? [{ role, content }]
            : [],
        );
        const result = await trial.model.complete({
          ...operation,
          route: trial.route,
          messages: conversation,
          beforeRecovery: shouldContinue,
          beforeDispatch: async () => {
            await background?.beforeDispatch?.();
            if (!(await shouldContinue())) return false;
            const current = usesLearningGuidance ? await currentGuidance() : [];
            if (!current) return false;
            const versions = learnedSkillVersions(current);
            const [recorded] = await database
              .update(directChatRuns)
              .set({ dispatchedSkillVersions: versions })
              .where(
                and(
                  matchingRun(key),
                  eq(directChatRuns.status, "running"),
                  eq(directChatRuns.dispatchedAt, dispatchTime),
                  isNull(directChatRuns.dispatchedSkillVersions),
                ),
              )
              .returning({ id: directChatRuns.id });
            if (!recorded) return false;
            learnedVersions = versions;
            const instructions = learningInstructions(current);
            return instructions
              ? [{ role: "system", content: instructions }, ...conversation]
              : conversation;
          },
        });
        if (!(await shouldContinue())) return;
        if (result.state === "completed" && learnedVersions === undefined) {
          await stopRevokedContext("executed");
          return;
        }
        if (result.state === "completed") {
          await appendLearnedEvent(terminal(key, "completed"), {
            traceRuns,
            reply: {
              id:
                background?.source === "handoff"
                  ? answerMessageId(agentId, key.runId)
                  : crypto.randomUUID(),
              content: result.text,
            },
            streamReply: true,
            externalOutcome: "executed",
          });
        } else {
          const event = {
            type: EventType.RUN_ERROR,
            code: result.state,
            message: managedRunError[result.state],
          } satisfies BaseEvent;
          await appendLearnedEvent(event, {
            traceRuns,
            externalOutcome:
              result.state === "reconciling" ||
              result.state === "settled" ||
              result.state === "released"
                ? "unknown"
                : null,
          });
        }
        return;
      }
      if (!(await shouldContinue())) return;
      if (!agent) throw new Error("Bot unavailable.");
      agent.threadId = threadId;
      agent.agentId = agentId;
      const versions = continuation
        ? (continuation.snapshot.sourceVersions ?? [])
        : learnedSkillVersions(skills);
      learnedVersions = versions.filter(({ kind }) => kind === "learned_skill");
      if (
        versions.length ||
        continuation?.result.error === CONTEXT_REVOKED_MESSAGE
      ) {
        const memories = versions.filter(({ kind }) => kind === "memory");
        withRunContext(runContext, () =>
          trackRunContext(async () => {
            if (continuation?.result.error === CONTEXT_REVOKED_MESSAGE)
              return false;
            if (
              memories.length &&
              !(await deps.memoryVersionsCurrent?.(actor.id, agentId, memories))
            )
              return false;
            return learnedContextIsCurrent();
          }, versions),
        );
      }
      const seededMessages: RunAgentInput["messages"] = guidance
        ? [
            { id: crypto.randomUUID(), role: "system", content: guidance },
            ...messages,
          ]
        : messages;
      const runMessages = continuation
        ? turnMessages({
            seeded: [],
            historicIds: new Set(),
            turn: { id: key.runId, role: "user", content: "" },
            continuation,
          }).messages
        : seededMessages;
      const initiator = background?.initiator ?? PERSON_INITIATOR;
      const computerTools =
        (await deps.computerTools?.(actor, agentId, initiator)) ?? [];
      if (computerTools.length > 0)
        agent.use(new HeadlessToolsMiddleware(computerTools, initiator));
      agent.setMessages(runMessages);
      const input = turnInput({
        ...key,
        messages: runMessages,
        state: continuation?.snapshot.state ?? {},
        tools: computerTools,
        continuation,
        skill: background?.source === "group" ? background.skill : undefined,
      });
      /*
       * The hop's own statement, so the tools this Run is offered follow the depth the chain has
       * actually reached and the claim under which it may coordinate further. Without it the
       * delivery's Run read as a person's own: depth zero, no claim, and a notice went back to
       * asking another Bot for ever.
       */
      if (background?.source === "handoff")
        input.forwardedProps = {
          ...(input.forwardedProps ?? {}),
          openbotRun: background.assertion,
        };
      let failure = false;
      let marketPause: string | undefined;
      let waitingApprovalId: string | undefined;
      const completion = withRunContext(runContext, async () => {
        await verifyRunContext();
        await background?.beforeDispatch?.();
        return agent.runAgent(input, {
          onEvent: ({ event }) => {
            if (continuation && event.type === EventType.RUN_STARTED) return;
            if (
              event.type === EventType.CUSTOM &&
              event.name === "openbot.headless.waiting"
            ) {
              const waiting = z
                .object({ approvalId: z.string() })
                .safeParse(event.value);
              if (waiting.success) waitingApprovalId = waiting.data.approvalId;
              return;
            }
            if (event.type === EventType.RUN_ERROR) {
              failure = true;
              if (
                event.code === "MARKET_SKILL_PAUSED" &&
                typeof event.message === "string"
              )
                marketPause = event.message;
            } else if (event.type !== EventType.RUN_FINISHED) {
              writes = writes
                .then(async () => {
                  if (!runnable || writeFailed) return;
                  if (!(await appendLearnedEvent(event))) {
                    writeFailed = true;
                    if (learnedContextRevoked) abort();
                  }
                })
                .catch(() => {
                  writeFailed = true;
                });
            }
          },
        });
      });
      await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              agent.abortRun();
              reject(new Error("The Bot run timed out."));
            },
            Math.max(
              0,
              (dispatched.dispatchedAt?.getTime() ?? Date.now()) +
                directChatRunTimeoutMs -
                Date.now(),
            ),
          );
        }),
      ]);
      const reply = agent.messages
        .slice(runMessages.length)
        .findLast(
          (message) =>
            message.role === "assistant" &&
            typeof message.content === "string" &&
            message.content.trim(),
        );
      await writes;
      if (!(await shouldContinue())) return;
      if (runContext.revoked) {
        await stopRevokedContext();
        return;
      }
      if (waitingApprovalId && !writeFailed && !failure) {
        if (!(await learnedContextIsCurrent())) {
          await stopRevokedContext();
          return;
        }
        const approval = await approvalCheckpoint(
          key,
          waitingApprovalId,
          actor.id,
        );
        if (
          approval &&
          approval.action.botId === agentId &&
          approval.action.continuation
        ) {
          await database
            .update(directChatRuns)
            .set({
              waitingApprovalId,
              dispatchedAt: null,
              externalOutcome: null,
            })
            .where(and(matchingRun(key), eq(directChatRuns.status, "running")));
          return;
        }
      }
      if (marketPause) {
        await appendLearnedEvent(
          {
            type: EventType.RUN_ERROR,
            message: marketPause,
            code: "MARKET_SKILL_PAUSED",
          },
          {
            traceRuns,
            ...(background && { externalOutcome: "unknown" as const }),
          },
        );
        return;
      }
      if (writeFailed || failure || !reply || typeof reply.content !== "string")
        throw new Error("Bot returned no text.");
      await appendLearnedEvent(terminal(key, "completed"), {
        traceRuns,
        reply: {
          id:
            background?.source === "handoff"
              ? answerMessageId(agentId, key.runId)
              : reply.id,
          content: reply.content,
        },
        ...(background && { externalOutcome: "executed" as const }),
      });
    } catch {
      await writes;
      if (!(await shouldContinue())) return;
      const billingFailure = background?.metered?.failure();
      if (billingFailure) {
        await database
          .update(directChatRuns)
          .set({
            dispatchedAt: null,
            externalOutcome: null,
            partialReply: null,
            partialMessageId: null,
          })
          .where(
            and(
              matchingRun(key),
              eq(directChatRuns.status, "running"),
              eq(directChatRuns.dispatchedAt, dispatchTime),
            ),
          );
        throw billingFailure;
      }
      await appendLearnedEvent(terminal(key, "failed"), {
        traceRuns,
        ...((trial || background) &&
          !reflectQuery && { externalOutcome: "unknown" }),
      });
    } finally {
      finished = true;
      clearTimeout(watcher);
      signal.removeEventListener("abort", abort);
      clearTimeout(timer);
    }
  }

  return {
    routes,
    learnedSkillVersionsCurrent,
    runBackground,
    backgroundApproval,
    learningConversations,
    sweepLearning: () =>
      learning.sweep(({ personId, threadId, botId: agentId }) => async (tx) => {
        if (deps.singleUser && personId === DEV_ACTOR.id)
          return threadFor(tx, DEV_ACTOR, threadId, agentId, true);
        const roles = await createRoleRepository(tx).rolesForUser(personId);
        const role = roles.includes("admin")
          ? "admin"
          : roles.includes("user")
            ? "user"
            : null;
        return role
          ? threadFor(tx, { id: personId, role }, threadId, agentId, true)
          : null;
      }),
  };
}
