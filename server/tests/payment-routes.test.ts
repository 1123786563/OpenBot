import { describe, expect, test } from "bun:test";
import { type Context, Hono } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  createPaymentCallbackRoutes,
  createPaymentRoutes,
} from "../src/billing/payments/routes";
import {
  createPaymentService,
  PurchaseError,
  type PaymentService,
} from "../src/billing/payments/service";
import type { PaymentProvider } from "../src/billing/payments/provider";
import type {
  PaymentOrderReadScope,
  PaymentOrderRecord,
  PaymentOrderView,
  PaymentStore,
} from "../src/billing/payments/types";
import type { AuditStore } from "../src/audit";

/*
 * The route layer against a scripted PaymentService: what is under test is the mapping — outcome
 * to status code, channel to ack body, refusal to the channel's own error shape — and the
 * registration order inside the user group, which the file's header documents as load-bearing.
 * `requireUser`/`requireAdmin` are one-line doubles: no header, refuse; header, pass.
 */

function viewFor(orderId: string): PaymentOrderView {
  return {
    orderId,
    planCode: "pro",
    provider: "alipay",
    amountCents: 8800,
    currency: "CNY",
    status: "pending",
    activationState: "pending",
    checkout: { kind: "qrcode", payload: "qr-payload" },
    expiresAt: "2026-10-10T02:15:00.000Z",
    periodEnd: null,
    createdAt: "2026-10-10T02:00:00.000Z",
  };
}

const ADMIN: AuthenticatedActor = {
  id: "admin-1",
  email: "admin@openbot.test",
  role: "admin",
};

const MEMBER: AuthenticatedActor = {
  id: "user-member",
  email: "member@openbot.test",
  role: "user",
};

function fakeService(overrides: Partial<PaymentService> = {}): PaymentService {
  return {
    catalog: (canPurchase, activePlanCode) => ({
      plans: [
        { planCode: "pro", amountCents: 8800, currency: "CNY", periodMonths: 1 },
      ],
      canPurchase,
      activePlanCode,
      providers: ["alipay"],
    }),
    createPurchase: async () => ({ order: viewFor("po-new") }),
    readOrder: async (id, _scope?: PaymentOrderReadScope) => ({
      order: viewFor(id),
    }),
    readCurrentOrder: async (_scope?: PaymentOrderReadScope) => ({ order: null }),
    cancelPurchase: async () => ({ outcome: "unknown" }),
    handleCallback: async () => ({ kind: "unknown-provider" }),
    sweepExpired: async () => {},
    ...overrides,
  };
}

function guardDoubles(actor: AuthenticatedActor = ADMIN) {
  // A Hono middleware must drive `next()` or return a Response — a plain `undefined` return
  // would stop the chain with an empty 200, which is exactly the shape these tests exist to
  // catch. The pass-through drives it AND establishes the actor the real guard establishes,
  // because the mutating handlers read `context.var.actor.id` for the audit trail.
  const requireUser = (async (
    context: Context<{ Variables: AppVariables }>,
    next: () => Promise<void>,
  ) => {
    context.set("actor", {
      id: actor.id,
      email: actor.email,
      role: actor.role,
    });
    await next();
  }) as never;
  const requireAdminAlways = (() => undefined) as never;
  return { requireUser, requireAdmin: requireAdminAlways };
}

function userApp(
  service: PaymentService,
  options: { actor?: AuthenticatedActor; audit?: AuditStore } = {},
) {
  const { requireUser, requireAdmin } = guardDoubles(options.actor);
  return createPaymentRoutes({
    service,
    requireUser,
    requireAdmin,
    activePlanCode: async () => null,
    ...(options.audit ? { audit: options.audit } : {}),
  });
}

