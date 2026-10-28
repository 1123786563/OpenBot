/**
 * The web surface of the code interpreter: one POST that runs a task and returns the outcome.
 *
 * `canUseBot` is required, not optional, for the same reason the computer routes demand it: a new
 * deployment must not be able to wire this up without answering "who may act as this Bot".
 */
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getLogger } from "../../../shared/logger";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AppVariables } from "../auth/public";
import type { CodeRunGateway } from "./gateway";

const log = getLogger("server");

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
  // A task is prose, not a payload: the bound stays well above any real task so an
  // authenticated caller cannot park a megabyte of JSON in the sandbox path.
  app.use("*", bodyLimit({ maxSize: 65_536 }));

  // Gateway, audit-store and access-check faults answer in the same { error } shape as
  // everything this surface returns, never as a framework text 500.
  app.onError((error, context) => {
    log.error({ err: error }, "A code-run route failed.");
    return context.json(
      { error: "The code run could not be completed. Try again." },
      500,
    );
  });

  app.post("/runs", async (context) => {
    const actor = context.var.actor;
    const body = (await context.req.json().catch(() => undefined)) as
      | { botId?: unknown; task?: unknown; timeoutSeconds?: unknown }
      | undefined;
    const botId = typeof body?.botId === "string" ? body.botId : "";
    const task = typeof body?.task === "string" ? body.task : "";
    const timeoutSeconds =
      typeof body?.timeoutSeconds === "number"
        ? body.timeoutSeconds
        : undefined;
    if (!botId || !task)
      return context.json(
        { error: "botId and task are required strings." },
        400,
      );
    if (
      timeoutSeconds !== undefined &&
      (timeoutSeconds < 1 || timeoutSeconds > 600)
    )
      return context.json(
        { error: "timeoutSeconds must be between 1 and 600." },
        400,
      );
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
    if (!botId)
      return context.json({ error: "botId is a required string." }, 400);
    if (!(await canUseBot(actor, botId)))
      return context.json(
        { error: "You may not reset this Bot's workspace." },
        403,
      );

    const outcome = await factory({
      botId,
      ownerUserId: actor.id,
    }).resetWorkspace();
    return context.json(outcome, outcome.ok ? 200 : 409);
  });

  return app;
}
