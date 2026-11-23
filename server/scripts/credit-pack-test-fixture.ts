import { z } from "zod";
import {
  type CreditPackChannel,
  type paidTestPayment,
  type testRefundResult,
  testRefundTerms,
} from "../src/billing/credit-pack-test-channel";

const checkoutTerms = z.strictObject({
  orderId: z.uuid(),
  merchantId: z.string().regex(/^fixture-[A-Za-z0-9_-]{1,112}$/),
  currency: z.literal("CNY"),
  amountCents: z.number().int().positive(),
});

type Payment = z.infer<typeof paidTestPayment>;
type Refund = z.infer<typeof testRefundResult>;

export function startCreditPackFixture({
  token,
  port,
  notify,
  notifyRefund,
  channel = "wechat",
}: {
  token: string;
  port: number;
  channel?: CreditPackChannel;
  notify: (payment: Payment) => Promise<Response>;
  notifyRefund?: (refund: Refund) => Promise<Response>;
}) {
  if (!/^[A-Za-z0-9_-]{24,256}$/.test(token))
    throw new Error("Set a dedicated fixture token of at least 24 characters.");
  const name = channel === "alipay" ? "Alipay" : "WeChat";
  const orders = new Map<
    string,
    {
      terms: z.infer<typeof checkoutTerms>;
      key: string;
      payment?: Payment;
      closed?: true;
    }
  >();
  const refunds = new Map<string, Refund>();
  const refundByOrder = new Map<string, string>();
  const checkouts = new Map<string, string>();
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request, server) {
      const [, route, key, extra] = new URL(request.url).pathname.split("/");
      if (!key || extra) return new Response(null, { status: 404 });
      if (route === "orders") {
        if (request.headers.get("authorization") !== `Bearer ${token}`)
          return new Response(null, { status: 401 });
        const existing = orders.get(key);
        if (request.method === "GET" || request.method === "DELETE") {
          if (!existing) return Response.json({ state: "unknown" });
          if (existing.payment) return Response.json(existing.payment);
          if (request.method === "DELETE") existing.closed = true;
          return Response.json(
            existing.closed
              ? { ...existing.terms, state: "failed" }
              : { state: "unknown" },
          );
        }
        if (request.method === "PUT") {
          const parsed = checkoutTerms.safeParse(
            await request.json().catch(() => undefined),
          );
          if (!parsed.success || parsed.data.orderId !== key)
            return new Response(null, { status: 400 });
          if (existing?.closed) return new Response(null, { status: 409 });
          if (
            existing &&
            (existing.terms.amountCents !== parsed.data.amountCents ||
              existing.terms.merchantId !== parsed.data.merchantId)
          )
            return new Response(null, { status: 409 });
          const checkoutKey = existing?.key ?? crypto.randomUUID();
          if (!existing) {
            orders.set(key, { terms: parsed.data, key: checkoutKey });
            checkouts.set(checkoutKey, key);
          }
          return Response.json({
            checkoutUrl: `${server.url.origin}/checkout/${checkoutKey}`,
          });
        }
      }
      if (route === "refunds") {
        if (request.headers.get("authorization") !== `Bearer ${token}`)
          return new Response(null, { status: 401 });
        const existing = refunds.get(key);
        if (request.method === "GET") {
          if (!existing) return Response.json({ state: "unknown" });
          const confirmed = {
            ...existing,
            state: "confirmed",
          } satisfies Refund;
          refunds.set(key, confirmed);
          await notifyRefund?.(confirmed).catch(() => undefined);
          return Response.json(confirmed);
        }
        if (request.method === "PUT") {
          const parsed = testRefundTerms.safeParse(
            await request.json().catch(() => undefined),
          );
          if (!parsed.success || parsed.data.refundId !== key)
            return new Response(null, { status: 400 });
          const terms = parsed.data;
          const payment = orders.get(terms.orderId)?.payment;
          const priorId = refundByOrder.get(terms.orderId);
          if (
            !payment ||
            payment.merchantId !== terms.merchantId ||
            payment.currency !== terms.currency ||
            payment.amountCents !== terms.amountCents ||
            payment.channelOrderRef !== terms.channelOrderRef ||
            (priorId && priorId !== key) ||
            (existing && existing.orderId !== terms.orderId)
          )
            return new Response(null, { status: 409 });
          const result = existing ?? { ...terms, state: "processing" };
          refunds.set(key, result);
          refundByOrder.set(terms.orderId, key);
          return Response.json(result);
        }
      }
      if (route === "checkout") {
        const orderId = checkouts.get(key);
        const order = orderId && orders.get(orderId);
        if (!order) return new Response(null, { status: 404 });
        if (order.closed)
          return new Response("This test order is closed.", { status: 409 });
        if (request.method === "GET")
          return new Response(
            `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${name} test checkout</title><h1>${name} test checkout</h1>
<p>Simulated payment of CN¥${(order.terms.amountCents / 100).toFixed(2)}.</p>
<form method="post"><button>Confirm simulated payment</button></form></html>`,
            {
              headers: {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
              },
            },
          );
        if (request.method === "POST") {
          order.payment ??= {
            ...order.terms,
            state: "paid",
            channelOrderRef: crypto.randomUUID(),
            paidAt: new Date().toISOString(),
          };
          const accepted = await notify(order.payment).then(
            (response) => response.ok,
            () => false,
          );
          return new Response(
            accepted
              ? "Simulated payment confirmed. Return to OpenBot Credits."
              : "Simulated payment recorded. Return to OpenBot Credits and select Check payment.",
            { headers: { "cache-control": "no-store" } },
          );
        }
      }
      return new Response(null, { status: 404 });
    },
  });
}

if (import.meta.main) {
  const channel = z
    .enum(["wechat", "alipay"])
    .parse(process.env.OPENBOT_CREDIT_PACK_FIXTURE_CHANNEL ?? "wechat");
  const token =
    (channel === "alipay"
      ? process.env.OPENBOT_CREDIT_PACK_ALIPAY_TEST_TOKEN
      : process.env.OPENBOT_CREDIT_PACK_TEST_TOKEN) ?? "";
  const callback = new URL(
    process.env.OPENBOT_CREDIT_PACK_FIXTURE_CALLBACK ?? "",
  );
  if (
    callback.protocol !== "http:" ||
    callback.hostname !== "127.0.0.1" ||
    callback.username ||
    callback.password
  )
    throw new Error("Use a loopback OpenBot callback URL.");
  const refundCallback = new URL("refund-callback", callback);
  function send(url: URL, result: Payment | Refund) {
    return fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(result),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
  }
  const fixture = startCreditPackFixture({
    channel,
    token,
    port: Number(process.env.OPENBOT_CREDIT_PACK_FIXTURE_PORT ?? "9199"),
    notify: (payment) => send(callback, payment),
    notifyRefund: (refund) => send(refundCallback, refund),
  });
  process.stdout.write(
    `${channel === "alipay" ? "Alipay" : "WeChat"} test fixture listening at ${fixture.url.origin}\n`,
  );
}
