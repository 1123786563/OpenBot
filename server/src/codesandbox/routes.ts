/**
 * The web surface of the code interpreter: one POST that runs a task and returns the outcome.
 *
 * `canUseBot` is required, not optional, for the same reason the computer routes demand it: a new
 * deployment must not be able to wire this up without answering "who may act as this Bot".
 */
import { Hono, type MiddlewareHandler } from "hono";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AppVariables } from "../auth/guards";
import type { CodeRunGateway } from "./gateway";

export type CodeRunGatewayFactory = (context: {
  botId: string;
  ownerUserId: string;
}) => CodeRunGateway;

export function createCodeSandboxRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  canUseBot: BotAccessCheck,
  factory: CodeRunGatewayFactory,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  app.post("/runs", async (context) => {
    const actor = context.var.actor;
    const body = (await context.req.json().catch(() => undefined)) as
      | { botId?: unknown; task?: unknown; timeoutSeconds?: unknown }
      | undefined;
    const botId = typeof body?.botId === "string" ? body.botId : "";
    const task = typeof body?.task === "string" ? body.task : "";
    const timeoutSeconds =
      typeof body?.timeoutSeconds === "number" ? body.timeoutSeconds : undefined;
    if (!botId || !task)
      return context.json({ error: "botId and task are required strings." }, 400);
    if (timeoutSeconds !== undefined && (timeoutSeconds < 1 || timeoutSeconds > 600))
      return context.json({ error: "timeoutSeconds must be between 1 and 600." }, 400);
    if (!(await canUseBot(actor, botId)))
      return context.json({ error: "You may not run code as this Bot." }, 403);

    const outcome = await factory({ botId, ownerUserId: actor.id }).run(task, {
      timeoutSeconds,
      toolCallId: undefined,
    });
    return context.json(outcome, outcome.kind === "refused" ? 409 : 200);
  });

  // Reset is a governance action, not a run: the gateway audits the ask before the workspace is
  // touched, and a workspace that is not configured answers refused rather than 404.
  app.post("/reset", async (context) => {
    const actor = context.var.actor;
    const body = (await context.req.json().catch(() => undefined)) as
      | { botId?: unknown }
      | undefined;
    const botId = typeof body?.botId === "string" ? body.botId : "";
    if (!botId) return context.json({ error: "botId is a required string." }, 400);
    if (!(await canUseBot(actor, botId)))
      return context.json({ error: "You may not reset this Bot's workspace." }, 403);

    const outcome = await factory({ botId, ownerUserId: actor.id }).resetWorkspace();
    return context.json(outcome, outcome.ok ? 200 : 409);
  });

  return app;
}
