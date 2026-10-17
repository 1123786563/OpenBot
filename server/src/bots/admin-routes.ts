/**
 * `/api/admin/bots`: the registry of builtin and approved external bot services (04.1, #234).
 *
 * Every route is administrator-only and audited; the registry itself grants no credentials
 * and no credit authority (service authentication is 04.2, per-user grants come later).
 * There is no DELETE route on purpose: a disabled botId stays reserved, so an audit trail
 * cannot be repointed by recycling the id. botId and kind are immutable after registration.
 */
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";
import {
  BotIdTakenError,
  type BotServiceRecord,
  editBotService,
  listBotServices,
  parseBotServiceEdit,
  parseBotServiceInput,
  registerBotService,
  setBotServiceStatus,
} from "./service-registry";

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

  routes.get("/", async (context) =>
    context.json(await listBotServices(deps.database)),
  );

  routes.post("/", async (context) => {
    const parsed = parseBotServiceInput(await context.req.json());
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    let record: BotServiceRecord;
    try {
      record = await registerBotService(deps.database, parsed.value);
    } catch (error) {
      if (error instanceof BotIdTakenError) {
        return context.json({ error: error.message }, 409);
      }
      throw error;
    }
    if (deps.audit) {
      await recordAuditEvent(deps.audit, {
        eventType: "bot_service.registered",
        targetType: "bot_service",
        targetId: record.botId,
        actorUserId: context.var.actor.id,
        payload: parsed.value,
      });
    }
    return context.json(record, 201);
  });

  routes.patch("/:botId", async (context) => {
    const botId = context.req.param("botId");
    const parsed = parseBotServiceEdit(await context.req.json());
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    const record = await editBotService(deps.database, botId, parsed.value);
    if (!record) {
      return context.json({ error: `Unknown botId "${botId}".` }, 404);
    }
    if (deps.audit) {
      await recordAuditEvent(deps.audit, {
        eventType: "bot_service.edited",
        targetType: "bot_service",
        targetId: botId,
        actorUserId: context.var.actor.id,
        payload: parsed.value,
      });
    }
    return context.json(record);
  });

  routes.post("/:botId/status", async (context) => {
    const botId = context.req.param("botId");
    const body = await context.req.json().catch(() => ({}));
    const status = body?.status;
    if (status !== "active" && status !== "disabled") {
      return context.json(
        { error: 'status must be "active" or "disabled".' },
        400,
      );
    }
    const record = await setBotServiceStatus(deps.database, botId, status);
    if (!record) {
      return context.json({ error: `Unknown botId "${botId}".` }, 404);
    }
    if (deps.audit) {
      await recordAuditEvent(deps.audit, {
        eventType: "bot_service.status_changed",
        targetType: "bot_service",
        targetId: botId,
        actorUserId: context.var.actor.id,
        payload: { status },
      });
    }
    return context.json(record);
  });

  return routes;
}
