import { z } from "zod";
import type { paidTestPayment } from "../src/billing/credit-pack-test-channel";

const checkoutTerms = z.strictObject({
  orderId: z.uuid(),
  merchantId: z.string().regex(/^fixture-[A-Za-z0-9_-]{1,112}$/),
  currency: z.literal("CNY"),
  amountCents: z.number().int().positive(),
});

type Payment = z.infer<typeof paidTestPayment>;

export function startCreditPackFixture({
  token,
  port,
  notify,
}: {
  token: string;
  port: number;
  notify: (payment: Payment) => Promise<Response>;
}) {
  if (!/^[A-Za-z0-9_-]{24,256}$/.test(token))
    throw new Error("Set a dedicated fixture token of at least 24 characters.");
  const orders = new Map<
    string,
    {
      terms: z.infer<typeof checkoutTerms>;
      key: string;
      payment?: Payment;
    }
  >();
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
        if (request.method === "GET")
          return Response.json(existing?.payment ?? { state: "unknown" });
        if (request.method === "PUT") {
          const parsed = checkoutTerms.safeParse(
            await request.json().catch(() => undefined),
          );
          if (!parsed.success || parsed.data.orderId !== key)
            return new Response(null, { status: 400 });
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
      if (route === "checkout") {
        const orderId = checkouts.get(key);
        const order = orderId && orders.get(orderId);
        if (!order) return new Response(null, { status: 404 });
        if (request.method === "GET")
          return new Response(
            `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>WeChat test checkout</title><h1>WeChat test checkout</h1>
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
  const token = process.env.OPENBOT_CREDIT_PACK_TEST_TOKEN ?? "";
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
  const fixture = startCreditPackFixture({
    token,
    port: Number(process.env.OPENBOT_CREDIT_PACK_FIXTURE_PORT ?? "9199"),
    notify: (payment) =>
      fetch(callback, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payment),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      }),
  });
  process.stdout.write(
    `WeChat test fixture listening at ${fixture.url.origin}\n`,
  );
}
