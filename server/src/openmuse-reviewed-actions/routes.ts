import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { getLogger } from "../../../shared/logger";
import { type AppVariables, requireAdmin } from "../auth/guards";
import {
  OpenMuseConnectionRefusedError,
  OpenMuseVendorUnavailableError,
} from "../openmuse-connectors/google-oauth";
import { parsePageLimit } from "../paging";
import { reviewedActionPayloadSchemas } from "./proposal";
import {
  type OpenMuseReviewedActionService,
  ReviewedActionConflictError,
  ReviewedActionExpiredError,
  type ReviewedActionReceipt,
  ReviewedActionReproposalError,
  ReviewedActionStaleError,
} from "./service";
import { OpenMuseOwnerDisabledError, type StoredReviewedAction } from "./store";

const log = getLogger("server");

/** The §8 feed-sized list default; a screen that pages grows its own cursor. */
const DEFAULT_LIMIT = 25;

/**
 * `/api/mobile/openmuse-reviewed-actions` (R01/R02/R04, contracts §6):
 * propose, list, decide (approve/deny), cancel, and the operator's reconcile.
 * The routes validate and serialize only; every transition is the service's
 * compare-and-swap, and the executor the service dials is whatever the
 * assembly injected — the Gmail send executor since R02, whose pre-claim
 * refusals these routes answer. R04's reconcile is operator-only
 * (requireAdmin; a user seat is 403), and its gate's 409 carries the reason.
 */
