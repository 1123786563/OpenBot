import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

/**
 * The purchase seam as the browser sees it, mirroring the server's payment surface exactly —
 * OrderView and catalog spell their fields the way the server's `toView` does: times ISO-8601
 * strings, amounts integer cents, the QR payload present only while an order is still pending.
 * A field added server-side shows up here as a typecheck question rather than a runtime surprise.
 */

/** One configured channel, as the wire spells it. */
export type PurchaseProvider = "alipay" | "wechat";

/** What an order's money state is. `blocked` is terminal: an amount the channel disagreed on. */
export type PurchaseStatus =
  | "pending"
  | "paid"
  | "blocked"
  | "canceled"
  | "expired";

/** Whether a paid order's plan has reached Lago — progress orthogonal to the money state. */
export type PurchaseActivationState = "pending" | "applied" | "failed";

/**
 * The delivery progress a paid order shows (BP07/#375, mirrors the server's
 * `PaymentFulfillmentState`): 「已付款，权益处理中」 while the sweep converges, `delivered` when
 * the subscription AND the period's grant both landed, `needs_resolution` for the deterministic
 * conflicts an operator owns. Null unless money landed — no money, no delivery to report.
 */
export type PurchaseFulfillmentState =
  | "processing"
  | "delivered"
  | "needs_resolution";

/** What a checkout renders. v1 ships QR codes only; `redirect` is named for a future wap flow. */
export type PurchaseCheckout =
  | { kind: "qrcode"; payload: string }
  | { kind: "redirect"; url: string };

/** One order, as the HTTP surface spells it. */
export type PurchaseOrderView = {
  orderId: string;
  planCode: string;
  provider: PurchaseProvider;
  amountCents: number;
  currency: string;
  status: PurchaseStatus;
  activationState: PurchaseActivationState;
  /** The user-facing delivery progress — null unless money landed. */
  fulfillmentState: PurchaseFulfillmentState | null;
  checkout: PurchaseCheckout | null;
  /** When the QR code stops being payable. */
  expiresAt: string;
  /** The period the paid order buys, when known. */
  periodEnd: string | null;
  createdAt: string;
};

/** One catalog price, as the HTTP surface spells it. */
export type PurchasePlanEntry = {
  planCode: string;
  amountCents: number;
  currency: "CNY";
  periodMonths: number;
};

/** What the catalog endpoint answers: the prices plus who may buy and what is running. */
export type PurchaseCatalog = {
  plans: PurchasePlanEntry[];
  canPurchase: boolean;
  activePlanCode: string | null;
  /**
   * The channels this deployment configured. The only source the page renders its channel
   * chooser from — a single-channel deployment shows one row, and a purchase never names a
   * channel the server would refuse.
   */
  providers: PurchaseProvider[];
  /**
   * The billing cycles a purchase may name — v1 answers the monthly spellings only. The
   * dialog renders its cycle choice from this list (a cycle the server does not offer is not
   * shown, so a reader cannot select something the checkout would refuse); yearly widens this
   * list when the provider can activate it.
   */
  cycles: PurchaseCycle[];
};

/** One purchasable billing cycle. The server's v1 set; not the display catalog's wider set. */
export type PurchaseCycle = "monthly" | "recurring_monthly";

/** A purchase request: one plan, one configured channel, one offered cycle. */
export type CreatePurchaseInput = {
  planCode: string;
  provider: PurchaseProvider;
  cycle: PurchaseCycle;
};

export const purchaseKeys = {
  catalog: ["billing", "purchases", "catalog"] as const,
  current: ["billing", "purchases", "current"] as const,
  order: (orderId: string) => ["billing", "purchases", orderId] as const,
};

/**
 * A deployment without payment channels answers every purchase endpoint with a plain 404 — the
 * surface does not exist there, which is a fact about the deployment rather than a failure. The
 * page reads this to show "not enabled" instead of an error.
 */
export class PaymentsUnavailableError extends Error {
  constructor() {
    super("Purchases are not available on this deployment.");
    this.name = "PaymentsUnavailableError";
  }
}

/** The catalog: prices plus whether this caller may buy and what plan is already running. */
export const purchaseCatalogQueryOptions = queryOptions({
  queryKey: purchaseKeys.catalog,
  staleTime: 15_000,
  queryFn: async (): Promise<PurchaseCatalog> => {
    const response = await tryClient("/api/billing/purchases/catalog");
    if (response.status === 404) throw new PaymentsUnavailableError();
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(body.error ?? "The plan catalog could not be loaded.");
    }
    return response.json();
  },
});

/** The most recent order that is still pending or paid, if any. */
export const currentPurchaseQueryOptions = queryOptions({
  queryKey: purchaseKeys.current,
  staleTime: 0,
  queryFn: async (): Promise<{ order: PurchaseOrderView | null }> => {
    const response = await client("/api/billing/purchases/current", {
      fallbackKey: "billing.loadLatestPurchase",
    });
    return response.json();
  },
});

/**
 * One order by id. This is the poll endpoint: a pending order's payment is confirmed server-side
 * as a side effect of the read (a channel query as a fallback for a missed callback), so it is
 * always fetched fresh and re-fetched on an interval the page controls.
 */
export const purchaseOrderQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: purchaseKeys.order(orderId),
    staleTime: 0,
    queryFn: async (): Promise<{ order: PurchaseOrderView }> => {
      const response = await client(`/api/billing/purchases/${orderId}`, {
        fallbackKey: "billing.loadPurchase",
      });
      return response.json();
    },
  });

/**
 * Why creating a purchase was refused. The status is what the server graded the refusal with;
 * `activePlanCode` rides the one-subscription refusal and `pendingPlanCode` the one-pending-order
 * one — the two 409s a reader can actually meet. The page treats them as "your catalog answer is
 * now stale" and as "say it in the reader's language" respectively, which is why both codes
 * travel on the error rather than in its message.
 */
export class PurchaseRequestError extends Error {
  readonly status: number;
  readonly activePlanCode: string | null;
  readonly pendingPlanCode: string | null;

  constructor(
    status: number,
    activePlanCode: string | null,
    pendingPlanCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = "PurchaseRequestError";
    this.status = status;
    this.activePlanCode = activePlanCode;
    this.pendingPlanCode = pendingPlanCode;
  }
}

/** Create a purchase order: price-snapshotted, replayed when one is already open. */
export async function createPurchase(
  input: CreatePurchaseInput,
): Promise<PurchaseOrderView> {
  const response = await tryClient("/api/billing/purchases", {
    method: "POST",
    body: input,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      activePlanCode?: string;
      pendingPlanCode?: string;
    };
    throw new PurchaseRequestError(
      response.status,
      body.activePlanCode ?? null,
      body.pendingPlanCode ?? null,
      body.error ?? "That purchase could not be started.",
    );
  }
  const body = (await response.json()) as { order: PurchaseOrderView };
  return body.order;
}

/** Cancel a pending order. Cancelling an already-cancelled order is a no-op success. */
export async function cancelPurchase(
  orderId: string,
): Promise<PurchaseOrderView> {
  const response = await tryClient(`/api/billing/purchases/${orderId}/cancel`, {
    method: "POST",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new PurchaseRequestError(
      response.status,
      null,
      null,
      body.error ?? "That purchase could not be cancelled.",
    );
  }
  const body = (await response.json()) as { order: PurchaseOrderView };
  return body.order;
}
