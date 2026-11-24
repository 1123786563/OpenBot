import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const paymentTerms = z.object({
  orderId: z.uuid(),
  merchantId: z.string().min(1).max(120),
  currency: z.string().length(3),
  amountCents: z.number().int().positive(),
});

export const paidTestPayment = paymentTerms.extend({
  state: z.literal("paid"),
  channelOrderRef: z.string().min(1).max(128),
  paidAt: z.iso.datetime({ offset: true }),
});

const failedTestPayment = paymentTerms.extend({ state: z.literal("failed") });

export const testPaymentResult = z.discriminatedUnion("state", [
  paidTestPayment,
  failedTestPayment,
]);

const channelResult = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unknown") }),
  paidTestPayment,
  failedTestPayment,
]);

export const testRefundTerms = z.object({
  refundId: z.uuid(),
  orderId: z.uuid(),
  merchantId: z.string().min(1).max(120),
  currency: z.literal("CNY"),
  amountCents: z.number().int().positive(),
  channelOrderRef: z.string().min(1).max(128),
});

export const testRefundResult = z.discriminatedUnion("state", [
  testRefundTerms.extend({
    // "failed" is definitive: no funds were returned and none remain owed.
    state: z.enum([
      "processing",
      "confirmed",
      "failed",
      "manual_owed",
      "disputed",
    ]),
  }),
  testRefundTerms
    .extend({
      state: z.literal("partial"),
      returnedCents: z.number().int().positive(),
    })
    .refine(({ returnedCents, amountCents }) => returnedCents < amountCents),
]);
export type CreditPackTestRefundResult = z.infer<typeof testRefundResult>;

const refundQueryResult = z.union([
  z.object({ state: z.literal("unknown") }),
  testRefundResult,
]);

const configSchema = z.object({
  origin: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.origin === value
    );
  }),
  token: z.string().regex(/^[A-Za-z0-9_-]{24,256}$/),
  accounts: z.array(z.uuid()),
  applicationIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).min(1),
  productCode: z.string().trim().min(1).max(120),
  merchant: z.string().regex(/^fixture-[A-Za-z0-9_-]{1,112}$/),
});

export type CreditPackChannel = "wechat" | "alipay";

const settingsPrefix = {
  wechat: "OPENBOT_CREDIT_PACK_TEST",
  alipay: "OPENBOT_CREDIT_PACK_ALIPAY_TEST",
} satisfies Record<CreditPackChannel, string>;

/** Loopback fixtures with separate credentials for each payment channel. */
export function loadCreditPackTestChannel(
  environment: Record<string, string | undefined>,
  kind: CreditPackChannel = "wechat",
) {
  const prefix = settingsPrefix[kind];
  const origin = environment[`${prefix}_ORIGIN`];
  if (!origin) return undefined;
  if (
    kind === "alipay" &&
    environment.OPENBOT_CREDIT_PACK_TEST_ORIGIN &&
    (origin === environment.OPENBOT_CREDIT_PACK_TEST_ORIGIN ||
      environment[`${prefix}_TOKEN`] ===
        environment.OPENBOT_CREDIT_PACK_TEST_TOKEN)
  )
    throw new Error(
      "Alipay and WeChat fixtures require separate origins and tokens.",
    );
  const list = (value?: string) =>
    value
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean) ?? [];
  const config = configSchema.parse({
    origin,
    token: environment[`${prefix}_TOKEN`],
    accounts: list(environment[`${prefix}_ACCOUNT_IDS`]),
    applicationIds: list(environment[`${prefix}_APPLICATION_IDS`]),
    productCode: environment.OPENBOT_CREDIT_PACK_TEST_PRODUCT,
    merchant: environment[`${prefix}_MERCHANT`],
  });
  const authorization = `Bearer ${config.token}`;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(authorization);
  const accounts = new Set(config.accounts);
  async function request(
    route: "orders" | "refunds",
    id: string,
    options?: RequestInit,
  ) {
    const response = await fetch(
      `${config.origin}/${route}/${encodeURIComponent(id)}`,
      {
        ...options,
        headers: { authorization, "content-type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) throw new Error("Test payment channel unavailable.");
    return response.json();
  }
  return {
    kind,
    merchant: config.merchant,
    productCode: config.productCode,
    applicationIds: config.applicationIds,
    allows: (accountId: string) => accounts.has(accountId),
    authenticates: (request: Request) =>
      timingSafeEqual(
        digest(request.headers.get("authorization") ?? ""),
        expected,
      ),
    async checkout(order: { id: string; priceCents: number }) {
      const payload = await request("orders", order.id, {
        method: "PUT",
        body: JSON.stringify({
          orderId: order.id,
          merchantId: config.merchant,
          amountCents: order.priceCents,
          currency: "CNY",
        }),
      });
      const { checkoutUrl } = z.object({ checkoutUrl: z.url() }).parse(payload);
      const url = new URL(checkoutUrl);
      if (
        url.protocol !== "http:" ||
        url.origin !== config.origin ||
        url.username ||
        url.password
      )
        throw new Error("Invalid test checkout URL.");
      return url.href;
    },
    async startRefund(refund: z.infer<typeof testRefundTerms>) {
      return refundQueryResult.parse(
        await request("refunds", refund.refundId, {
          method: "PUT",
          body: JSON.stringify(refund),
        }),
      );
    },
    async queryRefund(id: string) {
      return refundQueryResult.parse(await request("refunds", id));
    },
    async close(id: string) {
      return channelResult.parse(
        await request("orders", id, { method: "DELETE" }),
      );
    },
    async query(id: string) {
      return channelResult.parse(await request("orders", id));
    },
  };
}

export type CreditPackTestChannel = NonNullable<
  ReturnType<typeof loadCreditPackTestChannel>
>;
