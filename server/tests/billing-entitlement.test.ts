import { describe, expect, test } from "../../tests/support/e2e-compat";
import { createBillingEntitlementReader } from "../src/billing/entitlement";
import type { BillingEntitlements } from "../src/billing/types";

const PRO: BillingEntitlements = {
  active: true,
  planCode: "pro",
  codes: ["intelligence", "teams"],
};
const TEAM: BillingEntitlements = {
  active: true,
  planCode: "team",
  codes: ["intelligence"],
};

/** A read function that counts calls and can be switched between answers and failures. */
function countedRead() {
  const calls: (string | undefined)[] = [];
  let answer: BillingEntitlements = PRO;
  let failure: Error | undefined;
  return {
    calls,
    get callCount() {
      return calls.length;
    },
    answerWith(value: BillingEntitlements) {
      answer = value;
      failure = undefined;
    },
    failWith(error: Error) {
      failure = error;
    },
    read: async (externalCustomerId?: string) => {
      calls.push(externalCustomerId);
      if (failure) throw failure;
      return answer;
    },
  };
}

function clock(start = 1_000) {
  let at = start;
  return { advance: (ms: number) => (at += ms), now: () => at };
}

describe("createBillingEntitlementReader", () => {
  test("answers from the cache within the TTL: one read for many asks", async () => {
    const reader = countedRead();
    const cached = createBillingEntitlementReader({ read: reader.read });
    for (let index = 0; index < 5; index += 1) {
      await expect(cached.active()).resolves.toEqual(PRO);
    }
    expect(reader.callCount).toBe(1);
  });

  test("shares one in-flight read between concurrent asks", async () => {
    const reader = countedRead();
    const cached = createBillingEntitlementReader({ read: reader.read });
    await Promise.all([cached.active(), cached.active(), cached.active()]);
    expect(reader.callCount).toBe(1);
  });

  test("refreshes after the TTL and keeps serving the stale answer meanwhile", async () => {
    const reader = countedRead();
    const time = clock();
    const cached = createBillingEntitlementReader({
      read: reader.read,
      ttlMs: 1_000,
      now: time.now,
    });
    await expect(cached.active()).resolves.toEqual(PRO);
    reader.answerWith(TEAM);

    time.advance(999);
    await expect(cached.active()).resolves.toEqual(PRO); // still fresh
    expect(reader.callCount).toBe(1);

    time.advance(2);
    await expect(cached.active()).resolves.toEqual(PRO); // stale, refresh kicked off
    await cached.active(); // background refresh has landed by the next turn
    await expect(cached.active()).resolves.toEqual(TEAM);
    expect(reader.callCount).toBe(2);
  });

  test("a failed read falls back to no entitlements and does not throw", async () => {
    const reader = countedRead();
    const logged: string[] = [];
    const cached = createBillingEntitlementReader({
      read: reader.read,
      ttlMs: 1_000,
      failureTtlMs: 500,
      now: clock().now,
      log: (message) => logged.push(message),
    });
    reader.failWith(new Error("projection unavailable"));
    await expect(cached.active()).resolves.toEqual({
      active: false,
      codes: [],
      subscription: null,
    });
    expect(logged).toHaveLength(1);

    // Within the failure TTL the fallback is served without another read.
    await expect(cached.active()).resolves.toEqual({
      active: false,
      codes: [],
      subscription: null,
    });
    expect(reader.callCount).toBe(1);
  });

  test("the failure log fires once per run of failures, not per ask", async () => {
    const reader = countedRead();
    const logged: string[] = [];
    const cached = createBillingEntitlementReader({
      read: reader.read,
      log: (message) => logged.push(message),
    });
    reader.failWith(new Error("first"));
    await cached.active();
    await cached.active();
    await cached.active();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("billing-entitlement-unavailable");
  });

  test("caches customer keys independently", async () => {
    const reader = countedRead();
    const time = clock();
    const cached = createBillingEntitlementReader({
      read: reader.read,
      ttlMs: 1_000,
      now: time.now,
    });

    reader.answerWith(PRO);
    await cached.active("customer-a"); // read at t=1000, bucket a expires at t=2000
    time.advance(600);
    reader.answerWith(TEAM);
    await cached.active("customer-b"); // read at t=1600, bucket b expires at t=2600
    expect(reader.calls).toEqual(["customer-a", "customer-b"]);

    time.advance(500); // t=2100: bucket a is stale, bucket b is not
    await expect(cached.active("customer-a")).resolves.toEqual(PRO); // stale, triggers refresh
    await expect(cached.active("customer-b")).resolves.toEqual(TEAM); // still cached
    expect(reader.callCount).toBe(3);
  });

  test("passes the key through to the injected read", async () => {
    const reader = countedRead();
    const cached = createBillingEntitlementReader({ read: reader.read });
    await cached.active("customer-a");
    await cached.active();
    expect(reader.calls).toEqual(["customer-a", undefined]);
  });
});
