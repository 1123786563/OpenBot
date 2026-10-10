import { createBillingEntitlementReader } from "./entitlement";
import {
  LAGO_PROVIDER_ID,
  type LagoClient,
  type LagoSubscriptionBody,
} from "./lago";
import {
  type BillingEntitlements,
  BillingError,
  type BillingService,
  type BillingSnapshot,
  type BillingStore,
  type BillingSubscriptionRow,
  type VerifiedWebhook,
  type WebhookVerifier,
} from "./types";

/** The request body a webhook may carry. A bigger one is answered 413, never read whole. */
const MAX_WEBHOOK_BYTES = 1024 * 1024;

/**
 * The external customer ID one deployment is known by at the provider: deterministic, derived from
 * the tenant identity, defined in this one place so the assembly, the sync and any future caller
 * cannot drift apart. (The Go implementation this descends from built `weknora-tenant-<tenantID>`
 * the same way, for the same reason.)
 */
export function deploymentExternalCustomerId(tenantId: string): string {
  return `openbot-deployment-${tenantId}`;
}

/**
 * Read the raw webhook body exactly once, with a hard cap.
 *
 * Same discipline as the client's response read (./lago.ts `readCapped`): the delivery must be
 * verified against the exact bytes that arrived, so the body cannot be re-read or transformed — but
 * it is also unauthenticated input at this point, so it is never buffered beyond 1 MiB.
 * `content-length` is checked first and the stream is cut mid-read when it lies. Over the cap the
 * caller answers 413: the provider retries a bounded delivery, and nobody allocates for an
 * attacker.
 */
