import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createReconciler } from "../src/billing/reconcile";
import { createUsageOutbox } from "../src/billing/usage-outbox";
import { createDatabase } from "../src/db/client";
import { billingCustomers, billingSubscriptions } from "../src/db/schema/billing";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import {
  creditReservationAllocations,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { paymentEvents, paymentOrders } from "../src/db/schema/payment";
import { usageOutbox } from "../src/db/schema/usage-outbox";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The reconciliation skeleton against a real PostgreSQL (T7). Every test builds its own
 * rows in one customer's namespace and cleans them up: the pass reads WHOLE tables, so the
 * tests must not depend on (or disturb) whatever else the database holds — they assert on
 * THEIR findings (matched by subject), never on the report's total length.
 *
 * The three breaks under test are the ones the invariant comments name: a paid order
 * without its fact row (half-committed confirm), an applied order with no live projection
 * row (entitlement lost after grant), and the credit identity split (grants.used vs
 * ledger.applied disagreeing).
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const creditWriter = createCreditWriter(database);
const outbox = createUsageOutbox(database);
const prefix = `rct-${randomUUID().slice(0, 8)}`;
// This test deployment's own customer key: the projection side of the three-way scopes to
// it, exactly as the production assembly scopes to the deployment's key.
const reconciler = createReconciler(database, prefix);

/** This test's rows only: subject-prefix matched, so neighbours in the table are invisible. */
const mine = <T extends { subject: string }>(findings: readonly T[]) =>
  findings.filter((finding) => finding.subject.startsWith(prefix));

afterAll(async () => {
  await database
    .delete(usageOutbox)
    .where(like(usageOutbox.eventId, `${prefix}%`));
  await database
    .delete(paymentEvents)
    .where(like(paymentEvents.orderId, `${prefix}%`));
  await database
    .delete(paymentOrders)
    .where(like(paymentOrders.id, `${prefix}%`));
  await database
    .delete(creditLedger)
    .where(like(creditLedger.externalCustomerId, `${prefix}%`));
  await database
    .delete(creditGrants)
    .where(like(creditGrants.externalCustomerId, `${prefix}%`));
  await database
    .delete(billingSubscriptions)
    .where(like(billingSubscriptions.externalCustomerId, `${prefix}%`));
  await database
    .delete(billingCustomers)
    .where(eq(billingCustomers.externalId, prefix));
  await database.$client.close();
});

afterEach(async () => {
  await database
    .delete(usageOutbox)
    .where(like(usageOutbox.eventId, `${prefix}%`));
});

function usageEvent(eventId: string) {
  return {
    eventId,
    source: "llm" as const,
    externalCustomerId: `${prefix}-customer`,
    transactionId: `${eventId}-transaction`,
    inputTokens: 120,
    outputTokens: 45,
    model: "gpt-4.1",
    client: "web",
    occurredAt: new Date("2026-10-11T10:00:00.000Z"),
    reservationId: `res-${eventId}`,
    actualCostNumerator: "33",
    actualCostDenominator: "2",
  };
}

async function ageUsageEvent(eventId: string, ageMs: number) {
  await database.execute(
    sql`UPDATE usage_outbox SET updated_at = now() - (${ageMs} * interval '1 millisecond') WHERE event_id = ${eventId}`,
  );
}

function reservedId(
  result: Awaited<ReturnType<typeof creditWriter.reserveCredits>>,
) {
  if (!result.reserved) throw new Error("expected a reservation");
  return result.reservationId;
}

async function reservationSnapshot(reservationId: string) {
  const [reservation] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId))
    .limit(1);
  if (!reservation) throw new Error("expected reservation row");

  const allocations = await database
    .select()
    .from(creditReservationAllocations)
    .where(eq(creditReservationAllocations.reservationId, reservationId))
    .orderBy(
      creditReservationAllocations.id,
      creditReservationAllocations.grantId,
    );
  const grants = await database
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.externalCustomerId, reservation.externalCustomerId))
    .orderBy(creditGrants.id);

  return {
    reservation,
    allocations,
    grants,
  };
}