export function createOpenMuseReviewedActionsRoutes(deps: {
  service: OpenMuseReviewedActionService;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.onError((error, context) => {
    if (error instanceof OpenMuseOwnerDisabledError) {
      // The shared class's own sentence may name an internal id; this
      // surface answers its own fixed 403 sentence, the way the mail and
      // calendar surfaces answer theirs.
      return context.json(
        { error: "This owner's reviewed actions are unavailable." },
        403,
      );
    }
    // §6's three refusals carry a code the client keys on, not a sentence.
    // R03: the stale 409 also names which binding drifted, the stable
    // `staleReason` the fresh-proposal prompt is keyed on.
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
    if (error instanceof ReviewedActionExpiredError) {
      return context.json(
        { error: error.message, code: error.code, status: error.status },
        409,
      );
    }
    if (error instanceof ReviewedActionConflictError) {
      return context.json({ error: error.message, code: error.code }, 409);
    }
    // R04's re-proposal gate: the 409 also names WHY the same send cannot be
    // proposed again — uncertain, or already sent.
    if (error instanceof ReviewedActionReproposalError) {
      return context.json(
        { error: error.message, code: error.code, reason: error.reason },
        409,
      );
    }
    // The executor's pre-claim guard, answered the way the mail surface
    // answers the same two G01 errors.
    if (error instanceof OpenMuseConnectionRefusedError) {
      return context.json(
        { error: error.message, code: "connection_required" },
        error.status,
      );
    }
    if (error instanceof OpenMuseVendorUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    log.error(
      {
        type: "openmuse-reviewed-actions-route-error",
        error: error.name,
        context: { route: context.req.path },
      },
      "openmuse-reviewed-actions-route-error",
    );
    return context.json(
      { error: "Reviewed actions are unavailable right now. Try again." },
      503,
    );
  });

  routes.post("/", async (context) => {
    const input = proposeSchema.parse(await context.req.json());
    const action = await deps.service.propose(context.var.actor.id, input);
    return context.json(actionJson(action), 201);
  });

  routes.get("/", async (context) => {
    const parsedLimit = parsePageLimit(context.req.query("limit") ?? null, 100);
    if (!parsedLimit.ok) {
      return context.json({ error: parsedLimit.error }, 400);
    }
    const listed = await deps.service.list(
      context.var.actor.id,
      parsedLimit.limit ?? DEFAULT_LIMIT,
    );
    return context.json({
      actions: listed.actions.map((action) => actionJson(action)),
    });
  });

  routes.get("/:id", async (context) => {
    const action = await deps.service.get(
      context.var.actor.id,
      context.req.param("id"),
    );
    if (!action) {
      return context.json({ error: "No such reviewed action." }, 404);
    }
    return context.json(await withReceipt(action));
  });

  routes.post("/:id/decision", async (context) => {
    const body = decisionSchema.parse(await context.req.json());
    const action = await deps.service.decide(
      context.var.actor.id,
      context.req.param("id"),
      body.decision,
      body,
    );
    if (!action) {
      return context.json({ error: "No such reviewed action." }, 404);
    }
    return context.json(await withReceipt(action));
  });

  routes.post("/:id/cancel", async (context) => {
    const action = await deps.service.cancel(
      context.var.actor.id,
      context.req.param("id"),
    );
    if (!action) {
      return context.json({ error: "No such reviewed action." }, 404);
    }
    return context.json(await withReceipt(action));
  });

  routes.post("/:id/reconcile", async (context) => {
    // R04: reconciliation is an operator surface — the house requireAdmin
    // guard, the same one app.ts's administrator handlers use inline.
    const denied = requireAdmin(context);
    if (denied) return denied;
    const body = reconcileSchema.parse(await context.req.json());
    // The reviewer is the SESSION actor the guard proved, never a body
    // field: an operator identity from the request would be spoofable.
    const action = await deps.service.reconcile(
      context.var.actor.id,
      context.req.param("id"),
      {
        outcome: body.outcome,
        evidence: body.evidence ?? "",
        ...(body.providerEventId !== undefined
          ? { providerEventId: body.providerEventId }
          : {}),
      },
    );
    if (!action) {
      return context.json({ error: "No such reviewed action." }, 404);
    }
    return context.json(await withReceipt(action));
  });

  async function withReceipt(action: StoredReviewedAction) {
    const receipt = await deps.service.receiptOf(action.id);
    return actionJson(action, receipt ?? undefined);
  }

  return routes;
}

function actionJson(
  action: StoredReviewedAction,
  receipt?: ReviewedActionReceipt,
) {
  return {
    id: action.id,
    ownerUserId: action.ownerUserId,
    kind: action.kind,
    payload: action.canonicalPayload,
    payloadHash: action.payloadHash,
    accountEmail: action.accountEmail,
    connectionGeneration: action.connectionGeneration,
    targetId: action.targetId,
    targetVersion: action.targetVersion,
    attachmentVersionIds: action.attachmentVersionIds,
    status: action.status,
    expiresAt: action.expiresAt.toISOString(),
    createdAt: action.createdAt.toISOString(),
    decidedAt: action.decidedAt?.toISOString() ?? null,
    completedAt: action.completedAt?.toISOString() ?? null,
    providerRef: action.providerRef,
    ...(action.error !== null ? { error: action.error } : {}),
    ...(receipt !== undefined ? { receipt: receiptJson(receipt) } : {}),
  };
}

function receiptJson(receipt: ReviewedActionReceipt) {
  return {
    attemptId: receipt.attemptId,
    fingerprint: receipt.fingerprint,
    providerRef: receipt.providerRef,
    decidedAt: receipt.decidedAt?.toISOString() ?? null,
    attemptedAt: receipt.attemptedAt?.toISOString() ?? null,
    completedAt: receipt.completedAt?.toISOString() ?? null,
    ...(receipt.reconciliation !== null
      ? { reconciliation: receipt.reconciliation }
      : {}),
  };
}

const proposeSchema = z
  .object({
    // Executable kinds only: the assembly registers gmail.send and the
    // gcalendar trio, and an approval of a kind with no executor can only
    // settle `failed` — the legacy `mail`/`calendar` kinds are refused here
    // (400) rather than wasting a decision on a doomed proposal. The service
    // layer keeps accepting them for the fixtures that name them directly.
    kind: z.enum([
      "gmail.send",
      "gcalendar.create",
      "gcalendar.update",
      "gcalendar.delete",
    ]),
    payload: z.unknown(),
    accountEmail: z.string().min(1),
    connectionGeneration: z.number().int().positive(),
    targetId: z.string().min(1).optional(),
    targetVersion: z.string().min(1).optional(),
    attachmentVersionIds: z.array(z.string().min(1)).optional(),
  })
  .superRefine((value, ctx) => {
    const parsed = reviewedActionPayloadSchemas[value.kind].safeParse(
      value.payload,
    );
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: "custom",
          path: ["payload", ...issue.path],
          message: issue.message,
        });
      }
    }
    // §6/R06/R07: an update or delete binds its target first-class — the
    // event id AND the etag the decision will be guarded by; a proposal
    // without them has nothing to change.
    if (
      value.kind === "gcalendar.update" ||
      value.kind === "gcalendar.delete"
    ) {
      for (const field of ["targetId", "targetVersion"] as const) {
        if (value[field] === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `A ${value.kind} proposal must bind ${field}.`,
          });
        }
      }
    }
  });

const decisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  payloadHash: z.string().length(64).optional(),
  accountEmail: z.string().min(1).optional(),
  connectionGeneration: z.number().int().positive().optional(),
  targetVersion: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1).optional(),
});

const reconcileSchema = z.object({
  outcome: z.enum(["confirmed_succeeded", "confirmed_not_sent", "unresolved"]),
  evidence: z.string().max(2000).optional(),
  /**
   * R08: the provider event id the operator read back — the evidence a
   * confirmed_succeeded cites, recorded on the attempt row (§6 receipt).
   */
  providerEventId: z.string().min(1).max(512).optional(),
});
