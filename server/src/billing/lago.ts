/**
 * The one file that speaks the billing provider's language.
 *
 * Every provider word in this server — the API paths, the wire field names, the four subscription
 * states as they are spelled on the wire — is in this file and nowhere else. What leaves it are the
 * provider-neutral types from ./types plus results shaped `{ status, body }`, so the service above
 * never learns a field name that would have to be renamed when a second provider arrives. (The
 * delivery lane keeps its transports the same way.)
 *
 * The HTTP surface is deliberately thin: native `fetch` (injectable, so a test never opens a
 * socket), `redirect: "error"` (a provider that answers with a redirect is refused rather than
 * followed anywhere), `AbortSignal.timeout` (a hung provider must not hang us), and a hard
 * 1 MiB read cap (a provider that answers with gigabytes is not read into memory). Transport
 * failures, timeouts, redirects, 429 and 5xx all become the retryable `unreachable` sentinel; a
 * 4xx that is not one of the two statuses a caller is written to understand becomes the terminal
 * `invalid_response`; 422 is passed through untouched, because "create said no" is a race the
 * service resolves by re-reading, not an error this layer can classify.
 *
 * The provider's public key is deliberately NOT fetched here: a runtime fetch of the trust root
 * would let a hijacked API URL hand us the key that verifies its own forgeries. It comes from the
 * deployment environment, one layer up.
 */
import { BillingError, type BillingSubscriptionStatus } from "./types";

/** What the webhook inbox calls this provider. */
export const LAGO_PROVIDER_ID = "lago";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type LagoClientConfig = {
  baseUrl: string;
  apiKey: string;
  /** Test seam; production uses the runtime's global fetch. */
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  /**
   * The SSRF gate, run against every request URL immediately before it is opened. Required, not
   * optional: an assembly that forgets it is a type error, not a client that silently bypasses the
   * outbound policy. Built from ./outbound `createOutboundGuard` (which resolves the hostname and
   * refuses loopback, private, link-local, reserved and metadata destinations); injectable so a
   * test never resolves a name.
   */
  assertTarget: (url: URL) => Promise<void>;
};

export type LagoCustomerBody = { externalId: string; name: string | null };
export type LagoSubscriptionBody = {
  externalCustomerId: string;
  externalSubscriptionId: string;
  planCode: string;
  status: BillingSubscriptionStatus;
};

export type LagoUsageChargeBody = {
  metricCode: string;
  metricName: string;
  /** The wire sends units as a string decimal; it stays a string so precision survives the trip. */
  units: string;
  amountCents: number;
};

export type LagoUsageBody = {
  fromDatetime?: string;
  toDatetime?: string;
  currency?: string;
  amountCents: number;
  totalAmountCents: number;
  charges: readonly LagoUsageChargeBody[];
};

/** One metered usage event, in the provider's own wire words. */
export type LagoEventBody = {
  /** Idempotency: the same transaction id twice is stored once. Derived, never random. */
  transactionId: string;
  /** The billable metric's code as the provider knows it. */
  code: string;
  /**
   * When the usage happened, as Unix seconds. The provider's v1.53 validator documents ISO-8601
   * but answers invalid_format to every ISO spelling we tried (millisecond and whole-second);
   * integer seconds are the shape its own frontend sends and the only one it accepts.
   */
  timestamp: number;
  externalSubscriptionId: string;
  properties: Record<string, number | string>;
};

export type LagoResult<T> = { status: number; body: T | null };

export type LagoClient = {
  /** 200 is the customer; 404 is "absent", which is a fact the service acts on, not an error. */
  getCustomer(
    externalCustomerId: string,
  ): Promise<LagoResult<LagoCustomerBody>>;
  /** 200/201 is created; 422 is passed through for the service's re-read verdict. */
  postCustomer(input: {
    externalId: string;
    name: string;
  }): Promise<LagoResult<LagoCustomerBody>>;
  /** The four states the service asks about, wire-filtered; the response shape is neutralised. */
  listSubscriptions(
    externalCustomerId: string,
  ): Promise<LagoResult<readonly LagoSubscriptionBody[]>>;
  postSubscription(input: {
    externalCustomerId: string;
    externalSubscriptionId: string;
    planCode: string;
  }): Promise<LagoResult<LagoSubscriptionBody>>;
  /** 200 is the current period's usage; 404/405 are facts the projections already know, not errors. */
  getUsage(
    externalCustomerId: string,
    externalSubscriptionId: string,
  ): Promise<LagoResult<LagoUsageBody>>;
  /**
   * 200 or 202 is accepted. A rejected create is the deployment's mistake (a metric or
   * subscription it cannot name), so the sentinel is terminal; the caller logs and moves on.
   */
  postEvent(event: LagoEventBody): Promise<LagoResult<null>>;
};

