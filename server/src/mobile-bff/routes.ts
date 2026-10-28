import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { getLogger } from "../../../shared/logger";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { AppVariables } from "../auth/guards";
import type { ChannelStore } from "../channels/routes";
import {
  OpenMuseConnectionRefusedError,
  OpenMuseOwnerDisabledError,
  OpenMuseVendorUnavailableError,
} from "../openmuse-connectors/google-oauth";
import { OpenMuseFileQuotaError } from "../openmuse-files/store";
import { OpenMuseTaskQuotaError } from "../openmuse-tasks/store";
import { OpenMuseMailVendorError } from "../openmuse-mail/client";
import type { MobileBffActivityReader } from "./activity";
import type { OpenMuseBotProvisioner } from "./openmuse-bot";
import type { MobileBffWorkspaceReader } from "./workspace";

const log = getLogger("server");

/**
 * `/api/mobile`: thin aggregation for the OpenMuse mobile client
 * (the `apps/openmuse` submodule, `apps/mobile`).
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
  openMuseProvisioner?: OpenMuseBotProvisioner;
  /**
   * The personal-files sub-app, mounted only where the assembly built one
   * (`/api/mobile/openmuse-files`). Mount-only on purpose: the sub-app
   * carries its own session guard and its own 20 MiB body limit, and it is
   * mounted before the 8 KiB family body limit below so that limit — sized
   * for this layer's JSON reads — never wraps an upload.
   */
  openMuseFiles?: Hono<{ Variables: AppVariables }>;
  /**
   * The OpenMuse Tasks sub-app (T01): create+list queued tasks at /openmuse-tasks.
   * Mounted before the 8 KiB family body limit below, so it must carry its own
   * body limit: its POST handlers buffer and parse request bodies, and this
   * layer's limit never wraps them (it carries 64 KiB).
   */
  openMuseTasks?: Hono<{ Variables: AppVariables }>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  if (deps.openMuseFiles) {
    routes.route("/openmuse-files", deps.openMuseFiles);
  }
  if (deps.openMuseTasks) {
    routes.route("/openmuse-tasks", deps.openMuseTasks);
  }
  routes.use("*", bodyLimit({ maxSize: 8_192 }));
  routes.onError((error, context) => {
    // A sub-app's deliberate HTTP answer — a body limit's 413, say — is an
    // answer, not an error: pass it through instead of masking it as 503.
    if (error instanceof HTTPException) return error.getResponse();
    /*
     * `route()` merges a sub-app's route handlers, not its application-level `onError`, so a
     * sub-app's deliberate error classes land HERE at the mount. Without these branches the
     * files sub-app's stable contract (§4's 409 connection_required that sends the client to
     * consent, the 403 of a disabled owner, the 502 of a vendor failure) degrades to this
     * layer's 503 — which tells the client to retry a request that can never succeed.
     */
    /*
     * Three stores in this tree declare an OpenMuseOwnerDisabledError (files, tasks, and the
     * connectors one imported above), and the mounted sub-apps throw their OWN — an instanceof
     * against any one class never matches the others', which is how a disabled owner's 403 used
     * to fall through to the 503 below. The name is the stable contract here, not the class.
     */
    if (
      error instanceof OpenMuseOwnerDisabledError ||
      error.name === "OpenMuseOwnerDisabledError"
    ) {
      return context.json(
        { error: "This owner's files are unavailable." },
        403,
      );
    }
    if (error instanceof OpenMuseConnectionRefusedError) {
      return context.json(
        { error: error.message, code: "connection_required" },
        error.status,
      );
    }
    if (error instanceof OpenMuseVendorUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    if (error instanceof OpenMuseMailVendorError) {
      return context.json({ error: error.message }, 502);
    }
    if (error instanceof OpenMuseFileQuotaError) {
      /*
       * The files sub-app's own onError answers this 413 standalone, but `route()` does not
       * carry a sub-app's onError to the mount — restated here so the quota keeps its stable
       * contract at this layer too: a determinate "delete some files first", never the
       * retry-me 503 below, which would send the client back into the same refusal.
       */
      return context.json(
        {
          error: `That upload would pass this owner's ${error.capBytes}-byte Files quota. Delete some files first.`,
          code: error.code,
        },
        413,
      );
    }
    /*
     * The tasks sub-app's quota refusal, restated at the mount for the same reason as the files
     * one above: a determinate "delete some tasks first" (413), never the retry-me 503 that
     * would send the client straight back into the same refusal.
     */
    if (
      error instanceof OpenMuseTaskQuotaError ||
      error.name === "OpenMuseTaskQuotaError"
    ) {
      return context.json(
        { error: error.message, code: "openmuse_task_quota_exceeded" },
        413,
      );
    }
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

  /**
   * Provision — or find — this person's one private OpenMuse Bot.
   *
   * The one write this seam performs. No user id is accepted, ever: ownership
   * is the authenticated session, and the body is empty or `{}` so a caller
   * cannot ask for anybody else's Bot. Any field at all is refused, because
   * there is nothing a legitimate caller has to say here.
   */
  routes.post("/openmuse-bot", async (context) => {
    if (!deps.openMuseProvisioner) {
      return context.json(
        {
          error: "OpenMuse Bot provisioning is unavailable on this deployment.",
        },
        503,
      );
    }
    const body = await context.req.text();
    z.strictObject({}).parse(
      body.trim() === "" ? {} : (JSON.parse(body) as unknown),
    );
    const provisioned = await deps.openMuseProvisioner.provision(
      context.var.actor,
    );
    return context.json(provisioned);
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