async function readBodyCapped(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
    return null;
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
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

/**
 * The sync, the webhook and the entitlement read, arranged.
 *
 * ensureCustomer / ensureSubscription are read-before-create and judge by status code only: a 404
 * means "absent, create it", a create that answers 422 means somebody else created it between the
 * read and the write, which is resolved by reading again — never by a second create. A subscription
 * that exists on a different plan than the one asked for is a terminal conflict, not ours to
 * overwrite.
 *
 * handleWebhook order, fixed deliberately: verify (401) → inbox check (a known event is already
 * fully applied, 200) → fresh read of the authoritative object (a retryable failure answers 5xx
 * with nothing recorded, so the provider retries the whole delivery) → refresh the projections →
 * write the inbox row → 200. An inbox row therefore always means "the work it names is done", which
 * is the one property that keeps a crash mid-delivery from losing an event. (The Go implementation
 * this descends from wrote the inbox before acting, so a delivery that failed afterwards was never
 * retried; that gap is not inherited, and this comment is the record of the divergence.)
 *
 * Events about objects this deployment does not project (invoices, wallets, …) have nothing to
 * refresh, which is also finished work: they are recorded and answered 200.
 *
 * The entitlement read is served from the local projections with a per-customer cache (see
 * ./entitlement.ts) — a webhook keeps the projections fresh, so the cache never has to reach the
 * provider on a read path.
 *
 * reconcile() does not exist yet and says so by refusing, rather than half-working.
 */
export function createBillingService(deps: {
  config: { externalCustomerKey: string; webhookMode: "jwt" | "hmac" | "off" };
  client: LagoClient;
  store: BillingStore;
  /** Absent on a deployment with no webhook key: that deployment mounts no webhook route. */
  verifier?: WebhookVerifier;
  /** Plan code → entitlement codes. Injected so a test (or a future config) can differ. */
  planEntitlements?: ReadonlyMap<string, readonly string[]>;
  ttlMs?: number;
  failureTtlMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}): BillingService {
  const { config, client, store } = deps;

  async function readCustomerIntoStore(externalId: string): Promise<boolean> {
    const result = await client.getCustomer(externalId);
    if (result.status === 200 && result.body) {
      await store.upsertCustomer({
        externalId,
        name: result.body.name,
      });
      return true;
    }
    return false;
  }

  async function readSubscriptions(
    externalCustomerId: string,
  ): Promise<readonly LagoSubscriptionBody[]> {
    const result = await client.listSubscriptions(externalCustomerId);
    if (!result.body) throw new BillingError("invalid_response");
    return result.body;
  }

  async function writeSubscriptionProjections(
    subscriptions: readonly LagoSubscriptionBody[],
  ): Promise<void> {
    for (const subscription of subscriptions) {
      await store.upsertSubscription({
        externalCustomerId: subscription.externalCustomerId,
        externalSubscriptionId: subscription.externalSubscriptionId,
        planCode: subscription.planCode,
        status: subscription.status,
      });
    }
  }

  /**
   * The customer floor under a subscription refresh.
   *
   * The subscription projection's customer column is a foreign key (../db/schema/billing.ts): a
   * subscription row cannot land before the customer row exists. A subscription delivery can be
   * the first thing a deployment ever receives — configured but never synced, its `customer.*`
   * deliveries lost — so the floor is laid here, before any subscription row is written: an
   * authoritative read when the provider still has the customer, and when it answers 404 an
   * insert-if-absent placeholder, which is enough for the rows that follow and never overwrites a
   * projection that already carries the customer's name.
   */
  async function ensureCustomerProjection(externalId: string): Promise<void> {
    if (await readCustomerIntoStore(externalId)) return;
    await store.ensureCustomerRow({ externalId });
  }

  /**
   * What a delivery implies locally, refreshed from the authoritative object rather than from the
   * event payload: a delivery that arrives out of order must not walk a projection backwards.
   */
  async function refreshFor(delivery: VerifiedWebhook): Promise<void> {
    if (delivery.webhookType.startsWith("customer.")) {
      if (!delivery.externalCustomerId)
        throw new BillingError("invalid_response");
      // A 404 leaves the projection alone: the object is gone remotely, and the subscription
      // projections say what that means for entitlements. The delivery itself is done.
      await readCustomerIntoStore(delivery.externalCustomerId);
      return;
    }
    if (delivery.webhookType.startsWith("subscription.")) {
      if (!delivery.externalCustomerId)
        throw new BillingError("invalid_response");
      await ensureCustomerProjection(delivery.externalCustomerId);
      await writeSubscriptionProjections(
        await readSubscriptions(delivery.externalCustomerId),
      );
      return;
    }
    // Every other type names an object this deployment does not project. Nothing to refresh is
    // not a failure: the inbox row below records it as processed.
  }

  const reader = createBillingEntitlementReader({
    read: async (externalCustomerId): Promise<BillingEntitlements> => {
      const key = externalCustomerId ?? config.externalCustomerKey;
      const rows: readonly BillingSubscriptionRow[] =
        await store.readSubscriptions(key);
      const active = rows.find((row) => row.status === "active");
      if (!active) return { active: false, codes: [] };
      return {
        active: true,
        planCode: active.planCode,
        codes: deps.planEntitlements?.get(active.planCode) ?? [],
      };
    },
    ...(deps.ttlMs !== undefined ? { ttlMs: deps.ttlMs } : {}),
    ...(deps.failureTtlMs !== undefined
      ? { failureTtlMs: deps.failureTtlMs }
      : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });

  function json(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  return {
    async ensureCustomer(input) {
      if (await readCustomerIntoStore(input.externalId)) {
        return { externalId: input.externalId };
      }
      const created = await client.postCustomer(input);
      if (created.status === 422) {
        // Lost a race: it exists now. A re-read that still says absent is a provider that
        // refused the create and cannot explain itself — terminal, not retried into more POSTs.
        if (await readCustomerIntoStore(input.externalId)) {
          return { externalId: input.externalId };
        }
        throw new BillingError("invalid_response");
      }
      await store.upsertCustomer({
        externalId: input.externalId,
        name: created.body?.name ?? input.name,
      });
      return { externalId: input.externalId };
    },

    async ensureSubscription(input) {
      const existing = await readSubscriptions(input.externalCustomerId);
      const onThisPlan = existing.find(
        (subscription) => subscription.planCode === input.planCode,
      );
      if (onThisPlan) {
        await writeSubscriptionProjections(existing);
        return {
          externalCustomerId: input.externalCustomerId,
          externalSubscriptionId: onThisPlan.externalSubscriptionId,
          planCode: input.planCode,
        };
      }
      if (existing.length > 0) {
        // Somebody's subscription on another plan. Overwriting it is not a decision this
        // deployment gets to make from a sync call.
        throw new BillingError("invalid_response");
      }

      const created = await client.postSubscription(input);
      if (created.status === 422) {
        const reread = await readSubscriptions(input.externalCustomerId);
        const again = reread.find(
          (subscription) => subscription.planCode === input.planCode,
        );
        if (again) {
          await writeSubscriptionProjections(reread);
          return {
            externalCustomerId: input.externalCustomerId,
            externalSubscriptionId: again.externalSubscriptionId,
            planCode: input.planCode,
          };
        }
        // A different plan after the refusal is the conflict above; an empty list after a
        // refusal is a provider that cannot be argued with. Both terminal, neither retried.
        throw new BillingError("invalid_response");
      }
      await store.upsertSubscription({
        externalCustomerId: input.externalCustomerId,
        externalSubscriptionId:
          created.body?.externalSubscriptionId ?? input.externalSubscriptionId,
        planCode: input.planCode,
        status: created.body?.status ?? "active",
      });
      return {
        externalCustomerId: input.externalCustomerId,
        externalSubscriptionId:
          created.body?.externalSubscriptionId ?? input.externalSubscriptionId,
        planCode: input.planCode,
      };
    },

    async handleWebhook(request) {
      // Defensive: an assembly with no webhook key builds this service without a verifier and
      // mounts no webhook route, so nothing should reach here. Answer as unavailable, never as ok.
      if (!deps.verifier) {
        return json(503, { error: "Billing webhooks are not configured." });
      }
      const rawBody = await readBodyCapped(request);
      if (rawBody === null) {
        // Read exactly once, capped: an oversized delivery is refused before it is verified or
        // buffered, and the body is never re-read for a second attempt.
        return json(413, {
          error: "Billing webhook body exceeds the size limit.",
        });
      }
      const verified = await deps.verifier.verify(request.headers, rawBody);
      if (!verified.ok) {
        return json(401, { error: "Invalid billing webhook signature." });
      }
      const delivery = verified.delivery;

      if (await store.hasWebhookEvent(LAGO_PROVIDER_ID, delivery.eventId)) {
        // Already fully applied; the inbox row is the proof, and no re-read happens.
        return json(200, { status: "duplicate" });
      }

      try {
        await refreshFor(delivery);
      } catch (error) {
        if (error instanceof BillingError && error.retryable) {
          // Nothing recorded: the provider retries the whole delivery, re-read included.
          return json(503, { error: "Billing webhook could not be applied." });
        }
        return json(400, { error: "Billing webhook could not be applied." });
      }

      const inserted = await store.recordWebhookEvent({
        provider: LAGO_PROVIDER_ID,
        eventId: delivery.eventId,
        uniqueKey: request.headers.get("x-lago-unique-key") ?? undefined,
        webhookType: delivery.webhookType,
        ...(delivery.objectId ? { objectId: delivery.objectId } : {}),
      });
      return json(200, { status: inserted ? "processed" : "duplicate" });
    },

    entitlements(externalCustomerId) {
      return reader.active(externalCustomerId);
    },

    /**
     * Uncached on purpose: the entitlements reader answers a stable fact through a TTL, while
     * usage moves with every event the provider accepts, so a settings page wants it fresh.
     * No plan vocabulary either, for the same reason as the entitlements answer.
     */
    async usage(externalCustomerId) {
      const key = externalCustomerId ?? config.externalCustomerKey;
      const rows = await store.readSubscriptions(key);
      const active = rows.find((row) => row.status === "active");
      if (!active) return null;
      const usage = await client.getUsage(key, active.externalSubscriptionId);
      return {
        fromDatetime: usage.body?.fromDatetime,
        toDatetime: usage.body?.toDatetime,
        currency: usage.body?.currency,
        amountCents: usage.body?.amountCents,
        totalAmountCents: usage.body?.totalAmountCents,
        charges: usage.body?.charges ?? [],
      };
    },

    /**
     * Meter one event against the active subscription, without blocking the caller.
     *
     * The provider's transaction id deduplicates, so a crashed run reporting twice costs nothing;
     * every failure below is a logged sentence, never a throw — usage that cannot be metered is a
     * billing miss, not a product error, and a throw here would fail the very run that produced it.
     * No plan vocabulary and no per-call configuration: the metric code is the caller's own word,
     * which is also the provider's because the deployment registered it there on purpose.
     */
    async recordUsage(input) {
      const key = input.externalCustomerId ?? config.externalCustomerKey;
      try {
        const rows = await store.readSubscriptions(key);
        const active = rows.find((row) => row.status === "active");
        if (!active) {
          console.warn(
            `billing: usage for ${input.metricCode} dropped — no active subscription for this deployment`,
          );
          return;
        }
        const result = await client.postEvent({
          transactionId: input.transactionId,
          code: input.metricCode,
          // Unix seconds: the provider's v1.53 event validator refuses every ISO-8601 spelling
          // (invalid_format), so the wire carries the integer its own frontend sends.
          timestamp: Math.floor(
            (input.timestamp ?? new Date()).getTime() / 1000,
          ),
          externalSubscriptionId: active.externalSubscriptionId,
          properties: input.properties,
        });
        if (result.status === 404 || result.status === 422) {
          console.warn(
            `billing: usage for ${input.metricCode} refused by the provider (status ${result.status}) — check the metric and the subscription exist there`,
          );
        }
      } catch (error) {
        console.warn(
          `billing: usage for ${input.metricCode} could not be reported — ${
            error instanceof BillingError ? error.code : "unexpected error"
          }`,
        );
      }
    },

    async snapshot(): Promise<BillingSnapshot> {
      const { customers, subscriptions, lastSyncedAt } = await store.snapshot();
      return {
        configured: true,
        customers,
        subscriptions,
        ...(lastSyncedAt ? { lastSyncedAt: lastSyncedAt.toISOString() } : {}),
        webhookMode: config.webhookMode,
      };
    },

    async reconcile(): Promise<never> {
      throw new BillingError("unsupported");
    },
  };
}
