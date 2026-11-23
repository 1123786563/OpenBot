import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const paidTestPayment = z.object({
  state: z.literal("paid"),
  orderId: z.uuid(),
  merchantId: z.string().min(1).max(120),
  currency: z.string().length(3),
  amountCents: z.number().int().positive(),
  channelOrderRef: z.string().min(1).max(128),
  paidAt: z.iso.datetime({ offset: true }),
});

const channelResult = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unknown") }),
  paidTestPayment,
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

/** A loopback fixture protocol for the WeChat test harness. */
export function loadCreditPackTestChannel(
  environment: Record<string, string | undefined>,
) {
  const origin = environment.OPENBOT_CREDIT_PACK_TEST_ORIGIN;
  if (!origin) return undefined;
  const list = (value?: string) =>
    value
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean) ?? [];
  const config = configSchema.parse({
    origin,
    token: environment.OPENBOT_CREDIT_PACK_TEST_TOKEN,
    accounts: list(environment.OPENBOT_CREDIT_PACK_TEST_ACCOUNT_IDS),
    applicationIds: list(environment.OPENBOT_CREDIT_PACK_TEST_APPLICATION_IDS),
    productCode: environment.OPENBOT_CREDIT_PACK_TEST_PRODUCT,
    merchant: environment.OPENBOT_CREDIT_PACK_TEST_MERCHANT,
  });
  const authorization = `Bearer ${config.token}`;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(authorization);
  const accounts = new Set(config.accounts);
  async function request(id: string, options?: RequestInit) {
    const response = await fetch(
      `${config.origin}/orders/${encodeURIComponent(id)}`,
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
      const payload = await request(order.id, {
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
    async query(id: string) {
      return channelResult.parse(await request(id));
    },
  };
}

export type CreditPackTestChannel = NonNullable<
  ReturnType<typeof loadCreditPackTestChannel>
>;
