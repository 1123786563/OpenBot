import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

/**
 * 账单管理 as the browser sees it, mirroring `/api/billing/invoices` exactly.
 *
 * A bill is a local payment order read as a statement, not a document fetched from the provider:
 * this deployment raises its own orders and settles them through its own channels, so the bill
 * number is the order id and the payment method is the channel that carried it.
 */

/** The money state, in the order's own words. `blocked` is terminal. */
export type InvoiceStatus =
  | "pending"
  | "paid"
  | "blocked"
  | "canceled"
  | "expired";

/** One bill as the list renders it. */
export type BillingInvoice = {
  invoiceId: string;
  planCode: string;
  periodStart: string | null;
  periodEnd: string | null;
  amountCents: number;
  currency: "CNY";
  status: InvoiceStatus;
  method: "alipay" | "wechat";
  issuedAt: string;
  /** When money landed. Null unless the order actually settled as paid. */
  settledAt: string | null;
  channelTransactionId: string | null;
};

/** One line on a bill. v1 raises one: the plan the order bought. */
export type BillingInvoiceLine = {
  label: string;
  quantity: number;
  amountCents: number;
};

export type BillingInvoiceDetail = BillingInvoice & {
  lines: BillingInvoiceLine[];
};

export type BillingInvoicePage = {
  invoices: BillingInvoice[];
  pagination: {
    totalCount: number;
    totalPages: number;
    currentPage: number;
    nextPage: number | null;
  };
};

/** The window the list is narrowed to. Both ends ISO-8601; either may be absent. */
export type InvoiceWindow = { from?: string; to?: string };

export const invoiceKeys = {
  all: ["billing", "invoices"] as const,
  list: (window: InvoiceWindow, page: number) =>
    [
      ...invoiceKeys.all,
      "list",
      window.from ?? "",
      window.to ?? "",
      page,
    ] as const,
  detail: (invoiceId: string) =>
    [...invoiceKeys.all, "detail", invoiceId] as const,
};

/**
 * A deployment with no billing provider configured answers 404 on the whole surface — the surface
 * does not exist there, which is a fact about the deployment rather than a failure. The page reads
 * this to say "not configured" instead of "broken".
 */
export class BillingUnavailableError extends Error {
  constructor() {
    super("Billing is not configured on this deployment.");
    this.name = "BillingUnavailableError";
  }
}

/** One page of bills in a window, newest first. */
export const invoicesQueryOptions = (window: InvoiceWindow, page: number) =>
  queryOptions({
    queryKey: invoiceKeys.list(window, page),
    staleTime: 0,
    queryFn: async (): Promise<BillingInvoicePage> => {
      const params = new URLSearchParams();
      if (window.from) params.set("from", window.from);
      if (window.to) params.set("to", window.to);
      params.set("page", String(page));
      const response = await tryClient(`/api/billing/invoices?${params}`);
      if (response.status === 404) throw new BillingUnavailableError();
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? "Your bills could not be loaded.");
      }
      return response.json();
    },
  });

/**
 * One bill's detail, fetched when its dialog opens.
 *
 * `enabled: false` until there is an id, so opening the list never fires a read for a bill nobody
 * has asked about.
 */
export const invoiceDetailQueryOptions = (invoiceId: string | null) =>
  queryOptions({
    queryKey: invoiceKeys.detail(invoiceId ?? ""),
    staleTime: 0,
    enabled: invoiceId !== null,
    queryFn: async (): Promise<BillingInvoiceDetail> => {
      return client(
        `/api/billing/invoices/${encodeURIComponent(invoiceId ?? "")}`,
        "invoice",
        { fallbackKey: "billing.loadBill" },
      );
    },
  });
