import { z } from "zod";
import { headlessTurnRefusal } from "../admin/controls";
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
import { ApprovalRefusedError } from "./types";

/** Claim and retry decided Approvals through the same queue as other work items. */
export function createApprovalResumeTick(
  deps: ApprovalContinuationDependencies & {
    approvalQueue: WorkQueue;
    approvalOwner: string;
    approvalService: ApprovalService;
    executeApprovedAction: ReturnType<
      typeof import("./execute").createApprovedActionExecutor
    >;
    slackGoalAction?: ReturnType<typeof createSlackGoalAction>;
  },
): () => Promise<void> {
  const {
    approvalQueue,
    approvalOwner,
    approvalService,
    database,
    executeApprovedAction,
    responsibilityStore,
  } = deps;
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
        const resumeDependencies: ApprovalResumeDependencies = {
          // Asked before the action runs: with Use Bots off, or the Bot's model off the allowlist,
          // nothing is carried out and the refusal is final rather than retried.
          refusal: (action) =>
            headlessTurnRefusal({
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
          execute: async (action) => {
            const request = await approvalService.store.get(
              input.ownerUserId,
              input.approvalId,
            );
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
          },
          continue: (outcome) =>
            continueApproval(deps, input.ownerUserId, outcome),
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