describe("callback routes", () => {
  test("an oversized delivery is refused 413 before verification", async () => {
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/payments/callbacks",
      createPaymentCallbackRoutes({
        service: fakeService({
          handleCallback: async () => {
            throw new Error("verification must never run");
          },
        }),
      }),
    );
    const response = await app.request("/api/payments/callbacks/alipay", {
      method: "POST",
      headers: { "content-length": String(2 * 1024 * 1024) },
      body: "x=1",
    });
    expect(response.status).toBe(413);
  });

  test("an unknown provider is 404 without touching the body", async () => {
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/payments/callbacks",
      createPaymentCallbackRoutes({ service: fakeService() }),
    );
    const response = await app.request("/api/payments/callbacks/stripe", {
      method: "POST",
      body: "x=1",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Unknown payment provider." });
  });

  test("refusals grade by the adapter's reason, in the channel's own shape", async () => {
    for (const [refusal, status] of [
      [undefined, 403],
      ["stale", 401],
      ["decryption", 400],
    ] as const) {
      const app = new Hono<{ Variables: AppVariables }>().route(
        "/api/payments/callbacks",
        createPaymentCallbackRoutes({
          service: fakeService({
            handleCallback: async () => ({
              kind: "unverified",
              ...(refusal ? { refusal } : {}),
            }),
          }),
        }),
      );
      const alipay = await app.request("/api/payments/callbacks/alipay", {
        method: "POST",
        body: "x=1",
      });
      expect(alipay.status).toBe(status);
      const wechat = await app.request("/api/payments/callbacks/wechat", {
        method: "POST",
        body: "x=1",
      });
      expect(wechat.status).toBe(status);
      expect(await wechat.json()).toEqual({
        code: "FAIL",
        message: "Payment notification refused.",
      });
    }
  });

  test("verified-but-not-money is 409; an unknown order is 404; a store failure is 500", async () => {
    for (const [outcome, status] of [
      [{ kind: "not-success" }, 409],
      [{ kind: "unknown-order" }, 404],
      [{ kind: "store-failure" }, 500],
    ] as const) {
      const app = new Hono<{ Variables: AppVariables }>().route(
        "/api/payments/callbacks",
        createPaymentCallbackRoutes({
          service: fakeService({
            handleCallback: async () => outcome,
          }),
        }),
      );
      const response = await app.request("/api/payments/callbacks/wechat", {
        method: "POST",
        body: "x=1",
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        code: "FAIL",
        message: "Payment notification refused.",
      });
    }
  });

  test("a durable settlement refusal is not a provider success acknowledgement", async () => {
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/payments/callbacks",
      createPaymentCallbackRoutes({
        service: fakeService({
          handleCallback: async () => ({
            kind: "settlement-refused",
            settlement: { kind: "refused", reason: "amount-mismatch" },
          }),
        }),
      }),
    );
    const response = await app.request("/api/payments/callbacks/alipay", {
      method: "POST",
      body: "x=1",
    });

    expect(response.status).toBe(409);
    expect(await response.text()).not.toBe("success");
  });

  test("a thrown durable confirm returns HTTP 500 and provider failure", async () => {
    const order: PaymentOrderRecord = {
      id: "po-confirm-failure",
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      status: "pending",
      activationState: "pending",
      channelTransactionId: null,
      expiresAt: new Date("2026-10-10T02:15:00.000Z"),
      periodStart: null,
      periodEnd: null,
      paidAt: null,
      terminalAt: null,
      createdBy: "admin-1",
      createdAt: new Date("2026-10-10T02:00:00.000Z"),
      version: 0,
      checkoutPayload: null,
    };
    const store = {
      readOrder: async () => order,
      confirmPaid: async () => {
        throw new Error("database unavailable");
      },
    } as unknown as PaymentStore;
    const provider: PaymentProvider = {
      id: "alipay",
      async createSession() {
        throw new Error("unused");
      },
      async queryPayment() {
        throw new Error("unused");
      },
      async closePayment() {},
      async verifyNotification() {
        return {
          ok: true,
          fact: {
            outTradeNo: order.id,
            state: "paid",
            channelTransactionId: "tx-confirm-failure",
            amountCents: order.amountCents,
          },
        };
      },
      successAck: { body: "success", contentType: "text/plain" },
    };
    const service = createPaymentService({
      providers: new Map([["alipay", provider]]),
      store,
      catalog: new Map([
        ["pro", { amountCents: 8800, currency: "CNY", periodMonths: 1 }],
      ]),
      notifyBaseUrl: "https://payments.openbot.example",
      orderTtlMinutes: 15,
      latePaymentWindowHours: 24,
      acceptForeignCurrency: false,
      lago: {
        async getPlan() {
          return { found: true, interval: "monthly", currency: "CNY" };
        },
        async ensureSubscription() {},
      },
      externalCustomerKey: "openbot-deployment",
      activePlanCode: async () => null,
      invalidateEntitlementCache: () => undefined,
    });
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/payments/callbacks",
      createPaymentCallbackRoutes({ service }),
    );

    const response = await app.request("/api/payments/callbacks/alipay", {
      method: "POST",
      body: "x=1",
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Payment notification refused.",
    });
  });

  test("success answers with each channel's own ack, byte for byte", async () => {
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/payments/callbacks",
      createPaymentCallbackRoutes({
        service: fakeService({ handleCallback: async () => ({ kind: "success" }) }),
      }),
    );
    const alipay = await app.request("/api/payments/callbacks/alipay", {
      method: "POST",
      body: "x=1",
    });
    expect(alipay.status).toBe(200);
    expect(alipay.headers.get("content-type")).toContain("text/plain");
    expect(await alipay.text()).toBe("success");

    const wechat = await app.request("/api/payments/callbacks/wechat", {
      method: "POST",
      body: "x=1",
    });
    expect(wechat.status).toBe(200);
    expect(wechat.headers.get("content-type")).toContain("application/json");
    expect(await wechat.text()).toBe('{"code":"SUCCESS"}');
  });
});

