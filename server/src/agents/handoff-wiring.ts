import { createHash, randomUUID } from "node:crypto";
import { IntelligenceAgentRunner } from "@copilotkit/runtime/v2";
import { workOwner } from "@openbot/shared/work-owner";
import { and, desc, eq, inArray } from "drizzle-orm";
import { type AuditStore, handoffInitiator } from "../audit";
import { BackgroundConversationBusy } from "../channels/direct-chat";
import type { BackgroundModel } from "../billing/background-model";
import { budgetedAgent } from "../billing/background-model-turn";
import type { GroupConversations } from "../channels/group";
import type { ChannelStore } from "../channels/routes";
import type { ThreadIdentity } from "../channels/thread-identity";
import type { DeploymentConfig } from "../config";
import type { mountCopilotRuntime } from "../copilot";
import type { Database } from "../db/client";
import { reasonWithoutStatement } from "../db/query-failure";
import {
  agentProfiles,
  agents,
  channels,
  directChatRunEvents,
  directChatRuns,
  groupBotThreads,
  intelligenceChannelMappings,
} from "../db/schema";
import type { ProductTelemetry } from "../telemetry/product";
import {
  productHandoffAnalyticsContext,
  productHandoffInput,
} from "../telemetry/product-boundaries";
import { repeatAfterEach } from "../work/loop";
import {
  createWorkQueue,
  startWorkOfferedListener,
  type WorkOfferedListener,
} from "../work/queue";
import { HANDOFF_KIND } from "./handoff";
import { createHandoffDelivery, ThreadBusyError } from "./handoff-delivery";
import {
  createHandoffRunner,
  type HandoffDelivery,
  type HandoffWork,
} from "./handoff-runner";
import { signHandoffDeliveryRun } from "./handoff-signing";
import type { AgentActor } from "./profile-types";
import { serverTurnAdmission } from "./turn-admission";

/**
 * Why a hop waiting on its busy conversation has nowhere left to go, read from this deployment's
 * own rows, or null while it does.
 *
 * Only a hop that answers in a conversation (`answerIn`) waits on one. Gone means positively gone:
 * the Bot that would speak was deleted, or the conversation the thread belongs to was. A thread this
 * cannot place is waited for, since a lock nobody renews lapses on its own within two minutes.
 */
export function answerGoneFrom(database: Database) {
  return async (work: HandoffWork): Promise<string | null> => {
    const threadId = work.answerIn;
    if (!threadId) return null;
    const [bot] = await database
      .select({ deletedAt: agentProfiles.deletedAt })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, work.toBotId))
      .limit(1);
    if (bot?.deletedAt) return "the Bot it was to speak as was deleted";
    const [direct] = await database
      .select({ deletedAt: channels.deletedAt })
      .from(intelligenceChannelMappings)
      .innerJoin(
        channels,
        eq(channels.id, intelligenceChannelMappings.channelId),
      )
      .where(eq(intelligenceChannelMappings.threadId, threadId))
      .limit(1);
    const [group] = direct
      ? []
      : await database
          .select({ deletedAt: channels.deletedAt })
          .from(groupBotThreads)
          .innerJoin(channels, eq(channels.id, groupBotThreads.channelId))
          .where(eq(groupBotThreads.threadId, threadId))
          .limit(1);
    if ((direct ?? group)?.deletedAt)
      return "the conversation it was going to was deleted";
    return null;
  };
}

/**
 * The display names of these Bots, by id, read from this deployment's own rows. A Bot that is gone
 * is left out, and the caller says "another Bot" for it.
 */
export function botNamesFrom(database: Database) {
  return async (
    botIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> =>
    new Map(
      (
        await database
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, [...botIds]))
      ).map((row) => [row.id, row.name]),
    );
}