const SUBSCRIPTION_STATUSES: readonly BillingSubscriptionStatus[] = [
  "active",
  "incomplete",
  "canceled",
  "terminated",
];

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BillingError("invalid_response");
  }
  return value as Record<string, unknown>;
}

function fieldOf(body: unknown, name: string): unknown {
  return asObject(body)[name];
}

function stringOf(body: unknown, name: string): string {
  const value = fieldOf(body, name);
  if (typeof value !== "string" || value.length === 0) {
    throw new BillingError("invalid_response");
  }
  return value;
}

function optionalStringOf(body: unknown, name: string): string | null {
  const value = fieldOf(body, name);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function intOf(body: unknown, name: string): number {
  const value = fieldOf(body, name);
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new BillingError("invalid_response");
  }
  return value;
}

function customerOf(body: unknown): LagoCustomerBody {
  return {
    externalId: stringOf(fieldOf(body, "customer"), "external_id"),
    name: optionalStringOf(fieldOf(body, "customer"), "name"),
  };
}

function subscriptionOf(item: unknown): LagoSubscriptionBody {
  const externalCustomerId = stringOf(item, "external_customer_id");
  const planCode = stringOf(item, "plan_code");
  const status = fieldOf(item, "status");
  if (
    typeof status !== "string" ||
    !SUBSCRIPTION_STATUSES.includes(status as never)
  ) {
    throw new BillingError("invalid_response");
  }
  return {
    externalCustomerId,
    // A subscription created without our external id still needs a stable one for the receipt.
    externalSubscriptionId:
      optionalStringOf(item, "external_id") ?? stringOf(item, "lago_id"),
    planCode,
    status: status as BillingSubscriptionStatus,
  };
}

/**
 * How live a subscription state is, for folding the provider's lifecycle history.
 *
 * The provider keeps one record per subscription lifecycle, so a terminate-and-resubscribe under
 * the same external id answers the list with an `active` record AND the `terminated` one it
 * replaced. The external id is this server's identity for the subscription, never the provider's
 * record number, so the live record is the answer and the history is noise.
 */
const STATUS_LIVELINESS: Record<BillingSubscriptionStatus, number> = {
  active: 0,
  incomplete: 1,
  canceled: 2,
  terminated: 3,
};

/** One subscription per external id: the liveliest record the provider still holds. */
function foldSubscriptionHistory(
  subscriptions: readonly LagoSubscriptionBody[],
): LagoSubscriptionBody[] {
  const folded = new Map<string, LagoSubscriptionBody>();
  for (const subscription of subscriptions) {
    const existing = folded.get(subscription.externalSubscriptionId);
    if (
      existing === undefined ||
      STATUS_LIVELINESS[subscription.status] <
        STATUS_LIVELINESS[existing.status]
    ) {
      folded.set(subscription.externalSubscriptionId, subscription);
    }
  }
  return [...folded.values()];
}

/**
 * The usage answer's wire shape (`charges_usage` under `customer_usage`) neutralised: metric
 * vocabulary in, plan-neutral charge rows out.
 */
function usageOf(body: unknown): LagoUsageBody {
  const charges = fieldOf(body, "charges_usage");
  if (!Array.isArray(charges)) {
    throw new BillingError("invalid_response");
  }
  return {
    fromDatetime: optionalStringOf(body, "from_datetime") ?? undefined,
    toDatetime: optionalStringOf(body, "to_datetime") ?? undefined,
    currency: optionalStringOf(body, "currency") ?? undefined,
    amountCents: intOf(body, "amount_cents"),
    totalAmountCents: intOf(body, "total_amount_cents"),
    charges: charges.map(usageChargeOf),
  };
}

function usageChargeOf(item: unknown): LagoUsageChargeBody {
  const metric = asObject(fieldOf(item, "billable_metric"));
  return {
    metricCode: stringOf(metric, "code"),
    metricName: stringOf(metric, "name"),
    units: stringOf(item, "units"),
    amountCents: intOf(item, "amount_cents"),
  };
}

/**
 * Read the response body with a hard cap.
 *
 * A provider that answers with a body larger than 1 MiB is not read: this runs inside a server
 * process, and "read it to see" is how a hostile or broken endpoint becomes a memory problem.
 * `content-length` is checked first and the stream is cut mid-read when it lies.
 */