describe("user routes: registration order", () => {
  test("catalog and current are claimed by their static routes, not the :id segment", async () => {
    // The inverted order is the documented failure: `:id` registered first swallows both static
    // paths and `readOrder("catalog")` answers instead of the catalog. The service doubles make
    // the two answers unmistakable.
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      userApp(
        fakeService({
          readOrder: async (id) => ({ order: viewFor(id) }),
        }),
      ),
    );
    const catalog = await app.request("/api/billing/purchases/catalog");
    expect(catalog.status).toBe(200);
    const catalogBody = (await catalog.json()) as {
      plans?: unknown[];
      order?: unknown;
    };
    expect(Array.isArray(catalogBody.plans)).toBe(true);
    expect(catalogBody.order).toBeUndefined();

    const current = await app.request("/api/billing/purchases/current");
    expect(current.status).toBe(200);
    const currentBody = (await current.json()) as { order?: unknown };
    expect(currentBody).toEqual({ order: null });
  });
});

describe("user routes: catalog and reads", () => {
  test("the catalog answers canPurchase from the in-handler admin check and carries activePlanCode", async () => {
    let adminChecked = 0;
    const { requireUser } = guardDoubles();
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      createPaymentRoutes({
        service: fakeService(),
        requireUser,
        requireAdmin: ((_context: Context<{ Variables: AppVariables }>) => {
          adminChecked += 1;
          return undefined;
        }) as never,
        activePlanCode: async () => "pro",
      }),
    );
    const response = await app.request("/api/billing/purchases/catalog");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      plans: [
        { planCode: "pro", amountCents: 8800, currency: "CNY", periodMonths: 1 },
      ],
      canPurchase: true,
      activePlanCode: "pro",
      providers: ["alipay"],
    });
    expect(adminChecked).toBe(1);
  });

  test("a visitor who fails requireUser never reaches the group", async () => {
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      createPaymentRoutes({
        service: fakeService(),
        requireUser: (async () => new Response(null, { status: 401 })) as never,
        requireAdmin: (() => undefined) as never,
        activePlanCode: async () => null,
      }),
    );
    expect((await app.request("/api/billing/purchases/catalog")).status).toBe(401);
    expect((await app.request("/api/billing/purchases/current")).status).toBe(401);
    expect(
      (await app.request("/api/billing/purchases/po-1")).status,
    ).toBe(401);
  });

  test("an unknown order id is 404", async () => {
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      userApp(fakeService({ readOrder: async () => ({ order: null }) })),
    );
    const response = await app.request("/api/billing/purchases/po-missing");
    expect(response.status).toBe(404);
  });

  test("current and detail reads only expose the signed-in actor's orders", async () => {
    const ownerOrder = {
      ...viewFor("po-member"),
      checkout: { kind: "qrcode" as const, payload: "qr-member" },
    };
    const otherOrder = {
      ...viewFor("po-other"),
      checkout: { kind: "qrcode" as const, payload: "qr-other" },
    };
    const service = fakeService({
      readCurrentOrder: async (scope) => ({
        order: scope?.actorPayerRef?.id === MEMBER.id ? ownerOrder : null,
      }),
      readOrder: async (id, scope) => {
        if (scope?.actorPayerRef?.id !== MEMBER.id) return { order: null };
        if (id === ownerOrder.orderId) return { order: ownerOrder };
        if (id === otherOrder.orderId) return { order: null };
        return { order: null };
      },
    });

    const ownerApp = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      userApp(service, { actor: MEMBER }),
    );
    const current = await ownerApp.request("/api/billing/purchases/current");
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({ order: ownerOrder });

    const ownDetail = await ownerApp.request("/api/billing/purchases/po-member");
    expect(ownDetail.status).toBe(200);
    expect(await ownDetail.json()).toEqual({ order: ownerOrder });

    const otherActorApp = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      userApp(service, {
        actor: {
          id: "user-other",
          email: "other@openbot.test",
          role: "user",
        },
      }),
    );
    const otherCurrent = await otherActorApp.request(
      "/api/billing/purchases/current",
    );
    expect(otherCurrent.status).toBe(200);
    expect(await otherCurrent.json()).toEqual({ order: null });

    const otherDetail = await otherActorApp.request(
      "/api/billing/purchases/po-member",
    );
    expect(otherDetail.status).toBe(404);
  });
});