/** One settled-and-activated order, its fact, its grant/ledger pair, and a live projection row. */
async function agreeingWorld(): Promise<string> {
  const orderId = `${prefix}-ok`;
  await database.insert(paymentOrders).values({
    id: orderId,
    planCode: "pro",
    provider: "alipay",
    amountCents: 8800,
    currency: "CNY",
    status: "paid",
    activationState: "applied",
    channelTransactionId: `${prefix}-tx-ok`,
    checkoutPayload: null,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    version: 2,
  });
  await database.insert(paymentEvents).values({
    id: `${orderId}-fact`,
    orderId,
    kind: "fact",
    code: "paid",
    state: "paid",
    channelTransactionId: `${prefix}-tx-ok`,
  });
  // The customer floor the writer itself lays: the grant's foreign key must find the
  // billing_customers row (the writer inserts-if-absent; this test writes rows directly, so
  // it lays the floor itself).
  await database
    .insert(billingCustomers)
    .values({ externalId: prefix, name: null })
    .onConflictDoNothing({ target: billingCustomers.externalId });
  // The credit identity for this customer: one grant fully drawn, one ledger row recording
  // exactly that draw.
  await database.insert(creditGrants).values({
    id: `${prefix}-g1`,
    externalCustomerId: prefix,
    source: "plan",
    reason: "test",
    total: 1000,
    used: 1000,
    expiresAt: new Date(Date.now() + 24 * 3600_000),
    status: "active",
    idempotencyKey: `${prefix}-gk1`,
  });
  await database.insert(creditLedger).values({
    id: `${prefix}-l1`,
    externalCustomerId: prefix,
    grantId: `${prefix}-g1`,
    title: "模型调用",
    requestId: null,
    idempotencyKey: `${prefix}-lk1`,
    credits: 1000,
    applied: 1000,
  });
  // A live projection row (applied orders ↔ live subscription).
  await database.insert(billingSubscriptions).values({
    externalCustomerId: prefix,
    externalSubscriptionId: `${prefix}-sub`,
    planCode: "pro",
    status: "active",
  });
  return orderId;
}

