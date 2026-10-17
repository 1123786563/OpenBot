import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  createBillingRoutes,
  createBillingWebhookRoutes,
} from "../src/billing/routes";
import {
  createPaymentCallbackRoutes,
  createPaymentRoutes,
} from "../src/billing/payments/routes";
import type { BillingService } from "../src/billing/types";
import type { PaymentService } from "../src/billing/payments/service";

/*
 * The mount-order regression, pinning the two facts three rounds of direct router experiments
 * established (and the review reproduced verbatim):
 *
 * 1. The channel callbacks live at their OWN prefix (`/api/payments/callbacks/...`), mounted with
 *    no session — moving them under `/api/billing` puts the requireUser gate in front of the
 *    channels, and every delivery answers 401.
 * 2. The user-facing payment group mounts AFTER the billing user group on `/api/billing`, and its
 *    static purchase routes are registered before `:id` inside it.
 *
 * The six cases are the experiment's exact shape: lagoAnon=200 / payCbAnon=200 / purchasesAnon=401
 * / purchasesAuth=200 / entitlementsAnon=401 / entitlementsAuth=200.
 */

/** A guard in the real one's image: no session header, refuse; a session header, act as admin. */
function testRequireUser(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context: Context<{ Variables: AppVariables }>, next) => {
    if (context.req.header("x-test-session") === undefined) {
      return context.json({ error: "Authorization required." }, 401);
    }
    context.set("actor", {
      id: "admin-1",
      email: "admin@openbot.test",
      role: "admin",
    });
    await next();
  };
}

const billingService = {
  entitlements: async () => ({ active: false, codes: [] }),
  usage: async () => null,
  usageEvents: async () => ({
    events: [],
    totalCount: 0,
    totalPages: 0,
    currentPage: 1,
    nextPage: null,
  }),
  handleWebhook: async () =>
    new Response(JSON.stringify({ status: "processed" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  invalidateEntitlementCache: () => undefined,
} as unknown as BillingService;

const paymentService = {
  catalog: (canPurchase: boolean, activePlanCode: string | null) => ({
    plans: [
      { planCode: "pro", amountCents: 8800, currency: "CNY", periodMonths: 1 },
    ],
    canPurchase,
    activePlanCode,
    providers: ["alipay"],
  }),
  readOrder: async (_id: string) => ({ order: null }),
  readCurrentOrder: async () => ({ order: null }),
  handleCallback: async () => ({ kind: "success" }),
} as unknown as PaymentService;

function mountedApp(): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  const requireUser = testRequireUser();
  // The billing surfaces, in app.ts's order: the webhook group, then the person group.
  app.route(
    "/api/billing/webhooks",
    createBillingWebhookRoutes({ service: billingService }),
  );
  app.route(
    "/api/billing",
    createBillingRoutes({ service: billingService, requireUser }),
  );
  // The payment surfaces: the anonymous callback prefix FIRST, then the user group after the
  // billing user group on the shared prefix. Inverted, the sixth case below catches it.
  app.route(
    "/api/payments/callbacks",
    createPaymentCallbackRoutes({ service: paymentService }),
  );
  app.route(
    "/api/billing",
    createPaymentRoutes({
      service: paymentService,
      requireUser,
      requireAdmin: () => undefined,
      activePlanCode: async () => null,
    }),
  );
  return app;
}

describe("mount order regression (the six cases)", () => {
  const app = mountedApp();

  test("lagoAnon=200 — the provider's webhook door has no session", async () => {
    const response = await app.request("/api/billing/webhooks/lago", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(200);
  });

  test("payCbAnon=200 — the channels' callback prefix is session-free and reachable", async () => {
    const response = await app.request("/api/payments/callbacks/alipay", {
      method: "POST",
      body: "x=1",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("success");
  });

  test("purchasesAnon=401 — the user group is gated", async () => {
    const response = await app.request("/api/billing/purchases/catalog");
    expect(response.status).toBe(401);
  });

  test("purchasesAuth=200 — the same path with a session reads the catalog", async () => {
    const response = await app.request("/api/billing/purchases/catalog", {
      headers: { "x-test-session": "1" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      plans: unknown[];
      canPurchase: boolean;
    };
    expect(Array.isArray(body.plans)).toBe(true);
    expect(body.canPurchase).toBe(true);
  });

  test("entitlementsAnon=401 — the billing group's gate still holds with payments mounted after", async () => {
    const response = await app.request("/api/billing/entitlements");
    expect(response.status).toBe(401);
  });

  test("entitlementsAuth=200 — the billing group still serves with the payments group on the same prefix", async () => {
    const response = await app.request("/api/billing/entitlements", {
      headers: { "x-test-session": "1" },
    });
    expect(response.status).toBe(200);
  });
});
