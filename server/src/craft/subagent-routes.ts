/**
 * The subagent direct-push endpoint — ported from onyx
 * `session/messages.py`'s POST /sessions/{id}/subagents/{subagent_session_id}/send-message.
 *
 * Body `{content}` with extra=forbid (a stray key is a client bug, not a prompt). The response is
 * a synchronous SSE stream in the same wire format as the turn stream (eventToSse + the SSE
 * headers + keepalive comments), closed by a `prompt_response`/`error` frame. No InteractiveTurn
 * is minted and nothing persists: the request itself owns the subagent prompt, so a client
 * disconnect aborts it (the manager's generator teardown does the abort — the runner-less path's
 * replacement for the runner's cancel semantics).
 */

import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/public";
import { isBuildPacket } from "./events/packets";
import { isKeepalive, isPromptResponse, isSandboxError } from "./events/types";
import type { CraftSessionManager } from "./manager";
import type { CraftStore } from "./store";
import { eventToSse } from "./streaming";
import { CRAFT_SSE_HEADERS } from "./turn-routes";

type Json = Record<string, unknown>;

export type SubagentRoutesDeps = {
  store: CraftStore;
  manager: CraftSessionManager;
  /** Resolves the Bot whose sandbox hosts a session (routing the subagent prompt). */
  botIdFor: (sessionId: string) => Promise<string | null>;
};

function formatStreamError(detail: string): string {
  const payload = {
    type: "error",
    message: detail,
    timestamp: new Date().toISOString(),
  };
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function createSubagentRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  deps: SubagentRoutesDeps,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  app.post(
    "/sessions/:sessionId/subagents/:ocSessionId/send-message",
    async (context) => {
      const actor = context.var.actor;
      const sessionId = context.req.param("sessionId");
      const ocSessionId = context.req.param("ocSessionId");

      // Body first (onyx's pydantic extra=forbid answers before the session lookup).
      const body = (await context.req.json().catch(() => null)) as Json | null;
      if (!(body instanceof Object) || Array.isArray(body)) {
        return context.json({ error: "content is required" }, 400);
      }
      for (const key of Object.keys(body)) {
        if (key !== "content") {
          return context.json({ error: "extra fields are not allowed" }, 400);
        }
      }
      if (typeof body.content !== "string" || body.content.length === 0) {
        return context.json({ error: "content is required" }, 400);
      }
      const content = body.content;

      const session = await deps.store.getSession(sessionId, actor.id);
      if (!session) {
        return context.json({ error: "Session not found" }, 404);
      }
      const botId = await deps.botIdFor(sessionId);
      if (!botId) {
        return context.json(
          { error: "No sandbox configured for this session." },
          400,
        );
      }

      // The request's abort signal is the disconnect signal: breaking the for-await
      // runs the generator's teardown, which aborts the posted subagent prompt.
      const signal = context.req.raw.signal;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          let live = true;
          const guard = (text: string) => {
            if (!live) return;
            try {
              controller.enqueue(encoder.encode(text));
            } catch {
              // Client gone; the loop's live/signal checks close us out.
            }
          };

          void (async () => {
            try {
              const events = deps.manager.yieldSubagentSandboxEvents({
                session,
                botId,
                opencodeSessionId: ocSessionId,
                content,
                userId: actor.id,
              });
              for await (const event of events) {
                if (!live || signal.aborted) return;
                guard(eventToSse(event));
                const chunkType = isKeepalive(event)
                  ? null
                  : isBuildPacket(event)
                    ? event.type
                    : isPromptResponse(event)
                      ? "prompt_response"
                      : isSandboxError(event)
                        ? "error"
                        : "unknown";
                if (chunkType === "prompt_response" || chunkType === "error") {
                  return;
                }
              }
            } catch (error) {
              guard(formatStreamError(String(error)));
            } finally {
              live = false;
              try {
                controller.close();
              } catch {
                // Already closed by client disconnect.
              }
            }
          })();
        },
      });

      return new Response(stream, { status: 200, headers: CRAFT_SSE_HEADERS });
    },
  );

  return app;
}
