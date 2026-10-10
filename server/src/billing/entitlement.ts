import { getLogger } from "../../../shared/logger";
import type { BillingEntitlements } from "./types";

const logger = getLogger("server");

/**
 * The cached entitlement read, one bucket per customer key.
 *
 * Shaped after the self-host banner's cache (../self-host-banner.ts): a good answer is reused for
 * its TTL and refreshed in the background once stale; a failed read is answered from a fail-closed
 * fallback (`active: false`, no codes) held for the shorter failure TTL, so an unreachable
 * projection does not become a hot loop and does not become "everything is free" either. Both
 * timers and the reader itself are injectable, and concurrent readers of one key share one request
 * (`inFlight`), so a page that asks five times pays one read.
 *
 * The read function is the caller's: it resolves the default customer key and maps the plan code
 * onto entitlement codes. This file only knows how to cache it.
 */
const ANSWER_TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 60_000;

/** Fail-closed: a customer we cannot read about has no entitlements, and no subscription facts. */
const FALLBACK: BillingEntitlements = {
  active: false,
  codes: [],
  subscription: null,
};

type Bucket = {
  answer?: { value: BillingEntitlements; expiresAt: number };
  inFlight?: Promise<BillingEntitlements>;
};

export function createBillingEntitlementReader(options: {
  read: (externalCustomerId?: string) => Promise<BillingEntitlements>;
  ttlMs?: number;
  failureTtlMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}): {
  active(externalCustomerId?: string): Promise<BillingEntitlements>;
  /** Drop one customer's cached answer (all buckets when no key is named). */
  invalidate(externalCustomerId?: string): void;
} {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? ANSWER_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? FAILURE_TTL_MS;
  const log = options.log ?? ((message: string) => logger.warn(message));

  const buckets = new Map<string, Bucket>();
  // Logged once per run of failures, not once per bucket: many customers against one broken
  // projection is one problem, not a log entry each.
  let failureLogged = false;

  function refresh(bucket: Bucket, key?: string): Promise<BillingEntitlements> {
    if (bucket.inFlight) return bucket.inFlight;
    const request = options
      .read(key)
      .then((value) => {
        bucket.answer = { value, expiresAt: now() + ttlMs };
        failureLogged = false;
        return value;
      })
      .catch((error: unknown) => {
        if (!failureLogged) {
          failureLogged = true;
          log(
            JSON.stringify({
              type: "billing-entitlement-unavailable",
              reason: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        bucket.answer = { value: FALLBACK, expiresAt: now() + failureTtlMs };
        return FALLBACK;
      })
      .finally(() => {
        if (bucket.inFlight === request) bucket.inFlight = undefined;
      });
    bucket.inFlight = request;
    return request;
  }

  return {
    active(externalCustomerId) {
      const key = externalCustomerId ?? "";
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {};
        buckets.set(key, bucket);
      }
      if (bucket.answer) {
        if (now() >= bucket.answer.expiresAt) {
          void refresh(bucket, externalCustomerId);
        }
        return Promise.resolve(bucket.answer.value);
      }
      return refresh(bucket, externalCustomerId);
    },

    invalidate(externalCustomerId) {
      if (externalCustomerId === undefined) {
        buckets.clear();
        return;
      }
      buckets.delete(externalCustomerId ?? "");
    },
  };
}
