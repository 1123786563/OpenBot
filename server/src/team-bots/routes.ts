import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { BotCatalog } from "../agents/public";
import type { AppVariables } from "../auth/public";
import { afterExposureChange } from "../plugins/exposure-change";
import type { SharedUseStore } from "../plugins/shared-use-store";
import { getLogger } from "../../../shared/logger";
import {
  TeamBotForbiddenError,
  TeamBotNotFoundError,
  TeamBotRefusedError,
  type TeamBots,
} from "./team-bots";

const log = getLogger("server");

/** Malformed JSON is the caller's fault: it takes the 400 lane, not a 500. */
async function jsonBody(context: {
  req: { json(): Promise<unknown> };
}): Promise<unknown> {
  return context.req.json().catch(() => {
    throw new TeamBotRefusedError("The request body must be JSON.");
  });
}

export function createTeamBotRoutes(
  teamBots: TeamBots,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  sharedUse?: SharedUseStore,
  /**
   * MOD05（#625，根 #620）：发布/撤回两 handler 改经 M03 BotCatalog 门面（装配
   * 注入）；未注入门面的调用方保持 teamBots 直用旧路径——两路行为逐字节
   * 等价（组内自由）。最小消费面：只取 publish/withdraw 两能力。
   */
  botCatalog?: Pick<BotCatalog, "publish" | "withdraw">,
) {
  // The shared-approval refresh both exposure-growing routes run after their mutation lands.
  // It writes many approval rows and can fail on its own; that failure is logged here and must
  // not turn an already-committed change into a 500 the client would retry blind.
  const refreshSharedApps = async (
    actor: AppVariables["actor"],
    botId: string,
  ): Promise<Awaited<ReturnType<typeof afterExposureChange>>> => {
    try {
      return await afterExposureChange(sharedUse, actor, botId);
    } catch (error) {
      log.error(
        {
          type: "team-bot-shared-app-refresh-failed",
          botId,
          error,
        },
        "The Bot changed exposure, but the shared-approval refresh failed.",
      );
      return { approved: [], needsApproval: [] };
    }
  };
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    // The four outcomes the surface names answer their own sentences; anything else is an
    // outage whose detail stays in the log, never in the response.
    if (error instanceof TeamBotForbiddenError)
      return context.json({ error: error.message }, 403);
    if (error instanceof TeamBotNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof TeamBotRefusedError || error instanceof z.ZodError)
      return context.json({ error: error.message }, 400);
    log.error(
      {
        type: "team-bot-route-error",
        errorType: error.name,
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      },
      "team-bot-route-error",
    );
    return context.json({ error: "The Team Bot request failed. Try again." }, 500);
  });
  routes.get("/", async (context) =>
    context.json({
      teamBots: await teamBots.list(context.var.actor),
      publishable: await teamBots.publishable(context.var.actor),
      /**
       * The audience ranges the design allows a publication to choose — the same enum the PUT
       * below parses, answered here so a client renders the choices the server actually takes
       * rather than a wider or cross-company option of its own invention (MT085 AC2).
       */
      publishAudiences: ["team", "people"],
    }),
  );
  routes.delete("/consents", async (context) => {
    await teamBots.clearConsents(context.var.actor);
    return context.body(null, 204);
  });
  routes.put("/:botId/publication", async (context) => {
    const botId = context.req.param("botId");
    const input = z
      .strictObject({
        audience: z.enum(["team", "people"]),
        emails: z.array(z.string().max(320)).max(200).default([]),
        groups: z.array(z.string().max(200)).max(100).default([]),
      })
      .parse(await jsonBody(context));
    await (botCatalog ?? teamBots).publish(context.var.actor, botId, input);
    // The publication is already committed: an approval-refresh fault must not read back as a
    // failed publish (the retry would just publish again), so the refresh is best-effort.
    const sharedApps = await refreshSharedApps(context.var.actor, botId);
    return context.json({ sharedApps });
  });
  routes.delete("/:botId/publication", async (context) => {
    await (botCatalog
      ? botCatalog.withdraw(context.var.actor, context.req.param("botId"))
      : teamBots.unpublish(context.var.actor, context.req.param("botId")));
    return context.body(null, 204);
  });
  routes.post("/:botId/assignments", async (context) => {
    const botId = context.req.param("botId");
    const input = z
      .strictObject({ group: z.string().min(1).max(200) })
      .parse(await jsonBody(context));
    await teamBots.assign(context.var.actor, botId, input.group);
    // Same best-effort refresh as the publication put: the assignment has already landed.
    const sharedApps = await refreshSharedApps(context.var.actor, botId);
    return context.json({ sharedApps });
  });
  routes.delete("/:botId/assignments/:group", async (context) => {
    await teamBots.unassign(
      context.var.actor,
      context.req.param("botId"),
      decodeURIComponent(context.req.param("group")),
    );
    return context.body(null, 204);
  });
  routes.post("/:botId/consents", async (context) => {
    const input = z
      .strictObject({
        serverId: z.string().min(1).max(200),
        decision: z.enum([
          "allow_once",
          "allow_always",
          "allow_all_team_bots",
          "skip",
        ]),
      })
      .parse(await jsonBody(context));
    await teamBots.consent(
      context.var.actor,
      context.req.param("botId"),
      input.serverId,
      input.decision,
    );
    return context.body(null, 204);
  });
  return routes;
}
