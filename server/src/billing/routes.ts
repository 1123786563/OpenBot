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
import type { Credits } from "./credits";
import type { BillingStatements } from "./statements";
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
 * What a signed-in person may ask about their deployment's billing state.
 *
 * The entitlements answer carries the plan code, the plan's entries and the subscription's own
 * status and period — the facts 套餐与积分 renders. The provider's metered-usage reads that used to
 * ride beside it (`/usage`, `/usage/events`, `/usage/daily`) went with the old 用量 screens: no
 * page asks them any more, so the surface does not carry them.
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
      ...(entitlements.planCode !== undefined
        ? { planCode: entitlements.planCode }
        : {}),
      codes: entitlements.codes,
      subscription: entitlements.subscription ?? null,
    });
  });
  return routes;
}

/**
 * The statement reads: 套餐用量 and the bill list.
 *
 * Mounted on the same `/api/billing` prefix as the entitlement read, under the same session, and
 * registered BEFORE any parametric segment that could swallow them — the same ordering fact the
 * payment group's header records. `plan-usage` and `invoices` are static paths on a group whose
 * only other segment is static too, but the next person to add `/invoices/:id` will be glad the
 * shape was already right.
 *
 * The window is the caller's, the page size is not: `from`/`to`/`page` come from the query, 20
 * bills at a time do not. A bad date is a 400 with a sentence of ours; a page past the end is an
 * empty page, because a pager that walked off the end is not a client that misbehaved.
 */
const statementQueryInput = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

/** Exported for the route tests, which assert the window's own grammar. */
export { statementQueryInput };

export function createBillingStatementRoutes(deps: {
  statements: BillingStatements;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.onError((error, context) => {
    if (error instanceof z.ZodError) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    if (error instanceof BillingError) {
      return context.json({ error: error.message }, billingStatus(error));
    }
    return context.json({ error: "Billing is unavailable. Try again." }, 503);
  });

  routes.get("/plan-usage", async (context) => {
    return context.json(await deps.statements.planUsage());
  });

  routes.get("/invoices", async (context) => {
    const parsed = statementQueryInput.safeParse({
      from: context.req.query("from"),
      to: context.req.query("to"),
      page: context.req.query("page") ?? "1",
    });
    if (!parsed.success) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    return context.json(
      await deps.statements.invoices({
        from: parsed.data.from ? new Date(parsed.data.from) : null,
        to: parsed.data.to ? new Date(parsed.data.to) : null,
        page: parsed.data.page,
      }),
    );
  });

  routes.get("/invoices/:id", async (context) => {
    const invoice = await deps.statements.invoice(context.req.param("id"));
    if (!invoice) {
      return context.json({ error: "No such bill." }, 404);
    }
    return context.json({ invoice });
  });

  return routes;
}

/**
 * The credit-ledger reads: 套餐与积分.
 *
 * Mounted on the same `/api/billing` prefix under the same session, in the same spirit as the
 * statement reads beside it — but from a different source: the local credit ledger, not the
 * provider's reader and not the payment order table. `summary` is the plan's base allowance plus
 * the reward totals, `grants` the reward list, `consumption` the ledger with the same window/page
 * grammar as the bill list.
 */
export function createBillingCreditRoutes(deps: {
  credits: Credits;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.onError((error, context) => {
    if (error instanceof z.ZodError) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    return context.json({ error: "Billing is unavailable. Try again." }, 503);
  });

  routes.get("/catalog", async (context) => {
    return context.json(Object.fromEntries(deps.credits.catalog));
  });

  routes.get("/credits/summary", async (context) => {
    return context.json(await deps.credits.summary());
  });

  routes.get("/credits/grants", async (context) => {
    return context.json({ grants: await deps.credits.grants() });
  });

  routes.get("/credits/consumption", async (context) => {
    const parsed = statementQueryInput.safeParse({
      from: context.req.query("from"),
      to: context.req.query("to"),
      page: context.req.query("page") ?? "1",
    });
    if (!parsed.success) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    return context.json(
      await deps.credits.consumption({
        from: parsed.data.from ? new Date(parsed.data.from) : null,
        to: parsed.data.to ? new Date(parsed.data.to) : null,
        page: parsed.data.page,
      }),
    );
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
    /*
     * The sync just changed what the deployment is subscribed to; the entitlement reader would
     * otherwise keep answering the pre-sync cached value for up to its 10-minute TTL (and its
     * stale-while-revalidate returns the old answer even past expiry). Dropping the cache here is
     * what makes the next purchase's one-subscription gate — and the page's plan name — see the
     * world the sync just wrote.
     */
    deps.service.invalidateEntitlementCache();
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
