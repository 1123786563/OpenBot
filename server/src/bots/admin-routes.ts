/**
 * `/api/admin/bots`: the registry of builtin and approved external bot services.
 *
 * Registration and status changes are administrator-only and audited; the registry itself grants no
 * credentials and no credit authority (auth is 04.2). There is no delete route on purpose: a
 * disabled botId stays reserved so an audit trail cannot be repointed by recycling the id.
 */
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AuditStore, recordAuditEvent } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";
import { BotIdTakenError, listBotServices, parseBotServiceInput, registerBotService, setBotServiceStatus } from "./service-registry";

type RequireAdmin = (
  context: Context<{ Variables: AppVariables }>,
) => Response | undefined;

export function createBotAdminRoutes(deps: {
  database: Database;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  requireAdmin?: RequireAdmin;
  /** Present on a deployment with the audit store; absent skips the trail, as everywhere else. */
  audit?: AuditStore;
}) {
  const admin = deps.requireAdmin ?? requireAdmin;
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);

  routes.use("*", async (context, next) => {
    const denied = admin(context);
    if (denied) return denied;
    return next();
  });

  routes.get("/", async (context) => context.json(await listBotServices(deps.database)));

  routes.post("/", async (context) => {
    const parsed = parseBotServiceInput(await context.req.json());
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    try {
      await registerBotService(deps.database, parsed.value);
    } catch (error) {
      if (error instanceof BotIdTakenError) return context.json({ error: error.message }, 409);
      throw error;
    }
    if (deps.audit) {
      await recordAuditEvent(deps.audit, {
        eventType: "bot_service.registered",
        targetType: "bot_service",
        targetId: parsed.value.botId,
        actorUserId: context.var.actor.id,
        payload: parsed.value,
      });
    }
    return context.json({ ok: true }, 201);
  });

  routes.post("/:botId/status", async (context) => {
    const { status } = z.object({ status: z.enum(["active", "disabled"]) }).parse(await context.req.json());
    await setBotServiceStatus(deps.database, context.req.param("botId"), status);
    if (deps.audit) {
      await recordAuditEvent(deps.audit, {
        eventType: "bot_service.status_changed",
        targetType: "bot_service",
        targetId: context.req.param("botId"),
        actorUserId: context.var.actor.id,
        payload: { status },
      });
    }
    return context.json({ ok: true });
  });

  return routes;
}
