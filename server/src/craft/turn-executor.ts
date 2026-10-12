/**
 * Background executor for interactive craft turns — ported from onyx
 * `interactive_turns/executor.py`.
 *
 * onyx runs the turn on a background thread with a tenant contextvar; Bun has no threads, and
 * none are needed — the turn is I/O-bound (bus queue waits, SSE reads, Redis round-trips), so
 * the runner is a fire-and-forget async task (the same shape the workshop orchestrator uses).
 * The claim/touch/finish ownership protocol, the timeout-continuation ladder (an inactivity
 * timeout re-prompts the agent up to MAX_TIMEOUT_CONTINUATIONS times with a steer prompt), the
 * hard-cap deadline, the interrupt-fence polling, and the fence-clear ownership guard in the
 * finally block are preserved exactly — they are the crash-recovery story.
 */

import { getLogger } from "../../../shared/logger";
import type { Database } from "../db/client";
import type { CraftConfig } from "./config";
import { isBuildPacket } from "./events/packets";
import {
  isActivityTimeout,
  isKeepalive,
  isPromptResponse,
  isSandboxError,
} from "./events/types";
import type { InterruptFence } from "./interrupt";
import type { CraftSessionManager } from "./manager";
import type { CraftStore } from "./store";
import { BuildStreamingState } from "./streaming";
import type { InteractiveTurn, TurnStateStore } from "./turn-state";
import {
  TURN_STATUS_CANCELLED,
  TURN_STATUS_FAILED,
  TURN_STATUS_SUCCEEDED,
} from "./turn-state";

export const MAX_TIMEOUT_CONTINUATIONS = 2;

const TOOL_TIMEOUT_CONTINUATION_PROMPT = (inactivitySeconds: number) =>
  "Your last step was cancelled — it exceeded the " +
  `${inactivitySeconds}s activity limit with no output. Don't just retry it; ` +
  "split the work into shorter steps or run it in the background, then continue.";

export const TURN_ERROR_SUFFIX =
  "Files written to the workspace are saved — send a follow-up message to continue.";

/** One prompt pass's outcome. */
type PromptOutcome =
  | "TERMINATED" // the turn already finished; the caller returns
  | "TIMED_OUT" // step went silent; the caller re-prompts
  | "COMPLETED"; // the opencode stream ended; run the terminal handling

type PromptResult = {
  outcome: PromptOutcome;
  finalEventSeen: boolean;
  cancelled: boolean;
};

export type TurnExecutorDeps = {
  db: Database;
  config: CraftConfig;
  store: CraftStore;
  manager: CraftSessionManager;
  turnState: TurnStateStore;
  fence: InterruptFence;
  /** Resolves the Bot whose sandbox hosts a session (workspace + serve routing). */
  botIdFor: (sessionId: string) => Promise<string | null>;
};

export type TurnExecutor = {
  /** Fire-and-forget: run the turn in this process if the claim grants ownership. */
  startInteractiveTurnRunner(turnId: string): void;
};

