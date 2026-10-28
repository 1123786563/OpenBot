/**
 * The SSE attach endpoint — ported from onyx `interactive_turns/api.py` (the events route).
 *
 * Wire contract (report §四.2, must hold verbatim):
 * - frame: `event: message\ndata: {JSON}\n\n`; keepalive: `": keepalive\n\n"` every 15s.
 * - headers: text/event-stream, Cache-Control: no-cache, no-transform, Connection:
 *   keep-alive, X-Accel-Buffering: no.
 * - terminal: a `prompt_response` or `error` data frame closes the stream.
 * - a FAILED turn resolves to one error frame (the live stream died with the runner).
 *
 * The attach loop mirrors onyx's: poll the turn + session until the runner is driving and the
 * opencode session exists, retry the runner claim on a throttle, then subscribe to the live
 * bus stream (translate-only — the runner is the durable writer) and forward frames until a
 * terminal event or turn loss.
 */

import { getLogger } from "../../../shared/logger";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/public";
import type { CraftApprovalSignals } from "./approval-signals";
import type { CraftConfig } from "./config";
import type { CraftConnectAppSignals } from "./connect-app";
import { isBuildPacket } from "./events/packets";
import { isKeepalive, isPromptResponse, isSandboxError } from "./events/types";
import type { CraftSessionManager } from "./manager";
import type { CraftStore } from "./store";
import { eventToSse, SSE_KEEPALIVE } from "./streaming";
import type { TurnExecutor } from "./turn-executor";
import type { TurnStateStore } from "./turn-state";
import { TURN_STATUS_FAILED } from "./turn-state";

/** The SSE headers every craft stream sends (the workshop's four-piece set + type). */
export const CRAFT_SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

const log = getLogger("server");

const TERMINAL_STREAM_EVENT_TYPES = new Set(["prompt_response", "error"]);

