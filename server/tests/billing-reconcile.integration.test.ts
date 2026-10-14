import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createReconciler } from "../src/billing/reconcile";
import { createUsageOutbox } from "../src/billing/usage-outbox";
import { createDatabase } from "../src/db/client";
import {
  billingCustomers,
  billingSubscriptions,
  billingWebhookEvents,
} from "../src/db/schema/billing";
import {
  creditReservationAllocations,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
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
  // The teardown also deletes the precision suite's millions of seeded rows, so the heaviest
  // delete goes first and gets the whole budget — and it carries the same slow-case timeout
  // the seeding tests do. A timeout that strands half the rows turns the NEXT run's first test
  // into a false timeout over the residue, so nothing slow follows the big delete.
  //
  // One customer delete cascades the credit side (grants, ledger, reservations, allocations,
  // remainders all reference billing_customers ON DELETE CASCADE); the payment side carries no
  // customer key, so its two tables are named explicitly.
  await database
    .delete(billingCustomers)
    .where(like(billingCustomers.externalId, `${prefix}%`));
  await database
    .delete(usageOutbox)
    .where(like(usageOutbox.eventId, `${prefix}%`));
  await database
    .delete(paymentEvents)
    .where(like(paymentEvents.orderId, `${prefix}%`));
  await database
    .delete(paymentOrders)
    .where(like(paymentOrders.id, `${prefix}%`));
  await database.$client.close();
}, 240_000);

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
    expect(finding?.detail).toContain("remediation=operator_recovery_required");

    const after = await reservationSnapshot(reservationId);
    expect(after).toEqual(before);
  });

  test("an expired hold keyed usage:<eventId> with no outbox row is found by reservation id and event id, with age, claiming no usage", async () => {
    // The audited failure shape: admission reserved, the provider worked, and the finish's
    // durable write never committed — so there is no outbox row, only an expired hold.
    const customer = `${prefix}-nooutbox`;
    const eventId = `${prefix}-no-outbox-event`;
    await creditWriter.grantCredits({
      externalCustomerId: customer,
      source: "promo",
      totalCents: 1_000,
      expiresAt: new Date(Date.now() + 24 * 3600_000),
      reason: "no-outbox-seed",
      idempotencyKey: `${prefix}-no-outbox-grant`,
    });
    const reservationId = reservedId(
      await creditWriter.reserveCredits({
        externalCustomerId: customer,
        idempotencyKey: `usage:${eventId}`,
        maximumCents: 400,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    expect(
      await database
        .select()
        .from(usageOutbox)
        .where(eq(usageOutbox.eventId, eventId)),
    ).toEqual([]);
    await database
      .update(creditReservations)
      .set({ expiresAt: new Date(Date.now() - 20 * 60_000) })
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
    // The hold is identified by BOTH ids — the reservation's own and the usage event the
    // `usage:` idempotency key names — plus its age, so an operator can find the (absent)
    // outbox row and the logs for the same event.
    expect(finding?.detail).toContain(`idempotency_key=usage:${eventId}`);
    expect(finding?.detail).toContain(`usage_event_id=${eventId}`);
    expect(finding?.detail).toMatch(/expired_age_ms=\d+/);
    expect(finding?.detail).toContain("remediation=operator_recovery_required");
    // It must not claim knowledge of usage that was never durably recorded.
    expect(finding?.detail).not.toContain("input_tokens");
    expect(finding?.detail).not.toContain("output_tokens");

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
    expect(finding?.detail).toContain("remediation=operator_recovery_required");

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
    await outbox.blockDelivery(event.eventId, "credits", "missing_reservation");
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
          item.subject === event.eventId &&
          item.code === "usage_target_pending",
      ),
    ).toBe(false);

    const [after] = await database
      .select()
      .from(usageOutbox)
      .where(eq(usageOutbox.eventId, event.eventId));
    expect(after).toEqual(before);
  });

  test("usage findings are bounded deterministically, delivered rows stay silent, and overflow is summarized exactly", async () => {
    const bounded = createReconciler(database, prefix, undefined, {
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

  test("two inbox rows with the same body hash are webhook_body_replay; one row is silence (audit A7)", async () => {
    // Rows written directly (the pass audits the table, not the writer): two distinct event ids
    // carrying one body hash are the replay shape, one id alone is a normal delivery. The
    // finding's subject is the hash itself, so the assertions match on hashes this test owns.
    const replayedHash = createHash("sha256")
      .update(`${prefix}-replayed-body`)
      .digest("hex");
    const singleHash = createHash("sha256")
      .update(`${prefix}-single-body`)
      .digest("hex");
    await database.insert(billingWebhookEvents).values([
      {
        provider: "lago",
        eventId: `${prefix}-replay-1`,
        webhookType: "subscription.updated",
        bodyHash: replayedHash,
      },
      {
        provider: "lago",
        eventId: `${prefix}-replay-2`,
        webhookType: "subscription.updated",
        bodyHash: replayedHash,
      },
      {
        provider: "lago",
        eventId: `${prefix}-replay-3`,
        webhookType: "customer.updated",
        bodyHash: singleHash,
      },
    ]);
    try {
      const report = await reconciler.reconcile();
      const replayed = report.findings.find(
        (finding) =>
          finding.code === "webhook_body_replay" &&
          finding.subject === replayedHash,
      );
      expect(replayed).toMatchObject({
        category: "payment",
        subject: replayedHash,
      });
      expect(replayed?.detail).toContain("deliveries=2");
      expect(
        report.findings.some(
          (finding) =>
            finding.code === "webhook_body_replay" &&
            finding.subject === singleHash,
        ),
      ).toBe(false);
    } finally {
      await database
        .delete(billingWebhookEvents)
        .where(like(billingWebhookEvents.eventId, `${prefix}-replay-%`));
    }
  });
});

/*
 * Exact arithmetic at the identity and count seams (2026-10-13 audit, F1/F2): the two SUMs and
 * the four usage-outbox COUNTs must reach comparison as exact integers. Above
 * Number.MAX_SAFE_INTEGER a SUM read through Number() rounds to the nearest double — two sums a
 * unit apart compare equal and the divergence finding silently disappears — and a COUNT(*)::int
 * wraps at 2^31 rows. The grant and ledger columns are 32-bit integers, so crossing 2^53 takes
 * 2^53 / (2^31-1) ≈ 4.19M max-value rows, seeded server-side in one round trip each with
 * generate_series (client-side row-by-row would make the precision test a load test).
 */
describe("exact credit-identity arithmetic beyond Number.MAX_SAFE_INTEGER", () => {
  const huge = `${prefix}-huge`;
  // (2^31-1) × 2^22 = 2^53 − 2^22; one make-up row of 2^22 units brings the sum to exactly 2^53.
  const FULL = 2_147_483_647;
  const ROWS = 4_194_304; // 2^22
  const MAKE_UP = 4_194_304;

  // Seed and reconcile each walk millions of rows: these cases carry their own timeout
  // (bun's default 5s is tuned for unit tests, not generate_series).
  const SLOW = 240_000;

  beforeAll(async () => {
    await database
      .insert(billingCustomers)
      .values({ externalId: huge, name: null })
      .onConflictDoNothing({ target: billingCustomers.externalId });
    await database.execute(sql`
      INSERT INTO credit_grants
        (id, external_customer_id, source, total, used, expires_at, status, idempotency_key)
      SELECT
        ${huge} || '-g-' || g::text, ${huge}, 'promo', ${FULL}, ${FULL},
        now() + interval '1 day', 'active', ${huge} || '-gk-' || g::text
      FROM generate_series(1, ${ROWS}) g
    `);
    await database.execute(sql`
      INSERT INTO credit_ledger
        (id, external_customer_id, title, idempotency_key, credits, applied)
      SELECT
        ${huge} || '-l-' || g::text, ${huge}, 'precision-audit', ${huge} || '-lk-' || g::text, ${FULL}, ${FULL}
      FROM generate_series(1, ${ROWS}) g
    `);
  }, SLOW);

  test(
    "a one-unit split at 2^53 magnitude fires the finding with exact decimal strings",
    async () => {
      // Grants sum to exactly 2^53 = 9007199254740992; the ledger's make-up row carries one more
      // unit, so its sum is 9007199254740993 — beyond MAX_SAFE_INTEGER by exactly the split.
      await database.insert(creditGrants).values({
        id: `${huge}-g-makeup`,
        externalCustomerId: huge,
        source: "promo",
        reason: "precision-audit",
        total: MAKE_UP,
        used: MAKE_UP,
        expiresAt: new Date(Date.now() + 24 * 3600_000),
        status: "active",
        idempotencyKey: `${huge}-gk-makeup`,
      });
      await database.insert(creditLedger).values({
        id: `${huge}-l-makeup`,
        externalCustomerId: huge,
        title: "precision-audit",
        requestId: null,
        idempotencyKey: `${huge}-lk-makeup`,
        credits: MAKE_UP + 1,
        applied: MAKE_UP + 1,
      });

      const report = await reconciler.reconcile();
      const finding = report.findings.find(
        (item) =>
          item.code === "grants_ledger_divergence" && item.subject === huge,
      );
      expect(finding).toBeDefined();
      // The exact decimal strings, not a float's idea of them (9007199254740992 loses the split).
      expect(finding?.detail).toContain("9007199254740992");
      expect(finding?.detail).toContain("9007199254740993");
      expect(finding?.detail).toContain("off by 1");
    },
    SLOW,
  );

  test(
    "the identity agrees at 2^53 magnitude and stays silent",
    async () => {
      // The make-up ledger row loses the one extra unit: both sums are exactly 2^53.
      await database
        .update(creditLedger)
        .set({ applied: MAKE_UP, credits: MAKE_UP })
        .where(eq(creditLedger.id, `${huge}-l-makeup`));

      const report = await reconciler.reconcile();
      expect(
        report.findings.find(
          (item) =>
            item.code === "grants_ledger_divergence" && item.subject === huge,
        ),
      ).toBeUndefined();
    },
    SLOW,
  );

  test("usage delivery target counts report exact values (F2)", async () => {
    // The counts are whole-table (an estimate is not an audit), so the assertion is on the
    // DELTA this test's rows add — neighbours in a shared database stay invisible, exactly
    // like the finding assertions above.
    const before = await reconciler.reconcile();
    const a = usageEvent(`${prefix}-count-exact-a`);
    const b = usageEvent(`${prefix}-count-exact-b`);
    const c = usageEvent(`${prefix}-count-exact-c`);
    await outbox.record(a);
    await outbox.record(b);
    await outbox.record(c);
    await outbox.markLagoDelivered(a.eventId);
    await outbox.recordDeliveryFailure(a.eventId, "credits", "retry_later");
    await outbox.markLagoDelivered(b.eventId);
    await outbox.recordDeliveryFailure(b.eventId, "credits", "retry_later");
    await outbox.markCreditsDelivered(c.eventId);
    await outbox.blockDelivery(c.eventId, "lago", "manual_review");

    const report = await reconciler.reconcile();
    const beforeTargets = before.checked.usageDeliveryTargets;
    const afterTargets = report.checked.usageDeliveryTargets;
    expect(afterTargets.pending.credits - beforeTargets.pending.credits).toBe(
      2,
    );
    expect(afterTargets.blocked.lago - beforeTargets.blocked.lago).toBe(1);
    expect(afterTargets.pending.lago - beforeTargets.pending.lago).toBe(0);
    expect(afterTargets.blocked.credits - beforeTargets.blocked.credits).toBe(
      0,
    );
  });
});

/*
 * Plan payout and payment evidence reconciliation (plans 05, tasks 4 and 5): a paid order
 * prices an expected plan allowance through the catalog lookup the assembly passes in; the
 * reconciler matches it against the grant the payout should have written (idempotency key
 * `plan:<orderId>`, scaled integer units), reports paid orders whose activation never settled
 * once they are older than the documented threshold, surfaces duplicate-collection anomalies
 * as manual-disposition evidence, and compares each paid fact's amount against the order's
 * own snapshot. Everything stays read-only: these tests assert the rows are untouched.
 */
describe("plan payout and payment evidence reconciliation", () => {
  // pro pays 500 whole credits → 50_000 scaled units, the same ×CREDIT_SCALE arithmetic the
  // assembly's grantor uses. Plans outside the catalog price null: no allowance, no check.
  const planCreditsFor = (planCode: string): number | null =>
    planCode === "pro" ? 50_000 : null;

  /** One paid order plus its paid fact and the customer floor the grant foreign key needs. */
  async function seedPaidOrder(
    orderId: string,
    options: {
      planCode?: string;
      amountCents?: number;
      factAmountCents?: number | null;
      activationState?: "pending" | "applied" | "failed";
    } = {},
  ) {
    const amountCents = options.amountCents ?? 8_800;
    await database.insert(paymentOrders).values({
      id: orderId,
      planCode: options.planCode ?? "pro",
      provider: "alipay",
      amountCents,
      currency: "CNY",
      status: "paid",
      activationState: options.activationState ?? "applied",
      channelTransactionId: `${orderId}-tx`,
      checkoutPayload: null,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      paidAt: new Date(),
      version: 2,
    });
    await database.insert(paymentEvents).values({
      id: `${orderId}-fact`,
      orderId,
      kind: "fact",
      code: "paid",
      state: "paid",
      channelTransactionId: `${orderId}-tx`,
      amountCents:
        options.factAmountCents === undefined
          ? amountCents
          : options.factAmountCents,
    });
    await database
      .insert(billingCustomers)
      .values({ externalId: prefix, name: null })
      .onConflictDoNothing({ target: billingCustomers.externalId });
    return orderId;
  }

  test("a paid order whose plan allowance never landed is plan_grant_missing, named by order and the plan:<orderId> key", async () => {
    const orderId = await seedPaidOrder(`${prefix}-grant-missing`);
    const catalogReconciler = createReconciler(
      database,
      prefix,
      planCreditsFor,
    );

    const report = await catalogReconciler.reconcile();
    const finding = report.findings.find(
      (item) => item.subject === orderId && item.code === "plan_grant_missing",
    );
    expect(finding).toMatchObject({
      category: "payment",
      code: "plan_grant_missing",
      subject: orderId,
    });
    expect(finding?.detail).toContain(`plan:${orderId}`);
    expect(finding?.detail).toContain("expected=50000");
  });

  test("a plan grant whose total differs from the catalog price is plan_grant_amount_mismatch", async () => {
    const orderId = await seedPaidOrder(`${prefix}-grant-mismatch`);
    await database.insert(creditGrants).values({
      id: `${orderId}-grant`,
      externalCustomerId: prefix,
      source: "plan",
      reason: "test",
      total: 49_000,
      used: 0,
      expiresAt: new Date(Date.now() + 24 * 3600_000),
      status: "active",
      idempotencyKey: `plan:${orderId}`,
    });
    const catalogReconciler = createReconciler(
      database,
      prefix,
      planCreditsFor,
    );

    const report = await catalogReconciler.reconcile();
    const finding = report.findings.find(
      (item) =>
        item.subject === orderId && item.code === "plan_grant_amount_mismatch",
    );
    expect(finding).toMatchObject({
      category: "payment",
      code: "plan_grant_amount_mismatch",
      subject: orderId,
    });
    expect(finding?.detail).toContain(`plan:${orderId}`);
    expect(finding?.detail).toContain("expected=50000");
    expect(finding?.detail).toContain("actual=49000");
  });

  test("a matching plan grant keeps the books silent, and plans outside the catalog are not checked", async () => {
    const settled = await seedPaidOrder(`${prefix}-grant-ok`);
    await database.insert(creditGrants).values({
      id: `${settled}-grant`,
      externalCustomerId: prefix,
      source: "plan",
      reason: "test",
      total: 50_000,
      used: 0,
      expiresAt: new Date(Date.now() + 24 * 3600_000),
      status: "active",
      idempotencyKey: `plan:${settled}`,
    });
    // "basic" is not in the test catalog: it grants nothing, so there is nothing to reconcile.
    await seedPaidOrder(`${prefix}-grant-none`, { planCode: "basic" });
    const catalogReconciler = createReconciler(
      database,
      prefix,
      planCreditsFor,
    );

    const report = await catalogReconciler.reconcile();
    expect(
      report.findings.some(
        (item) =>
          item.code.startsWith("plan_grant") &&
          (item.subject === settled || item.subject === `${prefix}-grant-none`),
      ),
    ).toBe(false);
  });

  test("activation still pending beyond the age threshold is activation_backlog; a young retry and a wider threshold stay silent", async () => {
    const aged = await seedPaidOrder(`${prefix}-activation-aged`, {
      activationState: "pending",
    });
    const young = await seedPaidOrder(`${prefix}-activation-young`, {
      activationState: "pending",
    });
    await database.execute(
      sql`UPDATE payment_orders SET paid_at = now() - interval '30 minutes' WHERE id = ${aged}`,
    );

    const report = await reconciler.reconcile();
    const finding = report.findings.find(
      (item) => item.subject === aged && item.code === "activation_backlog",
    );
    expect(finding).toMatchObject({
      category: "payment",
      code: "activation_backlog",
      subject: aged,
    });
    expect(finding?.detail).toContain("state=pending");
    expect(
      report.findings.some(
        (item) => item.code === "activation_backlog" && item.subject === young,
      ),
    ).toBe(false);

    const patient = createReconciler(database, prefix, undefined, {
      activationBacklogAgeMs: 3_600_000,
    });
    const patientReport = await patient.reconcile();
    // The pass reads whole tables, so residual pending orders from other suites legitimately
    // report; the threshold contract is about THIS test's rows only.
    expect(
      patientReport.findings.some(
        (item) =>
          item.code === "activation_backlog" && item.subject.startsWith(prefix),
      ),
    ).toBe(false);
  });

  test("a duplicate paid collection is duplicate_paid_order evidence requiring manual disposition, and rows stay unchanged", async () => {
    const owner = await seedPaidOrder(`${prefix}-dup-owner`);
    const late = await seedPaidOrder(`${prefix}-dup-late`);
    await database.insert(paymentEvents).values({
      id: `${late}-anomaly`,
      orderId: late,
      kind: "anomaly",
      code: "duplicate_paid",
      state: null,
      channelTransactionId: `${late}-tx`,
      amountCents: 8_800,
      detail: `overlaps entitlement owned by ${owner} via ${owner}-tx`,
    });

    const [beforeOrder] = await database
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.id, late));
    const report = await reconciler.reconcile();
    const finding = report.findings.find(
      (item) => item.subject === late && item.code === "duplicate_paid_order",
    );
    expect(finding).toMatchObject({
      category: "payment",
      code: "duplicate_paid_order",
      subject: late,
    });
    expect(finding?.detail).toContain(owner);
    expect(finding?.detail).toContain("remediation=manual_operator_resolution");

    const [afterOrder] = await database
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.id, late));
    expect(afterOrder).toEqual(beforeOrder);
  });

  test("a paid fact whose amount disagrees with the order snapshot is fact_amount_mismatch; an unreadable amount stays silent", async () => {
    const drifted = await seedPaidOrder(`${prefix}-fact-amount`, {
      factAmountCents: 8_801,
    });
    await seedPaidOrder(`${prefix}-fact-unreadable`, {
      factAmountCents: null,
    });

    const report = await reconciler.reconcile();
    const finding = report.findings.find(
      (item) =>
        item.subject === drifted && item.code === "fact_amount_mismatch",
    );
    expect(finding).toMatchObject({
      category: "payment",
      code: "fact_amount_mismatch",
      subject: drifted,
    });
    expect(finding?.detail).toContain("order=8800");
    expect(finding?.detail).toContain("fact=8801");
    expect(
      report.findings.some(
        (item) =>
          item.subject === `${prefix}-fact-unreadable` &&
          item.code === "fact_amount_mismatch",
      ),
    ).toBe(false);
  });
});
