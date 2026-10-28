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

const log = getLogger("server");
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
import type { SandboxGateway } from "./sandbox-gateway";
import type { CraftStore } from "./store";
import { BuildStreamingState } from "./streaming";
import { clearTurnDeadline, stampTurnDeadline } from "./turn-budget";
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
  /** The sandbox gateway — the turn-budget stamp/clear write through its file API. */
  gateway: SandboxGateway;
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

    // The opencode session id is resolved on the session row before every
    // prompt pass: the row is what the ATTACH stream and the decision endpoint
    // key on, so re-minting here (a fresh id per turn) would strand every
    // observer on the previous id — the attach would drain announces and
    // keepalives but never the turn's own events, and conversation history
    // would reset each turn. ensureSession still re-mints when the row's id
    // has gone stale (a recycled sandbox), persisting the new id via the
    // callback; continuations re-read and ride the same row.
    const sessionRow = await store.getSession(input.sessionId, input.userId);
    const eventStream = manager.yieldSandboxEvents(
      {
        sessionId: input.sessionId,
        botId: input.botId,
        // The permission gate is owner-scoped: the turn's user is who gets asked.
        userId: input.userId,
        userMessageContent: input.prompt,
        opencodeSessionId: sessionRow?.opencodeSessionId ?? null,
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
      if (isActivityTimeout(sandboxEvent)) {
        if (input.canContinue) {
          timedOut = true;
          continue;
        }
        // Last attempt: the marker is a transport detail, not content. Persisting it
        // would put a consumed marker into the transcript; drain it and let the
        // TIMED_OUT outcome below record the failure.
        continue;
      }

      await manager.persistSandboxEvent(
        input.sessionId,
        input.state,
        sandboxEvent,
      );

      if (!isBuildPacket(sandboxEvent) && isSandboxError(sandboxEvent)) {
        // Best-effort, like the path's other persistence: a storage failure here must
        // not mask the sandbox error that is already on its way to the caller.
        await manager
          .finalizePersist(input.sessionId, input.state)
          .catch((error: unknown) => {
            log.warn(
              { error, sessionId: input.sessionId },
              "[craft] failed to persist sandbox error partials",
            );
          });
        await manager
          .persistTurnError(
            input.sessionId,
            input.state.turnIndex,
            `${sandboxEvent.message} ${TURN_ERROR_SUFFIX}`,
          )
          .catch((error: unknown) => {
            log.warn(
              { error, sessionId: input.sessionId },
              "[craft] failed to persist turn error row",
            );
          });
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

    // Turn-budget stamp — the point onyx guards with "only while holding the
    // prompt slot": past the preflight checks and ownership, before the first
    // prompt, once per turn (continuations never restamp). Best-effort; a
    // failed write leaves the sandbox-side plugin inert, never blocks the turn.
    await stampTurnDeadline({
      gateway: deps.gateway,
      botId,
      sessionId,
      config,
    });

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
      // True on every exit where no other turn can be mid-flight on this
      // session; false once a successor owns it (reclaim — it sets the
      // active-turn pointer at creation, before it ever prompts). `active ===
      // null` is OWNERSHIP TOO: our own finishTurn just cleared the pointer on
      // every normal ending, so requiring it to still name THIS turn would
      // never clear the fence — and a fence left set by an interrupt would
      // cancel the session's next N turns until its TTL ran out (F-H).
      try {
        const active = await turnState.getActiveTurn({ sessionId, userId });
        const stillOwns =
          active === null ||
          (active.turnId === turnId &&
            (runnerId === null || active.runnerId === runnerId));
        if (stillOwns) {
          await fence.clearInterrupt(sessionId).catch(() => undefined);
          // Same ownership guard as onyx's clear_turn_deadline: a successor's
          // fresh stamp (set at ITS turn start) must not be clobbered. Runs on
          // every exit — success, failure, cancellation — so a failed next-turn
          // restamp can never inherit this turn's deadlines.
          await clearTurnDeadline({
            gateway: deps.gateway,
            botId,
            sessionId,
            config,
          });
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
