import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  createFlexpriceAlipayClient,
  flexpriceInvoiceKey,
  flexpriceInvoiceNotification,
  flexpriceQRChannel,
} from "./flexprice-alipay-client";
import { createFlexpricePackRefundReconciliation } from "./flexprice-pack-refund";
import { type PaidCreditLedger, PaidLedgerError } from "./paid-ledger";
import type { TestCreditLedger, VerifiedBillingIdentity } from "./test-credit";

const settingsSchema = z.object({
  baseUrl: z.url(),
  apiKey: z.string().trim().min(1),
  webhookToken: z.string().regex(/^[A-Za-z0-9_-]{24,256}$/),
  merchant: z.string().trim().min(1).optional(),
  wechatMerchant: z.string().trim().min(1).optional(),
  environmentId: z.string().trim().min(1).optional(),
  productCodes: z.array(z.string().min(1)).min(1),
  applicationIds: z.array(z.string().min(1)).min(1),
  accountIds: z.array(z.uuid()),
});

export function loadFlexpriceAlipaySettings(environment: NodeJS.ProcessEnv) {
  const alipay = environment.OPENBOT_FLEXPRICE_ALIPAY_ENABLED === "true";
  const wechat = environment.OPENBOT_FLEXPRICE_WECHAT_ENABLED === "true";
  if (!alipay && !wechat) return undefined;
  const list = (value?: string) => [
    ...new Set(
      value
        ?.split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  return settingsSchema.parse({
    baseUrl: environment.OPENBOT_FLEXPRICE_ALIPAY_URL,
    apiKey: environment.OPENBOT_FLEXPRICE_ALIPAY_API_KEY,
    webhookToken: environment.OPENBOT_FLEXPRICE_ALIPAY_WEBHOOK_TOKEN,
    merchant: alipay
      ? z
          .string()
          .trim()
          .min(1)
          .parse(environment.OPENBOT_FLEXPRICE_ALIPAY_MERCHANT)
      : undefined,
    wechatMerchant: wechat
      ? z
          .string()
          .trim()
          .min(1)
          .parse(environment.OPENBOT_FLEXPRICE_WECHAT_MERCHANT)
      : undefined,
    environmentId: environment.OPENBOT_FLEXPRICE_ENVIRONMENT_ID,
    productCodes: list(environment.OPENBOT_FLEXPRICE_ALIPAY_PRODUCTS),
    applicationIds: list(environment.OPENBOT_FLEXPRICE_ALIPAY_APPLICATION_IDS),
    accountIds: list(environment.OPENBOT_FLEXPRICE_ALIPAY_ACCOUNT_IDS),
  });
}

export type FlexpriceAlipaySettings = z.infer<typeof settingsSchema>;
type Order = NonNullable<
  Awaited<ReturnType<PaidCreditLedger["flexpriceOrder"]>>
>;
type Client = ReturnType<typeof createFlexpriceAlipayClient>;
type Invoice = Awaited<ReturnType<Client["readInvoice"]>>;
type QRCheckout = NonNullable<Awaited<ReturnType<Client["checkout"]>>>;

const mismatch = () =>
  new PaidLedgerError(
    "verification_mismatch",
    "Flexprice payment does not match the placed order.",
  );

function checkInvoice(order: Order, invoice: Invoice) {
  if (
    (order.flexpriceInvoiceId !== null &&
      invoice.id !== order.flexpriceInvoiceId) ||
    invoice.idempotency_key !== flexpriceInvoiceKey(order.id) ||
    invoice.metadata.openbot_account_id !== order.accountId ||
    invoice.invoice_status !== "FINALIZED" ||
    invoice.currency.toUpperCase() !== "CNY" ||
    invoice.total !== order.priceCents ||
    invoice.amount_due !== order.priceCents
  )
    throw mismatch();
}

function checkQR(order: Order, qr: QRCheckout) {
  if (qr.currency.toUpperCase() !== "CNY" || qr.amount !== order.priceCents)
    throw mismatch();
}

function createReconciliation(paid: PaidCreditLedger, client: Client) {
  return async (order: Order, observed?: QRCheckout) => {
    if (!order.flexpriceInvoiceId || order.state !== "pending") return;
    const invoice = await client.readInvoice(order.flexpriceInvoiceId);
    checkInvoice(order, invoice);
    // A status read also reconciles missed merchant notifications.
    const qr = observed ?? (await client.checkout(invoice));
    if (!qr) return;
    checkQR(order, qr);
    if (qr.status !== "paid") return;
    const settled = await client.readInvoice(order.flexpriceInvoiceId);
    checkInvoice(order, settled);
    if (settled.payment_status !== "SUCCEEDED") return;
    if (
      settled.customer_id !== invoice.customer_id ||
      settled.amount_paid !== order.priceCents ||
      settled.amount_remaining !== 0 ||
      !settled.paid_at
    )
      throw mismatch();
    const outcome = await paid.verifyOrder({
      orderId: order.id,
      channel: qr.channel,
      channelOrderRef: qr.order_id,
      flexpriceInvoiceId: invoice.id,
      currency: "CNY",
      amountCents: settled.amount_paid,
      paidAt: new Date(settled.paid_at),
    });
    if (outcome.claimed)
      await paid.advanceClosureOrder(order.accountId, order.id);
  };
}

export function createFlexpriceAlipayCheckout({
  settings,
  paid,
  ledger,
}: {
  settings: FlexpriceAlipaySettings;
  paid: PaidCreditLedger;
  ledger: TestCreditLedger;
}) {
  const client = createFlexpriceAlipayClient(settings);
  const reconcile = createReconciliation(paid, client);
  const sales = new Map<z.infer<typeof flexpriceQRChannel>, string>();
  if (settings.merchant) sales.set("alipay", settings.merchant);
  if (settings.wechatMerchant) sales.set("wechat", settings.wechatMerchant);
  const defaultChannel = sales.keys().next().value;
  const scope = { fixture: false, flexprice: true } satisfies Partial<
    Parameters<PaidCreditLedger["testPackOrders"]>[0]
  >;
  const root = "/paid/credit-pack/alipay/flexprice";
  const api = new Hono<{ Variables: { identity: VerifiedBillingIdentity } }>();
  const allowed = new Set(settings.accountIds);
  const products = new Set(settings.productCodes);
  const webhookAuthorization = Buffer.from(`Bearer ${settings.webhookToken}`);
  const notFound = () =>
    Response.json({ error: "Checkout unavailable." }, { status: 404 });

  async function invoiceFor(order: Order) {
    const invoice = order.flexpriceInvoiceId
      ? await client.readInvoice(order.flexpriceInvoiceId)
      : await client.createInvoice(order);
    checkInvoice(order, invoice);
    if (!order.flexpriceInvoiceId)
      await paid.linkFlexpriceInvoice({
        orderId: order.id,
        invoiceId: invoice.id,
      });
    return invoice;
  }

  api.onError((error, context) => {
    if (error instanceof PaidLedgerError) {
      if (error.code === "order_unknown") return notFound();
      if (error.code !== "ledger_restoring")
        return context.json({ code: error.code, error: error.message }, 409);
    }
    return context.json(
      { error: "Flexprice checkout is temporarily unavailable." },
      503,
    );
  });

  api.get(root, async (context) => {
    const accountId = await ledger.accountOf(context.var.identity);
    if (!accountId || !allowed.has(accountId)) return notFound();
    const offers = await Promise.all(
      settings.productCodes.map(async (productCode) => {
        const byChannel = await Promise.all(
          [...sales].map(async ([channel, merchant]) => ({
            channel,
            ...(await paid.creditPackOffer(
              accountId,
              productCode,
              settings.applicationIds,
              {
                channel,
                merchant,
                fixture: false,
              },
            )),
          })),
        );
        const offer =
          byChannel.find(({ available }) => available) ?? byChannel[0];
        return {
          ...offer,
          productCode,
          channels: byChannel
            .filter(({ available }) => available)
            .map(({ channel }) => channel),
        };
      }),
    );
    return context.json({ offers, channels: [...sales.keys()] });
  });

  api.get(`${root}/orders`, async (context) => {
    const accountId = await ledger.accountOf(context.var.identity);
    if (!accountId) return notFound();
    return context.json(await paid.testPackOrders({ ...scope, accountId }));
  });

  api.post(`${root}/orders`, async (context) => {
    const accountId = await ledger.accountOf(context.var.identity);
    if (!accountId || !allowed.has(accountId)) return notFound();
    const input = z
      .strictObject({
        orderId: z.uuid(),
        version: z.number().int().positive(),
        productCode: z.string(),
        channel: flexpriceQRChannel.optional(),
      })
      .safeParse(await context.req.json().catch(() => undefined));
    if (!input.success || !products.has(input.data.productCode))
      return context.json({ error: "Invalid Credit Pack order." }, 400);
    const channel = input.data.channel ?? defaultChannel;
    const merchant = channel && sales.get(channel);
    if (!channel || !merchant) return notFound();
    const order = await paid.createOrder({
      accountId,
      channel,
      productCode: input.data.productCode,
      testPack: {
        id: input.data.orderId,
        version: input.data.version,
        merchant,
        applicationIds: settings.applicationIds,
        live: true,
        flexprice: true,
      },
    });
    if (!order.flexpriceInvoiceId && order.state === "pending")
      await invoiceFor(order);
    return context.json(
      { id: order.id, state: order.state },
      order.replayed ? 200 : 201,
    );
  });

  api.post(`${root}/orders/:id/checkout`, async (context) => {
    const accountId = await ledger.accountOf(context.var.identity);
    const id = z.uuid().safeParse(context.req.param("id"));
    if (!accountId || !allowed.has(accountId) || !id.success) return notFound();
    const order = await paid.flexpriceOrder({ id: id.data, accountId });
    if (!order) return notFound();
    if (order.state !== "pending")
      return context.json({ error: "This order is no longer pending." }, 409);
    const input = z
      .strictObject({ channel: flexpriceQRChannel.optional() })
      .safeParse(
        context.req.raw.body
          ? await context.req.json().catch(() => undefined)
          : {},
      );
    if (!input.success)
      return context.json({ error: "Invalid payment channel." }, 400);
    const channel = input.data.channel ?? defaultChannel;
    const merchant = channel && sales.get(channel);
    if (!channel || !merchant) return notFound();
    const invoice = await invoiceFor(order);
    if (invoice.payment_status === "SUCCEEDED") {
      await reconcile({ ...order, flexpriceInvoiceId: invoice.id });
      return context.json({ status: "confirming" });
    }
    await paid.checkTestCheckout(
      accountId,
      settings.applicationIds,
      { channel, merchant, fixture: false },
      order.priceCents,
    );
    const qr = await client.checkout(invoice, channel);
    if (!qr) throw new Error("Flexprice returned no QR checkout.");
    checkQR(order, qr);
    if (qr.status === "paid")
      await reconcile({ ...order, flexpriceInvoiceId: invoice.id }, qr);
    context.header("Cache-Control", "no-store");
    if (qr.status !== "paid" && qr.channel !== channel)
      return context.json({ channel: qr.channel, status: "confirming" });
    if (qr.status === "pending" && !qr.qr_code)
      return context.json({ channel, status: "confirming" });
    return context.json({
      channel: qr.channel,
      status: qr.status,
      qrCode: qr.status === "pending" ? qr.qr_code : undefined,
      expiresAt: qr.expires_at,
    });
  });

  api.post(`${root}/orders/:id/verify`, async (context) => {
    const accountId = await ledger.accountOf(context.var.identity);
    const id = z.uuid().safeParse(context.req.param("id"));
    if (!accountId || !id.success) return notFound();
    const order = await paid.flexpriceOrder({ id: id.data, accountId });
    if (!order) return notFound();
    await reconcile(order);
    const [updated] = await paid.testPackOrders({
      ...scope,
      accountId,
      id: order.id,
    });
    return context.json(updated);
  });

  api.post(
    "/credit-pack-flexprice/alipay/callback",
    bodyLimit({ maxSize: 1024 * 1024 }),
    async (context) => {
      const supplied = Buffer.from(context.req.header("authorization") ?? "");
      if (
        supplied.length !== webhookAuthorization.length ||
        !timingSafeEqual(supplied, webhookAuthorization)
      )
        return context.json(
          { error: "Verified Flexprice sender required." },
          401,
        );
      const result = flexpriceInvoiceNotification.safeParse(
        await context.req.json().catch(() => undefined),
      );
      if (!result.success)
        return context.json({ error: "Invalid invoice event." }, 400);
      const order = await paid.flexpriceOrder({
        invoiceId: result.data.invoice.id,
      });
      if (order) await reconcile(order);
      return context.json({ accepted: true });
    },
  );

  return api;
}

export function createFlexpriceAlipaySweep({
  settings,
  paid,
  onError,
}: {
  settings: FlexpriceAlipaySettings;
  paid: PaidCreditLedger;
  onError: (orderId: string, error: unknown) => void;
}) {
  const reconcile = createReconciliation(
    paid,
    createFlexpriceAlipayClient(settings),
  );
  const reconcileRefund = createFlexpricePackRefundReconciliation(
    paid,
    settings,
  );
  let after: string | undefined;
  let afterRefund: string | undefined;
  return async () => {
    const orders = await paid.pendingFlexpriceOrders(after);
    for (let offset = 0; offset < orders.length; offset += 5)
      await Promise.all(
        orders.slice(offset, offset + 5).map(async (order) => {
          try {
            await reconcile(order);
          } catch (error) {
            onError(order.id, error);
          }
        }),
      );
    after = orders.at(-1)?.id;

    const refunds = await paid.pendingAutomaticFlexpriceRefunds(afterRefund);
    for (let offset = 0; offset < refunds.length; offset += 5)
      await Promise.all(
        refunds.slice(offset, offset + 5).map(async (refund) => {
          try {
            await reconcileRefund(refund, "automatic");
          } catch (error) {
            onError(refund.orderId, error);
          }
        }),
      );
    afterRefund = refunds.at(-1)?.orderId;
  };
}
