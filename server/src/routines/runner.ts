/**
 * Running one firing of a routine with nobody's browser open.
 *
 * A turn normally has a person in front of it: their browser runs the agent, sees the reply, and
 * tells the server what was said, which is what moves the channel to the top of their roster and
 * lights the unread dot. A routine has none of that, so this file does that last step itself —
 * `recordActivity` — and it is the only place a headless turn does, which is why there is exactly
 * one of those calls per successful firing here and why the tests count them.
 *
 * TWO LEDGERS, AND THEY ARE NOT THE SAME LEDGER.
 *
 * The queue's attempt count (`server/src/work/queue.ts`) bounds retries of ONE FIRING: a consumer
 * that died mid-turn, a runner that is flapping, a lease that stopped being renewed. It answers
 * "how many times have we handed this one due moment out?".
 *
 * The fatigue rule below counts CONSECUTIVE FIRINGS THAT FAILED, in `routine_runs`, across days.
 * It answers "is this routine still worth firing at all?" — a Notion token that expired in March
 * fails every night, and no number of retries of any one night's firing will fix it.
 *
 * Conflating them is how a broken routine either spams a channel — a per-attempt notification
 * posting three times for one bad night — or retries for ever, because a rule counting attempts
 * within a firing never sees the routine that fails cleanly, once, every single night.
 */

import { frameFiring } from "@openbot/shared/routine-firing";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { BOT_PAUSED_REASON, isBotPaused } from "../agents/lifecycle";
import type { AgentActor } from "../agents/profile-types";
import { BackgroundConversationBusy } from "../channels/direct-chat";
import {
  BackgroundModelWaiting,
  backgroundModelOperationId,
} from "../billing/background-model";
import type { ChannelStore } from "../channels/routes";
import type { mountCopilotRuntime } from "../copilot";
import { isMarketVersionPause } from "../skill-market/disablements";
import type { RoutineStore } from "./store";

export type RoutineRunner = {
  run(
    routineRunId: string,
    continuation?: { ownerUserId: string; routineId: string },
  ): Promise<void>;
};

export function createRoutineTurn(
  runBackground: NonNullable<
    ReturnType<typeof mountCopilotRuntime>["runBackground"]
  >,
  actorFor: (personId: string) => Promise<AgentActor>,
  metered?: Parameters<typeof runBackground>[0]["metered"],
): TurnRunner {
  return ({
    ownerUserId,
    routineId,
    runId,
    agentId,
    threadId,
    instruction,
    signal,
  }) => {
    if (!runId) throw new Error("A Routine firing requires a Run ID.");
    return runBackground({
      source: "routine",
      id: runId,
      threadId,
      conversationBotId: agentId,
      personId: ownerUserId,
      agentId,
      prompt: frameFiring(instruction),
      metered,
      signal,
      authorize: () => actorFor(ownerUserId).catch(() => null),
      initiator: { kind: "routine", id: routineId },
    }).then(({ replyText, shared }) => ({
      replyText: shared ? "" : replyText,
    }));
  };
}

/**
 * How much of a failure's reason the channel notification carries.
 *
 * `recordActivity` caps its preview at 200 code points on its own, so this is not about safety, it
 * is about the sentence surviving: the prefix plus this much reason still fits, so the roster shows
 * a failure that says what failed rather than a truncated "This routine failed: Error: could not…".
 * The whole message is on the run row for anybody who wants all of it.
 */
const MAX_NOTIFIED_REASON = 160;

/** Consecutive failed firings after which a routine stops being fired at all. */
const FATIGUE_LIMIT = 10;

const SWITCHED_OFF =
  "This routine has failed ten times in a row, so I have switched it off. Ask me to turn it back on when whatever it needs is working.";

