import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { and, eq, sql } from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import { PERSON_INITIATOR } from "../audit";
import type { GroupConversations } from "../channels/group";
import type { ChannelStore } from "../channels/routes";
import type { Database } from "../db/client";
import {
  intelligenceChannelMappings,
  responsibilityRuns,
  routineRuns,
} from "../db/schema";
import type { DeliveryScope } from "../delivery/types";
import type { ResponsibilityStore } from "../responsibilities/types";
import {
  isMarketVersionPause,
  marketRunPauseReason,
} from "../skill-market/disablements";
import type { ApprovalResumeDependencies, ApprovalService } from "./service";

export type ApprovalContinuationDependencies = {
  approvalService: Pick<ApprovalService, "store">;
  database: Database;
  responsibilityStore: ResponsibilityStore;
  groupConversations: Pick<GroupConversations, "continueWaiting">;
  approvalContinuationRunner: TurnRunner;
  channelStore: Pick<ChannelStore, "recordActivity">;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  notify: (
    scope: DeliveryScope,
    input: { id: string; text: string; kind: "reply" },
  ) => Promise<void>;
  /**
   * Resolves once the thread's stored history holds a carried-on turn's reply, or gives up.
   *
   * The conversation reads its history again when the channel says the Bot replied, and the
   * platform's read of a thread can trail the run that wrote it. Told first, the browser read the
   * reply half written ("...shared with") and kept that half, because a message it already holds is
   * never read twice. So the channel is told, and the request finished, only once the reply is there
   * to read. Absent, the channel is told at once.
   */
  transcriptHolds?: (input: {
    ownerUserId: string;
    threadId: string;
    replyText: string;
  }) => Promise<void>;
};

/** Return an Approval's result to the Bot run that requested it. */
export async function continueApproval(
  deps: ApprovalContinuationDependencies,
  ownerUserId: string,
  {
    continuation: snapshot,
    result,
    messageId,
    approvalId,
    pauseReason,
  }: Parameters<ApprovalResumeDependencies["continue"]>[0],
): ReturnType<ApprovalResumeDependencies["continue"]> {
  const {
    approvalService,
    database,
    responsibilityStore,
    groupConversations,
    approvalContinuationRunner,
    channelStore,
    actorFor,
  } = deps;
  const request = await approvalService.store.get(ownerUserId, approvalId);
  pauseReason ??=
    (await marketRunPauseReason(database, request.action)) ?? undefined;
  const [waitingRun] = await database
    .select({ id: responsibilityRuns.id })
    .from(responsibilityRuns)
    .where(
      and(
        eq(responsibilityRuns.status, "waiting"),
        sql`${responsibilityRuns.waiting}->>'approvalId' = ${approvalId}`,
      ),
    )
    .limit(1);
  if (waitingRun) {
    if (pauseReason) {
      await database
        .update(responsibilityRuns)
        .set({
          status: "skipped",
          error: pauseReason,
          finishedAt: new Date(),
          waiting: null,
        })
        .where(
          and(
            eq(responsibilityRuns.id, waitingRun.id),
            eq(responsibilityRuns.status, "waiting"),
          ),
        );
      return { pauseReason };
    }
    await responsibilityStore.resumeWaiting(ownerUserId, waitingRun.id, result);
    return;
  }
  // A Shared Goal's Approval carries no conversation on: its Run above was the turn.
  if (request.action.dispatch === "corsair-shared-goal") return;
  /*
   * ASKING AGAIN IS WHERE THE TURN STOPS, NOT A FAILURE. A carried-on turn that reaches
   * another action needing the person opens its own request and stops on it, nothing
   * done, exactly as a run in the browser does. Thrown on from here, the resume loop
   * took it for a failure: it released this decision and carried the conversation on
   * again, from the same place, until its tries ran out, while the new request sat
   * pending where nobody was shown it. Now this decision is finished, the conversation
   * says what it waits on, and the new request carries it on when it is answered.
   */
  let waitingOn: { message: string; approvalId?: string } | undefined;
  let outcome: { replyText: string };
  try {
    // A group turn's approval also writes the resumed reply into the shared transcript.
    outcome = await groupConversations.continueWaiting(
      approvalId,
      () =>
        approvalContinuationRunner({
          ownerUserId: ownerUserId,
          routineId: "approval",
          agentId: request.action.botId,
          threadId: snapshot.threadId,
          instruction: "",
          initiator: snapshot.initiator ?? PERSON_INITIATOR,
          continuation: { snapshot, result, messageId },
        }),
      pauseReason,
    );
  } catch (error) {
    if (error instanceof HeadlessToolSuspension) {
      waitingOn = {
        message: error.message,
        ...(typeof error.waiting.approvalId === "string"
          ? { approvalId: error.waiting.approvalId }
          : {}),
      };
      outcome = { replyText: "" };
    } else if (error instanceof Error && isMarketVersionPause(error.message)) {
      pauseReason = error.message;
      outcome = { replyText: pauseReason };
    } else throw error;
  }
  if (outcome.replyText && !pauseReason)
    await deps.transcriptHolds?.({
      ownerUserId: ownerUserId,
      threadId: snapshot.threadId,
      replyText: outcome.replyText,
    });
  const [source] = await database
    .select({ channelId: intelligenceChannelMappings.channelId })
    .from(intelligenceChannelMappings)
    .where(
      and(
        eq(intelligenceChannelMappings.userId, ownerUserId),
        eq(intelligenceChannelMappings.threadId, snapshot.threadId),
      ),
    )
    .limit(1);
  if (source && outcome.replyText)
    await channelStore.recordActivity(
      await actorFor(ownerUserId),
      source.channelId,
      {
        text: outcome.replyText,
        agentId: request.action.botId,
        at: new Date(),
      },
      { id: messageId },
    );
  // The conversation's last line says what it waits on, and its card is read with it.
  if (source && waitingOn)
    await channelStore.recordActivity(
      await actorFor(ownerUserId),
      source.channelId,
      {
        text: waitingOn.message,
        agentId: request.action.botId,
        at: new Date(),
      },
      { id: `${messageId}:waiting` },
    );
  // A decision made in Slack, SMS or the phone gets its result back there too.
  if (source && outcome.replyText)
    await deps.notify(
      {
        ownerUserId: ownerUserId,
        channelId: source.channelId,
        agentId: request.action.botId,
        threadId: snapshot.threadId,
      },
      { id: messageId, text: outcome.replyText, kind: "reply" },
    );
  // A routine run waiting on this decision now waits on the request its turn opened.
  if (waitingOn) {
    if (waitingOn.approvalId)
      await database
        .update(routineRuns)
        .set({
          waiting: sql`jsonb_set(${routineRuns.waiting}, '{approvalId}', to_jsonb(${waitingOn.approvalId}::text))`,
        })
        .where(
          and(
            eq(routineRuns.status, "waiting"),
            sql`${routineRuns.waiting}->>'approvalId' = ${approvalId}`,
          ),
        );
    return;
  }
  await database
    .update(routineRuns)
    .set({
      status: pauseReason ? "skipped" : "succeeded",
      finishedAt: new Date(),
      error: pauseReason ?? null,
      waiting: null,
    })
    .where(
      and(
        eq(routineRuns.status, "waiting"),
        sql`${routineRuns.waiting}->>'approvalId' = ${approvalId}`,
      ),
    );
  if (pauseReason) return { pauseReason };
}
