import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { headlessTurnRefusal } from "../../../admin/controls";
import { isBotPaused } from "../../../agents/lifecycle";
import type { AgentActor } from "../../../agents/profile-types";
import {
  type ApprovalRecord,
  currentApprovalContext,
} from "../../../approvals/types";
import { type AuditEventInput, recordAuditEvent } from "../../../audit";
import {
  githubPilotEventOutcomes,
  responsibilities,
  responsibilityRuns,
} from "../../../db/schema";
import type {
  ResponsibilityRunContext,
  ResponsibilityStore,
} from "../../../responsibilities/types";
import { corsairWriteKey, dispatchCorsairWrite } from "../cutover";
import {
  GITHUB_EVENT_ACCESS_ENDED,
  githubQueuedRunAuthorization,
} from "../event-run-access";
import { dispatchWhileConnected, RevocationRefusal } from "../revocation";
import { SlackPilotRefusal } from "./accounts";
import {
  createSlackWriteAccess,
  invocation,
  type Options,
  tool,
} from "./write-access";

const parameters = invocation.omit({ botId: true });
const targetSchema = z.object({
  connectionId: z.uuid(),
  channelId: invocation.shape.channelId,
});
const unconfirmed =
  "Slack did not confirm this write. Check the selected channel for the message from the approved Slack user before requesting another Approval.";