function formatStreamError(detail: string): string {
  const payload = {
    type: "error",
    message: detail,
    timestamp: new Date().toISOString(),
  };
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

export type TurnRoutesDeps = {
  config: CraftConfig;
  store: CraftStore;
  manager: CraftSessionManager;
  turnState: TurnStateStore;
  executor: TurnExecutor;
  /** Resolves the Bot whose sandbox hosts a session (live attach routing). */
  botIdFor: (sessionId: string) => Promise<string | null>;
  /** Approval announce/wake signals; the stream merges announces into SSE when gating is on. */
  approvalSignals?: CraftApprovalSignals | null;
  /** The connect-app handshake's KV — its announce drain feeds the attach stream. */
  connectAppSignals?: CraftConnectAppSignals | null;
};

export function createTurnRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  deps: TurnRoutesDeps,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  app.get("/sessions/:sessionId/turns/:turnId/events", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const turnId = context.req.param("turnId");

    const session = await deps.store.getSession(sessionId, actor.id);
    if (!session) {
      return context.json({ error: "Session not found" }, 404);
    }

    // Resolve the turn's state up front: active → stream; FAILED → one error
    // frame; anything else → 409 (onyx: "Interactive turn is not running").
    const active = await deps.turnState.getActiveTurn({
      sessionId,
      userId: actor.id,
    });
    let initialErrorDetail: string | null = null;
    if (active === null || active.turnId !== turnId) {
      const requested = await deps.turnState.getTurn(turnId);
      if (
        requested === null ||
        requested.sessionId !== sessionId ||
        requested.userId !== actor.id ||
        requested.status !== TURN_STATUS_FAILED
      ) {
        return context.json({ error: "Interactive turn is not running" }, 409);
      }
      initialErrorDetail = requested.errorDetail ?? "Interactive turn failed.";
    }

    const userId = actor.id;
    const config = deps.config;

    // Hoisted out of start() so the disconnect paths can reach them: without cancel(),
    // a client that walks away leaves the polls and the bus subscription running to the
    // terminal frame with nobody reading, and maybeStartRunner retrying the whole time.
    let live = true;
    let stopIteration: (() => void) | null = null;
    const stopStreaming = () => {
      live = false;
      stopIteration?.();
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const guard = (text: string) => {
          if (!live) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // Client gone; the abort path closes us out.
          }
        };

        void (async () => {
          try {
            if (initialErrorDetail !== null) {
              guard(formatStreamError(initialErrorDetail));
              return;
            }

            let lastRunnerStartAttempt = 0;
            const maybeStartRunner = (force = false) => {
              const now = Date.now();
              if (
                !force &&
                now - lastRunnerStartAttempt <
                  config.liveStreamRunnerRetrySeconds * 1000
              ) {
                return;
              }
              lastRunnerStartAttempt = now;
              // The claim no-ops while the turn is healthy; a dead runner's
              // turn becomes reclaimable RUNNER_STALE later, so retry here.
              deps.executor.startInteractiveTurnRunner(turnId);
            };

            maybeStartRunner(true);

            // Phase 1: wait until the session row carries an opencode id (the
            // runner mints it before the first prompt). Keepalives bridge polls.
            let attachedSession = session;
            for (;;) {
              if (!live) return;
              const turn = await deps.turnState.getTurn(turnId);
              if (turn && turn.status === TURN_STATUS_FAILED) {
                guard(
                  formatStreamError(
                    turn.errorDetail ?? "Interactive turn failed.",
                  ),
                );
                return;
              }
              const stillActive = await deps.turnState.getActiveTurn({
                sessionId,
                userId,
              });
              if (stillActive === null || stillActive.turnId !== turnId) {
                return; // turn finished while we polled — its frames are in the DB
              }
              const refreshed = await deps.store.getSession(sessionId, userId);
              if (refreshed?.opencodeSessionId) {
                attachedSession = refreshed;
                break;
              }
              guard(SSE_KEEPALIVE);
              maybeStartRunner();
              await sleep(config.pollIntervalSeconds * 1000);
            }

            // Live attach: translate-only forwarding. The runner is the durable
            // writer; this path observes the same bus stream.
            const botId = await deps.botIdFor(sessionId);
            if (!botId) {
              guard(
                formatStreamError("No sandbox configured for this session."),
              );
              return;
            }
            const events = deps.manager.subscribeToExistingSessionEvents({
              session: attachedSession,
              botId,
              keepaliveSeconds: config.sseKeepaliveIntervalSeconds,
              // onyx's announce merge: approval cards ride the same SSE stream. The
              // drain is inert unless gated tools are configured.
              announceDrain:
                deps.approvalSignals && config.approvalGatedTools.length > 0
                  ? () => deps.approvalSignals!.drainAnnouncements(sessionId)
                  : null,
              // connect_app asks are in the permissions template (not a gated-
              // tools config), so the drain is wired whenever the KV is.
              connectAppAnnounceDrain: deps.connectAppSignals
                ? () =>
                    (
                      deps.connectAppSignals as CraftConnectAppSignals
                    ).drainAnnouncements(sessionId)
                : null,
            });
            // return() runs the generator's finally (the bus unsubscribe): this is
            // what makes a mid-stream disconnect actually tear the subscription down.
            stopIteration = () => void events.return(undefined);
            for await (const event of events) {
              if (!live) return;
              const frame = eventToSse(event);
              guard(frame);
              const chunkType = isKeepalive(event)
                ? null
                : isBuildPacket(event)
                  ? event.type
                  : isPromptResponse(event)
                    ? "prompt_response"
                    : isSandboxError(event)
                      ? "error"
                      : "unknown";
              if (
                chunkType !== null &&
                TERMINAL_STREAM_EVENT_TYPES.has(chunkType)
              ) {
                return;
              }

              // Turn lost while live (runner died / reclaimed): keep draining
              // queued events until a terminal frame or the bus goes idle, so
              // the client sees the turn's actual end — onyx's exact posture.
              const turn = await deps.turnState.getActiveTurn({
                sessionId,
                userId,
              });
              if (turn === null || turn.turnId !== turnId) {
                const failed = await deps.turnState.getTurn(turnId);
                if (failed?.status === TURN_STATUS_FAILED) {
                  guard(
                    formatStreamError(
                      failed.errorDetail ?? "Interactive turn failed.",
                    ),
                  );
                  return;
                }
                // No terminal frame yet and the turn is gone — end cleanly; the
                // messages endpoint has the durable truth.
                return;
              }
              maybeStartRunner();
            }
          } catch (error) {
            // The SSE error frame is browser-facing: a stable sentence plus a log
            // entry, never the raw exception text (subscription internals like
            // "No sandbox event bus configured." are not client vocabulary).
            log.error(
              {
                type: "craft-turn-stream-error",
                sessionId,
                turnId,
                error: error instanceof Error ? error.message : String(error),
              },
              "craft-turn-stream-error",
            );
            guard(formatStreamError("The turn stream failed. Try again."));
          } finally {
            live = false;
            try {
              controller.close();
            } catch {
              // Already closed by client disconnect.
            }
          }
        })();

        // Client teardown: cancel() (the stream machinery's own hook) and the request's
        // abort signal both stop the loop and return() the bus iterator, whose finally
        // unsubscribes.
      },
      cancel: () => {
        stopStreaming();
      },
    });

    context.req.raw.signal?.addEventListener("abort", stopStreaming, {
      once: true,
    });

    return new Response(stream, { status: 200, headers: CRAFT_SSE_HEADERS });
  });

  return app;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
