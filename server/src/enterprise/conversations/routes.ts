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
import type { EnterpriseDependencies, EnterpriseVariables } from "../app";
import { EnterpriseError } from "../errors";
import { createHistoryService } from "./history";
import { createMessagesService } from "./messages";
import { createConversationsService, PAGE_LIMIT } from "./service";

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
  deps: EnterpriseDependencies,
): void {
  const service = createConversationsService(
    // The conversations' own data-plane pool, injected through the assembly deps: the bootstrap
    // opened it from the EnterpriseConfig data URL and closes it on drain (app.ts docs). The
    // mount never opens a pool or reads the environment itself.
    deps.conversationsDatabase,
    // The one authorization engine the app shipped with (app.ts deps): the run decision goes
    // through it, governed by the tenant's policy revision (spec §2/§6.2).
    deps.authz,
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

  /*
   * The C07 message plane (plan §5.2): submit (202 = accepted), the offline
   * reconciliation read and the authorized cursor-paginated history. Mounted
   * only when the assembly injected the message pool and the Run seam — an
   * assembly without them answers an explicit 503 so a deployment can never
   * masquerade the message plane as an empty success (the RUNS_DISABLED
   * pattern). Identity never crosses from the client: every handler takes the
   * scope the middleware issued, and the body is the strict SubmitMessageSchema.
   */
  if (deps.messagesDatabase && deps.messageSeams) {
    const messages = createMessagesService(
      deps.messagesDatabase,
      deps.authz,
      deps.messageSeams,
    );
    const history = createHistoryService(
      deps.messagesDatabase,
      deps.authz,
      PAGE_LIMIT,
    );

    app.post("/channels/:id/messages", async (c) => {
      const submission = await messages.submit(
        c.var.scope,
        channelIdParam(c),
        await jsonBody(c),
      );
      // 202 is ACCEPTED: the Submission names the persisted message and its
      // business Run, and is never a completion claim (plan §5.2).
      return c.json(submission, 202);
    });

    app.get("/channels/:id/submissions/:clientMessageId", async (c) => {
      const clientMessageId = c.req.param("clientMessageId") ?? "";
      if (!RESOURCE_ID_PATTERN.test(clientMessageId)) {
        // An address that cannot be a clientMessageId is the same closed 404.
        throw new EnterpriseError("RESOURCE_NOT_FOUND", 404);
      }
      return c.json(
        await messages.findSubmission(
          c.var.scope,
          channelIdParam(c),
          clientMessageId,
        ),
      );
    });

    app.get("/channels/:id/history", async (c) =>
      c.json(
        await history.list(
          c.var.scope,
          channelIdParam(c),
          c.req.query("cursor") ?? null,
        ),
      ),
    );
  } else {
    const messagesDisabled = (): never => {
      throw new EnterpriseError("MESSAGES_DISABLED", 503);
    };
    app.post("/channels/:id/messages", messagesDisabled);
    app.get("/channels/:id/submissions/:clientMessageId", messagesDisabled);
    app.get("/channels/:id/history", messagesDisabled);
  }
}
