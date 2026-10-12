/**
 * The payment surface's HTTP half: two factories, one per audience, exactly like the billing
 * routes beside them (../routes.ts).
 *
 * The callback factory mounts nothing but the channels' delivery endpoint — no session, no
 * body-parsing middleware, because the caller is the channel and its whole credential is the
 * signature the adapter verifies against the raw bytes, read exactly once and capped (the same
 * discipline as the Lago webhook). Its answers follow each channel's own wire convention: Alipay
 * gets plain text `success` on acceptance and JSON refusals otherwise; WeChat gets its
 * `{"code":"SUCCESS"}` / `{"code":"FAIL","message":…}` envelope, with the refusal's status code
 * grading why (401 stale timestamp, 400 undecryptable, 403 wrong signature, 409 a verified fact
 * that is not money, 404 an order nobody knows, 500 a store that would not take it).
 *
 * The person-facing factory mounts behind `requireUser` for the whole group, with the admin check
 * repeated inside every mutating handler — the same double layer the billing admin routes use,
 * for the same reason: `requireAdmin` alone would read `context.var.actor.role` on a request that
 * never authenticated.
 *
 * REGISTRATION ORDER INSIDE THE USER GROUP IS LOAD-BEARING. `GET /purchases/catalog` and
 * `GET /purchases/current` are registered BEFORE `GET /purchases/:id`, because Hono matches a
 * group's routes in registration order and a parametric segment registered first swallows the
 * static paths — verified directly against the router this server ships (`catalog` then answered
 * by the `:id` handler as `{"hit":"id:catalog"}` when the order was inverted). The assertions in
 * payment-routes.test.ts pin that order; do not "tidy" it.
 */
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { type AuditStore, recordAuditEvent } from "../../audit";
import type { AppVariables } from "../../auth/guards";
import { readBodyCapped } from "../raw-body";
import { BillingError } from "../types";
import {
  type CallbackOutcome,
  type PaymentService,
  PurchaseError,
} from "./service";

/** The shape `requireAdmin` takes in auth/guards.ts: a refusal answer, or nothing to add. */
type RequireAdmin = (
  context: Context<{ Variables: AppVariables }>,
) => Response | undefined;

/**
 * The channels' anonymous deliveries, at their own prefix. The provider path segment is matched
 * against the configured providers only — anything else (a probe, a mistyped channel name) is a
 * plain 404 with no body-parsing work done.
 */
export function createPaymentCallbackRoutes(deps: { service: PaymentService }) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.post("/:provider", async (context) => {
    const providerId = context.req.param("provider");
    const rawBody = await readBodyCapped(context.req.raw);
    if (rawBody === null) {
      // Read exactly once, capped: an oversized delivery is refused before it is verified.
      return context.json(
        { error: "Payment callback body exceeds the size limit." },
        413,
      );
    }
    const outcome = await deps.service.handleCallback(
      providerId,
      context.req.raw.headers,
      rawBody,
    );
    return callbackAnswer(context, providerId, outcome);
  });
  return routes;
}

/**
 * The refusal each outcome earns, in the channel's own words. Alipay's convention is bare JSON;
 * WeChat's is its envelope with a fixed sentence — the message carries no detail by design, the
 * same way the billing errors do not.
 */
async function callbackAnswer(
  context: Context<{ Variables: AppVariables }>,
  providerId: string,
  outcome: CallbackOutcome,
): Promise<Response> {
  const wechat = providerId === "wechat";
  const fail = (status: 400 | 401 | 403 | 404 | 409 | 500) => {
    if (wechat) {
      return context.json(
        { code: "FAIL", message: "Payment notification refused." },
        status,
      );
    }
    return context.json({ error: "Payment notification refused." }, status);
  };

  switch (outcome.kind) {
    case "success": {
      // The ack is the channel's own word, byte for byte, in its own content type.
      const provider = outcomeProviderShape(providerId);
      return new Response(provider.body, {
        status: 200,
        headers: { "content-type": provider.contentType },
      });
    }
    case "settlement-refused":
      return fail(409);
    case "unknown-provider":
      return context.json({ error: "Unknown payment provider." }, 404);
    case "unverified":
      return fail(
        outcome.refusal === "stale"
          ? 401
          : outcome.refusal === "decryption"
            ? 400
            : 403,
      );
    case "not-success":
      return fail(409);
    case "unknown-order":
      return fail(404);
    case "store-failure":
      return fail(500);
  }
}

/** The ack bodies, spelled where the adapters already spell them. */
function outcomeProviderShape(providerId: string): {
  body: string;
  contentType: string;
} {
  // The service's providers own the exact bytes; the route needs only the shape for the two
  // channels that exist. Kept here rather than reaching into an adapter instance so the answer
  // never depends on a provider object being constructed.
  return providerId === "wechat"
    ? { body: '{"code":"SUCCESS"}', contentType: "application/json" }
    : { body: "success", contentType: "text/plain" };
}

