import { buildResponsibilityTurn } from "@openbot/shared/responsibility-turn";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { and, eq, isNull, ne, notExists } from "drizzle-orm";
import { z } from "zod";
import { HANDOFF_KIND } from "../agents/handoff";
import { createHandoffRunner } from "../agents/handoff-runner";
import { signHandoffDeliveryRun } from "../agents/handoff-signing";
import { isBotPaused } from "../agents/lifecycle";
import {
  createWakeUpRunner,
  createWakeUpStore,
  WAKE_UP_KIND,
  WAKE_UP_MIN_DELAY_MS,
  WakeUpRefusedError,
} from "../agents/wake-up";
import { createAuditStore } from "../audit";
import {
  createGroupConversations,
  createGroupStore,
  GROUP_TURN_KIND,
  GroupRefusedError,
  groupTurnSchema,
  submitGroupTurn,
} from "../channels/group";
import type { Database } from "../db/client";
import {
  agentProfiles,
  channelAgents,
  channelMemberships,
  channels,
  groupBotThreads,
  intelligenceChannelMappings,
  pluginGrants,
  responsibilities as responsibilityRows,
  responsibilityRuns,
} from "../db/schema";
import { personalWorkspaces } from "../db/schema/personal-saas";
import { createProactiveEngine, PROACTIVE_RUN_KIND } from "../proactive/engine";
import { createProactiveStore } from "../proactive/store";
import {
  ProactiveNotFoundError,
  ProactiveRefusedError,
} from "../proactive/types";
import {
  createResponsibilityEngine,
  RESPONSIBILITY_RUN_KIND,
} from "../responsibilities/engine";
import { createResponsibilityStore } from "../responsibilities/store";
import {
  ResponsibilityNotFoundError,
  ResponsibilityRefusedError,
  whyItRepeats,
} from "../responsibilities/types";
import { markUntrusted } from "../untrusted-content";
import { currentWorkGrant } from "../work/execution";
import { createWorkQueue } from "../work/queue";
import { type Transaction, workspaceConversations } from "./store";
import { workspaceBots } from "./workspace-bots";
import { workspaceResourceOwner } from "./workspace-principal";

const wakeUpRequest = z.object({
  ownerUserId: z.string(),
  agentId: z.string(),
  channelId: z.string().optional(),
  reason: z.string().min(1),
  instruction: z.string().optional(),
});
const handoffRequest = z.object({
  actorId: z.string(),
  fromBotId: z.string(),
  toBotId: z.string(),
  threadId: z.string(),
  task: z.string().min(1),
  constraints: z.string().optional(),
  expecting: z.string().optional(),
  answerIn: z.string().optional(),
});

type Connection = Database | Transaction;

async function authorizedBot(
  database: Connection,
  accountId: string,
  owner: string,
  agentId: string,
) {
  const [workspace] = await database
    .select({ id: personalWorkspaces.id })
    .from(personalWorkspaces)
    .where(eq(personalWorkspaces.ownerId, accountId));
  if (
    !workspace ||
    (owner !== workspaceResourceOwner(workspace.id) && owner !== accountId)
  )
    return;
  return workspaceBots(database).get({
    accountId,
    workspaceId: workspace.id,
    botId: agentId,
  });
}

async function ownsConversation(
  database: Connection,
  accountId: string,
  channelId: string,
) {
  const owned = workspaceConversations(database, { accountId }).as("owned");
  const [channel] = await database
    .select({ id: owned.id })
    .from(owned)
    .where(eq(owned.id, channelId));
  return Boolean(channel);
}

async function privateChannelBot(
  database: Connection,
  owner: string,
  channelId: string,
  agentId: string,
) {
  const [bot] = await database
    .select({ id: channelAgents.agentId })
    .from(channelAgents)
    .innerJoin(channels, eq(channels.id, channelAgents.channelId))
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, channelAgents.agentId))
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channels.id),
        eq(channelMemberships.userId, owner),
      ),
    )
    .where(
      and(
        eq(channels.id, channelId),
        eq(channelAgents.agentId, agentId),
        isNull(agentProfiles.deletedAt),
        isNull(channels.deletedAt),
        isNull(channels.packageId),
        notExists(
          database
            .select({ userId: channelMemberships.userId })
            .from(channelMemberships)
            .where(
              and(
                eq(channelMemberships.channelId, channelId),
                ne(channelMemberships.userId, owner),
              ),
            ),
        ),
      ),
    );
  return Boolean(bot);
}

