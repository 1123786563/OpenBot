import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AuditStore, recordAuditEvent } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { BotServiceRecord, BotServiceStore } from "./store";
import {
  BOT_ID_PATTERN,
  BotServiceConflictError,
  BotServiceInputError,
  BotServiceNotFoundError,
} from "./types";

/**
 * `/api/admin/bot-services`: the administrator's registration surface for the Bifrost bot
 * service registry (Bifrost #234, 04.1).
 *
 * Every route — including the list — is administrator-only, because the registry is the
 * deployment's own decision about which server-side Bots may present themselves at all; a
 * non-administrator reading it learns nothing they can act on and writing it must be impossible.
 * Registering produces an identity and a declaration and nothing else: no credential is returned
 * (04.2 mints those under its own, narrower trigger), no user authorization is implied, and no
 * credit is attached. Each action lands on the audit trail with who pressed it.
 */
export function botServiceAdminRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  store: BotServiceStore | undefined,
  auditStore: AuditStore | undefined,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  app.use("*", requireUser);
  if (!store) {
    app.all("*", (context) =>
      context.json(
        {
          error: "The bot service registry is not available.",
          code: "bot_service_unavailable",
        },
        503,
      ),
    );
    return app;
  }
  const live = store;
  app.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });

  const registrationInput = z.strictObject({
    botId: z
      .string()
      .regex(BOT_ID_PATTERN, "The botId is not a valid service identity."),
    displayName: z.string().trim().min(1).max(200),
    kind: z.enum(["builtin", "external"]),
    capabilities: z
      .array(
        z.enum(["chat", "image", "audio", "embedding", "realtime", "async"]),
      )
      .min(1)
      .refine((value) => new Set(value).size === value.length, {
        message: "A capability may be declared only once.",
      }),
  });

  const patchInput = z
    .strictObject({
      displayName: z.string().trim().min(1).max(200).optional(),
      capabilities: z
        .array(
          z.enum(["chat", "image", "audio", "embedding", "realtime", "async"]),
        )
        .min(1)
        .refine((value) => new Set(value).size === value.length, {
          message: "A capability may be declared only once.",
        })
        .optional(),
    })
    .refine(
      (value) =>
        value.displayName !== undefined || value.capabilities !== undefined,
      { message: "Send the fields to change." },
    );

  /** The record as the admin page and the downstream API read it. Never any credential material. */
  const view = (record: BotServiceRecord) => ({
    botService: {
      botId: record.botId,
      displayName: record.displayName,
      kind: record.kind,
      capabilities: record.capabilities,
      status: record.status,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    },
  });

  const notFound = (context: Context<{ Variables: AppVariables }>) =>
    context.json(
      {
        error: "No bot service is registered under that botId.",
        code: "bot_service_not_found",
      },
      404,
    );

  const invalid = (
    context: Context<{ Variables: AppVariables }>,
    message: string,
  ) => context.json({ error: message, code: "bot_service_invalid" }, 400);

  app.get("/", async (context) =>
    context.json({ botServices: await live.listBotServices() }),
  );

  app.post("/", async (context) => {
    const parsed = registrationInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return invalid(context, "The bot service declaration is not valid.");
    const actorId = context.var.actor.id;
    let record: BotServiceRecord;
    try {
      record = await live.register(parsed.data);
    } catch (error) {
      if (error instanceof BotServiceConflictError)
        return context.json(
          { error: error.message, code: "bot_service_conflict" },
          409,
        );
      if (error instanceof BotServiceInputError)
        return invalid(context, error.message);
      throw error;
    }
    if (auditStore) {
      await recordAuditEvent(auditStore, {
        eventType: "bot_service.registered",
        targetType: "bot_service",
        targetId: record.botId,
        actorUserId: actorId,
        payload: {
          actor: actorId,
          kind: record.kind,
          capabilities: record.capabilities,
        },
      });
    }
    return context.json(view(record), 201);
  });

  app.patch("/:botId", async (context) => {
    const botId = context.req.param("botId");
    const parsed = patchInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) return invalid(context, "Send the fields to change.");
    const actorId = context.var.actor.id;
    let record: BotServiceRecord;
    try {
      record = await live.update(botId, parsed.data);
    } catch (error) {
      if (error instanceof BotServiceNotFoundError) return notFound(context);
      if (error instanceof BotServiceInputError)
        return invalid(context, error.message);
      throw error;
    }
    if (auditStore) {
      await recordAuditEvent(auditStore, {
        eventType: "bot_service.updated",
        targetType: "bot_service",
        targetId: record.botId,
        actorUserId: actorId,
        payload: {
          actor: actorId,
          // What changed, not the new values: the registry holds the current answer, and the
          // trail's job is to say who moved it and when.
          changed: Object.keys(parsed.data),
        },
      });
    }
    return context.json(view(record));
  });

  for (const [action, eventType] of [
    ["disable", "bot_service.disabled"],
    ["enable", "bot_service.enabled"],
  ] as const) {
    app.post(`/:botId/${action}`, async (context) => {
      const botId = context.req.param("botId");
      const actorId = context.var.actor.id;
      let record: BotServiceRecord;
      try {
        record =
          action === "disable"
            ? await live.disable(botId)
            : await live.enable(botId);
      } catch (error) {
        if (error instanceof BotServiceNotFoundError) return notFound(context);
        if (error instanceof BotServiceInputError)
          return invalid(context, error.message);
        throw error;
      }
      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType,
          targetType: "bot_service",
          targetId: record.botId,
          actorUserId: actorId,
          payload: { actor: actorId, status: record.status },
        });
      }
      return context.json(view(record));
    });
  }

  return app;
}