async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new BillingError("invalid_response");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new BillingError("invalid_response");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export function createLagoClient(config: LagoClientConfig): LagoClient {
  const wire = config.fetch ?? fetch;
  const base = config.baseUrl.replace(/\/+$/, "");
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  async function request(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown } = { method: "GET" },
  ): Promise<{ status: number; body: unknown }> {
    const url = new URL(`${base}${path}`);
    await config.assertTarget(url);

    let response: Response;
    try {
      response = await wire(url, {
        method: init.method,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          accept: "application/json",
          ...(init.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      // Transport errors, timeouts and refused redirects all look the same to the caller: try
      // again later. The original error is dropped, because it can quote the URL and the key.
      throw new BillingError("unreachable");
    }

    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => {});
      throw new BillingError("unreachable");
    }
    if (response.status >= 300 && response.status < 400) {
      // `redirect: "error"` already refuses these in a real fetch; a fetch that returns one
      // anyway gets the same answer, because a redirect is a detour nobody vetted.
      await response.body?.cancel().catch(() => {});
      throw new BillingError("unreachable");
    }

    let text: string;
    try {
      text = await readCapped(response);
    } catch (error) {
      if (error instanceof BillingError) throw error;
      throw new BillingError("unreachable");
    }

    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        // A 2xx must be JSON we asked for; an error status' body is nothing the caller reads.
        if (response.status >= 200 && response.status < 300) {
          throw new BillingError("invalid_response");
        }
      }
    }
    return { status: response.status, body };
  }

  return {
    async getCustomer(externalCustomerId) {
      const result = await request(
        `/api/v1/customers/${encodeURIComponent(externalCustomerId)}`,
      );
      if (result.status === 200) {
        return { status: 200, body: customerOf(result.body) };
      }
      if (result.status === 404) return { status: 404, body: null };
      throw new BillingError("invalid_response");
    },
    async postCustomer(input) {
      const result = await request("/api/v1/customers", {
        method: "POST",
        body: { customer: { external_id: input.externalId, name: input.name } },
      });
      if (result.status === 200 || result.status === 201) {
        return { status: result.status, body: customerOf(result.body) };
      }
      if (result.status === 422) return { status: 422, body: null };
      throw new BillingError("invalid_response");
    },
    async listSubscriptions(externalCustomerId) {
      const params = new URLSearchParams();
      params.set("external_customer_id", externalCustomerId);
      for (const status of SUBSCRIPTION_STATUSES)
        params.append("status[]", status);
      const result = await request(
        `/api/v1/subscriptions?${params.toString()}`,
      );
      if (result.status !== 200) throw new BillingError("invalid_response");
      const subscriptions = fieldOf(result.body, "subscriptions");
      if (!Array.isArray(subscriptions))
        throw new BillingError("invalid_response");
      return {
        status: 200,
        body: foldSubscriptionHistory(subscriptions.map(subscriptionOf)),
      };
    },
    async postSubscription(input) {
      const result = await request("/api/v1/subscriptions", {
        method: "POST",
        // No activation rules: this server wants the plan it named, on the plan's own terms.
        body: {
          subscription: {
            external_customer_id: input.externalCustomerId,
            plan_code: input.planCode,
            external_id: input.externalSubscriptionId,
          },
        },
      });
      if (result.status === 200 || result.status === 201) {
        return {
          status: result.status,
          body: subscriptionOf(fieldOf(result.body, "subscription")),
        };
      }
      if (result.status === 422) return { status: 422, body: null };
      throw new BillingError("invalid_response");
    },
    async getUsage(externalCustomerId, externalSubscriptionId) {
      const params = new URLSearchParams();
      params.set("external_subscription_id", externalSubscriptionId);
      const result = await request(
        `/api/v1/customers/${encodeURIComponent(externalCustomerId)}/current_usage?${params.toString()}`,
      );
      if (result.status === 200) {
        return {
          status: 200,
          body: usageOf(fieldOf(result.body, "customer_usage")),
        };
      }
      // 404 is an unknown customer and 405 the provider's own "no active subscription": both are
      // answers the service reports as no usage, not failures worth a retry.
      if (result.status === 404 || result.status === 405) {
        return { status: result.status, body: null };
      }
      throw new BillingError("invalid_response");
    },
    async postEvent(event) {
      const result = await request("/api/v1/events", {
        method: "POST",
        body: {
          event: {
            transaction_id: event.transactionId,
            code: event.code,
            timestamp: event.timestamp,
            external_subscription_id: event.externalSubscriptionId,
            properties: event.properties,
          },
        },
      });
      // 200 and 202 are both acceptances in the provider's own API; 404/422 name something this
      // deployment sent wrongly (an unknown metric or subscription), which retrying cannot fix.
      if (result.status === 200 || result.status === 202) {
        return { status: result.status, body: null };
      }
      if (result.status === 404 || result.status === 422) {
        return { status: result.status, body: null };
      }
      throw new BillingError("invalid_response");
    },
  };
}
