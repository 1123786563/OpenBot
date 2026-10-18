import { describe, expect, test } from "bun:test";
import {
  createPlanRenewalGrantor,
  planRenewalIdempotencyKey,
} from "../src/billing/plan-renewals";

/*
 * The renewal payout's ledger identity (10.3): the key MUST carry the subscription id and the
 * period start. A key without the period would mistake the NEXT period's renewal for a replay
 * of the last one — exactly the failure the ticket's resume hint warns about — and a key
 * without the subscription id would collide across subscriptions of one account.
 */

describe("planRenewalIdempotencyKey", () => {
  test("distinguishes periods: the next period's renewal is never the last period's replay", () => {
    const november = planRenewalIdempotencyKey(
      "sub-1",
      new Date("2026-11-01T00:00:00.000Z"),
    );
    const december = planRenewalIdempotencyKey(
      "sub-1",
      new Date("2026-12-01T00:00:00.000Z"),
    );
    expect(november).not.toBe(december);
    // Same period, same answer — the duplicate-notification fence.
    expect(november).toBe(
      planRenewalIdempotencyKey("sub-1", new Date("2026-11-01T00:00:00.000Z")),
    );
  });

  test("distinguishes subscriptions, so two subscriptions of one account never collide", () => {
    const at = new Date("2026-11-01T00:00:00.000Z");
    expect(planRenewalIdempotencyKey("sub-1", at)).not.toBe(
      planRenewalIdempotencyKey("sub-2", at),
    );
  });
});

describe("createPlanRenewalGrantor", () => {
  test("pays the caller's account as a plan grant expiring with the period, under the period-tagged key", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const grantor = createPlanRenewalGrantor({
      creditsFor: (planCode) => (planCode === "pro" ? 10_000 : null),
      grantCredits: async (input) => {
        calls.push(input);
        return { inserted: true };
      },
    });
    expect(grantor.creditsFor("pro")).toBe(10_000);
    expect(grantor.creditsFor("starter")).toBeNull();

    const inserted = await grantor.grantRenewal({
      externalCustomerId: "personal:user-1",
      planCode: "pro",
      externalSubscriptionId: "sub-9",
      periodStart: new Date("2026-11-01T00:00:00.000Z"),
      periodEnd: new Date("2026-12-01T00:00:00.000Z"),
      totalCents: 10_000,
    });
    expect(inserted).toEqual({ inserted: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      externalCustomerId: "personal:user-1",
      source: "plan",
      totalCents: 10_000,
      expiresAt: new Date("2026-12-01T00:00:00.000Z"),
      idempotencyKey: planRenewalIdempotencyKey(
        "sub-9",
        new Date("2026-11-01T00:00:00.000Z"),
      ),
      reason: "plan renewal · pro · period 2026-11-01T00:00:00.000Z",
    });
    // The reason is a human line naming the plan and period; the key above is the identity.
    expect(String(calls[0]?.reason)).toContain("pro");
  });
});
