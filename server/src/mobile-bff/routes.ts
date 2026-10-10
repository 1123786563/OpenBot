import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { getLogger } from "../../../shared/logger";
import type { AgentActor } from "../agents/profile-types";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AppVariables } from "../auth/guards";
import type { ChannelStore } from "../channels/routes";
import type { MobileBffActivityReader } from "./activity";
import type { MobileBffWorkspaceReader } from "./workspace";

const log = getLogger("server");

/**
 * `/api/mobile`: thin aggregation for the OpenMuse mobile client
 * (`apps/openmuse-mobile`).
 *
 * WHAT THIS LAYER IS. A read-mostly convenience seam: the mobile cold start
 * needs three answers the web app already fetches in parallel (me, agents,
 * channels), and starting a conversation needs the channel's three identifiers
 * (`channelId` / `botId` / `threadId`) handed back as one object — the
 * `OpenBotSession` shape the integration spec §6.2 asks for.
 *
 * WHAT THIS LAYER IS NOT. Not a second API surface. It holds no business rules:
 * every write and every domain question goes through the stores the existing
 * routes already use, under the same `requireUser` guard, so a permission rule
 * changed for the web applies to mobile without a second edit here. When a
 * mobile need grows past aggregation (pagination of a join, say), the answer is
 * to extend the owning store — not to grow this file a private query path.
 *
 * WHY NOT `server/src/openmuse/` as the spec sketches. This seam serves the
 * client form factor, not the upstream brand: a second native client or a
 * renamed fork should not have to move house. The spec's layout is otherwise
 * honoured one-to-one (routes / workspace / activity).
 */
export function createMobileBffRoutes(deps: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  agentProfileStore?: AgentProfileStore;
  channelStore?: ChannelStore;
  workspace: MobileBffWorkspaceReader;
  activity?: MobileBffActivityReader;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser, bodyLimit({ maxSize: 8_192 }));
  routes.onError((error, context) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    log.error(
      {
        type: "mobile-bff-route-error",
        error: error.name,
        context: { route: context.req.path },
      },
      "mobile-bff-route-error",
    );
    return context.json(
      { error: "The mobile workspace is unavailable. Try again." },
      503,
    );
  });

  /**
   * The cold-start bundle: one round trip for the roster screen.
   *
   * Read in parallel because they are independent; the answer is never cached
   * (`no-store`) because every field in it is a per-user live answer and a
   * stale roster is worse than a second request.
   */
  routes.get("/workspace", async (context) => {
    const actor = context.var.actor;
    context.header("Cache-Control", "no-store");
    const workspace = await deps.workspace.read(actor);
    return context.json(workspace);
  });

  /**
   * Start or resume one Bot's conversation, returning the session identifiers
   * the mobile adapter layers its threading on.
   *
   * `direct` rather than `create`: the store finds the one conversation this
   * person already has with this Bot before making a new one, which is the
   * semantics a mobile "open Bot" tap wants (re-open ≠ duplicate). The Bot is
   * checked against the same profile store the roster reads, so a Bot the
   * caller cannot list cannot be opened here either.
   */
  routes.post("/conversations", async (context) => {
    const input = z
      .strictObject({ botId: z.string().min(1) })
      .parse(await context.req.json());
    const actor: AgentActor = {
      id: context.var.actor.id,
      role: context.var.actor.role,
    };
    if (deps.agentProfileStore) {
      const bot = await deps.agentProfileStore.get(actor, input.botId);
      if (!bot) return context.json({ error: "No such Bot." }, 404);
    }
    if (!deps.channelStore) {
      return context.json(
        { error: "Conversations are unavailable on this deployment." },
        503,
      );
    }
    const channel = await deps.channelStore.direct(actor, input.botId);
    return context.json(
      {
        channelId: channel.id,
        botId: input.botId,
        threadId: channel.threadId,
        mode: "single",
      },
      201,
    );
  });

  const activity = deps.activity;
  if (activity) {
    routes.get("/activity", async (context) => {
      context.header("Cache-Control", "no-store");
      return context.json(await activity.read(context.var.actor));
    });
  }

  return routes;
}