export function createTurnExecutor(deps: TurnExecutorDeps): TurnExecutor {
  const { config, store, manager, turnState, fence } = deps;
  const hardCapMs = config.interactiveTurnHardCapSeconds * 1000;
  const inactivitySeconds = Math.round(
    config.opencodePromptInactivityTimeoutSeconds,
  );

  async function driveOnePrompt(input: {
    turnId: string;
    sessionId: string;
    userId: string;
    botId: string;
    runnerId: string | null;
    prompt: string;
    attachments: InteractiveTurn["attachments"];
    state: BuildStreamingState;
    deadlineAt: number;
    canContinue: boolean;
  }): Promise<PromptResult> {
    let ownershipLost = false;
    let finalEventSeen = false;
    let cancelledEventSeen = false;
    let timedOut = false;
    let deadlineExceeded = false;

    const interruptRequested = (): boolean => {
      if (Date.now() > input.deadlineAt) {
        deadlineExceeded = true;
        return true;
      }
      return false;
    };

    // The transport polls shouldInterrupt ~1/s; the fence check is async, so the
    // wrapper latches the answer into a sync flag the poll reads.
    let interruptLatched = false;
    const refreshInterrupt = async () => {
      if (interruptRequested()) {
        interruptLatched = true;
        return;
      }
      try {
        interruptLatched = await fence.isInterruptRequested(input.sessionId);
      } catch {
        interruptLatched = false;
      }
    };
    const shouldInterrupt = () => {
      void refreshInterrupt();
      return interruptLatched;
    };

    const eventStream = manager.yieldSandboxEvents(
      {
        sessionId: input.sessionId,
        botId: input.botId,
        // The permission gate is owner-scoped: the turn's user is who gets asked.
        userId: input.userId,
        userMessageContent: input.prompt,
        // The opencode session id is resolved on the session row by the drive loop
        // before the first prompt; continuations rely on the same row.
        opencodeSessionId: null,
        attachments: input.attachments,
        shouldInterrupt,
        shouldAbortOnTeardown: () => !ownershipLost,
        turnTimeoutMs: null,
      },
      async (newId) => {
        await store.persistOpencodeSessionId(input.sessionId, newId);
      },
    );

    for await (const sandboxEvent of eventStream) {
      if (Date.now() > input.deadlineAt) deadlineExceeded = true;
      if (deadlineExceeded && !isKeepalive(sandboxEvent)) {
        // Past the cap: drain without persisting (the transport aborts on the
        // interrupt check); the drive loop records the timeout.
        continue;
      }

      if (
        !(await turnState.touchTurn({
          turnId: input.turnId,
          runnerId: input.runnerId,
        }))
      ) {
        ownershipLost = true;
        return {
          outcome: "TERMINATED",
          finalEventSeen: false,
          cancelled: false,
        };
      }

      if (isKeepalive(sandboxEvent)) continue;

      // The transport already aborted the timed-out step and ends the stream
      // after this event; drain it (don't return early, which would re-abort)
      // and let the caller re-prompt.
      if (isActivityTimeout(sandboxEvent) && input.canContinue) {
        timedOut = true;
        continue;
      }

      await manager.persistSandboxEvent(
        input.sessionId,
        input.state,
        sandboxEvent,
      );

      if (!isBuildPacket(sandboxEvent) && isSandboxError(sandboxEvent)) {
        await manager.finalizePersist(input.sessionId, input.state);
        await manager.persistTurnError(
          input.sessionId,
          input.state.turnIndex,
          `${sandboxEvent.message} ${TURN_ERROR_SUFFIX}`,
        );
        await turnState.finishTurn({
          turnId: input.turnId,
          status: TURN_STATUS_FAILED,
          errorDetail: sandboxEvent.message,
          runnerId: input.runnerId,
        });
        return {
          outcome: "TERMINATED",
          finalEventSeen: false,
          cancelled: false,
        };
      }

      if (!isBuildPacket(sandboxEvent) && isPromptResponse(sandboxEvent)) {
        finalEventSeen = true;
        cancelledEventSeen = sandboxEvent.stopReason === "cancelled";
      }
    }

    if (timedOut)
      return { outcome: "TIMED_OUT", finalEventSeen: false, cancelled: false };
    return {
      outcome: "COMPLETED",
      finalEventSeen,
      cancelled: cancelledEventSeen,
    };
  }

  async function driveInteractiveTurn(turn: InteractiveTurn): Promise<void> {
    const { turnId, sessionId, userId, runnerId } = turn;
    const budgetMs = hardCapMs;
    const deadlineAt = Date.now() + budgetMs;

    const session = await store.getSession(sessionId, userId);
    if (!session) {
      await turnState.finishTurn({
        turnId,
        status: TURN_STATUS_FAILED,
        errorDetail: "Craft session no longer exists.",
        runnerId,
      });
      return;
    }
    const botId = await deps.botIdFor(sessionId);
    if (!botId) {
      await turnState.finishTurn({
        turnId,
        status: TURN_STATUS_FAILED,
        errorDetail: "No sandbox configured for this session.",
        runnerId,
      });
      return;
    }

    // The workspace reconcile (create/repair) runs before the first prompt; the
    // send-message path creates sessions with the workspace already materialized,
    // so the fast path is a no-op row check.
    if (session.status !== "active") {
      await turnState.finishTurn({
        turnId,
        status: TURN_STATUS_FAILED,
        errorDetail:
          "Session is not active; retry after it finishes initializing.",
        runnerId,
      });
      return;
    }

    if (!(await turnState.touchTurn({ turnId, runnerId }))) {
      return; // ownership lost before we started
    }

    const state = new BuildStreamingState(turn.turnIndex);
    let deadlineExceeded = false;

    const persistTurnError = async (message: string) => {
      // Best-effort user-visible failure row; never blocks finishTurn.
      await manager
        .persistTurnError(
          sessionId,
          turn.turnIndex,
          `${message} ${TURN_ERROR_SUFFIX}`,
        )
        .catch(() => undefined);
    };

    try {
      let currentPrompt = turn.prompt;
      let result: PromptResult = {
        outcome: "COMPLETED",
        finalEventSeen: false,
        cancelled: false,
      };
      for (
        let attempt = 0;
        attempt <= MAX_TIMEOUT_CONTINUATIONS;
        attempt += 1
      ) {
        result = await driveOnePrompt({
          turnId,
          sessionId,
          userId,
          botId,
          runnerId,
          prompt: currentPrompt,
          attachments: attempt === 0 ? turn.attachments : [],
          state,
          deadlineAt,
          canContinue: attempt < MAX_TIMEOUT_CONTINUATIONS,
        });
        if (result.outcome !== "TIMED_OUT") break;
        // Flush the aborted step's partial output as its own message so it can't
        // merge with the continuation, then steer the agent.
        await manager.finalizePersist(sessionId, state);
        currentPrompt = TOOL_TIMEOUT_CONTINUATION_PROMPT(inactivitySeconds);
      }

      if (result.outcome === "TERMINATED") return;

      await manager.finalizePersist(sessionId, state);

      // deadlineExceeded is latched inside driveOnePrompt's interrupt closure;
      // re-derive cheaply here (the deadline is absolute).
      deadlineExceeded = Date.now() > deadlineAt;
      if (deadlineExceeded) {
        await persistTurnError(
          `This turn was stopped after reaching its ${Math.max(
            1,
            Math.round(config.interactiveTurnHardCapSeconds / 60),
          )}-minute time limit.`,
        );
        await turnState.finishTurn({
          turnId,
          status: TURN_STATUS_FAILED,
          errorDetail: `hard time cap exceeded (${config.interactiveTurnHardCapSeconds}s)`,
          runnerId,
        });
        return;
      }

      if (!result.finalEventSeen) {
        await persistTurnError(
          "This turn ended before the agent returned a final response.",
        );
        await turnState.finishTurn({
          turnId,
          status: TURN_STATUS_FAILED,
          errorDetail: "Turn ended before opencode returned a final response.",
          runnerId,
        });
        return;
      }

      if (result.cancelled) {
        await turnState.finishTurn({
          turnId,
          status: TURN_STATUS_CANCELLED,
          runnerId,
        });
        return;
      }

      await turnState.finishTurn({
        turnId,
        status: TURN_STATUS_SUCCEEDED,
        runnerId,
      });
    } catch (error) {
      await manager.finalizePersist(sessionId, state).catch(() => undefined);
      await persistTurnError("This turn failed unexpectedly.");
      await turnState.finishTurn({
        turnId,
        status: TURN_STATUS_FAILED,
        errorDetail: `${error instanceof Error ? error.name : "Error"}: ${String(
          error,
        ).slice(0, 950)}`,
        runnerId,
      });
    } finally {
      // True on every exit where this runner still owns the turn; false once a
      // successor owns it (reclaim). A successor sets the active-turn pointer at
      // creation, before it ever prompts, so this guard clears our fence exactly
      // when no other turn can be mid-flight on this session.
      try {
        const active = await turnState.getActiveTurn({ sessionId, userId });
        const stillOwns =
          active !== null &&
          active.turnId === turnId &&
          (runnerId === null || active.runnerId === runnerId);
        if (stillOwns) {
          await fence.clearInterrupt(sessionId).catch(() => undefined);
        }
      } catch {
        // Ownership check failed — leave the fence; its TTL is the backstop.
      }
    }
  }

  return {
    startInteractiveTurnRunner(turnId) {
      // Fire-and-forget: the caller resolves when the turn EXISTS, not finishes;
      // attach streams observe the result through the state store.
      void (async () => {
        let turn: InteractiveTurn | null = null;
        try {
          turn = await turnState.claimTurnForRunner(turnId);
          if (turn === null) return;
          await driveInteractiveTurn(turn);
        } catch (error) {
          getLogger("server").error(
            {
              turnId,
              err: error instanceof Error ? error : String(error),
            },
            "[craft] interactive turn runner failed",
          );
          if (turn !== null) {
            await turnState
              .finishTurn({
                turnId: turn.turnId,
                status: TURN_STATUS_FAILED,
                errorDetail: "Interactive turn runner failed.",
                runnerId: turn.runnerId,
              })
              .catch(() => undefined);
          }
        }
      })();
    },
  };
}
