import { createBillingEntitlementReader } from "./entitlement";
import {
  LAGO_PROVIDER_ID,
  type LagoClient,
  type LagoSubscriptionBody,
} from "./lago";
import { payerKey } from "./payer";
import { readBodyCapped } from "./raw-body";
import type { ReconcileReport } from "./types";
import {
  type BillingEntitlementEntry,
  type BillingEntitlementSubscriptionContext,
  type BillingEntitlements,
  BillingError,
  BillingPersistenceError,
  type BillingService,
  type BillingSnapshot,
  type BillingStore,
  type BillingSubscriptionRow,
  type BillingUsageDaily,
  type BillingUsageDailyBucket,
  type BillingUsageEventPage,
  type BillingWebhookProjection,
  type OwnedSubscriptionRow,
  type SubscriptionRenewalGrantor,
  type VerifiedWebhook,
  type WebhookVerifier,
} from "./types";
import { UsageDeliveryError } from "./usage-delivery-error";

/** The daily aggregation's read window: per page, the ceiling, and how long an answer is reused. */
const DAILY_PAGE_SIZE = 100;
const DAILY_MAX_PAGES = 50;
const DAILY_TTL_MS = 60_000;

/** The server-local `yyyy-mm-dd` an event's stamp lands on, which is how days are bucketed. */
const dayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Read one property as a finite number; absent or non-numeric stays undefined. */
function numberOf(
  properties: Record<string, number | string>,
  name: string,
): number | undefined {
  const value = properties[name];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

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
 * The sync, the webhook and the entitlement read, arranged.
 *
 * ensureCustomer / ensureSubscription are read-before-create and judge by status code only: a 404
 * means "absent, create it", a create that answers 422 means somebody else created it between the
 * read and the write, which is resolved by reading again — never by a second create. A subscription
 * that exists on a different plan than the one asked for is a terminal conflict, not ours to
 * overwrite.
 *
 * handleWebhook order, fixed deliberately: verify (401) → inbox check (a known event is already
 * fully applied, 200) → fresh read of the authoritative object → atomically commit the local
 * projections and inbox row → 200. Provider reads stay outside the SQL transaction.
 * Retryable provider failures and retryable persistence failures answer 503; a non-retryable
 * persistence failure — our own data, a constraint violation or a value too long — answers 500.
 * Both are ours and both are 5xx, so the provider retries the whole delivery and a manual fix
 * later still converges. A 4xx is reserved for a delivery we verified and then could not make
 * sense of; our own storage is never the provider's fault. An inbox row therefore always means
 * "the work it names is done", which is the one property that keeps a crash mid-delivery from
 * losing an event. (The Go implementation this descends from wrote the inbox before acting, so a
 * delivery that failed afterwards was never retried; that gap is not inherited, and this comment
 * is the record of the divergence.)
 *
 * Events about objects this deployment does not project (invoices, wallets, …) have nothing to
 * refresh, which is also finished work: they are recorded and answered 200.
 *
 * The entitlement read is served from the local projections with a per-customer cache (see
 * ./entitlement.ts) — a webhook keeps the projections fresh, and the one provider call the read
 * itself adds (the subscription's current period, answered null when the provider refuses it) rides
 * behind the same TTL.
 *
 * reconcile() does not exist yet and says so by refusing, rather than half-working.
 */
export function createBillingService(deps: {
  config: { externalCustomerKey: string; webhookMode: "jwt" | "hmac" | "off" };
  client: LagoClient;
  store: BillingStore;
  /** Absent on a deployment with no webhook key: that deployment mounts no webhook route. */
  verifier?: WebhookVerifier;
  /** Plan code → the entitlement entries that plan grants. Injected so a test (or a future config) can differ. */
  planEntitlements?: ReadonlyMap<string, readonly BillingEntitlementEntry[]>;
  /**
   * The reconciliation pass, injected (see reconcile()'s comment): the skeleton audits the
   * very collaborators this service holds, so the reader is assembled outside — over the
   * database, not the deps — and handed in. Absent keeps the honest refusal.
   */
  reconciler?: { reconcile(): Promise<ReconcileReport> };
  /**
   * The renewal payout (10.3): pays a subscription period's allowance into the owner's
   * account. Absent keeps renewal a no-op (a deployment that wires no plan catalog has no
   * allowance to renew, and the pass never guesses one).
   */
  renewals?: SubscriptionRenewalGrantor;
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

  /**
   * The provider list is requested for four statuses (`active`, `incomplete`, `canceled`,
   * `terminated`); a subscription in Lago's `pending` state is therefore invisible to the sync and to
   * the purchase guard. Adding it needs a `billing_subscriptions_status_check` migration and a
   * `BillingSubscriptionStatus` widening, and is deliberately not part of this change.
   */
  async function readSubscriptions(
    externalCustomerId: string,
  ): Promise<readonly LagoSubscriptionBody[]> {
    const result = await client.listSubscriptions(externalCustomerId);
    if (!result.body) throw new BillingError("invalid_response");
    return result.body;
  }

  /**
   * Fold one provider list into the projections: upsert every row it names, then retire the
   * customer's rows it does not. The list the provider just returned is the whole truth about
   * what it holds, so a local row it does not name is stale — and a stale `active` row is an
   * entitlement that never ends and a purchase guard that never opens (audit B6). Retire rather
   * than delete: the row stays as the record, and a later delivery can move it back.
   *
   * The one retirement rule: the scope is the explicit customer the list was read for, never
   * customers derived from the list itself. The read is per customer
   * (`listSubscriptions(externalCustomerId)`), so every row in the list belongs to that customer
   * and the derived grouping could only ever rediscover it — while an EMPTY list, the answer
   * that must retire the customer's every row (the provider deleted the only subscription),
   * names no customer of its own. An empty list reaching here is a real answer, not a failed
   * read: `readSubscriptions` throws on a malformed or absent body.
   */
  async function writeSubscriptionProjections(
    subscriptions: readonly LagoSubscriptionBody[],
    externalCustomerId: string,
  ): Promise<void> {
    for (const subscription of subscriptions) {
      await store.upsertSubscription({
        externalCustomerId: subscription.externalCustomerId,
        externalSubscriptionId: subscription.externalSubscriptionId,
        planCode: subscription.planCode,
        status: subscription.status,
      });
    }
    const retired = await store.retireAbsentSubscriptions(
      externalCustomerId,
      subscriptions.map((subscription) => subscription.externalSubscriptionId),
    );
    if (retired > 0) {
      (deps.log ?? console.warn)(
        `billing: retired ${retired} subscription projection(s) the provider no longer lists for ${externalCustomerId}`,
      );
    }
  }

  /**
   * What a delivery implies locally, refreshed from the authoritative object rather than from the
   * event payload: a delivery that arrives out of order must not walk a projection backwards.
   *
   * A `subscription.*` delivery also returns the provider list it just read (with the periods the
   * wire spelled): the renewal pass (10.3) runs against those bodies once the projection apply
   * has committed — a renewal is detected from the provider's own period, never from the
   * delivery's bytes.
   */
  async function readProjectionFor(delivery: VerifiedWebhook): Promise<{
    projection: Omit<BillingWebhookProjection, "event">;
    subscriptionReads?: readonly LagoSubscriptionBody[];
  }> {
    if (delivery.webhookType.startsWith("customer.")) {
      if (!delivery.externalCustomerId)
        throw new BillingError("invalid_response");
      // A 404 leaves the projection alone: the object is gone remotely, and the subscription
      // projections say what that means for entitlements. The delivery itself is done.
      const result = await client.getCustomer(delivery.externalCustomerId);
      return {
        projection:
          result.status === 200 && result.body
            ? {
                customer: {
                  externalId: delivery.externalCustomerId,
                  name: result.body.name,
                },
              }
            : {},
      };
    }
    if (delivery.webhookType.startsWith("subscription.")) {
      if (!delivery.externalCustomerId)
        throw new BillingError("invalid_response");
      const result = await client.getCustomer(delivery.externalCustomerId);
      const subscriptions = await readSubscriptions(
        delivery.externalCustomerId,
      );
      return {
        projection: {
          // A 404 stages an insert-only floor; it never clears an existing customer's name.
          customer: {
            externalId: delivery.externalCustomerId,
            ...(result.status === 200 && result.body
              ? { name: result.body.name }
              : {}),
          },
          subscriptions: subscriptions.map((subscription) => ({
            externalCustomerId: subscription.externalCustomerId,
            externalSubscriptionId: subscription.externalSubscriptionId,
            planCode: subscription.planCode,
            status: subscription.status,
          })),
          // The scope the apply retires absent rows under: this delivery's customer, the one an
          // empty list would otherwise leave unnamed.
          subscriptionsPresentFor: delivery.externalCustomerId,
        },
        subscriptionReads: subscriptions,
      };
    }
    // Every other type names an object this deployment does not project. Nothing to refresh is
    // not a failure: the inbox row below records it as processed.
    return { projection: {} };
  }

  /**
   * Cover one period of one owned subscription (10.3): the renewal allowance lands in the
   * OWNER's account — derived from the row's own pair via `payerKey`, never from a delivery —
   * and the marker advances only once the grant is recorded (or rightly absent). The ledger
   * key `plan-renewal:<id>:<periodStart>` is the fence that makes a duplicate or racing
   * delivery of the same period a no-op; the forward-only marker makes the fast path agree.
   * Answers what happened, for the log; every failure leaves the period uncovered so the next
   * delivery or sweep retries it.
   */
  async function coverPeriod(
    row: OwnedSubscriptionRow,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<"granted" | "covered" | "skipped"> {
    const renewals = deps.renewals;
    if (!renewals) return "skipped";
    const log_ = deps.log ?? (() => {});
    // The marker is the fast "already covered" answer; a row already at — or past — this
    // period has had its payout (the ledger key would refuse a second one anyway).
    if (
      row.allowancePeriodStart &&
      row.allowancePeriodStart.getTime() >= periodStart.getTime()
    ) {
      return "covered";
    }
    // The account is the subscription's own owner pair. An ownerless row pays nobody (Q23:
    // no guessed attribution), and the quarantined kind is refused by the key derivation
    // itself — both leave the period uncovered and visible in the log.
    if (!row.ownerPayerKind || !row.ownerPayerId) {
      log_(
        `billing: renewal skipped for ${row.externalSubscriptionId} — the row carries no owner (Q23); the period stays uncovered`,
      );
      return "skipped";
    }
    let accountKey: string;
    try {
      accountKey = payerKey({ kind: row.ownerPayerKind, id: row.ownerPayerId });
    } catch {
      log_(
        `billing: renewal skipped for ${row.externalSubscriptionId} — the owner pair resolves to no billable account`,
      );
      return "skipped";
    }
    const totalCents = renewals.creditsFor(row.planCode);
    if (totalCents === null || totalCents <= 0) {
      // A plan with no credit component has no allowance to renew: the period is handled —
      // advance the marker so the detection does not re-run on every delivery.
      await store.advanceSubscriptionAllowance({
        externalSubscriptionId: row.externalSubscriptionId,
        allowancePeriodStart: periodStart,
        allowancePeriodEnd: periodEnd,
      });
      return "covered";
    }
    try {
      await renewals.grantRenewal({
        externalCustomerId: accountKey,
        planCode: row.planCode,
        externalSubscriptionId: row.externalSubscriptionId,
        periodStart,
        periodEnd,
        totalCents,
      });
    } catch (error) {
      log_(
        `billing: renewal grant failed for ${row.externalSubscriptionId} period ${periodStart.toISOString()} — name=${error instanceof Error ? error.name : "unknown"}; the period stays uncovered and retries`,
      );
      return "skipped";
    }
    // The marker moves only after the grant is recorded: a crash between the two leaves the
    // period uncovered, and the next delivery or sweep re-runs the idempotent grant.
    await store.advanceSubscriptionAllowance({
      externalSubscriptionId: row.externalSubscriptionId,
      allowancePeriodStart: periodStart,
      allowancePeriodEnd: periodEnd,
    });
    return "granted";
  }

  /**
   * The renewal pass over one fresh provider list (the delivery path): every LIVE subscription
   * in the list whose stored row carries an owner gets its uncovered period covered. Runs
   * after the projection apply committed, best-effort: the delivery's own work stands, and a
   * failed pass is the sweep's next tick's work, not a failed delivery.
   */
  async function applyRenewals(
    subscriptions: readonly LagoSubscriptionBody[],
  ): Promise<void> {
    if (!deps.renewals || subscriptions.length === 0) return;
    for (const subscription of subscriptions) {
      if (
        subscription.status !== "active" &&
        subscription.status !== "incomplete"
      ) {
        continue;
      }
      if (!subscription.currentPeriodStart || !subscription.currentPeriodEnd)
        continue;
      const periodStart = new Date(subscription.currentPeriodStart);
      const periodEnd = new Date(subscription.currentPeriodEnd);
      if (
        Number.isNaN(periodStart.getTime()) ||
        Number.isNaN(periodEnd.getTime())
      ) {
        continue;
      }
      const rows = await store.readLiveOwnedSubscriptions(
        subscription.externalCustomerId,
      );
      const row = rows.find(
        (candidate) =>
          candidate.externalSubscriptionId ===
          subscription.externalSubscriptionId,
      );
      if (!row) continue;
      try {
        await coverPeriod(row, periodStart, periodEnd);
      } catch (error) {
        (deps.log ?? console.warn)(
          `billing: renewal pass failed for ${row.externalSubscriptionId} — name=${error instanceof Error ? error.name : "unknown"}; the sweep retries`,
        );
      }
    }
  }

  const reader = createBillingEntitlementReader({
    read: async (externalCustomerId): Promise<BillingEntitlements> => {
      const key = externalCustomerId ?? config.externalCustomerKey;
      const rows: readonly BillingSubscriptionRow[] =
        await store.readSubscriptions(key);
      const active = rows.find((row) => row.status === "active");
      if (!active) return { active: false, codes: [], subscription: null };
      // The subscription read is a courtesy beside the projection: a provider that refuses it
      // must not fail the entitlement read, whose answer gates the deployment.
      let subscription: BillingEntitlementSubscriptionContext | null = null;
      try {
        const remote = await client.getSubscription(
          active.externalSubscriptionId,
        );
        if (remote.body) {
          subscription = {
            status: remote.body.status,
            currentPeriodStart: remote.body.currentPeriodStart ?? null,
            currentPeriodEnd: remote.body.currentPeriodEnd ?? null,
          };
        }
      } catch {
        subscription = null;
      }
      return {
        active: true,
        planCode: active.planCode,
        codes: deps.planEntitlements?.get(active.planCode) ?? [],
        subscription,
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

  // One aggregation is up to fifty paged provider reads, so it answers from this cache for a
  // short window instead of paying that on every page load. Keyed by customer like the
  // entitlement reader, and small by construction: a deployment serves one customer key.
  const dailyCache = new Map<
    string,
    { value: BillingUsageDaily; expiresAt: number }
  >();

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
      // The fold runs immediately, before any branch decision below: whatever the branches then
      // decide, the projections already hold the provider's newest truth — and a customer whose
      // only subscription the provider deleted (an empty list, live.length 0 below) has the
      // stale row retired even though the branch that follows would only create a new one, which
      // is the B6 headline on a deployment with no webhooks mounted. Folding is a projection
      // write, never a decision to subscribe; it does not soften the conflicts below.
      await writeSubscriptionProjections(existing, input.externalCustomerId);
      // Only a LIVE subscription counts anywhere below — active, or incomplete (created, not yet
      // started). The provider keeps one record per subscription lifecycle, so after a terminate
      // and re-buy the list answers with the terminated record AND its active replacement: a
      // status-blind match here returns the dead record, reports success, and the payer's money
      // buys nothing — the exact failure a live sandbox re-purchase exposed.
      const live = existing.filter(
        (subscription) =>
          subscription.status === "active" ||
          subscription.status === "incomplete",
      );
      const onThisPlan = live.find(
        (subscription) => subscription.planCode === input.planCode,
      );
      if (onThisPlan) {
        return {
          externalCustomerId: input.externalCustomerId,
          externalSubscriptionId: onThisPlan.externalSubscriptionId,
          planCode: input.planCode,
          currentPeriodStart: onThisPlan.currentPeriodStart ?? null,
          currentPeriodEnd: onThisPlan.currentPeriodEnd ?? null,
        };
      }
      if (live.length > 0) {
        // Somebody's LIVE subscription on another plan. Overwriting it is not a decision this
        // deployment gets to make from a sync call. Terminal records bar nobody: a cancelled or
        // expired plan is history, not an entitlement.
        throw new BillingError("invalid_response");
      }

      const created = await client.postSubscription(input);
      if (created.status === 422) {
        const reread = await readSubscriptions(input.externalCustomerId);
        // Same rule as the first read: the newest list is folded before the branch reads it.
        await writeSubscriptionProjections(reread, input.externalCustomerId);
        const again = reread.find(
          (subscription) =>
            subscription.planCode === input.planCode &&
            (subscription.status === "active" ||
              subscription.status === "incomplete"),
        );
        if (again) {
          return {
            externalCustomerId: input.externalCustomerId,
            externalSubscriptionId: again.externalSubscriptionId,
            planCode: input.planCode,
            currentPeriodStart: again.currentPeriodStart ?? null,
            currentPeriodEnd: again.currentPeriodEnd ?? null,
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
        currentPeriodStart: created.body?.currentPeriodStart ?? null,
        currentPeriodEnd: created.body?.currentPeriodEnd ?? null,
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

      try {
        if (await store.hasWebhookEvent(LAGO_PROVIDER_ID, delivery.eventId)) {
          // Already fully applied; the inbox row is the proof, and no re-read happens.
          return json(200, { status: "duplicate" });
        }

        const read = await readProjectionFor(delivery);
        const status = await store.applyWebhookProjection({
          ...read.projection,
          // Audit B6's visibility rule: the retirement evidence line comes from the write that
          // produced it — the apply captures the count at its own UPDATE and calls this only
          // once that transaction committed, so the line can neither claim a retirement another
          // delivery performed nor miss one this delivery performed (audit B6 review r1).
          onRetired: ({ externalCustomerId, count }) => {
            (deps.log ?? console.warn)(
              `billing: retired ${count} subscription projection(s) the provider no longer lists for ${externalCustomerId}`,
            );
          },
          event: {
            provider: LAGO_PROVIDER_ID,
            eventId: delivery.eventId,
            uniqueKey: request.headers.get("x-lago-unique-key") ?? undefined,
            webhookType: delivery.webhookType,
            ...(delivery.objectId ? { objectId: delivery.objectId } : {}),
            bodyHash: delivery.bodyHash,
          },
        });
        // Best-effort replay evidence (audit A7): the count runs after the inbox insert, so it
        // includes this delivery, and a failed count is swallowed — evidence must never fail a
        // delivery the projection already accepted. Swallowed, not silent: the fallback leaves
        // replay detection dark for THIS delivery, so the catch says so. The inbox row still
        // stands, and a later replay of the same body re-counts it.
        const priorDeliveries = await store
          .countDeliveriesOfBody(delivery.bodyHash)
          .catch((error: unknown) => {
            (deps.log ?? console.warn)(
              `billing: webhook_body_replay_count_failed event=${delivery.eventId} name=${error instanceof Error ? error.name : "unknown"}`,
            );
            return 1;
          });
        if (priorDeliveries > 1) {
          (deps.log ?? console.warn)(
            `billing: webhook_body_replay event=${delivery.eventId} deliveries=${priorDeliveries}`,
          );
        }
        // The renewal pass (10.3) runs after the apply committed, for `subscription.*`
        // deliveries only, best-effort: the delivery's own projection work stands, and a
        // failed pass is the sweep's next tick's work — never a failed delivery.
        if (read.subscriptionReads) {
          await applyRenewals(read.subscriptionReads);
        }
        return json(200, { status });
      } catch (error) {
        if (error instanceof BillingPersistenceError) {
          (deps.log ?? console.warn)(
            `billing: webhook failed — ${error.operation}${error.retryable ? " (retryable)" : " (non-retryable data failure)"}`,
          );
          // 503 when it may heal on its own, 500 when it needs a person: both are ours, never
          // the provider's delivery. Nothing recorded, so the retry re-reads and re-applies the
          // whole projection.
          return json(error.retryable ? 503 : 500, {
            error: "Billing webhook could not be applied.",
          });
        }
        if (error instanceof BillingError && error.retryable) {
          (deps.log ?? console.warn)(`billing: webhook failed — ${error.code}`);
          // Nothing recorded: the provider retries the whole delivery, re-read included.
          return json(503, { error: "Billing webhook could not be applied." });
        }
        return json(400, { error: "Billing webhook could not be applied." });
      }
    },

    entitlements(externalCustomerId) {
      return reader.active(externalCustomerId);
    },

    invalidateEntitlementCache(externalCustomerId) {
      reader.invalidate(externalCustomerId);
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
     * Delivery-grade usage metering: resolves only once the provider accepted (or deduplicated,
     * by transaction id) the event, and every other outcome rejects with a stable code so the
     * outbox keeps the target pending.
     */
    async deliverUsage(input) {
      const key = input.externalCustomerId ?? config.externalCustomerKey;
      const rows = await store.readSubscriptions(key);
      const active = rows.find((row) => row.status === "active");
      if (!active) throw new UsageDeliveryError("no_active_subscription");
      const result = await client.postEvent({
        transactionId: input.transactionId,
        code: input.metricCode,
        timestamp: Math.floor((input.timestamp ?? new Date()).getTime() / 1000),
        externalSubscriptionId: active.externalSubscriptionId,
        properties: input.properties,
      });
      // Only 404/422 can reach this check: lago.ts's request() already turned 429/5xx and refused
      // redirects into the retryable BillingError("unreachable") before a status is returned, and
      // postEvent passes only 200/202/404/422 through (every other 4xx becomes
      // BillingError("invalid_response")). A refusal here is therefore always a permanent
      // "unknown metric or subscription", never a transient provider blip.
      if (result.status !== 200 && result.status !== 202) {
        throw new UsageDeliveryError("provider_refused");
      }
    },

    /**
     * One page of the line items behind the usage aggregate: the provider's own event list for the
     * active subscription, newest first. Read-only and uncached, like usage. An unknown page past
     * the end is the provider's empty page, not an error.
     */
    async usageEvents(
      limit,
      page,
      externalCustomerId,
    ): Promise<BillingUsageEventPage> {
      const key = externalCustomerId ?? config.externalCustomerKey;
      const rows = await store.readSubscriptions(key);
      const active = rows.find((row) => row.status === "active");
      if (!active) {
        return {
          events: [],
          totalCount: 0,
          totalPages: 0,
          currentPage: page,
          nextPage: null,
        };
      }
      const result = await client.listEvents(
        active.externalSubscriptionId,
        limit,
        page,
      );
      if (!result.body) {
        return {
          events: [],
          totalCount: 0,
          totalPages: 0,
          currentPage: page,
          nextPage: null,
        };
      }
      const body = result.body;
      return {
        events: body.events.map((event) => ({
          timestamp: event.timestamp,
          metricCode: event.code,
          transactionId: event.transactionId,
          inputTokens: numberOf(event.properties, "input_tokens"),
          outputTokens: numberOf(event.properties, "output_tokens"),
          tokens: numberOf(event.properties, "tokens"),
        })),
        totalCount: body.totalCount,
        totalPages: body.totalPages,
        currentPage: body.currentPage,
        nextPage: body.nextPage,
      };
    },

    /**
     * The current period's usage bucketed by server-local day, for a chart.
     *
     * The provider exposes no day axis of its own, so the buckets are built here: the
     * subscription's whole event log is paged through (a page at a time, at most
     * DAILY_MAX_PAGES pages — a log longer than that answers truncated, an honest boundary
     * rather than an unbounded loop), every event lands in its local-day bucket, and the answer
     * is reused for DAILY_TTL_MS because re-walking fifty pages on every page load is the kind
     * of bill a chart should not write. A failed page read is not swallowed — an aggregation
     * built over a half-read log would be quietly wrong, so it fails whole and the route answers
     * the error, the same contract as the reads above.
     */
    async usageDaily(externalCustomerId): Promise<BillingUsageDaily> {
      const key = externalCustomerId ?? config.externalCustomerKey;
      const cached = dailyCache.get(key);
      if (cached && Date.now() < cached.expiresAt) return cached.value;
      const value = await (async (): Promise<BillingUsageDaily> => {
        const rows = await store.readSubscriptions(key);
        const active = rows.find((row) => row.status === "active");
        if (!active) return { days: [], truncated: false };
        const usage = await client.getUsage(key, active.externalSubscriptionId);
        const buckets = new Map<string, BillingUsageDailyBucket>();
        let truncated = false;
        for (let page = 1; page <= DAILY_MAX_PAGES; page += 1) {
          const result = await client.listEvents(
            active.externalSubscriptionId,
            DAILY_PAGE_SIZE,
            page,
          );
          const body = result.body;
          if (!body) break;
          for (const event of body.events) {
            const date = dayKey(new Date(event.timestamp));
            const bucket = buckets.get(date) ?? {
              date,
              tokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              calls: 0,
            };
            bucket.tokens += numberOf(event.properties, "tokens") ?? 0;
            bucket.inputTokens +=
              numberOf(event.properties, "input_tokens") ?? 0;
            bucket.outputTokens +=
              numberOf(event.properties, "output_tokens") ?? 0;
            bucket.calls += 1;
            buckets.set(date, bucket);
          }
          if (body.nextPage === null) break;
          if (page === DAILY_MAX_PAGES) truncated = true;
        }
        const days = [...buckets.values()].sort((a, b) =>
          a.date.localeCompare(b.date),
        );
        return {
          ...(usage.body?.fromDatetime !== undefined
            ? { fromDatetime: usage.body.fromDatetime }
            : {}),
          ...(usage.body?.toDatetime !== undefined
            ? { toDatetime: usage.body.toDatetime }
            : {}),
          days,
          truncated,
        };
      })();
      dailyCache.set(key, { value, expiresAt: Date.now() + DAILY_TTL_MS });
      return value;
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

    /**
     * The renewal sweep (10.3): the webhook path pays a period when its notification arrives;
     * this pass asks the provider directly about every live owned subscription, so a period
     * whose notification never arrived still pays, and a grant that failed after a delivery
     * still retries. The ledger key and the forward-only marker make every re-run a no-op.
     */
    async sweepRenewals() {
      if (!deps.renewals) return;
      const rows = await store.readLiveOwnedSubscriptions();
      for (const row of rows) {
        try {
          // The provider's own period is the fact a renewal is detected from; a subscription
          // the provider no longer answers (or no longer runs) is skipped, not guessed.
          const remote = await client.getSubscription(row.externalSubscriptionId);
          if (!remote.body) continue;
          if (
            remote.body.status !== "active" &&
            remote.body.status !== "incomplete"
          ) {
            continue;
          }
          if (!remote.body.currentPeriodStart || !remote.body.currentPeriodEnd)
            continue;
          const periodStart = new Date(remote.body.currentPeriodStart);
          const periodEnd = new Date(remote.body.currentPeriodEnd);
          if (
            Number.isNaN(periodStart.getTime()) ||
            Number.isNaN(periodEnd.getTime())
          ) {
            continue;
          }
          await coverPeriod(row, periodStart, periodEnd);
        } catch (error) {
          (deps.log ?? console.warn)(
            `billing: renewal sweep skipped ${row.externalSubscriptionId} — ${error instanceof BillingError ? error.code : `name=${error instanceof Error ? error.name : "unknown"}`}; the next pass retries`,
          );
        }
      }
    },

    async reconcile(): Promise<ReconcileReport> {
      /*
       * The reconciliation pass is a separate module's (./reconcile.ts) and is INJECTED: the
       * billing service's own collaborators (the provider client, the projection store) are
       * what the pass audits, and a method that built its own reader over the deps it is
       * trusted with would be marking its own homework. Absent (a test double, or an assembly
       * that predates the skeleton) keeps the old honest refusal.
       */
      if (!deps.reconciler) {
        throw new BillingError("unsupported");
      }
      const report = await deps.reconciler.reconcile();
      // The report's own paper trail: one line per pass, findings included, so a
      // reconciliation that was run and ignored still left a mark where deployment logs go.
      // (deps.log is the same sink the entitlement reader's warnings use; absent, the report
      // itself — the return value — is the record, and nothing doubles into stdout.)
      deps.log?.(
        JSON.stringify({
          type: "billing-reconcile",
          ranAt: report.ranAt,
          checked: report.checked,
          findings: report.findings.length,
          detail: report.findings,
        }),
      );
      return report;
    },
  };
}