async function handoffChannel(
  database: Connection,
  accountId: string,
  work: z.infer<typeof handoffRequest>,
) {
  if (work.answerIn || work.fromBotId === work.toBotId) return;
  if (!(await authorizedBot(database, accountId, work.actorId, work.toBotId)))
    return;
  const [group] = await database
    .select({ channelId: groupBotThreads.channelId })
    .from(groupBotThreads)
    .where(
      and(
        eq(groupBotThreads.threadId, work.threadId),
        eq(groupBotThreads.ownerUserId, work.actorId),
        eq(groupBotThreads.agentId, work.fromBotId),
      ),
    );
  const [direct] = group
    ? []
    : await database
        .select({ channelId: intelligenceChannelMappings.channelId })
        .from(intelligenceChannelMappings)
        .where(
          and(
            eq(intelligenceChannelMappings.threadId, work.threadId),
            eq(intelligenceChannelMappings.userId, work.actorId),
          ),
        );
  const source = group ?? direct;
  if (
    !source ||
    !(await privateChannelBot(
      database,
      work.actorId,
      source.channelId,
      work.fromBotId,
    ))
  )
    return;
  if (
    group &&
    !(await privateChannelBot(
      database,
      work.actorId,
      group.channelId,
      work.toBotId,
    ))
  )
    return;
  const [grant] = await database
    .select({ ref: pluginGrants.ref })
    .from(pluginGrants)
    .where(
      and(
        eq(pluginGrants.kind, "bot"),
        eq(pluginGrants.agentId, work.fromBotId),
        eq(pluginGrants.ref, work.toBotId),
      ),
    );
  return grant && { channelId: source.channelId, group: Boolean(group) };
}

function checkIns(
  database: Connection,
  now: () => number,
  accountFor: (owner: string) => string | undefined,
  runTurn: TurnRunner,
) {
  return createProactiveEngine({
    store: createProactiveStore(database),
    queue: createWorkQueue(database, now, { personalOnly: true }),
    owner: crypto.randomUUID(),
    runTurn,
    resolveScope: async (ownerUserId, channelId, agentId) => {
      const accountId = accountFor(ownerUserId);
      if (
        !accountId ||
        !(await authorizedBot(database, accountId, ownerUserId, agentId)) ||
        !(await ownsConversation(database, accountId, channelId))
      )
        return null;
      return { ownerUserId, channelId, agentId, threadId: channelId };
    },
    attention: { notifyAttention: async () => {} },
    catalogue: { listServers: async () => [] },
    mintThreadId: () => crypto.randomUUID(),
    now: () => new Date(now()),
  });
}

export async function retryBackgroundWork(
  tx: Transaction,
  now: () => number,
  accountId: string,
  kind: string,
  payload: Record<string, unknown>,
  runTurn: TurnRunner,
) {
  try {
    switch (kind) {
      case WAKE_UP_KIND: {
        const parsed = wakeUpRequest.safeParse(payload);
        if (!parsed.success) return;
        const work = parsed.data;
        if (
          !(await authorizedBot(tx, accountId, work.ownerUserId, work.agentId))
        )
          return;
        if (
          work.channelId &&
          !(await ownsConversation(tx, accountId, work.channelId))
        )
          return;
        const fresh = await createWakeUpStore(tx, {
          now: () => new Date(now()),
        }).schedule({
          ...work,
          dueAt: new Date(now() + WAKE_UP_MIN_DELAY_MS),
        });
        return fresh.id;
      }
      case PROACTIVE_RUN_KIND: {
        const settingId = z.string().min(1).safeParse(payload.settingId);
        if (!settingId.success) return;
        const setting = await createProactiveStore(tx).byId(settingId.data);
        if (
          !setting ||
          !(await authorizedBot(
            tx,
            accountId,
            setting.ownerUserId,
            setting.agentId,
          ))
        )
          return;
        const key = crypto.randomUUID();
        const result = await checkIns(tx, now, () => accountId, runTurn).runNow(
          setting.ownerUserId,
          setting.id,
          key,
        );
        return result.queued ? key : undefined;
      }
      case RESPONSIBILITY_RUN_KIND: {
        const runId = z.string().uuid().safeParse(payload.runId);
        if (!runId.success) return;
        const store = createResponsibilityStore(tx, {
          resolveTarget: async () => null,
        });
        const [goal] = await tx
          .select({
            id: responsibilityRows.id,
            ownerUserId: responsibilityRows.ownerUserId,
            status: responsibilityRows.status,
            agentId: responsibilityRows.agentId,
            channelId: responsibilityRows.channelId,
          })
          .from(responsibilityRuns)
          .innerJoin(
            responsibilityRows,
            eq(responsibilityRows.id, responsibilityRuns.responsibilityId),
          )
          .where(eq(responsibilityRuns.id, runId.data));
        if (!goal) return;
        if (
          goal.status !== "active" ||
          !(await authorizedBot(
            tx,
            accountId,
            goal.ownerUserId,
            goal.agentId,
          )) ||
          !(await ownsConversation(tx, accountId, goal.channelId))
        )
          return;
        const result = await store.ingestEvent({
          ownerUserId: goal.ownerUserId,
          responsibilityId: goal.id,
          source: "manual",
          externalId: crypto.randomUUID(),
          type: "requested",
          payload: {},
        });
        return result.runIds[0];
      }
      case GROUP_TURN_KIND: {
        const parsed = groupTurnSchema.safeParse(payload);
        if (!parsed.success) return;
        const { ownerUserId, channelId, agentIds, text } = parsed.data;
        for (const botId of agentIds) {
          if (
            !(await authorizedBot(tx, accountId, ownerUserId, botId)) ||
            !(await privateChannelBot(tx, ownerUserId, channelId, botId))
          )
            return;
        }
        const messageId = crypto.randomUUID();
        await submitGroupTurn(tx, {
          ownerUserId,
          channelId,
          agentIds,
          text,
          messageId,
        });
        return messageId;
      }
      case HANDOFF_KIND: {
        const parsed = handoffRequest.safeParse(payload);
        if (
          !parsed.success ||
          !(await handoffChannel(tx, accountId, parsed.data))
        )
          return;
        const runId = crypto.randomUUID();
        const offered = await createWorkQueue(tx, now).offer({
          kind,
          key: runId,
          payload: { ...parsed.data, runId, depth: 1 },
          accountId,
        });
        return offered === "queued" ? runId : undefined;
      }
    }
  } catch (error) {
    if (
      !(
        error instanceof WakeUpRefusedError ||
        error instanceof GroupRefusedError ||
        error instanceof ProactiveNotFoundError ||
        error instanceof ProactiveRefusedError ||
        error instanceof ResponsibilityNotFoundError ||
        error instanceof ResponsibilityRefusedError
      )
    )
      throw error;
  }
}

