import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client";
import type { AccountGrant } from "./account-access";
import { assistantName, workspaceBots } from "./workspace-bots";

const renameBody = z.strictObject({ name: assistantName });

type WorkspaceSession =
  | { kind: "authorized"; grant: AccountGrant }
  | { kind: "unconfirmed" }
  | { kind: "signed-out" };

export function workspaceBotRoutes(
  database: Database,
  authorize: (context: Context) => Promise<WorkspaceSession>,
  stillAuthorized: (context: Context, grant: AccountGrant) => Promise<boolean>,
  rename: (
    context: Context,
    grant: AccountGrant,
    input: Parameters<ReturnType<typeof workspaceBots>["rename"]>[0],
  ) => Promise<
    | { authorized: false }
    | {
        authorized: true;
        result: Awaited<ReturnType<ReturnType<typeof workspaceBots>["rename"]>>;
      }
  >,
) {
  const routes = new Hono();
  const bots = workspaceBots(database);
  const path = "/:workspaceId/bots/:botId";

  routes.get(path, async (context) => {
    const session = await authorize(context);
    if (session.kind === "unconfirmed")
      return context.json({ error: "account_status_unconfirmed" }, 503);
    if (session.kind === "signed-out")
      return context.json({ error: "sign_in_required" }, 401);
    const bot = await bots.get({
      ...context.req.param(),
      accountId: session.grant.accountId,
    });
    if (!(await stillAuthorized(context, session.grant)))
      return context.json({ error: "authorization_changed" }, 403);
    return bot
      ? context.json(bot)
      : context.json({ error: "bot_not_found" }, 404);
  });

  routes.post(`${path}/name`, async (context) => {
    const session = await authorize(context);
    if (session.kind === "unconfirmed")
      return context.json({ error: "account_status_unconfirmed" }, 503);
    if (session.kind === "signed-out")
      return context.json({ error: "sign_in_required" }, 401);
    const input = renameBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success) return context.json({ error: "invalid_bot_name" }, 400);
    const outcome = await rename(context, session.grant, {
      ...context.req.param(),
      accountId: session.grant.accountId,
      name: input.data.name,
    });
    if (!outcome.authorized)
      return context.json({ error: "authorization_changed" }, 403);
    return outcome.result
      ? context.json(outcome.result)
      : context.json({ error: "bot_not_found" }, 404);
  });

  return routes;
}