describe("user routes: create and cancel", () => {
  test("a mutating endpoint refuses a non-admin inside the handler (the double layer)", async () => {
    const { requireUser } = guardDoubles();
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      createPaymentRoutes({
        service: fakeService({
          createPurchase: async () => {
            throw new Error("must never run");
          },
          cancelPurchase: async () => {
            throw new Error("must never run");
          },
        }),
        requireUser,
        requireAdmin: (() => new Response(null, { status: 403 })) as never,
        activePlanCode: async () => null,
      }),
    );
    expect(
      (
        await app.request("/api/billing/purchases", {
          method: "POST",
          body: JSON.stringify({ planCode: "pro", provider: "alipay", cycle: "monthly" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.request("/api/billing/purchases/po-1/cancel", { method: "POST" }))
        .status,
    ).toBe(403);
  });

  test("a body of the wrong shape is 400 (zod strict)", async () => {
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      userApp(
        fakeService({
          createPurchase: async () => {
            throw new Error("must never run");
          },
        }),
      ),
    );
    for (const body of [
      JSON.stringify({ planCode: "pro" }), // provider missing
      JSON.stringify({ planCode: "pro", provider: "stripe" }), // unknown channel
      JSON.stringify({ planCode: "pro", provider: "alipay", extra: 1 }), // strict
      "not json",
    ]) {
      const response = await app.request("/api/billing/purchases", {
        method: "POST",
        body,
      });
      expect(response.status).toBe(400);
    }
  });

  test("a user identifier in the request body cannot choose or change the order's owner", async () => {
    // AC14: ownership is not a request field. The body is a strict object, so ANY account
    // identity a client sends — userId, externalCustomerId, even an ownerPayerRef-shaped field
    // — is refused at the door with the shape refusal, and the service never runs.
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      userApp(
        fakeService({
          createPurchase: async () => {
            throw new Error("must never run");
          },
        }),
      ),
    );
    for (const forged of [
      { planCode: "pro", provider: "alipay", cycle: "monthly", userId: "victim-1" },
      {
        planCode: "pro",
        provider: "alipay",
        cycle: "monthly",
        externalCustomerId: "openbot-personal-victim-1",
      },
      {
        planCode: "pro",
        provider: "alipay",
        cycle: "monthly",
        ownerPayerRef: { kind: "personal", id: "victim-1" },
      },
    ]) {
      const response = await app.request("/api/billing/purchases", {
        method: "POST",
        body: JSON.stringify(forged),
      });
      expect(response.status).toBe(400);
    }
  });

  test("the order's owner is resolved server-side from the session, beside the audit actor", async () => {
    let captured: Parameters<PaymentService["createPurchase"]>[0] | null = null;
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      userApp(
        fakeService({
          createPurchase: async (input) => {
            captured = input;
            return { order: viewFor("po-owned") };
          },
        }),
      ),
    );
    const response = await app.request("/api/billing/purchases", {
      method: "POST",
      body: JSON.stringify({ planCode: "pro", provider: "alipay", cycle: "monthly" }),
    });
    expect(response.status).toBe(200);
    expect(captured).not.toBeNull();
    // The owner is the signed-in actor's own personal PayerRef — nothing the request sent.
    expect(captured!.ownerPayerRef).toEqual({ kind: "personal", id: ADMIN.id });
    expect(captured!.createdBy).toBe(ADMIN.id);
  });

  test("a cycle the server cannot collect is 400 before any order exists", async () => {
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      userApp(
        fakeService({
          createPurchase: async () => {
            throw new Error("must never run");
          },
        }),
      ),
    );
    // v1 collects monthly only: the yearly spellings exist in the DISPLAY catalog, and a
    // purchase naming one is refused at the door — the dialog hides them because this refuses
    // them, not the other way round.
    for (const body of [
      JSON.stringify({ planCode: "pro", provider: "alipay", cycle: "yearly" }),
      JSON.stringify({
        planCode: "pro",
        provider: "alipay",
        cycle: "recurring_yearly",
      }),
      JSON.stringify({ planCode: "pro", provider: "alipay" }), // cycle missing
    ]) {
      const response = await app.request("/api/billing/purchases", {
        method: "POST",
        body,
      });
      expect(response.status).toBe(400);
    }
    // Both monthly spellings pass the door (the service snapshots the same monthly price).
    const monthly = await app.request("/api/billing/purchases", {
      method: "POST",
      body: JSON.stringify({
        planCode: "pro",
        provider: "alipay",
        cycle: "recurring_monthly",
      }),
    });
    expect(monthly.status).not.toBe(400);
  });

  test("an active subscription answers 409 with the plan named", async () => {
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      userApp(
        fakeService({
          createPurchase: async () => {
            throw new PurchaseError({
              reason: "active-subscription",
              activePlanCode: "pro",
            });
          },
        }),
      ),
    );
    const response = await app.request("/api/billing/purchases", {
      method: "POST",
      body: JSON.stringify({ planCode: "pro", provider: "alipay", cycle: "monthly" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This deployment already has an active subscription.",
      activePlanCode: "pro",
    });
  });

  test("a competing pending purchase answers 409 with the plan that owns the slot", async () => {
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      userApp(
        fakeService({
          createPurchase: async () => {
            throw new PurchaseError({
              reason: "pending-purchase",
              pendingPlanCode: "team",
            });
          },
        }),
      ),
    );
    const response = await app.request("/api/billing/purchases", {
      method: "POST",
      body: JSON.stringify({
        planCode: "pro",
        provider: "wechat",
        cycle: "monthly",
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Another purchase is already pending for this deployment.",
      pendingPlanCode: "team",
    });
  });

  test("an unreachable provider answers 503; an unreachable-because-unwired one too", async () => {
    const { BillingError } = await import("../src/billing/types");
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      userApp(
        fakeService({
          createPurchase: async () => {
            throw new BillingError("unreachable");
          },
        }),
      ),
    );
    expect(
      (
        await app.request("/api/billing/purchases", {
          method: "POST",
          body: JSON.stringify({ planCode: "pro", provider: "alipay", cycle: "monthly" }),
        })
      ).status,
    ).toBe(503);
  });

  test("cancel: terminal refuses 409, idempotent answers 200, unknown 404", async () => {
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      userApp(
        fakeService({
          cancelPurchase: async (id) => {
            if (id === "po-paid" || id === "po-expired") {
              return {
                outcome: "terminal",
                order: { ...viewFor(id), status: id === "po-paid" ? "paid" : "expired" },
              } as const;
            }
            if (id === "po-canceled") {
              return {
                outcome: "idempotent",
                order: { ...viewFor(id), status: "canceled" },
              } as const;
            }
            return { outcome: "unknown" } as const;
          },
        }),
      ),
    );
    expect(
      (await app.request("/api/billing/purchases/po-paid/cancel", { method: "POST" }))
        .status,
    ).toBe(409);
    expect(
      (
        await app.request("/api/billing/purchases/po-expired/cancel", {
          method: "POST",
        })
      ).status,
    ).toBe(409);
    const idempotent = await app.request("/api/billing/purchases/po-canceled/cancel", {
      method: "POST",
    });
    expect(idempotent.status).toBe(200);
    expect(((await idempotent.json()) as { order: { status: string } }).order.status).toBe(
      "canceled",
    );
    expect(
      (await app.request("/api/billing/purchases/po-missing/cancel", { method: "POST" }))
        .status,
    ).toBe(404);
  });

  test("create and cancel write their audit events when the store exists", async () => {
    const events: Array<{ eventType: string; payload: unknown }> = [];
    const audit = {
      insert: async (event: { eventType: string; payload: unknown }) => {
        events.push({ eventType: event.eventType, payload: event.payload });
      },
    } as unknown as AuditStore;
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      userApp(
        fakeService({
          cancelPurchase: async () => ({
            outcome: "canceled",
            order: { ...viewFor("po-x"), status: "canceled" },
          }),
        }),
        { audit },
      ),
    );
    await app.request("/api/billing/purchases", {
      method: "POST",
      body: JSON.stringify({ planCode: "pro", provider: "alipay", cycle: "monthly" }),
    });
    await app.request("/api/billing/purchases/po-x/cancel", { method: "POST" });
    expect(events.map((event) => event.eventType)).toEqual([
      "billing.purchase.created",
      "billing.purchase.canceled",
    ]);
  });
});