export function createOpenBotHandoffDelivery(options: {
  runBackground: NonNullable<
    ReturnType<typeof mountCopilotRuntime>["runBackground"]
  >;
  actorFor: (personId: string) => Promise<AgentActor>;
  mayAddress: (fromBotId: string, toBotId: string) => Promise<boolean>;
  channelStore: ChannelStore;
  database: Database;
  groupConversations: GroupConversations;
  backgroundModel?: BackgroundModel;
  authorizeBudgetedWork?: Parameters<
    typeof createHandoffDelivery
  >[0]["authorizeBudgetedWork"];
  coordination?: Parameters<typeof createHandoffDelivery>[0]["coordination"];
}): HandoffDelivery {
  const announce = announceDeliveredFrom({
    database: options.database,
    actorFor: options.actorFor,
    groupConversations: options.groupConversations,
    channelStore: options.channelStore,
  });
  return {
    async deliver({
      work,
      message,
      shown,
      key,
      signal,
      beforeDispatch,
      claim,
    }) {
      const runId = createHash("sha256").update(key).digest("hex");
      const conversationBotId = work.answerIn ? work.toBotId : work.fromBotId;
      const threadId = work.answerIn ?? work.threadId;
      const authorize = async () => {
        const actor = await options.actorFor(work.actorId).catch(() => null);
        if (
          !actor ||
          (!work.answerIn &&
            !(await options.mayAddress(work.fromBotId, work.toBotId)))
        )
          return null;
        return actor;
      };
      let metered: ReturnType<typeof budgetedAgent> | undefined;
      if (work.budgetId && work.answer === undefined) {
        if (!claim) throw new Error("The Delegation lease is unavailable.");
        metered = budgetedAgent(
          options.backgroundModel,
          {
            kind: "delegation",
            executionId: claim.key,
            budgetId: work.budgetId,
            parentRunId: work.runId,
            personId: work.actorId,
            botId: work.toBotId,
          },
          async () => {
            await beforeDispatch?.();
            await options.authorizeBudgetedWork?.(work);
            if (!(await authorize()) || !(await claim.isCurrent()))
              throw new Error("The Delegation is no longer authorized.");
          },
          options.coordination
            ? (run) =>
                options.coordination?.(work, claim, run) ?? Promise.resolve([])
            : undefined,
          signal,
        );
      }
      const result = await options
        .runBackground({
          source: "handoff",
          id: runId,
          threadId,
          conversationBotId,
          personId: work.actorId,
          agentId: work.toBotId,
          prompt: message,
          shown: shown ?? (work.answerIn ? "" : work.task),
          ...(work.answerIn
            ? {
                literalAnswer:
                  work.answer === undefined
                    ? undefined
                    : { botId: work.fromBotId, text: work.answer },
              }
            : { handoffFromBotId: work.fromBotId }),
          authorize,
          metered,
          signal,
          beforeDispatch,
          initiator: handoffInitiator(work.fromBotId, work.initiator),
        })
        .catch((error: unknown) => {
          if (error instanceof BackgroundConversationBusy) {
            throw new ThreadBusyError(error.message);
          }
          throw error;
        });
      /*
       * Only once the Run is on record, and only when it said something: a conversation lifted to the
       * top of somebody's list for a turn that failed, or said nothing, is a conversation they open to
       * find nothing new. A hop finishes with no browser attached, so nobody else reports it.
       *
       * Not a shared Conversation: a relayed answer is written into its transcript as its own
       * message, and a line from here would be a second one. (A failed hop's notice there is
       * written by nothing yet; see docs/evidence/routine-handoff-37.md.)
       *
       * Told on every delivery, not only the one that ran the Bot: a worker lost between the answer
       * landing and the telling is not the one that tells; the next delivery is. Told of when the
       * answer landed, because the roster only goes forward: a delivery told again moves nothing.
       * The Run's events go after an hour and its row stays, so once they are gone, when the Run
       * started stands in. The database stamped both, so it is earlier by the same clock, and still
       * moves nothing. Only a Run that cannot be read at all is told as now. An answer settled onto
       * a failed Run has no event of its own, and is told at that failure.
       */
      if (!result.shared && result.replyText) {
        const [landed] = await options.database
          .select({ at: directChatRunEvents.createdAt })
          .from(directChatRunEvents)
          .where(
            and(
              eq(directChatRunEvents.threadId, threadId),
              eq(directChatRunEvents.runId, runId),
            ),
          )
          .orderBy(desc(directChatRunEvents.cursor))
          .limit(1)
          .catch(() => []);
        let at = landed?.at;
        if (!at) {
          const [run] = await options.database
            .select({ startedAt: directChatRuns.startedAt })
            .from(directChatRuns)
            .where(
              and(
                eq(directChatRuns.threadId, threadId),
                eq(directChatRuns.id, runId),
              ),
            )
            .limit(1)
            .catch(() => []);
          at = run?.startedAt;
        }
        await announce({
          actorId: work.actorId,
          threadId,
          // Under the Conversation's own Bot: the roster's line names a Bot that is in it.
          agentId: conversationBotId,
          text: result.replyText,
          at,
        }).catch((error: unknown) => {
          // The turn happened. A roster that has not caught up is worth less than a hop reported
          // as failed and run a second time. A telling dropped here is dropped for good: the hop
          // finishes, and nothing delivers it again unless its worker is lost before that.
          console.error(
            JSON.stringify({
              type: "handoff-activity-unrecorded",
              key,
              runId,
              reason: reasonWithoutStatement(error),
            }),
          );
        });
      }
      await options.channelStore.signalWork(threadId).catch(() => {});
      return {
        answer: result.replyText,
        conversationRunId: runId,
        relayRequired: result.shared,
      };
    },
  };
}

