/**
 * `/api/admin/openmuse-template`: preview and apply a managed OpenMuse template
 * revision to one person's private Bot (contracts §2). Both verbs are
 * administrator-only; preview never proposes overwriting a user-editable value
 * and apply writes only the managed keys inside the configuration JSON.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { getLogger } from "../../../shared/logger";
import { z } from "zod";
import {
  OPENMUSE_TEMPLATE_REVISIONS,
  type OpenMuseTemplateRevisionService,
  StaleTemplateRevisionError,
  TemplateBotNotFoundError,
} from "../agents/openmuse-template-store";
import { type AppVariables, requireAdmin } from "../auth/guards";

const log = getLogger("server");

const ownerUserId = z.string().trim().min(1);
/*
 * The revisions this build ships, straight from the store: the store is ready for a revision
 * the moment its entry exists, and the route must not keep a second, staler copy of the same
 * set that 400s what the store could serve.
 */
const knownRevision = z
  .number()
  .int()
  .refine(
    (v) => v in OPENMUSE_TEMPLATE_REVISIONS,
    "Unknown template revision.",
  );

const previewQuery = z.strictObject({
  ownerUserId,
  targetVersion: z.coerce.number().pipe(knownRevision),
});

const applyInput = z.strictObject({
  ownerUserId,
  targetVersion: knownRevision,
});

export function createOpenMuseTemplateAdminRoutes(deps: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  revisions: OpenMuseTemplateRevisionService;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });

  /*
   * Nothing behind this router answers with a bodyless 500: the store's
   * named errors keep their status, and anything unexpected is logged and
   * given the same sentence every other refusal here carries.
   */
  routes.onError((error, context) => {
    if (error instanceof TemplateBotNotFoundError) {
      return context.json({ error: error.message }, 404);
    }
    if (error instanceof StaleTemplateRevisionError) {
      return context.json({ error: error.message }, 409);
    }
    log.error({
      type: "openmuse-template-admin-failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return context.json(
      { error: "The template change did not go through. Try again." },
      500,
    );
  });

  routes.get("/preview", async (context) => {
    const parsed = previewQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json(
        { error: "Name the owner and a template revision." },
        400,
      );
    }
    return context.json(
      await deps.revisions.previewRevision(
        parsed.data.ownerUserId,
        parsed.data.targetVersion,
      ),
    );
  });

  routes.post("/apply", async (context) => {
    const parsed = applyInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        { error: "Name the owner and a template revision." },
        400,
      );
    }
    return context.json(
      await deps.revisions.applyRevision(
        parsed.data.ownerUserId,
        parsed.data.targetVersion,
      ),
    );
  });

  return routes;
}
