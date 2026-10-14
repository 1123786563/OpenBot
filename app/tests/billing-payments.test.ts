import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  cancelPurchase,
  createPurchase,
  PaymentsUnavailableError,
  type PurchaseOrderView,
  PurchaseRequestError,
  purchaseCatalogQueryOptions,
  purchaseKeys,
  purchaseOrderQueryOptions,
} from "../src/lib/billing/payments";

/**
 * The purchase seam's browser side, against a stubbed fetch: the catalog's not-enabled 404, the
 * one-subscription refusal carrying its activePlanCode, and the plain errors everything else
 * grades down to. The wire shapes are the server's own — OrderView and the catalog answer.
 */

const realFetch = globalThis.fetch;
const queryClient = new QueryClient();
afterEach(() => {
  globalThis.fetch = realFetch;
  queryClient.clear();
});

function serve(status: number, body: unknown) {
  globalThis.fetch = Object.assign(
    async () =>
      new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    { preconnect: () => undefined },
  );
}

const order = {
  orderId: "po-0123456789abcdef",
  planCode: "pro",
  provider: "alipay",
  amountCents: 8800,
  currency: "CNY",
  status: "pending",
  activationState: "pending",
  checkout: { kind: "qrcode", payload: "weixin://wxpay/bizpayurl?pr=abc" },
  expiresAt: "2026-10-10T12:15:00.000Z",
  periodEnd: null,
  createdAt: "2026-10-10T12:00:00.000Z",
} satisfies PurchaseOrderView;

test("purchase keys nest under the billing purchases family", () => {
  expect([...purchaseKeys.catalog]).toEqual([
    "billing",
    "purchases",
    "catalog",
  ]);
  expect([...purchaseKeys.current]).toEqual([
    "billing",
    "purchases",
    "current",
  ]);
  expect([...purchaseKeys.order("po-1")]).toEqual([
    "billing",
    "purchases",
    "po-1",
  ]);
});

test("createPurchase returns the created order", async () => {
  serve(200, { order });
  await expect(
    createPurchase({ planCode: "pro", provider: "alipay", cycle: "monthly" }),
  ).resolves.toEqual(order);
});

test("the one-subscription refusal keeps the server's activePlanCode", async () => {
  serve(409, {
    error: "This deployment already has an active subscription.",
    activePlanCode: "starter",
  });
  const error = await createPurchase({
    planCode: "pro",
    provider: "wechat",
    cycle: "monthly",
  }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PurchaseRequestError);
  expect((error as PurchaseRequestError).status).toBe(409);
  expect((error as PurchaseRequestError).activePlanCode).toBe("starter");
});

test("the pending-purchase refusal keeps the server's pendingPlanCode", async () => {
  serve(409, {
    error: "Another purchase is already pending for this deployment.",
    pendingPlanCode: "standard",
  });
  const error = await createPurchase({
    planCode: "pro",
    provider: "alipay",
    cycle: "monthly",
  }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PurchaseRequestError);
  expect((error as PurchaseRequestError).status).toBe(409);
  expect((error as PurchaseRequestError).pendingPlanCode).toBe("standard");
});

test("a plan the catalog does not know carries no activePlanCode", async () => {
  serve(400, { error: "That plan is not purchasable here." });
  const error = await createPurchase({
    planCode: "nope",
    provider: "alipay",
    cycle: "monthly",
  }).then(
    () => null,
    (e: unknown) => e,
  );
  expect((error as PurchaseRequestError).status).toBe(400);
  expect((error as PurchaseRequestError).activePlanCode).toBeNull();
});

test("cancelPurchase surfaces the settled refusal with its status", async () => {
  serve(409, { error: "That purchase is already settled." });
  const error = await cancelPurchase("po-1").then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PurchaseRequestError);
  expect((error as PurchaseRequestError).status).toBe(409);
});

describe("purchaseCatalogQueryOptions", () => {
  test("a deployment without payment channels reads as not enabled, not as a failure", async () => {
    // The unmounted surface answers a bare 404 with no JSON body at all.
    globalThis.fetch = Object.assign(
      async () => new Response("Not Found", { status: 404 }),
      { preconnect: () => undefined },
    );
    expect(
      queryClient.fetchQuery(purchaseCatalogQueryOptions),
    ).rejects.toBeInstanceOf(PaymentsUnavailableError);
  });

  test("passes the server's catalog answer through untouched", async () => {
    serve(200, {
      plans: [
        {
          planCode: "pro",
          amountCents: 8800,
          currency: "CNY",
          periodMonths: 1,
        },
      ],
      canPurchase: true,
      activePlanCode: null,
      providers: ["alipay", "wechat"],
      cycles: ["monthly", "recurring_monthly"],
    });
    await expect(
      queryClient.fetchQuery(purchaseCatalogQueryOptions),
    ).resolves.toEqual({
      plans: [
        {
          planCode: "pro",
          amountCents: 8800,
          currency: "CNY",
          periodMonths: 1,
        },
      ],
      canPurchase: true,
      activePlanCode: null,
      providers: ["alipay", "wechat"],
      cycles: ["monthly", "recurring_monthly"],
    });
  });
});

test("the poll query reads the order the server spells", async () => {
  serve(200, { order });
  await expect(
    queryClient.fetchQuery(purchaseOrderQueryOptions(order.orderId)),
  ).resolves.toEqual({ order });
});
