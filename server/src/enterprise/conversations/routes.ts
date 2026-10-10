/**
 * The conversations routes, per the conversations-subsystem spec §3.5 — mounted after the scope
 * middleware (app.ts mounts them right after `mountTenantRoutes`), so `c.var.scope` is a scope
 * this process issued for THIS request and identity never arrives from the client.
 *
 * Five endpoints and nothing else: the authorized-bot list, the personal channel's create (the
 * only one that parses a body), the owner's page, the detail, and the archive. No participant,
 * invite or shared-conversation endpoint exists for personal conversations (X01 is disabled), and
 * no write-type operation on an archived channel exists in this group — CHANNEL_ARCHIVED belongs
 * to C07's message submission.
 */
import type { Context, Hono } from "hono";
import { createDatabase } from "../../db/client";
import type { EnterpriseDependencies, EnterpriseVariables } from "../app";
import { EnterpriseError } from "../errors";
import { createConversationsService } from "./service";
import { conversationsDatabaseUrl } from "./store";

/** Same shape the tenant selector and every enterprise id allows: URL-safe, non-empty, bounded. */
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** A body that is not JSON at all is the same 400 as a body that fails the schema. */
async function jsonBody(
  c: Context<{ Variables: EnterpriseVariables }>,
): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new EnterpriseError("REQUEST_BODY_INVALID", 400);
  }
}

/** An address that cannot be a channel id is not a shape error: the same closed 404. */
function channelIdParam(
  c: Context<{ Variables: EnterpriseVariables }>,
): string {
  const id = c.req.param("id") ?? "";
  if (!RESOURCE_ID_PATTERN.test(id)) {
    throw new EnterpriseError("RESOURCE_NOT_FOUND", 404);
  }
  return id;
}

export function mountConversationsRoutes(
  app: Hono<{ Variables: EnterpriseVariables }>,
  _deps: EnterpriseDependencies,
): void {
  const service = createConversationsService(
    createDatabase(conversationsDatabaseUrl(process.env), { max: 2 }),
  );

  app.get("/bots", async (c) =>
    c.json(await service.listBots(c.var.scope, c.req.query("cursor") ?? null)),
  );

  app.post("/channels", async (c) =>
    c.json(await service.createChannel(c.var.scope, await jsonBody(c))),
  );

  app.get("/channels", async (c) =>
    c.json(
      await service.listChannels(c.var.scope, c.req.query("cursor") ?? null),
    ),
  );

  app.get("/channels/:id", async (c) =>
    c.json(await service.getChannel(c.var.scope, channelIdParam(c))),
  );

  app.post("/channels/:id/archive", async (c) =>
    c.json(await service.archiveChannel(c.var.scope, channelIdParam(c))),
  );
}