/**
 * The roster, told that a delivered Bot's answer landed. A delivery knows only the thread it ran in;
 * this resolves which channel shows that thread — a scratch thread maps to nothing and announces
 * nowhere, which is the point of a scratch thread.
 */
function announceDeliveredFrom({
  database,
  actorFor,
  groupConversations,
  channelStore,
}: {
  database: Database;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  groupConversations: GroupConversations;
  channelStore: ChannelStore;
}): NonNullable<Parameters<typeof createHandoffDelivery>[0]["announce"]> {
  return async (input) => {
    const [mapped] = await database
      .select({ channelId: intelligenceChannelMappings.channelId })
      .from(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.threadId, input.threadId))
      .limit(1);
    // A Bot's group thread maps to no channel; its answer goes to the shared transcript, marked
    // as the answering Bot's rather than the thread's own.
    if (!mapped) {
      await groupConversations.announceHandoff({
        threadId: input.threadId,
        actorId: input.actorId,
        agentId: input.answeredBy ?? input.agentId,
        text: input.text,
      });
      return;
    }
    const actor = await actorFor(input.actorId);
    await channelStore.recordActivity(actor, mapped.channelId, {
      text: input.text,
      agentId: input.agentId,
      at: input.at ?? new Date(),
    });
  };
}

/**
 * Handing work between Bots, started on this replica: the runner that claims hops, the delivery
 * that runs the addressed Bot, and the loop and queue wake-up that drive them.
 *
 * Moved out of index.ts verbatim. Returns the queue's wake-up listener, which index.ts holds so its
 * shutdown can give the connection back. Called only where handing work between Bots is on.
 */
