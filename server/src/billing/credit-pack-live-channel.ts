import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  type CreditPackChannel,
  type CreditPackChannelAdapter,
  testPaymentResult,
  testRefundResult,
  type testRefundTerms,
} from "./credit-pack-test-channel";

const liveConfig = z.object({
  origin: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname !== "127.0.0.1" &&
      url.hostname !== "localhost" &&
      url.origin === value
    );
  }),
  token: z.string().regex(/^[A-Za-z0-9_-]{24,256}$/),
  accounts: z.array(z.uuid()),
  applicationIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).min(1),
  productCode: z.string().trim().min(1).max(120),
  merchant: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((value) => !value.startsWith("fixture-")),
});

const unknown = z.object({ state: z.literal("unknown") });
const payments = z.union([unknown, testPaymentResult]);

const settingsPrefix = {
  wechat: "OPENBOT_CREDIT_PACK_LIVE",
  alipay: "OPENBOT_CREDIT_PACK_ALIPAY_LIVE",
} satisfies Record<CreditPackChannel, string>;

/**
 * Provider-backed channel. Absent unless its own credentials are configured
 * and disjoint from any loopback fixture's, so an unproven channel stays
 * closed. Callbacks are signed by the provider; merchant, amount and order
 * evidence is then checked by the ledger as for any other channel.
 */
export function loadCreditPackLiveChannel(
  environment: Record<string, string | undefined>,
  kind: CreditPackChannel = "wechat",
): CreditPackChannelAdapter | undefined {
  const prefix = settingsPrefix[kind];
  const origin = environment[`${prefix}_ORIGIN`];
  if (!origin) return undefined;
  const testPrefix = settingsPrefix[kind].replace("_LIVE", "_TEST");
  if (
    environment[`${testPrefix}_ORIGIN`] === origin ||
    environment[`${testPrefix}_TOKEN`] === environment[`${prefix}_TOKEN`]
  )
    return undefined;
  const list = (value?: string) =>
    value
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean) ?? [];
  const config = liveConfig.safeParse({
    origin,
    token: environment[`${prefix}_TOKEN`],
    accounts: list(environment[`${prefix}_ACCOUNT_IDS`]),
    applicationIds: list(environment[`${prefix}_APPLICATION_IDS`]),
    productCode:
      environment[`${prefix}_PRODUCT`] ??
      environment.OPENBOT_CREDIT_PACK_TEST_PRODUCT,
    merchant: environment[`${prefix}_MERCHANT`],
  });
  if (!config.success) return undefined;
  const { merchant, productCode, applicationIds } = config.data;
  const liveOrigin = config.data.origin;
  const accounts = new Set(config.data.accounts);
  const token = config.data.token;
  const sign = (body: string) =>
    createHmac("sha256", token).update(body).digest("hex");
  async function request(route: string, id: string, body?: object) {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(
      `${liveOrigin}/${route}/${encodeURIComponent(id)}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-signature": sign(`${route}/${id}:${payload}`),
        },
        body: body === undefined ? undefined : payload,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) throw new Error("Live payment channel unavailable.");
    return response.json();
  }
  return {
    kind,
    fixture: false,
    merchant,
    productCode,
    applicationIds,
    allows: (accountId: string) => accounts.has(accountId),
    // shortcut: HMAC covers route and body but no timestamp; a replayed
    // callback is idempotent in the ledger, rotate the token to revoke.
    authenticates: async (incoming: Request) => {
      const header = incoming.headers.get("x-signature") ?? "";
      const route = incoming.headers.get("x-channel-route") ?? "callback";
      const body = await incoming.clone().text();
      const expected = Buffer.from(sign(`${route}:${body}`));
      const supplied = Buffer.from(header);
      return (
        supplied.length === expected.length &&
        timingSafeEqual(supplied, expected)
      );
    },
    async checkout(order: { id: string; priceCents: number }) {
      const result = await request("orders", order.id, {
        orderId: order.id,
        merchantId: merchant,
        amountCents: order.priceCents,
        currency: "CNY",
        productCode,
      });
      const { checkoutUrl } = z.object({ checkoutUrl: z.url() }).parse(result);
      const url = new URL(checkoutUrl);
      if (
        url.protocol !== "https:" ||
        url.origin !== liveOrigin ||
        url.username ||
        url.password
      )
        throw new Error("Invalid live checkout URL.");
      return url.href;
    },
    async startRefund(refund: z.infer<typeof testRefundTerms>) {
      return testRefundResult.parse(
        await request("refunds", refund.refundId, refund),
      );
    },
    async queryRefund(id: string) {
      return z
        .union([unknown, testRefundResult])
        .parse(await request("refunds", id));
    },
    async close(id: string) {
      return payments.parse(await request("orders/close", id, {}));
    },
    async query(id: string) {
      return payments.parse(await request("orders", id));
    },
  };
}

export function liveCallbackSignature(
  token: string,
  route = "callback",
  body = "",
) {
  return createHmac("sha256", token).update(`${route}:${body}`).digest("hex");
}
