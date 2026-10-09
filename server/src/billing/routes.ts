/**
 * The billing module's whole HTTP surface: three factories, one per audience.
 *
 * The webhook factory mounts nothing but the provider's delivery endpoint — no session, because the
 * caller is the provider, whose whole credential is the signature the service verifies against the
 * raw body (the same shape as the delivery lane's webhook routes). The person-facing factory mounts
 * the entitlement read behind `requireUser`. The admin factory mounts the snapshot and the sync
 * behind `requireUser` *and* an in-handler `requireAdmin`, the same double layer as
 * `/api/admin/package`: the enterprise gate passes an unmatched `/api/admin/billing` path straight
 * through (admin/gate.ts), and `requireAdmin` alone would read `context.var.actor.role` on a request
 * that never authenticated — a TypeError and a 500, not a 401.
 *
 * Error answers are built from the seam's sentinel codes, never from an error's own message: a
 * `BillingError` carries its code and nothing else by construction, and the fallbacks here keep that
 * property on the paths the seam does not own (a parse failure, an unexpected throw), so no URL, no
 * status line and no credential can reach a response body through this file.
 */
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { BillingError, type BillingService } from "./types";

/** The shape `requireAdmin` takes in auth/guards.ts: a refusal answer, or nothing to add. */
type RequireAdmin = (
  context: Context<{ Variables: AppVariables }>,
) => Response | undefined;

/**
 * The provider's deliveries. One route, no session, no body-parsing middleware: the service reads
 * the raw request itself, exactly once and capped, because a signature is over the bytes that
 * arrived.
 */
export function createBillingWebhookRoutes(deps: { service: BillingService }) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.post("/lago", (context) =>
    deps.service.handleWebhook(context.req.raw),
  );
  return routes;
}

/**
 * What a signed-in person may ask about their deployment's entitlements.
 *
 * The answer is exactly `{active, codes}`. The provider's plan vocabulary stops at the service — it
 * is useful there, for the sync and for a log line, but it is not this deployment's own word for
 * anything and does not belong on the HTTP surface a client codes against.
 */
export function createBillingRoutes(deps: {
  service: BillingService;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.get("/entitlements", async (context) => {
    const entitlements = await deps.service.entitlements();
    return context.json({
      active: entitlements.active,
      codes: entitlements.codes,
    });
  });
  return routes;
}

/** A sync request: one field, spelled the way the plan was spelled at the provider. */
const syncInput = z.strictObject({
  planCode: z.string().trim().min(1).max(200),
});

/** The sentinel codes, as HTTP numbers: the two 503s might pass on a retry, the two 400s will not. */
function billingStatus(error: BillingError): 503 | 400 {
  return error.code === "unreachable" || error.code === "unconfigured"
    ? 503
    : 400;
}

/**
 * The administrator's snapshot and sync.
 *
 * `requireUser` is mounted for the whole group and `requireAdmin` is checked again inside each
 * handler, because the admin check is a plain function of the actor the first one established — see
 * the file header for why the layering is not optional.
 *
 * The sync is idempotent by construction (read-before-create in the service), and audited: the plan
 * asked for is the whole payload, since the receipt's identifiers are the provider's own words and
 * the trail has no use for them.
 */
export function createBillingAdminRoutes(deps: {
  service: BillingService;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  requireAdmin: RequireAdmin;
  /** Present on a deployment with the audit store; absent skips the trail, as everywhere else. */
  audit?: AuditStore;
  /** The deployment's customer key, already derived (service.ts `deploymentExternalCustomerId`). */
  externalCustomerKey: string;
  /** What the provider's customer record calls this deployment. */
  customerName: string;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.onError((error, context) => {
    // A body that is not JSON, or JSON of the wrong shape, is the caller's mistake — answered with a
    // sentence of ours, not the parser's, and never the parsed fragment of anything.
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    if (error instanceof BillingError) {
      return context.json({ error: error.message }, billingStatus(error));
    }
    // Nothing else is a person's decision: a fixed sentence, no detail from the throw.
    return context.json({ error: "Billing is unavailable. Try again." }, 503);
  });
  routes.get("/", async (context) => {
    const denied = deps.requireAdmin(context);
    if (denied) return denied;
    return context.json(await deps.service.snapshot());
  });
  routes.post("/sync", async (context) => {
    const denied = deps.requireAdmin(context);
    if (denied) return denied;
    const input = syncInput.parse(await context.req.json());
    await deps.service.ensureCustomer({
      externalId: deps.externalCustomerKey,
      name: deps.customerName,
    });
    await deps.service.ensureSubscription({
      externalCustomerId: deps.externalCustomerKey,
      // Deterministic, so the same plan on the same customer is the same subscription at the
      // provider however many times the button is pressed.
      externalSubscriptionId: `${deps.externalCustomerKey}-${input.planCode}`,
      planCode: input.planCode,
    });
    if (deps.audit) {
      await recordAuditEvent(deps.audit, {
        eventType: "billing.synced",
        targetType: "billing",
        actorUserId: context.var.actor.id,
        payload: { planCode: input.planCode },
      });
    }
    return context.json({ synced: true });
  });
  return routes;
}