/** A purchase request: one plan from the catalog, one configured channel, nothing else. */
const purchaseInput = z.strictObject({
  planCode: z.string().trim().min(1).max(200),
  // The wire shape: one of the two channel names this version speaks. Whether the deployment
  // CONFIGURED that channel is the service's answer, graded before any order row exists —
  // the catalog's `providers` field is the disclosure clients render from.
  provider: z.enum(["alipay", "wechat"]),
  /**
   * The billing cycle being bought. v1 collects MONTHLY only (the Lago interval the
   * activation creates, and the only cycle PAYMENT_PLAN_CATALOG's periodMonths=1 allows) —
   * both spellings of monthly are accepted because the display catalog names either. A
   * yearly code is a 400 here, on purpose: the server refusing what it cannot collect is
   * what keeps the dialog's hidden yearly option honest.
   */
  cycle: z.enum(["monthly", "recurring_monthly"]),
});

/** The sentinel codes, as HTTP numbers — the same mapping the billing admin routes use. */
function billingStatus(error: BillingError): 503 | 400 {
  return error.code === "unreachable" || error.code === "unconfigured"
    ? 503
    : 400;
}

export function createPaymentRoutes(deps: {
  service: PaymentService;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  requireAdmin: RequireAdmin;
  /** What plan is active at the provider right now, for the catalog's answer. */
  activePlanCode(): Promise<string | null>;
  /** Present on a deployment with the audit store; absent skips the trail, as everywhere else. */
  audit?: AuditStore;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.onError((error, context) => {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    if (error instanceof PurchaseError) {
      if (error.refusal.reason === "unknown-plan") {
        return context.json(
          { error: "That plan is not purchasable here." },
          400,
        );
      }
      if (error.refusal.reason === "unknown-provider") {
        return context.json(
          { error: "That channel is not configured on this deployment." },
          400,
        );
      }
      if (error.refusal.reason === "pending-purchase") {
        return context.json(
          {
            error: "Another purchase is already pending for this deployment.",
            pendingPlanCode: error.refusal.pendingPlanCode,
          },
          409,
        );
      }
      return context.json(
        {
          error: "This deployment already has an active subscription.",
          activePlanCode: error.refusal.activePlanCode,
        },
        409,
      );
    }
    if (error instanceof BillingError) {
      return context.json({ error: error.message }, billingStatus(error));
    }
    return context.json({ error: "Payments are unavailable. Try again." }, 503);
  });

  // STATIC ROUTES FIRST — catalog and current must be claimed before the `:id` segment exists
  // to swallow them; see the file header for the experiment that pinned this.
  routes.get("/purchases/catalog", async (context) => {
    const denied = deps.requireAdmin(context);
    const canPurchase = !denied;
    return context.json(
      deps.service.catalog(canPurchase, await deps.activePlanCode()),
    );
  });
  routes.get("/purchases/current", async (context) => {
    return context.json(await deps.service.readCurrentOrder());
  });

  routes.get("/purchases/:id", async (context) => {
    const { order } = await deps.service.readOrder(context.req.param("id"));
    if (!order) {
      return context.json({ error: "No such purchase." }, 404);
    }
    return context.json({ order });
  });

  routes.post("/purchases", async (context) => {
    const denied = deps.requireAdmin(context);
    if (denied) return denied;
    const input = purchaseInput.parse(await context.req.json());
    const { order } = await deps.service.createPurchase({
      planCode: input.planCode,
      provider: input.provider,
      // v1 converges both monthly spellings to the one cycle it collects; the service's
      // snapshot is the monthly price either way (the cross-check at boot keeps the two
      // catalogs' monthly prices identical, so there is no second number to choose).
      cycle: "monthly",
      createdBy: context.var.actor.id,
    });
    if (deps.audit) {
      await recordAuditEvent(deps.audit, {
        eventType: "billing.purchase.created",
        targetType: "billing",
        actorUserId: context.var.actor.id,
        payload: { planCode: order.planCode, provider: order.provider },
      });
    }
    return context.json({ order });
  });

  routes.post("/purchases/:id/cancel", async (context) => {
    const denied = deps.requireAdmin(context);
    if (denied) return denied;
    const result = await deps.service.cancelPurchase(context.req.param("id"));
    if (result.outcome === "unknown") {
      return context.json({ error: "No such purchase." }, 404);
    }
    if (result.outcome === "terminal") {
      return context.json({ error: "That purchase is already settled." }, 409);
    }
    if (deps.audit && result.outcome === "canceled") {
      await recordAuditEvent(deps.audit, {
        eventType: "billing.purchase.canceled",
        targetType: "billing",
        actorUserId: context.var.actor.id,
        payload: { orderId: result.order.orderId },
      });
    }
    return context.json({ order: result.order });
  });

  return routes;
}
