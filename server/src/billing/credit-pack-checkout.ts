import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  type CreditPackTestChannel,
  testPaymentResult,
  testRefundResult,
} from "./credit-pack-test-channel";
import { type PaidCreditLedger, PaidLedgerError } from "./paid-ledger";
import type { TestCreditLedger, VerifiedBillingIdentity } from "./test-credit";

const orderInput = z.strictObject({
  orderId: z.uuid(),
  version: z.number().int().positive(),
});

export function createCreditPackCheckout({
  channel,
  ledger,
  paid,
}: {
  channel: CreditPackTestChannel;
  ledger: TestCreditLedger;
  paid: PaidCreditLedger;
}) {
  const { merchant, kind } = channel;
  const channelScope = { merchant, channel: kind };
  const fixtureRef = `fixture:${merchant}:`;
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

  async function verify(result: z.infer<typeof testPaymentResult>, id: string) {
    if (result.orderId !== id || result.merchantId !== merchant)
      throw new PaidLedgerError(
        "verification_mismatch",
        "The payment does not match this test order.",
      );
    if (result.state === "failed") {
      await paid.closeTestPackOrder({
        ...channelScope,
        id,
        currency: result.currency,
        amountCents: result.amountCents,
      });
      return;
    }
    await paid.verifyOrder({
      ...result,
      channelOrderRef: fixtureRef + result.channelOrderRef,
      paidAt: new Date(result.paidAt),
      channel: kind,
      testChannel: true,
    });
  }

  api.post(`${callbackPath}/callback`, async (context) => {
    if (!channel.authenticates(context.req.raw))
      return context.json({ error: "Verified channel required." }, 401);
    const result = testPaymentResult.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!result.success)
      return context.json({ error: "Invalid payment result." }, 400);
    await verify(result.data, result.data.orderId);
    return context.json({ accepted: true });
  });

  async function verifyRefund(
    result: z.infer<typeof testRefundResult>,
    expected: { orderId: string; id: string },
  ) {
    if (
      result.orderId !== expected.orderId ||
      result.refundId !== expected.id ||
      result.merchantId !== merchant
    )
      throw new PaidLedgerError(
        "verification_mismatch",
        "The result does not match this test refund.",
      );
    await paid.applyTestPackRefundResult({
      ...result,
      channel: kind,
      channelOrderRef: fixtureRef + result.channelOrderRef,
    });
  }

  api.post(`${callbackPath}/refund-callback`, async (context) => {
    if (!channel.authenticates(context.req.raw))
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
        pausedApplications: [],
        blockedReason: "New test orders are unavailable for this account.",
      });
    }
    return context.json(
      await paid.creditPackOffer(
        accountId,
        channel.productCode,
        channel.applicationIds,
      ),
    );
  });

  api.get(`${path}/orders`, async (context) => {
    const accountId = await ledger.accountOf(context.var.identity);
    return context.json(
      accountId
        ? await paid.testPackOrders({ ...channelScope, accountId })
        : [],
    );
  });

  api.post(`${path}/orders`, async (context) => {
    const accountId = await ledger.accountOf(context.var.identity);
    if (!accountId || !channel.allows(accountId)) return notFound(context);
    const input = orderInput.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success)
      return context.json({ error: "Invalid test order." }, 400);
    const order = await paid.createOrder({
      accountId,
      productCode: channel.productCode,
      channel: kind,
      testPack: {
        id: input.data.orderId,
        merchant,
        version: input.data.version,
        applicationIds: channel.applicationIds,
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
      ...channelScope,
      accountId,
      id: id.data,
    });
    if (!order) return notFound(context);
    if (order.state !== "pending")
      return context.json({ error: "This order is no longer pending." }, 409);
    return context.json({ checkoutUrl: await channel.checkout(order) });
  });

  api.post(`${path}/orders/:id/verify`, async (context) => {
    const id = z.uuid().safeParse(context.req.param("id"));
    const accountId = await ledger.accountOf(context.var.identity);
    if (!id.success || !accountId) return notFound(context);
    const scope = { ...channelScope, accountId, id: id.data };
    const [order] = await paid.testPackOrders(scope);
    if (!order) return notFound(context);
    if (order.state !== "pending" && order.state !== "failed")
      return context.json(order);
    const result = await channel.query(order.id);
    if (result.state !== "unknown") await verify(result, order.id);
    const [updated] = await paid.testPackOrders(scope);
    return context.json(updated);
  });

  async function refreshRefund(orderId: string, query: boolean) {
    const refund = await paid.testPackRefundDispatch({
      ...channelScope,
      orderId,
    });
    if (!refund?.channelOrderRef.startsWith(fixtureRef)) return;
    if (refund.state === "requested") {
      const result = await channel.startRefund({
        refundId: refund.id,
        orderId,
        merchantId: merchant,
        currency: "CNY",
        amountCents: refund.amountCents,
        channelOrderRef: refund.channelOrderRef.slice(fixtureRef.length),
      });
      if (result.state !== "unknown") await verifyRefund(result, refund);
    } else if (query && refund.state === "processing") {
      const result = await channel.queryRefund(refund.id);
      if (result.state !== "unknown") await verifyRefund(result, refund);
    }
  }

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
      ...channelScope,
      ...input.data,
    });
    await refreshRefund(id.data, false);
    const [order] = await paid.testPackOrders({
      ...channelScope,
      accountId,
      id: id.data,
    });
    return context.json(order);
  });

  api.post(`${path}/orders/:id/refund/verify`, async (context) => {
    const id = z.uuid().safeParse(context.req.param("id"));
    const accountId = await ledger.accountOf(context.var.identity);
    if (!id.success || !accountId) return notFound(context);
    const scope = { ...channelScope, accountId, id: id.data };
    const [order] = await paid.testPackOrders(scope);
    if (!order) return notFound(context);
    await refreshRefund(order.id, true);
    const [updated] = await paid.testPackOrders(scope);
    return context.json(updated);
  });

  return api;
}
