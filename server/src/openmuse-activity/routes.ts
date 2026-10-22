import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { getLogger } from "../../../shared/logger";
import {
  ApprovalNotFoundError,
  ApprovalRefusedError,
} from "../approvals/types";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { OpenMuseOwnerDisabledError as OpenMuseNotificationOwnerDisabledError } from "../openmuse-notifications/store";
import {
  ReviewedActionConflictError,
  ReviewedActionExpiredError,
  ReviewedActionStaleError,
} from "../openmuse-reviewed-actions/service";
import { OpenMuseOwnerDisabledError } from "../openmuse-reviewed-actions/store";
import { PAGE_LIMIT_ERROR, parsePageLimit } from "../paging";
import { ACTIVITY_MAX_LIMIT, type ActivityFeed } from "./feed";

const log = getLogger("server");

/**
 * The §8 outcome→response mapping the decision and read routes share: the
 * matrix requires the same id to answer the same codes under both verbs, so
 * the mapping exists once. A `bad_action` (a library caller's contract
 * violation, unreachable over HTTP behind the zod enum) answers 400.
 */
function activityItemResponse(
  context: Context<{ Variables: AppVariables }>,
  outcome: Awaited<ReturnType<ActivityFeed["decide"]>>,
): Response {
  if (outcome.kind === "missing") {
    return context.json({ error: "No such activity item." }, 404);
  }
  if (outcome.kind === "wrong_type") {
    return context.json(
      {
        error: "That decision type does not match this activity item.",
        code: "wrong_type",
      },
      409,
    );
  }
  if (outcome.kind === "bad_action") {
    return context.json(
      { error: "That decision action is not valid for this item." },
      400,
    );
  }
  return context.json(outcome.item);
}

/**
 * `/api/mobile/openmuse-activity` (V01 decisions + V02 reads, contracts §8):
 * the owner's Activity feed over policy approvals, reviewed actions and task
 * notifications, the decision route that dispatches to the owning module of
 * the item it names, and the task notification's mark-read route. The routes
 * validate and serialize only; ordering, cursors and dispatch are the feed's,
 * and every decision or mark is the owning seam's own path.
 */
export function createOpenMuseActivityRoutes(deps: {
  feed: ActivityFeed;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.onError((error, context) => {
    if (error instanceof OpenMuseOwnerDisabledError) {
      return context.json({ error: error.message }, 403);
    }
    // The notifications seam carries its own identically-shaped fence error;
    // one answer (403) regardless of which source tripped it.
    if (error instanceof OpenMuseNotificationOwnerDisabledError) {
      return context.json({ error: error.message }, 403);
    }
    // The reviewed seam's own refusals, answered the way its own routes
    // answer them, so one client keys on the same codes in both surfaces.
    if (error instanceof ReviewedActionExpiredError) {
      return context.json(
        { error: error.message, code: error.code, status: error.status },
        409,
      );
    }
    if (error instanceof ReviewedActionStaleError) {
      return context.json(
        {
          error: error.message,
          code: error.code,
          staleReason: error.staleReason,
        },
        409,
      );
    }
    if (error instanceof ReviewedActionConflictError) {
      return context.json({ error: error.message, code: error.code }, 409);
    }
    // A decide refused between the re-read and the dispatch: a race lost to
    // another decision, not a caller mistake, so 409 stale rather than 400.
    if (error instanceof ApprovalRefusedError) {
      return context.json({ error: error.message }, 409);
    }
    if (error instanceof ApprovalNotFoundError) {
      return context.json({ error: error.message }, 404);
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    log.error(
      {
        type: "openmuse-activity-route-error",
        error,
        context: { route: context.req.path },
      },
      "openmuse-activity-route-error",
    );
    // 500, not 503: the unrecognized remainder is code defects (TypeError
    // et al), not a capacity problem — 503 would invite pointless retries
    // and mis-file the alert.
    return context.json(
      { error: "The activity feed is unavailable right now. Try again." },
      500,
    );
  });

  routes.get("/", async (context) => {
    const parsedLimit = parsePageLimit(
      context.req.query("limit") ?? null,
      ACTIVITY_MAX_LIMIT,
    );
    if (!parsedLimit.ok) {
      return context.json({ error: PAGE_LIMIT_ERROR }, 400);
    }
    const page = await deps.feed.read(context.var.actor.id, {
      ...(parsedLimit.limit !== undefined ? { limit: parsedLimit.limit } : {}),
      ...(context.req.query("cursor") !== undefined
        ? { cursor: context.req.query("cursor") as string }
        : {}),
      // §8: the reconcile marker on an uncertain send is an operator's; the
      // same guard the reviewed routes use decides who sees it.
      operator: requireAdmin(context) === undefined,
    });
    if (!page.ok) {
      return context.json({ error: page.error }, 400);
    }
    return context.json({ items: page.items, nextCursor: page.nextCursor });
  });

  routes.post("/:id/decision", async (context) => {
    const body = decisionSchema.parse(await context.req.json());
    const outcome = await deps.feed.decide(
      context.var.actor.id,
      context.req.param("id"),
      {
        ...body,
        operator: requireAdmin(context) === undefined,
      },
    );
    return activityItemResponse(context, outcome);
  });

  // §8 (V02): the task notification's one verb. The route validates and
  // serializes only — owner scope and the set-once instant are the
  // notifications store's, and another type's id refuses as a wrong type.
  routes.post("/:id/read", async (context) => {
    const outcome = await deps.feed.markRead(
      context.var.actor.id,
      context.req.param("id"),
    );
    return activityItemResponse(context, outcome);
  });

  return routes;
}

const decisionSchema = z.object({
  type: z.enum(["policy_approval", "reviewed_action"]),
  action: z.enum(["approve", "deny"]),
});
