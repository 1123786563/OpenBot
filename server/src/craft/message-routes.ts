/**
 * Craft message + turn admission routes — ported from onyx
 * `session/messages.py` + `interactive_turns/api.py`, Hono-shaped.
 *
 * The load-bearing endpoint is POST /sessions/:id/send-message: idempotent by
 * client_request_id (a retry gets the same turn back), 409 on a live turn, attachments
 * validated to live under `attachments/`, the USER row written, the turn created in Redis,
 * and the runner started fire-and-forget — the response is the turn, never the stream. The
 * SSE attach endpoint (turns/:turnId/events) lives in turn-routes.ts.
 */

import { randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { CraftConfig } from "./config";
import type { InterruptFence } from "./interrupt";
import type { CraftSessionManager } from "./manager";
import type { PromptAttachment } from "./opencode/serve-client";
import type { CraftStore } from "./store";
import type { TurnExecutor } from "./turn-executor";
import type { TurnStateStore } from "./turn-state";
import {
  type InteractiveTurn,
  InteractiveTurnLockError,
  TURN_STATUS_FAILED,
} from "./turn-state";

type Json = Record<string, unknown>;

export type MessageRoutesDeps = {
  config: CraftConfig;
  store: CraftStore;
  manager: CraftSessionManager;
  turnState: TurnStateStore;
  executor: TurnExecutor;
  /** Resolves the Bot whose sandbox hosts a session (attachment + model checks). */
  botIdFor: (sessionId: string) => Promise<string | null>;
  /** The interrupt fence — set by the interrupt endpoint, polled by the runner. */
  fence: InterruptFence;
};

/** The wire shape of one attachment on a send-message request (onyx MessageAttachment). */
type MessageAttachmentInput = {
  name?: unknown;
  path?: unknown;
  mime_type?: unknown;
};

/** onpy's path validator: must be relative, ≥2 parts, rooted at attachments/, no "..". */
function validateAttachmentPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.startsWith("/")) return null;
  const parts = value.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return null;
  if (parts[0] !== "attachments") return null;
  if (parts.includes("..")) return null;
  return value;
}

export function interactiveTurnResponse(turn: {
  turnId: string;
  sessionId: string;
  status: string;
  turnIndex: number;
}): Json {
  return {
    turn_id: turn.turnId,
    session_id: turn.sessionId,
    status: turn.status,
    turn_index: turn.turnIndex,
  };
}

