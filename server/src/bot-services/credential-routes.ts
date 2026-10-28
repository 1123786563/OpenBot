import { type Context, Hono, type MiddlewareHandler } from "hono";
import { getLogger } from "../../../shared/logger";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { BotServiceRegistry } from "./registry";
import type { BotServiceStore } from "./store";
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
    // The 503 answers after the admin gate, not instead of it: a signed-in non-admin
    // learns nothing about this surface, not even that it exists.
    app.all("*", (context) => {
      const denied = requireAdmin(context);
      if (denied) return denied;
      return context.json(
        {
          error: "The bot service credential surface is not available.",
          code: "bot_service_credentials_unavailable",
        },
        503,
      );
    });
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

  const log = getLogger("server");
  // The fallback every catch shares: this surface's answers are JSON with a code, so
  // an unexpected failure keeps that shape (Hono's plain-text 500 breaks JSON clients)
  // and lands in the log with its cause.
  const internal = (
    context: Context<{ Variables: AppVariables }>,
    error: unknown,
  ) => {
    log.error(
      {
        type: "bot-service-credential-route-failed",
        error: String(error),
      },
      "bot-service-credential-route-failed",
    );
    return context.json(
      {
        error:
          "The bot service credential surface could not complete the request.",
        code: "bot_service_internal",
      },
      500,
    );
  };

  app.post("/:botId/credentials", async (context) => {
    const botIdOr = botIdOf(context);
    if (botIdOr instanceof Response) return botIdOr;
    const botId = botIdOr;
    const actorId = context.var.actor.id;
    try {
      const issued = await credentials.issue(botId, actorId);
      return context.json({ botServiceCredential: issued }, 201);
    } catch (error) {
      if (error instanceof BotServiceNotFoundError) return notFound(context);
      if (error instanceof BotServiceInputError)
        return context.json(
          { error: error.message, code: "bot_service_invalid" },
          400,
        );
      return internal(context, error);
    }
  });

  app.post("/:botId/credentials/rotate", async (context) => {
    const botIdOr = botIdOf(context);
    if (botIdOr instanceof Response) return botIdOr;
    const botId = botIdOr;
    const actorId = context.var.actor.id;
    try {
      const issued = await credentials.rotate(botId, actorId);
      // 201, like issue: a new secret was minted, so this is a creation answer, not
      // an update of an existing resource.
      return context.json({ botServiceCredential: issued }, 201);
    } catch (error) {
      if (error instanceof BotServiceNotFoundError) return notFound(context);
      if (error instanceof BotServiceCredentialMissingError)
        return missing(context);
      if (error instanceof BotServiceInputError)
        return context.json(
          { error: error.message, code: "bot_service_invalid" },
          400,
        );
      return internal(context, error);
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
      return internal(context, error);
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
      return internal(context, error);
    }
  });

  return app;
}
