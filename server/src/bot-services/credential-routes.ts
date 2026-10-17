import { type Context, Hono, type MiddlewareHandler } from "hono";
import { requireAdmin, type AppVariables } from "../auth/guards";
import type { BotServiceStore } from "./store";
import type { BotServiceRegistry } from "./registry";
import {
  BOT_ID_PATTERN,
  BotServiceCredentialMissingError,
  BotServiceInputError,
  BotServiceNotFoundError,
} from "./types";

/**
 * The administrator's credential surface for the bot service registry (Bifrost #235, 04.2),
 * mounted under `/api/admin/bot-services` beside 04.1's registry routes.
 *
 * These routes are the ONLY place a credential's plaintext is ever handed out: issuing and
 * rotating answer with the secret exactly once, and every other answer — the masked status read,
 * a revocation, a refusal — carries none. The boundary is administrator-only like the registry
 * itself, and it is not the authentication boundary: here a missing bot is an honest 404 an
 * administrator can act on, because the uniform silence is the authentication failure's duty,
 * not a management route's.
 */
export function botServiceCredentialRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  registry: BotServiceStore | BotServiceRegistry | undefined,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  app.use("*", requireUser);
  const credentials =
    registry && "credentials" in registry ? registry.credentials : undefined;
  if (!credentials) {
    app.all("*", (context) =>
      context.json(
        {
          error: "The bot service credential surface is not available.",
          code: "bot_service_credentials_unavailable",
        },
        503,
      ),
    );
    return app;
  }
  app.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });

  /** A botId that cannot be a service identity is malformed input, not a missing row. */
  function botIdOf(
    context: Context<{ Variables: AppVariables }>,
  ): string | Response {
    const botId = context.req.param("botId") ?? "";
    if (!BOT_ID_PATTERN.test(botId)) {
      return context.json(
        {
          error: "The botId is not a valid service identity.",
          code: "bot_service_invalid",
        },
        400,
      );
    }
    return botId;
  }

  const notFound = (context: Context<{ Variables: AppVariables }>) =>
    context.json(
      {
        error: "No bot service is registered under that botId.",
        code: "bot_service_not_found",
      },
      404,
    );

  const missing = (context: Context<{ Variables: AppVariables }>) =>
    context.json(
      {
        error: "That bot service has no live credential.",
        code: "bot_service_credential_missing",
      },
      409,
    );

  app.post("/:botId/credentials", async (context) => {
    const botIdOr = botIdOf(context);
    if (botIdOr instanceof Response) return botIdOr;
    const botId = botIdOr;
    const actorId = context.var.actor.id;
    try {
      const issued = await credentials.issue(botId, actorId);
      return context.json(
        { botServiceCredential: { ...issued, secret: issued.secret } },
        201,
      );
    } catch (error) {
      if (error instanceof BotServiceNotFoundError) return notFound(context);
      if (error instanceof BotServiceInputError)
        return context.json(
          { error: error.message, code: "bot_service_invalid" },
          400,
        );
      throw error;
    }
  });

  app.post("/:botId/credentials/rotate", async (context) => {
    const botIdOr = botIdOf(context);
    if (botIdOr instanceof Response) return botIdOr;
    const botId = botIdOr;
    const actorId = context.var.actor.id;
    try {
      const issued = await credentials.rotate(botId, actorId);
      return context.json(
        { botServiceCredential: { ...issued, secret: issued.secret } },
        201,
      );
    } catch (error) {
      if (error instanceof BotServiceNotFoundError) return notFound(context);
      if (error instanceof BotServiceCredentialMissingError)
        return missing(context);
      if (error instanceof BotServiceInputError)
        return context.json(
          { error: error.message, code: "bot_service_invalid" },
          400,
        );
      throw error;
    }
  });

  app.delete("/:botId/credentials", async (context) => {
    const botIdOr = botIdOf(context);
    if (botIdOr instanceof Response) return botIdOr;
    const botId = botIdOr;
    const actorId = context.var.actor.id;
    try {
      const revoked = await credentials.revoke(botId, actorId);
      return context.json({ botServiceCredential: revoked });
    } catch (error) {
      if (error instanceof BotServiceNotFoundError) return notFound(context);
      if (error instanceof BotServiceCredentialMissingError)
        return missing(context);
      if (error instanceof BotServiceInputError)
        return context.json(
          { error: error.message, code: "bot_service_invalid" },
          400,
        );
      throw error;
    }
  });

  app.get("/:botId/credentials", async (context) => {
    const botIdOr = botIdOf(context);
    if (botIdOr instanceof Response) return botIdOr;
    const botId = botIdOr;
    try {
      return context.json({
        botServiceCredential: await credentials.status(botId),
      });
    } catch (error) {
      if (error instanceof BotServiceNotFoundError) return notFound(context);
      if (error instanceof BotServiceInputError)
        return context.json(
          { error: error.message, code: "bot_service_invalid" },
          400,
        );
      throw error;
    }
  });

  return app;
}