/** Measured in code points, like every other cap in this area, so nothing is cut mid-pair. */
function shorten(reason: string): string {
  const codePoints = Array.from(reason);
  if (codePoints.length <= MAX_NOTIFIED_REASON) return reason;
  return `${codePoints.slice(0, MAX_NOTIFIED_REASON - 1).join("")}…`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRoutineRunner(options: {
  routineStore: RoutineStore;
  channelStore: ChannelStore;
  runTurn: TurnRunner;
}): RoutineRunner {
  const { routineStore, channelStore, runTurn } = options;

  async function runOnce(
    routineRunId: string,
    continuation?: { ownerUserId: string; routineId: string },
  ): Promise<void> {
    const context = await routineStore.runContext(routineRunId);
    /*
     * A deleted routine's queued run is nobody's problem. The routine is gone, its runs cascaded
     * with it, and there is no row left to finish — so there is nothing to record and nothing to
     * say to anybody. The firing is dropped on the floor deliberately.
     */
    if (!context) return;
    if (continuation) {
      if (
        context.ownerUserId !== continuation.ownerUserId ||
        context.routineId !== continuation.routineId ||
        !context.budgetId ||
        (context.status !== "waiting" && context.status !== "skipped")
      )
        return;
      if (!(await routineStore.reopenBillingRun?.(routineRunId))) return;
    } else if (context.status) return;
    /*
     * PAUSED NEVER RUNS, checked here at the moment of running rather than only when the firing was
     * offered: a person who switched the routine off after the dispatch, or a Run now that raced a
     * pause, has said what they want. Skipped, so the fatigue rule does not count it.
     */
    if (context.enabled === false) {
      await routineStore.finishRun(
        routineRunId,
        "skipped",
        "the routine is paused",
      );
      return;
    }

    const {
      routineId,
      ownerUserId,
      agentId,
      channelId,
      instruction,
      budgetId,
      source,
    } = context;
    // Everything below is done AS the owner: their channel, their thread, their grants.
    const owner: AgentActor = { id: ownerUserId, role: "user" };

    /** One activity record, from the routine's Bot, or a logged miss. Never a throw. */
    async function say(text: string, phase = "reply"): Promise<void> {
      try {
        await channelStore.recordActivity(
          owner,
          channelId,
          {
            text,
            agentId,
            at: new Date(),
          },
          budgetId ? { id: `${routineRunId}:${phase}` } : undefined,
        );
      } catch (error) {
        /*
         * A channel that cannot be written to must not turn a recorded outcome into an unrecorded
         * one. The run row is the ledger; this call is the courtesy of saying so where a person
         * will see it, and losing the courtesy is not worth losing the ledger.
         */
        console.error(
          JSON.stringify({
            type: "routine-activity-unrecorded",
            routineId,
            routineRunId,
            reason: reasonOf(error),
          }),
        );
      }
    }

    /*
     * `get` as the owner already filters soft-deleted channels and non-members, so null covers all
     * three ways this can be over: the channel was deleted, the row is gone, or the owner is no
     * longer in it. No second check, and no turn — a reply with nowhere to land is model spend for
     * nothing.
     *
     * This is why `routines.channel_id` is not a foreign key: the routine survives its channel so
     * the routines page can show it as broken, and the person can point it somewhere else.
     */
    const channel = await channelStore.get(owner, channelId);
    if (!channel) {
      await routineStore.finishRun(
        routineRunId,
        "skipped",
        "the channel is gone",
      );
      return;
    }

    // A paused Bot's firing is skipped, not failed, so a long pause never trips the fatigue rule.
    if (await isBotPaused(ownerUserId, agentId)) {
      await routineStore.finishRun(routineRunId, "skipped", BOT_PAUSED_REASON);
      return;
    }
    /*
     * The conversation shown as working while the firing runs, and told it is over once the run
     * row has its outcome. The run row is what the conversation reads "a routine is running" from
     * (see channels/working.ts), so the signal that ends it comes after `finishRun`, not after the
     * turn. Best-effort both ways: a firing is not worth failing over a dot.
     */
    await channelStore.signalBusy(channel.threadId, true).catch(() => {});
    try {
      await fire(channel.threadId);
    } finally {
      await channelStore.signalBusy(channel.threadId, false).catch(() => {});
    }

    async function fire(threadId: string): Promise<void> {
      let replyText: string;
      try {
        ({ replyText } = await runTurn({
          ownerUserId,
          runId: routineRunId,
          telemetry: {
            trigger: source === "run_now" ? "human" : "routine",
            surface: source === "run_now" ? "web" : "unknown",
            rootTaskId: routineRunId,
          },
          routineId,
          agentId,
          threadId,
          instruction,
          ...(budgetId
            ? {
                budget: { id: budgetId, stepId: routineRunId },
                userMessage: {
                  id: routineRunId,
                  role: "user",
                  content: instruction,
                },
              }
            : {}),
        }));
      } catch (error) {
        if (error instanceof BackgroundConversationBusy) return;
        if (
          budgetId &&
          error instanceof Error &&
          error.name === "PlatformRequestError" &&
          "status" in error &&
          error.status === 409
        )
          return;
        if (budgetId) {
          const waiting =
            error instanceof BackgroundModelWaiting
              ? error
              : new BackgroundModelWaiting(
                  backgroundModelOperationId(
                    {
                      kind: "routine",
                      executionId: routineRunId,
                      personId: ownerUserId,
                      budgetId,
                    },
                    "reply",
                  ),
                  "reconciling",
                );
          await routineStore.finishRun(
            routineRunId,
            "waiting",
            `${waiting.message} Operation ${waiting.operationId}`,
          );
          await say(waiting.message, "billing");
          return;
        }
        if (error instanceof HeadlessToolSuspension) {
          await routineStore.finishRun(
            routineRunId,
            "waiting",
            error.message,
            error.waiting,
          );
          await say(error.message);
          return;
        }
        const reason = reasonOf(error);
        if (isMarketVersionPause(reason)) {
          await routineStore.finishRun(routineRunId, "skipped", reason);
          await say(reason);
          return;
        }
        await routineStore.finishRun(routineRunId, "failed", reason);

        /*
         * THE FATIGUE RULE, read after the failure is recorded — the count has to include this
         * firing, or the tenth failure in a row reads as the ninth and the routine keeps going.
         *
         * Its own try/catch, around the read and the switching-off as well as the message: this all
         * happens after `finishRun`, and nothing in it is allowed to throw its way out of a firing
         * whose failure is already on the row.
         */
        try {
          const failures = await routineStore.consecutiveFailures(routineId);
          if (failures === 1) {
            // Only the first failure after a success. A routine that fails every night at three has
            // one line in the channel, not one line a night for a month.
            await say(`This routine failed: ${shorten(reason)}`);
          } else if (failures >= FATIGUE_LIMIT) {
            // A dead integration should not burn model spend for ever. Switched off, and said out
            // loud, because a routine that goes quiet without explaining itself is worse than one
            // that fails.
            await routineStore.setEnabled(ownerUserId, routineId, false);
            await say(SWITCHED_OFF);
          }
          // In between, nothing is said. The run rows carry it, and the routines page reads them.
        } catch (fatigueError) {
          console.error(
            JSON.stringify({
              type: "routine-fatigue-rule-failed",
              routineId,
              routineRunId,
              reason: reasonOf(fatigueError),
            }),
          );
        }
        return;
      }

      /*
       * The reply, then the outcome. `say` cannot throw, and `finishRun` is finish-once, so neither
       * order can lose the run row — this one is the browser's order: what was said lands in the
       * channel, and then the firing is closed.
       */
      if (replyText) await say(replyText);
      await routineStore.finishRun(routineRunId, "succeeded");
    }
  }

  const running = new Map<string, Promise<void>>();
  return {
    async run(routineRunId, continuation) {
      const existing = running.get(routineRunId);
      if (existing) return existing;
      const turn = runOnce(routineRunId, continuation);
      running.set(routineRunId, turn);
      /*
       * `run` never throws. Every outcome a routine can have — a gone channel, a refused model, a
       * routine deleted underneath the firing — is recorded on the run row above rather than raised
       * at whoever is draining the queue. This backstop is for the ones that are not outcomes at
       * all, a store that cannot be reached being the honest example: said out loud, because the
       * alternative is a firing that vanishes without a line anywhere.
       */
      try {
        await turn;
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "routine-run-crashed",
            routineRunId,
            reason: reasonOf(error),
          }),
        );
      } finally {
        running.delete(routineRunId);
      }
    },
  };
}
