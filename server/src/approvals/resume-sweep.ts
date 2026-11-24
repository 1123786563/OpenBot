import {
  CONTEXT_REVOKED,
  CONTEXT_REVOKED_MESSAGE,
  createRunContext,
  RunContextRevokedError,
  trackRunContext,
  verifyRunContext,
  withRunContext,
} from "@openbot/toolkit/run-context";
import { and, eq, exists, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { headlessTurnRefusal } from "../admin/controls";
import type { createDirectChatRoutes } from "../channels/direct-chat";
import { matchingRun, stopDirectChatRun } from "../channels/direct-chat-replay";
import type { GroupConversations } from "../channels/group";
import { approvalRequests, directChatRuns } from "../db/schema";
import {
  decisionInvalidated,
  runWithDecisionAccess,
} from "../personal-saas/decision-access";
import { GithubEventAccessRetry } from "../plugins/corsair/event-run-access";
import type { createSlackGoalAction } from "../plugins/corsair/slack/goal-action";
import { DEFAULT_MAX_ATTEMPTS, type WorkQueue } from "../work/queue";
import {
  type ApprovalContinuationDependencies,
  continueApproval,
} from "./continuation";
import type { ApprovalResumeDependencies, ApprovalService } from "./service";
import { type ApprovalAction, ApprovalRefusedError } from "./types";

/**
 * One pass of the approval resume loop: claim a decided approval, carry it out, and pick the waiting
 * turn back up — a responsibility run, a group conversation or a routine run — then tell the channel.
 *
 * Moved out of index.ts verbatim. `notify` is taken as a function because index.ts assigns delivery
 * after this loop is created: the loop reads it when it runs, never when it is built.
 */
export function createApprovalResumeTick(
  deps: ApprovalContinuationDependencies & {
    approvalQueue: WorkQueue;
    approvalOwner: string;
    executeApprovedAction: ReturnType<
      typeof import("./execute").createApprovedActionExecutor
    >;
    contextCurrent?: (action: ApprovalAction) => Promise<boolean>;
    traceRuns?: boolean;
    slackGoalAction?: ReturnType<typeof createSlackGoalAction>;
    groupConversations: Pick<
      GroupConversations,
      "continueWaiting" | "pauseWaiting"
    >;
    backgroundApproval?: ReturnType<
      typeof createDirectChatRoutes
    >["backgroundApproval"];
    approvalService: ApprovalService;
  },
): () => Promise<void> {
  const {
    approvalQueue,
    approvalOwner,
    approvalService,
    database,
    executeApprovedAction,
    groupConversations,
    approvalContinuationRunner,
    responsibilityStore,
  } = deps;
  const contextCurrent = (action: ApprovalAction) =>
    action.continuation?.sourceVersions?.length
      ? (deps.contextCurrent?.(action) ?? Promise.resolve(false))
      : Promise.resolve(true);
  const withSavedContext = <T>(action: ApprovalAction, run: () => Promise<T>) =>
    withRunContext(createRunContext(), async () => {
      const versions = action.continuation?.sourceVersions;
      if (versions?.length)
        trackRunContext(() => contextCurrent(action), versions);
      return run();
    });
  return async () => {
    try {
      const [item] = await approvalQueue.claim({
        kind: "approval.resume",
        owner: approvalOwner,
        leaseMs: 15 * 60_000,
        limit: 1,
      });
      if (!item) return;
      // Set once the item is understood, so its last failed try can still tell the Bot.
      let abandon: ((reason: string) => Promise<void>) | undefined;
      try {
        const input = z
          .object({
            ownerUserId: z.string().min(1),
            approvalId: z.string().min(1),
          })
          .parse(item.payload);
        const request = await approvalService.store.get(
          input.ownerUserId,
          input.approvalId,
        );
        const finish = async () => {
          if (
            !(await approvalQueue.finish({
              kind: item.kind,
              key: item.key,
              owner: approvalOwner,
            }))
          )
            throw new Error(
              "The approval work lease was lost before completion.",
            );
        };
        if (
          request.action.dispatch === "corsair-slack-goal" &&
          deps.slackGoalAction
        ) {
          const slackGoalAction = deps.slackGoalAction;
          if (request.action.executionInvalidated) {
            await finish();
            return;
          }
          const outcome = await runWithDecisionAccess(
            database,
            input.ownerUserId,
            {
              runId: request.action.runId,
              createdAt: request.createdAt,
              epoch: request.action.executionEpoch,
            },
            ({ beforeDispatch }) =>
              slackGoalAction.resume(
                request,
                responsibilityStore,
                beforeDispatch,
              ),
          );
          if (outcome === "retry") throw new GithubEventAccessRetry();
          await finish();
          return;
        }
        const background = await deps.backgroundApproval?.(
          request.action,
          request.id,
        );
        const pause = async (beforeExecution = false) => {
          const { threadId, runId } = request.action;
          if (threadId)
            await database.transaction(async (tx) => {
              const key = { threadId, runId };
              if (background) {
                // A consumed approval with a saved success resolves dispatch even on redelivery.
                // An execution error can leave the effect uncertain.
                const savedSuccess = tx
                  .select({ id: approvalRequests.id })
                  .from(approvalRequests)
                  .where(
                    and(
                      eq(approvalRequests.id, request.id),
                      eq(approvalRequests.ownerUserId, input.ownerUserId),
                      eq(approvalRequests.runId, runId),
                      sql`${approvalRequests.action}->>'threadId' = ${threadId}`,
                      isNotNull(approvalRequests.consumedAt),
                      sql`${approvalRequests.result}->>'content' is not null`,
                      sql`${approvalRequests.result}->>'error' is null`,
                    ),
                  );
                // Only the worker that consumed this checkpoint can prove it skipped execution.
                await tx
                  .update(directChatRuns)
                  .set({ externalOutcome: beforeExecution ? null : "executed" })
                  .where(
                    and(
                      matchingRun(key),
                      eq(directChatRuns.waitingApprovalId, request.id),
                      inArray(directChatRuns.externalOutcome, [
                        "dispatching",
                        "unknown",
                      ]),
                      beforeExecution ? undefined : exists(savedSuccess),
                    ),
                  );
              }
              await stopDirectChatRun(
                tx,
                key,
                CONTEXT_REVOKED,
                Boolean(deps.traceRuns),
                { waitingApprovalId: background ? request.id : undefined },
              );
            });
          if (!background)
            await groupConversations.pauseWaiting(
              input.ownerUserId,
              request.id,
            );
        };
        const resumeDependencies: ApprovalResumeDependencies = {
          // Asked before the action runs: with Use Bots off, or the Bot's model off the allowlist,
          // nothing is carried out and the refusal is final rather than retried.
          refusal: (action) =>
            background
              ? background.check()
              : headlessTurnRefusal({
                  ownerUserId: action.actorId,
                  agentId: action.botId,
                  threadId: action.threadId,
                }),
          validate: (action) => {
            if (action.dispatch === "corsair-slack-goal")
              throw new ApprovalRefusedError(
                "The Slack pilot registration is unavailable.",
              );
            return approvalService.validateReentry(action, () =>
              executeApprovedAction(action),
            );
          },
          beforeConsume: (action) => withSavedContext(action, verifyRunContext),
          execute: (action) =>
            withSavedContext(action, async () => {
              try {
                await verifyRunContext();
              } catch (error) {
                if (error instanceof RunContextRevokedError) await pause(true);
                throw error;
              }
              if (request.action.executionInvalidated)
                throw new Error(decisionInvalidated);
              return runWithDecisionAccess(
                database,
                input.ownerUserId,
                {
                  runId: action.runId,
                  createdAt: request.createdAt,
                  epoch: request.action.executionEpoch,
                },
                (execution) => executeApprovedAction(action, execution),
              );
            }),
          continue: async (outcome) => {
            if (
              outcome.result.error === CONTEXT_REVOKED_MESSAGE ||
              !(await contextCurrent(request.action))
            ) {
              await pause();
              return;
            }
            // The original Routine or handoff worker resumes the durable Run.
            if (background) return;
            try {
              return await continueApproval(
                {
                  ...deps,
                  approvalContinuationRunner: (turn) =>
                    withSavedContext(request.action, async () => {
                      await verifyRunContext();
                      return approvalContinuationRunner(turn);
                    }),
                },
                input.ownerUserId,
                outcome,
              );
            } catch (error) {
              if (!(error instanceof RunContextRevokedError)) throw error;
              await pause();
            }
          },
        };
        abandon = (reason) =>
          approvalService.abandon(
            input.ownerUserId,
            input.approvalId,
            reason,
            resumeDependencies,
          );
        await approvalService.resume(
          input.ownerUserId,
          input.approvalId,
          resumeDependencies,
        );
        await finish();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // A Goal's source access that may come back is waited for, never abandoned.
        if (error instanceof GithubEventAccessRetry) {
          await approvalQueue.release({
            kind: item.kind,
            key: item.key,
            owner: approvalOwner,
            delayMs: 10_000,
            reason,
            uncounted: true,
          });
          return;
        }
        // The queue will not hand this item out again, so the conversation hears now or never.
        if (abandon && item.attempts >= DEFAULT_MAX_ATTEMPTS) {
          try {
            await abandon(reason);
            await approvalQueue.finish({
              kind: item.kind,
              key: item.key,
              owner: approvalOwner,
            });
            return;
          } catch (failure) {
            console.error(
              JSON.stringify({
                type: "approval-abandon-error",
                error:
                  failure instanceof Error ? failure.message : String(failure),
                timestamp: new Date().toISOString(),
              }),
            );
          }
        }
        await approvalQueue.release({
          kind: item.kind,
          key: item.key,
          owner: approvalOwner,
          delayMs: 10_000,
          reason,
        });
        throw error;
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "approval-resume-error",
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  };
}