describe("reconcile (the skeleton, over real tables)", () => {
  test("an agreeing world yields no findings for it", async () => {
    await agreeingWorld();
    const report = await reconciler.reconcile();
    expect(mine(report.findings)).toEqual([]);
    // And the counts saw this world's rows at all (checked > 0 proves the pass read them).
    expect(report.checked.paidOrders).toBeGreaterThanOrEqual(1);
    expect(report.checked.appliedOrders).toBeGreaterThanOrEqual(1);
    expect(report.checked.creditCustomers).toBeGreaterThanOrEqual(1);
  });

  test("a paid order without its fact row is paid_without_fact, named by order id", async () => {
    const orderId = `${prefix}-nofact`;
    await database.insert(paymentOrders).values({
      id: orderId,
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      status: "paid",
      activationState: "pending",
      channelTransactionId: `${prefix}-tx-nofact`,
      checkoutPayload: null,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      version: 2,
    });
    const report = await reconciler.reconcile();
    // Earlier cases' rows still sit in the tables (whole-table audit is the pass's shape), so
    // this case asserts ITS order's finding precisely — present, correctly coded — and that
    // no OTHER finding names this order.
    const mineOnly = report.findings.filter((f) => f.subject === orderId);
    expect(mineOnly).toHaveLength(1);
    expect(mineOnly[0]).toMatchObject({
      category: "payment",
      code: "paid_without_fact",
      subject: orderId,
    });
  });

  test("a fact naming a different transaction is fact_transaction_mismatch", async () => {
    const orderId = `${prefix}-swap`;
    await database.insert(paymentOrders).values({
      id: orderId,
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      status: "paid",
      activationState: "pending",
      channelTransactionId: `${prefix}-tx-order`,
      checkoutPayload: null,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      version: 2,
    });
    await database.insert(paymentEvents).values({
      id: `${orderId}-fact`,
      orderId,
      kind: "fact",
      code: "paid",
      state: "paid",
      channelTransactionId: `${prefix}-tx-other`, // the swap
    });
    const report = await reconciler.reconcile();
    const mineOnly = report.findings.filter((f) => f.subject === orderId);
    expect(mineOnly).toHaveLength(1);
    expect(mineOnly[0]).toMatchObject({
      category: "payment",
      code: "fact_transaction_mismatch",
      subject: orderId,
    });
  });

  test("an applied order with no live projection row is applied_without_subscription", async () => {
    const orderId = `${prefix}-nolive`;
    await database.insert(paymentOrders).values({
      id: orderId,
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      status: "paid",
      activationState: "applied", // granted…
      channelTransactionId: `${prefix}-tx-nolive`,
      checkoutPayload: null,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      version: 2,
    });
    await database.insert(paymentEvents).values({
      id: `${orderId}-fact`,
      orderId,
      kind: "fact",
      code: "paid",
      state: "paid",
      channelTransactionId: `${prefix}-tx-nolive`,
    });
    // …but NO live projection row for this customer (the agreeing world used `prefix` as its
    // customer; this order's customer has none). The single-customer membership ask: the
    // finding fires when the customer key has no live row.
    const before = await reconciler.reconcile();
    void before; // (the world above may hold the agreeing customer's live row — see below)
    // Neutralize the agreeing world's live row for a clean single-customer ask.
    await database
      .update(billingSubscriptions)
      .set({ status: "canceled" })
      .where(eq(billingSubscriptions.externalCustomerId, prefix));
    const report = await reconciler.reconcile();
    const findings = report.findings.filter(
      (finding) =>
        finding.code === "applied_without_subscription" &&
        finding.subject.startsWith(prefix),
    );
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]).toMatchObject({
      category: "payment",
      code: "applied_without_subscription",
      subject: expect.stringMatching(new RegExp(`^${prefix}`)),
    });
  });

  test("a split credit identity is grants_ledger_divergence, named by customer, with the delta", async () => {
    // Break the agreeing customer's identity: the ledger says 1000 was absorbed (it does),
    // the grant says only 600 was drawn — manual surgery's signature.
    await database
      .update(creditGrants)
      .set({ used: 600 })
      .where(eq(creditGrants.id, `${prefix}-g1`));
    const report = await reconciler.reconcile();
    const finding = report.findings.find(
      (item) =>
        item.code === "grants_ledger_divergence" && item.subject === prefix,
    );
    expect(finding).toBeDefined();
    expect(finding?.category).toBe("credits");
    expect(finding?.detail).toContain("600");
    expect(finding?.detail).toContain("1000");
  });

  test("an expired reserved hold stays reserved and is reported for operator recovery without mutating rows", async () => {
    const customer = `${prefix}-stuck`;
    await creditWriter.grantCredits({
      externalCustomerId: customer,
      source: "promo",
      totalCents: 1_000,
      expiresAt: new Date(Date.now() + 24 * 3600_000),
      reason: "stuck-seed",
      idempotencyKey: `${prefix}-stuck-grant`,
    });
    const reservationId = reservedId(
      await creditWriter.reserveCredits({
        externalCustomerId: customer,
        idempotencyKey: `${prefix}-stuck-reservation`,
        maximumCents: 400,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    await database
      .update(creditReservations)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(creditReservations.id, reservationId));

    const before = await reservationSnapshot(reservationId);

    const report = await reconciler.reconcile();
    const finding = report.findings.find(
      (item) =>
        item.code === "expired_reserved_reservation" &&
        item.subject === reservationId,
    );
    expect(finding).toMatchObject({
      category: "credits",
      code: "expired_reserved_reservation",
      subject: reservationId,
    });
    expect(finding?.detail).toContain("state=reserved");
    expect(finding?.detail).toContain(
      "remediation=operator_recovery_required",
    );

    const after = await reservationSnapshot(reservationId);
    expect(after).toEqual(before);
  });

  test("a reserved hold expiring at the reconciliation instant is still reported as expired", async () => {
    const customer = `${prefix}-stuck-boundary`;
    await creditWriter.grantCredits({
      externalCustomerId: customer,
      source: "promo",
      totalCents: 1_000,
      expiresAt: new Date(Date.now() + 24 * 3600_000),
      reason: "stuck-boundary-seed",
      idempotencyKey: `${prefix}-stuck-boundary-grant`,
    });
    const reservationId = reservedId(
      await creditWriter.reserveCredits({
        externalCustomerId: customer,
        idempotencyKey: `${prefix}-stuck-boundary-reservation`,
        maximumCents: 400,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    const boundaryNow = new Date("2026-10-12T06:01:56.851Z");
    await database
      .update(creditReservations)
      .set({ expiresAt: boundaryNow })
      .where(eq(creditReservations.id, reservationId));

    const realNow = Date.now;
    Date.now = () => boundaryNow.getTime();
    try {
      const report = await reconciler.reconcile();
      const finding = report.findings.find(
        (item) =>
          item.code === "expired_reserved_reservation" &&
          item.subject === reservationId,
      );
      expect(finding).toMatchObject({
        category: "credits",
        code: "expired_reserved_reservation",
        subject: reservationId,
      });
    } finally {
      Date.now = realNow;
    }
  });

  test("a reservation whose allocations no longer match its maximum is reported with the exact delta and remains unchanged", async () => {
    const customer = `${prefix}-imbalance`;
    await creditWriter.grantCredits({
      externalCustomerId: customer,
      source: "promo",
      totalCents: 1_000,
      expiresAt: new Date(Date.now() + 24 * 3600_000),
      reason: "imbalance-seed",
      idempotencyKey: `${prefix}-imbalance-grant`,
    });
    const reservationId = reservedId(
      await creditWriter.reserveCredits({
        externalCustomerId: customer,
        idempotencyKey: `${prefix}-imbalance-reservation`,
        maximumCents: 500,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    await database
      .update(creditReservations)
      .set({ maximum: 550 })
      .where(eq(creditReservations.id, reservationId));

    const before = await reservationSnapshot(reservationId);

    const report = await reconciler.reconcile();
    const finding = report.findings.find(
      (item) =>
        item.code === "reservation_allocation_imbalance" &&
        item.subject === reservationId,
    );
    expect(finding).toMatchObject({
      category: "credits",
      code: "reservation_allocation_imbalance",
      subject: reservationId,
    });
    expect(finding?.detail).toContain("maximum=550");
    expect(finding?.detail).toContain("allocated=500");
    expect(finding?.detail).toContain("delta=-50");
    expect(finding?.detail).toContain(
      "remediation=operator_recovery_required",
    );

    const after = await reservationSnapshot(reservationId);
    expect(after).toEqual(before);
  });

  test("allocation imbalance findings cap sampled allocation ids while reporting exact counts and truncation", async () => {
    const customer = `${prefix}-imbalance-many`;
    for (let index = 0; index < 7; index += 1) {
      await creditWriter.grantCredits({
        externalCustomerId: customer,
        source: "promo",
        totalCents: 1,
        expiresAt: new Date(Date.now() + (index + 1) * 3600_000),
        reason: `imbalance-many-${index}`,
        idempotencyKey: `${prefix}-imbalance-many-grant-${index}`,
      });
    }
    const reservationId = reservedId(
      await creditWriter.reserveCredits({
        externalCustomerId: customer,
        idempotencyKey: `${prefix}-imbalance-many-reservation`,
        maximumCents: 7,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    await database
      .update(creditReservations)
      .set({ maximum: 8 })
      .where(eq(creditReservations.id, reservationId));

    const before = await reservationSnapshot(reservationId);
    const allocationIds = before.allocations.map((allocation) => allocation.id);

    const report = await reconciler.reconcile();
    const finding = report.findings.find(
      (item) =>
        item.code === "reservation_allocation_imbalance" &&
        item.subject === reservationId,
    );
    expect(finding).toBeDefined();
    expect(finding?.detail).toContain("allocation_count=7");
    expect(finding?.detail).toContain("allocation_ids_sample=");
    expect(finding?.detail).toContain("allocation_ids_truncated=yes");
    expect(finding?.detail).toContain("delta=-1");
    expect(finding?.detail).toContain(allocationIds[0] ?? "");
    expect(finding?.detail).toContain(allocationIds[1] ?? "");
    expect(finding?.detail).toContain(allocationIds[2] ?? "");
    expect(finding?.detail).not.toContain(allocationIds[6] ?? "");
  });

  test("a pending usage target is reported by usage event id with target, age, and stable failure code", async () => {
    const event = usageEvent(`${prefix}-usage-pending`);
    await outbox.record(event);
    await outbox.markLagoDelivered(event.eventId);
    await outbox.recordDeliveryFailure(
      event.eventId,
      "credits",
      "provider_unavailable",
    );
    await database.execute(
      sql`UPDATE usage_outbox SET updated_at = now() - interval '1 hour' WHERE event_id = ${event.eventId}`,
    );

    const [before] = await database
      .select()
      .from(usageOutbox)
      .where(eq(usageOutbox.eventId, event.eventId));

    const report = await reconciler.reconcile();
    expect(report.checked.usageDeliveryTargets.pending).toEqual({
      lago: 0,
      credits: 1,
    });
    expect(report.checked.usageDeliveryTargets.blocked).toEqual({
      lago: 0,
      credits: 0,
    });

    const finding = report.findings.find(
      (item) =>
        item.code === "usage_target_pending" && item.subject === event.eventId,
    );
    expect(finding).toMatchObject({
      category: "usage",
      code: "usage_target_pending",
      subject: event.eventId,
    });
    expect(finding?.detail).toContain("target=credits");
    expect(finding?.detail).toContain("attempt_age_seconds=");
    expect(finding?.detail).toContain("last_failure_code=provider_unavailable");

    const [after] = await database
      .select()
      .from(usageOutbox)
      .where(eq(usageOutbox.eventId, event.eventId));
    expect(after).toEqual(before);
  });

  test("a blocked usage target remains distinct manual-review evidence and is not counted as pending", async () => {
    const event = usageEvent(`${prefix}-usage-blocked`);
    await outbox.record(event);
    await outbox.markLagoDelivered(event.eventId);
    await outbox.blockDelivery(
      event.eventId,
      "credits",
      "missing_reservation",
    );
    await database.execute(
      sql`UPDATE usage_outbox SET updated_at = now() - interval '2 hours' WHERE event_id = ${event.eventId}`,
    );

    const [before] = await database
      .select()
      .from(usageOutbox)
      .where(eq(usageOutbox.eventId, event.eventId));

    const report = await reconciler.reconcile();
    expect(report.checked.usageDeliveryTargets.pending).toEqual({
      lago: 0,
      credits: 0,
    });
    expect(report.checked.usageDeliveryTargets.blocked).toEqual({
      lago: 0,
      credits: 1,
    });

    const finding = report.findings.find(
      (item) =>
        item.code === "usage_target_blocked" && item.subject === event.eventId,
    );
    expect(finding).toMatchObject({
      category: "usage",
      code: "usage_target_blocked",
      subject: event.eventId,
    });
    expect(finding?.detail).toContain("target=credits");
    expect(finding?.detail).toContain("attempt_age_seconds=");
    expect(finding?.detail).toContain("last_failure_code=missing_reservation");
    expect(
      report.findings.some(
        (item) =>
          item.subject === event.eventId && item.code === "usage_target_pending",
      ),
    ).toBe(false);

    const [after] = await database
      .select()
      .from(usageOutbox)
      .where(eq(usageOutbox.eventId, event.eventId));
    expect(after).toEqual(before);
  });

  test("usage findings are bounded deterministically, delivered rows stay silent, and overflow is summarized exactly", async () => {
    const bounded = createReconciler(database, prefix, {
      usageFindingLimit: 2,
    });

    const delivered = usageEvent(`${prefix}-usage-delivered`);
    await outbox.record(delivered);
    await outbox.markLagoDelivered(delivered.eventId);
    await outbox.markCreditsDelivered(delivered.eventId);
    await ageUsageEvent(delivered.eventId, 4 * 3600_000);

    const oldestPending = usageEvent(`${prefix}-usage-a-pending`);
    await outbox.record(oldestPending);
    await outbox.markLagoDelivered(oldestPending.eventId);
    await outbox.recordDeliveryFailure(
      oldestPending.eventId,
      "credits",
      "provider_unavailable",
    );
    await ageUsageEvent(oldestPending.eventId, 3 * 3600_000);

    const secondBlocked = usageEvent(`${prefix}-usage-b-blocked`);
    await outbox.record(secondBlocked);
    await outbox.blockDelivery(
      secondBlocked.eventId,
      "lago",
      "missing_reservation",
    );
    await outbox.markCreditsDelivered(secondBlocked.eventId);
    await ageUsageEvent(secondBlocked.eventId, 2 * 3600_000);

    const newestMixed = usageEvent(`${prefix}-usage-c-mixed`);
    await outbox.record(newestMixed);
    await outbox.recordDeliveryFailure(
      newestMixed.eventId,
      "lago",
      "provider_unavailable",
    );
    await outbox.blockDelivery(
      newestMixed.eventId,
      "credits",
      "missing_reservation",
    );
    await ageUsageEvent(newestMixed.eventId, 1 * 3600_000);

    const report = await bounded.reconcile();

    expect(report.checked.usageDeliveryTargets.pending).toEqual({
      lago: 1,
      credits: 1,
    });
    expect(report.checked.usageDeliveryTargets.blocked).toEqual({
      lago: 1,
      credits: 1,
    });
    expect(report.checked.usageFindings).toEqual({
      limit: 2,
      emitted: 2,
      omitted: 2,
    });
    const usageFindings = report.findings.filter(
      (finding) => finding.category === "usage",
    );
    expect(usageFindings.at(-1)).toMatchObject({
      category: "usage",
      code: "usage_findings_omitted",
      subject: "usage_outbox",
    });
    expect(usageFindings.slice(0, 2)).toMatchObject([
      {
        category: "usage",
        code: "usage_target_pending",
        subject: oldestPending.eventId,
      },
      {
        category: "usage",
        code: "usage_target_blocked",
        subject: secondBlocked.eventId,
      },
    ]);
    expect(
      usageFindings.some((finding) => finding.subject === delivered.eventId),
    ).toBe(false);
    expect(usageFindings.at(-1)?.detail).toContain("omitted=2");
  });
});