export function personalBackgroundWorkers(
  database: Database,
  now: () => number,
  encryptionKey: string,
  runTurn: TurnRunner,
) {
  const queue = createWorkQueue(database, now, { personalOnly: true });
  const owner = crypto.randomUUID();
  const auditStore = createAuditStore(database);
  const groupStore = createGroupStore(database, () => crypto.randomUUID());

  const accountFor = () => currentWorkGrant()?.accountId;
  const checkedTurn: TurnRunner = async (input) => {
    const accountId = accountFor();
    if (
      !accountId ||
      !(await authorizedBot(
        database,
        accountId,
        input.ownerUserId,
        input.agentId,
      )) ||
      (await isBotPaused(input.ownerUserId, input.agentId))
    )
      throw new Error("This Bot is unavailable to the workspace.");
    return runTurn({ ...input, ownerUserId: accountId });
  };

  const checkIn = checkIns(database, now, accountFor, checkedTurn);
  const responsibilities = createResponsibilityEngine({
    queue,
    store: createResponsibilityStore(database, {
      resolveTarget: async (ownerUserId, agentId, channelId) => {
        // beginRun resolves before it has entered the execution guard.
        const prefix = workspaceResourceOwner("");
        const principal = z
          .uuid()
          .safeParse(
            ownerUserId.startsWith(prefix)
              ? ownerUserId.slice(prefix.length)
              : ownerUserId,
          );
        if (!principal.success) return null;
        const [workspace] = await database
          .select({ accountId: personalWorkspaces.ownerId })
          .from(personalWorkspaces)
          .where(
            ownerUserId.startsWith(prefix)
              ? eq(personalWorkspaces.id, principal.data)
              : eq(personalWorkspaces.ownerId, principal.data),
          );
        if (
          !workspace ||
          !(await authorizedBot(
            database,
            workspace.accountId,
            ownerUserId,
            agentId,
          )) ||
          !(await ownsConversation(database, workspace.accountId, channelId))
        )
          return null;
        return { threadId: channelId };
      },
    }),
    runTurn: (context) =>
      checkedTurn({
        ownerUserId: context.ownerUserId,
        routineId: context.responsibilityId,
        runId: context.runId,
        agentId: context.agentId,
        threadId: context.threadId,
        initiator: { kind: "responsibility", id: context.responsibilityId },
        signal: context.signal,
        beforeDispatch: context.beforeDispatch,
        onText: context.onText,
        instruction: buildResponsibilityTurn({
          instruction: context.instruction,
          successCriteria: context.successCriteria,
          progress: context.progress,
          trigger: context.event,
          eventData: markUntrusted(
            JSON.stringify(context.event.payload),
            `${context.event.source} event`,
          ),
          responsibilityId: context.responsibilityId,
          ...(context.repeats
            ? { repeats: whyItRepeats(context.repeats) }
            : {}),
        }),
      }),
  });

  const wakeUp = createWakeUpRunner({
    queue,
    owner,
    store: createWakeUpStore(database),
    actorFor: async (id) => ({ id, role: "user" }),
    channels: {
      get: async (_actor, channelId) => {
        const accountId = accountFor();
        if (
          !accountId ||
          !(await ownsConversation(database, accountId, channelId))
        )
          throw new Error("This conversation is unavailable to the workspace.");
        return { id: channelId, threadId: channelId };
      },
      direct: async (actor, agentId) => {
        const accountId = accountFor();
        const bot =
          accountId &&
          (await authorizedBot(database, accountId, actor.id, agentId));
        if (!bot) throw new Error("This Bot is unavailable to the workspace.");
        const id = crypto.randomUUID();
        await database.transaction(async (tx) => {
          await tx
            .insert(channels)
            .values({ id, name: bot.name, description: "" });
          await tx.insert(channelAgents).values({ channelId: id, agentId });
        });
        return { id, threadId: id };
      },
      recordActivity: async (_actor, channelId, activity, source) => {
        const accountId = accountFor();
        if (!accountId || !activity.agentId) return;
        await database.transaction(async (tx) => {
          if (!(await ownsConversation(tx, accountId, channelId))) return;
          await tx
            .update(channels)
            .set({
              lastMessage: activity.text.slice(0, 500),
              lastMessageAt: activity.at,
              lastMessageAgentId: activity.agentId,
              lastMessageSourceId: source?.id,
            })
            .where(eq(channels.id, channelId));
        });
      },
    },
    runTurn: checkedTurn,
  });

  const groups = createGroupConversations({
    store: groupStore,
    queue,
    owner,
    auditStore,
    caps: { maxDepth: 0, maxPerRun: 0 },
    publishProgress: false,
    privateShare: async ({ ownerUserId, botId, audience }) =>
      (await privateChannelBot(database, ownerUserId, audience.id, botId))
        ? { status: "allowed", reason: "Only the workspace owner can read it." }
        : {
            status: "denied",
            message: "The group is no longer private to this workspace.",
          },

    mayAddress: async () => false,
    roster: async (ownerUserId, channelId) => {
      const accountId = accountFor();
      if (!accountId) return null;
      const linked = await database
        .select({ id: channelAgents.agentId })
        .from(channelAgents)
        .where(eq(channelAgents.channelId, channelId));
      const bots = [];
      for (const { id } of linked) {
        const bot = await authorizedBot(database, accountId, ownerUserId, id);
        if (
          bot &&
          (await privateChannelBot(database, ownerUserId, channelId, id))
        )
          bots.push(bot);
      }
      return bots.length ? bots : null;
    },
    runTurn: checkedTurn,
  });

  const handoffs = createHandoffRunner({
    queue,
    owner,
    auditStore,
    maxAttempts: 1,
    sign: (work, claim) =>
      signHandoffDeliveryRun(work, encryptionKey, work.runId, claim),
    delivery: {
      deliver: async ({ work, message, signal, beforeDispatch, onText }) => {
        const accountId = accountFor();
        const source =
          accountId && (await handoffChannel(database, accountId, work));
        if (!accountId || !source)
          throw new Error("This handoff is unavailable to the workspace.");
        const threadId = crypto.randomUUID();
        const result = await checkedTurn({
          ownerUserId: work.actorId,
          agentId: work.toBotId,
          routineId: work.runId,
          runId: work.runId,
          threadId,
          instruction: message,
          initiator: { kind: "handoff", id: work.fromBotId },
          signal,
          beforeDispatch,
          onText,
        });
        await beforeDispatch?.();
        const current = await handoffChannel(database, accountId, work);
        if (
          !current ||
          current.channelId !== source.channelId ||
          !result.replyText
        )
          return { answer: null };
        if (current.group) {
          await groupStore.append({
            id: `handoff:${work.runId}`,
            ownerUserId: work.actorId,
            channelId: current.channelId,
            agentId: work.toBotId,
            threadId,
            text: result.replyText,
            details: {},
          });
        } else {
          await database.transaction(async (tx) => {
            const bot = await authorizedBot(
              tx,
              accountId,
              work.actorId,
              work.toBotId,
            );
            if (!bot) return;
            await tx.insert(channels).values({
              id: threadId,
              name: bot.name,
              description: "",
              lastMessage: result.replyText.slice(0, 500),
              lastMessageAgentId: bot.id,
              lastMessageAt: new Date(),
            });
            await tx
              .insert(channelAgents)
              .values({ channelId: threadId, agentId: bot.id });
          });
        }
        return { answer: null };
      },
    },
  });

  return {
    checkIn: () => checkIn.drainRuns(),
    responsibility: () => responsibilities.dispatch({ owner, limit: 1 }),
    wakeUp: () => wakeUp.sweep(),
    group: () => groups.sweep(),
    handoff: () => handoffs.sweep(),
  };
}