export function createMessageRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  deps: MessageRoutesDeps,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  // ── GET /sessions/:sessionId/messages ───────────────────────────────────────
  app.get("/sessions/:sessionId/messages", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const session = await deps.store.getSession(sessionId, actor.id);
    if (!session) {
      return context.json({ error: "Session not found" }, 404);
    }
    const messages = await deps.store.getMessages(sessionId);
    return context.json({
      messages: messages.map((message) => ({
        id: message.id,
        session_id: message.sessionId,
        turn_index: message.turnIndex,
        type: message.type,
        message_metadata: message.messageMetadata,
        created_at: message.createdAt.toISOString(),
      })),
    });
  });

  // ── POST /sessions/:sessionId/send-message ─────────────────────────────────
  app.post("/sessions/:sessionId/send-message", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const body = (await context.req.json().catch(() => ({}))) as {
      content?: unknown;
      client_request_id?: unknown;
      attachments?: unknown;
      provider?: unknown;
      provider_id?: unknown;
      model?: unknown;
    };
    if (typeof body.content !== "string" || body.content.length === 0) {
      return context.json({ error: "content is required" }, 400);
    }
    const content = body.content;

    const session = await deps.store.getSession(sessionId, actor.id);
    if (!session) {
      return context.json({ error: "Session not found" }, 404);
    }

    const clientRequestId =
      typeof body.client_request_id === "string" && body.client_request_id
        ? body.client_request_id
        : randomUUID();

    // The active-turn lock spans the WHOLE admission (onyx messages.py holds it
    // from idempotency check through turn create + commit). Releasing it after
    // the checks alone would let two concurrent sends both pass "no active
    // turn" and mint competing turns; the lock is the admission serializer.
    // The lock is NOT reentrant: a failure finish must run after it unwinds
    // (onyx releases the lock before finish_turn on the commit-failure path).
    // Holder object — a plain `let` assigned inside the closure would narrow
    // to `never` at the read below TS's closure-unaware flow analysis.
    const pendingFailure: { turnId: string | null } = { turnId: null };
    let outcome: { response: Response } | { turn: InteractiveTurn };
    try {
      outcome = await deps.turnState.withActiveTurnLock(
        sessionId,
        async (): Promise<
          { response: Response } | { turn: InteractiveTurn }
        > => {
          // Idempotent retry: the same client_request_id returns the same turn.
          const existing = await deps.turnState.getTurnForRequest({
            sessionId,
            userId: actor.id,
            clientRequestId,
          });
          if (existing) {
            return {
              response: context.json(interactiveTurnResponse(existing)),
            };
          }
          const active = await deps.turnState.getActiveTurn({
            sessionId,
            userId: actor.id,
          });
          if (active) {
            return {
              response: context.json(
                { error: "This session is busy with a previous turn." },
                409,
              ),
            };
          }

          // Attachments: validate paths under attachments/; only image/* ride
          // the prompt.
          const rawAttachments = Array.isArray(body.attachments)
            ? (body.attachments as MessageAttachmentInput[])
            : [];
          const validAttachments: PromptAttachment[] = [];
          for (const attachment of rawAttachments) {
            const path = validateAttachmentPath(attachment.path);
            if (
              path === null ||
              typeof attachment.name !== "string" ||
              typeof attachment.mime_type !== "string"
            ) {
              return {
                response: context.json(
                  {
                    error:
                      "Attachment path must be inside the attachments directory",
                  },
                  400,
                ),
              };
            }
            validAttachments.push({
              name: attachment.name,
              path,
              mimeType: attachment.mime_type,
            });
          }
          const promptAttachments = validAttachments.filter((attachment) =>
            attachment.mimeType.startsWith("image/"),
          );

          // Per-message model override (onyx: both provider and model set together).
          let agentProvider = session.agentProvider;
          let agentModel = session.agentModel;
          if (
            typeof body.provider === "string" &&
            typeof body.model === "string"
          ) {
            agentProvider = body.provider;
            agentModel = body.model;
          }

          const turnIndex = await deps.store.countUserMessages(sessionId);
          const messageMetadata: Json = {
            type: "user_message",
            content: { type: "text", text: body.content },
          };
          if (validAttachments.length > 0) {
            messageMetadata.attachments = validAttachments.map(
              (attachment) => ({
                name: attachment.name,
                path: attachment.path,
                mime_type: attachment.mimeType,
              }),
            );
          }

          // Create the turn FIRST (Redis), then the USER row: if the row write
          // fails we finish the real turn id FAILED (onyx's commit-failure path)
          // and a retry with the same client_request_id resolves that turn
          // instead of duplicating the USER row.
          const turn = await deps.turnState.createInteractiveTurn({
            sessionId,
            userId: actor.id,
            clientRequestId,
            prompt: content,
            turnIndex,
            attachments: promptAttachments,
          });
          try {
            await deps.store.createMessage({
              sessionId,
              type: "user",
              turnIndex,
              messageMetadata,
            });
          } catch (error) {
            // Deferred: finishTurn takes the same active-turn lock, which this
            // body still holds — finishing here would deadlock until the lock
            // wait expired and swallow the FAILED transition. The catch below
            // finishes the turn once withActiveTurnLock has released.
            pendingFailure.turnId = turn.turnId;
            throw error;
          }
          if (
            agentProvider !== session.agentProvider ||
            agentModel !== session.agentModel
          ) {
            await deps.store.updateSession(sessionId, {
              agentProvider,
              agentModel,
            });
          }
          return { turn };
        },
      );
    } catch (error) {
      if (pendingFailure.turnId !== null) {
        // The admission lock has unwound — finish the real turn id FAILED
        // (onyx's commit-failure path) so a retry with the same
        // client_request_id resolves this turn instead of duplicating the row.
        await deps.turnState
          .finishTurn({
            turnId: pendingFailure.turnId,
            status: TURN_STATUS_FAILED,
            errorDetail: "Failed to persist user message.",
          })
          .catch(() => undefined);
      }
      if (error instanceof InteractiveTurnLockError) {
        return context.json(
          { error: "This session is busy with a previous turn." },
          409,
        );
      }
      throw error;
    }
    if ("response" in outcome) return outcome.response;

    // Fire-and-forget; attach streams retry the claim if this process dies.
    deps.executor.startInteractiveTurnRunner(outcome.turn.turnId);
    return context.json(interactiveTurnResponse(outcome.turn));
  });

  // ── POST /sessions/:sessionId/interrupt ─────────────────────────────────────
  app.post("/sessions/:sessionId/interrupt", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const session = await deps.store.getSession(sessionId, actor.id);
    if (!session) {
      return context.json({ error: "Session not found" }, 404);
    }
    // Two complementary signals (onyx parity): the fence covers the window
    // before the opencode session id exists (the runner's consume loop polls it
    // ~1/s, aborts, and records the turn CANCELLED); the direct abort stops
    // sandbox-side work even when no live runner is polling the fence.
    await deps.fence.requestInterrupt(sessionId).catch(() => undefined);
    const interruptible = await deps.manager.interruptMessage(session);
    return context.json({ interrupted: interruptible });
  });

  // ── GET /sessions/:sessionId/turns/active ──────────────────────────────────
  app.get("/sessions/:sessionId/turns/active", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const session = await deps.store.getSession(sessionId, actor.id);
    if (!session) {
      return context.json({ error: "Session not found" }, 404);
    }
    const turn = await deps.turnState.getActiveTurn({
      sessionId,
      userId: actor.id,
    });
    return context.json(turn ? interactiveTurnResponse(turn) : null);
  });

  return app;
}
