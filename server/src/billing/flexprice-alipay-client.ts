import { z } from "zod";

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,150}$/);
const cnyAmount = z
  .string()
  .regex(/^\d{1,12}(?:\.(?:\d{1,2}|\d{2}0+))?$/)
  .transform((decimal) => {
    const [units, fraction = ""] = decimal.split(".");
    return Number(units) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
  });
const invoiceResponse = z.object({
  id: identifier,
  customer_id: identifier,
  idempotency_key: z.string(),
  metadata: z.object({ openbot_account_id: z.uuid() }),
  currency: z.string(),
  invoice_status: z.string(),
  payment_status: z.string(),
  amount_due: cnyAmount,
  total: cnyAmount,
  amount_paid: cnyAmount,
  amount_remaining: cnyAmount,
  paid_at: z.iso.datetime({ offset: true }).nullish(),
});
export const flexpriceQRChannel = z.enum(["alipay", "wechat"]);
const qrResponse = z.object({
  channel: flexpriceQRChannel,
  order_id: identifier,
  amount: cnyAmount,
  currency: z.string(),
  status: z.enum(["paid", "pending", "closed", "confirming", "expired"]),
  qr_code: z.string().min(1).max(4096).optional(),
  expires_at: z.iso.datetime({ offset: true }),
});
const customerResponse = z.object({ id: identifier, external_id: z.string() });
export const flexpriceInvoiceNotification = z.object({
  event_type: z.literal("invoice.update.payment"),
  invoice: z.object({ id: identifier }),
});

export function flexpriceInvoiceKey(orderId: string) {
  return `openbot-credit-pack:${orderId}`;
}

export function createFlexpriceAlipayClient(options: {
  baseUrl: string;
  apiKey: string;
  environmentId?: string;
}) {
  const origin = new URL(options.baseUrl);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.href !== `${origin.origin}/`
  )
    throw new Error("Flexprice URL must be an HTTP origin.");

  async function request(path: string, body?: object) {
    return fetch(`${origin.origin}/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": options.apiKey,
        ...(options.environmentId
          ? { "x-environment-id": options.environmentId }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  }

  async function json(response: Response): Promise<unknown> {
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Flexprice request failed with HTTP ${response.status}.`);
    }
    return response.json();
  }

  async function customer(accountId: string) {
    const externalId = `openbot-alipay-${accountId}`;
    const path = `/customers/external/${encodeURIComponent(externalId)}`;
    let response = await request(path);
    if (response.status === 404) {
      await response.body?.cancel();
      response = await request("/customers", {
        external_id: externalId,
        name: `OpenBot ${accountId}`,
        billing_currency: "CNY",
        skip_onboarding_workflow: true,
      });
      if (response.status === 409) {
        await response.body?.cancel();
        response = await request(path);
      }
    }
    return customerResponse
      .extend({ external_id: z.literal(externalId) })
      .parse(await json(response));
  }

  const invoicePath = (id: string) => `/invoices/${encodeURIComponent(id)}`;
  const readInvoice = async (id: string) =>
    invoiceResponse.parse(await json(await request(invoicePath(id))));

  async function createInvoice(order: {
    id: string;
    accountId: string;
    priceCents: number;
  }) {
    const { id: customerId } = await customer(order.accountId);
    const amount = (order.priceCents / 100).toFixed(2);
    const response = await request("/invoices", {
      customer_id: customerId,
      idempotency_key: flexpriceInvoiceKey(order.id),
      invoice_type: "ONE_OFF",
      billing_reason: "MANUAL",
      currency: "CNY",
      amount_due: amount,
      total: amount,
      subtotal: amount,
      line_items: [
        { display_name: "OpenBot Credit Pack", amount, quantity: "1" },
      ],
      metadata: { openbot_account_id: order.accountId },
    });
    let invoice: Awaited<ReturnType<typeof readInvoice>>;
    if (response.status === 409) {
      const conflict = z.object({
        details: z.object({ invoice_id: identifier }),
      });
      const { details } = conflict.parse(await response.json());
      invoice = await readInvoice(details.invoice_id);
    } else {
      invoice = invoiceResponse.parse(await json(response));
    }
    if (invoice.customer_id !== customerId)
      throw new Error("Flexprice returned an invoice for another customer.");
    return invoice;
  }

  async function checkout(
    invoice: { id: string; customer_id: string },
    channel?: z.infer<typeof flexpriceQRChannel>,
  ) {
    const query = new URLSearchParams({ customer_id: invoice.customer_id });
    const response = await request(
      `${invoicePath(invoice.id)}/qr-checkout?${query}`,
      channel ? { channel } : undefined,
    );
    if (!channel && response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    return qrResponse.parse(await json(response));
  }

  return { createInvoice, readInvoice, checkout };
}
