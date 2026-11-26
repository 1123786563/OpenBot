import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  type CreditPackChannelAdapter,
  testPaymentResult,
  testRefundResult,
} from "./credit-pack-test-channel";
import { type PaidCreditLedger, PaidLedgerError } from "./paid-ledger";
import type { TestCreditLedger, VerifiedBillingIdentity } from "./test-credit";

export function createCreditPackReconciliation(
  paid: Pick<
    PaidCreditLedger,
    | "advanceClosureOrder"
    | "verifyOrder"
    | "closeTestPackOrder"
    | "testPackRefundDispatch"
    | "applyTestPackRefundResult"
  >,
  channel: CreditPackChannelAdapter,
) {
  async function verify(
    result: z.infer<typeof testPaymentResult>,
    id: string,
    paymentChannel = channel,
  ) {
    // A live order carries no test merchant, so the ledger cannot pin its
    // currency; this checkout only ever sells CNY.
    if (
      result.orderId !== id ||
      result.merchantId !== paymentChannel.merchant ||
      result.currency !== "CNY"
    )
      throw new PaidLedgerError(
        "verification_mismatch",
        "The payment does not match this test order.",
      );
    if (result.state === "failed") {
      await paid.closeTestPackOrder({
        channel: paymentChannel.kind,
        merchant: paymentChannel.merchant,
        id,
        currency: result.currency,
        amountCents: result.amountCents,
        fixture: paymentChannel.fixture,
      });
      return;
    }
    const outcome = await paid.verifyOrder({
      ...result,
      channelOrderRef: paymentChannel.fixture
        ? `fixture:${paymentChannel.merchant}:${result.channelOrderRef}`
        : result.channelOrderRef,
      paidAt: new Date(result.paidAt),
      channel: paymentChannel.kind,
      ...(paymentChannel.fixture ? { testChannel: true as const } : {}),
    });
    if (outcome.claimed)
      await paid.advanceClosureOrder(outcome.order.accountId, id);
    await refreshRefund(id, false, paymentChannel);
  }

  async function verifyRefund(
    result: z.infer<typeof testRefundResult>,
    expected: { orderId: string; id: string },
    paymentChannel = channel,
  ) {
    if (
      result.orderId !== expected.orderId ||
      result.refundId !== expected.id ||
      result.merchantId !== paymentChannel.merchant
    )
      throw new PaidLedgerError(
        "verification_mismatch",
        "The result does not match this test refund.",
      );
    await paid.applyTestPackRefundResult({
      ...result,
      channel: paymentChannel.kind,
      channelOrderRef: paymentChannel.fixture
        ? `fixture:${paymentChannel.merchant}:${result.channelOrderRef}`
        : result.channelOrderRef,
    });
  }

  async function refreshRefund(
    orderId: string,
    query: boolean,
    paymentChannel = channel,
  ) {
    const fixtureRef = `fixture:${paymentChannel.merchant}:`;
    const refund = await paid.testPackRefundDispatch({
      channel: paymentChannel.kind,
      merchant: paymentChannel.merchant,
      orderId,
      fixture: paymentChannel.fixture,
    });
    const observedRef = refund?.channelOrderRef;
    if (
      !observedRef ||
      (paymentChannel.fixture && !observedRef.startsWith(fixtureRef))
    )
      return false;
    if (refund.state === "requested") {
      const result = await paymentChannel.startRefund({
        refundId: refund.id,
        orderId,
        merchantId: paymentChannel.merchant,
        currency: "CNY",
        amountCents: refund.amountCents,
        channelOrderRef: paymentChannel.fixture
          ? observedRef.slice(fixtureRef.length)
          : observedRef,
      });
      if (result.state !== "unknown")
        await verifyRefund(result, refund, paymentChannel);
    } else if (query && refund.state === "processing") {
      const result = await paymentChannel.queryRefund(refund.id);
      if (result.state !== "unknown")
        await verifyRefund(result, refund, paymentChannel);
    }
    return true;
  }

  async function reconcileOrder(
    id: string,
    closeIfUnknown: boolean,
    paymentChannel = channel,
  ) {
    const observed = await paymentChannel.query(id);
    const result =
      observed.state === "unknown" && closeIfUnknown
        ? await paymentChannel.close(id)
        : observed;
    if (result.state !== "unknown") await verify(result, id, paymentChannel);
    return result.state;
  }

  return { verify, verifyRefund, refreshRefund, reconcileOrder };
}

const orderInput = z.strictObject({
  orderId: z.uuid(),
  version: z.number().int().positive(),
});