export async function startHandoffDelivery(deps: {
  backgroundModel?: BackgroundModel;
  authorizeBudgetedWork?: Parameters<
    typeof createHandoffDelivery
  >[0]["authorizeBudgetedWork"];
  budgetedCoordination?: Parameters<
    typeof createHandoffDelivery
  >[0]["coordination"];
  productTelemetry?: ProductTelemetry;
  config: DeploymentConfig;
  database: Database;
  bootAuditStore: AuditStore;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  mayAddress: (fromBotId: string, toBotId: string) => Promise<boolean>;
  copilotRuntime: ReturnType<typeof mountCopilotRuntime>;
  threadIdentity: ThreadIdentity;
  groupConversations: GroupConversations;
  channelStore: ChannelStore;
}): Promise<WorkOfferedListener> {
  const {
    config,
    database,
    bootAuditStore,
    actorFor,
    copilotRuntime,
    threadIdentity,
    groupConversations,
    channelStore,
  } = deps;
  const productTelemetry = deps.productTelemetry;
  const runner = createHandoffRunner({
    queue: createWorkQueue(database),
    owner: workOwner("handoff"),
    auditStore: bootAuditStore,
    /*
     * The signed statement of the run the addressed Bot is about to start, carrying how deep the
     * chain has gone. Minted here, where the key lives, and one deeper than the run that asked.
     */
    sign: (work, claim) =>
      signHandoffDeliveryRun(work, config.keyEncryptionKey, undefined, claim),
    // The asking conversation, told what it is waiting on once the queue has moved for a hop.
    onSettled: (work) => channelStore.signalWork(work.threadId),
    answerGone: answerGoneFrom(database),
    delivery: copilotRuntime.runBackground
      ? createOpenBotHandoffDelivery({
          runBackground: copilotRuntime.runBackground,
          actorFor,
          mayAddress: deps.mayAddress,
          channelStore,
          database,
          groupConversations,
          backgroundModel: deps.backgroundModel,
          authorizeBudgetedWork: deps.authorizeBudgetedWork,
          coordination: deps.budgetedCoordination,
        })
      : createHandoffDelivery({
          backgroundModel: deps.backgroundModel,
          authorizeBudgetedWork: deps.authorizeBudgetedWork,
          coordination: deps.budgetedCoordination,
          ...(productTelemetry
            ? {
                prepareRunInput: (input, work) =>
                  productHandoffInput(
                    productTelemetry,
                    input,
                    work.actorId,
                    work.runId,
                  ),
                onKnownStop: productTelemetry.stopKnown,
                analyticsContextFor: (run, work) =>
                  productHandoffAnalyticsContext(
                    productTelemetry,
                    run,
                    work.actorId,
                    work.runId,
                  ),
              }
            : {}),
          admission: serverTurnAdmission,
          /*
           * Built as the person, WITH THEIR ROLE. The desk resolved it to decide the hop was allowed; a
           * delivery that then rebuilt them as an ordinary user could not find the Bot the desk had just
           * agreed to, and the person was told it never answered.
           */
          agentFor: async ({ actorId, botId, fromBotId, initiator }) => {
            const actor = await actorFor(actorId).catch(() => null);
            if (!actor) {
              throw new Error(
                "who this is for could not be confirmed, so the Bot was not run",
              );
            }
            return copilotRuntime.agentFor({
              actor,
              botId,
              initiator: handoffInitiator(fromBotId, initiator),
            });
          },
          history: copilotRuntime.history,
          lock: copilotRuntime.threadLock,
          recordStopFor: copilotRuntime.stopRecorder,
          /*
           * A scratch thread of the addressed Bot's own, one per hop.
           *
           * An Intelligence thread has exactly one agent, so a second Bot cannot answer inside the first
           * Bot's conversation however it asks. Its turn runs here instead, unmapped to any channel, and
           * what it said comes back to the conversation that asked through the relay, written there
           * word for word as its own message. Minted with the deployment's own identity, like every
           * thread this deployment starts.
           */
          mintThreadId: () => threadIdentity.mint(),
          // The roster, told that a relayed answer landed; see `announceDeliveredFrom`.
          announce: announceDeliveredFrom({
            database,
            actorFor,
            groupConversations,
            channelStore,
          }),
          // The asking conversation shown as working while a hop runs in it. Keyed by thread, resolved
          // to its channel by the store; a scratch thread maps to none and signals nowhere.
          setBusy: (input) =>
            channelStore.signalBusy(input.threadId, input.busy),
          // Who answered, for another Bot's answer in the conversation a forward hop quotes.
          botNames: botNamesFrom(database),
          newRunId: () => randomUUID(),
          // The same address and the same token the runtime uses. Assembling either from configuration
          // produced a runner every join was refused for, because the thread's active run is a lock the
          // platform issues rather than something an API key can claim.
          runner: new IntelligenceAgentRunner(
            copilotRuntime.runnerConnection(),
          ) as never,
        }),
  });

  const sweep = async () => {
    try {
      const report = await runner.sweep();
      if (report.delivered.length > 0 || report.skipped.length > 0) {
        console.info(JSON.stringify({ type: "bot-handoff", ...report }));
      }
    } catch (error) {
      // A sweep that failed must not take the loop with it: the next one may find the database back.
      console.warn(
        "[handoff] a sweep could not run:",
        error instanceof Error ? error.message : error,
      );
    }
  };

  /*
   * ONE SWEEP AT A TIME ON THIS REPLICA, from both callers below. A sweep poked while one is
   * running is remembered rather than started, and runs once the current one ends — a wake-up
   * that arrived mid-sweep may be for a hop the running sweep's claim already missed.
   */
  let sweeping = false;
  let sweepAgain = false;
  const kick = async () => {
    if (sweeping) {
      sweepAgain = true;
      return;
    }
    sweeping = true;
    try {
      do {
        sweepAgain = false;
        await sweep();
      } while (sweepAgain);
    } finally {
      sweeping = false;
    }
  };

  /*
   * Woken by the queue itself, from any replica: a person is waiting through every hop, and the
   * poll below would spend up to two seconds per leg doing nothing. The poll stays as the
   * backstop — a notification is a latency optimisation, and one lost in transit costs one
   * interval, never the work. See repeatAfterEach for why an interval must not be used: an
   * interval would start another sweep every two seconds while a five-minute delivery runs, each
   * claiming a different batch, and this replica's concurrent agent runs would grow with the
   * backlog rather than stopping at the limit it was asked for.
   */
  const listener = await startWorkOfferedListener(
    config.databaseUrl,
    (kind) => {
      if (kind === HANDOFF_KIND) void kick();
    },
  );
  repeatAfterEach(kick, 2_000);
  return listener;
}