export function createSlackGoalAction(
  options: Omit<Options, "requireUser"> & {
    actorFor: (ownerUserId: string) => Promise<AgentActor>;
    githubEventAccess: Parameters<
      typeof githubQueuedRunAuthorization
    >[0]["service"];
  },
) {
  const { database, actorFor, approvals, audit, provider } = options;
  const access = createSlackWriteAccess(options);

  return {
    async toolFor(context: ResponsibilityRunContext) {
      const [origin] = await database
        .select({ triggerId: githubPilotEventOutcomes.triggerId })
        .from(githubPilotEventOutcomes)
        .where(eq(githubPilotEventOutcomes.runId, context.runId));
      if (!origin) return null;
      const actor = await actorFor(context.ownerUserId);
      if (!(await access.actorCanPost(actor, context.agentId))) return null;
      return {
        definition: {
          name: "corsair_slack_post_message",
          description:
            "Request one-time Approval to post a Slack message as the user's selected Slack Connection.",
          parameters: z.toJSONSchema(parameters),
        },
        async execute(
          args: unknown,
          _call: { toolCallId: string; signal?: AbortSignal },
        ) {
          const continuation = currentApprovalContext();
          if (!continuation)
            throw new Error("The Slack action needs a waiting Goal turn.");
          const selection = parameters.parse(args);
          const connectionId =
            selection.connectionId ??
            (await access.accounts.defaultConnectionId(actor.id));
          if (!connectionId)
            throw new SlackPilotRefusal(
              "Choose a verified Slack default or select a Connection for this action.",
              409,
            );
          const input = { ...selection, connectionId, botId: context.agentId };
          const connection = await access.permitted(actor, input);
          const action = access.actionFor(
            actor.id,
            input,
            connection,
            context.runId,
          );
          const approval = await approvals.open({
            ...action,
            dispatch: "corsair-slack-goal",
            threadId: context.threadId,
            toolCallId: continuation.toolCallId,
            continuation,
          });
          throw new HeadlessToolSuspension(
            "This Slack action is waiting for your approval.",
            {
              kind: "approval",
              approvalId: approval.id,
              requestId: approval.id,
              continuation,
            },
          );
        },
      };
    },

    async resume(
      record: ApprovalRecord,
      responsibilityStore: Pick<ResponsibilityStore, "resumeWaiting">,
      beforeDispatch?: () => Promise<void>,
    ) {
      const { action, ownerUserId: owner, id: approvalId } = record;
      if (record.status === "completed") return;
      const [binding] = await database
        .select({
          run: responsibilityRuns,
          goal: responsibilities,
        })
        .from(responsibilityRuns)
        .innerJoin(
          responsibilities,
          eq(responsibilities.id, responsibilityRuns.responsibilityId),
        )
        .where(
          and(
            eq(responsibilityRuns.id, action.runId),
            eq(responsibilities.ownerUserId, owner),
          ),
        );

      // A quick decision may reach the worker before the original turn records its suspension.
      if (binding?.run.status === "running") return "retry";
      const waiting = and(
        eq(responsibilityRuns.id, action.runId),
        eq(responsibilityRuns.status, "waiting"),
        sql`${responsibilityRuns.waiting}->>'approvalId' = ${approvalId}`,
      );
      const [origin] = await database
        .select()
        .from(githubPilotEventOutcomes)
        .where(eq(githubPilotEventOutcomes.runId, action.runId));
      const log = (
        eventType: AuditEventInput["eventType"],
        details: Record<string, unknown> = {},
      ) =>
        recordAuditEvent(audit, {
          eventType,
          actorUserId: owner,
          targetType: "slack_channel",
          targetId: targetSchema.safeParse(action.target).data?.channelId,
          initiator: binding
            ? { kind: "responsibility", id: binding.goal.id }
            : undefined,
          payload: {
            runId: action.runId,
            approvalId,
            receiptId: origin?.receiptId,
            triggerId: origin?.triggerId,
            botId: action.botId,
            tool: tool.ref,
            target: action.target,
            ...details,
          },
        });

      async function confirmed(
        channel: string,
        timestamp: string,
        reconciled = false,
      ) {
        await log("corsair.slack.write_succeeded", { timestamp, reconciled });
        return { content: `Slack message ${channel}/${timestamp}` };
      }

      async function reconcile(startedAt: Date) {
        const pinned = targetSchema.safeParse(action.target);
        const args = parameters.pick({ text: true }).safeParse(action.args);
        if (pinned.success && args.success) {
          const input = { ...pinned.data, ...args.data, botId: action.botId };
          const timestamp = await (async () => {
            const actor = await actorFor(owner);
            const { token, userId, revision } = await access.verifiedTarget(
              actor,
              input,
              action,
            );
            return dispatchWhileConnected(
              database,
              input.connectionId,
              revision,
              () =>
                provider.findGoalMessage({
                  token,
                  userId,
                  channel: input.channelId,
                  delivery: approvalId,
                  startedAt,
                }),
            );
          })().catch(() => undefined);
          if (timestamp) return confirmed(input.channelId, timestamp, true);
        }
        await log("corsair.slack.write_unconfirmed", { reason: unconfirmed });
        return { content: unconfirmed, error: unconfirmed };
      }

      async function dispatch(): Promise<
        NonNullable<ApprovalRecord["result"]> | undefined
      > {
        if (record.status === "consumed")
          return reconcile(record.consumedAt ?? record.createdAt);
        try {
          if (record.status !== "approved" || record.decision !== "allow_once")
            throw new SlackPilotRefusal(
              "A current one-time Approval is required.",
              409,
            );
          if (
            binding?.goal.status !== "active" ||
            binding.goal.agentId !== action.botId ||
            binding.goal.threadId !== action.threadId ||
            binding.run.status !== "waiting" ||
            binding.run.waiting?.approvalId !== approvalId
          )
            throw new SlackPilotRefusal(
              "The original Goal run is no longer waiting for this Approval.",
              409,
            );
          const refusal = await headlessTurnRefusal({
            ownerUserId: owner,
            agentId: action.botId,
            threadId: action.threadId,
          });
          if (refusal) throw new SlackPilotRefusal(refusal, 403);

          if (await isBotPaused(owner, action.botId))
            throw new SlackPilotRefusal("The Bot is paused.", 403);
          const actor = await actorFor(owner);
          const pinned = targetSchema.parse(action.target);
          const { text } = parameters.pick({ text: true }).parse(action.args);
          const input = { ...pinned, text, botId: action.botId };
          const source = await githubQueuedRunAuthorization({
            database,
            service: options.githubEventAccess,
            runId: action.runId,
            personId: owner,
          });
          if (source.kind === "denied")
            throw new SlackPilotRefusal(GITHUB_EVENT_ACCESS_ENDED, 403);
          const { token, userId, revision } = await access.verifiedTarget(
            actor,
            input,
            action,
            true,
          );
          await access.checkBinding(actor, input, action);
          const startedAt = new Date();
          const consumed = await approvals.consume(
            owner,
            approvalId,
            action.actionDigest,
            async (tx) => {
              // Use the same local source lock as queued Run authorization.
              if (
                !(await source.check(
                  tx,
                  source.origin.outcome.triggerId,
                  owner,
                ))
              )
                throw new SlackPilotRefusal(GITHUB_EVENT_ACCESS_ENDED, 403);
              const [goal] = await tx
                .select({ id: responsibilities.id })
                .from(responsibilities)
                .where(
                  and(
                    eq(responsibilities.id, binding.goal.id),
                    eq(responsibilities.status, "active"),
                  ),
                )
                .for("share");
              if (!goal)
                throw new SlackPilotRefusal(
                  "The original Goal is no longer active.",
                  409,
                );
              const [run] = await tx
                .select({ id: responsibilityRuns.id })
                .from(responsibilityRuns)
                .where(waiting)
                .for("share");
              if (!run)
                throw new SlackPilotRefusal(
                  "The Goal run is no longer waiting.",
                  409,
                );
              await access.checkBinding(actor, input, action, tx);
            },
          );
          if (!consumed) return;
          const writeKey = corsairWriteKey(
            owner,
            userId,
            input.channelId,
            action.args,
          );
          await log("corsair.slack.write_started", { writeKey });
          await beforeDispatch?.();
          let message: Awaited<ReturnType<typeof provider.postMessage>>;
          try {
            message = await dispatchCorsairWrite(
              database,
              options.enforceCutover
                ? {
                    workspaceId: options.workspaceId,
                    app: "slack",
                    botId: action.botId,
                    registration: options.registration,
                    binding: "personal",
                    approvalId,
                    writeKey,
                    grant: { toolRef: tool.ref },
                  }
                : undefined,
              input.connectionId,
              revision,
              () =>
                provider.postMessage({
                  token,
                  userId,
                  channel: input.channelId,
                  text,
                  delivery: approvalId,
                }),
            );
          } catch (error) {
            if (error instanceof RevocationRefusal) {
              await log("corsair.slack.write_refused", {
                reason: error.message,
                dispatchRefused: true,
              });
              return { content: error.message, error: error.message };
            }
            return reconcile(startedAt);
          }
          return confirmed(message.channel, message.timestamp);
        } catch (error) {
          if (
            !(
              error instanceof SlackPilotRefusal ||
              error instanceof RevocationRefusal
            )
          )
            throw error;
          await log("corsair.slack.write_refused", { reason: error.message });
          return { content: error.message, error: error.message };
        }
      }

      const result = record.result ?? (await dispatch());
      if (!result) return "retry";
      if (
        !record.result &&
        !(await approvals.saveResult(owner, approvalId, result))
      )
        return "retry";
      if (result.error) {
        await database
          .update(responsibilityRuns)
          .set({
            status: "failed",
            error: result.error,
            waiting: null,
            continuation: null,
            finishedAt: new Date(),
          })
          .where(waiting);
      } else if (binding?.run.status === "waiting") {
        await beforeDispatch?.();
        await responsibilityStore.resumeWaiting(owner, action.runId, result);
      }
      await approvals.finish(owner, approvalId);
    },
  };
}