const subscriptionOrderInput = orderInput.extend({
  productCode: z.string().min(1).optional(),
});

export function createCreditPackCheckout({
  channel,
  otherChannel,
  ledger,
  paid,
}: {
  channel: CreditPackChannelAdapter;
  otherChannel?: CreditPackChannelAdapter;
  ledger: TestCreditLedger;
  paid: PaidCreditLedger;
}) {
  const { merchant, kind } = channel;
  const { verify, verifyRefund, refreshRefund, reconcileOrder } =
    createCreditPackReconciliation(paid, channel);
  const channelScope = {
    merchant,
    channel: kind,
    fixture: channel.fixture,
  };
  const suffix = kind === "alipay" ? "/alipay" : "";
  const callbackPath = `/credit-pack-test${suffix}`;
  const api = new Hono<{ Variables: { identity: VerifiedBillingIdentity } }>();
  function notFound(context: Context) {
    return context.json({ error: "Test checkout unavailable." }, 404);
  }

  api.onError((error, context) => {
    if (error instanceof PaidLedgerError && error.code === "order_unknown")
      return notFound(context);
    if (error instanceof PaidLedgerError && error.code !== "ledger_restoring")
      return context.json({ code: error.code, error: error.message }, 409);
    return context.json(
      { error: "Test checkout is temporarily unavailable. Try again." },
      503,
    );
  });

  api.post(`${callbackPath}/callback`, async (context) => {
    if (!(await channel.authenticates(context.req.raw)))
      return context.json({ error: "Verified channel required." }, 401);
    const result = testPaymentResult.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!result.success)
      return context.json({ error: "Invalid payment result." }, 400);
    await verify(result.data, result.data.orderId);
    return context.json({ accepted: true });
  });

  api.post(`${callbackPath}/refund-callback`, async (context) => {
    if (!(await channel.authenticates(context.req.raw)))
      return context.json({ error: "Verified channel required." }, 401);
    const result = testRefundResult.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!result.success)
      return context.json({ error: "Invalid refund result." }, 400);
    await verifyRefund(result.data, {
      orderId: result.data.orderId,
      id: result.data.refundId,
    });
    return context.json({ accepted: true });
  });

  const path = `/paid/credit-pack${suffix}`;
  api.get(path, async (context) => {
    const accountId = await ledger.accountOf(context.var.identity);
    if (!accountId) return notFound(context);
    if (!channel.allows(accountId)) {
      if (!(await paid.testPackOrders({ ...channelScope, accountId })).length)
        return notFound(context);
      return context.json({
        available: false,
        product: null,
        canSwitchChannel: Boolean(otherChannel?.allows(accountId)),
        pausedApplications: [],
        blockedReason: "New test orders are unavailable for this account.",
      });
    }
    return context.json({
      ...(await paid.creditPackOffer(
        accountId,
        channel.productCode,
        channel.applicationIds,
        channelScope,
      )),
      canSwitchChannel: Boolean(otherChannel?.allows(accountId)),
    });
  });

  const subscriptionPath = `/paid/subscription${suffix}`;
  api.get(subscriptionPath, async (context) => {
    const accountId = await ledger.accountOf(context.var.identity);
    if (!accountId) return notFound(context);
    const eligible = channel.allows(accountId);
    if (
      !eligible &&
      !(
        await paid.testPackOrders({
          ...channelScope,
          accountId,
          kind: "subscription",
        })
      ).length
    )
      return notFound(context);
    return context.json({
      ...(await paid.subscriptionOffer(
        accountId,
        channel.applicationIds,
        eligible,
        channelScope,
      )),
      canSwitchChannel: Boolean(otherChannel?.allows(accountId)),
    });
  });

  const checkouts: { path: string; productKind?: "subscription" }[] = [
    { path },
    { path: subscriptionPath, productKind: "subscription" },
  ];
  for (const { path, productKind } of checkouts) {
    const scope = { ...channelScope, kind: productKind };
    api.get(`${path}/orders`, async (context) => {
      const accountId = await ledger.accountOf(context.var.identity);
      return context.json(
        accountId ? await paid.testPackOrders({ ...scope, accountId }) : [],
      );
    });

    api.post(`${path}/orders`, async (context) => {
      const accountId = await ledger.accountOf(context.var.identity);
      if (!accountId || !channel.allows(accountId)) return notFound(context);
      const input = subscriptionOrderInput.safeParse(
        await context.req.json().catch(() => undefined),
      );
      if (
        !input.success ||
        Boolean(input.data.productCode) !== Boolean(productKind)
      )
        return context.json({ error: "Invalid test order." }, 400);
      const order = await paid.createOrder({
        accountId,
        productCode: input.data.productCode ?? channel.productCode,
        channel: kind,
        testPack: {
          id: input.data.orderId,
          merchant,
          version: input.data.version,
          applicationIds: channel.applicationIds,
          kind: productKind,
          ...(channel.fixture ? {} : { live: true as const }),
        },
      });
      return context.json(
        { id: order.id, state: order.state },
        order.replayed ? 200 : 201,
      );
    });

    api.post(`${path}/orders/switch/:id`, async (context) => {
      const originalId = z.uuid().safeParse(context.req.param("id"));
      const input = orderInput
        .pick({ orderId: true })
        .safeParse(await context.req.json().catch(() => undefined));
      const accountId = await ledger.accountOf(context.var.identity);
      if (
        !accountId ||
        !originalId.success ||
        !otherChannel ||
        !channel.allows(accountId)
      )
        return notFound(context);
      if (!input.success)
        return context.json({ error: "Invalid test order." }, 400);
      const order = await paid.switchOrder({
        accountId,
        originalId: originalId.data,
        id: input.data.orderId,
        kind: productKind,
        source: { channel: otherChannel.kind, merchant: otherChannel.merchant },
        target: { ...channelScope, applicationIds: channel.applicationIds },
        reconcile: async (id) => {
          await reconcileOrder(id, true, otherChannel);
        },
      });
      return context.json(
        { id: order.id, state: order.state },
        order.replayed ? 200 : 201,
      );
    });

    api.post(`${path}/orders/:id/checkout`, async (context) => {
      const id = z.uuid().safeParse(context.req.param("id"));
      const accountId = await ledger.accountOf(context.var.identity);
      if (!id.success || !accountId) return notFound(context);
      const [order] = await paid.testPackOrders({
        ...scope,
        accountId,
        id: id.data,
      });
      if (!order) return notFound(context);
      if (order.state !== "pending" || order.switchOrderId)
        return context.json({ error: "This order is no longer pending." }, 409);
      if (!channel.allows(accountId)) return notFound(context);
      await paid.checkTestCheckout(
        accountId,
        channel.applicationIds,
        channelScope,
        order.priceCents,
      );
      return context.json({ checkoutUrl: await channel.checkout(order) });
    });

    api.post(`${path}/orders/:id/verify`, async (context) => {
      const id = z.uuid().safeParse(context.req.param("id"));
      const accountId = await ledger.accountOf(context.var.identity);
      if (!id.success || !accountId) return notFound(context);
      const orderScope = { ...scope, accountId, id: id.data };
      const [order] = await paid.testPackOrders(orderScope);
      if (!order) return notFound(context);
      if (order.state !== "pending" && order.state !== "failed")
        return context.json(order);
      await reconcileOrder(
        order.id,
        order.state === "pending" &&
          Boolean(await paid.closureCutoff(accountId)),
      );
      const [updated] = await paid.testPackOrders(orderScope);
      return context.json(updated);
    });

    api.post(`${path}/orders/:id/refund`, async (context) => {
      const id = z.uuid().safeParse(context.req.param("id"));
      const accountId = await ledger.accountOf(context.var.identity);
      if (!id.success || !accountId) return notFound(context);
      const body = await context.req.text();
      const input = z
        .strictObject({ amountCents: z.number().int().positive().optional() })
        .safeParse(body ? await context.req.json().catch(() => undefined) : {});
      if (!input.success)
        return context.json({ error: "Invalid refund request." }, 400);
      await paid.requestTestPackRefund({
        orderId: id.data,
        accountId,
        ...scope,
        ...input.data,
      });
      await refreshRefund(id.data, false);
      const [order] = await paid.testPackOrders({
        ...scope,
        accountId,
        id: id.data,
      });
      return context.json(order);
    });

    api.post(`${path}/orders/:id/refund/verify`, async (context) => {
      const id = z.uuid().safeParse(context.req.param("id"));
      const accountId = await ledger.accountOf(context.var.identity);
      if (!id.success || !accountId) return notFound(context);
      const orderScope = { ...scope, accountId, id: id.data };
      const [order] = await paid.testPackOrders(orderScope);
      if (!order) return notFound(context);
      await paid.advanceClosureOrder(accountId, order.id);
      await refreshRefund(order.id, true);
      const [updated] = await paid.testPackOrders(orderScope);
      return context.json(updated);
    });
  }

  return api;
}
